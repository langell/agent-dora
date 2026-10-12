import type { Config } from './config.js';
import { AUTHOR_CLASSES, AuthorClass, BOT_SUFFIX, ClassSource, OTHER_TOOL } from './constants.js';

export interface Classifiable {
  author: string | null;
  labels: string[];
  headRefName: string;
  body: string;
  commits: { message: string; authorName?: string; authorEmail?: string }[];
}

/**
 * A commit as assisted patterns see it: its message, plus its git author as an `Author:` line,
 * since some tools mark the author rather than adding a trailer.
 */
const commitText = (c: Classifiable['commits'][number]) => (c.authorName ? `${c.message}\nAuthor: ${c.authorName} <${c.authorEmail ?? ''}>` : c.message);

export interface Classification {
  authorClass: AuthorClass;
  /** Which signal decided it; use this, not `reason`, to branch on. */
  source: ClassSource;
  /** Human-readable detail, e.g. which label or pattern matched. */
  reason: string;
  /** The AI tool behind an agent or assisted change; null for human ones. */
  tool: string | null;
}

/** The whole line of `text` that contains position `at`: the evidence a pattern matched in. */
function lineAt(text: string, at: number): string {
  const start = text.lastIndexOf('\n', at) + 1;
  const end = text.indexOf('\n', at);
  return text.slice(start, end === -1 ? undefined : end);
}

/** An email address in angle brackets, as in a co-author trailer or commit author. */
const ADDRESS = /<[^<>\s]+@[^<>\s]+>/;

/** Lines that credit a tool: co-author and assisted-by trailers, "Generated with ..." footers, and commit authors. */
const CREDIT_LINE = /^.*(?:co-authored-by:|assisted-by:|generated with|^author:).*$/gim;

/**
 * Names the AI tool in `evidence` (what marked the change as AI-written), falling back
 * to the author, branch and credit lines (not free text, where "cursor" may mean
 * pagination), then to `OTHER_TOOL`.
 */
export function detectTool(evidence: string, pr: Classifiable, cfg: Config): string {
  const tools = Object.entries(cfg.tools).map(([name, p]) => ({ name, re: new RegExp(p, 'i') }));
  const credits = [pr.body, ...pr.commits.map(commitText)].flatMap((t) => t.match(CREDIT_LINE) ?? []);
  const texts = [evidence, pr.author ?? '', pr.headRefName, ...credits];
  for (const text of texts) {
    // An address names the tool that wrote the line, even when the name is the model's:
    // opencode running Muse Spark writes "Muse Spark 1.3 <noreply@opencode.ai>".
    const address = ADDRESS.exec(text)?.[0];
    const byAddress = address && tools.find((t) => t.re.test(address));
    if (byAddress) return byAddress.name;
    // Otherwise the tool named earliest wins, so a trailer naming the tool and then its model
    // ("Assisted-by: Crush:claude-sonnet") credits the tool, not the model's maker.
    let best: { name: string; at: number } | null = null;
    for (const t of tools) {
      const at = text.search(t.re);
      if (at !== -1 && (!best || at < best.at)) best = { name: t.name, at };
    }
    if (best) return best.name;
  }
  return OTHER_TOOL;
}

/** Lowercased login without GitHub's bot suffix, so `claude[bot]` matches `claude`. */
export function normLogin(login: string): string {
  const lower = login.toLowerCase();
  return lower.endsWith(BOT_SUFFIX) ? lower.slice(0, -BOT_SUFFIX.length) : lower;
}

export function isBotLogin(login: string): boolean {
  return login.toLowerCase().endsWith(BOT_SUFFIX);
}

const inList = (login: string, list: string[]) => {
  const a = normLogin(login);
  return list.some((x) => normLogin(x) === a);
};

export function isIgnoredAuthor(author: string | null, cfg: Config): boolean {
  return !!author && inList(author, cfg.ignoreAuthors);
}

/**
 * A review by a person other than the PR's author. AI review bots don't count: with
 * one installed, every PR would look reviewed within minutes.
 */
export function isHumanReview(review: { author: string | null; isBot: boolean }, prAuthor: string | null, cfg: Config): boolean {
  const who = review.author;
  if (!who || review.isBot || isBotLogin(who)) return false;
  if (prAuthor && normLogin(who) === normLogin(prAuthor)) return false;
  return !inList(who, cfg.botReviewers) && !inList(who, cfg.agentAuthors);
}

/**
 * Decides who wrote a PR, in precedence order:
 * 1. an explicit label (`ai:agent`, `ai:assisted`, `ai:none`) wins, unless labels
 *    of different classes contradict each other, in which case they're all ignored;
 * 2. an agent login or agent branch prefix means the agent opened the PR -> agent;
 * 3. an AI co-author trailer or tool marker in commits or body -> assisted;
 * 4. otherwise -> human.
 */
export function classify(pr: Classifiable, cfg: Config): Classification {
  const labels = new Set(pr.labels.map((l) => l.toLowerCase()));
  const hits = AUTHOR_CLASSES.flatMap((cls) => {
    const hit = cfg.labels[cls].find((l) => labels.has(l.toLowerCase()));
    return hit ? [{ cls, hit }] : [];
  });
  // Which tool, for AI-written changes, is read from the evidence that decided the class.
  const toolFor = (authorClass: AuthorClass, evidence: string) => (authorClass === AuthorClass.Human ? null : detectTool(evidence, pr, cfg));
  if (hits.length === 1) {
    const { cls, hit } = hits[0]!;
    return { authorClass: cls, source: ClassSource.Label, reason: `label ${hit}`, tool: toolFor(cls, '') };
  }
  const note = hits.length > 1 ? `; ignored conflicting labels ${hits.map((h) => h.hit).join(', ')}` : '';
  const decided = (authorClass: AuthorClass, source: ClassSource, reason: string, evidence: string): Classification =>
    ({ authorClass, source, reason: reason + note, tool: toolFor(authorClass, evidence) });

  if (pr.author && inList(pr.author, cfg.agentAuthors)) return decided(AuthorClass.Agent, ClassSource.Author, `author ${pr.author}`, pr.author);
  const prefix = cfg.agentBranchPrefixes.find((p) => pr.headRefName.startsWith(p));
  if (prefix) return decided(AuthorClass.Agent, ClassSource.Branch, `branch ${prefix}*`, prefix);

  const patterns = cfg.assistedPatterns.map((p) => new RegExp(p, 'im'));
  const texts = [pr.body, ...pr.commits.map(commitText)];
  for (const re of patterns) {
    for (const t of texts) {
      const m = re.exec(t);
      if (m) return decided(AuthorClass.Assisted, ClassSource.Trailer, `matched /${re.source}/`, lineAt(t, m.index));
    }
  }

  return decided(AuthorClass.Human, ClassSource.None, 'no AI signal', '');
}
