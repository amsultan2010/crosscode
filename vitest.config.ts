import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    testTimeout: 15_000,
    // Several daemon/mcp-server integration tests spawn real daemon child processes;
    // running too many test files in parallel starves those processes of CPU and
    // trips their internal timeouts. Cap fork concurrency to keep them reliable.
    pool: "forks",
    poolOptions: { forks: { maxForks: 4 } },
    coverage: {
      provider: "v8",
      include: ["packages/**/src/**/*.ts", "apps/daemon/src/**/*.ts", "apps/service/src/**/*.ts"],
      exclude: ["**/main.ts", "**/types.ts"]
    }
  }
});
