// Two Vitest projects (Invariants & Test Templates: "The test runner (settled)"):
// unit = colocated src tests; invariants = tests/invariants/** and gates every merge.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'apps/server/src/**/*.test.ts',
            'packages/**/src/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'invariants',
          include: ['tests/invariants/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['apps/server/src/**', 'packages/protocol/src/**'],
      exclude: ['apps/web/**'],
      thresholds: {
        'apps/server/src/storage/**': { branches: 90 },
        'apps/server/src/engine/**': { branches: 90 },
        'packages/protocol/src/**': { branches: 90 },
      },
    },
  },
});
