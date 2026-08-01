import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDaemonConfig, writeDaemonConfig } from "../../daemon/src/runtime.js";
import { DaemonClient } from "../../daemon/src/client.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const daemonMain = join(repoRoot, "apps", "daemon", "src", "main.ts");

/**
 * TODO(Task 4): this is a minimal shim to keep the build green after CoordinationServiceClient.enroll()
 * was removed in favor of Supabase Auth. It does not yet perform any Supabase-aware bootstrap
 * (e.g. detecting an existing daemon config with a valid session, or guiding first-time login) -
 * that full redesign is Task 4's responsibility.
 */
async function ensureIdentity(directory: string): Promise<void> {
  const exists = await readDaemonConfig(directory).then(() => true).catch(() => false);
  if (exists) return;
  const serviceUrl = process.env.CROSSCODE_SERVICE_URL;
  if (serviceUrl) throw new Error("No Crosscode session found for this directory; run `crosscode -- login` first");
  await writeDaemonConfig(directory, {
    workspaceId: randomUUID(),
    replicaId: randomUUID(),
    actorId: process.env.USER ?? process.env.USERNAME ?? "local-user"
  });
}

function spawnDaemon(directory: string): void {
  const child = spawn(tsxBin, [daemonMain, "--directory", directory], { detached: true, stdio: "ignore" });
  child.unref();
}

async function waitForDaemon(directory: string, timeoutMs = 10_000): Promise<DaemonClient> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await DaemonClient.connect(directory);
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  throw new Error(`Crosscode daemon did not become ready in time: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/**
 * Connects to the local daemon for `directory`, transparently bootstrapping it on
 * first use: writes a local replica identity if none exists yet (see ensureIdentity's
 * TODO for the CROSSCODE_SERVICE_URL case), then spawns the daemon as a detached
 * background process and waits for it to come up. This is what lets an MCP client
 * just point at this server with zero manual `crosscode init`/daemon steps.
 */
export async function ensureDaemonRunning(directory: string): Promise<DaemonClient> {
  try {
    return await DaemonClient.connect(directory);
  } catch {
    await ensureIdentity(directory);
    spawnDaemon(directory);
    return waitForDaemon(directory);
  }
}
