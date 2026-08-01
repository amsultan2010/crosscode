import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDaemonConfig, writeDaemonConfig } from "../../daemon/src/runtime.js";
import { DaemonClient } from "../../daemon/src/client.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const daemonMain = join(repoRoot, "apps", "daemon", "src", "main.ts");

const LOGIN_HINT = "No Crosscode Supabase session found for this directory; run `crosscode -- login` first, then retry.";

async function ensureIdentity(directory: string): Promise<void> {
  const serviceUrl = process.env.CROSSCODE_SERVICE_URL;
  const existingConfig = await readDaemonConfig(directory).catch(() => undefined);
  if (existingConfig) {
    // A config from a prior local-only run has no service.session at all; if the
    // operator has since pointed this directory at a coordination service, silently
    // continuing in local-only mode would look like sync is working when it never
    // authenticates. Require an explicit login in that case rather than guessing.
    if (serviceUrl && !existingConfig.service?.session) throw new Error(LOGIN_HINT);
    return;
  }
  if (serviceUrl) throw new Error(LOGIN_HINT);
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
 * first use: writes a local-only replica identity if none exists and no coordination
 * service is configured, or requires `crosscode -- login` first when one is, then spawns
 * the daemon as a detached background process and waits for it to come up. This is what
 * lets an MCP client just point at this server with zero manual `crosscode init`/daemon
 * steps for local-only use.
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
