import { randomUUID } from "node:crypto";
import { configuredWebUrl, openInBrowser } from "../../daemon/src/browser-login.js";
import { connectOrStartDaemon } from "../../daemon/src/launch.js";
import { readDaemonConfig, writeDaemonConfig } from "../../daemon/src/runtime.js";
import { DaemonClient } from "../../daemon/src/client.js";

const LOGIN_HINT = "No Crosscode session found for this directory; run `crosscode start` (or `crosscode login`) first, then retry.";

// Best-effort: opens the website's sign-in/sign-up page in the user's default browser the
// first time an MCP client bootstraps a directory with no prior local identity, so
// installing gets them straight to an account instead of a silent local-only daemon. The
// session itself is still established by `crosscode start`/`crosscode login`; this only
// saves a copy-paste. Only fires when a website URL is explicitly configured -- there is no
// fixed hosted domain yet, and guessing one would point users at a page that may not exist.
function openSignInPage(): void {
  const webUrl = configuredWebUrl();
  if (webUrl) openInBrowser(webUrl);
}

/**
 * Deliberately reads the raw CROSSCODE_SERVICE_URL rather than resolveDefaultServiceUrl(),
 * which folds in the compiled-in hosted default and would therefore always be set.
 *
 * `crosscode start` does not change this, and must not. The two entrypoints answer
 * different questions. `crosscode start` is an opt-in: a person ran it, so signing them in
 * and pointing them at the hosted service is exactly what they asked for. This bootstrap is
 * implicit -- it fires because some MCP client connected -- so treating the compiled-in
 * default as "a service is configured" would make every fresh MCP install fail with
 * LOGIN_HINT instead of running local-only, and would make every pre-existing local-only
 * checkout start demanding a login it never needed. Only an operator who explicitly
 * exported CROSSCODE_SERVICE_URL has asked for sync, and only they get the strict check.
 *
 * A worktree that went through `crosscode start` is unaffected either way: it already has
 * a config with a session, so this returns on the first branch.
 */
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
 * Connects to the local daemon for `directory`, transparently bootstrapping it on
 * first use: writes a local-only replica identity if none exists and no coordination
 * service is configured, or requires a login first when one is, then spawns the daemon
 * as a detached background process and waits for it to come up. This is what lets an MCP
 * client just point at this server with zero manual `crosscode init`/daemon steps for
 * local-only use.
 */
export async function ensureDaemonRunning(directory: string): Promise<DaemonClient> {
  try {
    return await DaemonClient.connect(directory);
  } catch {
    await ensureIdentity(directory);
    return connectOrStartDaemon(directory);
  }
}
