# Fact-check Verdicts (Phase 1.5)

One verifier per proposal (haiku, web-search). Facts only, no re-arguing of choices.

---

## Proposal 1 — Token-economy & hot-path latency

Now I have comprehensive information. Let me compile my findings into a markdown verdict list:

## Verification Results

| # | Package | Name Status | Maintenance | License Status | Verdict |
|---|---|---|---|---|---|
| 1 | Node.js v24 LTS | ✓ Confirmed | Actively maintained (LTS) | No license issue | **confirmed** |
| 2 | TypeScript 5.x | ✓ Confirmed | Actively maintained | MIT compatible | **confirmed** |
| 3 | Fastify 5 | ✓ Confirmed | Actively maintained (v5.9.0 as of 2026) | MIT ✓ | **confirmed** |
| 4 | better-sqlite3 | ✓ Confirmed | Actively maintained (v12.11.1, last update 15 days ago) | MIT ✓ | **confirmed** |
| 5 | croner | ✓ Confirmed | Actively maintained (v10.0.1, ~4 months ago) | MIT ✓ | **confirmed** |
| 6 | Svelte 5 | ✓ Confirmed | Actively maintained (v5.53.0 as of early 2026) | MIT ✓ | **confirmed** |
| 7 | Vite 6 | ✓ Confirmed | Actively maintained (security patches backported to 6.4) | MIT ✓ | **confirmed** |
| 8 | PixiJS v8 | ✓ Confirmed | Actively maintained (v8.19.0 as of June 2026) | MIT ✓ | **confirmed** |
| 9 | sharp | ✓ Confirmed | Actively maintained (v0.35.3, 53M weekly downloads) | Apache 2.0 ⚠️ | **license-conflict** (Apache 2.0 incompatible with AGPLv3 core) |
| 10 | Vercel AI SDK v5 (`ai`) | ✓ Confirmed | Actively maintained (latest release July 2026) | Apache 2.0 ⚠️ | **license-conflict** (Apache 2.0 incompatible with AGPLv3 core) |
| 11 | @ai-sdk/openai-compatible | ✓ Confirmed | Actively maintained (v3.0.5, last update 13 hours ago) | Apache 2.0 ⚠️ | **license-conflict** (Apache 2.0 incompatible with AGPLv3 core) |
| 12 | @openrouter/ai-sdk-provider v2.10 | ✓ Confirmed | Actively maintained (v2.10.0, last update 4 days ago) | Apache 2.0 ⚠️ | **license-conflict** (Apache 2.0 incompatible with AGPLv3 core) |
| 13 | grammY | ✓ Confirmed | Actively maintained (v1.44.0, last update 14 days ago) | MIT ✓ | **confirmed** |
| 14 | @grammyjs/runner | ✓ Confirmed | ⚠️ Unmaintained (v2.0.3, last update ~2 years ago, single maintainer) | MIT ✓ | **unmaintained** |
| 15 | wechaty | ✓ Confirmed | Actively maintained (community-driven) | Apache 2.0 ⚠️ | **license-conflict** (Apache 2.0 incompatible with AGPLv3 core) |
| 16 | wechaty-puppet-wechat4u | ✓ Confirmed | ❌ Unmaintained (v1.14.14, last update 2 years ago; known bans/blocking) | Unclear | **unmaintained** + functional concerns |
| 17 | web-push | ✓ Confirmed | ⚠️ Stale (v3.6.7, last update 2 years ago) | MPL-2.0 ⚠️ | **unmaintained** + **license-conflict** (MPL-2.0 incompatible with AGPLv3 core) |
| 18 | TypeBox (@sinclair/typebox) | ✓ Confirmed | Actively maintained (v1.x active line) | MIT ✓ | **confirmed** |

## Summary

**License conflicts requiring review:**
- **sharp** (Apache 2.0) — used for image processing in painter jobs
- **Vercel AI SDK + providers** (Apache 2.0) — entire LLM integration layer (ai, @ai-sdk/openai-compatible, @openrouter/ai-sdk-provider)
- **wechaty** (Apache 2.0) — WeChat gateway connector
- **web-push** (MPL-2.0) — browser push notifications

**Maintenance concerns:**
- **@grammyjs/runner** (v2.0.3, 2-year-old) — Telegram polling concurrency; stable but inert
- **wechaty-puppet-wechat4u** (v1.14.14, 2-year-old) — Known account bans, login failures post-2017 accounts; design isolates risk but core concern is real
- **web-push** (v3.6.7, 2-year-old) — push notification library; alternative `node-webpush` exists with Apache 2.0 (March 2026)

---

## Proposal 2 — Plugin ecosystem & community adoption

Now let me compile the verdict list based on all the verification I've done.

## Verdict Summary

Based on comprehensive web search verification, here is the per-item verdict:

| # | Item | Verdict | Details |
|---|---|---|---|
| 1 | TypeScript 5.x on Node.js 24 LTS | **confirmed** | Node.js 24 is confirmed LTS (maintenance through 2028); TypeScript 5.x is actively maintained |
| 2 | Fastify 5.x | **confirmed** | Latest 5.10.0 published recently; MIT licensed; actively maintained |
| 3 | Custom Scene-Engine loop | **confirmed** | No external package; custom implementation |
| 4 | SSE + POST with TypeBox + OpenAPI 3.1/AsyncAPI 3 | **confirmed** | TypeBox 0.34.49 (MIT) published March 2026; transport/protocol are custom |
| 5 | Lit 3 + Vite 7 | **wrong-name-corrected-to-Vite 8** | Lit 3 confirmed; Vite 7 is now EOL — latest is 8.1.3 (published 4 days ago, July 2026); MIT licensed |
| 6 | Leaflet 1.9.x + leaflet.markercluster + Leaflet-Geoman | **wrong-name-corrected-to-Leaflet 1.9.4-latest + leaflet.markercluster 1.5.3-unmaintained + @geoman-io/leaflet-geoman-free 2.20.0** | Leaflet 1.9.4 (3 years old, maintenance-mode, BSD-2-Clause); leaflet.markercluster 1.5.3 last published 5 years ago (unmaintained); @geoman-io/leaflet-geoman-free 2.20.0 (June 2026, MIT) |
| 7 | better-sqlite3 v12 | **confirmed** | v12.11.1 (published 20 days ago); MIT licensed; actively maintained |
| 8 | croner for wall-clock CRON | **confirmed** | 10.0.1 published 4 months ago; MIT licensed; zero dependencies; actively maintained |
| 9 | grammY 1.x long-polling | **confirmed** | v1.44+ (published 3 weeks ago); MIT licensed; actively maintained |
| 10 | wechaty + wechaty-puppet-wechat4u | **license-conflict-Apache2.0** | wechaty (Apache-2.0) is compatible; wechaty-puppet-wechat4u 1.14.14 last published 2 years ago — **unmaintained + medium-risk** — known WeChat account bans, no solutions documented, Web API broken since 2018 |
| 11 | sharp 0.34 | **confirmed** | 0.34.x branch actively maintained; Apache-2.0 licensed; prebuilt Windows binaries available |
| 12 | Vercel AI SDK v5 + @openrouter/ai-sdk-provider | **confirmed** | ai (core) v7.0.15 (Apache-2.0); @openrouter/ai-sdk-provider 2.10.0 published 4 days ago; Apache-2.0 compatible |
| 13 | @ai-sdk/openai-compatible | **confirmed** | Part of Vercel AI SDK; Apache-2.0 licensed; actively maintained |
| 14 | web-push with VAPID | **license-conflict-MPL-2.0** | web-push 3.6.7 is licensed MPL-2.0, not MIT — **license incompatible with AGPLv3 core** (copyleft conflict); last published 2 years ago (outdated) |
| 15 | Docker + multi-arch image + GitHub Actions | **confirmed** | Standard tooling; version pinning via .nvmrc/engines confirmed viable |
| 16 | Plugin format (folder + plugin.json + MIT SDK) | **confirmed** | Custom schema; no conflicting packages |

---

## License Compatibility Issues

1. **web-push (item 14)**: MPL-2.0 license is problematic for AGPLv3 core. MPL-2.0 and AGPL are incompatible — they have conflicting copyleft triggers (file-level vs. full-project). **Recommendation:** Switch to a Web Push alternative with MIT/Apache-2.0 (e.g., implement VAPID manually, or use a wrapper with compatible license).

2. **wechaty-puppet-wechat4u (item 10)**: Apache-2.0 is compatible with AGPLv3; however, the package is **unmaintained (2 years since last release)** and has documented breaking issues (account bans, no known fix). The proposal already acknowledges this risk. **Recommendation:** If shipping, document the breakage risk and make the connector swappable per the plugin architecture (item 13).

3. **leaflet.markercluster (item 6)**: MIT licensed (compatible), but **unmaintained (5 years since last release)**. Leaflet 1.9.x itself is in maintenance mode. Core Leaflet (1.9.4) has MIT license. Alternatives (react-leaflet-cluster 4.1.3, actively maintained) exist if React support is acceptable, but proposal uses Lit. **Recommendation:** Accept maintenance risk or implement clustering inline.

4. All other packages are confirmed MIT, Apache-2.0, or BSD-2-Clause — all compatible with AGPLv3 core + MIT edges.

---

## Verdict List (Markdown)

- **Fastify 5.x**: confirmed
- **better-sqlite3 v12**: confirmed
- **Lit 3**: confirmed
- **Vite 7**: wrong-name-corrected-to-Vite-8.1.3
- **TypeBox @sinclair/typebox**: confirmed
- **Leaflet 1.9.x**: confirmed
- **leaflet.markercluster**: unmaintained
- **Leaflet-Geoman**: wrong-name-corrected-to-@geoman-io/leaflet-geoman-free-2.20.0
- **grammY 1.x**: confirmed
- **wechaty**: confirmed
- **wechaty-puppet-wechat4u**: unmaintained
- **sharp 0.34**: confirmed
- **croner**: confirmed
- **Vercel AI SDK v5 (ai)**: confirmed
- **@openrouter/ai-sdk-provider**: confirmed
- **@ai-sdk/openai-compatible**: confirmed
- **web-push**: license-conflict (MPL-2.0 incompatible with AGPLv3)
- **Node.js 24 LTS**: confirmed
- **Docker/multi-arch**: confirmed
- **Custom plugin SDK (MIT)**: confirmed

---

## Proposal 3 — Ops, distribution & crash-safety

Now let me compile the final verification list based on all my searches. Let me organize the findings:

## Verification Summary

Based on systematic web searches, here is the per-item verdict list for the Weltari V1 Stack Proposal:

| # | Item | Package Name | Verdict | Notes |
|---|------|--------------|---------|-------|
| 1 | Bun runtime | Bun v1.3.14+ | **confirmed** | Actively maintained (May 2026 release), MIT licensed, enterprise-backed by Anthropic |
| 2 | TypeScript 5.x | typescript | **confirmed** | Latest 5.x versions available, MIT licensed, actively maintained |
| 3 | Hono 4.x | hono v4.12.27 | **confirmed** | Latest v4.12.27 published 3 days ago, MIT licensed, zero dependencies |
| 4 | React 19 | react v19.2.7 | **confirmed** | Latest v19.2.7 published June 2026, MIT licensed, actively maintained |
| 5 | Vite 6 | vite | **wrong-name-corrected-to: vite@8.1.3** | Vite has progressed to v8.1.3 (latest); v6 is obsolete. MIT licensed |
| 6 | Vercel AI SDK v5 | ai v5→v6 | **confirmed-with-caveat** | v5 exists but development focus shifted to v6. Latest is v6, both MIT licensed. Consider upgrading to v6 |
| 7 | @openrouter/ai-sdk-provider | @openrouter/ai-sdk-provider v2.10.0 | **confirmed** | Latest v2.10.0 published 4 days ago, maintained by OpenRouter, compatible with AI SDK |
| 8 | @ai-sdk/openai-compatible | @ai-sdk/openai-compatible | **confirmed** | Part of Vercel AI SDK ecosystem, actively maintained, MIT licensed |
| 9 | Sharp | sharp v0.34+ | **confirmed-license-alert** | Latest v0.34+, actively maintained. **LICENSE: Apache 2.0** (not MIT) — compatible with AGPL core but flag for audit |
| 10 | Croner | croner v10.0.1+ | **confirmed** | Latest v10.0.1, MIT licensed, zero dependencies, actively maintained by Hexagon |
| 11 | grammY | grammY (latest) | **confirmed** | Actively maintained, long-polling supported. Runs natively on Bun/Node/Deno. MIT licensed (inferred from search context) |
| 12 | Wechaty | wechaty | **confirmed-license-alert** | Core maintained, puppets (including PadLocal) volatile. **LICENSE: Apache 2.0** — compatible but volatile |
| 13 | wechaty-puppet-padlocal | wechaty-puppet-padlocal v1.20.1 | **unmaintained** | Last npm release June 2022 (3 years ago); documentation updated Dec 2025 but no recent binary updates. **High risk** |
| 14 | web-push | web-push (latest) | **confirmed-license-ambiguous** | Actively maintained. **LICENSE: Unclear from search; sister projects in web-push-libs use MIT** — recommend verifying directly on GitHub |
| 15 | Motion (formerly framer-motion) | motion (v12.42.2) | **confirmed** | Latest v12.42.2, MIT licensed, maintained by Motion Division, React 19 compatible |
| 16 | AsyncAPI 3.0 | asyncapi/spec v3.1.0 | **confirmed** | Latest v3.1.0 available, Apache 2.0 licensed, actively maintained by Linux Foundation |
| 17 | minisign | minisign v0.12 | **confirmed** | Latest v0.12 (March 2026), standalone CLI tool, Ed25519 cryptography, no npm package (system binary) |

## License Compatibility Summary

**AGPL-compatible (core) + MIT-compatible (edges):**
- ✅ Bun (MIT)
- ✅ TypeScript (MIT)
- ✅ Hono (MIT)
- ✅ React (MIT)
- ✅ Vite (MIT)
- ✅ Vercel AI SDK (MIT)
- ✅ OpenRouter provider (inferred compatible)
- ✅ @ai-sdk/openai-compatible (MIT)
- ✅ Croner (MIT)
- ✅ Motion (MIT)
- ⚠️ Sharp (Apache 2.0 — compatible with AGPL but NOT MIT; flag for license audit)
- ⚠️ Wechaty (Apache 2.0 — compatible with AGPL but NOT MIT; flag for license audit)
- ⚠️ web-push (license needs verification; sister packages use MIT)
- ⚠️ AsyncAPI 3.0 (Apache 2.0 — compatible with AGPL but used for protocol docs, not linked)
- ⚠️ grammY (license inference needed; search assumed MIT from context)

## Critical Risks

1. **wechaty-puppet-padlocal: UNMAINTAINED** — Last release 3 years ago. Proposal notes "puppets are ToS-fragile by nature" and acknowledges volatility, but 3-year staleness is severe. Recommend forking or selecting a newer puppet provider before prototype.
2. **Sharp & Wechaty: Apache 2.0 license** — Both are compatible with AGPLv3 core + MIT edges per AGPL rules, but introduce a secondary license family. If strict "MIT-only edges" is required, both must be reviewed by legal.
3. **web-push: License ambiguity** — Direct verification from GitHub repo recommended before release.

---

## Final Verdict List (Markdown format for scripting)

```markdown
# Weltari V1 Stack Fact-Check Results

## Confirmed Packages
- Bun 1.3.14+ — confirmed
- TypeScript 5.x — confirmed
- Hono 4.12.27 — confirmed
- React 19.2.7 — confirmed
- Croner 10.0.1+ — confirmed
- grammY (latest) — confirmed
- Motion 12.42.2 — confirmed
- minisign 0.12 — confirmed
- Vercel AI SDK v5 — confirmed (v6 now primary; consider upgrade)
- @openrouter/ai-sdk-provider 2.10.0 — confirmed
- @ai-sdk/openai-compatible — confirmed
- AsyncAPI 3.0/3.1.0 — confirmed

## Version/Name Corrections
- Vite 6 → **Vite 8.1.3** (latest; v6 obsolete)

## Unmaintained / High Risk
- wechaty-puppet-padlocal v1.20.1 — **unmaintained** (last release June 2022; 3-year stale)

## License Alerts (Non-MIT)
- Sharp 0.34+ — Apache 2.0 (not MIT; AGPL-compatible but requires audit)
- Wechaty — Apache 2.0 (not MIT; AGPL-compatible but requires audit)
- web-push — **license requires verification** from GitHub repo
- AsyncAPI 3.0 — Apache 2.0 (spec doc; not a linked dependency, acceptable)

## Summary
- 12 packages confirmed and actively maintained
- 1 version correction (Vite)
- 1 package unmaintained (wechaty-puppet-padlocal)
- 4 license considerations (mostly Apache 2.0, AGPL-compatible)
```

Sources:
- [Bun Runtime](https://bun.com/)
- [Hono npm](https://www.npmjs.com/package/hono)
- [Hono GitHub](https://github.com/honojs/hono)
- [Vercel AI SDK](https://ai-sdk.dev)
- [AI SDK GitHub](https://github.com/vercel/ai)
- [OpenRouter AI SDK Provider npm](https://www.npmjs.com/package/@openrouter/ai-sdk-provider)
- [OpenRouter AI SDK Provider GitHub](https://github.com/OpenRouterTeam/ai-sdk-provider)
- [Sharp npm](https://www.npmjs.com/package/sharp)
- [Sharp GitHub](https://github.com/lovell/sharp)
- [grammY GitHub](https://github.com/grammyjs/grammy)
- [Wechaty GitHub](https://github.com/wechaty/wechaty)
- [wechaty-puppet-padlocal npm](https://www.npmjs.com/package/wechaty-puppet-padlocal)
- [Croner GitHub](https://github.com/Hexagon/croner)
- [Croner npm](https://www.npmjs.com/package/croner)
- [React GitHub](https://github.com/facebook/react)
- [React npm](https://www.npmjs.com/package/react)
- [Vite npm](https://www.npmjs.com/package/vite)
- [Vite GitHub](https://github.com/vitejs/vite)
- [Motion GitHub](https://github.com/motiondivision/motion)
- [Motion npm](https://www.npmjs.com/package/motion)
- [web-push GitHub](https://github.com/web-push-libs/web-push)
- [web-push npm](https://www.npmjs.com/package/web-push)
- [web-push-libs GitHub](https://github.com/web-push-libs)
- [AsyncAPI Specification](https://www.asyncapi.com/docs/reference/specification/v3.0.0)
- [AsyncAPI GitHub](https://github.com/asyncapi/spec)
- [minisign GitHub](https://github.com/jedisct1/minisign)
- [Minisign Official](https://jedisct1.github.io/minisign/)
- [@ai-sdk/openai-compatible npm](https://www.npmjs.com/package/@ai-sdk/openai-compatible)

---

## Proposal 4 — Solo-owner maintainability

Perfect. Now let me compile the final verdict list. Based on my research:

**Verified package status:**
1. **Node.js 22 LTS** - Confirmed (Active maintenance until April 2027)
2. **TypeScript 5.x** - Confirmed (Latest 6.x, but 5.x actively maintained)
3. **Fastify 5.x** - Confirmed (Latest 5.10.0, actively maintained)
4. **@sinclair/typebox** - Confirmed (Actively maintained)
5. **Vite 7** - **Wrong-name-corrected-to-Vite 8** (Vite 7.3.3 released May 2026 but Vite 8.1.3 is current)
6. **React 19** - Confirmed (Actively maintained)
7. **zustand** - Confirmed (v5.0.14, actively maintained)
8. **better-sqlite3 v12** - Confirmed (Actively maintained)
9. **Drizzle ORM** - Confirmed (v0.45.2, actively maintained)
10. **croner** - Confirmed (Actively maintained)
11. **Vercel AI SDK v5** - Confirmed (Actively maintained, v6 also available)
12. **@openrouter/ai-sdk-provider** - Confirmed (v2.10.0, actively maintained)
13. **@ai-sdk/openai-compatible** - Confirmed (Part of Vercel AI SDK)
14. **sharp v0.34** - Confirmed (v0.34.5 released Nov 2025)
15. **grammY** - Confirmed (Actively maintained)
16. **wechaty** - Confirmed (Actively maintained)
17. **wechaty-puppet-wechat4u** - **Unmaintained** (Last release 2 years ago, Jan 2024)
18. **web-push** - Confirmed (Actively maintained)
19. **esbuild** - Confirmed (Actively maintained)
20. **drizzle-kit** - Confirmed (Part of Drizzle ORM ecosystem)

**License compatibility (AGPLv3 core + MIT edges):**
- TypeScript: Apache 2.0 ✓ Compatible
- Fastify: MIT ✓ Compatible
- @sinclair/typebox: MIT ✓ Compatible
- React: MIT ✓ Compatible
- zustand: MIT ✓ Compatible
- better-sqlite3: MIT ✓ Compatible
- Drizzle ORM: Apache 2.0 ✓ Compatible
- croner: MIT ✓ Compatible
- Vercel AI SDK: Apache 2.0 ✓ Compatible
- @openrouter/ai-sdk-provider: Apache 2.0 ✓ Compatible
- @ai-sdk/openai-compatible: Apache 2.0 ✓ Compatible
- sharp: Apache 2.0 ✓ Compatible
- grammY: MIT ✓ Compatible
- wechaty: Apache 2.0 ✓ Compatible
- wechaty-puppet-wechat4u: Apache 2.0 ✓ Compatible
- web-push: MIT ✓ Compatible
- esbuild: MIT ✓ Compatible
- Vite: MIT ✓ Compatible
- drizzle-kit: Apache 2.0 ✓ Compatible

---

## Verdict List

- **Node.js 22 LTS** — confirmed
- **TypeScript 5.x** — confirmed
- **Fastify 5.x** — confirmed
- **@sinclair/typebox** — confirmed
- **Vite 7** — wrong-name-corrected-to-Vite 8 (latest is 8.1.3; v7 entered maintenance May 2026)
- **React 19** — confirmed
- **zustand** — confirmed
- **better-sqlite3 v12** — confirmed
- **Drizzle ORM** — confirmed
- **drizzle-kit** — confirmed
- **croner** — confirmed
- **Vercel AI SDK v5** — confirmed
- **@openrouter/ai-sdk-provider** — confirmed
- **@ai-sdk/openai-compatible** — confirmed
- **sharp v0.34** — confirmed
- **grammY** — confirmed
- **wechaty** — confirmed
- **wechaty-puppet-wechat4u** — unmaintained (last release January 2024, two years ago)
- **web-push** — confirmed
- **esbuild** — confirmed

**License compatibility:** All packages are compatible with AGPLv3 core + MIT-licensed edges. Apache 2.0 and MIT are mutually compatible for this constraint. No GPL-incompatible or no-license dependencies found.

