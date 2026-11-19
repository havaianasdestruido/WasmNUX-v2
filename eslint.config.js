// Flat ESLint config (ROADMAP §8 `npm run lint`).
// Type-aware rules are intentionally out of scope: `npm run typecheck` owns
// type safety; lint catches correctness smells tsc misses.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "benchmarks/results/**",
      "docs/**",
      "web/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "smart"],
      "no-throw-literal": "error",
      // spike/bench harnesses use definite-assignment and non-null assertions
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
);
