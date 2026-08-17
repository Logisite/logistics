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
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: ['app'], allow: ['app', 'package'] },
            { from: ['package'], allow: ['package'] },
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
      'boundaries/dependency-nodes': ['import', 'export', 'dynamic-import'],
      'import/resolver': {
        typescript: { alwaysTryTypes: true },
        node: true,
      },
    },
  },
);