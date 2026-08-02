# Automated Guardrails: TypeScript & Node.js — The Complete Reference

Every tool, every config, every convention, every enforcement layer for production TypeScript and Node.js applications.

---

## Part 1: TypeScript Compiler — The First Line of Defense

### 1.1 `tsconfig.json` — Maximum Strictness

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "useUnknownInCatchVariables": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitThis": true,
    "alwaysStrict": true,

    "noUnusedLocals": true,
    "noUnusedParameters": true,

    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,

    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,

    "outDir": "./dist",
    "rootDir": "./src",
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "coverage", "**/*.test.ts", "**/*.spec.ts"]
}
```

### 1.2 What Each Flag Catches

| Flag | What It Prevents |
| --- | --- |
| `strict: true` | Enables all strict family flags below |
| `noImplicitAny` | `function f(x) {}` — x is implicitly `any` |
| `strictNullChecks` | `null` and `undefined` are not assignable to every type |
| `strictFunctionTypes` | Prevents unsound function parameter assignments |
| `strictBindCallApply` | Type-checks `bind`, `call`, `apply` arguments |
| `strictPropertyInitialization` | Class properties must be initialized in constructor |
| `noImplicitThis` | `this` in functions must have a known type |
| `alwaysStrict` | Emits `"use strict"` in every file |
| `noUncheckedIndexedAccess` | `arr[i]` returns `T \| undefined`, forcing bounds checks |
| `noImplicitReturns` | Every code path must return a value |
| `noImplicitOverride` | Must use `override` keyword when overriding |
| `noFallthroughCasesInSwitch` | No accidental switch fallthrough |
| `noPropertyAccessFromIndexSignature` | Forces `obj["key"]` instead of `obj.key` for index signatures |
| `exactOptionalPropertyTypes` | `{ x?: number }` means `number \| undefined`, not `number \| undefined \| missing` |
| `useUnknownInCatchVariables` | `catch (e)` — `e` is `unknown`, not `any` |
| `noUnusedLocals` | Catches AI-generated dead variables |
| `noUnusedParameters` | Catches AI-generated dead parameters |
| `verbatimModuleSyntax` | Enforces explicit `type` imports/exports |
| `isolatedModules` | Each file can be transpiled independently (required for esbuild/swc) |

### 1.3 `tsconfig.build.json` — Production Build

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "sourceMap": false,
    "declarationMap": false,
    "removeComments": false
  },
  "exclude": [
    "node_modules",
    "dist",
    "coverage",
    "**/*.test.ts",
    "**/*.spec.ts",
    "**/*.mock.ts",
    "**/tests/**",
    "**/__tests__/**",
    "**/__mocks__/**"
  ]
}
```

### 1.4 `tsconfig.test.json` — Test Configuration

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "sourceMap": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

---

## Part 2: ESLint — The Primary Enforcer

### 2.1 Installation

```bash
npm install -D eslint @eslint/js typescript-eslint \
  eslint-plugin-import eslint-plugin-unicorn \
  eslint-plugin-functional eslint-plugin-sonarjs \
  eslint-plugin-promise eslint-plugin-n \
  eslint-plugin-no-unsanitized eslint-plugin-security \
  eslint-plugin-jsdoc eslint-plugin-tsdoc \
  eslint-plugin-vitest eslint-plugin-testing-library
```

### 2.2 `eslint.config.mjs` — Full Configuration

```javascript
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import unicorn from 'eslint-plugin-unicorn';
import functional from 'eslint-plugin-functional';
import sonarjs from 'eslint-plugin-sonarjs';
import promise from 'eslint-plugin-promise';
import node from 'eslint-plugin-n';
import noUnsanitized from 'eslint-plugin-no-unsanitized';
import security from 'eslint-plugin-security';
import jsdoc from 'eslint-plugin-jsdoc';
import vitest from 'eslint-plugin-vitest';

export default tseslint.config(
  // === BASE ===
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // === MAIN CONFIG ===
  {
    plugins: {
      import: importPlugin,
      unicorn,
      functional,
      sonarjs,
      promise,
      n: node,
      'no-unsanitized': noUnsanitized,
      security,
      jsdoc,
    },

    languageOptions: {
      parserOptions: {
        projectService: true,
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
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/prefer-readonly-parameter-types': 'off',
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
      '@typescript-eslint/no-var-requires': 'error',
      '@typescript-eslint/unified-signatures': 'error',
      '@typescript-eslint/method-signature-style': ['error', 'property'],
      '@typescript-eslint/no-confusing-void-expression': 'error',
      '@typescript-eslint/no-meaningless-void-operator': 'error',
      '@typescript-eslint/no-mixed-enums': 'error',
      '@typescript-eslint/no-unnecessary-parameter-property-assignment': 'error',
      '@typescript-eslint/parameter-properties': ['error', { prefer: 'parameter-property' }],
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
      'unicorn/prefer-ternary': ['error', 'only-single-line'],
      'unicorn/no-null': 'off',
      'unicorn/prevent-abbreviations': ['error', {
        replacements: {
          args: false,
          props: false,
          ref: false,
          params: false,
        },
      }],
      'unicorn/no-useless-spread': 'error',
      'unicorn/no-useless-fallback-in-spread': 'error',
      'unicorn/prefer-modern-dom-apis': 'error',
      'unicorn/prefer-modern-math-apis': 'error',
      'unicorn/prefer-native-coercion-functions': 'error',
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
      'unicorn/no-unnecessary-polyfills': 'error',
      'unicorn/no-zero-fractions': 'error',
      'unicorn/number-literal-case': 'error',
      'unicorn/numeric-separators-style': 'error',
      'unicorn/prefer-array-find': 'error',
      'unicorn/prefer-array-flat': 'error',
      'unicorn/prefer-array-flat-map': 'error',
      'unicorn/prefer-array-index-of': 'error',
      'unicorn/prefer-array-some': 'error',
      'unicorn/prefer-at': 'error',
      'unicorn/prefer-blob-reading-methods': 'error',
      'unicorn/prefer-code-point': 'error',
      'unicorn/prefer-date-now': 'error',
      'unicorn/prefer-default-parameters': 'error',
      'unicorn/prefer-export-from': 'error',
      'unicorn/prefer-includes': 'error',
      'unicorn/prefer-logical-operator-over-ternary': 'error',
      'unicorn/prefer-math-min-max': 'error',
      'unicorn/prefer-module': 'error',
      'unicorn/prefer-negative-index': 'error',
      'unicorn/prefer-object-has-own': 'error',
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
      'sonarjs/no-one-iteration-loop': 'error',
      'sonarjs/no-use-of-empty-return-value': 'error',
      'sonarjs/non-existent-operator': 'error',

      // ============================================================
      // ERROR HANDLING
      // ============================================================
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-throw-literal': 'error',
      '@typescript-eslint/no-throw-literal': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      'promise/always-return': 'error',
      'promise/catch-or-return': 'error',
      'promise/no-nesting': 'error',
      'promise/no-promise-in-callback': 'error',
      'promise/no-return-wrap': 'error',
      'promise/param-names': 'error',
      'promise/no-return-in-finally': 'error',
      'promise/valid-params': 'error',
      'unicorn/throw-new-error': 'error',
      'unicorn/error-message': 'error',

      // ============================================================
      // IMPORTS
      // ============================================================
      'import/no-cycle': 'error',
      'import/no-self-import': 'error',
      'import/no-useless-path-segments': 'error',
      'import/no-duplicates': 'error',
      'import/no-mutable-exports': 'error',
      'import/no-named-as-default': 'error',
      'import/no-named-as-default-member': 'error',
      'import/no-extraneous-dependencies': ['error', {
        devDependencies: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**', '**/__tests__/**', '**/*.config.*'],
      }],
      'import/order': ['error', {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc' },
        pathGroups: [
          { pattern: 'node:*', group: 'builtin', position: 'before' },
          { pattern: '@/**', group: 'internal', position: 'after' },
        ],
      }],
      'import/no-default-export': 'error',
      'import/no-anonymous-default-export': 'error',
      'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],

      // ============================================================
      // NODE.JS SPECIFIC
      // ============================================================
      'n/no-process-exit': 'error',
      'n/no-deprecated-api': 'error',
      'n/no-missing-import': 'error',
      'n/no-missing-require': 'error',
      'n/no-unpublished-import': 'error',
      'n/no-unpublished-require': 'error',
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
      'n/no-sync': ['error', { allowAtRootLevel: true }],
      'n/prefer-node-protocol': 'error',

      // ============================================================
      // SECURITY
      // ============================================================
      'no-unsanitized/property': 'error',
      'no-unsanitized/method': 'error',
      'security/detect-child-process': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-no-csrf-before-method-override': 'error',
      'security/detect-non-literal-fs-filename': 'warn',
      'security/detect-non-literal-regexp': 'warn',
      'security/detect-non-literal-require': 'warn',
      'security/detect-object-injection': 'off',
      'security/detect-possible-timing-attacks': 'error',
      'security/detect-pseudoRandomBytes': 'error',
      'security/detect-unsafe-regex': 'error',

      // ============================================================
      // DOCUMENTATION
      // ============================================================
      'jsdoc/require-jsdoc': ['error', {
        require: {
          ClassDeclaration: true,
          MethodDefinition: true,
          FunctionDeclaration: true,
        },
        checkConstructors: false,
        checkGetters: false,
        checkSetters: false,
      }],
      'jsdoc/require-description': 'error',
      'jsdoc/require-param': 'error',
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-param-type': 'off',
      'jsdoc/require-returns': 'error',
      'jsdoc/require-returns-description': 'error',
      'jsdoc/check-param-names': 'error',
      'jsdoc/check-tag-names': 'error',
      'jsdoc/check-types': 'error',
      'jsdoc/no-types': 'error',
      'jsdoc/require-throws': 'warn',

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

  // === TEST FILES ===
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**', '**/__tests__/**'],
    plugins: { vitest },
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
      ...vitest.configs.recommended.rules,
      'vitest/expect-expect': 'error',
      'vitest/no-commented-out-tests': 'error',
      'vitest/no-conditional-expect': 'error',
      'vitest/no-conditional-in-test': 'error',
      'vitest/no-disabled-tests': 'error',
      'vitest/no-focused-tests': 'error',
      'vitest/no-identical-title': 'error',
      'vitest/no-interpolation-in-snapshots': 'error',
      'vitest/no-mocks-import': 'error',
      'vitest/no-standalone-expect': 'error',
      'vitest/no-test-prefixes': 'error',
      'vitest/no-test-return-statement': 'error',
      'vitest/prefer-called-with': 'error',
      'vitest/prefer-comparison-matcher': 'error',
      'vitest/prefer-each': 'error',
      'vitest/prefer-equality-matcher': 'error',
      'vitest/prefer-expect-resolves': 'error',
      'vitest/prefer-hooks-in-order': 'error',
      'vitest/prefer-hooks-on-top': 'error',
      'vitest/prefer-mock-promise-shorthand': 'error',
      'vitest/prefer-spy-on': 'error',
      'vitest/prefer-strict-equal': 'error',
      'vitest/prefer-to-be': 'error',
      'vitest/prefer-to-be-falsy': 'error',
      'vitest/prefer-to-be-object': 'error',
      'vitest/prefer-to-be-truthy': 'error',
      'vitest/prefer-to-contain': 'error',
      'vitest/prefer-to-have-length': 'error',
      'vitest/prefer-todo': 'error',
      'vitest/require-hook': 'error',
      'vitest/require-to-throw-message': 'error',
      'vitest/require-top-level-describe': 'error',
      'vitest/valid-describe-callback': 'error',
      'vitest/valid-expect': 'error',
      'vitest/valid-title': 'error',
    },
  },

  // === CONFIG FILES ===
  {
    files: ['**/*.config.*', '**/*.mjs', '**/*.cjs'],
    rules: {
      'import/no-default-export': 'off',
      'n/no-unpublished-import': 'off',
      'jsdoc/require-jsdoc': 'off',
    },
  },

  // === IGNORES ===
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '*.d.ts'],
  },
);
```

---

## Part 3: Prettier — Formatting

### `prettier.config.mjs`

```javascript
export default {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  arrowParens: 'always',
  endOfLine: 'lf',
  bracketSpacing: true,
  bracketSameLine: false,
  proseWrap: 'always',
  overrides: [
    {
      files: '*.json',
      options: { printWidth: 200 },
    },
    {
      files: '*.md',
      options: { proseWrap: 'always', printWidth: 80 },
    },
  ],
  plugins: [],
};
```

### `.prettierignore`

```
dist/
node_modules/
coverage/
package-lock.json
pnpm-lock.yaml
*.min.js
*.min.css
```

---

## Part 4: Dead Code & Dependency Analysis

### 4.1 Knip — Unused Files, Exports, Dependencies

```bash
npm install -D knip
```

**`knip.json`:**

```json
{
  "$schema": "https://unpkg.com/knip@5/schema.json",
  "entry": ["src/main.ts", "src/index.ts"],
  "project": ["src/**/*.ts"],
  "ignore": ["src/**/*.test.ts", "src/**/*.spec.ts", "src/**/*.d.ts"],
  "ignoreDependencies": [],
  "ignoreBinaries": [],
  "ignoreExportsUsedInFile": true,
  "compilers": {
    "css": "(input) => ''",
    "scss": "(input) => ''"
  },
  "rules": {
    "classMembers": "error",
    "enumMembers": "error",
    "types": "error",
    "duplicates": "error",
    "exports": "error",
    "files": "error",
    "dependencies": "error",
    "devDependencies": "error",
    "unlisted": "error",
    "unresolved": "error"
  }
}
```

### 4.2 ts-prune — Unused Exports (Lighter Alternative)

```bash
npm install -D ts-prune
```

```bash
npx ts-prune --project tsconfig.json --error
```

### 4.3 madge — Circular Dependencies

```bash
npm install -D madge
```

```bash
npx madge --circular --extensions ts,tsx src/
npx madge --circular --extensions ts,tsx --warning src/
```

### 4.4 dependency-cruiser — Architectural Boundaries

```bash
npm install -D dependency-cruiser
npx depcruise --init
```

**`.dependency-cruiser.cjs`:**

```javascript
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make code unpredictable and hard to test.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Orphan files are dead code. Delete them.',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '\\.config\\.',
          '\\.test\\.',
          '\\.spec\\.',
          'index\\.ts$',
        ],
      },
      to: {},
    },
    {
      name: 'no-deprecated-core',
      severity: 'warn',
      from: {},
      to: { dependencyTypes: ['core'], path: '^(punycode|domain|constants|sys|_linklist)$' },
    },
    {
      name: 'no-deprecated-npm',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['deprecated'] },
    },
    {
      name: 'no-non-package-json',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['no-package-json'] },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment: 'Production code must not import devDependencies.',
      from: {
        path: '^(src)',
        pathNot: ['\\.(spec|test)\\.ts$', '__tests__', '__mocks__'],
      },
      to: { dependencyTypes: ['npm-dev'] },
    },
    // === ARCHITECTURAL BOUNDARIES ===
    {
      name: 'controllers-must-not-import-repositories-directly',
      severity: 'error',
      comment: 'Controllers go through services. No direct DB access.',
      from: { path: '^src/(controllers|routes|handlers)' },
      to: { path: '^src/(repositories|dal|db)' },
    },
    {
      name: 'domain-must-not-import-infrastructure',
      severity: 'error',
      comment: 'Domain layer must be pure. No HTTP, DB, or framework imports.',
      from: { path: '^src/domain' },
      to: { path: '^src/(infrastructure|framework|adapters)' },
    },
    {
      name: 'services-must-not-import-controllers',
      severity: 'error',
      from: { path: '^src/services' },
      to: { path: '^src/(controllers|routes|handlers)' },
    },
    {
      name: 'no-external-to-internal',
      severity: 'error',
      comment: 'Shared libraries must not import application code.',
      from: { path: '^src/lib' },
      to: { path: '^src/(controllers|services|routes|handlers)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      dot: { collapsePattern: 'node_modules' },
      archi: { collapsePattern: '^(src|lib|test)' },
    },
  },
};
```

---

## Part 5: Node.js Specific Guardrails

### 5.1 `package.json` — Engine & Module Configuration

```json
{
  "name": "@yourorg/your-service",
  "version": "1.0.0",
  "type": "module",
  "engines": {
    "node": ">=22.0.0",
    "npm": ">=10.0.0"
  },
  "packageManager": "npm@10.8.0",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      }
    },
    "./package.json": "./package.json"
  },
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsx watch src/main.ts",
    "start": "node dist/main.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint . --max-warnings=0",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --noEmit",
    "knip": "knip",
    "deps:circular": "madge --circular --extensions ts src/",
    "deps:boundaries": "depcruise src/ --output-type err",
    "deps:audit": "npm audit --audit-level=high",
    "deps:unused": "knip --include dependencies",
    "quality": "npm run typecheck && npm run lint && npm run format:check && npm run knip && npm run deps:circular && npm run test:coverage",
    "prepare": "husky"
  },
  "dependencies": {
    "fastify": "^5.0.0",
    "zod": "^3.23.0",
    "pino": "^9.0.0",
    "pino-http": "^10.0.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0",
    "@vitest/coverage-v8": "^2.1.0",
    "eslint": "^9.12.0",
    "prettier": "^3.3.0",
    "husky": "^9.1.0",
    "lint-staged": "^15.2.0",
    "knip": "^5.30.0",
    "madge": "^8.0.0",
    "dependency-cruiser": "^16.4.0",
    "@commitlint/cli": "^19.5.0",
    "@commitlint/config-conventional": "^19.5.0"
  }
}
```

### 5.2 `.nvmrc` / `.node-version`

```
22
```

### 5.3 `.npmrc`

```ini
engine-strict=true
save-exact=true
audit-level=high
fund=false
loglevel=warn
```

### 5.4 Environment Variable Validation

```typescript
// src/config/env.ts
import { z } from 'zod';

/**
 * Validates and parses all environment variables at startup.
 * Fails fast if any required variable is missing or invalid.
 * NEVER use process.env directly elsewhere in the codebase.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRY: z.string().default('15m'),

  CORS_ORIGINS: z.string().default('*').transform((v) => v.split(',')),

  FORCE_SSL: z.coerce.boolean().default(false),

  // External services
  EXCHANGE_API_KEY: z.string().optional(),
  EXCHANGE_API_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env: Readonly<Env> = Object.freeze(parsed.data);
```

### 5.5 Process Management

```typescript
// src/main.ts
import { env } from './config/env.js';
import { createApp } from './app.js';
import { logger } from './lib/logger.js';

const app = await createApp();

const server = app.listen({ port: env.PORT, host: env.HOST }, () => {
  logger.info(`Server listening on ${env.HOST}:${env.PORT} (${env.NODE_ENV})`);
});

// Graceful shutdown
const shutdown = async (signal: string): Promise<void> => {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  const timeout = setTimeout(() => {
    logger.error('Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 30_000);

  try {
    await app.close();
    logger.info('Server closed. Exiting.');
    clearTimeout(timeout);
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    clearTimeout(timeout);
    process.exit(1);
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Catch unhandled errors
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  void shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled rejection');
  void shutdown('unhandledRejection');
});
```

### 5.6 Structured Logging

```typescript
// src/lib/logger.ts
import { pino } from 'pino';
import { env } from '../config/env.js';

/**
 * Application-wide structured JSON logger.
 * Use this everywhere. NEVER use console.log.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['req.headers.authorization', 'password', 'secret', 'token', 'apiKey'],
    censor: '[REDACTED]',
  },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

export type Logger = pino.Logger;
```

### 5.7 Runtime Validation (Zod)

```typescript
// src/schemas/order.schema.ts
import { z } from 'zod';

/**
 * Validation schema for creating an order.
 * Used at the API boundary. All input is untrusted.
 */
export const createOrderSchema = z.object({
  symbol: z.string().min(1).max(20),
  side: z.enum(['BUY', 'SELL']),
  orderType: z.enum(['LIMIT', 'MARKET', 'SL', 'SL-M']),
  quantity: z.number().int().positive(),
  price: z.number().positive().optional(),
  productType: z.enum(['CNC', 'MIS', 'NRML']).default('MIS'),
  tag: z.string().max(50).optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/**
 * Validation schema for order query parameters.
 */
export const orderQuerySchema = z.object({
  status: z.enum(['OPEN', 'FILLED', 'CANCELLED', 'REJECTED']).optional(),
  symbol: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(['createdAt', 'price', 'quantity']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type OrderQuery = z.infer<typeof orderQuerySchema>;
```

### 5.8 Error Handling

```typescript
// src/errors/app-error.ts

/**
 * Base application error. All domain errors extend this.
 * Includes an HTTP status code and a machine-readable error code.
 */
export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;
  readonly isOperational: boolean = true;
  readonly context: Record<string, unknown>;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON(): Record<string, unknown> {
    return {
      error: {
        message: this.message,
        code: this.code,
        context: this.context,
      },
    };
  }
}

/** 400 — Invalid input. */
export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly code = 'VALIDATION_ERROR';
}

/** 401 — Not authenticated. */
export class UnauthorizedError extends AppError {
  readonly statusCode = 401;
  readonly code = 'UNAUTHORIZED';
}

/** 403 — Not authorized. */
export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly code = 'FORBIDDEN';
}

/** 404 — Resource not found. */
export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';
}

/** 409 — Conflict. */
export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = 'CONFLICT';
}

/** 422 — Business rule violation. */
export class BusinessRuleError extends AppError {
  readonly statusCode = 422;
  readonly code = 'BUSINESS_RULE_VIOLATION';
}

/** 429 — Rate limited. */
export class RateLimitError extends AppError {
  readonly statusCode = 429;
  readonly code = 'RATE_LIMITED';
}

/** 500 — Unexpected internal error. */
export class InternalError extends AppError {
  readonly statusCode = 500;
  readonly code = 'INTERNAL_ERROR';
  override readonly isOperational = false;
}

/** 503 — Service unavailable. */
export class ServiceUnavailableError extends AppError {
  readonly statusCode = 503;
  readonly code = 'SERVICE_UNAVAILABLE';
}
```

---

## Part 6: Testing Guardrails

### 6.1 Vitest Configuration

**`vitest.config.ts`:**

```typescript
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/*.d.ts',
        'src/main.ts',
        'src/config/**',
        'src/types/**',
      ],
      thresholds: {
        global: {
          branches: 80,
          functions: 85,
          lines: 85,
          statements: 85,
        },
        perFile: true,
      },
    },
    testTimeout: 10_000,
    hookTimeout: 10_000,
    sequence: {
      shuffle: true,
    },
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

### 6.2 Test Conventions

```typescript
// src/services/create-order.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreateOrder } from './create-order.js';
import { ValidationError } from '../errors/app-error.js';
import type { OrderRepository } from '../repositories/order.repository.js';
import type { FeeCalculator } from './fee-calculator.js';

describe('CreateOrder', () => {
  let orderRepo: OrderRepository;
  let feeCalculator: FeeCalculator;
  let createOrder: CreateOrder;

  beforeEach(() => {
    orderRepo = {
      save: vi.fn().mockResolvedValue({ id: 'order-1' }),
      findById: vi.fn(),
    } as unknown as OrderRepository;

    feeCalculator = {
      calculate: vi.fn().mockReturnValue({ total: 100n, brokerage: 20n }),
    } as unknown as FeeCalculator;

    createOrder = new CreateOrder({ orderRepo, feeCalculator });
  });

  describe('when input is valid', () => {
    const validInput = {
      symbol: 'NIFTY24JUL18500CE',
      side: 'BUY' as const,
      orderType: 'LIMIT' as const,
      quantity: 25,
      price: 18500.05,
    };

    it('creates an order and returns the result', async () => {
      const result = await createOrder.execute(validInput);

      expect(result.order.id).toBe('order-1');
      expect(orderRepo.save).toHaveBeenCalledOnce();
    });

    it('calculates fees', async () => {
      await createOrder.execute(validInput);

      expect(feeCalculator.calculate).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: 'NIFTY24JUL18500CE' }),
      );
    });
  });

  describe('when quantity is not a valid lot size', () => {
    it('throws ValidationError', async () => {
      const invalidInput = {
        symbol: 'NIFTY24JUL18500CE',
        side: 'BUY' as const,
        orderType: 'LIMIT' as const,
        quantity: 30, // Not a multiple of 25
        price: 18500.05,
      };

      await expect(createOrder.execute(invalidInput)).rejects.toThrow(ValidationError);
    });
  });
});
```

---

## Part 7: Docker for Node.js

### 7.1 Dockerfile — Multi-Stage, Non-Root, Minimal

**`docker/Dockerfile`:**

```dockerfile
# ============================================================
# Stage 1: Install dependencies
# ============================================================
FROM node:22-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ============================================================
# Stage 2: Build
# ============================================================
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/

RUN npm run build

# ============================================================
# Stage 3: Production runtime
# ============================================================
FROM node:22-slim AS production

# Security: non-root user
RUN groupadd -r appuser && useradd -r -g appuser -d /app appuser

# Install tini for proper signal handling
RUN apt-get update && \
    apt-get install -y --no-install-recommends tini curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy production dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy built output
COPY --from=builder /app/dist ./dist

# Copy package.json for module resolution
COPY package.json ./

# Set ownership
RUN chown -R appuser:appuser /app

USER appuser

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health/live || exit 1

# Use tini as PID 1
ENTRYPOINT ["tini", "--"]

CMD ["node", "dist/main.js"]
```

### 7.2 `.dockerignore`

```
.git
.github
node_modules
dist
coverage
*.log
.env
.env.*
!.env.example
docker-compose*.yml
Dockerfile*
.docker/
*.md
!README.md
.vscode
.idea
.cursorrules
CLAUDE.md
*.test.ts
*.spec.ts
tests/
__tests__/
__mocks__/
.eslintcache
```

### 7.3 Docker Compose

```yaml
version: "3.9"

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: app
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    volumes:
      - pg_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

  api:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/app
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET}
      LOG_LEVEL: info
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: "2.0"
          memory: 512M
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health/live"]
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3

volumes:
  pg_data:
```

---

## Part 8: Git Hooks & CI

### 8.1 Husky + lint-staged

```bash
npm install -D husky lint-staged
npx husky init
```

**`.husky/pre-commit`:**

```bash
npx lint-staged
npx tsc --noEmit
```

**`.husky/pre-push`:**

```bash
npm run test:coverage
npm run knip
npm run deps:circular
```

**`.husky/commit-msg`:**

```bash
npx commitlint --edit $1
```

**`package.json` lint-staged config:**

```json
{
  "lint-staged": {
    "*.{ts,tsx,mts,cts}": [
      "eslint --max-warnings=0 --fix",
      "prettier --write"
    ],
    "*.{js,mjs,cjs,json,md,yml,yaml}": [
      "prettier --write"
    ]
  }
}
```

### 8.2 Commit Lint

**`commitlint.config.mjs`:**

```javascript
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', [
      'feat', 'fix', 'docs', 'style', 'refactor',
      'perf', 'test', 'chore', 'revert', 'ci', 'build',
    ]],
    'subject-max-length': [2, 'always', 72],
    'body-max-line-length': [2, 'always', 100],
    'subject-empty': [2, 'never'],
    'type-empty': [2, 'never'],
  },
};
```

### 8.3 GitHub Actions CI

**`.github/workflows/quality.yml`:**

```yaml
name: TypeScript Quality

on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  typecheck:
    name: Type Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npx tsc --noEmit

  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npx eslint . --max-warnings=0 --format json --output-file eslint-report.json
      - run: npx prettier --check .
      - name: Upload ESLint report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: eslint-report
          path: eslint-report.json

  dead-code:
    name: Dead Code & Dependencies
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npx knip --no-progress
      - run: npx madge --circular --extensions ts src/
      - run: npx depcruise src/ --output-type err

  security:
    name: Security
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npm audit --audit-level=high
      - name: Socket.dev check
        uses: socketdev/socket-action@v1
        if: github.event_name == 'pull_request'

  test:
    name: Tests
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        ports: ["5432:5432"]
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7
        ports: ["6379:6379"]
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npx vitest run --coverage
      - name: Check coverage
        run: |
          COVERAGE=$(node -e "const c=require('./coverage/coverage-summary.json'); console.log(c.total.lines.pct)")
          echo "Coverage: ${COVERAGE}%"
          if (( $(echo "$COVERAGE < 85" | bc -l) )); then
            echo "::error::Coverage ${COVERAGE}% below 85%"
            exit 1
          fi

  docker:
    name: Docker Build
    runs-on: ubuntu-latest
    needs: [typecheck, lint, dead-code, security, test]
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - name: Build
        uses: docker/build-push-action@v6
        with:
          context: .
          file: docker/Dockerfile
          push: false
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - name: Trivy scan
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: 'local/app:latest'
          format: 'sarif'
          output: 'trivy-results.sarif'
          severity: 'CRITICAL,HIGH'
          exit-code: '1'

  commit-lint:
    name: Commit Messages
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: wagoid/commitlint-github-action@v6
```

---

## Part 9: AI Rules File

### `.cursorrules` / `CLAUDE.md`

```markdown
# TypeScript & Node.js Engineering Standards

## Language & Runtime
- TypeScript 5.6+, Node.js 22+, ESM only (`"type": "module"`).
- `strict: true` in tsconfig. No exceptions.
- NEVER use `any`. Use `unknown` + type guards.
- NEVER use `@ts-ignore` or `@ts-expect-error` without a comment explaining why.
- Use `import type` for type-only imports.
- Use `node:` prefix for Node.js builtins (`import { readFile } from 'node:fs/promises'`).
- Use `.js` extension in relative imports (ESM requirement).

## Code Style
- Named exports only. NEVER default exports.
- Prefer `interface` for object shapes, `type` for unions/intersections.
- Prefer `const` over `let`. NEVER `var`.
- Prefer `===` over `==`. Always.
- Prefer template literals over string concatenation.
- Prefer optional chaining (`?.`) and nullish coalescing (`??`).
- Prefer `Array.prototype.find` over `filter()[0]`.
- Prefer `for...of` over `forEach` when you need `break`/`return`.
- Prefer early returns (guard clauses) over nested if/else.
- Max function length: 30 lines. Max file length: 300 lines.
- Max nesting depth: 3. Max parameters: 4.
- Max cyclomatic complexity: 10.

## Naming
- Variables/functions: camelCase.
- Classes/types/interfaces/enums: PascalCase.
- Constants: UPPER_SNAKE_CASE.
- Enum members: UPPER_SNAKE_CASE.
- Booleans: prefix with `is`, `has`, `should`, `can`.
- No abbreviations except: id, url, db, io, http, api.
- No generic names: data, temp, stuff, thing, item, obj, val, result, args, params, options.
- Interfaces: NO `I` prefix. `UserService`, not `IUserService`.

## Error Handling
- Custom error classes extending a base `AppError`.
- Include HTTP status code and machine-readable error code.
- Include context in the error (what failed, with what input).
- NEVER `throw "string"`. ALWAYS `throw new SomeError(...)`.
- NEVER empty catch blocks.
- NEVER swallow errors silently.
- Use `unknown` in catch, not `any`. Narrow with type guards.
- Handle errors at the boundary (controller/route handler).
- Use Result pattern for expected failures. Exceptions for unexpected failures.

## Async
- ALWAYS `async/await`. NEVER raw `.then()` chains.
- ALWAYS handle floating promises (`void` prefix or `await`).
- NEVER use `Promise.all` without considering partial failure.
  Use `Promise.allSettled` when partial failure is acceptable.
- ALWAYS set timeouts on external HTTP calls.
- ALWAYS implement retry with exponential backoff for transient failures.

## Node.js Specific
- Use `node:` prefix for builtins.
- Use `fs/promises`, not callback-based `fs`.
- NEVER use `process.exit()` in library code. Only in entry point.
- NEVER use synchronous fs/path/crypto in request handlers.
- Use `structuredClone()` for deep copies, not `JSON.parse(JSON.stringify())`.
- Use `crypto.randomUUID()` for IDs, not `Math.random()`.
- Use `AbortController` for cancellable operations.
- Validate ALL environment variables at startup with Zod.
- Use structured JSON logging (pino). NEVER `console.log` in production.
- Graceful shutdown: handle SIGTERM, SIGINT. Drain connections.

## Architecture
- Dependency direction: controllers → services → repositories → database.
- Domain layer: pure TypeScript. No framework imports. No I/O.
- Infrastructure layer: database, HTTP clients, message queues.
- Inject dependencies via constructor. NEVER instantiate inside a class.
- One concept per file. File name matches primary export.
- No circular dependencies. Ever.
- No god files (> 300 lines). No god functions (> 30 lines).

## Testing
- Vitest. Coverage: 85% minimum.
- Test behavior, not implementation.
- Use `vi.fn()` for mocks. Use `vi.mock()` for modules.
- Name tests: "should [expected behavior] when [condition]".
- Max 2 assertions per test. Max 3 nesting levels.
- Use `describe` blocks to group related tests.
- Test edge cases: empty input, null, undefined, boundary values.
- Test error paths: what happens when things fail?

## What To NEVER Generate
- `any` type
- `@ts-ignore` without explanation
- Default exports
- `var` declarations
- `console.log` in production code
- `process.exit()` in library code
- Synchronous fs/path operations in handlers
- `JSON.parse(JSON.stringify())` for deep copy
- `Math.random()` for IDs
- Empty catch blocks
- `throw "string"`
- Raw `.then()` chains
- Circular imports
- God files (> 300 lines)
- God functions (> 30 lines)
- Unused imports, variables, parameters
- Magic numbers without named constants
- Comments that describe WHAT (code explains WHAT)
- TODO/FIXME without issue number
- `enum` (prefer `as const` objects or union types)
- `namespace` (use modules)
- `require()` (use `import`)
- `module.exports` (use `export`)
- Callback-style APIs (use Promises)
- `arguments` object (use rest parameters)
- `Function` type (use specific signatures)
- `Object` type (use `Record<string, unknown>` or specific interface)
- `{}` type (use `Record<string, never>` or specific interface)
```

---

## Part 10: The Complete Enforcement Stack

```
┌──────────────────────────────────────────────────────────────────┐
│                     AI GENERATES CODE                             │
│  .cursorrules / CLAUDE.md → TypeScript strict, Node.js ESM,      │
│  naming, error handling, architecture, testing conventions        │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                     EDITOR (VS Code / Cursor)                     │
│  .editorconfig → formatting                                       │
│  TypeScript language server → inline type errors                  │
│  ESLint extension → inline lint errors                            │
│  Prettier extension → format on save                              │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                     PRE-COMMIT (Husky + lint-staged)              │
│  ESLint --fix → auto-fix style + complexity                       │
│  Prettier --write → formatting                                    │
│  tsc --noEmit → type check                                        │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                     PRE-PUSH (Husky)                              │
│  Vitest --coverage → all tests + 85% gate                         │
│  Knip → dead code, unused exports, unused deps                    │
│  madge → circular dependency check                                │
│  dependency-cruiser → architectural boundary check                │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                     CI (GitHub Actions)                           │
│  All of the above + npm audit + Socket.dev + Trivy                │
│  Commit message lint → conventional commits                       │
│  Docker build + image scan                                        │
│  Coverage gate: 85% lines, 80% branches                           │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                     DOCKER BUILD                                  │
│  Multi-stage: deps → build → production (node:22-slim)            │
│  Non-root user (appuser)                                          │
│  tini as PID 1                                                    │
│  HEALTHCHECK instruction                                          │
│  npm ci --omit=dev (no dev deps in production)                    │
│  .dockerignore excludes tests, docs, configs                      │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                     RUNTIME                                       │
│  Zod env validation at startup (fail fast)                        │
│  Pino structured JSON logging                                     │
│  Graceful shutdown (SIGTERM, SIGINT)                              │
│  Uncaught exception / unhandled rejection handlers                │
│  Health checks: /health/live, /health/ready                       │
│  Rate limiting, CORS, Helmet (security headers)                   │
│  Request ID propagation                                           │
│  Zod validation at API boundary                                   │
│  Custom error hierarchy with status codes                         │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                     HUMAN REVIEW                                  │
│  Is there any `any`? (NEVER)                                      │
│  Is there any unused code? (YAGNI)                                │
│  Does each function do one thing? (SRP)                           │
│  Are errors handled at boundaries?                                │
│  Are async operations properly awaited?                           │
│  Are external calls wrapped with timeout + retry?                 │
│  Would a new dev understand this in 5 minutes?                    │
│  Is the Docker image minimal and secure?                          │
└──────────────────────────────────────────────────────────────────┘
```

---

## Part 11: Quick-Start Bootstrap

```bash
#!/bin/bash
# bootstrap-typescript-guardrails.sh
set -euo pipefail

echo "=== Bootstrapping TypeScript + Node.js Guardrails ==="

# 1. Initialize project
npm init -y

# 2. TypeScript
npm install -D typescript tsx
npx tsc --init

# 3. ESLint + plugins
npm install -D eslint @eslint/js typescript-eslint \
  eslint-plugin-import eslint-plugin-unicorn \
  eslint-plugin-functional eslint-plugin-sonarjs \
  eslint-plugin-promise eslint-plugin-n \
  eslint-plugin-no-unsanitized eslint-plugin-security \
  eslint-plugin-jsdoc eslint-plugin-vitest

# 4. Prettier
npm install -D prettier

# 5. Testing
npm install -D vitest @vitest/coverage-v8

# 6. Dead code & deps
npm install -D knip madge dependency-cruiser

# 7. Git hooks
npm install -D husky lint-staged @commitlint/cli @commitlint/config-conventional
npx husky init

# 8. Runtime
npm install fastify zod pino pino-http

# 9. Docker
mkdir -p docker

# 10. Configs
echo "→ Create: tsconfig.json, eslint.config.mjs, prettier.config.mjs"
echo "→ Create: vitest.config.ts, knip.json, .dependency-cruiser.cjs"
echo "→ Create: .editorconfig, .prettierignore, .dockerignore"
echo "→ Create: .cursorrules / CLAUDE.md"
echo "→ Create: docker/Dockerfile, docker-compose.yml"
echo "→ Create: .github/workflows/quality.yml"
echo "→ Create: commitlint.config.mjs"

echo ""
echo "=== Done ==="
echo "Run: npx tsc --noEmit && npx eslint . && npx vitest run --coverage"
```

---

## Final Principle

TypeScript's type system is the most powerful automated guardrail you have. Every `strict` flag, every `no-unsafe-*` rule, every `no-explicit-any` error is a mechanical proof that the code does what it claims. When the compiler passes with zero errors and zero warnings, you have a mathematical guarantee that entire categories of bugs do not exist in your code.

ESLint catches what the compiler cannot: complexity, naming, dead code, architectural violations, security anti-patterns. Knip catches what ESLint cannot: unused files, unused exports, unused dependencies. dependency-cruiser catches what no single-file tool can: circular dependencies, boundary violations, orphan modules.

The Docker build catches what no local tool can: missing production dependencies, bloated images, root-user security holes. The CI pipeline catches what no pre-commit hook can: coverage regressions, CVEs in dependencies, broken builds on a clean machine.

And the human reviewer catches what no tool can: a design that compiles, lints, tests, and deploys perfectly — but solves the wrong problem.

Every layer is a net. The code that reaches production has passed through all of them. That is how you maintain quality in a TypeScript codebase not for a sprint, but for years.
