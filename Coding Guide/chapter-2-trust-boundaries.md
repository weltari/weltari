All inputs read and versions verified (npm registry + GitHub API + Context7). Producing the chapter.

# Chapter 2: Runtime Trust Boundaries and Data Validation

Weltari's code is written by AI agents, and AI agents' most common security failure is *trusting data because the type annotation says it's fine*. This chapter makes that impossible: every byte that enters the process from something we don't control passes through one Zod v4 `safeParse` gate, and the lint/CI configuration makes bypassing the gate a build failure, not a code-review debate.

**The boundary map.** These are all of Weltari's trust boundaries. If new code reads data from a source not on this list, that is itself a review finding — the list must be extended first.

| # | Boundary | Enters via | Schema lives in |
|---|---|---|---|
| B1 | LLM outputs (tool calls, structured JSON, streamed text) | AI SDK v6 (`ai@^6`) | `src/boundary/llm/` |
| B2 | Telegram inbound (long-polling) | grammY `bot.start()` | `src/plugins/telegram/` (connector) |
| B3 | WeChat inbound (official claw bots, 24h-pause) | claw-bot connector plugin | `src/plugins/wechat/` (connector) |
| B4 | HTTP command bodies + params + query | Fastify 5 routes | `@weltari/protocol` (shared with clients) |
| B5 | Plugin manifests + everything a plugin returns at runtime | plugin loader | `src/boundary/plugins/` |
| B6 | Config files | startup loader | `src/boundary/config/` |
| B7 | Environment variables / secrets | `src/boundary/config/env.ts` only | same file |
| B8 | Update metadata (GitHub Releases JSON, downloaded artifacts) | updater job | `src/boundary/update/` |
| B9 | User file uploads (images, plugin zips) | `@fastify/multipart` | `src/boundary/uploads/` |

Everything inside these gates trusts its inputs; nothing outside them is trusted. "Inside" and "outside" are directory-fenced and lint-enforced (Rule 3), not conventions.

## Rules

Each rule: **the rule** — *why (plain language)* — **enforced by**.

**R1. Every trust boundary validates with Zod v4 `safeParse`; `parse()` is banned everywhere.**
*Why: `parse()` throws, and an AI agent will eventually forget the try/catch — `safeParse` forces the failure into a value you must handle.*
Enforced: ESLint `no-restricted-syntax` selector banning `.parse(` calls (config below); CI runs `eslint . --max-warnings 0`.

**R2. No `as` casts and no `any` to launder external data — external data is typed `unknown` until a `safeParse` succeeds.**
*Why: a cast is a promise the AI cannot keep; `unknown` makes the compiler demand proof.*
Enforced: the strict-TS chapter's compiler/lint gates (`@typescript-eslint/no-explicit-any`, `no-unsafe-assignment`, ban on `as`); this chapter adds: all boundary entry functions must declare their raw parameter as `unknown` — review check: grep boundary modules for parameters typed as anything other than `unknown` before validation.

**R3. Only the boundary directory for a source may import that source's transport library.**
*Why: if only one folder can talk to Telegram, only one folder needs auditing.*
Enforced: ESLint `no-restricted-imports` (config below): `grammy` importable only under `src/plugins/telegram/`, `ai` and `@openrouter/ai-sdk-provider` only under `src/boundary/llm/`, `undici`/raw `fetch` wrappers for update checks only under `src/boundary/update/`. Same mechanism that already fences better-sqlite3 into `repositories/`.

**R4. Validated types flow inward as plain `z.infer` types — no branded types in V1.**
*Why: brands add cast-shaped friction that tempts AI agents back into `as`; the directory fence (R3) already guarantees anything inward was validated.*
Enforced: decision recorded here; review check: no `.brand(` calls in the codebase (`grep -r "\.brand(" src/` must output nothing).

**R5. Boundary schemas we author (protocol, config, plugin manifests, update metadata) use `z.strictObject` — unknown keys are rejected. Third-party API payloads (Telegram updates, provider responses) use plain `z.object` — unknown keys are stripped, never trusted.**
*Why: for our own formats, an unexpected key means a bug or an attack; for Telegram's, it just means they shipped a new field and we must not break.*
Enforced: review check per boundary module; a unit test per schema feeding one extra-key fixture and asserting reject (strict) or strip (loose).

**R6. On validation failure: reject the input, log a structured rejection event, never "repair" or partially accept.** The rejection record carries `{boundary, schema_name, issues: error.issues, raw_size}` — never the full raw payload into durable logs (it may contain secrets or injection text). Error taxonomy and log shape are Chapter 3's; this chapter binds only *reject + log + no repair*.
*Why: half-accepted data is worse than no data — it looks trusted downstream.*
Enforced: shared `validateAt()` helper (below) is the only sanctioned call site pattern; review check: no `safeParse` call outside `validateAt` or a test.

**R7. LLM output is never directly durable (Brief §2.10). Two gates in series: Zod shape-validation of the tool call, then engine state-validation.** The AI SDK's `inputSchema` (Zod) rejects malformed arguments; the Scene Engine then checks the *valid-shaped* call against game state (character present? art exists? holder rules?) before committing any event. Streamed narration text is display-only until the engine wraps it in an engine-committed event at turn close; a killed stream leaves nothing durable (turn-envelope voiding, Rev 4 §16).
*Why: a schema can't know whether Elias is actually in the room — shape and state are different checks and both must pass.*
Enforced: tools are defined with `tool({ inputSchema })` in `src/boundary/llm/` only (R3); a CI test drives each Narrator tool with (a) malformed JSON, (b) well-formed-but-invalid-state calls and asserts zero rows/events written.

**R8. LLM structured JSON (VLM map classification, engagement signals, world forms) goes through `safeParse` on our own schema even when the SDK "guarantees" the shape.**
*Why: provider-side JSON modes fail rarely but confidently — the cheap re-check catches the day they do.*
Enforced: the `validateAt()` helper wraps every `generateObject`/tool result before it leaves `src/boundary/llm/`; review check on that directory's exports.

**R9. Gateway inbound messages are validated, deduplicated, and length-capped before touching any mailbox.** Telegram: validate each grammY update against our own Zod schema (not grammY's types — types are compile-time only); WeChat claw-bot callbacks likewise. Dedup by `UNIQUE(connector_id, external_msg_id)` insert — a constraint violation is a silent drop, not an error. Cap inbound text (suggest 8 KB) before it can enter a prompt.
*Why: messengers redeliver, attackers replay, and a 2 MB paste should not become a 2 MB prompt.*
Enforced: SQLite UNIQUE constraint (structural); Zod `.max()` on the text field; connector conformance test suite (ships in the MIT SDK per FINAL §5-risk-2) feeds duplicate + oversized + malformed fixtures and asserts exactly-once, capped, or rejected.

**R10. WeChat 24h-pause is an expected state, not an error.** When the claw bot is paused (user silent >24h), outbound sends fail — the connector must validate the API error response with Zod, mark the failure as `paused` in its `health()` state, log once, and stop retrying that thread until fresh inbound arrives. V1 builds no workaround (owner decision 2026-07-06); the connector must simply never crash, never retry-storm, and never block the Telegram channel.
*Why: the pause is WeChat working as designed — treating it as a crash would take down a healthy gateway.*
Enforced: connector conformance test with a paused-response fixture asserting: no throw, no retry within the test window, `health()` reports degraded.

**R11. HTTP command validation unifies on Zod v4 via `fastify-type-provider-zod` — one schema per route, defined in `@weltari/protocol`.** Verified 2026-07-06: `fastify-type-provider-zod@7.0.0` peer-depends on `zod@>=4.1.5` and `fastify@^5.5.0` — Zod v4 support is real and current. **Recommendation (settles the Fact-check open item): drop TypeBox entirely.** Protocol schemas are written once in Zod v4; `z.toJSONSchema()` emits the JSON Schema files that `@weltari/protocol` ships for non-JS clients (OpenAPI 3.1 via `jsonSchemaTransform`, AsyncAPI 3.1 for events). Fastify's route-level validation and the trust-boundary rule become the same mechanism instead of two parallel schema languages that will drift.
*Why: two schema systems describing the same wire format is exactly the kind of duplicated truth AI agents silently un-sync.*
Enforced: `app.setValidatorCompiler(validatorCompiler)` set once at server construction (snippet below); CI step regenerates JSON Schema from Zod and fails on git diff (`npm run protocol:emit && git diff --exit-code packages/protocol/schemas/`); ESLint bans importing `typebox`/`@sinclair/typebox` anywhere.

**R12. Plugin manifests are strict-validated and hash-verified at install *and* at every load; a plugin that fails either check does not load — the app boots without it and surfaces the failure in Config.**
*Why: a plugin folder is the most attacker-shaped thing on disk; a bad plugin must cost the user one feature, never the world.*
Enforced: `PluginManifestSchema` (`z.strictObject`, below) + SHA-256 recompute against `provenance.sha256` in the loader; loader test with a tampered-byte fixture asserting refusal + `plugin.rejected` event.

**R13. Everything a plugin hands back at runtime is boundary data.** `register(api)` return values, connector `onInbound` payloads, theme token files — all `safeParse`d by the host before use. Plugin backend code runs in-process (V1 accepts this — no sandbox), so validation limits *accidents and data corruption*, not a malicious plugin; the honest security line is the manifest hash + provenance display, and docs must say so.
*Why: we can't stop in-process code from misbehaving, but we can stop its bad data from becoming durable state.*
Enforced: host-side `validateAt()` on every plugin-facing API seam; the plugin API's TypeScript types are advisory, the runtime checks are the contract.

**R14. Config files are validated at startup with `z.strictObject`; an invalid config aborts boot with the exact key path and expected type printed — never "defaults over garbage".**
*Why: silently defaulting a mistyped key means the user's setting is ignored without telling them.*
Enforced: startup loader in `src/boundary/config/`; test feeding a config with one typo'd key asserting non-zero exit + key path in output. (Defaults are fine for genuinely *absent* keys via `.default()` — the ban is on malformed *present* values.)

**R15. Update metadata is untrusted network data: `safeParse` the Releases JSON, then verify the downloaded artifact's SHA-256 *and* minisign signature before the `current` pointer ever flips.** A hash/signature mismatch deletes the download, logs `update.rejected`, and keeps the running version.
*Why: the updater is remote-code-execution by design — the signature is the only thing standing between "update" and "compromise".*
Enforced: verification is one function in `src/boundary/update/` whose test suite includes a wrong-hash and wrong-signature fixture; the pointer-flip code path takes a `VerifiedArtifact` value that only that function constructs.

**R16. User uploads: size-capped at the transport, magic-byte-verified, stored under engine-generated IDs — the client-supplied filename is display metadata only and never touches a path.** Images: `@fastify/multipart` with `limits.fileSize`, then `sharp(buffer).metadata()` must succeed and report an allowed format. Plugin zips: size cap + zip-slip check (every entry's resolved path must stay inside the extraction dir) before any entry is written.
*Why: `../../etc/cron.d/x` is a filename; path traversal is the oldest upload trick and AI agents re-invent the vulnerable version constantly.*
Enforced: multipart limits in server config; extraction helper test with a zip-slip fixture asserting refusal; ESLint fence: `@fastify/multipart` importable only in `src/boundary/uploads/`.

**R17. Prompt-injection posture: external text that re-enters prompts (gateway messages, wiki entries, memory deltas, social posts, plugin skill text) is data, never instructions.** Structural containment already holds (Rev 4 §16: agents have only engine-granted tools; skills can never grant tools — injected text *cannot escalate capability*). On top: (a) the ContextAssembler wraps every non-core text block in provenance-tagged delimiters (`<wiki provenance="scene:…">…</wiki>` style) and never interpolates external text into the stable prefix — stable prefix is core-provenance content only; (b) tool-call *results* fed back to models are engine-generated summaries, not raw external text where avoidable. Accepted residual risk (Brief posture: "operator's own risk"): injection can still make a character *say* weird things — it can never write durable state except through the R7 double gate.
*Why: we can't stop a model being persuaded; we can stop persuasion from ever holding a pen.*
Enforced: byte-stability unit tests on every prompt builder (already mandated for cache discipline — same test asserts a hostile-string fixture in wiki/memory leaves the stable prefix byte-identical); review check: no string concatenation into the system/skill slots outside the assembler.

**R18. Secrets live only in environment variables, read only in `src/boundary/config/env.ts`, validated by an env Zod schema at boot, redacted from all logs, and scanned for in CI.** Never hardcoded, never in SQLite rows, never in events, never in the repo. `.env` is gitignored; `.env.example` carries names only.
*Why: an AI agent pasting a working API key into a test fixture is a when, not an if — the scanner catches it before it's public forever.*
Enforced: four machine checks — (1) ESLint `n/no-process-env` (from `eslint-plugin-n`) errors on any `process.env` outside `env.ts`; (2) env schema `safeParse` aborts boot listing missing/malformed variable *names* (never values); (3) pino logger `redact` paths on Fastify (below) so `authorization`, `apiKey`-shaped fields never serialize; (4) **gitleaks v8.30.x** (verified current, released 2026-03-21) in CI: `gitleaks dir . --redact --no-banner` on every push (GitHub: `gitleaks/gitleaks-action@v2`), plus the same as a pre-commit hook.

**R19. The boundary list itself is enforced.** A CI grep asserts the fenced directories exist and that `validateAt` call sites reference a registered boundary name from a closed union — adding a new external data source without extending the `Boundary` union type does not compile.
*Why: the most dangerous boundary is the one nobody wrote down.*
Enforced: `type Boundary = "llm" | "telegram" | "wechat" | "http" | "plugin" | "config" | "env" | "update" | "upload"` — exhaustive union, compiler-checked.

## Config or code snippets

All names/versions verified against npm registry, GitHub releases, and Context7 on 2026-07-06: `zod@4.4.3`, `fastify-type-provider-zod@7.0.0` (peers: `zod@>=4.1.5`, `fastify@^5.5.0`, `@fastify/swagger@>=9.5.1`), `ai@6.0.219` (dist-tag `ai-v6`), `gitleaks v8.30.1`, `eslint-plugin-n` (`n/no-process-env`).

**The one sanctioned validation helper** (`src/boundary/validate.ts`):

```ts
import { z } from "zod";

export type Boundary =
  | "llm" | "telegram" | "wechat" | "http" | "plugin"
  | "config" | "env" | "update" | "upload";

export type Validated<T> =
  | { ok: true; data: T }
  | { ok: false; rejected: true };

export function validateAt<S extends z.ZodType>(
  boundary: Boundary,
  schemaName: string,
  schema: S,
  raw: unknown,               // external data is ALWAYS unknown here
): Validated<z.infer<S>> {
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  // Chapter 3 owns the taxonomy; the shape here is binding:
  // never log the raw payload, only issues + size.
  logBoundaryRejection({
    boundary,
    schema: schemaName,
    issues: result.error.issues,
    raw_size: typeof raw === "string" ? raw.length : JSON.stringify(raw ?? null).length,
  });
  return { ok: false, rejected: true };
}
```

**ESLint enforcement** (flat config excerpt, `eslint.config.mjs`):

```js
export default [
  {
    rules: {
      // R1: ban throwing .parse(); JSON.parse is separately confined below
      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.property.name='parse'][callee.object.name!='JSON']",
        message: "Use .safeParse() via validateAt() — .parse() throws (R1).",
      }],
      // R11: TypeBox is dropped; one schema language only
      "no-restricted-imports": ["error", {
        paths: [
          { name: "typebox", message: "Protocol unified on Zod v4 (R11)." },
          { name: "@sinclair/typebox", message: "Protocol unified on Zod v4 (R11)." },
        ],
      }],
    },
  },
  // R3: transport fences — the pattern; one block per boundary lib
  {
    files: ["src/**"],
    ignores: ["src/boundary/llm/**"],
    rules: {
      "no-restricted-imports": ["error", { paths: [
        { name: "ai", message: "LLM SDK only under src/boundary/llm/ (R3)." },
        { name: "@openrouter/ai-sdk-provider", message: "Only under src/boundary/llm/ (R3)." },
      ]}],
    },
  },
  { // R18: process.env only in env.ts (requires eslint-plugin-n)
    files: ["src/**"], ignores: ["src/boundary/config/env.ts"],
    rules: { "n/no-process-env": "error" },
  },
];
```

(Rare false positives on the `.parse` selector — e.g. `path.parse()` — get a one-line `// eslint-disable-next-line` with justification; `JSON.parse` itself is only called inside boundary modules, wrapped so its output enters `validateAt` as `unknown`.)

**Fastify + Zod v4 route validation** (R11):

```ts
import Fastify from "fastify";
import {
  serializerCompiler, validatorCompiler, type ZodTypeProvider,
} from "fastify-type-provider-zod";        // v7.x — requires zod >= 4.1.5
import { SendCommandBody } from "@weltari/protocol"; // z.strictObject(...)

const app = Fastify({
  logger: { redact: { paths: [
    "req.headers.authorization", "*.apiKey", "*.api_key", "*.token", "*.password",
  ], censor: "[REDACTED]" } },             // R18(3)
}).withTypeProvider<ZodTypeProvider>();

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

app.route({
  method: "POST",
  url: "/v1/commands/send",
  schema: { body: SendCommandBody },        // invalid body -> 400 before handler runs
  handler: async (req) => { /* req.body is typed AND runtime-validated */ },
});
```

**JSON Schema emission for non-JS clients** (R11, replaces TypeBox):

```ts
// packages/protocol/scripts/emit.ts — CI fails if output differs from committed files
import { z } from "zod";
import { SendCommandBody } from "../src/commands.js";
const jsonSchema = z.toJSONSchema(SendCommandBody);  // native in Zod v4
```

**Plugin manifest schema + hash check** (R12):

```ts
export const PluginManifestSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9-]{3,40}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),      // semver, no ranges
  engine: z.string().min(1),                          // engine-version range
  capabilities: z.strictObject({
    skills: z.boolean().default(false),
    themes: z.boolean().default(false),
    components: z.boolean().default(false),
    connectors: z.boolean().default(false),
  }),
  provenance: z.strictObject({
    source_url: z.url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
// Loader: recompute SHA-256 over the plugin archive; mismatch => plugin.rejected
// event, plugin skipped, app boots without it. Checked at install AND every load.
```

**Env schema** (R18):

```ts
// src/boundary/config/env.ts — the ONLY file allowed to read process.env
const EnvSchema = z.strictObject({
  WELTARI_DATA_DIR: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  WECHAT_CLAW_CREDENTIALS: z.string().min(1).optional(),
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
});
const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:", parsed.error.issues.map(i => i.path.join(".")));
  process.exit(1);                          // names only — never values
}
export const env = parsed.data;
```

**Secret scanning in CI** (R18(4)):

```yaml
# .github/workflows/ci.yml (excerpt)
  secrets-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }            # scan full history
      - uses: gitleaks/gitleaks-action@v2   # gitleaks v8.30.x
        env: { GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
```

Local equivalent (also the pre-commit hook): `gitleaks dir . --redact --no-banner` — must exit 0.

**LLM tool double gate** (R7, AI SDK v6):

```ts
import { tool } from "ai";                  // ai@^6 pinned (Fact-check Addendum #1)

const switchArt = tool({
  description: "Switch a present character's displayed art.",
  inputSchema: z.strictObject({             // gate 1: shape (Zod v4)
    character_name: z.string().min(1),
    art_name: z.string().min(1),
  }),
  execute: async (input) => {
    // gate 2: state — Scene Engine checks presence + art-set membership,
    // resolves names to IDs; only then is an engine event committed.
    return sceneEngine.validateAndCommit("switch_art", input);
  },
});
```

## Boundary notes

Deliberately left to other chapters:

- **Error taxonomy, log levels, and the `boundary.rejected` event shape** — Chapter 3 (this chapter binds only reject + log + no-repair and the fields listed in R6).
- **Compiler options and generic lint gates** (`noUncheckedIndexedAccess`, `no-explicit-any`, no-floating-promises, the `as` ban) — the strict-TS chapter; R2 consumes them.
- **The repository fence** (better-sqlite3 confined to `repositories/`) — the data-layer chapter; it is the same `no-restricted-imports` mechanism as R3.
- **Test-suite structure and the kill-harness** — the testing chapter; this chapter contributes fixture requirements (duplicate/oversized/malformed gateway messages, tampered plugin, wrong-signature update, zip-slip archive, hostile prompt-injection string).
- **CLA/licensing hygiene for what may be embedded in `@weltari/protocol`** — repo-governance chapter (note: Zod is MIT, so unifying the MIT protocol package on Zod is license-clean).
- **Frontend rendering of untrusted text** (XSS when displaying gateway/LLM text; custom-element prop passing) — the frontend chapter.

## Open questions for synthesis

1. **TypeBox removal changes a decided stack item.** FINAL Stack Decision items 4/13 name TypeBox for `@weltari/protocol`; the Fact-check Addendum explicitly opened this. Evidence now settles it technically: `fastify-type-provider-zod@7.0.0` fully supports Zod v4 (`peer zod@>=4.1.5`) and Zod v4 has native `z.toJSONSchema()`. I recommend unifying on Zod v4 (R11); synthesis must confirm this supersedes the TypeBox lines in the stack table, or the guide and stack doc will contradict.
2. **WeChat "official claw bots" vs. NAT-first is unverified.** The Owner Decisions file itself defers verification ("to verify at the gateway milestone: the concrete claw-bot API/library, and that it works outbound-only"). R9/R10 are written connector-shaped so they survive whatever the concrete API is, but synthesis should carry the verification flag forward — and note the 24h-pause figure is taken from the owner's statement, not re-verified against WeChat platform docs.
3. **Rev 4 conflict (minor):** Rev 4 §13 says "webhook ingestion is deduplicated" for the gateway; files 1–5 mandate NAT-first *polling* (no webhooks). The dedup requirement carries over unchanged (R9); the word "webhook" in Rev 4 does not.
4. **In-process plugins vs. validation honesty (R13):** V1 runs plugin backends in-process with no sandbox, and Rev 4 §18 defers permission *enforcement*. If synthesis wants a stronger promise ("plugins can't read your API keys"), that is a stack change (worker isolation), not a validation rule — someone must decide the documented security claim matches R13's honest wording.
5. **`.parse` lint selector collateral:** the R1 ESLint selector also catches non-Zod `.parse()` methods (e.g. `path.parse`). I chose blanket-ban + justified inline disables over a custom lint rule; synthesis may prefer commissioning a small custom rule in the tooling chapter.
6. **Owner mandate overlap:** the Owner Decisions "no `any`/`as`" mandate spans this chapter and the strict-TS chapter; I placed the enforcement config there (R2). Synthesis should verify that chapter actually ships those rules, or R2 dangles.
