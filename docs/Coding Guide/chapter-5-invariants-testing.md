# Chapter N: Weltari invariants and the testing strategy

This chapter turns the Brief §2 hard constraints into permanent, machine-checked guards, and defines how AI agents write tests. Owner Decision #4.1 is binding here: **tests grow with the code from day one; the Week-1 kill-harness and cache-hit checks become permanent CI tests.** Tests are the enforcement arm of the docs (builder.md §6): a rule without a failing test will eventually be broken politely and confidently by an AI agent.

## Rules

### A. Invariant guards (one guard per Brief §2 constraint)

**R1. The events table is append-only: the events repository exposes only `append()` and read methods — no update, no delete, ever.**
*Why:* the event log is the game's only true history; editing it silently corrupts every memory, wiki, and map built from it.
*Enforced by:* (a) API shape — `EventLogRepository` has no mutating methods (TypeScript interface, snippet below); (b) SQLite `BEFORE UPDATE` / `BEFORE DELETE` triggers on `events` that `RAISE(ABORT)` (migration snippet below); (c) invariant test `tests/invariants/event-log-append-only.test.ts` that opens a raw test connection, attempts `UPDATE` and `DELETE`, and asserts both throw.

**R2. All durable writes to one character serialize through its mailbox; write a concurrency test proving it.**
*Why:* two simultaneous writes to the same character (a scene turn and a social-post reaction) must never interleave and half-overwrite each other.
*Enforced by:* invariant test `mailbox-serializes.test.ts` (template below): enqueue N concurrent writes that each read-modify-write a counter with an artificial `await`; final value must equal N (a lost update proves a race). Plus the optimistic-`version` backstop test: a stale-version write must throw, not overwrite.

**R3. Every job-ledger semantic gets its own test, from the four templates below: (a) idempotency keys are UNIQUE — enqueueing the same key twice yields one row; (b) an expired lease makes a `running` job claimable again; (c) after `max_attempts` failures the job lands in `parked` (the dead-letter lane), never retried automatically; (d) per-world concurrency — two World Agent jobs for one world never both hold `running`.**
*Why:* the ledger is what makes crashes harmless; if any of these four silently regresses, crashes start duplicating or losing work.
*Enforced by:* `tests/invariants/ledger-*.test.ts`, all four run in the `invariants` Vitest project which gates every merge (R13). Lease and dead-letter tests use the injected fake clock (R10) — no `sleep`.

**R4. The kill -9 harness is a permanent CI job, not a Week-1 script.**
*Why:* "safe to pull the plug at any moment" is the product promise to NAS users; only repeated real kills prove it.
*Enforced by:* `tools/kill-harness.mjs` (supervisor sketch below) spawns the real server against a temp SQLite file, drives a scripted scene turn with the FakeLLM, and `SIGKILL`s the child when it prints a named fault-point marker (`FAULT_POINT:mid_stream`, `between_calls`, `pre_commit`, plus the Milestone-2 points: `mid_reflection`, `mid_painter`, `mid_cron`). After each kill it restarts the server and runs `tools/verify-consistency.mjs`: `PRAGMA integrity_check` returns `ok`; event ids strictly increasing with no duplicates; no `running` job whose lease has expired after the startup sweep; a reconnecting SSE client with `Last-Event-ID` receives exactly the missed events once. CI: 25 cycles per PR (~5–8 min, GitHub Actions `ubuntu-latest`), 100 cycles nightly (the Milestone-2 bar). Local Windows dev note: the harness uses `child.kill('SIGKILL')`, which Node implements as unconditional termination on Windows — same semantics, runnable locally.

**R5. Every prompt builder has a byte-stability test: build the prompt twice with identical inputs, assert the stable prefix is byte-identical (`Buffer.compare === 0`); build it with only dynamic inputs changed, assert the prefix bytes are still identical.**
*Why:* LLM providers give ~90% discounts only on the part of the prompt that is byte-for-byte the same as last time — one drifting byte (a timestamp, a reordered key, a locale-dependent number) silently re-bills the whole ~50K-token prefix on every single turn, multiplying the daily token budget.
*Enforced by:* one test file per assembler in `tests/invariants/prompt-prefix/`, using the shared template below; every `ContextAssembler` must return `{stablePrefix: string, dynamicTail: string}` as separate fields precisely so this is testable. Also assert the world clock string and latest-turn text appear only in `dynamicTail`. CI additionally keeps the Week-1 cache-hit check alive as a nightly job against a real provider: log `cached_tokens` over 20 turns, fail under 80% (Owner Decision #4.1; FINAL §6 criterion b).

**R6. Only repositories touch SQL; the raw database handle is never exported outside `src/storage/`.**
*Why:* if any module writes SQL directly, the append-only trigger, the mailbox rule, and the future Postgres swap all quietly break.
*Enforced by:* the ESLint `no-restricted-imports` fence (Chapter 1 owns the lint config); belt-and-braces here: invariant test `repository-fence.test.ts` greps the source tree (builder.md §6 names exactly this test) — `better-sqlite3` may be imported only in `src/storage/db.ts`, and the strings `db.prepare(`/`db.exec(` may appear only under `src/storage/repositories/` and `src/storage/migrations`. No runtime stack-inspection assertion — module non-export plus lint plus grep-test is three fences already; runtime caller checks are fragile and add hot-path cost.

**R7. The versioned JSON Schemas in `@weltari/protocol` are snapshot-committed, and CI diffs them for breaking changes.**
*Why:* the frontend, the V1.5 CLI, and future external games all build against these schemas; an unnoticed breaking change strands every client.
*Enforced by:* (a) generated `schemas/*.json` are checked into the repo; CI runs the generator then `git diff --exit-code -- packages/protocol/schemas` — any ungenerated drift fails; (b) a CI step runs **`json-schema-diff`** (npm, v1.0.0, Apache-2.0, Atlassian — verified current 2026-07) old-vs-new for each changed schema: any `removalsFound` (requests the old schema accepted that the new one rejects) fails CI unless the PR also bumps `protocol_version` major; (c) for the OpenAPI 3.1 command surface, **`oasdiff`** (Go binary, Apache-2.0, actively maintained — repo pushed 2026-07-06) with `oasdiff breaking --fail-on ERR` as a second gate. Note the Apache-2.0 tools are CI-only — nothing Apache-licensed is copied *into* the MIT protocol package (FINAL preamble rule).

**R8. LLM output is never directly durable: every tool call is validated (Zod v4 `safeParse`) before any repository write, and every tool has a rejection test.**
*Why:* a hallucinated tool call must bounce off the engine loudly, not become permanent game state.
*Enforced by:* per-tool test template: feed a malformed payload → assert `safeParse` failure is logged as a dev-channel event and **zero rows changed** (assert via repository reads, not internals). The Zod schemas themselves belong to the trust-boundary chapter; this chapter owns the "invalid ⇒ nothing durable" tests.

**R9. Dev-channel parity: integration tests observe the system through the same SSE dev channel users debug with — subscribe with dev mode on, assert on the emitted log-only events (tool call + validation outcome, CACHE writes, turn-envelope open/close).**
*Why:* if tests and users watch through the same window, the window itself stays honest — and tests never need to reach into private internals.
*Enforced by:* the shared test helper `subscribeDevChannel()` in `tests/helpers/`; review check: integration tests that import engine internals instead of the helper are rejected.

### B. How AI agents write tests

**R10. All time is injected: engine code takes a `WorldClock` (fictional, monotonic) and a `SystemClock` (wall time, for leases/TTLs); tests pass fakes and advance them explicitly. All LLM calls go through the `ModelRegistry` seam; tests pass a `FakeLLM` that returns scripted responses.**
*Why:* a test that waits for real time or a real model is slow, flaky, and costs money — determinism makes AI-written tests trustworthy.
*Enforced by:* the two clock interfaces and the FakeLLM live in `tests/fakes/`; Chapter 1's lint fence bans `Date.now()`/`new Date()` in `src/engine/`; review check: any test containing `setTimeout`-based waiting or a real API key is rejected. (The AI SDK ships mock models in `ai/test` — evaluate `MockLanguageModelV2` against the pinned `ai@^6` in Week 1; our own `FakeLLM` at the ModelRegistry seam is the stable seam either way.)

**R11. Tests ship in the same task as the code — every task that adds or changes behavior adds or changes tests in the same commit. Bulk after-the-fact test backfill is banned.**
*Why:* tests written with the code encode intent; tests backfilled later merely encode whatever the (possibly buggy) code already does.
*Enforced by:* CI script `tools/check-tests-accompany.mjs`: fail if a PR adds a new file under `src/` (excluding `src/frontend/`) with no test file added or modified in the same PR; plus patch-coverage gate (R12). Review check: PR descriptions must name which invariant/behavior each new test pins.

**R12. Coverage: no vanity 100%. The gating metric is (a) patch coverage — lines changed in the PR — ≥ 85%, and (b) branch coverage ≥ 90% on the guard modules `src/storage/`, `src/engine/`, `packages/protocol/`. `src/frontend/` is excluded from gates.**
*Why:* 100%-everything pushes AI agents to write meaningless assertion-free tests; high branch coverage on the crash/money-critical modules is what actually prevents disasters.
*Enforced by:* Vitest coverage with `@vitest/coverage-v8`, `coverage.thresholds` per-glob (snippet below); patch coverage via the coverage JSON summary compared against `git diff` in `tools/patch-coverage.mjs`.

**R13. Test what breaks silently; do not over-test what is visible. In scope: repositories, ledger semantics, mailboxes, the scene-engine state machine (turn envelope open→calls→validated commits→close, including interrupt and resume paths), protocol validation, prompt-prefix stability, crash recovery. Out of scope: pixel/DOM snapshot tests of the UI, and any assertion on LLM *prose content* — assert the shape (schema-valid tool call, event emitted), never the wording.**
*Why:* UI pixels and model prose change constantly and legitimately; tests on them train agents to update tests instead of thinking, while a silent ledger regression eats real data.
*Enforced by:* review check + lint ban on `toMatchSnapshot()` outside `packages/protocol/` (schema snapshots are the one sanctioned snapshot use); the Vitest `invariants` project (see config) must pass for every merge.

**R14. Tests assert outcomes through public seams — events on the stream, rows via repository reads, HTTP/SSE responses — never implementation details: no spying on private functions, no asserting internal call counts, no reaching into module state.**
*Why:* an AI agent asked to "make the tests pass" will edit whatever the test touches; outcome tests can only be satisfied by correct behavior, implementation-detail tests can be satisfied by matching the bug.
*Enforced by:* review check (grep for `vi.spyOn` on non-fake internals in PRs); nightly **StrykerJS mutation run** (`@stryker-mutator/core` 9.x + `@stryker-mutator/vitest-runner`, both verified current) over `src/storage` and `src/engine` — mutation score is *informative* (reported, trended), not a merge gate, because gating on it invites metric-gaming of its own.

**R15. Invariant tests are protected: any PR that modifies an existing file under `tests/invariants/` fails CI unless it carries the `invariant-change` label, which only the owner applies.**
*Why:* the cheapest way for an AI agent to "fix" a violated invariant is to edit the test that guards it — that path must be loud and human-approved.
*Enforced by:* CI step: `git diff --name-only origin/main...HEAD | grep '^tests/invariants/'` → non-empty ⇒ require the label (GitHub Actions `contains(github.event.pull_request.labels.*.name, 'invariant-change')`). Adding *new* invariant tests is always allowed.

**R16. The test runner is Vitest, pinned to the 4.1.x line (`"vitest": "~4.1.10"` at time of writing). Do not adopt the 5.0 beta.**
*Why:* Vitest 4 is the current stable major, explicitly supports Node ≥24 and Vite 8, and 4.1 keeps receiving backported fixes; betas contradict the "boring appliance" posture.
*Enforced by:* exact pin in `package.json` per the stack's pin-exact policy; monthly batched updates.

## Config or code snippets

**Append-only: repository shape + SQLite triggers** (migration `0001_events.sql`):

```sql
-- events: append-only event log (Brief §2.1). Rows are never updated or deleted.
CREATE TABLE events (
  id         INTEGER PRIMARY KEY,           -- monotonic; doubles as SSE Last-Event-ID
  world_id   TEXT NOT NULL,
  actor_id   TEXT NOT NULL,                 -- Brief §2.8: every event carries actor_id
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,                 -- JSON
  ts         TEXT NOT NULL
);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only (Brief §2.1)'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only (Brief §2.1)'); END;
```

```ts
// src/storage/repositories/event-log.ts — the interface HAS no mutating members.
export interface EventLogRepository {
  append(e: NewEvent): PersistedEvent;          // sole write path
  readSince(id: number, limit?: number): PersistedEvent[];
  readByScene(sceneId: string): PersistedEvent[];
}
```

```ts
// tests/invariants/event-log-append-only.test.ts
import Database from "better-sqlite3";
it("raw UPDATE and DELETE on events abort", () => {
  const db = new Database(testDbPath);
  expect(() => db.prepare("UPDATE events SET type='x' WHERE id=1").run())
    .toThrow(/append-only/);
  expect(() => db.prepare("DELETE FROM events WHERE id=1").run())
    .toThrow(/append-only/);
});
```

**Mailbox serialization template:**

```ts
// tests/invariants/mailbox-serializes.test.ts
it("N concurrent mailbox writes never lose an update", async () => {
  const N = 50;
  await Promise.all(Array.from({ length: N }, () =>
    mailboxes.enqueue(charId, async (state) => {
      const v = state.counter;               // read
      await Promise.resolve();               // yield: exposes interleaving
      return { ...state, counter: v + 1 };   // modify-write
    })));
  expect(charRepo.get(charId).counter).toBe(N); // any race ⇒ < N
});
```

**Ledger templates (fake clock — no sleeps):**

```ts
it("idempotency key is unique", () => {
  ledger.enqueue({ type: "reflect", key: "reflect:c1:s9", worldId });
  ledger.enqueue({ type: "reflect", key: "reflect:c1:s9", worldId }); // no-op
  expect(ledger.countByKey("reflect:c1:s9")).toBe(1);
});

it("expired lease returns the job to claimable", () => {
  const job = ledger.claimNext(workerA);           // running, lease_until = now+60s
  sysClock.advance("61s");
  ledger.sweepExpiredLeases();                      // the startup/poll sweep
  expect(ledger.claimNext(workerB)?.id).toBe(job.id);
});

it("max attempts parks the job (dead-letter)", () => {
  for (let i = 0; i < MAX_ATTEMPTS; i++) { failOnce(ledger, sysClock); }
  expect(ledger.get(jobId).state).toBe("parked");
  expect(ledger.claimNext(workerA)).toBeNull();     // never auto-retried
});

it("World Agent jobs serialize per world", () => {
  ledger.enqueue(worldAgentJob(worldId, "a")); ledger.enqueue(worldAgentJob(worldId, "b"));
  expect(ledger.claimNext(w1)).not.toBeNull();
  expect(ledger.claimNext(w2)).toBeNull();          // second blocked while first runs
});
```

**Prompt-prefix byte-stability template:**

```ts
// tests/invariants/prompt-prefix/character-assembler.test.ts
const fixed = characterFixture();                    // from fixtures/
it("stable prefix is byte-identical across calls", () => {
  const a = assembler.build(fixed), b = assembler.build(fixed);
  expect(Buffer.compare(Buffer.from(a.stablePrefix, "utf8"),
                        Buffer.from(b.stablePrefix, "utf8"))).toBe(0);
});
it("dynamic inputs never leak into the prefix", () => {
  const a = assembler.build(fixed);
  const b = assembler.build({ ...fixed,
    worldClock: laterClock, latestTurns: otherTurns });
  expect(b.stablePrefix).toBe(a.stablePrefix);       // only the tail may differ
  expect(a.stablePrefix).not.toContain(fixed.worldClock.render());
});
```

**Vitest config (Vitest 4.1.x, `@vitest/coverage-v8`):**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit",       include: ["src/**/*.test.ts"] } },
      { test: { name: "invariants", include: ["tests/invariants/**/*.test.ts"] } },
      // kill harness is NOT a Vitest project — it is tools/kill-harness.mjs, its own CI step
    ],
    coverage: {
      provider: "v8",
      include: ["src/**", "packages/protocol/src/**"],
      exclude: ["src/frontend/**"],
      thresholds: {
        "src/storage/**":          { branches: 90 },
        "src/engine/**":           { branches: 90 },
        "packages/protocol/**":    { branches: 90 },
      },
    },
  },
});
```

**Kill-harness supervisor (sketch) + CI steps:**

```js
// tools/kill-harness.mjs — spawn real server, SIGKILL at named fault points, verify.
import { spawn } from "node:child_process";
const POINTS = ["mid_stream", "between_calls", "pre_commit"]; // M2 adds the rest
for (let cycle = 0; cycle < Number(process.env.CYCLES ?? 25); cycle++) {
  const point = POINTS[cycle % POINTS.length];
  const child = spawn("node", ["dist/server.js"], {
    env: { ...process.env, WELTARI_FAKE_LLM: "1", WELTARI_EMIT_FAULT_POINTS: "1" },
  });
  child.stdout.on("data", (d) => {
    if (d.toString().includes(`FAULT_POINT:${point}`)) child.kill("SIGKILL");
  });
  await driveScriptedTurn();          // POST commands via the public API only
  await exited(child);
  await run("node", ["tools/verify-consistency.mjs"]);  // exits 1 ⇒ CI fails
}
```

```yaml
# .github/workflows/ci.yml (excerpt — full pipeline belongs to the CI chapter)
- run: npx vitest run --project invariants          # every PR, must pass
- run: npx vitest run --coverage                     # thresholds gate
- run: node tools/kill-harness.mjs                   # CYCLES=25 on PR
  env: { CYCLES: 25 }
- run: npm run protocol:generate && git diff --exit-code -- packages/protocol/schemas
- run: node tools/protocol-breaking-check.mjs        # json-schema-diff per changed schema
- name: Protect invariant tests
  run: |
    if git diff --name-only origin/main...HEAD | grep -q '^tests/invariants/'; then
      echo "::error::invariant tests modified — needs 'invariant-change' label"; exit 1
    fi
  if: "!contains(github.event.pull_request.labels.*.name, 'invariant-change')"
```

```js
// tools/protocol-breaking-check.mjs (core of it)
import { diffSchemas } from "json-schema-diff";   // v1.0.0, Apache-2.0 (CI-only dep)
const r = await diffSchemas({ sourceSchema: oldSchema, destinationSchema: newSchema });
if (r.removalsFound && !protocolMajorBumped()) process.exit(1);
```

## Boundary notes

- **Chapter 1 (compiler/lint):** owns `tsconfig` strictness, the ESLint `no-restricted-imports` repository fence, and the `Date.now()` ban — this chapter only adds the grep-test backstop and the tests that assume those fences hold.
- **Trust-boundary chapter (Zod v4):** owns the Zod schemas and the Zod↔TypeBox split; this chapter owns only the "invalid input ⇒ zero durable writes" test pattern (R8).
- **CI/workflow chapter:** owns pipeline ordering, task-completion gates (`tsc --noEmit`, lint), commit-size policy; this chapter contributes the test jobs it must include (invariants project, kill harness, schema diff, protected-tests check).
- **Prompt/context chapter (if any):** owns *what* goes in the stable prefix; this chapter only guards that it is byte-stable.
- **builder.md:** docs-in-same-commit and fixtures (`fixtures/` seeded world) are defined there; R10/R11 reuse them without restating.

## Open questions for synthesis

1. **Protocol schema source of truth:** FINAL item 4 says TypeBox → JSON Schema; the Fact-check Addendum proposes unifying on Zod v4 (native JSON Schema export) and notes the `typebox` vs `@sinclair/typebox` naming split. The snapshot/diff pipeline in R7 works either way, but the generator step differs — synthesis must settle this before the Week-1 protocol package exists.
2. **AI SDK version drift:** FINAL item 9 says `ai` v5; the Addendum overrides to pin v6 (`ai@^6` + `@openrouter/ai-sdk-provider@^2.10`). I followed the Addendum; the FakeLLM seam (R10) is deliberately ours so the pin can move without rewriting tests. Verify the `ai/test` mock-model export names against v6 in Week 1.
3. **Patch-coverage threshold (85%) and PR-cycle count for the kill harness (25):** judgment calls balancing CI minutes against safety — synthesis may retune, but both must stay non-zero and gating.
4. **R15 protection scope:** should *edits* to existing invariant tests hard-fail CI without a label (as written), or merely warn? Hard-fail is my recommendation for an AI-maintained repo; it costs the owner one label click per legitimate change.
5. **Rev 4 vs FINAL job states:** consistent (`pending|running|committed|failed|parked`, `parked` = dead-letter) — no conflict, noted for the record. One real gap: Rev 4 §17 shows no `lease_until` sweep-on-startup wording, while FINAL item 8 makes the expired-lease sweep part of the poll/startup path — tests in R3(b) and R4 assume FINAL's behavior (files 1–5 win).
6. **Nightly real-provider cache-hit test (R5)** spends real tokens (~20 turns/night); synthesis should confirm the owner accepts that standing cost or scope it to weekly.
