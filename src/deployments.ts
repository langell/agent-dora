import type { Config } from './config.js';
import { DeploySource, DeploySourceSetting, DeployStatus, EnvVar, MS_PER_HOUR } from './constants.js';
import * as g from './git.js';
import type { GitHub } from './github.js';
import { fetchJson } from './http.js';
import type { ChangeRecord, Deployment } from './types.js';

const VERCEL_API = 'https://api.vercel.com/v7/deployments';
const VERCEL_PAGE_SIZE = 100;
/** Vercel's `readyState` values that end a deployment. */
const VercelState = { Ready: 'READY', Error: 'ERROR', Canceled: 'CANCELED' } as const;
/** Vercel's deployment `target` for production. */
const VERCEL_PRODUCTION = 'production';

type VercelDeployment = {
  uid: string; url: string | null; created: number; ready?: number | null; readyState: string;
  target: string | null; meta?: { githubCommitSha?: string };
};

/** Production deployments of the given Vercel projects created on or after `since`, oldest first. */
export async function vercelDeployments(token: string, projects: string[], teamId: string, since: Date): Promise<Deployment[]> {
  const out: Deployment[] = [];
  for (const project of projects) {
    let until: number | null = null;
    do {
      const params = new URLSearchParams({ projectId: project, target: VERCEL_PRODUCTION, since: String(since.getTime()), limit: String(VERCEL_PAGE_SIZE) });
      if (teamId) params.set('teamId', teamId);
      if (until !== null) params.set('until', String(until));
      const page: { deployments: VercelDeployment[]; pagination: { next: number | null } } = await fetchJson(
        `${VERCEL_API}?${params}`,
        { headers: { authorization: `Bearer ${token}` } },
        'Vercel',
      );
      for (const d of page.deployments) {
        // Only deployments built from a known commit can be matched to changes.
        const sha = d.meta?.githubCommitSha;
        if (!sha) continue;
        const ready = d.readyState === VercelState.Ready;
        out.push({
          source: DeploySource.Vercel,
          environment: project,
          sha,
          createdAt: new Date(d.created).toISOString(),
          readyAt: ready ? new Date(d.ready ?? d.created).toISOString() : null,
          status: ready ? DeployStatus.Success : d.readyState === VercelState.Error ? DeployStatus.Failure : DeployStatus.Pending,
          url: d.url ? `https://${d.url}` : null,
        });
      }
      until = page.pagination.next;
    } while (until !== null);
  }
  return out.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/**
 * Production deployments from the configured source, or null if there's no source to read.
 * A source that fails (missing permission, bad token) adds a note instead of stopping the run.
 */
export async function loadDeployments(cfg: Config, gh: GitHub, since: Date, note: (msg: string) => void, log: (msg: string) => void): Promise<Deployment[] | null> {
  const { source, environment, vercelProjects, vercelTeamId } = cfg.deployments;
  if (source === DeploySourceSetting.None) return null;
  const vercelToken = process.env[EnvVar.VercelToken];
  const tryGitHub = source === DeploySourceSetting.GitHub || source === DeploySourceSetting.Auto;
  if (tryGitHub) {
    log('Fetching GitHub deployments...');
    try {
      const deploys = await gh.deployments(since, environment);
      if (deploys.length || source === DeploySourceSetting.GitHub) return deploys;
    } catch (err) {
      note(`Couldn't read GitHub deployments, so lead time to production isn't shown. In GitHub Actions, add \`deployments: read\` to the workflow's permissions. (${(err as Error).message})`);
      if (source === DeploySourceSetting.GitHub) return null;
    }
  }
  if (!vercelProjects.length) {
    if (source === DeploySourceSetting.Vercel) note('deployments.source is vercel, but deployments.vercelProjects is empty.');
    return null;
  }
  if (!vercelToken) {
    note(`Set ${EnvVar.VercelToken} to read deployments of the configured Vercel projects.`);
    return null;
  }
  log('Fetching Vercel deployments...');
  try {
    return await vercelDeployments(vercelToken, vercelProjects, vercelTeamId, since);
  } catch (err) {
    note(`Couldn't read Vercel deployments: ${(err as Error).message}`);
    return null;
  }
}

/** Successful deployments in the order they went live. */
export function liveDeployments(deploys: Deployment[]): Deployment[] {
  return deploys.filter((d) => d.status === DeployStatus.Success && d.readyAt).sort((a, b) => Date.parse(a.readyAt!) - Date.parse(b.readyAt!));
}

/**
 * Releases: each commit's first successful deployment, in the order they went live. A monorepo
 * that deploys one commit to several projects (an app, an API) releases it once, not per project.
 */
export function releases(deploys: Deployment[]): Deployment[] {
  const seen = new Set<string>();
  return liveDeployments(deploys).filter((d) => !seen.has(d.sha) && seen.add(d.sha));
}

/**
 * Sets each change's `deployedAt`: when the first successful production deployment that
 * contains its commit went live. Walks the deployments in order, collecting the commits each
 * one added over all earlier ones, so it runs one `git rev-list` per deployment rather than
 * one ancestry check per change and deployment. Rollbacks (deploying an older commit) add
 * nothing, so they never count as a change's first deployment.
 */
export async function attachDeployments(repoPath: string, changes: ChangeRecord[], deploys: Deployment[], since: Date): Promise<void> {
  const firstLive = new Map<string, string>();
  const shipped: string[] = [];
  for (const d of liveDeployments(deploys)) {
    const added = await g.newCommits(repoPath, d.sha, shipped, since);
    // A deployment of a commit that isn't in local history (another branch, not fetched) is skipped.
    if (added === null) continue;
    for (const oid of added) if (!firstLive.has(oid)) firstLive.set(oid, d.readyAt!);
    shipped.push(d.sha);
  }
  for (const c of changes) {
    const at = c.oid ? firstLive.get(c.oid) : undefined;
    if (!at) continue;
    c.deployedAt = at;
    // Lead time starts where the change's own lead time does: its first commit, or PR creation if earlier.
    const start = Date.parse(c.mergedAt) - (c.leadTimeHours ?? 0) * MS_PER_HOUR;
    c.deployLeadTimeHours = Math.max(0, (Date.parse(at) - start) / MS_PER_HOUR);
  }
}
