import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "./client.js";

/**
 * How to start a detached daemon for a worktree, shared by the two things that ever need
 * to: the MCP server's first-connection bootstrap (`apps/mcp-server/src/bootstrap.ts`) and
 * `crosscode start`. It lives beside the daemon rather than inside either caller because
 * both resolve the same bundle layout, and a second copy would drift.
 */

/**
 * Works out how to launch the daemon for however this module was installed, and says so
 * explicitly rather than guessing at a monorepo layout that only exists in a clone.
 *
 * Installed from npm this module is inlined into a `dist/*.js` bundle and the bundled
 * daemon is `dist/daemon.js` beside it, run by the same Node binary that is running us. In
 * a clone the daemon is still TypeScript source that only tsx can execute, so `pnpm mcp`
 * keeps working. Both candidates are checked for existence, so a layout that does not
 * match produces a message naming the paths that were tried instead of an ENOENT from a
 * path nobody ever verified.
 */
export function resolveDaemonLaunch(moduleDirectory = dirname(fileURLToPath(import.meta.url))): { command: string; args: string[] } {
  const bundled = join(moduleDirectory, "daemon.js");
  if (existsSync(bundled)) return { command: process.execPath, args: [bundled] };

  const repoRoot = resolve(moduleDirectory, "../../..");
  const daemonSource = join(repoRoot, "apps", "daemon", "src", "main.ts");
  const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
  if (existsSync(daemonSource) && existsSync(tsxBin)) return { command: tsxBin, args: [daemonSource] };

  throw new Error(`Cannot locate the Crosscode daemon: no bundled daemon at ${bundled}, and no ${daemonSource} runnable by ${tsxBin}`);
}

/**
 * Starts the daemon detached and returns a getter for whatever went wrong, if anything.
 * `detached` + `stdio: "ignore"` is what keeps the daemon alive past this process, but it
 * also means a failed exec is completely silent -- the caller would otherwise wait out the
 * full timeout with no thread to pull on.
 */
export function spawnDaemon(directory: string): () => string | undefined {
  const { command, args } = resolveDaemonLaunch();
  let failure: string | undefined;
  const child = spawn(command, [...args, "--directory", directory], { detached: true, stdio: "ignore" });
  child.once("error", (error) => {
    failure = `could not run \`${command}\`: ${error.message}`;
  });
  child.once("exit", (code, signal) => {
    if (code) failure = `\`${command}\` exited with code ${code}`;
    else if (signal) failure = `\`${command}\` was killed by ${signal}`;
  });
  child.unref();
  return () => failure;
}

export async function waitForDaemon(directory: string, spawnFailure: () => string | undefined, timeoutMs = 10_000): Promise<DaemonClient> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await DaemonClient.connect(directory);
    } catch (error) {
      lastError = error;
      // An exec that failed outright is never going to succeed on the next poll; report it
      // now instead of making the caller wait out the full timeout for a worse message.
      if (spawnFailure()) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  const reason = spawnFailure() ?? (lastError instanceof Error ? lastError.message : String(lastError));
  throw new Error(`Crosscode daemon did not become ready: ${reason}`);
}

/**
 * Connects to the daemon for `directory`, starting one if nothing is listening yet.
 * Assumes the worktree already has a config the daemon can read; establishing that
 * identity is the caller's job, and the two callers do it differently.
 */
export async function connectOrStartDaemon(directory: string, timeoutMs?: number): Promise<DaemonClient> {
  try {
    return await DaemonClient.connect(directory);
  } catch {
    return waitForDaemon(directory, spawnDaemon(directory), timeoutMs);
  }
}
