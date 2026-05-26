import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/.expo/**',
      '**/coverage/**',
      '**/*.config.js',
      '**/*.config.ts',
      '**/*.config.mjs',
      'packages/api/prisma/**',
    ],
  },

  // Base: recommended JS + TypeScript (no type-info / syntactic only)
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Project-wide rule severity tuning.
  // no-explicit-any is intentionally a WARNING until a dedicated post-launch
  // typing session — see TECH_DEBT note in CLAUDE.md. Do not promote to error
  // without typing all 700+ instances first.
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // API + shared — Node environment
  {
    files: ['packages/api/src/**/*.{ts,tsx}', 'packages/shared/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.es2021 },
    },
  },

  // Web — React + browser environment
  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2021 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react-refresh/only-export-components': 'warn',
    },
  },

  // Mobile — React Native + browser-ish globals
  {
    files: ['packages/mobile/src/**/*.{ts,tsx}', 'packages/mobile/app/**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2021, __DEV__: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },
);
