# agent-dora

**Delivery metrics for teams shipping with AI coding agents.**

Once agents write much of your code, the classic DORA metrics are easy to inflate: deployment frequency and lead time go up while quality debt piles up where they can't see it. agent-dora measures what counts now: **how many changes ship and stay shipped**. Every metric is split by who wrote the code:

| Author | Meaning |
|---|---|
| **Agent** | A coding agent opened the PR (Copilot coding agent, Claude, Codex, Devin, Cursor, Jules…) |
| **Assisted** | A person opened the PR, with AI co-authored commits (e.g. Claude Code's `Co-Authored-By` trailer) |
| **Human** | No AI signal |

It runs as a CLI or a GitHub Action, uses only the GitHub API and your local git history, and produces a static dashboard. No server, no SaaS, and no data leaves your machine or CI runner.

## Metrics

| Metric | Definition |
|---|---|
| **Durable PRs / week** | The headline metric. Merged PRs that, 21 days after merging, were not reverted or reworked **and** still have ≥70% of their added lines in the default branch. |
| **Durable rate** | Share of matured PRs that were durable. |
| **Line churn** | Share of added lines gone 21 days after merge, measured with `git blame` at merge time and at merge + 21 days. |
| **Change failure rate** | Matured PRs that were reverted, reworked, or blamed for a bug within the window. |
| **Lead time (p50)** | First commit to merge. |
| **Time to first review (p50)** | PR opened to first review by someone other than the author. |
| **PR size (p50)** | Lines added plus deleted. |
| **Awaiting review** | Open, non-draft PRs that nobody has reviewed yet. With agents in the loop, review is usually the bottleneck. |

A PR **matures** once its durability window has passed. Until then it shows as *Maturing* and doesn't count toward rates. The window and threshold are configurable.

## Quick start (CLI)

Requires Node 22.13+ and a full clone (not shallow).

```bash
cd path/to/your/repo
npx agent-dora
open agent-dora-report/index.html
```

Auth comes from `GITHUB_TOKEN`, `GH_TOKEN`, or your existing `gh auth login`.

```
agent-dora [run|collect|report|classify|label] [options]

  --repo <owner/name>   default: the origin remote
  --path <dir>          local clone with full history (default: .)
  --since <days>        how far back to collect (default: 180)
  --window <days>       durability window (default: 21)
  --threshold <0-1>     share of added lines that must survive (default: 0.7)
  --out <dir>           report directory (default: agent-dora-report)
  --pr <number>         for classify / label
```

Output: `index.html` (dashboard), `metrics.json` (everything, for your own tooling) and `summary.md`.

Durability results are cached in `.agent-dora/cache.db` (SQLite). They can't change once a PR matures, so later runs only measure new PRs.

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

1. **Label.** `ai:agent`, `ai:assisted` or `ai:none` on the PR always wins. Use these to correct misclassifications; the label action never overwrites a label a person set.
2. **Agent.** The PR author is a known agent account, or the head branch starts with an agent prefix (`claude/`, `codex/`, `copilot/`, `cursor/`, `devin/`…).
3. **Assisted.** A commit message or the PR body matches an AI marker, such as `Co-Authored-By: Claude …` or `Generated with Claude Code`.
4. **Human.** Everything else.

Dependency bots (Dependabot, Renovate…) are excluded from all metrics.

## Linking fixes to the PRs they fix

Reverts are detected automatically: `git revert` commits, GitHub's Revert button, and PRs titled `Revert "<title>"`. For other fixes, use either of these conventions:

- Put a **rework label** (`hotfix`, `rework` or `regression`) on the fixing PR and mention the original as `#123`.
- Write **`Caused-by: #123`** in a bug issue (labelled `bug`) or in a fixing PR's description.

A fix only counts against a PR if it lands within that PR's durability window.

## Configuration

Optional. Add `.agent-dora.json` to your repo root. Arrays replace the defaults; `labels` merges key by key.

```json
{
  "windowDays": 21,
  "survivalThreshold": 0.7,
  "sinceDays": 180,
  "labels": { "rework": ["hotfix", "rework", "regression", "follow-up"] },
  "agentBranchPrefixes": ["claude/", "codex/", "copilot/", "bot/"],
  "agentAuthors": ["Copilot", "claude", "my-internal-agent"],
  "assistedPatterns": ["Co-Authored-By:.*\\b(Claude|Copilot|Cursor)\\b"],
  "ignoreAuthors": ["dependabot", "renovate"],
  "ignoreFiles": ["**/package-lock.json", "**/generated/**"]
}
```

See [`src/config.ts`](src/config.ts) for every option and its default.

## How durability is measured

For each merged PR:

1. Find the commits on the default branch that carry the PR's lines: the squash commit, the rebased commits, or every commit merged by a merge commit.
2. Run `git blame -w` at the merge commit to count the lines those commits added (the baseline). Lockfiles, build output and other `ignoreFiles` are skipped.
3. Run `git blame -w` again at the last default-branch commit before *merge + window*, and count how many of those lines are still attributed to the PR's commits. Renamed files are followed.
4. Survival = surviving ÷ baseline.

Known limits:

- Lines moved to a *different* file count as churned.
- Whitespace-only edits don't count as churn.
- PRs with more than 100 commits are only partly read.
- PRs that only delete lines have nothing to churn, so they're judged on reverts and rework alone.

## Why not plain DORA?

DORA still measures your delivery system well. What it can't tell you is whether agent output is *sticking*: a change can deploy cleanly and still be quietly rewritten two weeks later. Durable throughput counts only the changes that hold up, which makes it hard to game by shipping more, smaller or sloppier PRs. For the reasoning in more depth, see the [DORA research program](https://dora.dev) and its work on AI-assisted development.

## Roadmap

- AI cost per durable change (Claude Code OpenTelemetry, Anthropic Admin API)
- Deployment data (GitHub Deployments, Vercel) for true deploy-based lead time
- Multi-repo and org-level reports
- Escaped defects from incident trackers (Linear, Jira, PagerDuty)

## Development

```bash
npm install
npm test        # type-check and run the test suite (includes real git fixtures)
node dist/src/cli.js --help
```

## License

MIT
