import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@wasmnux/core': `${root}core/src/index.ts`,
      '@wasmnux/host': `${root}host/src/index.ts`,
      '@wasmnux/relay': `${root}relay/src/index.ts`,
      '@wasmnux/bench': `${root}benchmarks/src/index.ts`,
    },
  },
  test: {
    include: ['core/test/**/*.test.ts', 'host/test/**/*.test.ts', 'relay/test/**/*.test.ts', 'benchmarks/test/**/*.test.ts'],
    // The SMP litmus/worker tests need real threads; keep them off the fake-timer path.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'threads',
    reporters: ['default'],
  },
});
