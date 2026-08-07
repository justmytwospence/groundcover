import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // .local/ is build output and scratch: the owner's artifacts, and the staged publish tree,
  // which contains a minified bundle and a 170 kB generated function. Linting generated code
  // buries the handful of real findings under thousands of noise errors.
  { ignores: ['**/dist/**', '**/node_modules/**', 'app/public/**', 'data/**', '.local/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
