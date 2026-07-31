import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `await using` is only native from Node 24. The tests use it, and CI runs
  // the matrix down to the 20.19 floor declared in engines, so the transform
  // has to downlevel it rather than passing it through.
  oxc: { target: 'node20' },
  test: {
    include: ['test/**/*.test.ts'],
    // Every test binds a real loopback TCP server; keep them isolated.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
