import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import unicorn from 'eslint-plugin-unicorn';
import sonarjs from 'eslint-plugin-sonarjs';
import promise from 'eslint-plugin-promise';
import node from 'eslint-plugin-n';
import noUnsanitized from 'eslint-plugin-no-unsanitized';
import security from 'eslint-plugin-security';
import jsdoc from 'eslint-plugin-jsdoc';
import jest from 'eslint-plugin-jest';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    plugins: {
      'import-x': importX,
      unicorn,
      sonarjs,
      promise,
      n: node,
      'no-unsanitized': noUnsanitized,
      security,
      jsdoc,
      jest,
    },

    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      // ============================================================
      // KISS: COMPLEXITY LIMITS
      // ============================================================
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 30, skipBlankLines: true, skipComments: true }],
      'max-depth': ['error', 3],
      'max-params': ['error', 4],
      'max-nested-callbacks': ['error', 3],
      'complexity': ['error', { max: 10 }],
      'max-statements': ['error', 20],

      // ============================================================
      // YAGNI: DEAD CODE
      // ============================================================
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-unreachable': 'error',
      'no-constant-condition': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unnecessary-type-arguments': 'error',
      '@typescript-eslint/no-useless-constructor': 'error',
      '@typescript-eslint/no-unnecessary-qualifier': 'error',
      '@typescript-eslint/no-unnecessary-template-expression': 'error',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/no-duplicate-enum-values': 'error',
      '@typescript-eslint/no-duplicate-type-constituents': 'error',
      '@typescript-eslint/no-useless-empty-export': 'error',
      '@typescript-eslint/prefer-literal-enum-member': 'error',

      // ============================================================
      // NO `any` — EVER
      // ============================================================
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-unary-minus': 'error',
      '@typescript-eslint/no-unsafe-declaration-merging': 'error',

      // ============================================================
      // TYPE SAFETY
      // ============================================================
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', {
        checksConditionals: true,
        checksVoidReturn: true,
        checksSpreads: true,
      }],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/prefer-reduce-type-parameter': 'error',
      '@typescript-eslint/prefer-return-this-type': 'error',
      '@typescript-eslint/prefer-string-starts-ends-with': 'error',
      '@typescript-eslint/prefer-includes': 'error',
      '@typescript-eslint/prefer-as-const': 'error',
      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports',
        fixStyle: 'separate-type-imports',
      }],
      '@typescript-eslint/consistent-type-exports': ['error', {
        fixMixedExportsWithInlineTypeSpecifier: true,
      }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/unified-signatures': 'error',
      '@typescript-eslint/method-signature-style': ['error', 'property'],
      '@typescript-eslint/no-confusing-void-expression': 'error',
      '@typescript-eslint/no-meaningless-void-operator': 'error',
      '@typescript-eslint/no-mixed-enums': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-deprecated': 'error',

      // ============================================================
      // NAMING CONVENTIONS
      // ============================================================
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE'], leadingUnderscore: 'allow' },
        { selector: 'function', format: ['camelCase'] },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['UPPER_CASE'] },
        { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'classProperty', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'interface', format: ['PascalCase'], custom: { regex: '^I[A-Z]', match: false } },
        { selector: 'typeAlias', format: ['PascalCase'] },
      ],

      // ============================================================
      // READABILITY
      // ============================================================
      '@typescript-eslint/explicit-function-return-type': ['error', {
        allowExpressions: true,
        allowTypedFunctionExpressions: true,
        allowHigherOrderFunctions: true,
      }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-inferrable-types': 'error',
      'no-nested-ternary': 'error',
      'no-unneeded-ternary': 'error',
      'unicorn/no-nested-ternary': 'error',
      'unicorn/no-array-reduce': 'error',
      'unicorn/prefer-switch': ['error', { minimumCases: 3 }],
      'unicorn/prefer-early-return': ['error', { maximumStatements: 2 }],
      'unicorn/no-useless-undefined': 'error',
      'unicorn/no-lonely-if': 'error',
      'unicorn/no-null': 'off',
      'unicorn/name-replacements': ['error', {
        checkProperties: false,
        checkVariables: false,
        checkFilenames: false,
      }],
      'unicorn/no-useless-spread': 'error',
      'unicorn/no-useless-fallback-in-spread': 'error',
      'unicorn/prefer-node-protocol': 'error',
      'unicorn/prefer-number-properties': 'error',
      'unicorn/prefer-object-from-entries': 'error',
      'unicorn/prefer-string-replace-all': 'error',
      'unicorn/prefer-string-slice': 'error',
      'unicorn/prefer-string-trim-start-end': 'error',
      'unicorn/prefer-type-error': 'error',
      'unicorn/throw-new-error': 'error',
      'unicorn/error-message': 'error',
      'unicorn/escape-case': 'error',
      'unicorn/new-for-builtins': 'error',
      'unicorn/no-instanceof-array': 'error',
      'unicorn/no-new-array': 'error',
      'unicorn/no-new-buffer': 'error',
      'unicorn/no-typeof-undefined': 'error',
      'unicorn/no-zero-fractions': 'error',
      'unicorn/number-literal-case': 'error',
      'unicorn/numeric-separators-style': 'error',
      'unicorn/prefer-array-find': 'error',
      'unicorn/prefer-array-flat': 'error',
      'unicorn/prefer-array-flat-map': 'error',
      'unicorn/prefer-array-index-of': 'error',
      'unicorn/prefer-array-some': 'error',
      'unicorn/prefer-at': 'error',
      'unicorn/prefer-code-point': 'error',
      'unicorn/prefer-date-now': 'error',
      'unicorn/prefer-default-parameters': 'error',
      'unicorn/prefer-export-from': 'error',
      'unicorn/prefer-includes': 'error',
      'unicorn/prefer-logical-operator-over-ternary': 'error',
      'unicorn/prefer-math-min-max': 'error',
      'unicorn/prefer-module': 'error',
      'unicorn/prefer-negative-index': 'error',
      'prefer-object-has-own': 'error',
      'unicorn/prefer-prototype-methods': 'error',
      'unicorn/prefer-reflect-apply': 'error',
      'unicorn/prefer-regexp-test': 'error',
      'unicorn/prefer-set-has': 'error',
      'unicorn/prefer-set-size': 'error',
      'unicorn/prefer-spread': 'error',
      'unicorn/prefer-string-raw': 'error',
      'unicorn/relative-url-style': 'error',
      'unicorn/require-array-join-separator': 'error',
      'unicorn/require-number-to-fixed-digits-argument': 'error',
      'unicorn/switch-case-braces': 'error',
      'unicorn/text-encoding-identifier-case': 'error',

      // ============================================================
      // SOLID / DESIGN
      // ============================================================
      'sonarjs/no-duplicate-string': ['error', { threshold: 3 }],
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-small-switch': 'error',
      'sonarjs/no-collapsible-if': 'error',
      'sonarjs/no-collection-size-mischeck': 'error',
      'sonarjs/no-redundant-boolean': 'error',
      'sonarjs/no-redundant-jump': 'error',
      'sonarjs/no-same-line-conditional': 'error',
      'sonarjs/no-unused-collection': 'error',
      'sonarjs/prefer-immediate-return': 'error',
      'sonarjs/prefer-object-literal': 'error',
      'sonarjs/prefer-single-boolean-return': 'error',
      'sonarjs/no-inverted-boolean-check': 'error',
      'sonarjs/no-extra-arguments': 'error',
      'sonarjs/no-ignored-return': 'error',
      'sonarjs/no-use-of-empty-return-value': 'error',
      'sonarjs/non-existent-operator': 'error',

      // ============================================================
      // ERROR HANDLING
      // ============================================================
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-throw-literal': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      'promise/always-return': 'error',
      'promise/catch-or-return': 'error',
      'promise/no-nesting': 'error',
      'promise/no-promise-in-callback': 'error',
      'promise/no-return-wrap': 'error',
      'promise/param-names': 'error',
      'promise/no-return-in-finally': 'error',
      'promise/valid-params': 'error',

      // ============================================================
      // IMPORTS
      // ============================================================
      'import-x/no-cycle': 'error',
      'import-x/no-self-import': 'error',
      'import-x/no-useless-path-segments': 'error',
      'import-x/no-duplicates': 'error',
      'import-x/no-mutable-exports': 'error',
      'import-x/no-named-as-default': 'error',
      'import-x/no-named-as-default-member': 'error',
      'import-x/no-extraneous-dependencies': ['error', {
        devDependencies: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/tests/**', '**/*.config.*'],
      }],
      'import-x/order': ['error', {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc' },
        pathGroups: [
          { pattern: 'node:*', group: 'builtin', position: 'before' },
        ],
      }],
      'import-x/no-default-export': 'error',
      'import-x/no-anonymous-default-export': 'error',

      // ============================================================
      // NODE.JS SPECIFIC
      // ============================================================
      'n/no-process-exit': 'error',
      'n/no-deprecated-api': 'error',
      'n/no-unpublished-import': 'error',
      'n/no-unsupported-features/es-syntax': ['error', { version: '>=22.0.0' }],
      'n/no-unsupported-features/node-builtins': ['error', { version: '>=22.0.0' }],
      'n/prefer-global/buffer': ['error', 'always'],
      'n/prefer-global/console': ['error', 'always'],
      'n/prefer-global/process': ['error', 'always'],
      'n/prefer-global/text-decoder': ['error', 'always'],
      'n/prefer-global/text-encoder': ['error', 'always'],
      'n/prefer-global/url': ['error', 'always'],
      'n/prefer-global/url-search-params': ['error', 'always'],
      'n/prefer-promises/dns': 'error',
      'n/prefer-promises/fs': 'error',
      'n/no-mixed-requires': 'error',
      'n/no-new-require': 'error',
      'n/no-path-concat': 'error',
      'n/prefer-node-protocol': 'error',

      // ============================================================
      // SECURITY
      // ============================================================
      'no-unsanitized/property': 'error',
      'no-unsanitized/method': 'error',
      'security/detect-child-process': 'error',
      'security/detect-eval-with-expression': 'error',
      // Paths reaching the fs boundary from LLM-supplied input must be
      // validated — scoped to tool-boundary files (see boundary block below);
      // off elsewhere where paths are config/env-derived and never user input.
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-non-literal-regexp': 'warn',
      'security/detect-non-literal-require': 'warn',
      'security/detect-object-injection': 'off',
      'security/detect-possible-timing-attacks': 'error',
      'security/detect-pseudoRandomBytes': 'error',
      'security/detect-unsafe-regex': 'error',

      // ============================================================
      // DOCUMENTATION (check rules only — project comment culture is WHY-only)
      // ============================================================
      'jsdoc/check-param-names': 'error',
      'jsdoc/check-tag-names': 'error',
      'jsdoc/check-types': 'error',
      'jsdoc/no-types': 'error',

      // ============================================================
      // COMMENTS
      // ============================================================
      'no-warning-comments': ['warn', {
        terms: ['todo', 'fixme', 'hack', 'xxx'],
        location: 'anywhere',
      }],
      'capitalized-comments': ['error', 'always', {
        ignorePattern: 'pragma|ignored|c8|v8|istanbul',
        ignoreInlineComments: true,
      }],

      // ============================================================
      // BEST PRACTICES
      // ============================================================
      'eqeqeq': ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-template': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-alert': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-void': 'error',
      'no-with': 'error',
      'prefer-arrow-callback': 'error',
      'prefer-rest-params': 'error',
      'prefer-spread': 'error',
      'require-atomic-updates': 'error',
      'no-promise-executor-return': 'error',
      'no-constructor-return': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-useless-call': 'error',
      'no-useless-computed-key': 'error',
      'no-useless-concat': 'error',
      'no-useless-rename': 'error',
      'no-useless-return': 'error',
      'object-shorthand': 'error',
      'prefer-object-spread': 'error',
      'prefer-numeric-literals': 'error',
      'prefer-exponentiation-operator': 'error',
      'symbol-description': 'error',
      'yoda': 'error',
    },
  },

  // === FS SANDBOX BOUNDARY (LLM-supplied paths → filesystem calls) ===
  // The non-literal-fs-filename heuristic only adds signal here: paths must
  // pass resolveWorkspacePath() before touching fs. Calls on already-validated
  // paths get a per-line disable with rationale.
  {
    files: [
      'src/tools/filesystem.ts',
      'src/tools/directory-tools.ts',
      'src/tools/edit-tools.ts',
      'src/tools/backup-tools.ts',
      'src/tools/path-utils.ts',
      'src/tools/search-tools.ts',
      'src/tools/shell.ts',
      'src/tools/git-tools.ts',
      'src/tools/docker-tools.ts',
      'src/tools/database-tools.ts',
    ],
    rules: {
      'security/detect-non-literal-fs-filename': 'error',
    },
  },

  // === TEST FILES ===
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/tests/**'],
    rules: {
      'max-lines-per-function': 'off',
      'max-lines': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'jsdoc/require-jsdoc': 'off',
      'n/no-sync': 'off',
      'no-console': 'off',
      ...jest.configs.recommended.rules,
      'jest/expect-expect': 'error',
      'jest/no-commented-out-tests': 'error',
      'jest/no-conditional-expect': 'error',
      'jest/no-disabled-tests': 'error',
      'jest/no-focused-tests': 'error',
      'jest/no-identical-title': 'error',
      'jest/no-standalone-expect': 'error',
      'jest/no-test-prefixes': 'error',
      'jest/prefer-called-with': 'error',
      'jest/prefer-comparison-matcher': 'error',
      'jest/prefer-equality-matcher': 'error',
      'jest/prefer-expect-resolves': 'error',
      'jest/prefer-hooks-in-order': 'error',
      'jest/prefer-hooks-on-top': 'error',
      'jest/prefer-spy-on': 'off', // autofixer corrupts `(x as any).method = jest.fn()` patterns
      'jest/prefer-strict-equal': 'error',
      'jest/prefer-to-be': 'error',
      'jest/prefer-to-contain': 'error',
      'jest/prefer-to-have-length': 'error',
      'jest/prefer-todo': 'error',
      'jest/require-to-throw-message': 'error',
      'jest/valid-describe-callback': 'error',
      'jest/valid-expect': 'error',
      'jest/valid-title': 'error',
    },
  },

  // === PLAIN JS FILES (no type-aware rules) ===
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },

  // === CONFIG FILES ===
  {
    files: ['**/*.config.*', '**/*.mjs', '**/*.cjs'],
    rules: {
      'import-x/no-default-export': 'off',
      'n/no-unpublished-import': 'off',
    },
  },

  // === IGNORES ===
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '*.d.ts', 'e2e-test.ts', 'alpha-hunt.ts'],
  },
);
