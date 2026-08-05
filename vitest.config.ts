import { cpus } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    testTimeout: 15_000,
    // Tearing down a suite is real work -- sync-daemon.test.ts stops three daemons and an
    // HTTP/WebSocket stub per test -- and the 10s default cut that short on CI, which
    // surfaces as "Hook timed out" plus whatever the half-stopped daemons go on to do.
    hookTimeout: 30_000,
    // Several daemon/mcp-server integration tests spawn real daemon child processes;
    // running too many test files in parallel starves those processes of CPU and
    // trips their internal timeouts. Cap fork concurrency to keep them reliable.
    //
    // Half the cores, because each of those forks is itself several processes (daemons,
    // chokidar watchers, git plumbing) rather than one. A flat 4 was headroom on a dev
    // machine and a 4-way oversubscription on a 4-vCPU CI runner, where the same suite
    // ran 6-9x slower and timed out.
    pool: "forks",
    poolOptions: { forks: { maxForks: Math.max(1, Math.min(4, Math.floor(cpus().length / 2))) } },
    coverage: {
      provider: "v8",
      include: ["packages/**/src/**/*.ts", "apps/daemon/src/**/*.ts", "apps/service/src/**/*.ts"],
      exclude: ["**/main.ts", "**/types.ts"]
    }
  }
});
