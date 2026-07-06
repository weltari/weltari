# Week 1 Kickoff — Walking Skeleton (paste this to start the session)

Build the Week-1 walking skeleton for Weltari in this repository (`D:\devproj\weltari`, remote `https://github.com/weltari/weltari`). I am not a professional developer — explain plainly, recommend, and let me decide only where a genuine value judgment remains.

## Read first, in this order

1. `Coding Guide/AI Coding Guide.md` — your binding rulebook; also `Coding Guide/Task Completion Checklist.md` (the definition of done for every task).
2. `Stack Session/FINAL - Stack Decision.md` — the decided 14-item stack.
3. `Stack Session/Owner Decisions (2026-07-06).md` + `Stack Session/Fact-check Addendum (Context7 + web, 2026-07-06).md` — owner overrides (WeChat = official claw bots; Zod v4 everywhere — TypeBox dropped; AI SDK pinned to v6) and verified versions.
4. `Stack Requirements Brief.md` and `UI Spec (skeleton).md` — the requirements.
5. `builder.md` — documentation rules (structure.md per module, docs updated same-commit).
6. `Weltari V1 - Architecture & Structure (Rev 4).md` — reference only; on conflict the Brief and FINAL decision win.

## What to build (the de-risk plan's "naked hot path, tortured")

The smallest real vertical slice, in the final repo structure (this is the product's first commit series, not a throwaway):

- Repo skeleton per the Coding Guide's canonical layout; commit #1 promotes `Coding Guide/tsconfig.json` and `Coding Guide/eslint.config.mjs` into place, plus package.json (Node 24 LTS, ESM, exact pins), Vitest 4, Prettier, CI workflow.
- Fastify 5 serving: SSE event stream (`GET /v1/events`, event id = event-log seq, `Last-Event-ID` replay) + schema-validated POST command routes (Zod v4; protocol schemas live in the MIT-side protocol package).
- better-sqlite3 (WAL) behind hand-written repositories (import fence enforced); append-only event log; the hand-rolled job-ledger tables (idempotency keys, leases, states) + croner.
- ContextAssembler with byte-stable stable-first prefix + dynamic tail (unit-tested byte stability).
- LLM layer: `ai` v6 + `@openrouter/ai-sdk-provider` (per-character provider pinning); a scripted 3-call scene turn (Narrator → character → narration) streamed sentence-by-sentence to a bare React 19 + Vite 8 page.
- Kill harness: script that `kill -9`s the process at injection points (mid-stream, between calls, pre-commit) and restarts in a loop — this becomes a permanent CI job.
- Tests alongside every piece (Vitest), per the Invariants & Test Templates file. Zod v4 `safeParse` at every trust boundary from day one.

Ask me for an OpenRouter API key when you need it (env var only — never committed).

## Success criteria (all must be demonstrated, numbers from the brief)

(a) first sentence rendered **< 10 s** with a ~50K-token stable prefix on a 256K-class model; (b) provider-reported cached tokens **≥ 80 %** of the stable prefix on turns 2+ across 20 consecutive turns; (c) every kill/restart cycle reaches a consistent state with **zero duplicate or lost events**, and a reconnecting client resumes via `Last-Event-ID`; (d) the same stream consumed by `curl -N` with resume; (e) idle RSS **< 150 MB**.

If (b) fails with pinned providers → revisit the LLM-layer choice before building on it. If (c) fails → fix the ledger claim/lease SQL before any feature work.

## Process rules

- Small commits (one logical change each), pushed to GitHub as you go; follow the Task Completion Checklist before calling anything done.
- Never modify the spec/session documents (`Stack Requirements Brief.md`, `UI Spec (skeleton).md`, `Stack Session/`, Rev 3/Rev 4).
- Work is "vibe coding" with the owner supervising: after each milestone-sized step, summarize plainly what exists and what's next.
