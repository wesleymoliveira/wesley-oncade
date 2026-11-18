import { defineConfig } from 'vitest/config';

// `npm test`: the pure rules, and the schemas against replies recorded from
// the real test API. No services needed.
// The limit of what is tested is written in TESTING.md and enforced here:
// lib/core must be fully covered; nothing else has a target.
export default defineConfig({
  test: {
    include: ['tests/core/**/*.test.ts', 'tests/contract/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['lib/core/**'],
      reporter: ['text'],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
