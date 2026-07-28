import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["packages/**/src/**/*.ts", "apps/daemon/src/**/*.ts", "apps/service/src/**/*.ts"],
      exclude: ["**/main.ts", "**/types.ts"]
    }
  }
});
