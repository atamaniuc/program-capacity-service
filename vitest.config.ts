import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const swcPlugin = swc.vite({
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: 'es2022',
  },
  module: { type: 'es6' },
});

export default defineConfig({
  plugins: [swcPlugin],
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/capacity/domain/**', 'src/capacity/application/**'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      // An empty layer reports nothing and must not fail; a populated one must hit 90% of lines.
      thresholds: { lines: 90 },
      reporter: ['text', 'lcov'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'src/**/*.test.ts',
            'test/architecture/**/*.test.ts',
            'test/property/**/*.test.ts',
            'test/contracts/**/*.test.ts',
          ],
          // buf and the AsyncAPI parser take seconds under the parallel unit run (workspaces add load).
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'int',
          include: [
            'test/integration/**/*.test.ts',
            'test/e2e/**/*.test.ts',
            'test/kafka/**/*.test.ts',
            'test/fault/**/*.test.ts',
          ],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
