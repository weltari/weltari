# Weltari — AI Coding Guide

> **Who this is for.** The AI coding agents that write Weltari, and the owner who supervises them. Weltari's code is written almost entirely by AI agents overseen by a non-professional owner, so every rule in this guide is designed to make agent mistakes either *impossible* (a machine rejects them) or *loudly visible* (a red CI check or a one-grep review item). Vague advice is banned here the same way it is banned in the code: every rule says exactly how it is enforced.
>
> **How to use.** Before any task: read the repo `CLAUDE.md`, the target module's `structure.md`, and this guide's Definition of Done. Documentation rules (repo `CLAUDE.md`, `docs/` wiki, in-code notes, vocabulary) live in `builder.md` and are **not restated here — they are equally binding**, and the docs-in-same-commit rule is wired into the Done gate below.
>
> **Enforcement tags.** Every rule carries one or more of: `[compiler]` `[lint]` `[CI]` `[test]` `[review]`. An enforcement index at the end groups all rules by tag.

All package names, versions, compiler options and lint rule names below were verified against the npm registry, typescript-eslint docs and GitHub releases on **2026-07-06**.

---

## 0. Decisions settled by this guide

Where the input documents disagreed, this guide settles it. These supersede the conflicting lines in earlier documents:

1. **Protocol schemas: Zod v4 only — TypeBox is dropped.** Supersedes FINAL Stack Decision items 4 and 13 (which named TypeBox), as anticipated by the Fact-check Addendum. Reason: `fastify-type-provider-zod@7.0.0` fully supports Zod v4 (peer `zod@>=4.1.5`, `fastify@^5.5.0`), and Zod v4 natively emits JSON Schema via `z.toJSONSchema()` — so route validation, trust-boundary validation, and the wire schemas for non-JS clients become one schema language instead of two that would drift. `typebox` and `@sinclair/typebox` are lint-banned everywhere.
2. **TypeScript pinned at 5.9.3** (the decided stack says "TypeScript 5.x"; TS 6.0.x exists and works with our tooling — re-evaluate in a monthly `chore(deps)` PR, not ad hoc).
3. **Test runner: Vitest, pinned exactly at 4.1.10** (`@vitest/coverage-v8` at the same version). Do not adopt the 5.0 beta.
4. **Formatter: Prettier 3.9.4** with `eslint-config-prettier@10.1.8` applied last in the ESLint config. (Biome rejected: ESLint is mandatory anyway for type-aware rules like `no-floating-promises`, so Biome would be a second toolchain, not a replacement.)
5. **One Result convention, no Result library:** the shared discriminated union in `apps/server/src/errors.ts` — `{ ok: true, value } | { ok: false, error }`. `neverthrow` was evaluated and rejected (stale ~1 year). The boundary helper `validateAt()` returns this same shape.
6. **One canonical directory layout** (reconciles the chapters' differing paths — the fence globs below are the single source of truth):

```
weltari/
  package.json            # private, workspaces, AGPL-3.0-only
  tsconfig.base.json      # the strict flags (see §7)
  tsconfig.json           # solution file: references only
  eslint.config.mjs
  .npmrc  .node-version   # node-version contains: 24
  scripts/                # CI check scripts (.mjs)
  tools/                  # kill-harness, verify-consistency, patch-coverage (.mjs)
  fixtures/               # seeded example world (builder.md §4.3)
  docs/                   # module wiki + dependencies.md (builder.md §2)
  tests/                  # invariants/  helpers/  fakes/
  packages/protocol/      # MIT — Zod v4 wire schemas + emitted schemas/*.json
  packages/plugin-sdk/    # MIT — plugin API types, GatewayConnector, conformance tests
  apps/server/
    migrations/           # numbered .sql + manifest.json (append-only, hash-locked)
    src/
      storage/            # db.ts (connection + WriteGate + migration runner), repositories/  ← SQLite fence
      llm/                # ModelRegistry, provider clients, tool defs, LLM-output validation  ← AI-SDK fence
      engine/             # scene engine, context assemblers, mailboxes  ← no wall-clock fence
      ledger/             # job runner + croner scheduling
      gateway/            # connector host; telegram/ (grammY fence), wechat/ (claw-bot connector)
      boundary/           # validate.ts, config/ (env.ts, config loader), update/, uploads/, plugins/
      http/               # Fastify routes, SSE stream
      observability/      # logger.ts, fatal.ts, gauges.ts
      main.ts
  apps/web/               # AGPL — React 19 + Vite 8 client
```

7. **AI SDK: `ai` pinned exactly to 6.0.219** + `@openrouter/ai-sdk-provider` 2.10.0 + `@ai-sdk/openai-compatible` (per the Fact-check Addendum; FINAL said v5 — superseded). Note: `ai@7.x` is the current npm `latest`; our v6 pin is intentional because the OpenRouter provider peer-depends on `ai@^6`. Re-evaluate v7 in the monthly deps PR.
8. **CI secret scanning uses `gitleaks/gitleaks-action@v3`** — v2 (named in an earlier draft) is deprecated and stops working when GitHub removes Node 20 runners (Sept 2026). Blocking correction applied.
9. **Vocabulary: Rev 4's "LOG" (the log-only event trail) is named `trail` in code identifiers;** pino diagnostics are `logger`/`diag`. This is a recorded, sanctioned deviation from builder.md §5's exact-vocabulary rule, because two different things cannot share the word "log". Never use the bare identifier `log`.
10. **Exit codes:** all deliberate crashes exit **1**, except `corrupt_state` crashes which exit **3** — launcher docs say "exit 3: do not blindly restart; check the data directory".
11. **Package manager: npm** (bundled with Node 24); lockfile committed; CI uses `npm ci`. ESLint 10 flat config is the only config format.
12. **Type assertions are banned in tests too** — no `expr as T`, no `!`, anywhere (`as const` always permitted). Fixtures that need wrong-shaped data are declared `unknown` and fed to the code under test; that is what the boundary parsers exist for.
13. **Edits to existing invariant tests hard-fail CI** unless the PR carries the owner-only `invariant-change` label.
14. **The nightly real-provider cache-hit test stays nightly** (owner mandate: Week-1 checks become permanent CI). It spends ~20 turns of real tokens per night — the owner may downgrade to weekly with a one-line CI edit.

Rev 4 conflicts flagged and resolved (files 1–5 win): Rev 4's "LangGraph vs custom orchestration" open item is closed (custom loop); Rev 4 §13's "webhook ingestion" wording is superseded by NAT-first polling (the dedup requirement carries over unchanged); Rev 4's wechaty WeChat path is superseded by the official claw-bot connector (Owner Decisions 2026-07-06).

---

## A. Compile-time safety

**A1. Pin the toolchain exactly.** TypeScript `5.9.3`, ESLint `10.6.0`, `@eslint/js@10.0.1`, `typescript-eslint@8.62.1`, `@types/node@24.13.2`, Prettier `3.9.4`. All dependencies exact-pinned (`.npmrc`: `save-exact=true`, `engine-strict=true`); `package-lock.json` committed.
*Why: if the compiler silently changes under an AI agent, yesterday's green build stops meaning anything.*
Enforced: `[CI]` `npm ci` fails on lockfile drift; `.npmrc` in repo.

**A2. One shared `tsconfig.base.json` with the full strict flag set** (the `tsconfig.json` file shipped with this guide — see §7 for the flag-by-flag explanation). No package may weaken an inherited flag; per-package tsconfigs may only add `outDir`, `rootDir`, `include`, `references`, `lib`, `jsx`, `types`, `module`/`moduleResolution` (web only), `noEmit`/`composite` (web only).
*Why: the compiler is the one reviewer that reads every line of every file, every time.*
Enforced: `[compiler]` `tsc -b` must exit 0; `[review]` any diff setting a strict-family flag to `false` in any tsconfig is rejected.

**A3. ESM only.** Every `package.json` has `"type": "module"`; server compiles with `module: "nodenext"`; relative imports include the `.js` extension; `require()`, `module.exports`, `__dirname`, `__filename` are banned (use `import.meta.dirname` / `import.meta.url`, native on Node 24).
*Why: mixing module systems is the #1 way AI code type-checks but crashes at startup.*
Enforced: `[compiler]` `moduleResolution: nodenext` (missing extension = TS2835); `[lint]` `@typescript-eslint/no-require-imports` (in preset) + `no-restricted-globals` for `__dirname`/`__filename`.

**A4. Erasable TypeScript syntax only:** no `enum`, no `namespace`, no parameter properties — use `as const` objects + union types.
*Why: keeps every file directly runnable by Node 24's built-in type stripping, so debugging never needs a build step.*
Enforced: `[compiler]` `erasableSyntaxOnly: true`.

**A5. `any` is banned, explicit and implicit.** Untyped external data is `unknown` and must be narrowed (via `validateAt`, §B).
*Why: `any` turns the type checker off for everything it touches — exactly the hole hallucinated code slips through.*
Enforced: `[compiler]` `strict: true`; `[lint]` `@typescript-eslint/no-explicit-any` + the full `no-unsafe-*` set (in `strictTypeChecked`).

**A6. Type assertions are banned:** no `expr as T`, no `<T>expr`, no non-null `!`. Only exceptions: `as const` (always legal), and a single-line `eslint-disable-next-line` with a written reason (A7). No test exemption (§0.12).
*Why: an assertion is the developer overruling the compiler; an AI agent overruling the compiler is the exact failure mode this guide exists to stop.*
Enforced: `[lint]` `@typescript-eslint/consistent-type-assertions: ["error", { assertionStyle: "never" }]` + `no-non-null-assertion`.

**A7. Every `eslint-disable` carries a `-- reason` description; unused directives are errors; target zero disables in `src/`.**
*Why: escape hatches are allowed only when they explain themselves, so the owner can audit every bypass with one grep.*
Enforced: `[lint]` `@eslint-community/eslint-comments/require-description` + `no-unlimited-disable`; `linterOptions.reportUnusedDisableDirectives: "error"`; `[CI]` disables are grepped into the PR log; `[review]` circular justifications rejected.

**A8. Every Promise is awaited, returned, or explicitly routed to an error handler.** `void promise` fire-and-forget is banned; intentionally detached work goes through the Job Ledger or a named `catchAndLog(promise, logger)` helper.
*Why: a dropped promise is a silent crash-in-waiting — in an always-on app, "silently failed" is the one bug class the owner can never see.*
Enforced: `[lint]` `no-floating-promises` (`ignoreVoid: false`), `no-misused-promises`, `await-thenable`, `require-await`, `return-await` (`error-handling-correctness-only`), `promise-function-async`, core `no-async-promise-executor`.

**A9. Switches over union types are exhaustive with no `default`** — adding a variant (job state, event type, error kind) must break compilation everywhere it isn't handled.
*Why: the engine is a state machine — a forgotten state must be a compile error, not a 2 a.m. surprise.*
Enforced: `[lint]` `switch-exhaustiveness-check` (`allowDefaultCaseForExhaustiveSwitch: false`, `requireDefaultForNonUnion: true`).

**A10. Every exported function declares explicit parameter and return types.**
*Why: exported signatures are the contract other agents build against — inference drift must not silently change it.*
Enforced: `[lint]` `explicit-module-boundary-types`.

**A11. Import fences** — banned everywhere, re-allowed only in one home directory:
| Package(s) | Only importable under |
|---|---|
| `better-sqlite3` | `apps/server/src/storage/**` (+ `tests/**`, `tools/**` for the raw-connection invariant tests) |
| `ai`, `@openrouter/ai-sdk-provider`, `@ai-sdk/openai-compatible` | `apps/server/src/llm/**` |
| `grammy` | `apps/server/src/gateway/telegram/**` |
| `@fastify/multipart` | `apps/server/src/boundary/uploads/**` |
| `typebox`, `@sinclair/typebox` | nowhere (dropped, §0.1) |
*Why: if only one folder can touch a dangerous library, only one folder needs auditing — and each fence is a load-bearing promise (database swap, SDK swap, gateway swap).*
Enforced: `[lint]` `@typescript-eslint/no-restricted-imports` with per-directory overrides (see `eslint.config.mjs`); `[test]` the repository-fence grep test (Invariants I6).

**A12. License fence.** `packages/protocol` and `packages/plugin-sdk` are MIT: they never import from `apps/*`, depend only on MIT workspace siblings, and contain no vendored third-party source (notably no Apache-2.0 code copied in — depending on Apache-2.0 packages is fine, embedding their source is not).
*Why: these packages are the legal promise to plugin and client authors ("no copyleft touches you"); one wrong import quietly makes it false.*
Enforced: `[compiler]` `packages/*` tsconfigs list no references to `apps/*`; `[lint]` `no-restricted-imports` patterns; `[CI]` `scripts/check-licenses.mjs` asserts `"license": "MIT"` and MIT-only workspace deps; `[review]` any new >~50-line file in `packages/` not authored for this repo gets challenged.

**A13. Frontend fence.** `apps/web/` may import `@weltari/protocol` (and `@weltari/plugin-sdk`) but nothing from `apps/server/`.
*Why: "the frontend is just another client" is only true if it physically cannot reach into the engine.*
Enforced: `[lint]` pattern ban in the web override; `apps/web/package.json` lists only the MIT packages as workspace deps.

**A14. Frontend compiles under the same base flags** with only `jsx: "react-jsx"`, DOM libs, `moduleResolution: "bundler"`, `noEmit` changed.
*Why: the render-only frontend gets no strictness discount — it handles the same event schema.*
Enforced: `[compiler]` `apps/web/tsconfig.json` extends the base; type-checked in the same CI run.

**A15. `console.*` is banned in `apps/server/src/`** — use the logger. Exceptions: `observability/fatal.ts` (last resort), `boundary/config/env.ts` (before the logger exists), `scripts/`, `tools/`, tests.
*Why: an always-on appliance needs every message in one structured stream the owner can actually find.*
Enforced: `[lint]` `no-console` scoped as above.

**A16. No wall-clock reads in the engine.** `Date.now()` and `new Date()` are banned under `apps/server/src/engine/**`; the engine takes injected `WorldClock` (fictional) and `SystemClock` (wall time) interfaces.
*Why: the world clock is engine-owned truth, and injected time is what makes tests deterministic.*
Enforced: `[lint]` `no-restricted-syntax`/`no-restricted-properties` in the engine override; `[test]` fakes in `tests/fakes/`.

---

## B. Runtime trust boundaries and validation

**The boundary map** (closed list — reading data from a source not on it is itself a review finding; extend the list first):

| # | Boundary | Enters via | Home directory |
|---|---|---|---|
| B-llm | LLM outputs (tool calls, structured JSON, streams) | AI SDK v6 | `src/llm/` |
| B-telegram | Telegram inbound (long-polling) | grammY | `src/gateway/telegram/` |
| B-wechat | WeChat inbound (official claw bots) | claw connector | `src/gateway/wechat/` |
| B-http | HTTP command bodies/params/query | Fastify 5 routes | `@weltari/protocol` schemas |
| B-plugin | Plugin manifests + everything plugins return | plugin loader | `src/boundary/plugins/` |
| B-config | Config files | startup loader | `src/boundary/config/` |
| B-env | Environment variables / secrets | `src/boundary/config/env.ts` only | same file |
| B-update | Update metadata + downloaded artifacts | updater job | `src/boundary/update/` |
| B-upload | User file uploads (images, plugin zips) | `@fastify/multipart` | `src/boundary/uploads/` |

**B1. Every trust boundary validates with Zod v4 `safeParse`; `.parse()` is banned everywhere.**
*Why: `parse()` throws and an agent will eventually forget the try/catch; `safeParse` forces the failure into a value you must handle.*
Enforced: `[lint]` `no-restricted-syntax` selector banning `.parse(` calls (JSON.parse excepted — it is confined to boundary modules and its output enters `validateAt` as `unknown`); rare false positives (e.g. `path.parse`) take a justified one-line disable per A7.

**B2. External data is typed `unknown` until a `safeParse` succeeds** — never laundered with `any` or a cast (A5/A6 provide the machine enforcement).
Enforced: `[compiler]`+`[lint]` per A5/A6; `[review]` boundary entry functions declare their raw parameter as `unknown`.

**B3. All validation goes through the one sanctioned helper** `validateAt(boundary, schemaName, schema, raw)` in `src/boundary/validate.ts`, whose `boundary` argument is the closed union `"llm" | "telegram" | "wechat" | "http" | "plugin" | "config" | "env" | "update" | "upload"`. It returns the shared `Result` shape and, on failure, logs `{ boundary, schema, issues, raw_size }` — never the raw payload.
*Why: one call site pattern means one place to audit; the closed union means adding a data source without writing it down does not compile.*
Enforced: `[compiler]` exhaustive union; `[review]` no `safeParse` outside `validateAt` or a test.

**B4. On validation failure: reject, log a structured rejection, never repair or partially accept.** Validated types flow inward as plain `z.infer` types — no branded types in V1 (`grep -r "\.brand(" src/` must output nothing).
*Why: half-accepted data is worse than no data — it looks trusted downstream.*
Enforced: `[review]` + the R6 log shape in `validateAt`; `[CI]` brand grep.

**B5. Schemas we author use `z.strictObject` (unknown keys rejected); third-party payloads (Telegram updates, provider responses) use plain `z.object` (unknown keys stripped, never trusted).**
*Why: in our own formats an unexpected key is a bug or an attack; in Telegram's it just means they shipped a new field.*
Enforced: `[test]` one extra-key fixture per schema asserting reject (strict) or strip (loose); `[review]` per boundary module.

**B6. LLM output is never directly durable — two gates in series** (Brief §2.10): the AI SDK tool's Zod `inputSchema` rejects malformed shape; the Scene Engine then validates the well-formed call against game state before committing any event. Streamed narration is display-only until the engine wraps it in a committed event at turn close; a killed stream leaves nothing durable. LLM structured JSON is re-checked with our own `safeParse` even when the provider "guarantees" the shape.
*Why: a schema can't know whether Elias is actually in the room — shape and state are different checks and both must pass; provider JSON modes fail rarely but confidently.*
Enforced: `[lint]` tools definable only in `src/llm/` (A11); `[test]` per-tool rejection tests (Invariants I8) assert zero rows written for malformed and valid-shape-invalid-state calls.

**B7. Gateway inbound is validated, deduplicated, and length-capped before touching any mailbox.** Own Zod schema per update (never trust the library's compile-time types); dedup by `UNIQUE(connector_id, external_msg_id)` insert — constraint violation is a silent drop; inbound text capped at 8 KB before it can enter a prompt.
*Why: messengers redeliver, attackers replay, and a 2 MB paste must not become a 2 MB prompt.*
Enforced: `[test]` SQLite UNIQUE constraint + connector conformance suite (ships in the MIT plugin-sdk) with duplicate/oversized/malformed fixtures.

**B8. WeChat 24h-pause is an expected state, not an error.** A paused claw bot's send failures are validated, marked `paused` in the connector's `health()`, logged once, and not retried until fresh inbound arrives. V1 builds no workaround (owner decision). The connector never crashes, never retry-storms, never blocks Telegram. *Open verification carried forward:* the concrete claw-bot API/library and its outbound-only operation are to be verified at the gateway milestone; the 24h figure is the owner's statement, not re-verified against WeChat docs.
Enforced: `[test]` paused-response fixture asserting no throw, no retry in window, `health()` degraded.

**B9. HTTP commands validate via `fastify-type-provider-zod@7.0.0`** — one Zod schema per route, defined in `@weltari/protocol`; `setValidatorCompiler`/`setSerializerCompiler` set once at server construction; `z.toJSONSchema()` emits the committed `schemas/*.json` for non-JS clients.
*Why: route validation and the trust-boundary rule become the same mechanism instead of two schema languages that drift.*
Enforced: `[CI]` `npm run protocol:emit && git diff --exit-code packages/protocol/schemas/`; `[lint]` TypeBox ban.

**B10. Plugin manifests are strict-validated and SHA-256-verified at install AND at every load;** a failing plugin does not load — the app boots without it and surfaces the failure in Config. Everything a plugin hands back at runtime is boundary data and is `safeParse`d by the host. Honest security line (documented as such): plugins run in-process in V1 — validation limits accidents and data corruption, not a malicious plugin; the real protections are the manifest hash + provenance display.
Enforced: `[test]` tampered-byte fixture asserting refusal + `plugin.rejected` event; `[review]` host-side `validateAt` on every plugin-facing seam.

**B11. Config files strict-validate at startup; an invalid config aborts boot printing the exact key path — never "defaults over garbage"** (`.default()` for genuinely absent keys is fine; the ban is on malformed present values).
Enforced: `[test]` typo'd-key fixture asserting non-zero exit + key path in output.

**B12. Update metadata is untrusted:** `safeParse` the Releases JSON, verify the artifact's SHA-256 AND minisign signature before the `current` pointer flips; mismatch deletes the download and keeps the running version. The pointer-flip code path takes a `VerifiedArtifact` value only the verifier constructs.
Enforced: `[test]` wrong-hash and wrong-signature fixtures; `[compiler]` `VerifiedArtifact` construction confinement.

**B13. Uploads: size-capped at the transport, magic-byte-verified, stored under engine-generated IDs;** client filenames are display metadata only and never touch a path. Plugin zips get a zip-slip check (every entry's resolved path stays inside the extraction dir).
Enforced: `[test]` zip-slip fixture asserting refusal; `[lint]` `@fastify/multipart` fence (A11).

**B14. Prompt-injection posture: external text that re-enters prompts is data, never instructions.** The ContextAssembler wraps non-core text in provenance-tagged delimiters and never interpolates external text into the stable prefix (core-provenance content only). Accepted residual risk (documented): injection can make a character *say* weird things; it can never write durable state except through the B6 double gate.
Enforced: `[test]` byte-stability tests include a hostile-string fixture asserting the stable prefix stays byte-identical (Invariants I5); `[review]` no string concatenation into system/skill slots outside the assembler.

**B15. Secrets live only in environment variables, read only in `src/boundary/config/env.ts`,** validated by an env Zod schema at boot (missing/malformed *names* printed, never values), redacted from all logs, scanned in CI. `.env` is gitignored; `.env.example` carries names only.
Enforced: `[lint]` `n/no-process-env` (from `eslint-plugin-n@18.x`) everywhere in server src except `env.ts`; `[test]` planted-key redaction test; `[CI]` `gitleaks/gitleaks-action@v3` on every push + `gitleaks dir . --redact --no-banner` as the local pre-commit hook.

---

## C. Error handling, logging and observability

**C1. Every error is one of three kinds on one base class** (`apps/server/src/errors.ts`): `operational` (expected failure of something we don't control: LLM timeout, 429/5xx, network, disk-full), `bug` (our code broke its own contract), `corrupt_state` (durable rows contradict an invariant; SQLITE_CORRUPT/IOERR).
*Why: the three kinds have three different correct reactions — retry, crash, crash-and-refuse-blind-restart — and an agent picking the reaction needs the kind to be data, not judgment.*
Enforced: `[lint]` `only-throw-error`; `[compiler]` exhaustive `switch (e.kind)` with `never` check in the job runner and request handler (A9).

**C2. Result at integration edges; throw for bugs and corruption everywhere.** Functions calling anything external return `Promise<Result<T>>` and never throw for operational failures (catch the SDK exception at the edge, classify, `return err(...)`). Repositories, engine internals and pure domain code throw `BugError`/`CorruptStateError` and return plain values (better-sqlite3 is synchronous; throwing inside a transaction aborts it — which is what we want). `safeParse` failure of external data → rejection (B4); of our own stored data → `CorruptStateError`.
*Why: expected failures become values the compiler forces you to look at; impossible failures stay exceptions so they reach the crash handler.*
Enforced: `[review]` any `try/catch` in `src/llm/`, `src/gateway/`, `src/boundary/update/` ends in `return err(...)` or rethrow; `[lint]` A11 fences confine the SDKs.

**C3. Empty catch is banned; every catch does exactly one of:** (a) rethrow (preserving `{ cause }`), (b) `return err(...)`, (c) log at `warn`+ with the error attached and a `// CATCH-OK: <reason>` marker.
Enforced: `[lint]` `no-empty`, `use-unknown-in-catch-callback-variable`, tsconfig `useUnknownInCatchVariables` (in `strict`); `[CI]` catch-audit grep script (crude by design — makes drive-by swallowing loud).

**C4. Throw/reject only `Error` instances; no floating promises** (`only-throw-error`, `prefer-promise-reject-errors`, plus A8). `[lint]`

**C5. Crash on purpose: `process.exit` exists in exactly one function,** `fatal(err)` in `src/observability/fatal.ts` — synchronous log flush, exit 1 (exit 3 for `corrupt_state`, §0.10). Triggers, exhaustively: uncaughtException; unhandledRejection; `BugError`/`CorruptStateError` inside a repository transaction, mailbox handler, or the tool-validation/commit path; SQLITE_CORRUPT/IOERR/FULL/READONLY; migration failure at startup. Never exit for `operational` errors. No cleanup beyond the flush — graceful shutdown is an optimization, never a correctness requirement (Brief §2.4); startup *is* recovery.
*Why: after a detected bug the in-memory state is unreliable; the durable log + ledger are not — restarting from them is the one recovery path tested every day, because it is the startup path.*
Enforced: `[lint]` `no-restricted-properties` bans `process.exit` outside `fatal.ts`; `[CI]` kill-harness proves restarts converge (Invariants I4).

**C6. Process handlers exist to log, never to survive.** `main.ts` installs `process.on('uncaughtException', fatal)` and `('unhandledRejection', fatal)` once, first; no library or plugin registers its own. SIGTERM/SIGINT: set draining flag, stop claiming jobs, ≤5 s, exit 0 — purely an optimization.
Enforced: `[CI]` grep: those two `process.on` registrations appear exactly twice, both in `main.ts`.

**C7. The job runner is the only catch site for job execution, mapping kind → ledger state in one exhaustive switch:** `operational` → attempts+1, exponential backoff, → `parked` after max (default 5); `bug` → `parked` immediately (never retry deterministic bugs), then `fatal()` if the throw escaped mid-transaction; `corrupt_state` → `fatal()`. Every state change writes truncated `last_error {kind, code, message}` (never prompt content) and emits `job.failed`/`job.parked` events for the UI.
Enforced: `[test]` one error of each kind through a stub job asserts the row state; `[review]` no try/catch inside individual job implementations except C3-conforming edge catches.

**C8. Structured logging is pino v10, NDJSON to stdout** (+ `pino.destination()` file for native installs). No worker-thread transports in production; `pino-pretty` is a dev-only CLI pipe, `devDependencies` only. One root logger in `observability/logger.ts`.
Enforced: `[CI]` `pino-pretty` placement checked in package.json; `[lint]` `no-console` (A15).

**C9. Log levels have fixed meanings:** `fatal` = about to exit (only fatal.ts) · `error` = job parked / turn voided / someone should look · `warn` = retried operational failure or degraded mode or gauge threshold · `info` = low-volume lifecycle facts (steady-state idle ≈ zero info lines) · `debug` = per-call diagnostics incl. model, token counts, `cached_tokens`, durations · `trace` = payload-level detail incl. prompts, never on by default.
Enforced: `[CI]` idle-minute test fails if info lines exceed a fixed count (Invariants I13); `[review]` against this table.

**C10. Every log line carries correlation ids via child loggers** bound once at context creation (`world_id`, plus whichever exist of `scene_id`, `turn_id`, `session_id`, `job_id`, `conversation_id`, `connector_id`, `event_seq`); deep code receives the child logger, never re-passes ids.
Enforced: `[review]` only `logger.ts` creates a root logger; `[test]` scripted-turn test samples lines for `turn_id`.

**C11. Diagnostics are never truth; the dev channel is not a log tail.** Dev mode renders log-only events from the event system's `trail`, emitted at their source as typed events — never by parsing pino output. Pino lines are never read by application code, never rendered in any UI, never replayed. Events mirror *state changes* only (e.g. `job.parked`), never log lines.
Enforced: `[CI]` grep: no `fs` import targeting the logs dir outside `observability/`; `[review]` dev-channel code's inputs are event types from `@weltari/protocol`.

**C12. Secrets and user content never reach `info`:** keys/tokens/credentials never logged at any level (pino `redact` paths, structural); prompts/completions/thinking/memory content `trace` only; provider metadata (model id, token counts, `cached_tokens`, latency) at `debug` — that is the cache-hit observability the risk register requires.
Enforced: `[test]` planted `apiKey` emits `[Redacted]`; `[review]` new logger fields named like `content|prompt|message|key|token|secret` need justification.

**C13. The process watches its own event loop and memory:** every 15 s, `monitorEventLoopDelay()` p99 and RSS, logged at `debug`, escalated to `warn` past 200 ms p99 or 220 MB RSS, and mirrored as `dev.gauges` events for dev mode.
Enforced: `[CI]` smoke test asserts the gauge line within 30 s of boot.

---

## D. Agent workflow, task gates and dependency policy

**D1–D5. The Definition of Done** (also shipped as the one-page `Task Completion Checklist.md`): a task is complete only when, on a clean checkout, all of these exit 0 — `npm run format:check` (Prettier) · `npm run lint` (`eslint . --max-warnings 0`; warnings are failures) · `npm run typecheck` (`tsc -b` + `tsc -p apps/web`) · `npm test` (full Vitest suite; no `.only`/`.skip` in committed code) · `npm run knip` (no unused deps/dead exports) — collectively `npm run gate`.
*Why: "it looks right" is not a check; commands with exit codes are — and they are the same commands CI runs, so "works on my run" is not a state that exists.*
Enforced: `[CI]` every step blocks merge via branch protection; `[lint]` `no-only-tests/no-only-tests` + `vitest/no-focused-tests` + `vitest/no-disabled-tests`; `[CI]` runner-agnostic grep backstop for `.only(`/`.skip(` in test files.

**D6. One logical change per commit; conventional messages** (`feat(scene-engine): …`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`); docs page and the code it describes change in the same commit (builder.md §2); PRs over ~400 changed source lines must say why they couldn't be split.
Enforced: `[CI]` commitlint (`@commitlint/cli@21.2` + `config-conventional`) over the PR range; `[review]` "can I describe this commit in one sentence?".

**D7. Task slicing:** every task names (a) the target module directory, (b) the acceptance command ("run X, it must output Y"), (c) the docs page to update. Tasks that cannot name an acceptance command are not ready. All work extends the real repository in place — the walking-skeleton rule: no scratch folders, no `prototype/` dirs, no parallel repos.
Enforced: `[review]` PR description quotes the acceptance command and its output; `[CI]` new top-level directories outside the documented layout fail.

**D8. Dependency policy:** every new dependency requires, in the same PR: a `docs/dependencies.md` entry (what, why not stdlib/existing, license, maintenance evidence — release within ~12 months or a written staleness waiver); an AGPLv3-compatible license (MIT/ISC/BSD/Apache-2.0/MPL-2.0; Apache-2.0 may be depended on but never copied into the MIT packages); exact pin; lockfile updated. peerDependency warnings in `npm ci` output are gate failures, not noise.
Enforced: `[CI]` `scripts/check-dep-ledger.mjs` (every dep needs a `## <name>` heading), `knip`, `license-checker-rseidelsohn --onlyAllow` with the approved list, grep for `^`/`~` ranges.

**D9. Monthly batched updates, never ad hoc:** one owner-triggered `chore(deps):` PR per month (bump pins, `npm audit`, full gate, record notable majors — including the standing TS 6.x and `ai` v7 re-evaluations). Agents never bump a version inside a feature PR.
Enforced: `[review]` any `package.json` version change in a non-`chore(deps)` PR is rejected. (Deliberately manual: scheduling it would give an agent standing write access on a timer.)

**D10. Lockfile always committed; CI installs with `npm ci`, never `npm install`.** `[CI]`

**D11. Docs-accompany heuristic:** builder.md's docs-in-same-commit rule is primarily a `[review]` check; CI additionally posts a warning (non-blocking) when `apps/server/src/<module>/` changed but `docs/<module>.md` did not — warning-level because pure refactors legitimately skip docs.

---

## E. Invariants and testing

The full invariant list, guard-per-invariant, templates, and runner setup ship in `Weltari Invariants & Test Templates.md`. The binding rules:

**E1. Every Brief §2 hard constraint has a permanent machine guard + invariant test** (append-only event log, mailbox serialization, ledger semantics, kill-9 recovery, prompt-prefix byte stability, repository fence, protocol snapshots, LLM-never-durable). See Invariants I1–I9.
Enforced: `[test]` the `invariants` Vitest project gates every merge; `[CI]` kill harness 25 cycles per PR, 100 nightly.

**E2. Tests ship in the same task as the code; bulk backfill is banned.**
Enforced: `[CI]` `tools/check-tests-accompany.mjs` (new `src/` file with no test touched ⇒ fail) + patch coverage ≥ 85%; `[review]` PR names which behavior each new test pins.

**E3. Coverage gates: patch coverage ≥ 85%; branch coverage ≥ 90% on `apps/server/src/storage/`, `apps/server/src/engine/`, `packages/protocol/`.** Frontend excluded from gates. No vanity 100%.
Enforced: `[CI]` `@vitest/coverage-v8` per-glob thresholds + `tools/patch-coverage.mjs`.

**E4. All time and all LLM calls are injected** (A16; `FakeLLM` at the ModelRegistry seam). Tests with `setTimeout`-waiting or real API keys are rejected.
Enforced: `[lint]` engine clock ban; `[review]`.

**E5. Test what breaks silently; assert through public seams only** (events, repository reads, HTTP/SSE) — never private spies or internal call counts. No UI pixel snapshots; never assert LLM prose wording, only shape. `toMatchSnapshot()` only in `packages/protocol` (schema snapshots).
Enforced: `[lint]` snapshot ban outside protocol; `[review]` grep for `vi.spyOn` on internals; nightly StrykerJS mutation run over storage+engine (informative, not gating).

**E6. Invariant tests are protected:** modifying an existing file under `tests/invariants/` fails CI without the owner-applied `invariant-change` label. Adding new invariant tests is always allowed.
Enforced: `[CI]` label check on the diff.

---

## 7. tsconfig explanation (the shipped `tsconfig.json` is the shared strict base)

The deliverable `tsconfig.json` file is committed at the repo root as **`tsconfig.base.json`**; every package extends it. JSON has no comments, so the explanations live here:

| Flag | Plain-language reason |
|---|---|
| `target: es2024` | Node 24 runs ES2024 natively; no downleveling. |
| `module: nodenext` | Real Node ESM semantics; forces `.js` extensions on relative imports (implies `moduleResolution: nodenext`). |
| `moduleDetection: force` | Every file is a module; no accidental global scripts. |
| `verbatimModuleSyntax` | Type imports must say `import type`; imports emit exactly as written. |
| `erasableSyntaxOnly` | No enums/namespaces/param properties → Node can strip types and run files directly (A4). |
| `isolatedModules` | Every file compilable alone (Vite/strip-types safe). |
| `strict` | The umbrella: `noImplicitAny`, `strictNullChecks`, `useUnknownInCatchVariables`, etc. |
| `noUncheckedIndexedAccess` | `arr[i]` is `T \| undefined` — index lookups must be checked (owner mandate). |
| `exactOptionalPropertyTypes` | Optional props can be omitted but never explicitly `undefined` — kills a whole class of "why is this undefined" bugs. |
| `noImplicitOverride` | Overriding a method requires the `override` keyword. |
| `noPropertyAccessFromIndexSignature` | Dynamic keys need bracket access — typos on real props stay errors. |
| `noImplicitReturns` / `noFallthroughCasesInSwitch` | Every code path returns explicitly; no accidental case fallthrough. |
| `noUnusedLocals` / `noUnusedParameters` | Dead variables are errors (AI agents leave these constantly); prefix `_` for intentionally unused. |
| `allowUnreachableCode: false` / `allowUnusedLabels: false` | Dead code after return/throw is an error. |
| `allowJs: false` | TypeScript only — no unchecked .js in src. |
| `forceConsistentCasingInFileNames` | Windows dev box vs Linux Docker: casing bugs die here. |
| `composite`/`declaration`/`declarationMap`/`sourceMap`/`incremental` | Project-references monorepo build. |
| `skipLibCheck` | Don't re-check node_modules' own `.d.ts` — their bugs aren't fixable here. |

**Per-package tsconfigs** (the only allowed variations, per A2):

`tsconfig.json` (root solution): `{ "files": [], "references": [{ "path": "packages/protocol" }, { "path": "packages/plugin-sdk" }, { "path": "apps/server" }] }` — `apps/web` uses `noEmit`, so the `typecheck` script runs `tsc -b && tsc -p apps/web`.

`apps/server/tsconfig.json`: extends base; `rootDir: "src"`, `outDir: "dist"`, `types: ["node"]`; references `../../packages/protocol` and `../../packages/plugin-sdk`.

`packages/protocol/tsconfig.json` and `packages/plugin-sdk/tsconfig.json`: extends base; `rootDir`/`outDir` only; **no references to `apps/*`** (the license fence, A12 — the import physically cannot type-resolve).

`apps/web/tsconfig.json`: extends base; `module: "esnext"`, `moduleResolution: "bundler"`, `jsx: "react-jsx"`, `lib: ["es2024", "dom", "dom.iterable"]`, `noEmit: true`, `composite: false`, `types: ["vite/client"]`; references `../../packages/protocol`.

**Root `package.json` fragment (pinned toolchain):**

```jsonc
{
  "name": "weltari",
  "private": true,
  "license": "AGPL-3.0-only",
  "type": "module",
  "engines": { "node": ">=24.0.0 <25" },
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "typecheck": "tsc -b && tsc -p apps/web",
    "lint": "eslint . --max-warnings 0",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "knip": "knip",
    "gate": "npm run format:check && npm run lint && npm run typecheck && npm test && npm run knip"
  },
  "devDependencies": {
    "typescript": "5.9.3",
    "eslint": "10.6.0",
    "@eslint/js": "10.0.1",
    "typescript-eslint": "8.62.1",
    "@eslint-community/eslint-plugin-eslint-comments": "4.7.2",
    "eslint-plugin-n": "18.2.1",
    "eslint-plugin-no-only-tests": "3.4.0",
    "eslint-plugin-react-hooks": "7.1.1",
    "@vitest/eslint-plugin": "pin-exact-at-install",
    "eslint-config-prettier": "10.1.8",
    "prettier": "3.9.4",
    "globals": "17.7.0",
    "@types/node": "24.13.2",
    "vitest": "4.1.10",
    "@vitest/coverage-v8": "4.1.10",
    "knip": "6.24.0",
    "@commitlint/cli": "21.2.0",
    "@commitlint/config-conventional": "21.2.0"
  }
}
```

Key runtime pins (exact, in the workspace packages that use them): `fastify` 5.10.x · `fastify-type-provider-zod` 7.0.0 · `zod` 4.4.3 · `better-sqlite3` 12.11.1 · `ai` 6.0.219 (intentional — v7 exists, see §0.7) · `@openrouter/ai-sdk-provider` 2.10.0 · `pino` 10.3.1 (`pino-pretty` 13.1.3 dev-only) · `sharp` 0.35.x · `grammy` 1.44.x · `croner` 10.x · `web-push` pinned (MPL-2.0; frozen IETF standard; `@pushforge/builder` documented as the swap).

---

## 8. Forbidden actions (absolute — no justification accepted)

An agent must **never**:

1. Force-push to `main` or any shared branch.
2. Delete, weaken, or skip a test to make the suite pass. (If a test is truly wrong, change it in its own commit explaining why the old assertion was wrong; `tests/invariants/` edits additionally need the owner's `invariant-change` label.)
3. Modify a shipped migration file (append-only history, hash-locked — fix forward with a new migration).
4. Hand-edit generated files (built frontend output, `packages/protocol/schemas/*.json`, `package-lock.json`) — regenerate via the owning tool.
5. Commit `.env`, an API key, or any credential — including inside test fixtures.
6. Use `git commit --no-verify` or otherwise bypass hooks.
7. Set any `strict`-family tsconfig flag to `false`, or add an `eslint-disable` without a written reason.
8. Write `UPDATE` or `DELETE` against the `events` table, or add mutating methods to the event-log repository.
9. Import a fenced package outside its home directory (A11), or add a dependency without its `docs/dependencies.md` entry.
10. Create scratch/prototype folders or parallel repos — all work extends the walking skeleton in place.
11. Bump a dependency version inside a feature PR (monthly `chore(deps)` only).
12. Parse, tail, or render pino diagnostic output from application code (C11).

---

## 9. Definition of Done (the gate)

A task is done when **all** of the following hold — this list is duplicated as the one-page `Task Completion Checklist.md`:

1. `npm run gate` exits 0 on a clean checkout (format:check → lint at zero warnings → typecheck → full test suite → knip).
2. The task's named acceptance command was run and its output is quoted in the PR description.
3. Tests for the new/changed behavior are in the same commit(s); patch coverage ≥ 85%.
4. The module's `docs/` page changed in the same commit as the code (builder.md §2).
5. New dependencies (if any) have ledger entries, exact pins, and a clean license check.
6. Zero new unexplained `eslint-disable`s; no forbidden action taken.
7. Commits are conventional, one logical change each.

---

## 10. Enforcement index

| Mechanism | Rules |
|---|---|
| **Compiler** (`tsc -b`) | A2–A6 (flags), A9 (never-check), A12 (no references), A14, B3 (closed union), B12 (VerifiedArtifact), C1 |
| **Lint** (`eslint . --max-warnings 0`) | A3, A5–A11, A13, A15, A16, B1, B15, C1, C3–C5, C8, D1–D5 (test focus), E5 (snapshot ban) |
| **CI scripts/steps** | A1 (npm ci), A7 (disable grep), A12 (license check), B4 (brand grep), B9 (schema emit diff), B15 (gitleaks v3), C3 (catch audit), C6 (handler grep), C9 (idle-info budget), C11 (fs grep), C13 (gauge smoke), D1–D11 (gate, commitlint, dep ledger, migrations hash, licenses, knip), E1 (invariants project + kill harness), E2–E3 (coverage), E6 (label check) |
| **Tests** | B5–B8, B10–B14, C7, C10, C12, E1 (Invariants I1–I14), E4 |
| **Human review** | A2 (flag weakening), A12 (vendored source), B2/B3/B5 (boundary hygiene), C2 (edge catches), C9/C12 (log discipline), D6–D9, E2, E5 |

*Open items carried forward for the owner:* the concrete WeChat claw-bot API/library (verify at the gateway milestone, outbound-only); the nightly real-token cache-hit cost (§0.14); TS 6.x and `ai` v7 re-evaluations in the monthly deps PR.

