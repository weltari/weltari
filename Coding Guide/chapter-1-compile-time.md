# Chapter 2: Compile-time safety

*Scope: make bad code fail before it runs. Every rule here is enforced by `tsc`, ESLint, or a CI script — an AI agent cannot "forget" any of them without the build going red. All package versions and rule names below were verified against the npm registry and typescript-eslint documentation on 2026-07-06: `typescript@5.9.3` (latest 5.x; 6.0.3 is current latest — see Open Questions), `eslint@10.6.0`, `@eslint/js@10.0.1`, `typescript-eslint@8.62.1` (supports ESLint ^10 and TypeScript <6.1.0), `@eslint-community/eslint-plugin-eslint-comments@4.7.2`, `globals@17.7.0`, `@types/node@24.13.2`.*

## Rules

Each rule: **what** / *why (plain language)* / **enforced by**.

**R1. Pin the toolchain exactly: TypeScript `5.9.3`, ESLint `10.6.0`, `typescript-eslint@8.62.1`, `@types/node@24.13.2`. All dependencies are exact-pinned (`save-exact=true` in `.npmrc`), updated in monthly batches.**
*Why: if the compiler silently changes under an AI agent, yesterday's green build stops meaning anything.*
Enforced by: `.npmrc` (`save-exact=true`, `engine-strict=true`), `package-lock.json` committed, CI runs `npm ci` (fails on lockfile drift).

**R2. One shared `tsconfig.base.json` with the full strict flag set (snippet below). No package may weaken an inherited flag; per-package tsconfigs may only add `outDir`, `rootDir`, `include`, `references`, `lib`, and `jsx`.**
*Why: the compiler is the one reviewer that reads every line of every file, every time — these flags are its instructions.*
Enforced by: `tsc -b` in CI must exit 0; review check: any diff touching a `tsconfig*.json` that sets a `strict`-family flag to `false` is rejected (CI greps `": false"` in tsconfig files against an allowlist).

**R3. `tsc -b` (whole workspace) and `eslint . --max-warnings 0` must both exit 0 before any task is declared complete. This is the agent's definition of done.**
*Why: "it looks right" is not a check; two commands with exit codes are.*
Enforced by: CI job (snippet below); the repo `CLAUDE.md` lists the two commands (ties into builder.md §1 — this rule belongs in its "conventions that must never be violated" list).

**R4. ESM only. Every `package.json` has `"type": "module"`; backend compiles with `module: "nodenext"`; relative imports must include the `.js` extension; `require()`, `module.exports`, `__dirname`, and `__filename` are banned (use `import.meta.dirname` / `import.meta.url` — native on Node 24).**
*Why: mixing module systems is the #1 way an AI agent produces code that type-checks but crashes at startup.*
Enforced by: `moduleResolution: nodenext` (missing extension = compile error TS2835), `@typescript-eslint/no-require-imports` (on in the recommended preset), `no-restricted-globals` for `__dirname`/`__filename` (config below).

**R5. Erasable TypeScript syntax only: no `enum`, no `namespace`, no parameter properties, no `module =` — use `as const` objects + union types instead.**
*Why: keeps every source file directly runnable by Node 24's built-in TypeScript stripping, so debugging never needs a build step.*
Enforced by: compiler flag `erasableSyntaxOnly: true` (TS 5.8+; verified present in 5.9).

**R6. `any` is banned, explicit and implicit. No new code may introduce an `any`-typed value even from an untyped dependency.**
*Why: `any` turns the type checker off for everything it touches — it is exactly the hole AI-hallucinated code slips through.*
Enforced by: `strict: true` (includes `noImplicitAny`); `@typescript-eslint/no-explicit-any` plus the full `no-unsafe-assignment` / `no-unsafe-argument` / `no-unsafe-call` / `no-unsafe-member-access` / `no-unsafe-return` set — all enabled by the `strictTypeChecked` preset. Untyped data is typed `unknown` and narrowed (Zod v4 `safeParse` at trust boundaries — Chapter: runtime validation).

**R7. Type assertions are banned: no `expr as T`, no `<T>expr`, no non-null `!`. The only allowed exceptions, precisely: (a) `as const` — always permitted by the rule itself; (b) a single-line `eslint-disable-next-line` carrying a written justification (see R8). Tests get no blanket exemption: test fixtures that need "wrong" data are declared as `unknown` and fed to the code under test — that is what the trust-boundary parsers are for.**
*Why: an assertion is the developer overruling the compiler; an AI agent overruling the compiler is the exact failure mode this guide exists to stop.*
Enforced by: `@typescript-eslint/consistent-type-assertions: ["error", { assertionStyle: "never" }]` (verified: `never` bans all assertions but always permits `as const`); `@typescript-eslint/no-non-null-assertion` (on in `strict` presets).

**R8. Every `eslint-disable` directive must carry a description (`-- reason`), and unused directives are errors. Target: zero disables in `src/`; each one is a review item.**
*Why: escape hatches are allowed only when they explain themselves, so the owner can audit every place an agent bypassed a rule with one grep.*
Enforced by: `@eslint-community/eslint-comments/require-description: "error"`, `linterOptions.reportUnusedDisableDirectives: "error"`; CI step: `grep -rn "eslint-disable" apps packages --include="*.ts" --include="*.tsx"` output is posted in the PR for review.

**R9. Full async-correctness set: every Promise is awaited, returned, or explicitly routed to an error handler. `void promise` fire-and-forget is banned; intentionally detached work goes through the Job Ledger or a named `catchAndLog(promise, logger)` helper.**
*Why: a dropped promise is a silent crash-in-waiting — in an always-on, kill-9-safe app, "silently failed" is the one bug class the owner can never see.*
Enforced by: `@typescript-eslint/no-floating-promises: ["error", { ignoreVoid: false }]`, `no-misused-promises` (with `checksVoidReturn: true`, its default), `await-thenable`, `require-await`, `return-await`, `promise-function-async`, plus core `no-async-promise-executor`. The first four are already in `strictTypeChecked`/`recommendedTypeChecked`; the config re-declares `no-floating-promises` to set `ignoreVoid: false` and adds the rest.

**R10. Switches over union types must be exhaustive with no `default` clause; adding a variant (job state, event type, scene mode) must break compilation everywhere it isn't handled.**
*Why: the engine is a state machine — a forgotten state must be a compile error, not a 2 a.m. runtime surprise.*
Enforced by: `@typescript-eslint/switch-exhaustiveness-check: ["error", { allowDefaultCaseForExhaustiveSwitch: false, requireDefaultForNonUnion: true }]`.

**R11. Every exported function/method declares explicit parameter and return types.**
*Why: exported signatures are the documentation other agents build against (builder.md §6) — inference drift must not silently change a module's public contract.*
Enforced by: `@typescript-eslint/explicit-module-boundary-types: "error"`.

**R12. Import fence — SQLite: `better-sqlite3` may be imported only under `apps/server/src/repositories/` (which contains the connection/WriteGate module and the migration runner, per the decided stack item 7).**
*Why: the repository layer is the promise that lets a future database swap cost one driver — a single stray import breaks that promise invisibly.*
Enforced by: `@typescript-eslint/no-restricted-imports` — banned globally, re-allowed only in a `files: ["apps/server/src/repositories/**"]` override (config below). Echoed by the grep-test required by builder.md §6 (owned by the testing chapter).

**R13. Import fence — LLM SDK: `ai`, `@openrouter/ai-sdk-provider`, and `@ai-sdk/openai-compatible` may be imported only under `apps/server/src/llm/` (ModelRegistry + provider clients). The ContextAssembler and all agents call the `llm` module's own interface, never the SDK.**
*Why: prompt order and "LLM output is never directly durable" are load-bearing invariants — keeping the SDK behind one door means one place to audit and one place to swap (the stack's own v6→v7 escape hatch).*
Enforced by: same `no-restricted-imports` mechanism, override scoped to `apps/server/src/llm/**`.

**R14. Import fence — frontend: code under `apps/web/` may import `@weltari/protocol` (and `@weltari/plugin-sdk`) but nothing from `apps/server/`.**
*Why: "the frontend is just another client" is only true if it physically cannot reach into the engine.*
Enforced by: `no-restricted-imports` `patterns` ban on `@weltari/server*` and `**/apps/server/**` in the web override; plus `apps/web/package.json` lists only `@weltari/protocol` as a workspace dependency, so the import wouldn't resolve anyway.

**R15. License fence — the MIT packages (`packages/protocol`, `packages/plugin-sdk`) may not import from the AGPL core in any direction, may not depend on any workspace package that is not itself MIT, and may not contain vendored (copied-in) third-party source at all — notably no Apache-2.0 code (per the stack decision's repo-hygiene note). Dependency direction is one-way: `protocol` ← `plugin-sdk` ← core apps.**
*Why: these packages are the legal promise to plugin authors ("no copyleft touches you"); one wrong import quietly makes that promise false.*
Enforced by: three layers — (a) TS project references: `packages/*` tsconfigs list no reference to `apps/*`, so the import cannot type-resolve; (b) `no-restricted-imports` patterns in the `packages/**` override; (c) a CI license-check script (snippet below) asserting each `packages/*/package.json` has `"license": "MIT"` and its `dependencies` contain only MIT workspace siblings. "No vendored source" is a review check: any new file in `packages/` over ~50 lines that wasn't authored for this repo gets challenged.

**R16. Monorepo layout is fixed: npm workspaces + TypeScript project references.**
```
weltari/
  package.json            # private, workspaces, AGPL-3.0-only
  tsconfig.base.json      # the strict flags (R2)
  tsconfig.json           # solution file: references only
  eslint.config.js
  packages/protocol/      # MIT — TypeBox/Zod wire schemas, event & command types
  packages/plugin-sdk/    # MIT — plugin API types, GatewayConnector interface, conformance tests
  apps/server/            # AGPL — engine, repositories, llm, jobs, gateway…
  apps/web/               # AGPL — React 19 + Vite 8 client
```
*Why: license separation must be visible in the folder tree, and project references make cross-package type errors appear at build time instead of at publish time.*
Enforced by: `tsc -b` on the solution file; the license-check script; review check on any new top-level directory.

**R17. Frontend code compiles under the same base flags with only `jsx: "react-jsx"`, DOM libs, and `moduleResolution: "bundler"` changed (Vite owns module emit).**
*Why: the render-only frontend gets no strictness discount — it handles the same event schema.*
Enforced by: `apps/web/tsconfig.json` extends `tsconfig.base.json` (snippet below); CI type-checks it in the same `tsc -b` run.

**R18. `console.*` is banned in `apps/server/src/` (use the logger); allowed in `scripts/` and tests.**
*Why: an always-on appliance needs every message in one structured stream the owner can actually find.*
Enforced by: core `no-console: "error"` scoped to server `src`, off for `scripts/**` and `**/*.test.ts`.

## Config or code snippets

**`.npmrc` (repo root):**
```ini
save-exact=true
engine-strict=true
```

**Root `package.json` (fragment):**
```jsonc
{
  "name": "weltari",
  "private": true,
  "license": "AGPL-3.0-only",
  "type": "module",
  "engines": { "node": ">=24.0.0 <25" },
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "typecheck": "tsc -b",
    "lint": "eslint . --max-warnings 0",
    "check": "npm run typecheck && npm run lint && npm test"
  },
  "devDependencies": {
    "typescript": "5.9.3",
    "eslint": "10.6.0",
    "@eslint/js": "10.0.1",
    "typescript-eslint": "8.62.1",
    "@eslint-community/eslint-plugin-eslint-comments": "4.7.2",
    "globals": "17.7.0",
    "@types/node": "24.13.2"
  }
}
```

**`tsconfig.base.json`** — every flag justified in the comment:
```jsonc
{
  "compilerOptions": {
    /* Emit / module system — Node 24 ESM */
    "target": "es2024",                      // Node 24 runs ES2024 natively; no downleveling
    "module": "nodenext",                    // real Node ESM semantics; forces .js extensions on relative imports
    "moduleDetection": "force",              // every file is a module; no accidental global scripts
    "verbatimModuleSyntax": true,            // type imports must say `import type`; imports emit exactly as written
    "erasableSyntaxOnly": true,              // no enums/namespaces/param properties → Node can strip types directly
    "isolatedModules": true,                 // every file compilable alone (Vite/strip-types safe)

    /* Strictness — the point of this chapter */
    "strict": true,                          // noImplicitAny, strictNullChecks, useUnknownInCatchVariables, etc.
    "noUncheckedIndexedAccess": true,        // arr[i] is T | undefined — index lookups must be checked
    "exactOptionalPropertyTypes": true,      // `prop?: T` can be omitted but never explicitly `undefined` — kills a whole class of "why is this undefined" bugs
    "noImplicitOverride": true,              // overriding a method requires the `override` keyword
    "noPropertyAccessFromIndexSignature": true, // dynamic keys need bracket access — typos on real props stay errors
    "noImplicitReturns": true,               // every code path returns explicitly
    "noFallthroughCasesInSwitch": true,      // no accidental case fallthrough
    "noUnusedLocals": true,                  // dead variables are errors (AI agents leave these constantly)
    "noUnusedParameters": true,              // prefix `_` for intentionally unused
    "allowUnreachableCode": false,           // dead code after return/throw is an error
    "allowUnusedLabels": false,
    "allowJs": false,                        // TypeScript only — no unchecked .js in src
    "forceConsistentCasingInFileNames": true,// Windows dev box vs Linux Docker: casing bugs die here

    /* Build */
    "composite": true,                       // project references (monorepo)
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "incremental": true,
    "skipLibCheck": true                     // don't re-check node_modules' own .d.ts (their bugs aren't fixable here)
  }
}
```

**`apps/server/tsconfig.json`:**
```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src"],
  "references": [
    { "path": "../../packages/protocol" },
    { "path": "../../packages/plugin-sdk" }
  ]
}
```

**`packages/protocol/tsconfig.json`** (MIT package — note: **no references**, so it physically cannot see the core):
```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

**`apps/web/tsconfig.json`:**
```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",   // Vite resolves; extensions not required here
    "jsx": "react-jsx",
    "lib": ["es2024", "dom", "dom.iterable"],
    "noEmit": true,                  // Vite emits; tsc only checks
    "composite": false,
    "types": ["vite/client"]
  },
  "include": ["src"],
  "references": [{ "path": "../../packages/protocol" }]
}
```
Root `tsconfig.json` (solution): `{ "files": [], "references": [{ "path": "packages/protocol" }, { "path": "packages/plugin-sdk" }, { "path": "apps/server" }, { "path": "apps/web" }] }`. (`apps/web` uses `noEmit`, so run `tsc -b` for the composite packages plus `tsc -p apps/web` in the same `typecheck` script.)

**`eslint.config.js`** (flat config, typescript-eslint 8.62.x on ESLint 10):
```js
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import globalsPkg from 'globals';

/* Fenced packages: banned everywhere, re-allowed only in their home module. */
const SQLITE = [{ name: 'better-sqlite3', message: 'Only repositories may touch SQLite (Brief §2.7). Call a repository instead.' }];
const AI_SDK = ['ai', '@openrouter/ai-sdk-provider', '@ai-sdk/openai-compatible'].map(
  (name) => ({ name, message: 'Only src/llm may import the AI SDK. Call the ModelRegistry / LLM client interface instead.' }),
);
const restricted = (paths, patterns = []) => ({
  '@typescript-eslint/no-restricted-imports': ['error', { paths, patterns }],
});

export default defineConfig([
  globalIgnores(['**/dist/**', '**/node_modules/**', 'apps/web/dist/**']),

  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      comments.recommended,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: globalsPkg.node,
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      /* R7 — assertions banned (`as const` stays legal by rule design) */
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      /* R8 — every disable explains itself */
      '@eslint-community/eslint-comments/require-description': 'error',
      /* R9 — async correctness beyond the preset defaults */
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'error-handling-correctness-only'],
      '@typescript-eslint/promise-function-async': 'error',
      /* R10 — exhaustive state machines */
      '@typescript-eslint/switch-exhaustiveness-check': ['error', {
        allowDefaultCaseForExhaustiveSwitch: false,
        requireDefaultForNonUnion: true,
      }],
      /* R11 — explicit public contracts */
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      /* R4 — ESM discipline */
      'no-restricted-globals': ['error',
        { name: '__dirname', message: 'ESM: use import.meta.dirname' },
        { name: '__filename', message: 'ESM: use import.meta.filename' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      /* Misc hard checks */
      '@typescript-eslint/no-deprecated': 'error',
      eqeqeq: ['error', 'always'],
      /* R12/R13 — default: both fences closed */
      ...restricted([...SQLITE, ...AI_SDK]),
    },
  },

  /* R12 — repositories may import better-sqlite3 (AI SDK still banned) */
  { files: ['apps/server/src/repositories/**/*.ts'], rules: { ...restricted(AI_SDK) } },

  /* R13 — llm module may import the AI SDK (SQLite still banned) */
  { files: ['apps/server/src/llm/**/*.ts'], rules: { ...restricted(SQLITE) } },

  /* R14 — frontend: fences plus a ban on reaching into the server */
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globalsPkg.browser },
    rules: {
      ...restricted([...SQLITE, ...AI_SDK], [
        { group: ['@weltari/server*', '**/apps/server/**'], message: 'The frontend consumes @weltari/protocol only — no private side-channels (Brief §1).' },
      ]),
    },
  },

  /* R15 — MIT packages: nothing from the AGPL core, ever (types included) */
  {
    files: ['packages/**/*.ts'],
    rules: {
      ...restricted([...SQLITE, ...AI_SDK], [
        { group: ['@weltari/server*', '@weltari/web*', '**/apps/**'], message: 'MIT packages must not depend on the AGPL core (license fence).' },
      ]),
    },
  },

  /* R18 — server code logs through the logger */
  { files: ['apps/server/src/**/*.ts'], ignores: ['**/*.test.ts'], rules: { 'no-console': 'error' } },
]);
```
Note for the frontend chapter: add `eslint-plugin-react-hooks@7.1.1` (`recommended` flat preset) to the `apps/web` block; React-specific rules are out of this chapter's scope. If Prettier is adopted (formatting chapter), append `eslint-config-prettier@10.1.8` last.

**`scripts/check-licenses.mjs`** (CI, R15):
```js
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIT_PACKAGES = readdirSync('packages');
const mitNames = new Set();
const manifests = MIT_PACKAGES.map((dir) => {
  const pkg = JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8'));
  mitNames.add(pkg.name);
  return { dir, pkg };
});
let failed = false;
for (const { dir, pkg } of manifests) {
  if (pkg.license !== 'MIT') { console.error(`packages/${dir}: license must be "MIT", got "${pkg.license}"`); failed = true; }
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (dep.startsWith('@weltari/') && !mitNames.has(dep)) {
      console.error(`packages/${dir}: depends on non-MIT workspace package ${dep}`); failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);
```

**CI gate (fragment, GitHub Actions):**
```yaml
- uses: actions/setup-node@v4
  with: { node-version-file: '.node-version' }   # contains: 24
- run: npm ci
- run: npm run typecheck        # tsc -b + tsc -p apps/web — must exit 0
- run: npm run lint             # eslint . --max-warnings 0
- run: node scripts/check-licenses.mjs
- run: "! grep -rn --include='*.ts' 'eslint-disable' apps/server/src || true"  # surfaces disables in the log for review
```

## Boundary notes

Deliberately left to other chapters:
- **Runtime validation** (Zod v4 `safeParse` at trust boundaries, the Zod↔TypeBox split in `@weltari/protocol`) — this chapter only guarantees untrusted data arrives typed `unknown`.
- **Tests** (kill-harness, cache-hit CI tests, the grep-for-SQL test from builder.md §6, coverage policy) — I name the greps but the testing chapter owns them.
- **Formatting** (Prettier vs ESLint stylistic overlap) and **commit/PR discipline** (small commits, dependency-justification policy).
- **React/frontend specifics**: react-hooks rules, custom-element `IntrinsicElements` augmentations (Fact-check Addendum), zustand store discipline.
- **Secrets and untrusted-input handling** (no hardcoded keys, plugin sandboxing) — security chapter.
- **Documentation rules** — builder.md is authoritative; R3 and R12 explicitly feed its `CLAUDE.md` conventions list.

## Open questions for synthesis

1. **TypeScript 5.9.3 vs 6.0.3.** The decided stack says "TypeScript 5.x", so I pinned 5.9.3 — but 6.0.3 is the current stable and `typescript-eslint@8.62.1` explicitly supports `<6.1.0`. TS 7 (native compiler) is at RC. Synthesis should decide: hold 5.9.3 per the decision, or amend to 6.0.x now to shrink the eventual TS7 migration. Either is safe today; the tsconfig above works on both.
2. **Fence location for the SQLite connection/migrations.** The stack decision (item 7) puts the WriteGate and migration runner inside the repository layer, so my fence is `apps/server/src/repositories/**` as a whole. If the walking skeleton splits `db/` out of `repositories/`, the ESLint override globs must be updated in the same commit — synthesis should state this in one place.
3. **Zod/TypeBox unification** (Fact-check Addendum open item): if Week 1 unifies the protocol package on Zod v4, add `typebox`/`@sinclair/typebox` to a `no-restricted-imports` fence outside `packages/protocol`; until then both names should be fenced to the protocol package. I did not add this fence because the decision is explicitly open.
4. **`ai` v6 pin vs v7.** npm `latest` is now `ai@7.0.15`; the Addendum pins v6 because `@openrouter/ai-sdk-provider@2.x` peer-depends on `ai@^6` (re-verified today). The exact-pin policy (R1) makes this safe, but synthesis should carry the "re-evaluate v7" reminder into the walking-skeleton checklist.
5. **Test-file assertion policy.** I chose the hard line (assertions banned in tests too, R7); if the testing chapter finds this too costly for mocks, the negotiated exception should be a *single* scoped override (e.g., `assertionStyle: "as"` limited to `**/*.test.ts`) declared there — not ad-hoc disables.
6. **Rev 4 conflict flag (routine).** Rev 4 front-matter still says "LangGraph vs custom orchestration" is open; the stack decision closed it (custom loop, 4/4). No compile-time impact, but R13's fence assumes the custom loop — if any future doc reopens an orchestration framework, the fence list changes.
