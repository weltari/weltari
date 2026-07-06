# repo — root toolchain & workspace layout

Purpose: everything at the repo root that makes the gate run: compiler config, lint config, formatter, test runner, dep hygiene, CI.

## Contract

- Inputs: source under `packages/*` and `apps/*`; owner spec docs under `docs/` (read-only for agents).
- Outputs: `npm run gate` exit code — the Definition of Done (Guide §9).
- Never: weaken a strict-family tsconfig flag; add a top-level directory outside the canonical layout (Guide §0.6, D7).

## File table

| File | What it does / talks to |
| --- | --- |
| `package.json` | Root workspace manifest: npm workspaces (`packages/*`, `apps/*`), gate scripts, exact-pinned dev toolchain (Guide A1, §7). |
| `package-lock.json` | Committed lockfile; CI installs with `npm ci` (Guide D10). Generated — never hand-edited. |
| `.npmrc` | `save-exact` + `engine-strict`: installs pin exactly and refuse wrong Node (Guide A1). |
| `.node-version` | `24` — the only supported Node major (FINAL item 1). |
| `tsconfig.base.json` | The full strict flag set every package extends (Guide §7); promoted verbatim from `docs/Coding Guide/tsconfig.json`. |
| `tsconfig.json` | Solution file: project references only, no sources. |
| `eslint.config.mjs` | Flat config with the A/B/C fences (import fences, assertion ban, `.parse()` ban, engine clock ban…); promoted from `docs/Coding Guide/eslint.config.mjs`. |
| `.prettierrc.json` / `.prettierignore` | Prettier 3; owner docs, lockfile and generated output are not formatted. |
| `vitest.config.mjs` | Two projects: `unit` (colocated `src/**/*.test.ts`) and `invariants` (`tests/invariants/**`); v8 coverage with per-glob branch thresholds (Guide E3). |
| `knip.json` | Knip workspace map: entries per package so unused deps/exports fail the gate. |
| `commitlint.config.mjs` | Conventional-commit checking (Guide D6). |
| `.github/workflows/ci.yml` | CI: `npm ci` → structural checks (`scripts/*.mjs`) → `npm run gate` → protocol emit diff; kill harness; gitleaks secret scan; commitlint + tests-accompany on PRs. |
| `scripts/check-dep-ledger.mjs` | D8: every declared dep has a `## <name>` heading in `docs/dependencies.md` and an exact pin (no `^`/`~`). |
| `scripts/check-licenses.mjs` | A12/D8: AGPL core + MIT edges license fields, MIT packages free of AGPL workspace deps, direct deps on the approved license list. |
| `scripts/check-c6-handlers.mjs` | C6: `uncaughtException`/`unhandledRejection` registered exactly once each, both in `main.ts`. |
| `scripts/check-catch-audit.mjs` | C3 (crude by design): every `catch` in server src shows rethrow / `return err` / `fatal` / warn+ log / `CATCH-OK` marker nearby. |
| `CLAUDE.md` | The ~1-page agent index (builder.md §1). |

## Deviations recorded

- `packages/plugin-sdk` created at the gateway milestone (M2 step 4) as planned — MIT, referenced from the solution `tsconfig.json` and `apps/server`.
- Root `typecheck` is `tsc -b` only until `apps/web` exists (then `tsc -b && tsc -p apps/web`, Guide §7).
- `vitest.config` is `.mjs`, not `.ts`, so the config file needs no tsconfig project membership for type-aware lint (keeps the promoted eslint config unmodified).
