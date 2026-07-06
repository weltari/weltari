# Weltari — agent index (keep ~1 page; depth lives in docs/)

Single-process, self-hosted AI-RP world engine. TypeScript strict, Node 24 LTS, ESM only, npm workspaces. AGPL-3.0-only core; `packages/protocol` (and later `packages/plugin-sdk`) are MIT and must never import from `apps/*`.

## Commands

- `npm run gate` — the Definition of Done: format:check → lint (0 warnings) → typecheck (`tsc -b`) → full Vitest suite → knip. All must exit 0 before any task is called done.
- `npm test` / `npx vitest run --project invariants` — tests; invariant tests gate merges.
- Single test file: `npx vitest run path/to/file.test.ts`

## Layout (canonical — Guide §0.6; new top-level dirs are a CI failure)

- `packages/protocol/` — MIT. Zod v4 wire schemas; emitted `schemas/*.json`.
- `apps/server/src/` — `storage/` (only SQLite site) · `llm/` (only AI-SDK site) · `engine/` (no wall-clock reads) · `ledger/` · `gateway/` · `boundary/` · `http/` · `observability/` · `main.ts`.
- `apps/web/` — React 19 + Vite 8; imports `@weltari/protocol` only, never server code.
- `tests/` (`invariants/`, `helpers/`, `fakes/`) · `tools/` (kill harness) · `scripts/` (CI checks) · `fixtures/`.

## Never violate (machine-enforced; full rules in `docs/Coding Guide/AI Coding Guide.md`)

1. Repositories are the only SQL site; the `events` table is append-only — no UPDATE/DELETE ever.
2. Every trust boundary validates with Zod v4 `safeParse` via `validateAt()`; `.parse()` is banned; no `any`, no type assertions (`as const` excepted).
3. Prompt builders return `{ stablePrefix, dynamicTail }`; nothing dynamic may enter the prefix (byte-stability tests enforce).
4. LLM output is never directly durable — schema gate then engine-state gate (B6).
5. Every event carries `actor_id`; secrets live only in env vars read in `boundary/config/env.ts`.
6. Docs page changes in the same commit as the code (builder.md); tests ship with the code; deps need a `docs/dependencies.md` entry; versions are exact pins, bumped only in monthly `chore(deps)` PRs.

## Vocabulary

Terms come from Rev 4 §3 — use them exactly: `mailbox`, `ledger_job`, `turn_envelope`, `sublocation`, `proposal`, `reflection`. The log-only event trail is `trail`; pino diagnostics are `logger`/`diag`; never the bare identifier `log`.

## Deeper docs

`docs/INDEX.md` → per-module wiki pages · `docs/dependencies.md` (dep ledger) · binding rulebook: `docs/Coding Guide/` (AI Coding Guide + Task Completion Checklist + Invariants & Test Templates) · requirements: `docs/Stack Requirements Brief.md`, `docs/UI Spec (skeleton).md` · stack: `docs/Stack Session/FINAL - Stack Decision.md` + Owner Decisions + Fact-check Addendum. Spec/session docs are read-only for agents.
