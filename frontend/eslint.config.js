import tsParser from "@typescript-eslint/parser";
import noUnsanitized from "eslint-plugin-no-unsanitized";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src/wasm/pkg/**",
      "src/miner_wasm/pkg/**",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      "no-unsanitized": noUnsanitized,
    },
    rules: {
      "no-unsanitized/method": "error",
      "no-unsanitized/property": "error",
    },
  },
];
