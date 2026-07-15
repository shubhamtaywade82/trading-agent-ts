/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  setupFiles: ["<rootDir>/tests/jest.setup.js"],
  extensionsToTreatAsEsm: [".ts", ".tsx"],
  // Source imports use explicit .js extensions (required for the real ESM
  // build); strip them back off so Jest's resolver finds the .ts source.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        // Transpile-only: type errors from the @jest/globals vs @types/jest
        // ambient-type overlap (see tests/jest.setup.js) shouldn't block test
        // execution — `tsc --noEmit` on the real tsconfig is the actual type
        // gate (see package.json build/lint scripts), this is just runtime.
        isolatedModules: true,
        diagnostics: {
          ignoreCodes: [151002],
        },
      },
    ],
  },
};
