import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json", "lcov"],
      thresholds: {
        branches: 70,
        functions: 65,
        lines: 65,
        statements: 65,
      },
    },
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
  },
});
