import type { Config } from './config.js';
import { EnvVar, INCIDENT_SOURCE_NAMES, IncidentSource, isoDate, MS_PER_DAY } from './constants.js';
import { fetchJson } from './http.js';
import type { Incident } from './types.js';

const LINEAR_API = 'https://api.linear.app/graphql';
const LINEAR_PAGE_SIZE = 100;
const JIRA_SEARCH_PATH = '/rest/api/3/search/jql';
const JIRA_PAGE_SIZE = 100;
const JIRA_FIELDS = 'summary,description,created,resolutiondate';
const PAGERDUTY_API = 'https://api.pagerduty.com/incidents';
const PAGERDUTY_ACCEPT = 'application/vnd.pagerduty+json;version=2';
const PAGERDUTY_PAGE_SIZE = 100;
/** PagerDuty caps a query's date range at six months; ask in shorter stretches. */
const PAGERDUTY_RANGE_DAYS = 90;

// ---- Linear -------------------------------------------------------------------

type LinearIssue = { identifier: string; title: string; description: string | null; url: string; createdAt: string; completedAt: string | null };

/** Linear issues created on or after `since` with any of `labels`, in `teams` (all teams if empty). */
export async function linearIncidents(key: string, labels: string[], teams: string[], since: Date): Promise<Incident[]> {
  const query = `query($after:String,$filter:IssueFilter){
    issues(first:${LINEAR_PAGE_SIZE}, after:$after, filter:$filter){
      nodes{identifier title description url createdAt completedAt}
      pageInfo{hasNextPage endCursor}
    }
  }`;
  const filter = {
    createdAt: { gte: since.toISOString() },
    labels: { some: { name: { in: labels } } },
    ...(teams.length ? { team: { key: { in: teams } } } : {}),
  };
  const out: Incident[] = [];
  let after: string | null = null;
  for (;;) {
    const res: { data?: { issues: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string } } }; errors?: { message: string }[] } = await fetchJson(
      LINEAR_API,
      // Linear takes a personal API key as-is, without "Bearer".
      { method: 'POST', headers: { authorization: key, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables: { after, filter } }) },
      INCIDENT_SOURCE_NAMES[IncidentSource.Linear],
    );
    if (!res.data) throw new Error(`Linear: ${res.errors?.map((e) => e.message).join('; ') ?? 'no data'}`);
    for (const i of res.data.issues.nodes) {
      out.push({ source: IncidentSource.Linear, id: i.identifier, title: i.title, url: i.url, createdAt: i.createdAt, resolvedAt: i.completedAt, text: `${i.title}\n${i.description ?? ''}` });
    }
    if (!res.data.issues.pageInfo.hasNextPage) return out;
    after = res.data.issues.pageInfo.endCursor;
  }
}

// ---- Jira -----------------------------------------------------------------------

/** A node of Atlassian Document Format, the rich text Jira returns for descriptions. */
type AdfNode = { type?: string; text?: string; attrs?: { url?: string; href?: string }; marks?: { attrs?: { href?: string } }[]; content?: AdfNode[] };

/** Plain text of an ADF document, keeping link targets so PR and commit URLs can be found. */
export function adfText(node: AdfNode | null | undefined): string {
  if (!node) return '';
  const own = [node.text, node.attrs?.url, node.attrs?.href, ...(node.marks ?? []).map((m) => m.attrs?.href)].filter(Boolean).join(' ');
  const children = (node.content ?? []).map(adfText).filter(Boolean).join(node.type === 'doc' ? '\n' : ' ');
  return [own, children].filter(Boolean).join(' ');
}

type JiraIssue = { key: string; fields: { summary: string; description: AdfNode | null; created: string; resolutiondate: string | null } };

/** Jira issues matching `jql`, created on or after `since`. */
export async function jiraIncidents(site: string, email: string, token: string, jql: string, since: Date): Promise<Incident[]> {
  const base = `https://${site.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  // The search endpoint only accepts bounded queries, so the date bound is always added.
  const bounded = `(${jql}) AND created >= "${isoDate(since.toISOString())}" ORDER BY created DESC`;
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const out: Incident[] = [];
  const seen = new Set<string>();
  let pageToken: string | null = null;
  for (;;) {
    const params = new URLSearchParams({ jql: bounded, fields: JIRA_FIELDS, maxResults: String(JIRA_PAGE_SIZE) });
    if (pageToken) params.set('nextPageToken', pageToken);
    const page: { issues: JiraIssue[]; nextPageToken?: string | null; isLast?: boolean } = await fetchJson(
      `${base}${JIRA_SEARCH_PATH}?${params}`,
      { headers: { authorization: auth } },
      INCIDENT_SOURCE_NAMES[IncidentSource.Jira],
    );
    for (const i of page.issues) {
      out.push({
        source: IncidentSource.Jira,
        id: i.key,
        title: i.fields.summary,
        url: `${base}/browse/${i.key}`,
        createdAt: new Date(i.fields.created).toISOString(),
        resolvedAt: i.fields.resolutiondate ? new Date(i.fields.resolutiondate).toISOString() : null,
        text: `${i.fields.summary}\n${adfText(i.fields.description)}`,
      });
    }
    // Stop on the last page, and guard against a token that repeats.
    const next = page.nextPageToken ?? null;
    if (page.isLast || !next || seen.has(next)) return out;
    seen.add(next);
    pageToken = next;
  }
}

// ---- PagerDuty --------------------------------------------------------------------

type PagerDutyIncident = { incident_number: number; title: string; description?: string; created_at: string; resolved_at?: string | null; html_url: string };

/** PagerDuty incidents created on or after `since`, on `services` (all services if empty). */
export async function pagerDutyIncidents(token: string, services: string[], since: Date, now: Date): Promise<Incident[]> {
  const out: Incident[] = [];
  for (let from = since.getTime(); from < now.getTime(); from += PAGERDUTY_RANGE_DAYS * MS_PER_DAY) {
    const until = Math.min(now.getTime(), from + PAGERDUTY_RANGE_DAYS * MS_PER_DAY);
    for (let offset = 0; ; offset += PAGERDUTY_PAGE_SIZE) {
      const params = new URLSearchParams({ since: new Date(from).toISOString(), until: new Date(until).toISOString(), limit: String(PAGERDUTY_PAGE_SIZE), offset: String(offset) });
      for (const s of services) params.append('service_ids[]', s);
      const page: { incidents: PagerDutyIncident[]; more: boolean } = await fetchJson(
        `${PAGERDUTY_API}?${params}`,
        { headers: { authorization: `Token token=${token}`, accept: PAGERDUTY_ACCEPT } },
        INCIDENT_SOURCE_NAMES[IncidentSource.PagerDuty],
      );
      for (const i of page.incidents) {
        out.push({
          source: IncidentSource.PagerDuty,
          id: `PD-${i.incident_number}`,
          title: i.title,
          url: i.html_url,
          createdAt: i.created_at,
          resolvedAt: i.resolved_at ?? null,
          text: `${i.title}\n${i.description ?? ''}`,
        });
      }
      if (!page.more) break;
    }
  }
  return out;
}

// ---- All trackers ------------------------------------------------------------------

/**
 * Incidents from every tracker whose credentials are set, or null if none is set up.
 * A tracker that fails adds a note instead of stopping the run.
 */
export async function loadIncidents(cfg: Config, since: Date, now: Date, note: (msg: string) => void, log: (msg: string) => void): Promise<Incident[] | null> {
  const env = process.env;
  const c = cfg.incidents;
  const trackers: { source: IncidentSource; load: () => Promise<Incident[]> }[] = [];
  const linearKey = env[EnvVar.LinearApiKey];
  if (linearKey) trackers.push({ source: IncidentSource.Linear, load: () => linearIncidents(linearKey, c.linearLabels, c.linearTeams, since) });
  const jiraEmail = env[EnvVar.JiraEmail];
  const jiraToken = env[EnvVar.JiraApiToken];
  if (c.jiraSite && jiraEmail && jiraToken) trackers.push({ source: IncidentSource.Jira, load: () => jiraIncidents(c.jiraSite, jiraEmail, jiraToken, c.jiraJql, since) });
  else if (c.jiraSite) note(`incidents.jiraSite is set; set ${EnvVar.JiraEmail} and ${EnvVar.JiraApiToken} to read Jira.`);
  const pdToken = env[EnvVar.PagerDutyToken];
  if (pdToken) trackers.push({ source: IncidentSource.PagerDuty, load: () => pagerDutyIncidents(pdToken, c.pagerdutyServices, since, now) });
  if (!trackers.length) return null;

  const out: Incident[] = [];
  for (const t of trackers) {
    log(`Fetching incidents from ${INCIDENT_SOURCE_NAMES[t.source]}...`);
    try {
      out.push(...(await t.load()));
    } catch (err) {
      note(`Couldn't read incidents from ${INCIDENT_SOURCE_NAMES[t.source]}: ${(err as Error).message}`);
    }
  }
  return out.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
