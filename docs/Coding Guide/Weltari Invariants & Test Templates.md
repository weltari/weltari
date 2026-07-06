# Weltari — Invariants & Test Templates

> Every hard constraint in the Stack Requirements Brief §2 gets a permanent, machine-checked guard **and** an invariant test (builder.md §6: tests are the enforcement arm of the docs — a rule without a failing test will eventually be broken politely and confidently by an AI agent). This file is the canonical list. Owner Decision #4.1 is binding: tests grow with the code from day one; the Week-1 kill-harness and cache-hit checks are permanent CI, not throwaway scripts.

## The test runner (settled)

**Vitest, pinned exactly to `4.1.10`** with `@vitest/coverage-v8@4.1.10`. Do not adopt the 5.0 beta (boring-appliance posture). Two Vitest projects: `unit` (colocated `src/**/*.test.ts`) and `invariants` (`tests/invariants/**`) — the `invariants` project gates every merge. The kill harness is **not** a Vitest project; it is `tools/kill-harness.mjs`, its own CI step.

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit",       include: ["apps/server/src/**/*.test.ts", "packages/**/src/**/*.test.ts"] } },
      { test: { name: "invariants", include: ["tests/invariants/**/*.test.ts"] } },
    ],
    coverage: {
      provider: "v8",
      include: ["apps/server/src/**", "packages/protocol/src/**"],
      exclude: ["apps/web/**"],
      thresholds: {
        "apps/server/src/storage/**": { branches: 90 },
        "apps/server/src/engine/**":  { branches: 90 },
        "packages/protocol/src/**":   { branches: 90 },
      },
    },
  },
});
```

Shared infrastructure: `tests/fakes/` (the `WorldClock`/`SystemClock` fakes and the `FakeLLM` at the ModelRegistry seam — evaluate `ai/test` mocks against the pinned `ai@6.0.219` in Week 1, but our own seam is the stable one either way), `tests/helpers/` (`subscribeDevChannel()` — integration tests observe through the same SSE dev channel users debug with), `fixtures/` (the seeded example world, builder.md §4.3).

---

## The invariant list — one guard + one test each

| # | Invariant (Brief ref) | Structural guard | Test |
|---|---|---|---|
| I1 | Events table is append-only (§2.1) | Repository interface has no mutating methods; SQLite `BEFORE UPDATE/DELETE` triggers `RAISE(ABORT)` | `tests/invariants/event-log-append-only.test.ts` — raw UPDATE/DELETE both throw |
| I2 | All durable writes to one character serialize through its mailbox (§2.3) | In-process serial queue per character; optimistic `version` backstop | `mailbox-serializes.test.ts` — N concurrent read-modify-writes, counter === N; stale-version write throws |
| I3 | Ledger semantics (§2.2) | UNIQUE idempotency key; lease columns; claim query encodes per-world concurrency | 4 tests: `ledger-idempotency` / `ledger-lease-expiry` / `ledger-dead-letter` (parked, never auto-retried) / `ledger-per-world` — all on the injected fake clock, zero sleeps |
| I4 | kill -9 safe at any moment (§2.4) | Crash-only design; durable intent before work | `tools/kill-harness.mjs` — SIGKILL at named fault points (`mid_stream`, `between_calls`, `pre_commit`; M2 adds `mid_reflection`, `mid_painter`, `mid_cron`), restart, then `tools/verify-consistency.mjs`: `PRAGMA integrity_check` = ok, event ids strictly increasing & unique, no expired running leases after the startup sweep, SSE `Last-Event-ID` reconnect delivers missed events exactly once. **25 cycles per PR, 100 nightly** |
| I5 | Prompt prefix is byte-stable (§2.6) | Every ContextAssembler returns `{ stablePrefix, dynamicTail }` as separate fields | One test per assembler in `tests/invariants/prompt-prefix/`: same inputs twice ⇒ `Buffer.compare === 0`; dynamic-only changes ⇒ prefix identical; world-clock/latest-turn text appear only in the tail; **plus one hostile-injection-string fixture** asserting the prefix stays byte-identical (Guide B14). Nightly real-provider check: `cached_tokens` over 20 turns, fail under 80% |
| I6 | Only repositories touch SQL (§2.7) | ESLint fence (Guide A11) + no exported raw handle | `repository-fence.test.ts` (the grep test builder.md §6 names): `better-sqlite3` imported only in `apps/server/src/storage/db.ts`; `db.prepare(`/`db.exec(` only under `apps/server/src/storage/` and the migration runner |
| I7 | Protocol schemas never break clients silently (§1) | Generated `packages/protocol/schemas/*.json` are committed | CI: regenerate + `git diff --exit-code`; `json-schema-diff@1.0.0` old-vs-new — any `removalsFound` fails unless `protocol_version` major bumped; `oasdiff breaking --fail-on ERR` on the OpenAPI surface (both Apache-2.0, **CI-only** — never copied into the MIT package) |
| I8 | LLM output is never directly durable (§2.10) | Two gates: Zod `inputSchema` then engine state validation (Guide B6) | Per-tool template: (a) malformed payload, (b) well-formed-but-invalid-state call ⇒ rejection logged as a `trail` event and **zero rows changed** (asserted via repository reads, never internals) |
| I9 | Dev channel is honest (UI Spec §2.8) | Dev events emitted at source, never parsed from pino (Guide C11) | Integration tests use `subscribeDevChannel()`; review rejects tests importing engine internals instead |
| I10 | Boundary fixtures (Guide B7–B14) | `validateAt` + fences | Fixture suite: duplicate/oversized/malformed gateway messages (exactly-once, capped, rejected); WeChat paused-response (no throw, no retry-storm, `health()` degraded); tampered-byte plugin (refused + `plugin.rejected`); wrong-hash & wrong-signature update (download deleted, version kept); zip-slip archive (refused); extra-key fixture per schema (strict rejects / loose strips) |
| I11 | Config never defaults over garbage (Guide B11) | strictObject at boot | Typo'd-key config fixture ⇒ non-zero exit, key path in output |
| I12 | Secrets never serialize (Guide B15/C12) | pino `redact` paths; `n/no-process-env` fence | Planted `apiKey` log call emits `[Redacted]`; env schema failure prints names only |
| I13 | Idle is quiet (Guide C9) | Fixed log-level meanings | Boot the fixture world, one idle minute ⇒ info-line count under the fixed budget |
| I14 | The loop watches itself (Guide C13) | `gauges.ts` started unconditionally in `main.ts` | Smoke test: gauge line within 30 s of boot; warn past 200 ms p99 / 220 MB RSS |

**Invariant tests are protected:** any PR that *modifies* an existing file under `tests/invariants/` fails CI unless it carries the `invariant-change` label, which only the owner applies. Adding new invariant tests is always allowed.

---

## How AI agents write tests (binding rules)

1. **All time is injected.** Engine code takes `WorldClock` (fictional, monotonic) and `SystemClock` (wall time, leases/TTLs); tests pass fakes and advance them explicitly. `Date.now()`/`new Date()` are lint-banned in the engine. A test containing `setTimeout`-based waiting or a real API key is rejected in review.
2. **All LLM calls go through the ModelRegistry seam;** tests pass the `FakeLLM` with scripted responses. Real-provider calls exist only in the named nightly cache-hit job.
3. **Tests ship in the same task as the code.** CI fails a PR adding a new `apps/server/src/` or `packages/` file with no test file added or modified; patch coverage on changed lines ≥ 85%. Bulk after-the-fact backfill is banned — backfilled tests merely encode whatever the possibly-buggy code already does.
4. **Coverage gates, no vanity 100%:** branch ≥ 90% on the guard modules (`storage`, `engine`, `protocol`); frontend excluded from gates.
5. **Assert outcomes through public seams** — events on the stream, rows via repository reads, HTTP/SSE responses. Never spy on private functions, never assert internal call counts, never reach into module state: an agent told "make the tests pass" will edit whatever the test touches, and only outcome tests can be satisfied solely by correct behavior. Backstop: nightly StrykerJS mutation run (`@stryker-mutator/core@9.x` + `@stryker-mutator/vitest-runner@9.x`) over storage+engine — score reported and trended, deliberately **not** a merge gate.
6. **In scope:** repositories, ledger semantics, mailboxes, the scene-engine state machine (turn envelope open → calls → validated commits → close, including interrupt and resume), protocol validation, prompt-prefix stability, crash recovery, boundary fixtures. **Out of scope:** UI pixel/DOM snapshots, and any assertion on LLM *prose* — assert the shape (schema-valid tool call, event emitted), never the wording. `toMatchSnapshot()` is lint-banned outside `packages/protocol`.
7. **Type assertions are banned in tests too** (Guide §0.12): fixtures that need wrong-shaped data are declared `unknown` and fed to the code under test — that is what the boundary parsers are for.

---

## Templates

**Append-only guard (migration `0001_events.sql` + repository shape):**

```sql
-- events: append-only event log (Brief §2.1). Rows are never updated or deleted.
CREATE TABLE events (
  id       INTEGER PRIMARY KEY,   -- monotonic; doubles as SSE Last-Event-ID
  world_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,         -- Brief §2.8: every event carries actor_id
  type     TEXT NOT NULL,
  payload  TEXT NOT NULL,         -- JSON
  ts       TEXT NOT NULL
);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only (Brief §2.1)'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only (Brief §2.1)'); END;
```

```ts
// apps/server/src/storage/repositories/event-log.ts — the interface HAS no mutating members.
export interface EventLogRepository {
  append(e: NewEvent): PersistedEvent;          // sole write path
  readSince(id: number, limit?: number): PersistedEvent[];
  readByScene(sceneId: string): PersistedEvent[];
}
```

```ts
// tests/invariants/event-log-append-only.test.ts
import Database from "better-sqlite3";           // raw access sanctioned in tests/ only
it("raw UPDATE and DELETE on events abort", () => {
  const db = new Database(testDbPath);
  expect(() => db.prepare("UPDATE events SET type='x' WHERE id=1").run()).toThrow(/append-only/);
  expect(() => db.prepare("DELETE FROM events WHERE id=1").run()).toThrow(/append-only/);
});
```

**Mailbox serialization:**

```ts
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

**Ledger (fake clock — no sleeps):**

```ts
it("idempotency key is unique", () => {
  ledger.enqueue({ type: "reflect", key: "reflect:c1:s9", worldId });
  ledger.enqueue({ type: "reflect", key: "reflect:c1:s9", worldId }); // no-op
  expect(ledger.countByKey("reflect:c1:s9")).toBe(1);
});
it("expired lease returns the job to claimable", () => {
  const job = ledger.claimNext(workerA);           // running, lease_until = now+60s
  sysClock.advance("61s");
  ledger.sweepExpiredLeases();                      // the startup/poll sweep (FINAL item 8)
  expect(ledger.claimNext(workerB)?.id).toBe(job.id);
});
it("max attempts parks the job (dead-letter)", () => {
  for (let i = 0; i < MAX_ATTEMPTS; i++) failOnce(ledger, sysClock);
  expect(ledger.get(jobId).state).toBe("parked");
  expect(ledger.claimNext(workerA)).toBeNull();     // never auto-retried
});
it("World Agent jobs serialize per world", () => {
  ledger.enqueue(worldAgentJob(worldId, "a")); ledger.enqueue(worldAgentJob(worldId, "b"));
  expect(ledger.claimNext(w1)).not.toBeNull();
  expect(ledger.claimNext(w2)).toBeNull();          // second blocked while first runs
});
```

**Prompt-prefix byte stability (one file per assembler):**

```ts
const fixed = characterFixture();                    // from fixtures/
it("stable prefix is byte-identical across calls", () => {
  const a = assembler.build(fixed), b = assembler.build(fixed);
  expect(Buffer.compare(Buffer.from(a.stablePrefix, "utf8"),
                        Buffer.from(b.stablePrefix, "utf8"))).toBe(0);
});
it("dynamic inputs never leak into the prefix", () => {
  const a = assembler.build(fixed);
  const b = assembler.build({ ...fixed, worldClock: laterClock, latestTurns: otherTurns });
  expect(b.stablePrefix).toBe(a.stablePrefix);       // only the tail may differ
  expect(a.stablePrefix).not.toContain(fixed.worldClock.render());
});
it("hostile wiki/memory text cannot move the prefix", () => {
  const a = assembler.build(fixed);
  const b = assembler.build({ ...fixed, wiki: withHostileInjectionString(fixed.wiki) });
  expect(b.stablePrefix).toBe(a.stablePrefix);       // Guide B14
});
```

**Kill-harness supervisor (sketch) + CI wiring:**

```js
// tools/kill-harness.mjs — spawn real server, SIGKILL at named fault points, verify.
import { spawn } from "node:child_process";
const POINTS = ["mid_stream", "between_calls", "pre_commit"]; // M2 adds mid_reflection, mid_painter, mid_cron
for (let cycle = 0; cycle < Number(process.env.CYCLES ?? 25); cycle++) {
  const point = POINTS[cycle % POINTS.length];
  const child = spawn("node", ["apps/server/dist/main.js"], {
    env: { ...process.env, WELTARI_FAKE_LLM: "1", WELTARI_EMIT_FAULT_POINTS: "1" },
  });
  child.stdout.on("data", (d) => {
    if (d.toString().includes(`FAULT_POINT:${point}`)) child.kill("SIGKILL");
  });
  await driveScriptedTurn();          // POST commands via the public API only
  await exited(child);
  await run("node", ["tools/verify-consistency.mjs"]);  // exits 1 ⇒ CI fails
}
// Windows note: child.kill('SIGKILL') is unconditional termination on Windows — runnable locally.
```

```yaml
# .github/workflows/ci.yml (test-related steps; the full pipeline lives with the workflow chapter of the guide)
- run: npx vitest run --project invariants           # every PR, must pass
- run: npx vitest run --coverage                     # per-glob thresholds gate
- run: node tools/kill-harness.mjs                   # CYCLES=25 on PR; 100 on the nightly schedule
  env: { CYCLES: 25 }
- run: npm run protocol:emit && git diff --exit-code -- packages/protocol/schemas
- run: node tools/protocol-breaking-check.mjs        # json-schema-diff per changed schema
- run: node tools/check-tests-accompany.mjs          # new src file ⇒ test in same PR
- name: Protect invariant tests
  if: "!contains(github.event.pull_request.labels.*.name, 'invariant-change')"
  run: |
    if git diff --name-only origin/main...HEAD | grep -q '^tests/invariants/'; then
      echo "::error::invariant tests modified — needs the owner's 'invariant-change' label"; exit 1
    fi
```

**LLM rejection template (I8):** feed the tool (a) malformed JSON and (b) a well-formed call naming an absent character/art ⇒ assert a `trail` rejection event was emitted and repository reads show zero new rows/events. Both gates (Zod shape, engine state) must be exercised.

**Nightly jobs (scheduled workflow):** kill harness at `CYCLES=100`; StrykerJS mutation run over `apps/server/src/storage` + `apps/server/src/engine` (informative); real-provider cache-hit check (20 turns, `cached_tokens` ≥ 80% of the stable prefix — spends real tokens; owner may downgrade to weekly with a one-line schedule edit).

