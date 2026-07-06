# observability — apps/server/src/observability

Purpose: one structured NDJSON diagnostics stream (pino v10), one sanctioned exit point, one sanctioned home for detached promises. Diagnostics are never truth (Guide C11) — application code never parses these lines.

## Contract

- Inputs: log calls via child loggers bound to correlation ids (C10).
- Outputs: NDJSON on stdout (sync destination so `fatal()` flushes); process exit 1 (bug/operational escalation) or 3 (`corrupt_state` — "do not blindly restart").
- Never: worker-thread transports in production; `pino-pretty` outside devDependencies; a second root logger; `process.exit` anywhere else (lint-enforced).

## File table

| File | What it does / talks to |
| --- | --- |
| `logger.ts` | `createRootLogger` — level, structural redaction of `apiKey/token/secret/authorization` at every depth (C12/I12), injectable stream for tests. |
| `fatal.ts` | `fatal(logger, err)` — the only `process.exit` site (C5): sync log, exit 1 / exit 3 for corrupt_state. |
| `catch-and-log.ts` | `catchAndLog(promise, logger, what)` — the A8-sanctioned way to detach work. |
| `gauges.ts` | Self-watch (C13/I14): every 15 s samples `monitorEventLoopDelay()` p99 + RSS, logs at `debug`, escalates to `warn` past 200 ms / 220 MB, mirrors each sample as a `dev.gauges` frame on the dev bus. Started unconditionally in `main.ts`; injectable sampler for unit tests. |

## boundary — apps/server/src/boundary

| File | What it does / talks to |
| --- | --- |
| `validate.ts` | `validateAt(boundary, schemaName, schema, raw, logger)` — the ONE validation helper (B3); closed 9-boundary union; failure logs `{boundary, schema, issues, raw_size}`, never the payload. |
| `config/env.ts` | B-env: the only `process.env` reader (B15). Zod-validated; failures report key NAMES only; `OPENROUTER_API_KEY` required unless `WELTARI_FAKE_LLM=1`. `.env.example` carries names only. |

## Tests

- I12 invariant: planted apiKey/token/authorization → `[Redacted]`, value absent.
- I13 + I14 invariant: `tests/invariants/self-watch.test.ts` boots the built server once — gauge line within 30 s (I14), one idle minute under the fixed info-line budget (I13).
- Unit: env defaults/name-only errors/key requirement; validateAt ok/reject logging shape without payload; gauges debug/warn thresholds + dev.gauges mirror on a scripted sampler.
