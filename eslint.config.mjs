// Plain JS on purpose. A .ts config would need `jiti` installed, which was an
// implicit dependency that happened to work locally under Bun and failed in CI
// under Node. See tsdown.config.mjs for the same reasoning.
import { defineConfig, globalIgnores } from 'eslint/config';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default defineConfig(
  globalIgnores(['dist/', 'coverage/']),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      // Device responses are strings; the numeric conversions are validated
      // in src/parse.ts rather than by the compiler.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
    },
  },
  {
    // Config files are not part of the tsconfig project, so type-aware rules
    // cannot resolve them. Lint them syntactically only.
    files: ['*.config.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Scripts and tests talk to sockets and print to the console.
    files: ['scripts/**/*.ts', 'test/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
