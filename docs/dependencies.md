# Dependency ledger

Every dependency gets one `## <package>` heading (CI keys on the heading — Guide D8). Entries follow the template in `Coding Guide/Task Completion Checklist.md`. Versions are exact pins; bumps happen only in the monthly `chore(deps):` PR.

## zod

- What: the one schema language — wire schemas in `@weltari/protocol`, `safeParse` at every trust boundary (Guide §0.1, B1).
- Why not stdlib / an existing dep: no stdlib runtime validation; TypeBox dropped by Guide §0.1 (Zod v4 emits JSON Schema natively).
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 4.4.3
- Swap documented: n/a (load-bearing by owner decision)

## better-sqlite3

- What: synchronous SQLite driver — WAL, one write connection, transactions that a throw rolls back (FINAL item 7).
- Why not stdlib / an existing dep: `node:sqlite` is still experimental in Node 24 and lacks the maturity/prebuilds record; a synchronous driver makes single-writer discipline structural (Brief §2.3).
- License: MIT
- Maintenance: release within last 12 months (Node 24 prebuilds since 12.0.0), checked 2026-07-06.
- Pinned: 12.11.1
- Swap documented: repository layer caps the future Postgres swap at "write a driver" (Brief §2.7).

## @types/better-sqlite3

- What: TypeScript types for better-sqlite3 (driver ships none).
- Why not stdlib / an existing dep: DefinitelyTyped is the only source.
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 7.6.13
- Swap documented: n/a

## typescript

- What: the compiler — the one reviewer that reads every line every time (Guide §A).
- Why not stdlib / an existing dep: the language choice itself (FINAL stack item 1).
- License: Apache-2.0 (AGPLv3-compatible; never copied into MIT packages).
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 5.9.3 (TS 6.x exists — re-evaluate monthly, Guide §0.2)
- Swap documented: n/a

## eslint

- What: lint runner enforcing the Guide's `[lint]` rules at zero warnings.
- Why not stdlib / an existing dep: mandatory for type-aware rules (Guide §0.4).
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 10.6.0
- Swap documented: n/a (Biome rejected, Guide §0.4)

## @eslint/js

- What: ESLint's own recommended core rule set, extended by our flat config.
- Why not stdlib / an existing dep: companion package to eslint 10.
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 10.0.1
- Swap documented: n/a

## typescript-eslint

- What: TS parser + type-aware rule sets (strictTypeChecked, stylisticTypeChecked).
- Why not stdlib / an existing dep: only bridge between ESLint and the TS type checker.
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 8.62.1
- Swap documented: n/a

## @eslint-community/eslint-plugin-eslint-comments

- What: forces every `eslint-disable` to carry a written reason (Guide A7).
- Why not stdlib / an existing dep: no core rule audits disable directives.
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 4.7.2
- Swap documented: n/a

## eslint-plugin-n

- What: provides `n/no-process-env` — secrets readable only in `boundary/config/env.ts` (Guide B15).
- Why not stdlib / an existing dep: no core rule fences `process.env`.
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 18.2.1
- Swap documented: n/a

## eslint-plugin-no-only-tests

- What: bans `.only(` in committed tests (Guide D1–D5).
- Why not stdlib / an existing dep: core ESLint has no test-focus rule.
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 3.4.0
- Swap documented: n/a

## eslint-plugin-react-hooks

- What: rules-of-hooks checking for the `apps/web` React 19 client.
- Why not stdlib / an existing dep: the only maintained hooks-correctness linter.
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 7.1.1
- Swap documented: n/a

## @vitest/eslint-plugin

- What: bans focused/disabled tests at lint time (Guide D1–D5).
- Why not stdlib / an existing dep: vitest-aware variants of the no-only rules.
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 1.6.21 (guide said "pin-exact-at-install"; resolved 2026-07-06)
- Swap documented: n/a

## eslint-config-prettier

- What: applied last in the flat config; turns off rules that would fight Prettier (Guide §0.4).
- Why not stdlib / an existing dep: canonical Prettier/ESLint peace treaty.
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 10.1.8
- Swap documented: n/a

## prettier

- What: the formatter; `format:check` is gate step 1.
- Why not stdlib / an existing dep: settled by Guide §0.4.
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 3.9.4
- Swap documented: n/a

## globals

- What: environment-global maps (node, browser) for the flat ESLint config.
- Why not stdlib / an existing dep: flat config requires explicit global sets.
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 17.7.0
- Swap documented: n/a

## @types/node

- What: Node 24 API types for the compiler.
- Why not stdlib / an existing dep: TS needs the ambient Node types.
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 24.13.2
- Swap documented: n/a

## vitest

- What: the test runner (unit + invariants projects; Guide E, Invariants file).
- Why not stdlib / an existing dep: `node:test` lacks projects, v8 coverage thresholds, and the mock seams the templates use; settled by Guide §0.3.
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 4.1.10 (do not adopt the 5.0 beta)
- Swap documented: n/a

## @vitest/coverage-v8

- What: V8 coverage provider driving the per-glob branch thresholds (Guide E3).
- Why not stdlib / an existing dep: vitest's own coverage companion.
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 4.1.10 (must match vitest)
- Swap documented: n/a

## knip

- What: unused-dependency / dead-export detector; gate step 5.
- Why not stdlib / an existing dep: no stdlib equivalent; named by Guide D1–D5.
- License: ISC
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 6.24.0
- Swap documented: n/a

## @commitlint/cli

- What: machine-checks conventional commit messages (Guide D6).
- Why not stdlib / an existing dep: the standard conventional-commits checker.
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 21.2.0
- Swap documented: n/a

## @commitlint/config-conventional

- What: the conventional-commits rule preset commitlint extends.
- Why not stdlib / an existing dep: companion preset to @commitlint/cli.
- License: MIT
- Maintenance: release within last 12 months, checked 2026-07-06.
- Pinned: 21.2.0
- Swap documented: n/a
