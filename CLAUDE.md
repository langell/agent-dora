# agent-dora

CLI + GitHub Action measuring delivery metrics (durable throughput, churn, change failure rate)
split by agent / assisted / human authorship. TypeScript on Node 22, zero runtime dependencies.

## Commands
- `npm test`: type-check and run the suite (includes real temporary git repos)
- `node dist/src/cli.js --help`: run the local build (after `npx tsc`)
- Release: `npm version patch && git push --follow-tags`. The `release.yml` workflow publishes to npm
  via trusted publishing and moves the `v0` tag. Never rename `release.yml`: npm's trusted publisher is bound to it.

## Layout
- `src/constants.ts`: every shared value (see below)
- `src/collect.ts` → `commits.ts` / `durability.ts` / `rework.ts` → `metrics.ts` → `report.ts`
- `src/report.ts` renders markdown and a self-contained HTML dashboard; its browser script gets
  everything it shares with the server through the embedded `ui` payload

## No magic strings
Never write a bare string or number literal whose meaning is shared, compared against, or would need
to change in more than one place. Name it once and reference the name.

- **Domain values** (author classes, units, statuses, kinds, commands) go in `src/constants.ts` as an
  `as const` object with a type of the same name derived from it:
  `export const Unit = { Prs: 'prs', Commits: 'commits' } as const;` and
  `export type Unit = ValueOf<typeof Unit>;`. Compare with `Unit.Commits`, never `'commits'`.
- **Iterate the constant**, don't re-list its values: `AUTHOR_CLASSES`, `CLASS_KEYS`, `Object.values(...)`.
- **Never branch on human-readable text.** If code needs to know *why* something happened, add a
  typed field (e.g. `Classification.source`) rather than parsing a message like `reason.startsWith('label ')`.
- **Formats and units**: use the helpers (`isoDate`, `isoMinute`, `shortSha`, `prId`, `githubCommitUrl`)
  and the `MS_PER_*` time constants. No `slice(0, 10)`, `86_400_000` or `` `#${n}` ``.
- **Module-local values** used only inside one file (API page sizes, git format codes, chart geometry)
  are named `const`s at the top of that file.
- **HTML ids and wording shared by markup and the client script** come from `report.ts` (`Ids`,
  `nouns()`, `STATUS_STYLE`) and reach the browser through the `ui` payload. Don't retype them in `CLIENT_JS`.

Fine as literals: user-facing prose (log lines, errors, help text), CSS, regexes held in a named
constant, config defaults defined once in `DEFAULT_CONFIG`, and expected values in tests (tests
assert the literal serialized format on purpose).
