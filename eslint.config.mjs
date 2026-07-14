// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'architecture/', 'esbuild.config.mjs', 'eslint.config.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // tsconfig.json excludes *.test.ts, which is fine: the test-file block
        // below turns typed parsing off for those, so the build project covers
        // exactly the typed (non-test) source this tier lints.
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The codebase marks intentionally-unused bindings (dropped destructure
      // fields, placeholder params) with a leading underscore.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  // Test files are outside the typed build (tsconfig excludes *.test.ts) and
  // lean on `any`/`require` for fixtures; drop the type-aware rule tier for them.
  {
    files: ['**/*.test.ts'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
)
