# Fact-check Addendum — Context7 + web verification (2026-07-06)

Second-pass verification of the final stack's load-bearing libraries, run after `FINAL - Stack Decision.md` at the owner's request. Two agents (backend / frontend), Context7 for API-and-version facts, web + npm registry for maintenance and licenses.

**Overall verdict: the stack survives intact. No choice is overturned. Three corrections change version pins or package names; the rest are caveats to design around.**

## Corrections that matter

1. **AI SDK: pin v6, not v5 (and not v7 yet).** The `ai` package's current major is **7.0.x, released ~2026-07-04** — days old. The mature previous major is **v6 (6.0.219)**. Critically, the stable `@openrouter/ai-sdk-provider` (2.10.0) peer-depends on `ai@^6.0.0` and does not yet support v7. **Decision: pin `ai@^6` + `@openrouter/ai-sdk-provider@^2.10` for the Week-1 skeleton; re-evaluate v7 once the OpenRouter provider catches up.** (Escape hatch if v7 is ever needed early: `@ai-sdk/openai-compatible@3.x` tracks v7 and works against OpenRouter's OpenAI-compatible endpoint.)
2. **TypeBox package name / possible Zod-v4 unification.** The current TypeBox 1.x line lives under the npm name **`typebox`** (1.3.3); `@sinclair/typebox` is the 0.34.x LTS line — and Fastify's `@fastify/type-provider-typebox` integrates with the latter. Separately, **Zod v4 natively exports JSON Schema**, and the owner has mandated Zod v4 `safeParse` at all trust boundaries anyway. **Open item for Week 1: consider unifying the protocol package on Zod v4** (schemas defined once in Zod, JSON Schema emitted for OpenAPI 3.1 / AsyncAPI 3.1 and non-JS clients) instead of running Zod + TypeBox side by side; verify `fastify-type-provider-zod` supports Zod v4 before committing.
3. **Wechaty *core* is also effectively unmaintained** — zero npm releases since May 2022 (sporadic repo commits only), not just the wechat4u puppet (stale since early 2024). This strengthens, not changes, the decided posture: the whole WeChat path lives in the isolated **experimental-labeled** connector plugin; a breakage never touches the core.

## Caveats to design around (no decision changes)

- **iOS push:** Web Push on iPhone/iPad works only for **home-screen-installed** web apps (iOS 16.4+, manifest `display: standalone`, permission from a user gesture) — document "Add to Home Screen" in the notifications setup page.
- **web-push staleness:** ~2.5 years since release (protocol is a frozen IETF standard, so low risk). Maintained swap now identified: **`@pushforge/builder`** (MIT, active 2026). Keep `web-push` pinned; document the swap.
- **`@grammyjs/runner`** confirmed stale and unnecessary — already dropped; `bot.start()` built-in polling confirmed.
- **AsyncAPI:** target **3.1** (current minor) in tooling.
- **Custom-element plugin boundary — real gotchas for the plugin SDK docs:**
  - React 19 sets a JSX prop as a *property* only if it already exists on the element instance — plugin elements must declare properties in the class (else objects arrive as `"[object Object]"` attributes).
  - `customElements.define()` is one-shot per tag name — **namespace tags per plugin (+ version)**; two plugins can't claim `<wl-map>` simultaneously, so the loader must own tag assignment.
  - Gate on `customElements.whenDefined()` before passing props at mount.
  - Each tag needs a TypeScript `IntrinsicElements` augmentation for type-checked use in core code.
  - No SSR of plugin elements (irrelevant for the pure-client Vite app; noted for the record).
- **Canvas 2D sanity check passed:** OpenLayers defaults to Canvas 2D, Excalidraw and Owlbear Rodeo are Canvas 2D; WebGL only pays off at thousands of animated sprites. A pannable tile/fog map with lasso is comfortably in range.
- **Version-number hygiene for the guide:** `sharp` (0.35.x) and `@sinclair/typebox` (0.34.x) are healthy projects that simply never left 0.x — "0.x" is not a staleness signal by itself.

## Confirmed as claimed (no notes needed)

better-sqlite3 12.x (Node 24 prebuilds since 12.0.0) · Fastify 5.10 (per-route Ajv validation core; `@fastify/static` for static files; SSE via `reply.raw`) · grammY 1.44 · croner 10 · sharp (all-platform prebuilds incl. win32-arm64) · React 19.2 (custom-element interop officially documented, passes Custom Elements Everywhere) · Vite 8 (Rolldown; Node 20.19+/22.12+) · zustand 5 · Zod 4.4 (plain `import "zod"` gives v4; large parse-speed gains) · minisign (ISC, active; npm `minisign` package exists for in-app verify) · Tailscale Serve / Cloudflare Tunnel as genuine one-command HTTPS.
