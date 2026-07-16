module.exports = {
  root: true,
  extends: ["universe/native", "universe/web"],
  ignorePatterns: ["build"],
  env: { node: true },
  overrides: [
    {
      // Type-aware linting for src/ only (ARCHITECTURE.md §11 task 11: robustness sweep —
      // no `void somePromise()` without a rejection handler anywhere in the package).
      files: ["src/**/*.ts", "src/**/*.tsx"],
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: __dirname,
      },
      rules: {
        "@typescript-eslint/no-floating-promises": "error",
      },
    },
  ],
};
