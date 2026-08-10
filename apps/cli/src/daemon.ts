import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolveGitPath } from "@crosscode/git";
import { type SyncStatus } from "../../../packages/protocol/src/sync.js";
import { DaemonClient } from "../../daemon/src/client.js";
import { daemonDescriptorSchema } from "../../daemon/src/sync-config.js";
import { CliError } from "./errors.js";

/**
 * The daemon, as a narrow interface: one per checkout, started by `crosscode start`, stopped
 * by `crosscode stop`, and asked for the contract's `syncStatus` by `crosscode status`.
 *
 * The descriptor schema and the loopback client are the daemon's own, imported rather than
 * described again here. This file used to carry a stub of both, written before the daemon
 * existed, and every part of the guess was wrong once it did: the descriptor gained
 * `secret` and `startedAt`, and a `.strict()` two-field schema rejected it, so `status`
 * reported "no daemon is running" against a daemon that was running and answering. The
 * route is `/v1/status`, not `/status`, and it needs the descriptor's secret as a bearer
 * token. Importing the real thing is what stops that drifting again.
 */

export type DaemonControl = {
  /** Idempotent: a daemon already running for this checkout is left alone. */
  start(): Promise<{ alreadyRunning: boolean; pid: number }>;
  stop(): Promise<{ wasRunning: boolean }>;
  status(): Promise<SyncStatus>;
};

type Handshake = { pid: number; port: number };

export function localDaemon(repoRoot: string): DaemonControl {
  const handshakePath = () => resolveGitPath(repoRoot, "crosscode/daemon.json");

  async function running(): Promise<Handshake | undefined> {
    const path = await handshakePath();
    const contents = await readFile(path, "utf8").catch(() => undefined);
    if (contents === undefined) return undefined;
    // A descriptor half-written by a daemon that died mid-handshake is not valid JSON, and
    // `JSON.parse` throwing here took `status`, `stop`, and `start` down with a SyntaxError
    // -- leaving no command that could clear it. Unreadable means the same as absent.
    let descriptor: unknown;
    try {
      descriptor = JSON.parse(contents);
    } catch {
      return undefined;
    }
    const parsed = daemonDescriptorSchema.safeParse(descriptor);
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
      // SIGTERM, which main.ts handles by shutting the supervisor down cleanly. This used to
      // POST to `/stop` and fall back to the signal only if that *threw* -- but the daemon
      // has no such route, and an unmatched route answers 401 rather than rejecting, so
      // fetch resolved, the fallback never ran, and `crosscode stop` deleted the descriptor
      // out from under a daemon that went on running with nothing left pointing at it.
      try {
        process.kill(handshake.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      await rm(await handshakePath(), { force: true });
      return { wasRunning: true };
    },

    async status() {
      const handshake = await running();
      if (!handshake) {
        throw new CliError("DAEMON_UNAVAILABLE", "No daemon is running for this checkout", "Run `crosscode start` to configure this checkout and start it.");
      }
      const client = await DaemonClient.connect(repoRoot).catch(() => undefined);
      if (!client) {
        throw new CliError("DAEMON_UNAVAILABLE", "The daemon for this checkout is not answering", "Run `crosscode stop` then `crosscode start`.");
      }
      return client.status();
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
