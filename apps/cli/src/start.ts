import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { discoverRepository } from "@crosscode/git";
import type { DaemonConfig, ListMembershipsResponse } from "@crosscode/protocol";
import { resolveWebUrl } from "../../daemon/src/browser-login.js";
import { DaemonClient } from "../../daemon/src/client.js";
import { resolveDefaultServiceUrl } from "../../daemon/src/hosted.js";
import { spawnDaemon, waitForDaemon } from "../../daemon/src/launch.js";
import { browserLogin, daemonConfigPath, login, readDaemonConfig, serviceRequest, writeDaemonConfig } from "../../daemon/src/runtime.js";
import { VERSION } from "../../daemon/src/version.js";
import { CliError } from "./errors.js";
import { type McpClient, type McpRegistration, registerMcpServer, resolveMcpLaunch } from "./mcp-config.js";

/**
 * `crosscode start` -- the one command between a stranger and a running, synced daemon.
 *
 * Every step it performs already existed as its own command (`init`, `login`, `join`, the
 * daemon that an MCP tool call would have started, and a hand-written MCP config). What did
 * not exist was the path through them, and a five-command setup is where a first-time user
 * is lost, not at any one of the five. So this adds no new capability on purpose: it is the
 * ordering, plus the defaults that make every flag optional.
 *
 * Each step is idempotent and skipped when already satisfied, so re-running it in a
 * configured checkout is a no-op that reports state rather than a second setup.
 */

export type StartOptions = {
  email?: string;
  password?: string;
  web?: string;
  service?: string;
  /** false when --no-browser was passed: print the sign-in URL instead of opening it. */
  browser?: boolean;
  /** false when --no-mcp was passed. */
  mcp?: McpClient | false;
  /** Progress for a human, on stderr, so `--json` stays a single parseable line. */
  report?: (line: string) => void;
  /** Injected by tests; production always reads the real TTY. */
  interactive?: boolean;
};

export type StartResult = {
  repoRoot: string;
  workspaceId: string;
  workspaceName?: string;
  actorId: string;
  service: { url: string; signedIn: boolean; paired: boolean };
  daemon: { alreadyRunning: boolean };
  mcp?: { client: McpClient; path: string; command: string; args: string[] };
};

export async function start(directory: string, options: StartOptions = {}): Promise<StartResult> {
  const report = options.report ?? (() => {});
  const repository = await discoverRepository(directory).catch(() => undefined);
  if (!repository) {
    throw new CliError(
      "NOT_A_GIT_REPOSITORY",
      "`crosscode start` must run inside a Git repository",
      "cd into your project first. Crosscode coordinates one checkout at a time, and Git is where its checkpoints and published work live."
    );
  }

  let config = await ensureInitialized(directory, report);
  const serviceUrl = options.service ?? config.service?.url ?? resolveDefaultServiceUrl();

  config = await ensureSignedIn(directory, config, { ...options, serviceUrl }, report);
  config = await ensureWorkspace(directory, config, report);

  const daemon = await ensureDaemonRunning(directory, report);
  const mcp = options.mcp === false ? undefined : await ensureMcpRegistered(repository.root, options.mcp ?? "claude", report);

  return {
    repoRoot: repository.root,
    workspaceId: config.workspaceId,
    workspaceName: config.workspaceName,
    actorId: config.actorId,
    service: { url: config.service?.url ?? serviceUrl, signedIn: Boolean(config.service?.session), paired: Boolean(config.service?.workspaceToken) },
    daemon,
    mcp: mcp && { client: mcp.registration.client, path: mcp.registration.path, command: mcp.launch.command, args: mcp.launch.args }
  };
}

/**
 * `crosscode init`, minus the failure when it has already run. Existence of the file is
 * checked separately from reading it so that a config whose session moved to the OS
 * keychain and cannot be read surfaces that error instead of being silently overwritten.
 */
async function ensureInitialized(directory: string, report: (line: string) => void): Promise<DaemonConfig & { workspaceName?: string }> {
  const path = await daemonConfigPath(directory);
  if (await access(path, constants.F_OK).then(() => true, () => false)) {
    report("Using this checkout's existing Crosscode configuration.");
    return readDaemonConfig(directory);
  }
  const config: DaemonConfig = {
    workspaceId: randomUUID(),
    replicaId: randomUUID(),
    actorId: process.env.USER ?? process.env.USERNAME ?? "local-user"
  };
  await writeDaemonConfig(directory, config);
  report("Initialized Crosscode for this checkout.");
  return config;
}

/**
 * Signs in if this checkout holds no credential yet. The browser page this opens carries
 * both a "Sign in" and a "Sign up" tab, so account creation and returning both land here
 * with no flag to choose between them -- which is the whole reason the browser flow is the
 * default rather than prompting for a password in the terminal.
 *
 * A checkout paired with `crosscode join --pair` already holds a workspace token and is
 * left alone: it is deliberately attached to a workspace without a user account.
 */
async function ensureSignedIn(
  directory: string,
  config: DaemonConfig,
  options: StartOptions & { serviceUrl: string },
  report: (line: string) => void
): Promise<DaemonConfig> {
  if (config.service?.session) {
    report("Already signed in for this checkout.");
    return config;
  }
  if (config.service?.workspaceToken) {
    report("This checkout is paired to a workspace with a device token; leaving it as it is.");
    return config;
  }

  const email = options.email ?? process.env.CROSSCODE_EMAIL;
  const password = options.password ?? process.env.CROSSCODE_PASSWORD;
  if (email || password) {
    if (!email || !password) {
      throw new CliError(
        "USAGE_ERROR",
        "The headless sign-in needs both --email and --password",
        "Pass both flags (or set CROSSCODE_EMAIL and CROSSCODE_PASSWORD), or drop them to sign in in a browser. Creating an account headlessly is `crosscode signup`."
      );
    }
    report(`Signing in to ${options.serviceUrl} as ${email}…`);
    const { config: updated, user } = await login(directory, { email, password, serviceUrl: options.serviceUrl });
    return adoptAccountIdentity(directory, updated, user.email);
  }

  const interactive = options.interactive ?? process.stdout.isTTY;
  // Opening a browser from a pipe would strand the caller waiting on a tab nobody can see,
  // so an agent or CI run has to say which noninteractive path it wants.
  if (options.browser !== false && !interactive) {
    throw new CliError(
      "LOGIN_NOT_INTERACTIVE",
      "Signing in through a browser needs a terminal; this process has no TTY",
      "Pass --no-browser to print the sign-in URL, or --email <email> --password <password> for the headless sign-in. New accounts: `crosscode signup`."
    );
  }
  report("Opening your browser to sign in or create an account…");
  const { config: updated, user } = await browserLogin(directory, {
    webUrl: resolveWebUrl(options.web),
    serviceUrl: options.serviceUrl,
    openBrowser: options.browser !== false,
    onUrl: (url) => report(options.browser === false ? `Open this URL to sign in:\n${url}` : `Opening ${url}`)
  });
  report(`Signed in as ${user.email}.`);
  return adoptAccountIdentity(directory, updated, user.email);
}

/**
 * The account's email becomes this replica's actorId, because that is what the service
 * records as a member's actor_id (it comes from the verified token's email claim). Leaving
 * the local Unix username in place would attribute this checkout's presence, claims, and
 * proposals to an actor the workspace has never heard of.
 */
async function adoptAccountIdentity(directory: string, config: DaemonConfig, email: string): Promise<DaemonConfig> {
  if (!email || config.actorId === email) return config;
  const updated = { ...config, actorId: email };
  await writeDaemonConfig(directory, updated);
  return updated;
}

/**
 * Points this checkout at a workspace the signed-in account is actually a member of.
 *
 * `GET /v1/memberships` is what provisions the personal workspace (Contract C in
 * `docs/onboarding-contracts.md`): a user with no memberships gets one on their first read,
 * so a brand-new account needs no "create a team" step before it can coordinate anything.
 * A checkout already pointed at one of the account's workspaces keeps it -- re-running
 * `start` in a repo joined to a team must not silently drag it back to the personal one.
 */
async function ensureWorkspace(directory: string, config: DaemonConfig, report: (line: string) => void): Promise<DaemonConfig & { workspaceName?: string }> {
  if (!config.service?.session) return config;
  const { memberships } = await serviceRequest<ListMembershipsResponse>(directory, "/v1/memberships", { describe: "Workspace lookup" });
  const current = memberships.find((membership) => membership.workspaceId === config.workspaceId);
  // The personal workspace is the default for a checkout that has not chosen one. Older
  // service deployments do not report isPersonal, hence the single-membership fallback --
  // which is the shape a brand-new account has anyway.
  const chosen = current ?? memberships.find((membership) => membership.isPersonal) ?? (memberships.length === 1 ? memberships[0] : undefined);
  if (!chosen) {
    throw new CliError(
      "WORKSPACE_AMBIGUOUS",
      "This account belongs to several workspaces and this checkout is not attached to any of them",
      `Run \`crosscode join --workspace <id>\` to pick one: ${memberships.map((membership) => `${membership.workspaceName} (${membership.workspaceId})`).join(", ")}.`
    );
  }
  if (chosen.workspaceId === config.workspaceId) {
    report(`Using workspace ${chosen.workspaceName}.`);
    return { ...config, workspaceName: chosen.workspaceName };
  }
  const updated = { ...config, workspaceId: chosen.workspaceId };
  await writeDaemonConfig(directory, updated);
  report(`Attached this checkout to workspace ${chosen.workspaceName}.`);
  return { ...updated, workspaceName: chosen.workspaceName };
}

async function ensureDaemonRunning(directory: string, report: (line: string) => void): Promise<{ alreadyRunning: boolean }> {
  const running = await DaemonClient.connect(directory).catch(() => undefined);
  if (running) {
    report("A daemon is already running for this checkout.");
    return { alreadyRunning: true };
  }
  report("Starting the daemon…");
  // waitForDaemon only resolves once the daemon answers a status call, so returning from
  // here means it is genuinely up rather than merely spawned.
  await waitForDaemon(directory, spawnDaemon(directory));
  report("Daemon is running and syncing.");
  return { alreadyRunning: false };
}

async function ensureMcpRegistered(
  repoRoot: string,
  client: McpClient,
  report: (line: string) => void
): Promise<{ registration: McpRegistration; launch: ReturnType<typeof resolveMcpLaunch> }> {
  const launch = resolveMcpLaunch(VERSION);
  const registration = await registerMcpServer(repoRoot, client, launch);
  report(
    registration.changed
      ? `Registered the crosscode MCP server for ${registration.label} in ${registration.path}.`
      : `${registration.label} already has the crosscode MCP server in ${registration.path}.`
  );
  if (launch.command === "npx") {
    report("That entry runs Crosscode through npx. `npm install -g crosscode-cli` and re-run `crosscode start` for a faster, pinned local install.");
  }
  report("Restart your agent (or reconnect its MCP servers) to pick it up.");
  return { registration, launch };
}
