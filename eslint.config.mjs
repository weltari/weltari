// Weltari flat ESLint config — ESLint 10.6.x + typescript-eslint 8.62.x.
// Every rule name verified against typescript-eslint / plugin docs on 2026-07-06.
// See "AI Coding Guide.md" for the rule-by-rule rationale (A/B/C/D/E section refs below).
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import nodePlugin from 'eslint-plugin-n';
import noOnlyTests from 'eslint-plugin-no-only-tests';
import vitest from '@vitest/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';
import globalsPkg from 'globals';

/* Fenced packages (Guide A11): banned everywhere, re-allowed only in their home directory. */
const SQLITE = [
  {
    name: 'better-sqlite3',
    message:
      'Only apps/server/src/storage may touch SQLite (Brief §2.7). Call a repository instead.',
  },
];
const AI_SDK = [
  'ai',
  '@openrouter/ai-sdk-provider',
  '@ai-sdk/openai-compatible',
].map((name) => ({
  name,
  message:
    'Only apps/server/src/llm may import the AI SDK. Call the ModelRegistry / LLM client interface instead.',
}));
const GRAMMY = [
  {
    name: 'grammy',
    message:
      'Only apps/server/src/gateway/telegram may import grammY (trust-boundary fence, Guide B7).',
  },
];
const MULTIPART = [
  {
    name: '@fastify/multipart',
    message:
      'Only apps/server/src/boundary/uploads may handle uploads (Guide B13).',
  },
];
const TYPEBOX = ['typebox', '@sinclair/typebox'].map((name) => ({
  name,
  message: 'Protocol is unified on Zod v4 (Guide §0.1); TypeBox is dropped.',
}));
const SHARP = [
  {
    name: 'sharp',
    message:
      'Only apps/server/src/painter may touch sharp (A11; tests may read images).',
  },
];
const ALL_FENCES = [
  ...SQLITE,
  ...AI_SDK,
  ...GRAMMY,
  ...MULTIPART,
  ...TYPEBOX,
  ...SHARP,
];
const restricted = (paths, patterns = []) => ({
  '@typescript-eslint/no-restricted-imports': ['error', { paths, patterns }],
});

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    '**/coverage/**',
    'plugins/**',
  ]),

  /* ---- Base TypeScript block: all .ts/.tsx ---- */
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      comments.recommended,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globalsPkg.node,
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      /* A6 — assertions banned (`as const` stays legal by rule design) */
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],
      /* A7 — every disable explains itself */
      '@eslint-community/eslint-comments/require-description': 'error',
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
      /* A8 — async correctness beyond preset defaults */
      '@typescript-eslint/no-floating-promises': [
        'error',
        { ignoreVoid: false },
      ],
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': [
        'error',
        'error-handling-correctness-only',
      ],
      '@typescript-eslint/promise-function-async': 'error',
      /* A9 — exhaustive state machines */
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        {
          allowDefaultCaseForExhaustiveSwitch: false,
          requireDefaultForNonUnion: true,
        },
      ],
      /* A10 — explicit public contracts */
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      /* A3 — ESM discipline */
      'no-restricted-globals': [
        'error',
        { name: '__dirname', message: 'ESM: use import.meta.dirname' },
        { name: '__filename', message: 'ESM: use import.meta.filename' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports' },
      ],
      /* C1/C3/C4 — error discipline */
      'no-empty': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
      /* C5 — process.exit only in observability/fatal.ts */
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'exit',
          message:
            'Only apps/server/src/observability/fatal.ts may exit. Throw a typed AppError instead (Guide C5).',
        },
      ],
      /* B1 — .parse() throws; use safeParse via validateAt(). JSON.parse excepted (confined to boundary modules). */
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='parse'][callee.object.name!='JSON']",
          message:
            'Use .safeParse() via validateAt() — .parse() throws (Guide B1). Non-Zod false positives take a justified inline disable.',
        },
      ],
      /* Misc hard checks */
      '@typescript-eslint/no-deprecated': 'error',
      eqeqeq: ['error', 'always'],
      /* A11 — default: every fence closed */
      ...restricted(ALL_FENCES),
    },
  },

  /* ---- B15: process.env only in env.ts ---- */
  {
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/boundary/config/env.ts'],
    plugins: { n: nodePlugin },
    rules: { 'n/no-process-env': 'error' },
  },

  /* ---- A11 fence re-openings (each keeps every OTHER fence closed) ---- */
  {
    files: ['apps/server/src/storage/**/*.ts'],
    rules: {
      ...restricted([...AI_SDK, ...GRAMMY, ...MULTIPART, ...TYPEBOX, ...SHARP]),
    },
  },
  {
    files: ['apps/server/src/llm/**/*.ts'],
    rules: {
      ...restricted([...SQLITE, ...GRAMMY, ...MULTIPART, ...TYPEBOX, ...SHARP]),
    },
  },
  {
    files: ['apps/server/src/gateway/telegram/**/*.ts'],
    rules: {
      ...restricted([...SQLITE, ...AI_SDK, ...MULTIPART, ...TYPEBOX, ...SHARP]),
    },
  },
  {
    files: ['apps/server/src/boundary/uploads/**/*.ts'],
    rules: {
      ...restricted([...SQLITE, ...AI_SDK, ...GRAMMY, ...TYPEBOX, ...SHARP]),
    },
  },
  {
    files: ['apps/server/src/painter/**/*.ts'],
    rules: {
      ...restricted([
        ...SQLITE,
        ...AI_SDK,
        ...GRAMMY,
        ...MULTIPART,
        ...TYPEBOX,
      ]),
    },
  },

  /* ---- A16: no wall-clock reads in the engine (injected clocks only) ---- */
  {
    files: ['apps/server/src/engine/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='parse'][callee.object.name!='JSON']",
          message:
            'Use .safeParse() via validateAt() — .parse() throws (Guide B1).',
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            'Engine time is injected: use WorldClock / SystemClock (Guide A16).',
        },
        {
          selector:
            "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            'Engine time is injected: use WorldClock / SystemClock (Guide A16).',
        },
      ],
    },
  },

  /* ---- A15: server code logs through the logger ---- */
  {
    files: ['apps/server/src/**/*.ts'],
    ignores: [
      'apps/server/src/observability/fatal.ts',
      'apps/server/src/boundary/config/env.ts',
      '**/*.test.ts',
    ],
    rules: { 'no-console': 'error' },
  },

  /* ---- C5/A15 escape: fatal.ts is the one sanctioned exit + last-resort console ---- */
  {
    files: ['apps/server/src/observability/fatal.ts'],
    rules: { 'no-restricted-properties': 'off', 'no-console': 'off' },
  },

  /* ---- A13: frontend — browser globals, react-hooks, no reaching into the server ---- */
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    /* Plugin v7 ships flat configs under .flat; .recommended is legacy format
       (one-line correction to the promoted config — recorded in docs/repo.md). */
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: globalsPkg.browser },
    rules: {
      ...restricted(ALL_FENCES, [
        {
          group: ['@weltari/server*', '**/apps/server/**'],
          message:
            'The frontend consumes @weltari/protocol only — no private side-channels (Brief §1).',
        },
      ]),
    },
  },

  /* ---- A12: MIT packages — nothing from the AGPL core, ever (types included) ---- */
  {
    files: ['packages/**/*.ts'],
    rules: {
      ...restricted(ALL_FENCES, [
        {
          group: ['@weltari/server*', '@weltari/web*', '**/apps/**'],
          message:
            'MIT packages must not depend on the AGPL core (license fence, Guide A12).',
        },
      ]),
    },
  },

  /* ---- Tests: no focus/skip, no snapshots outside protocol, raw SQLite allowed for invariant tests ---- */
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'tests/**/*.ts'],
    plugins: { 'no-only-tests': noOnlyTests, vitest },
    rules: {
      'no-only-tests/no-only-tests': 'error',
      'vitest/no-focused-tests': 'error',
      'vitest/no-disabled-tests': 'error',
      'no-console': 'off',
      /* E5 — snapshots only for protocol schemas; keep the B1 .parse ban alive in tests too */
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='parse'][callee.object.name!='JSON']",
          message:
            'Tests use safeParse too — assertions are not exempt (Guide §0.12).',
        },
        {
          selector: "CallExpression[callee.property.name='toMatchSnapshot']",
          message:
            'Snapshot tests are sanctioned only in packages/protocol (Guide E5).',
        },
      ],
      /* Raw driver access is needed by tests/invariants (append-only trigger test) */
      ...restricted([...AI_SDK, ...GRAMMY, ...MULTIPART, ...TYPEBOX]),
    },
  },
  {
    files: ['packages/protocol/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='parse'][callee.object.name!='JSON']",
          message: 'Tests use safeParse too (Guide §0.12).',
        },
      ],
    },
  },

  /* ---- Plain .mjs (scripts/, tools/): basic checks, node globals ---- */
  {
    files: ['scripts/**/*.mjs', 'tools/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globalsPkg.node },
  },

  /* Must stay last: disables formatting rules that would fight Prettier (Guide §0.4). */
  prettierConfig,
]);
