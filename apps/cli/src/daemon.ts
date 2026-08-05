import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolveGitPath } from "@crosscode/git";
import { z } from "zod";
import { syncStatusSchema, type SyncStatus } from "../../../packages/protocol/src/sync.js";
import { CliError } from "./errors.js";

/**
 * The daemon, as a narrow interface: one per checkout, started by `crosscode start`, stopped
 * by `crosscode stop`, and asked for the contract's `syncStatus` by `crosscode status`.
 *
 * The daemon is being written in parallel. The contract fixes what `status` returns
 * (`syncStatusSchema`) but says nothing about how a CLI reaches a daemon on the same
 * machine, so everything below the interface is a STUB of that workstream's local API:
 * a handshake file at `<git dir>/crosscode/daemon.json` holding `{ pid, port }`, and
 * `GET /status` / `POST /stop` on that port bound to loopback.
 */

export type DaemonControl = {
  /** Idempotent: a daemon already running for this checkout is left alone. */
  start(): Promise<{ alreadyRunning: boolean; pid: number }>;
  stop(): Promise<{ wasRunning: boolean }>;
  status(): Promise<SyncStatus>;
};

/** STUB: handshake file shape is not described by the wire contract. */
const handshakeSchema = z.object({ pid: z.number().int().positive(), port: z.number().int().positive() }).strict();
type Handshake = z.infer<typeof handshakeSchema>;

export function localDaemon(repoRoot: string, fetchImpl: typeof fetch = fetch): DaemonControl {
  const handshakePath = () => resolveGitPath(repoRoot, "crosscode/daemon.json");

  async function running(): Promise<Handshake | undefined> {
    const path = await handshakePath();
    const contents = await readFile(path, "utf8").catch(() => undefined);
    if (contents === undefined) return undefined;
    const parsed = handshakeSchema.safeParse(JSON.parse(contents));
    if (!parsed.success) return undefined;
    // A handshake file outliving its process is the normal aftermath of a crash or a reboot,
    // so liveness is the pid, not the file.
    try {
      process.kill(parsed.data.pid, 0);
    } catch {
      await rm(path, { force: true });
      return undefined;
    }
    return parsed.data;
  }

  return {
    async start() {
      const already = await running();
      if (already) return { alreadyRunning: true, pid: already.pid };
      // Detached, with its output discarded: the daemon has to outlive the shell that ran
      // `crosscode start`, and it does its own logging.
      const child = spawn(process.execPath, [daemonEntry(), "--directory", repoRoot], { detached: true, stdio: "ignore" });
      child.unref();
      for (let waited = 0; waited < 15_000; waited += 100) {
        await delay(100);
        const handshake = await running();
        if (handshake) return { alreadyRunning: false, pid: handshake.pid };
      }
      throw new CliError("DAEMON_DID_NOT_START", "The daemon did not report itself ready within 15 seconds", "Run `crosscode start` again; if it keeps failing, run `crosscode status` for the last error.");
    },

    async stop() {
      const handshake = await running();
      if (!handshake) return { wasRunning: false };
      await fetchImpl(`http://127.0.0.1:${handshake.port}/stop`, { method: "POST" }).catch(() => {
        // A daemon that will not answer still has to stop; SIGTERM is the fallback.
        try {
          process.kill(handshake.pid, "SIGTERM");
        } catch {
          // Already gone.
        }
      });
      await rm(await handshakePath(), { force: true });
      return { wasRunning: true };
    },

    async status() {
      const handshake = await running();
      if (!handshake) {
        throw new CliError("DAEMON_UNAVAILABLE", "No daemon is running for this checkout", "Run `crosscode start` to configure this checkout and start it.");
      }
      const response = await fetchImpl(`http://127.0.0.1:${handshake.port}/status`).catch(() => undefined);
      if (!response?.ok) {
        throw new CliError("DAEMON_UNAVAILABLE", "The daemon for this checkout is not answering", "Run `crosscode stop` then `crosscode start`.");
      }
      return syncStatusSchema.parse(await response.json());
    }
  };
}

/**
 * The two layouts the CLI ships in: bundled beside us when installed from npm, TypeScript
 * source in a monorepo clone. Built at runtime so the bundler does not inline the daemon
 * into the CLI bundle -- `crosscode status` should not pay to load the watcher.
 */
function daemonEntry(): string {
  const bundled = fileURLToPath(new URL("./daemon.js", import.meta.url));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL("../../daemon/src/main.ts", import.meta.url));
}
