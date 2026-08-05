import { defineConfig } from "vitest/config";

// The engine's tests drive real git checkouts through real plumbing, so they are slower
// than a unit test and they fork rather than share a worker.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { maxForks: 4 } }
  }
});
