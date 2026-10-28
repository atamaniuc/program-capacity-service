import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'test/architecture/fixtures/**',
      '.omc/**',
      '.codegraph/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    files: ['src/capacity/domain/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money is bigint minor units; no floating point (I8).' },
        {
          name: 'Number',
          message: 'Money is bigint minor units; no Number() on the money path (I8).',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'Money is bigint minor units; no parseFloat (I8).',
        },
        {
          selector: "CallExpression[callee.name='Number']",
          message: 'Money is bigint minor units; no Number() (I8).',
        },
        {
          selector:
            "CallExpression[callee.object.name='Number'][callee.property.name='parseFloat']",
          message: 'Money is bigint minor units; no Number.parseFloat (I8).',
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
