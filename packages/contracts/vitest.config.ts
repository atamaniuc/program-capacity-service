import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    testTimeout: 30_000,
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/**/*.test.ts'] } },
      { extends: true, test: { name: 'int', include: ['test/integration/**/*.test.ts'] } },
    ],
  },
});
