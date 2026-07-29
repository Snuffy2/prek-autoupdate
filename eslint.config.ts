import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**", "rollup.config.mjs"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["src/update/index.ts"],
    rules: {
      "no-control-regex": "off",
      "preserve-caught-error": "off",
    },
  },
  prettier,
);
