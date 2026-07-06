# Chapter N: Error Handling, Logging and Observability

Scope: how Weltari code classifies failures, when it throws vs returns, when it deliberately crashes, and how the single always-on Node 24 process reports what it is doing — without ever confusing diagnostics with the event log, which is the only truth (Brief §2.1).

Vocabulary guard: Rev 4 uses "LOG" (§16) for the *log-only event trail* (thinking, raw attempts, tool outcomes) that feeds dev mode. That trail is **game data inside the event system**. This chapter's "logs" are **diagnostics** (pino output). They are different things and the code must name them differently: `trail` / log-only events for the Rev 4 concept, `logger`/`diag` for pino. Never use the bare word "log" in an identifier.

## Rules

**R1. Every error is one of three kinds, carried on one base class.**
Kinds: `operational` (expected failures of things we don't control: LLM timeout, provider 429/5xx, gateway hiccup, image-backend failure, network, disk-full), `bug` (our code violated its own contract: bad argument, impossible branch, schema we authored fails to parse our own data), `corrupt_state` (durable rows contradict an invariant: mailbox version mismatch that can't be optimistic-retried, ledger row in an impossible state, SQLITE_CORRUPT/SQLITE_IOERR).
*Why:* the three kinds have three different correct reactions — retry, crash, crash-and-refuse-restart-blindly — and an AI agent picking the reaction needs the kind to be data, not judgment.
*Enforced:* all thrown/returned errors extend `AppError` (snippet below); `@typescript-eslint/only-throw-error` bans throwing non-Errors; exhaustive `switch (e.kind)` with a `never` check in the two central handlers (job runner, request handler) makes a fourth kind a compile error.

**R2. Result for operational failures at integration edges; throw for bugs and corruption everywhere.**
The approach is **plain discriminated unions — no Result library.** (`neverthrow` was checked: latest 8.2.0, no release in ~a year as of 2026-07 — under this project's stale-edge-dependency posture it does not earn a slot, and Zod v4's `safeParse` already returns this exact shape, so the codebase gets one idiom for free.) Concretely:
- Functions that call anything external — LLM providers via the AI SDK, image backends, VLM, gateway sends, web-push — return `Promise<Result<T>>` and **never throw for operational failures**; they catch the SDK/driver exception at the edge, classify it, and return `err(...)`.
- Repositories, engine internals, and pure domain code **throw** `BugError`/`CorruptStateError` and return plain values. better-sqlite3 is synchronous; a failed domain write is never "operational", it is a bug or corruption, and throwing inside the transaction aborts it — which is what we want.
- Zod `safeParse` results at trust boundaries (owner mandate) are handled in place: parse failure of *external* data (LLM tool call, gateway message, plugin manifest) → `err(operational or rejected-input)`; parse failure of *our own* stored data → throw `CorruptStateError`.
*Why:* expected failures become ordinary values the compiler forces you to look at; impossible failures stay exceptions so they can reach the crash handler.
*Enforced:* the `Result` type lives in one shared module; ESLint `no-restricted-imports` fence (same mechanism as the repository fence) forbids importing provider SDKs outside `integrations/`; review check: any `try/catch` inside `integrations/` must end in `return err(...)` or rethrow.

**R3. Empty catch is banned; every catch does exactly one of three things.**
A `catch` block must (a) rethrow (possibly wrapped, preserving `{ cause }`), (b) `return err(...)`, or (c) log at `warn` or above **with the error object attached** and a `// CATCH-OK: <reason>` marker comment on the catch line.
*Why:* a silently swallowed error is the single most common way AI-written code hides its own bugs.
*Enforced:* ESLint core `no-empty` (empty catch is an error by default; note it tolerates comment-only blocks, so it is not sufficient alone); `@typescript-eslint/use-unknown-in-catch-callback-variable` plus `useUnknownInCatchVariables: true` in tsconfig force explicit handling; CI script (snippet below) fails on any `catch` block containing neither `throw`, `return err`, `logger.`, nor `CATCH-OK`.

**R4. Throw and reject only `Error` instances; no floating promises.**
*Why:* a thrown string has no stack and no `kind`; a floating promise turns a crash into silence.
*Enforced:* `@typescript-eslint/only-throw-error`, `@typescript-eslint/prefer-promise-reject-errors`, `@typescript-eslint/no-floating-promises`, `@typescript-eslint/no-misused-promises` — all `error`. (The full lint/tsconfig baseline belongs to the strict-TS chapter; these four rules are load-bearing here and must be present whatever else that chapter decides.)

**R5. Crash on purpose — `process.exit` happens in exactly one function, for exactly five triggers.**
`fatal(err)` in `src/observability/fatal.ts` is the **only** call site of `process.exit` in the codebase. It synchronously flushes the logger, appends nothing to the event log (the event log records the world, not the process), and exits with code 1. Triggers:
1. `uncaughtException` (any).
2. `unhandledRejection` (any).
3. `BugError` or `CorruptStateError` detected **inside a repository transaction, a mailbox handler, or the engine's tool-validation/commit path** — i.e., anywhere a durable write might be half-formed in intent. Brief §2.4: crashing is safer than limping; startup *is* recovery, so the crashed process resumes from durable intent.
4. SQLite errors indicating storage trouble: `SQLITE_CORRUPT`, `SQLITE_IOERR`, `SQLITE_FULL`, `SQLITE_READONLY`.
5. Migration failure or schema-version mismatch at startup (before serving anything).
Never exit for `operational` errors — those retry, park, or surface to the user. Never attempt cleanup before exiting beyond the synchronous log flush: graceful shutdown is an optimization, not a correctness requirement (Brief §2.4), and cleanup code in a known-bad process is itself untrusted.
*Why:* after a detected bug the in-memory state is unreliable; the durable log + ledger are not — restarting from them is the one recovery path that is tested every day because it is the startup path.
*Enforced:* ESLint `no-restricted-properties` bans `process.exit` outside `fatal.ts`; `no-restricted-globals`/review bans installing additional `uncaughtException` handlers; the kill-harness CI test (owner requirement #1) already proves restarts converge.

**R6. Process-level handlers exist to log, never to survive.**
`main.ts` installs `process.on('uncaughtException', fatal)` and `process.on('unhandledRejection', fatal)` once, before anything else. No library or plugin may register its own. Node's default behavior already crashes on both — our handlers exist so the crash line lands in the diagnostics with a stack, not to keep the process alive. `SIGTERM`/`SIGINT`: set a "draining" flag, stop claiming new jobs, give the current turn ≤5 s, then exit 0 — purely an optimization.
*Why:* a single always-on process that "recovers" from an unknown exception is a process running with corrupted assumptions forever.
*Enforced:* grep-based CI check: `process.on('uncaughtException'|'unhandledRejection')` appears exactly twice, both in `main.ts`.

**R7. Workers translate errors into ledger states at exactly one place.**
The job-runner loop is the only catch site for job execution. Mapping:
- `operational` → `attempts += 1`; if `attempts < max` (per job type, default 5) → back to `pending` with exponential backoff on `run_at`; else → `parked` (the dead-letter lane, Brief §2.2). `failed` is the transient marker state; `parked` is terminal-until-human.
- `bug` → `parked` **immediately** (retrying deterministic bugs burns tokens and produces the same crash), and if the throw escaped mid-transaction per R5.3 → `fatal()` after the park write commits; if the park write itself cannot commit → `fatal()` directly.
- `corrupt_state` → `fatal()`; the startup sweep will re-lease.
Every state change writes `last_error: {kind, code, message}` (truncated, never prompt content) onto the job row and emits a `job.failed` / `job.parked` event so the UI and dev mode can show it (UI Spec §2.9 failure/retry per step).
*Why:* retries are only safe because jobs are idempotent projections (Brief §2.2); the kind decides whether a retry is a repair or a loop.
*Enforced:* the mapping is one exhaustive `switch` in `ledger/runner.ts`; unit test feeds one error of each kind through a stub job and asserts the resulting row state; review check: no `try/catch` inside individual job implementations except R3-conforming edge catches.

**R8. Structured logging is pino v10, NDJSON, no in-process worker transports.**
`pino` (current major **v10**, verified 2026-07) writing newline-JSON to stdout (Docker collects it) and, for native installs, to `logs/weltari.log` via `pino.destination()` with `pino/file` rotation left to the platform. **Do not use worker-thread transports in production** — they spend RAM and a crash can lose the tail; `pino-pretty` is a dev-only CLI pipe (`node app | pino-pretty`), never a dependency of the server path. pino's base cost is well inside the 256 MB envelope (it is the low-overhead choice precisely because serialization is inline).
*Why:* JSON lines are the only format both `grep` and an AI debugging agent can consume reliably.
*Enforced:* `pino-pretty` in `devDependencies` only (CI checks `package.json`); one `logger.ts` module exports the root logger; `no-console` ESLint rule (error) bans `console.*` everywhere except `fatal.ts`'s last-resort branch.

**R9. Log levels have fixed meanings.**
- `fatal` — process is about to exit (only `fatal.ts`).
- `error` — a job parked, a turn voided, an invariant nearly tripped; someone should look.
- `warn` — operational failure being retried (429, timeout), degraded mode entered (WeChat connector down, plain-HTTP push fallback), event-loop lag / RSS threshold crossed.
- `info` — lifecycle facts, low volume: startup config summary, migration applied, scene opened/closed, job committed/parked counts, gateway connected. **Steady-state idle must produce near-zero info lines.**
- `debug` — per-call diagnostics: model, token counts, `cached_tokens`, durations, job claim/lease detail.
- `trace` — payload-level detail including prompt/response bodies; **never enabled by default**, opt-in per run.
*Why:* levels are a contract; if `info` is chatty, nobody (human or agent) reads it.
*Enforced:* review check against this table; a CI test boots the server, runs one idle minute of the fixture world, and fails if more than a fixed count of `info` lines appear.

**R10. Every log line carries correlation ids via child loggers.**
Bind once, at context creation: `world_id`, and whichever exist of `scene_id`, `turn_id` (turn envelope id), `session_id`, `job_id`, `conversation_id`, `connector_id`, and `event_seq` when the line concerns a specific appended event. Code deeper in the call stack never re-passes ids — it receives the child logger.
*Why:* "why did my character act weird" is answered by filtering one `turn_id` across engine, LLM edge, and ledger lines.
*Enforced:* the engine/runner constructors accept a `Logger` and create children; review check: no module creates a root logger except `logger.ts`; the fixture-world CI test asserts sampled lines during a scripted turn all carry `turn_id`.

**R11. Diagnostics are never truth; the dev channel is not a log tail.**
The event log is the source of truth and the only thing projections rebuild from (Brief §2.1). Dev mode (UI Spec §2.8) renders **log-only events from the event system's trail** (thinking, tool calls + validation outcomes, CACHE writes, turn envelope open/close) pushed as a gated SSE channel — it must be implemented by emitting those as events at their source, **not** by tailing pino output. Pino lines are never parsed by application code, never rendered in any UI surface, never replayed.
*Why:* the moment code reads its own diagnostics, log format changes become data corruption.
*Enforced:* grep CI check: no import of `fs` targeting the logs directory outside `observability/`; review check on any PR touching dev-channel code: its inputs are event types from `@weltari/protocol`, not strings.

**R12. Secrets and user content never reach `info`.**
- API keys, tokens, `Authorization` headers, VAPID keys, gateway credentials: **never logged at any level** — enforced structurally by pino `redact` paths on the known key names plus the rule that raw config objects are never passed to the logger.
- User message content, LLM prompts/completions, character thinking, memory content: `trace` only (they are game data; the trail/event log is where they durably live).
- Provider request metadata (model id, token counts, latency, `cached_tokens`): `debug` — this is the cache-hit observability the risk register requires (risk #1).
*Why:* self-hosted users share logs when asking for help; a pasted logfile must never leak their keys or their story.
*Enforced:* `redact` config in `logger.ts` (snippet); unit test asserts a log call with a planted `apiKey` emits `[Redacted]`; review check: any new logger field named like `content|prompt|message|key|token|secret` needs a `trace`/redact justification.

**R13. The process watches its own event loop and memory.**
Sample every 15 s with Node built-ins: `perf_hooks.monitorEventLoopDelay()` (p99) and `process.memoryUsage.rss()`. Emit at `debug` normally; escalate to `warn` when event-loop p99 > 200 ms (risk register #3) or RSS > 220 MB (85% of the 256 MB target), including the top pending-job counts for context. The same gauge values are also emitted as dev-channel events so dev mode can chart them (risk register promised a lag gauge "in dev mode").
*Why:* on a single event loop, a stall is invisible until narration freezes — the gauge makes it loud before a user notices.
*Enforced:* `observability/gauges.ts` started unconditionally in `main.ts`; CI smoke test asserts the gauge line appears within 30 s of boot.

## Config or code snippets

**`src/errors.ts` — taxonomy + Result (verified: plain TS, no dependency):**

```ts
export type ErrorKind = "operational" | "bug" | "corrupt_state";

export class AppError extends Error {
  constructor(
    readonly kind: ErrorKind,
    readonly code: string,          // stable machine code, e.g. "llm.timeout"
    message: string,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
    this.retryable = options?.retryable ?? kind === "operational";
  }
  readonly retryable: boolean;
}

export class OperationalError extends AppError {
  constructor(code: string, message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super("operational", code, message, options);
  }
}
export class BugError extends AppError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super("bug", code, message, { ...options, retryable: false });
  }
}
export class CorruptStateError extends AppError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super("corrupt_state", code, message, { ...options, retryable: false });
  }
}

// Result — same shape as Zod v4 safeParse ({ success, data | error }) by design.
export type Result<T, E extends AppError = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E extends AppError>(error: E): Result<never, E> => ({ ok: false, error });

/** Invariant check: failure means OUR code is wrong. Throws BugError. */
export function invariant(cond: unknown, code: string, message: string): asserts cond {
  if (!cond) throw new BugError(code, message);
}
```

**`src/observability/fatal.ts` — the only `process.exit`:**

```ts
import { logger } from "./logger.js";

export function fatal(cause: unknown): never {
  try {
    logger.fatal({ err: cause }, "fatal: crashing on purpose (crash-only design)");
    logger.flush();               // pino v10: synchronous flush of sonic-boom buffer
  } catch {
    // CATCH-OK: logger itself failed; last resort below.
    console.error("fatal (logger unavailable):", cause);
  }
  process.exit(1);
}
```

**`src/main.ts` — process handlers (installed first):**

```ts
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
```

**`src/observability/logger.ts` — pino v10 with redaction:**

```ts
import { pino } from "pino";

export const logger = pino({
  level: process.env["WELTARI_LOG_LEVEL"] ?? "info",
  redact: {
    paths: [
      "apiKey", "*.apiKey", "*.api_key", "token", "*.token", "*.secret",
      "headers.authorization", "*.headers.authorization",
      "vapid.privateKey", "config.providers[*].key",
    ],
    censor: "[Redacted]",
  },
  base: { app: "weltari", pid: process.pid },
  // stdout by default; pino.destination("logs/weltari.log") for native installs.
  // NO worker-thread transports in production; pino-pretty is a dev CLI pipe only.
});
```

**`src/observability/gauges.ts`:**

```ts
import { monitorEventLoopDelay } from "node:perf_hooks";
import { logger } from "./logger.js";

const h = monitorEventLoopDelay({ resolution: 20 });
h.enable();

export function startGauges(emitDevEvent: (e: object) => void, intervalMs = 15_000): void {
  setInterval(() => {
    const lagP99Ms = h.percentile(99) / 1e6;
    const rssMb = process.memoryUsage.rss() / (1024 * 1024);
    h.reset();
    const level = lagP99Ms > 200 || rssMb > 220 ? "warn" : "debug";
    logger[level]({ lagP99Ms, rssMb }, "gauges");
    emitDevEvent({ type: "dev.gauges", lagP99Ms, rssMb });
  }, intervalMs).unref();
}
```

**ESLint fragment (typescript-eslint v8 line, ESLint flat config) — rule names verified current:**

```js
rules: {
  "no-empty": "error",
  "no-console": "error",                                   // fatal.ts overridden per-file
  "@typescript-eslint/only-throw-error": "error",
  "@typescript-eslint/prefer-promise-reject-errors": "error",
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
  "no-restricted-properties": ["error", {
    object: "process", property: "exit",
    message: "Only observability/fatal.ts may exit. Throw a typed AppError instead.",
  }],
},
```

**CI catch-audit (add as an npm script; must output nothing and exit 0):**

```bash
# Flags catch blocks that neither rethrow, return err(), log, nor carry CATCH-OK.
grep -rn --include='*.ts' -A3 'catch' src/ \
  | awk '/catch/{buf=$0; getline a; getline b; getline c; blk=buf a b c;
         if (blk !~ /throw|return err|logger\.|fatal\(|CATCH-OK/) print buf}'
```

(Deliberately crude; the authoritative gates are the lint rules and review — this script exists to make drive-by swallowing loud in CI.)

## Boundary notes

- Full tsconfig strictness (`useUnknownInCatchVariables`, `noUncheckedIndexedAccess`, no-`any`) and the complete ESLint baseline → strict-TS/lint chapter; I only pin the seven error-relevant rules above.
- Zod v4 trust-boundary schemas themselves (what to validate, where) → validation chapter; this chapter only defines what a `safeParse` failure *becomes*.
- Ledger schema, lease SQL, backoff constants, per-world concurrency → architecture/ledger chapter; I define only the error→state mapping.
- Kill-harness and recovery tests, CI pipeline wiring → testing/CI chapter.
- Dev-mode UI rendering and spoiler styling → frontend chapter; I define only that its data source is events, never pino.
- Secrets storage/config-file handling → secrets chapter; I cover only their non-appearance in logs.

## Open questions for synthesis

1. **"LOG" naming collision.** Rev 4 §16 calls the log-only event trail "the LOG"; this chapter mandates `trail`/log-only-event identifiers to avoid collision with diagnostics. Synthesis should ratify one glossary entry, since builder.md §5 requires exact Rev-4 vocabulary — a small sanctioned deviation ("LOG → `trail` in code") needs to be recorded or Rev 4's term wins and diagnostics get renamed instead.
2. **Crash-loop behavior under Docker `restart: unless-stopped`.** A deterministic `BugError` at startup will crash-loop. Decide: exit code 1 for all fatals (simple), or a distinct exit code (e.g. 3) for `corrupt_state` so the launcher/docs can say "do not blindly restart; check the data dir". I lean distinct code; needs a one-line launcher change owned by the packaging chapter.
3. **Should `error`/`warn` diagnostics also be mirrored as dev-channel events** (so dev mode shows retries/parks inline)? R7 already emits `job.failed`/`job.parked` events; mirroring *all* warn+ lines would blur R11's logs-are-not-events rule. I recommend: events for state changes only, never for log lines — synthesis should confirm against the dev-mode chapter.
4. **neverthrow rejected on staleness** (8.2.0, ~1 year without release) in favor of plain unions. If the synthesis's lint chapter wanted `eslint-plugin-neverthrow` for must-handle enforcement: that plugin is also unmaintained — the plain-union choice stands, with `noUnusedLocals`/review as the must-handle check. Flagging in case another chapter assumed a Result library.
5. **Fact-check addendum leaves Zod-v4-vs-TypeBox unification open** for the protocol package. This chapter is unaffected (it uses Zod shapes in-process only) but the `job.failed` event schema in R7 lands in `@weltari/protocol` — whoever settles the unification must include the error-code enum (`kind`, `code`) there so non-JS clients see typed failures.
6. **Trace-level prompt logging vs privacy.** R12 permits prompts at `trace`. If the owner prefers absolute never-log for story content (even opt-in), delete the `trace` allowance and rely solely on dev mode's trail — a judgment call for the owner at synthesis.
