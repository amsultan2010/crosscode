import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configuredWebUrl, openInBrowser } from "../../daemon/src/browser-login.js";
import { readDaemonConfig, writeDaemonConfig } from "../../daemon/src/runtime.js";
import { DaemonClient } from "../../daemon/src/client.js";

const LOGIN_HINT = "No Crosscode session found for this directory; run `crosscode login` first, then retry.";

// Best-effort: opens the website's sign-in/sign-up page in the user's default browser the
// first time an MCP client bootstraps a directory with no prior local identity, so
// installing gets them straight to an account instead of a silent local-only daemon. The
// session itself is still established by `crosscode login`; this only saves a copy-paste.
// Only fires when a website URL is explicitly configured -- there is no fixed hosted domain
// yet, and guessing one would point users at a page that may not exist.
function openSignInPage(): void {
  const webUrl = configuredWebUrl();
  if (webUrl) openInBrowser(webUrl);
}

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
  openSignInPage();
  if (serviceUrl) throw new Error(LOGIN_HINT);
  await writeDaemonConfig(directory, {
    workspaceId: randomUUID(),
    replicaId: randomUUID(),
    actorId: process.env.USER ?? process.env.USERNAME ?? "local-user"
  });
}

/**
 * Works out how to launch the daemon for however this server was installed, and says so
 * explicitly rather than guessing at a monorepo layout that only exists in a clone.
 *
 * Installed from npm, this module is `dist/mcp.js` and the bundled daemon is `dist/daemon.js`
 * beside it, run by the same Node binary that is running us. In a clone the daemon is still
 * TypeScript source that only tsx can execute, so `pnpm mcp` keeps working. Both candidates
 * are checked for existence, so a layout that does not match produces a message naming the
 * paths that were tried instead of an ENOENT from a path nobody ever verified.
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
 * also means a failed exec is completely silent -- the MCP client would otherwise see
 * `DAEMON_UNAVAILABLE` forever with no thread to pull on.
 */
function spawnDaemon(directory: string): () => string | undefined {
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

async function waitForDaemon(directory: string, spawnFailure: () => string | undefined, timeoutMs = 10_000): Promise<DaemonClient> {
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
 * Connects to the local daemon for `directory`, transparently bootstrapping it on
 * first use: writes a local-only replica identity if none exists and no coordination
 * service is configured, or requires `crosscode login` first when one is, then spawns
 * the daemon as a detached background process and waits for it to come up. This is what
 * lets an MCP client just point at this server with zero manual `crosscode init`/daemon
 * steps for local-only use.
 */
export async function ensureDaemonRunning(directory: string): Promise<DaemonClient> {
  try {
    return await DaemonClient.connect(directory);
  } catch {
    await ensureIdentity(directory);
    return waitForDaemon(directory, spawnDaemon(directory));
  }
}
