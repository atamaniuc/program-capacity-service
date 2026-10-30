import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts', 'test/property/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'int',
          include: [
            'test/integration/**/*.test.ts',
            'test/e2e/**/*.test.ts',
            'test/system/**/*.test.ts',
          ],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
