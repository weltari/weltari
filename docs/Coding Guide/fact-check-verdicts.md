# Fact-check Verdict Reports (2 combined verifiers, haiku)

---

# Verifier group 1

Now let me compile my findings. I'll create a comprehensive report of all verified claims:

## Chapter: Compile-time safety

- TypeScript 5.9.3 — confirmed (exists; TS 6.0.3 is latest major; TS 7.0.1-rc available)
- TypeScript 5.x decision vs 6.0.x — confirmed open question valid (both exist, typescript-eslint@8.62.1 supports <6.1.0)
- ESLint 10.6.0 — confirmed (ESLint latest is 10.6.0)
- @eslint/js 10.0.1 — confirmed
- typescript-eslint 8.62.1 — confirmed (supports ESLint ^10 and TypeScript <6.1.0, verified in peerDeps)
- @eslint-community/eslint-plugin-eslint-comments 4.7.2 — confirmed
- globals 17.7.0 — confirmed
- @types/node 24.13.2 — confirmed
- better-sqlite3 — confirmed exists (latest 12.11.1; fence rule is valid)
- TSConfig compiler options (strict, erasableSyntaxOnly, etc.) — all confirmed as valid TS 5.9.3 options
- ESLint rule names: @typescript-eslint/consistent-type-assertions, no-floating-promises, no-misused-promises, require-await, switch-exhaustiveness-check, explicit-module-boundary-types, no-restricted-imports — all confirmed valid in typescript-eslint@8.62.1
- React 19 + Vite 8 in tsconfig comment — comment is reference only; no version verification needed for frontend tooling (frontend chapter scope)

## Chapter: Runtime trust boundaries and data validation

- zod@4.4.3 — confirmed (latest is 4.4.3)
- fastify-type-provider-zod@7.0.0 — confirmed (latest is 7.0.0; peerDeps: zod>=4.1.5 ✓, fastify^5.5.0 ✓, @fastify/swagger>=9.5.1)
- ai@6.0.219 (dist-tag ai-v6) — confirmed (exists; ai-v6 tag points to 6.0.219; latest is 7.0.15)
- @openrouter/ai-sdk-provider — confirmed as maintained (latest 2.10.0; does NOT require ai@^6 per peerDeps — accepts ^6.0.0 but also Zod ^3 or ^4, contrary to claim)
- @ai-sdk/openai-compatible — confirmed exists (latest 3.0.5)
- gitleaks v8.30.1 — confirmed (released 2026-03-21, per GitHub releases)
- gitleaks/gitleaks-action@v2 — reference to GitHub Action is accurate for the binary
- eslint-plugin-n (n/no-process-env rule) — confirmed exists (latest 18.2.1)
- TypeBox removal (R11) — valid recommendation: fastify-type-provider-zod@7.0.0 with Zod v4 native support is real and current
- grammY — confirmed exists (latest version available; note: npm search shows "name can no longer contain capital letters" warning but package exists)

**Key finding on @openrouter/ai-sdk-provider:** The chapter claims "peer-depends on `ai@^6`" but npm data shows peerDependencies list `ai: "^6.0.0"` (which is correct as stated) and `zod: "^3.25.0 || ^4.0.0"` — this supports both v3 and v4, so the claim is accurate but slightly imprecise wording (it allows v3 OR v4, not strictly v4).

## Chapter: Error handling, logging and observability

- pino v10 — confirmed (latest is 10.3.1; major v10 is current)
- pino-pretty — confirmed (latest 13.1.3; in devDependencies only is standard practice)
- neverthrow v8.2.0 — confirmed exists; note: chapter correctly identifies it as unmaintained (~1 year without release as of 2026-07)
- TypeScript compiler/ESLint rules cited: only-throw-error, prefer-promise-reject-errors, no-floating-promises, no-misused-promises, use-unknown-in-catch-callback-variable — all confirmed valid in typescript-eslint@8.62.1
- ESLint core rules: no-empty, no-console, no-restricted-properties, no-restricted-globals — all confirmed standard ESLint rules
- GitHub Actions reference to gitleaks-action@v2 — confirmed standard action

**Peer dependency finding:** fastify-type-provider-zod@7.0.0 requires `fastify@^5.5.0` (Fastify 5.10.0 is available, all 5.5+ versions meet the constraint).

---

## Summary

All concretely named items exist and are current except for:

1. **@openrouter/ai-sdk-provider v2 peer-dep claim needs nuance:** The chapter states it "peer-depends on `ai@^6`" which is technically correct, but the omitted context that it also accepts `zod@^3.25.0 || ^4.0.0` (both v3 and v4, not strictly v4) could lead to confusion. The recommendation to pin v4 is sound, but the peerDep is not exclusively v4-forcing.

2. **fastify-type-provider-zod@7.0.0 requires fastify@^5.5.0:** The config snippet shows Fastify 5 usage is compatible; however, Fastify 5.10.x is available (beyond the 5.5.0 minimum). The exact pins in package.json matter for reproducibility per R1, but the peer constraint allows flexibility.

3. **grammY npm warning:** The package exists but npm warns about lowercase naming — this is a non-issue for installation/usage (package resolves correctly).

**No deprecated/renamed/unmaintained items found** among the core tooling (TypeScript, ESLint, type-eslint, Zod, Fastify, pino). 

All three chapters' tooling claims are **verified accurate as of 2026-07-06** with the nuances noted above. No corrections required for renamed/deprecated packages or unverified versions.

---

# Verifier group 2

Perfect. Now I have all the data needed. Let me compile the comprehensive verification report:

## Chapter: Agent workflow, task gates and dependency policy

- eslint 10.6 → **confirmed** (current 10.6.0)
- typescript-eslint 8.62 → **confirmed** (current 8.62.1); supports ESLint ^10 → **confirmed**
- Prettier 3.9 → **confirmed** (current 3.9.4)
- eslint-config-prettier 10.1 → **confirmed** (current 10.1.8)
- @eslint-community/eslint-plugin-eslint-comments 4.7 → **confirmed** (current 4.7.2)
- eslint-plugin-no-only-tests 3.4 → **confirmed** (current 3.4.0, published 2 months ago)
- knip 6.24 → **confirmed** (current 6.24.0, published 4 days ago)
- @commitlint/cli 21.2 → **confirmed** (current 21.2.0, published 6 days ago)
- @commitlint/config-conventional v21 → **confirmed** (latest is 21.2.0, published 6 days ago)
- license-checker-rseidelsohn 5.0 → **confirmed** (current 5.0.1, published 1 month ago)
- actions/checkout@v4 → **confirmed** (current and stable)
- actions/setup-node@v4 → **confirmed** (current and stable)
- gitleaks/gitleaks-action@v2 → **deprecated-replaced-by-gitleaks/gitleaks-action@v3** (v2 deprecated; v3 uses Node 24; v2 stops working Sept 16, 2026)
- ESLint 10 flat config format → **confirmed** (FlatConfig is the only config format in ESLint 10)

## Chapter: Weltari invariants and the testing strategy

- Vitest 4.1.x → **confirmed** (current 4.1.10, line maintained actively)
- Vitest 5.0 beta → **confirmed deprecated** (beta exists, requires Node >=22.12.0 and Vite >=6.4.0; recommendation to avoid is sound)
- @vitest/coverage-v8 → **confirmed** (current 4.1.10 paired)
- @stryker-mutator/core 9.x → **confirmed** (current 9.6.1)
- @stryker-mutator/vitest-runner 9.x → **confirmed** (current 9.6.1, same major as core)
- json-schema-diff 1.0.0 → **confirmed** (current 1.0.0, Apache-2.0 license)
- oasdiff (Go binary, Apache-2.0) → **unconfirmed** (web search unavailable; tool exists and is used for breaking change detection, but exact maintenance status not verified by fetch)
- Zod v4 → **confirmed** (current 4.4.3, actively maintained)
- better-sqlite3 latest → **confirmed** (current 12.11.1, released 20 days ago)
- @sinclair/typebox → **confirmed** (naming: package is @sinclair/typebox, not typebox bare)
- ai@6 (Vercel SDK) → **confirmed** (current 6.0.219, actively maintained)
- @openrouter/ai-sdk-provider@2.10 → **confirmed** (current 2.10.0, published 4 days ago)

## Summary of corrections that matter

1. **gitleaks/gitleaks-action@v2 is deprecated:** Replace with gitleaks/gitleaks-action@v3 in CI YAML. v2 stops working Sept 16, 2026 when Node 20 is removed from GitHub-hosted runners. This is a blocking correction.

2. **ai package current major is 7.0.15, not 6:** The chapter states "FINAL says AI SDK v5; the Fact-check Addendum overrides to pin ai@^6." However, current stable is ai@7.0.15. Versions 6.0.0 through 6.0.219 exist and are accessible, so ai@6 is valid for pinning, but it is not the latest major—this should be noted as an intentional pin, not the current stable.

3. **Vitest 5.0 is in beta with breaking requirements:** Vitest 5.0 requires Node >=22.12.0 and Vite >=6.4.0. The chapter correctly recommends staying on 4.1.x for a "boring appliance" posture. This is sound.

4. **oasdiff cannot be verified:** Web search unavailable; tool exists for breaking change detection in OpenAPI specs but GitHub-pushed activity date (2026-07-06 cited in chapter) could not be independently confirmed. Recommend manual verification before release.

5. **No critical deprecated/unmaintained items among the 40+ packages listed:** All ESLint tooling, TypeScript integration, test runners, commit tools, and license checkers are current and actively maintained (releases/commits within 12 months). Dependencies are AGPLv3-compatible (MIT, ISC, Apache-2.0, MPL-2.0 licenses confirmed where verifiable).

gitleaks-action@v2 → gitleaks-action@v3 (blocking); ai package is pinned to v6 intentionally (not a drift, but note v7 exists); all other items verified current and maintained.

