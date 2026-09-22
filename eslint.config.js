import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { boundaries },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          rules: [
            {
              from: { type: 'app' },
              allow: { to: { type: ['app', 'package'] } },
            },
            {
              from: { type: 'package' },
              allow: { to: { type: 'package' } },
            },
          ],
        },
      ],
    },
    settings: {
      'boundaries/elements': [
        { type: 'app', pattern: 'apps/*', mode: 'folder' },
        { type: 'package', pattern: 'packages/*', mode: 'folder' },
      ],
      'boundaries/root-path': import.meta.dirname,
      'import/resolver': {
        typescript: { alwaysTryTypes: true },
        node: true,
      },
    },
  },
  {
    // Module barrels: code outside a module may only import its index.ts.
    files: ['apps/api/src/**/*.ts', '!apps/api/src/modules/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/*/*', '!**/modules/*/index.*'],
              message: 'Import the module public API via modules/<name>/index.js only.',
            },
          ],
        },
      ],
    },
  },
  {
    // Cross-module imports within modules: prefer barrel, allow ../auth/audit.js
    files: ['apps/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/*/*', '!**/modules/*/index.*', '!**/modules/auth/audit.js'],
              message: 'Import via the module barrel (modules/<name>/index.js).',
            },
          ],
        },
      ],
    },
  },
);