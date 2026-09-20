import typescriptEslint from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';

export default [
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parser: typescriptParser,
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': typescriptEslint,
    },
    rules: {
      'no-undef': 'off', // TypeScript handles this
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',
    },
  },
  {
    ignores: ['eslint.config.mjs', 'dist/**', 'node_modules/**'],
  },
];
