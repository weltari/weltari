# Code tour — observability (logs, crashes, and validation)

This module is Weltari's nervous system for knowing what's going on inside itself: one place that writes structured log lines, one place that's allowed to shut the process down when something goes badly wrong, one place that catches errors from "fire and forget" background work so nothing fails silently, one background check that watches the app's own health, and one shared helper (`validateAt`) that every piece of untrusted data — from the browser, from an LLM, from a config file — has to pass through before it's trusted. None of this is "the truth" about the game world; it's diagnostics only, for humans and log tools to read, never data the application itself reads back and acts on.

**What is redaction?** Redaction means secrets (API keys, tokens, passwords) are scrubbed out and replaced with a placeholder like `[Redacted]` *before* a log line is ever written anywhere — not after. So even if a piece of code accidentally tries to log an object containing a secret, the secret itself never touches disk or terminal output. This is built into the logger itself, so no individual piece of code has to remember to do it.

**Why validate everywhere with a label?** Every time data crosses a "trust boundary" — arrives from the browser, comes back from an AI model, is read from an environment variable — it's checked against a strict schema using `validateAt`. If the data doesn't match what's expected, it's rejected immediately, and the resulting log line says exactly *where* the rejection happened (which boundary, which schema) — never the actual bad data itself (which might be huge, or might itself contain something sensitive). This means when something goes wrong, whoever's debugging it doesn't have to guess whether the browser sent something malformed, or the AI model returned something unexpected, or a config file is broken — the log tells them precisely which doorway rejected the data.

## `apps/server/src/observability/logger.ts`

Creates the single shared logger every other part of the app uses to write diagnostic lines. It's for turning log calls into structured, one-line-per-entry JSON output.

- `createRootLogger(options)` — builds the one root logger (there is deliberately only ever one). It writes NDJSON (one JSON object per line) to standard output, and it's configured to write synchronously so that if the process is about to crash, the very last log line is guaranteed to actually get flushed to disk before the process exits. It also has the secret-redaction rules built in (any field named `apiKey`, `api_key`, `token`, `secret`, or `authorization`, at any nesting depth, is replaced with `[Redacted]`) — this is the mechanism the "redaction" explanation above refers to. Tests can pass in their own in-memory stream instead of real stdout so they can inspect exactly what got logged.

## `apps/server/src/observability/fatal.ts`

The one and only place in the entire codebase allowed to actually terminate the process. It exists so that "the app is shutting down on purpose because something is unrecoverable" always happens the same, deliberate way.

- `fatal(logger, error)` — logs the error at the highest severity (synchronously, so it's guaranteed to be written), then exits the process. It exits with code 1 for an ordinary bug or unexpected failure, or code 3 specifically for a "corrupt state" situation — a distinct exit code that tells whatever restarts the process (a supervisor, Docker, a launcher script) "don't just restart me blindly, something about the saved data itself may need a human to look at it first." If even the logger itself fails while trying to report the fatal error, it falls back to printing directly to the terminal as a last resort so the failure is never completely silent.

## `apps/server/src/observability/catch-and-log.ts`

A tiny but important safety net for background work that isn't directly waited on ("detached" work, e.g. a reply the chat engine is still generating while the HTTP request that triggered it has already returned).

- `catchAndLog(promise, logger, what)` — attaches a handler to a detached background task so that if it eventually fails, the failure is logged (with a short label describing what the task was) instead of becoming a silent, invisible failure that nobody ever finds out about. This is the app's one sanctioned way of "starting something and not waiting for it."

## `apps/server/src/observability/gauges.ts`

A self-monitoring heartbeat: the app watches its own responsiveness and memory use while it runs, independent of anything a user does.

- `startGauges(options)` — starts a recurring timer (every 15 seconds by default) that measures two things: how backed-up the Node.js event loop is (a measure of whether the app is keeping up with work, reported as a "p99" — the worst 1% of delays) and how much memory the process is using (RSS, roughly "real memory in use"). Under normal conditions this is logged quietly at `debug` level; if the event loop delay goes past 200ms or memory passes 220MB, it's logged more loudly at `warn` level instead, so a human watching logs will notice the escalation without having to watch every line. Each sample is also mirrored out onto the dev bus (see the http tour) so a developer connected to the SSE stream in dev mode can watch these numbers live. It returns a function to stop the timer (used during graceful shutdown), and accepts a substitute "sampler" function so tests can feed it made-up numbers instead of real system measurements.

## `apps/server/src/observability/gauges.test.ts`

Automated tests for `gauges.ts`: using fake timers and a scripted sample function (instead of real event-loop/memory numbers), they check that samples are logged at `debug` level normally and escalate to `warn` once the thresholds are crossed, and that each sample is also mirrored out as a `dev.gauges` frame.

## `apps/server/src/boundary/validate.ts`

Although this file lives in the `boundary` folder rather than `observability`, it's documented alongside the rest of this module because it's the validation half of "log clearly, reject clearly" — and it depends on the logger above. This is the one function every trust boundary in the whole codebase is required to call.

- `validateAt(boundary, schemaName, schema, raw, logger)` — takes some raw, untrusted data (from the browser, an AI model, a plugin, a config file, etc.), a label saying which kind of boundary this is (a fixed list: `llm`, `telegram`, `wechat`, `http`, `plugin`, `config`, `env`, `update`, `upload`), and a schema describing the shape the data is supposed to have. It checks the data against the schema. If it matches, the validated, typed data is returned. If it doesn't match, the function logs a warning that names the boundary, the schema, and exactly which fields were wrong and why — but deliberately never logs the raw data itself (only its size), since that data is untrusted and could be huge or sensitive — and returns a rejection instead of ever letting the bad data through.

## `apps/server/src/boundary/config/env.ts`

The only file in the whole codebase allowed to read environment variables directly (every other file receives configuration as ordinary function arguments instead) — this is what "config" as a boundary, in `validate.ts`'s list, refers to. It's for turning the raw operating-system environment into a checked, typed configuration object the rest of the app can rely on.

- `readEnv(raw)` — validates every environment variable Weltari understands (server port, database path, log level, API keys, feature flags, model names, timeouts, and so on) against a strict schema, applying sensible defaults where a variable is optional. If anything present is malformed, it reports which variable NAMES were bad — never their values, since some of them are secrets like API keys.
- `readEnvOrExplain()` — the version actually called at startup: it prints a short, readable error to the terminal (there's no logger yet this early in boot) and signals failure if the environment is invalid, or returns the fully validated configuration object if it's fine.

## How this connects to the rest of the app

Every other module in Weltari depends on this one, but not the other way around: `main.ts` creates the root logger first, before almost anything else happens, and hands child loggers down into every subsystem (the engine, the ledger, the HTTP server, the chat engine) so every log line anywhere in the app carries the same redaction rules and the same structured format. `fatal()` is the landing point for the app's only two crash handlers (installed in `main.ts`), so any unexpected failure anywhere ends up here. `catchAndLog` is used throughout `main.ts` and the engine wherever background work is deliberately not waited on. `validateAt` is called at every point data crosses in from outside the process — including inside the HTTP routes described in the http tour, wherever a command body needs checking beyond what Fastify's schema validation already covers, and wherever the LLM's response is parsed. And `gauges.ts` is started unconditionally as one of the very first things `main.ts` does, so the app is watching its own health from the moment it comes up.
