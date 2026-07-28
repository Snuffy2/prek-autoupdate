import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import ts from "typescript";

const typescript = {
  name: "typescript",
  resolveId(source, importer) {
    if (importer && source.startsWith(".") && source.endsWith(".js")) {
      const typescriptPath = resolve(
        dirname(importer),
        source.replace(/\.js$/, ".ts"),
      );
      if (existsSync(typescriptPath)) {
        return typescriptPath;
      }
    }
    return null;
  },
  transform(code, id) {
    if (!id.endsWith(".ts")) {
      return null;
    }

    return {
      code: ts.transpileModule(code, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2024,
        },
        fileName: id,
      }).outputText,
      map: null,
    };
  },
};

const stripTrailingWhitespace = {
  name: "strip-trailing-whitespace",
  renderChunk(code) {
    return code.replace(/[ \t]+$/gmu, "");
  },
};

/** @type {import("rollup").RollupOptions} */
const config = {
  input: "src/index.ts",
  output: {
    file: "dist/index.js",
    format: "esm",
    inlineDynamicImports: true,
    sourcemap: false,
  },
  plugins: [
    nodeResolve({ preferBuiltins: true }),
    commonjs(),
    typescript,
    stripTrailingWhitespace,
  ],
};

export default config;
