# agent-dora

**Delivery metrics for teams shipping with AI coding agents.**

Once agents write much of your code, the classic DORA metrics are easy to inflate: deployment frequency and lead time go up while quality debt piles up where they can't see it. agent-dora measures what counts now: **how many changes ship and stay shipped**. Every metric is split by who wrote the code:

| Author | Meaning |
|---|---|
| **Agent** | A coding agent opened the PR (Copilot coding agent, Claude, Codex, Devin, Cursor, Jules…) |
| **Assisted** | A person opened the PR, with AI co-authored commits (e.g. Claude Code's `Co-Authored-By` trailer) |
| **Human** | No AI signal |

It works whether your team merges pull requests or pushes straight to a branch, and runs as a CLI or a GitHub Action, uses only the GitHub API and your local git history, and produces a static dashboard. No server, no SaaS, and no data leaves your machine or CI runner.

## Metrics

| Metric | Definition |
|---|---|
| **Durable changes / week** | The headline metric. Changes that, 21 days after landing, were not reverted or reworked **and** still have ≥70% of their added lines on the branch. |
| **Surviving lines / week** | Added lines still on the branch 21 days later. Shown next to the headline so splitting work into more, smaller changes can't inflate it unnoticed. |
| **Durable rate** | Share of matured changes that were durable. |
| **Line churn** | Share of all added lines gone 21 days after merge, measured with `git blame` at merge time and at merge + 21 days. Big changes weigh more. |
| **Lines kept (p50)** | The median change's share of lines kept. Every change weighs the same, so read it next to churn. |
| **Change failure rate** | Matured changes that were reverted, reworked, or blamed for a bug within the window. |
| **Failing early** | Changes still inside their window that were already reverted or reworked. |
| **Lead time (p50)** | First commit to merge. |
| **Time to first review (p50)** | PR opened to the first review by a person other than the author (PR mode only). Reviews by AI review bots don't count. |
| **Size (p50)** | Lines added plus deleted, excluding `ignoreFiles`. |
| **Awaiting review** | Open, non-draft PRs that no person has reviewed yet. With agents in the loop, review is usually the bottleneck. |

A change **matures** once its durability window has passed. Until then it shows as *Maturing* and doesn't count toward rates. A change that is reverted or reworked inside its window shows as *Not durable* straight away, but still only counts toward rates once its window has passed, so recent periods aren't skewed by failures being known before successes. The window and threshold are configurable.

**Fixes and reverts** (changes that revert or fix earlier ones) are counted, but left out of every durability metric: a revert is not durable output, and counting it would make every failure add to throughput.

### PRs or commits

A *change* is either a merged pull request or a commit on the branch:

- **`--unit prs`**: each PR merged into the branch is one change. PRs are selected by merge date, so a PR opened long ago but merged in the period counts.
- **`--unit commits`**: each commit on the branch's first-parent history is one change. A branch merged without a PR counts as one change carrying all its commits. Use this for solo or push-to-main repos.
- **`--unit auto`** (default): uses commits when more changes land directly on the branch than through PRs, and says so in the report.

In PR mode, the report notes how many direct commits it isn't counting. Commit mode has no review time, and its lead time is first commit to landing on the branch.

## Quick start (CLI)

Requires Node 22.13+ and a full clone (not shallow).

```bash
cd path/to/your/repo
npx agent-dora
open agent-dora-report/index.html
```

Auth comes from `GITHUB_TOKEN`, `GH_TOKEN`, or your existing `gh auth login`.

```
agent-dora [run|collect|report|rollup|classify|label] [options]

  --repo <owner/name>   default: the origin remote
  --unit <auto|prs|commits>
                        what counts as a change (default: auto)
  --branch <name>       branch to measure (default: the repo's default branch)
  --path <dir>          local clone with full history (default: .)
  --since <days>        how far back to collect (default: 180)
  --window <days>       durability window (default: 21)
  --threshold <0-1>     share of added lines that must survive (default: 0.7)
  --out <dir>           report directory (default: agent-dora-report)
  --db <file>           cache file; repeat it with rollup
  --pr <number>         for classify / label
```

Output: `index.html` (dashboard), `metrics.json` (everything, for your own tooling), `summary.md` and `changes.csv` (one row per change, for spreadsheets).

**Several repositories.** Run `collect` in each repository, then combine their caches into one report:

```bash
npx agent-dora rollup --db ../api/.agent-dora/cache.db --db ../web/.agent-dora/cache.db --out team-report
```

The repositories must use the same unit, window and threshold.

Durability results are cached in `.agent-dora/cache.db` (SQLite). They can't change once a change matures, so later runs only measure new ones.

## GitHub Action

**Nightly dashboard on GitHub Pages.** Copy [`examples/agent-dora.yml`](examples/agent-dora.yml) to `.github/workflows/`, then set Settings → Pages → Source to *GitHub Actions*:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # durability needs full history
- uses: langell/agent-dora@v0
  id: dora
- uses: actions/upload-pages-artifact@v3
  with:
    path: ${{ steps.dora.outputs.report-dir }}
- uses: actions/deploy-pages@v4
```

Each run also writes the summary table to the job summary.

**Label PRs automatically.** [`examples/agent-dora-label.yml`](examples/agent-dora-label.yml) applies `ai:agent`, `ai:assisted` or `ai:none` to every PR, so authorship is visible in GitHub itself.

## How authorship is decided

In order of precedence:

1. **Label.** `ai:agent`, `ai:assisted` or `ai:none` on the PR always wins. Use these to correct misclassifications; the label action never overwrites a label a person set. If labels of different classes contradict each other, they're all ignored and the reason says so.
2. **Agent.** The PR author is a known agent account, or the head branch starts with an agent prefix (`codex/`, `copilot/`, `devin/`, `jules/`, `openhands/`). `claude/` and `cursor/` aren't in the defaults because interactive, person-driven tools create branches with those prefixes too; add them to `agentBranchPrefixes` if your team only uses them for autonomous runs.
3. **Assisted.** A commit message or the PR body matches an AI marker, such as a `Co-Authored-By` trailer for Copilot, Cursor or Codex, Claude's `noreply@anthropic.com` address, or `Generated with Claude Code`. Agents that share a name with people (Claude, Devin, Jules, Amp) are matched by their address, not their name, so a human co-author named Devin doesn't count.
4. **Human.** Everything else.

In commit mode there are no labels or PR authors: a commit is **agent** if its git author is a known agent (e.g. `Copilot`), **assisted** if it or any commit it merged has an AI trailer, and **human** otherwise.

Dependency bots (Dependabot, Renovate…) are excluded from all metrics. AI review bots (Copilot review, CodeRabbit…, see `botReviewers`) don't count as a first review.

## The dashboard

`index.html` is a single static page with no external requests. Tiles show the headline numbers with their change since the previous period. Below them: durable changes per week (count, rate, or each author's share), the per-author rates with 95% ranges, the survival curve, lead-time spread, size against lines kept, who fixed whom, review depth, hotspots, the review queue, and a change table you can search, filter, sort, link to (filters live in the URL) and download as CSV.

## What else the report shows

- **By tool.** Every metric per AI tool (Claude, Copilot, Codex, Cursor, Devin…), read from whatever marked the change as AI-written. Map your own agents with `tools`.
- **This period vs the last.** The headline metrics for the latest `compareDays` (default 28) of matured changes next to the 28 before, computed from the changes themselves, so there's no history to keep.
- **Who fixed whom.** Reverts, rework and bugs inside the window, by the author class of the change fixed and of the change (or bug report) that fixed it.
- **Review depth (PR mode).** How many PRs merged with no human review, or a human approval with nothing written ("rubber-stamped"), versus reviews that commented or requested changes.
- **Hotspots.** Directories (first `hotspotDepth` segments, default 2) that lost the most added lines.
- **Survival curve.** Share of lines left at each of `checkpointDays` (default 7 and 14) and at the end of the window. Each checkpoint adds a `git blame` per changed file; set `checkpointDays` to `[]` to skip it.
- **How authorship was decided.** Counts per signal (label, agent account, branch prefix, trailer), so you can see how much rests on weaker signals.

## Linking fixes to the changes they fix

Reverts are detected automatically: `git revert` commits, GitHub's Revert button, and PRs titled `Revert "<title>"`. For other fixes, use either of these conventions (in commit mode, reference the commit SHA instead of `#123`, e.g. `Caused-by: 1a2b3c4`):

- Put a **rework label** (`hotfix`, `rework` or `regression`) on the fixing PR and mention the original as `#123`.
- Write **`Caused-by: #123`** in a bug issue (labelled `bug`) or in a fixing PR's description.

A fix only counts against a PR if it lands within that PR's durability window.

## Configuration

Optional. Add `.agent-dora.json` to your repo root. Arrays replace the defaults; `labels` and `tools` merge key by key. Unknown keys print a warning, and values of the wrong type stop the run with an error.

```json
{
  "unit": "auto",
  "branch": "main",
  "windowDays": 21,
  "survivalThreshold": 0.7,
  "minSurvivalLines": 5,
  "sinceDays": 180,
  "checkpointDays": [7, 14],
  "compareDays": 28,
  "hotspotDepth": 2,
  "labels": { "rework": ["hotfix", "rework", "regression", "follow-up"] },
  "agentBranchPrefixes": ["claude/", "codex/", "copilot/", "bot/"],
  "agentAuthors": ["Copilot", "claude", "my-internal-agent"],
  "assistedPatterns": ["Co-Authored-By:.*\\b(Claude|Copilot|Cursor)\\b"],
  "tools": { "My Agent": "my-internal-agent" },
  "ignoreAuthors": ["dependabot", "renovate"],
  "botReviewers": ["copilot-pull-request-reviewer", "coderabbitai"],
  "ignoreFiles": ["**/package-lock.json", "**/generated/**"]
}
```

See [`src/config.ts`](src/config.ts) for every option and its default.

## How durability is measured

For each change:

1. Find the commits on the branch that carry the change's lines: the squash commit, the rebased commits, or every commit merged by a merge commit (in commit mode, the commit itself, or everything a merge brought in).
2. Run `git blame -w -M` at the merge commit to count the lines those commits added (the baseline). Lockfiles, build output and other `ignoreFiles` are skipped.
3. Run `git blame -w -M` again at the last default-branch commit before *merge + window*, and count how many of those lines are still attributed to the PR's commits. Renamed files are followed, and lines moved within a file keep their author.
4. Survival = surviving ÷ baseline. Changes adding fewer than `minSurvivalLines` (default 5) measurable lines are judged on reverts and rework alone, since a single later edit would swing their share.

Known limits:

- Lines moved to a *different* file count as churned.
- Whitespace-only edits and lines moved within a file don't count as churn.
- PRs with more than 100 commits are only partly read.
- PRs that only delete lines have nothing to churn, so they're judged on reverts and rework alone.

## Why not plain DORA?

DORA still measures your delivery system well. What it can't tell you is whether agent output is *sticking*: a change can deploy cleanly and still be quietly rewritten two weeks later. Durable throughput counts only the changes that hold up, which makes it hard to game by shipping more, smaller or sloppier PRs. For the reasoning in more depth, see the [DORA research program](https://dora.dev) and its work on AI-assisted development.

## Roadmap

- AI cost per durable change (Claude Code OpenTelemetry, Anthropic Admin API)
- Deployment data (GitHub Deployments, Vercel) for true deploy-based lead time
- Escaped defects from incident trackers (Linear, Jira, PagerDuty)

## Development

```bash
npm install
npm test        # type-check and run the test suite (includes real git fixtures)
node dist/src/cli.js --help
```

## License

MIT
