#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { DaemonClient, DaemonUnavailableError } from "../../daemon/src/client.js";
import { BrowserLoginError, resolveWebUrl } from "../../daemon/src/browser-login.js";
import { SupabaseConfigError } from "../../daemon/src/supabase-client.js";
import { browserLogin, login, logout, readDaemonConfig, redeemInvite, redeemPairingCode, serviceRequest, signup, writeDaemonConfig } from "../../daemon/src/runtime.js";
import { VERSION } from "../../daemon/src/version.js";
import { CliError } from "./errors.js";
import { MCP_CLIENTS, parseMcpClient } from "./mcp-config.js";
import { start } from "./start.js";

type CliResult = { value?: unknown; exitCode?: number };

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(prompt);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

type CatalogEntry = { command: string; args?: string; options?: string[]; description?: string };

function buildCatalog(program: Command): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const walk = (command: Command, prefix: string) => {
    const name = prefix ? `${prefix} ${command.name()}` : command.name();
    const args = command.registeredArguments
      .map((argument) => (argument.required ? `<${argument.name()}>` : `[${argument.name()}]`))
      .join(" ");
    const options = command.options.map((option) => option.flags);
    entries.push({ command: name, args: args || undefined, options: options.length ? options : undefined, description: command.description() || undefined });
    for (const sub of command.commands) walk(sub, name);
  };
  for (const command of program.commands) walk(command, "");
  return entries;
}

export async function runCli(args: string[], directory = process.cwd()): Promise<CliResult> {
  const command = args[0];

  // "run" forwards argv byte-for-byte to a child process; handled outside the
  // parser so nothing after the first `--` (including further `--json`/`--`
  // tokens) is ever reinterpreted as a crosscode flag.
  if (command === "run") {
    const separator = args.indexOf("--");
    if (separator < 0 || !args[separator + 1]) throw new CliError("USAGE_ERROR", "Usage: crosscode run -- <command> [args]", "Everything after `--` is passed to the child process verbatim, e.g. `crosscode run -- pytest -q`.");
    const child = spawn(args[separator + 1]!, args.slice(separator + 2), { cwd: directory, stdio: "inherit" });
    const exitCode = await new Promise<number>((resolveRun, rejectRun) => {
      child.once("error", rejectRun);
      child.once("exit", (code) => resolveRun(code ?? 1));
    });
    return { exitCode };
  }

  // Serves MCP over this process's stdio and never returns, so it is handled before the
  // parser rather than as an action that would fall through to printing a result.
  if (command === "mcp") {
    await serveMcpServer();
    return {};
  }

  if (command === "validate" && args.includes("--")) {
    throw new CliError("UNTRUSTED_VALIDATION_ARGS", "Validation commands must come from trusted .crosscode/config.yaml profiles", "Add the command to a profile in .crosscode/config.yaml and run `crosscode validate --profile <name>`.");
  }

  // --json is a purely presentational, position-independent flag handled by
  // main(); strip it before commander sees it so it never has to be declared
  // on every subcommand or fought over positionally.
  const parseArgs = args.filter((value) => value !== "--json");

  let result: CliResult = {};
  const client = () => DaemonClient.connect(directory);

  const program = new Command();
  program
    .name("crosscode")
    .description("Local-first coordination layer for multi-agent git checkouts")
    .version(VERSION)
    .option("--json", "output compact JSON instead of pretty-printed JSON")
    .exitOverride()
    .configureOutput({ writeOut: (str) => process.stdout.write(str), writeErr: () => {} });

  program
    .command("start")
    .description("set this checkout up end to end: configure it, sign in, attach a workspace, start the daemon, and register the MCP server")
    .option("--email <email>", "account email; with --password, signs in headlessly instead of opening a browser (or set CROSSCODE_EMAIL)")
    .option("--password <password>", "account password for the headless sign-in (or set CROSSCODE_PASSWORD)")
    .option("--web <url>", "base URL of the crosscode website hosting the sign-in page (or set CROSSCODE_WEB_URL)")
    .option("--service <url>", "coordination service URL to record for this checkout")
    .option("--no-browser", "print the sign-in URL instead of opening a browser, for remote shells and CI")
    .option("--mcp <client>", `MCP client to register with: ${MCP_CLIENTS.join(", ")}`, "claude")
    .option("--no-mcp", "skip MCP client registration")
    .action(async (options: { email?: string; password?: string; web?: string; service?: string; browser?: boolean; mcp?: string | boolean }) => {
      result = {
        value: await start(directory, {
          email: options.email,
          password: options.password,
          web: options.web,
          service: options.service,
          browser: options.browser,
          mcp: options.mcp === false ? false : parseMcpClient(typeof options.mcp === "string" ? options.mcp : "claude"),
          // stderr, not stdout: --json output has to stay a single parseable object.
          report: (line) => process.stderr.write(`${line}\n`)
        })
      };
    });

  program
    .command("mcp")
    .description("serve the crosscode MCP server over stdio (the portable spelling of the crosscode-mcp binary)");

  program
    .command("init")
    .description("initialize crosscode configuration for this repository")
    .action(async () => {
      const settings = { workspaceId: randomUUID(), replicaId: randomUUID(), actorId: process.env.USER ?? "local-user" };
      await writeDaemonConfig(directory, settings);
      result = { value: settings };
    });

  program
    .command("join")
    .description("join a workspace")
    .argument("[workspaceId]", "workspace id (or use --workspace / --invite / --pair)")
    .option("--workspace <id>", "workspace id")
    .option("--invite <code>", "invite code (alternative to --workspace)")
    .option("--pair <code>", "one-time pairing code minted by the service (XXXX-XXXX); no login required")
    .option("--service <url>", "service URL, when pairing before any login")
    .option("--replica-name <name>", "name to register this machine under when pairing")
    .action(async (positional: string | undefined, options: { workspace?: string; invite?: string; pair?: string; service?: string; replicaName?: string }) => {
      if (options.pair) {
        const paired = await redeemPairingCode(directory, options.pair, { serviceUrl: options.service, replicaName: options.replicaName });
        // Never echo the workspace token: it is a bearer credential, and it is already
        // persisted to the 0600 config file the daemon reads.
        result = { value: { workspaceId: paired.workspaceId, replicaId: paired.replicaId, actorId: paired.actorId, paired: true } };
        return;
      }
      if (options.invite) {
        result = { value: await redeemInvite(directory, options.invite) };
        return;
      }
      const settings = await readDaemonConfig(directory);
      const workspaceId = options.workspace ?? positional;
      if (!workspaceId) throw new CliError("USAGE_ERROR", "Usage: crosscode join --workspace <workspaceId> | --invite <code> | --pair <code>", "Run `crosscode login` first for --workspace/--invite; --pair needs no login.");
      const updated = { ...settings, workspaceId };
      await writeDaemonConfig(directory, updated);
      result = { value: updated };
    });

  program
    .command("login")
    .description("log in to the crosscode service by signing in in a browser, or headlessly with --email/--password")
    .option("--email <email>", "account email; with --password, signs in headlessly instead of opening a browser (or set CROSSCODE_EMAIL)")
    .option("--password <password>", "account password for the headless sign-in (or set CROSSCODE_PASSWORD)")
    .option("--web <url>", "base URL of the crosscode website hosting the sign-in page (or set CROSSCODE_WEB_URL)")
    .option("--no-browser", "print the sign-in URL instead of opening a browser, for remote shells and CI")
    .option("--service <url>", "coordination service URL to record for this checkout")
    .action(async (options: { email?: string; password?: string; web?: string; browser?: boolean; service?: string }) => {
      const email = options.email ?? process.env.CROSSCODE_EMAIL;
      const password = options.password ?? process.env.CROSSCODE_PASSWORD;
      const serviceUrl = options.service;
      if (email || password) {
        if (!email || !password) {
          throw new CliError(
            "USAGE_ERROR",
            "The headless login needs both --email and --password",
            "Pass both flags (or set CROSSCODE_EMAIL and CROSSCODE_PASSWORD), or drop them to sign in in a browser."
          );
        }
        const { user } = await login(directory, { email, password, serviceUrl });
        result = { value: { userId: user.id, email: user.email } };
        return;
      }
      // Opening a browser from a pipe would strand the caller waiting on a tab nobody can
      // see, so an agent or CI run has to say which noninteractive path it wants.
      if (options.browser !== false && !process.stdout.isTTY) {
        throw new CliError(
          "LOGIN_NOT_INTERACTIVE",
          "Browser login needs a terminal; this process has no TTY",
          "Pass --no-browser to print the sign-in URL, or --email <email> --password <password> for the headless login."
        );
      }
      const { user } = await browserLogin(directory, {
        webUrl: resolveWebUrl(options.web),
        serviceUrl,
        openBrowser: options.browser !== false,
        // stderr, not stdout: --json output has to stay a single parseable object.
        onUrl: (url) => process.stderr.write(options.browser === false ? `Open this URL to sign in:\n${url}\n` : `Opening ${url}\n`)
      });
      result = { value: { userId: user.id, email: user.email } };
    });

  program
    .command("signup")
    .description("create an account and log in to the crosscode service")
    .option("--email <email>", "account email")
    .option("--password <password>", "account password")
    .option("--invite <code>", "invite code to redeem after signing up")
    .option("--service <url>", "service URL")
    .action(async (options: { email?: string; password?: string; invite?: string; service?: string }) => {
      let email = options.email ?? process.env.CROSSCODE_EMAIL;
      let password = options.password ?? process.env.CROSSCODE_PASSWORD;
      const serviceUrl = options.service;
      if ((!email || !password) && process.stdout.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        if (!email) email = await rl.question("Email: ");
        if (!password) password = await rl.question("Password: ");
        rl.close();
      }
      if (!email || !password) {
        throw new CliError("USAGE_ERROR", "Usage: crosscode signup --email <email> --password <password> [--invite <code>] [--service <url>] (or set CROSSCODE_EMAIL/CROSSCODE_PASSWORD)", "Set CROSSCODE_EMAIL and CROSSCODE_PASSWORD to sign up without a terminal prompt.");
      }
      const updated = await signup(directory, { email, password, invite: options.invite, serviceUrl });
      result = { value: { workspaceId: updated.workspaceId, actorId: updated.actorId, service: { url: updated.service!.url, loggedIn: true } } };
    });

  program
    .command("logout")
    .description("log out of the crosscode service, clearing this checkout's session and any pairing token")
    .action(async () => {
      const cleared = await logout(directory);
      result = { value: { loggedOut: true, ...cleared } };
    });

  program
    .command("run")
    .description("run a shell command with the daemon context available (crosscode run -- <command> [args])")
    .argument("[args...]", "command and arguments, prefixed by --");

  program
    .command("status")
    .description("show workspace and daemon status")
    .action(async () => {
      result = { value: await (await client()).status() };
    });

  const workspace = program.command("workspace").description("manage workspace-level settings");
  const autonomy = workspace.command("autonomy").description("get or set this workspace's autonomy tier (0=always_ask, 1=auto_if_clean, 2=auto_always)");
  autonomy
    .command("get")
    .description("show the current autonomy tier")
    .action(async () => {
      result = { value: await (await client()).workspaceAutonomy() };
    });
  autonomy
    .command("set")
    .description("set the autonomy tier (owner/admin only)")
    .argument("<tier>", "0, 1, or 2")
    .action(async (tierArg: string) => {
      if (!/^[0-2]$/.test(tierArg)) throw new CliError("USAGE_ERROR", "Usage: crosscode workspace autonomy set <0|1|2>", "The tier is 0=always_ask, 1=auto_if_clean, or 2=auto_always; run `crosscode workspace autonomy get` to see the current one.");
      result = { value: await (await client()).setWorkspaceAutonomy(Number(tierArg) as 0 | 1 | 2) };
    });

  const checkpoint = program
    .command("checkpoint")
    .description("create a checkpoint")
    .option("--message <message>", "checkpoint message")
    .action(async (options: { message?: string }) => {
      result = { value: await (await client()).checkpoint(options.message) };
    });
  checkpoint
    .command("list")
    .description("list the checkpoints this daemon still retains")
    .action(async () => {
      result = { value: await (await client()).checkpoints() };
    });
  checkpoint
    .command("inspect")
    .description("inspect a checkpoint")
    .argument("[ref]", "checkpoint ref")
    .action(async (ref: string | undefined) => {
      result = { value: await (await client()).inspectCheckpoint(ref ?? "") };
    });
  checkpoint
    .command("restore")
    .description("restore a path from a checkpoint")
    .argument("[ref]", "checkpoint ref")
    .argument("[path]", "path to restore")
    .action(async (ref: string | undefined, path: string | undefined) => {
      result = { value: await (await client()).restoreCheckpoint(ref ?? "", path ?? "") };
    });

  const task = program.command("task").description("manage tasks");
  task
    .command("create")
    .description("create a task")
    .argument("[title]", "task title")
    .option("--path <path>", "path claimed by the task")
    .action(async (title: string | undefined, options: { path?: string }) => {
      result = { value: await (await client()).createTask({ title: title ?? "", paths: options.path ? [options.path] : [] }) };
    });

  const claim = program.command("claim").description("manage claims");
  claim
    .command("path")
    .description("claim a path for a task")
    .argument("[target]", "path to claim")
    .option("--task <taskId>", "task id")
    .action(async (target: string | undefined, options: { task?: string }) => {
      result = { value: await (await client()).createClaim({ taskId: options.task ?? "", kind: "path", target: target ?? "", mode: "exclusive-preferred" }) };
    });

  program
    .command("intent")
    .description("publish an intent")
    .argument("[text]", "intent text")
    .option("--task <taskId>", "task id")
    .action(async (text: string | undefined, options: { task?: string }) => {
      result = { value: await (await client()).publishIntent({ text: text ?? "", taskId: options.task }) };
    });

  const handoff = program.command("handoff").description("manage handoffs");
  handoff
    .command("request")
    .description("request a handoff for an operation")
    .argument("[operationId]", "operation id")
    .option("--note <note>", "handoff note")
    .action(async (operationId: string | undefined, options: { note?: string }) => {
      result = { value: await (await client()).requestHandoff({ operationId: operationId ?? "", note: options.note }) };
    });
  handoff
    .command("respond")
    .description("respond to a handoff request")
    .argument("[id]", "handoff id")
    .option("--decision <decision>", "accepted or declined")
    .action(async (id: string | undefined, options: { decision?: string }) => {
      result = { value: await (await client()).respondHandoff(id ?? "", (options.decision ?? "") as "accepted" | "declined") };
    });

  const proposals = program.command("proposals").description("inspect proposed operations");
  proposals
    .command("list")
    .description("list proposed operations")
    .action(async () => {
      result = { value: (await (await client()).operations()).filter((operation) => operation.status === "proposed") };
    });
  proposals
    .command("inspect")
    .description("inspect a proposed operation")
    .argument("[id]", "operation id")
    .action(async (id: string | undefined) => {
      result = { value: await (await client()).analyze(id ?? "") };
    });
  proposals
    .command("diff")
    .description("show the diff for a proposed operation")
    .argument("[id]", "operation id")
    .action(async (id: string | undefined) => {
      result = { value: await (await client()).diff(id ?? "") };
    });
  proposals
    .command("artifacts")
    .description("show conflict artifacts for a proposed operation")
    .argument("[id]", "operation id")
    .action(async (id: string | undefined) => {
      result = { value: await (await client()).artifacts(id ?? "") };
    });

  program
    .command("accept")
    .description("accept a proposed operation")
    .argument("[id]", "operation id")
    .action(async (id: string | undefined) => {
      result = { value: await (await client()).accept(id ?? "") };
    });

  program
    .command("reject")
    .description("reject a proposed operation")
    .argument("[id]", "operation id")
    .action(async (id: string | undefined) => {
      result = { value: await (await client()).reject(id ?? "") };
    });

  program
    .command("validate")
    .description("run validation checks (validate commands must come from trusted .crosscode/config.yaml profiles)")
    .option("--profile <name>", "validation profile", "fast")
    .action(async (options: { profile: string }) => {
      result = { value: await (await client()).validate(options.profile) };
    });

  program
    .command("publish")
    .description("publish accepted changes to a branch")
    .option("--branch <branch>", "target branch")
    .option("--profile <name>", "validation profile")
    .option("--message <message>", "publish message")
    .option("--dry-run", "do not actually publish")
    .option("--yes", "skip the confirmation prompt")
    .action(async (options: { branch?: string; profile?: string; message?: string; dryRun?: boolean; yes?: boolean }) => {
      if (!options.branch || !options.profile) {
        throw new CliError("USAGE_ERROR", 'Usage: crosscode publish --branch <branch> --profile <name> [--message "..."] [--dry-run] [--yes]', "Both --branch and --profile are required; add --dry-run to see what would be published.");
      }
      const input = { branch: options.branch, profile: options.profile, message: options.message, dryRun: Boolean(options.dryRun) };
      if (!options.yes) {
        if (!process.stdout.isTTY) throw new CliError("CONFIRMATION_REQUIRED", "Publishing requires confirmation; pass --yes in noninteractive environments", "Pass --yes to publish without an interactive prompt.");
        const confirmed = await confirm(`Publish to branch "${input.branch}"? [y/N] `);
        if (!confirmed) throw new CliError("CANCELLED", "Publish cancelled", "Re-run with --yes to publish without the confirmation prompt.");
      }
      result = { value: await (await client()).publish(input) };
    });

  const billing = program.command("billing").description("billing plan and usage (read-only)");
  billing
    .command("status")
    .description("show a workspace's plan and current usage counters")
    .option("--workspace <id>", "workspace id (defaults to this checkout's workspace)")
    .action(async (options: { workspace?: string }) => {
      // Goes through the service's own GET /v1/workspace/billing rather than opening a
      // PostgreSQL connection: this is an end-user command, and requiring DATABASE_URL
      // meant it could only ever run on a machine holding the production database
      // credentials -- which is nobody who would want to read their own plan.
      result = { value: await serviceRequest(directory, "/v1/workspace/billing", { workspaceId: options.workspace, describe: "Billing status" }) };
    });

  const devices = program.command("devices").description("paired devices holding a workspace token (owner only)");
  devices
    .command("list")
    .description("list every device paired into this workspace, and whether it is still active")
    .option("--workspace <id>", "workspace id (defaults to this checkout's workspace)")
    .action(async (options: { workspace?: string }) => {
      result = { value: await serviceRequest(directory, "/v1/workspace-tokens", { workspaceId: options.workspace, describe: "Device list" }) };
    });
  devices
    .command("revoke")
    .description("revoke a paired device's workspace token, immediately and permanently")
    .argument("<tokenId>", "token id from `crosscode devices list`")
    .option("--workspace <id>", "workspace id (defaults to this checkout's workspace)")
    .option("--yes", "skip the confirmation prompt")
    .action(async (tokenId: string, options: { workspace?: string; yes?: boolean }) => {
      if (!options.yes) {
        if (!process.stdout.isTTY) throw new CliError("CONFIRMATION_REQUIRED", "Revoking a device requires confirmation; pass --yes in noninteractive environments", "Pass --yes to revoke without an interactive prompt.");
        if (!await confirm(`Revoke device token ${tokenId}? It cannot be un-revoked. [y/N] `)) {
          throw new CliError("CANCELLED", "Revocation cancelled", "Re-run with --yes to revoke without the confirmation prompt.");
        }
      }
      result = { value: await serviceRequest(directory, `/v1/workspace-tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE", workspaceId: options.workspace, describe: "Device revocation" }) };
    });

  const members = program.command("members").description("workspace membership");
  members
    .command("list")
    .description("list this workspace's members and their roles")
    .option("--workspace <id>", "workspace id (defaults to this checkout's workspace)")
    .action(async (options: { workspace?: string }) => {
      result = { value: await serviceRequest(directory, "/v1/members", { workspaceId: options.workspace, describe: "Member list" }) };
    });
  members
    .command("remove")
    .description("remove a member's access, along with their devices and workspace tokens (owner only)")
    .argument("<memberId>", "member id from `crosscode members list`")
    .option("--workspace <id>", "workspace id (defaults to this checkout's workspace)")
    .option("--yes", "skip the confirmation prompt")
    .action(async (memberId: string, options: { workspace?: string; yes?: boolean }) => {
      if (!options.yes) {
        if (!process.stdout.isTTY) throw new CliError("CONFIRMATION_REQUIRED", "Removing a member requires confirmation; pass --yes in noninteractive environments", "Pass --yes to remove without an interactive prompt.");
        if (!await confirm(`Remove member ${memberId} and revoke their devices? [y/N] `)) {
          throw new CliError("CANCELLED", "Member removal cancelled", "Re-run with --yes to remove without the confirmation prompt.");
        }
      }
      result = { value: await serviceRequest(directory, `/v1/members/${encodeURIComponent(memberId)}`, { method: "DELETE", workspaceId: options.workspace, describe: "Member removal" }) };
    });

  program
    .command("commands")
    .description("list the full command tree as machine-readable JSON")
    .action(() => {
      result = { value: buildCatalog(program) };
    });

  // Answered here rather than by commander's own `--version` handler, which writes the bare
  // string straight to stdout and would break the guarantee that `--json` prints exactly one
  // line of JSON. Returning it as a value routes it through the same envelope as every other
  // command: `0.1.0` plain, `{"value":"0.1.0"}` with --json. `.version()` above still
  // registers the flag so `--help` documents it.
  //
  // Only the leading flags are considered, because `--version` is a flag on the root program:
  // anything at or after the first bare word belongs to a subcommand, and claiming a `-V` from
  // there would answer for an option some subcommand owns.
  const firstSubcommand = parseArgs.findIndex((value) => !value.startsWith("-"));
  const globalFlags = firstSubcommand < 0 ? parseArgs : parseArgs.slice(0, firstSubcommand);
  if (globalFlags.some((value) => value === "--version" || value === "-V")) return { value: VERSION };

  try {
    await program.parseAsync(parseArgs, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return { exitCode: error.exitCode };
      }
      throw new CliError(
        "USAGE_ERROR",
        error.message.replace(/^error: /, ""),
        "Run `crosscode --help` or `crosscode commands --json` to see available commands."
      );
    }
    throw error;
  }

  return result;
}

function formatError(error: unknown): { error: { code: string; message: string; hint?: string } } {
  if (error instanceof CliError) return { error: { code: error.code, message: error.message, hint: error.hint } };
  // The browser-login errors already carry the frozen contract's codes and their own hints.
  if (error instanceof BrowserLoginError) return { error: { code: error.code, message: error.message, hint: error.hint } };
  // Same shape: a stable code plus a hint naming the two variables to set.
  if (error instanceof SupabaseConfigError) return { error: { code: error.code, message: error.message, hint: error.hint } };
  if (error instanceof DaemonUnavailableError) {
    return { error: { code: error.code, message: error.message, hint: "Run `crosscode init` if this checkout has no configuration, then start the daemon by making one MCP tool call, which starts it for you." } };
  }
  const message = error instanceof Error ? error.message : "Command failed";
  if (message === "Unknown command") return { error: { code: "UNKNOWN_COMMAND", message, hint: "Run `crosscode commands --json` to see available commands." } };
  return { error: { code: "COMMAND_FAILED", message } };
}

/**
 * Loads and runs the MCP server, which starts serving on import.
 *
 * The specifier is built at runtime so esbuild leaves it alone: the MCP server is its own
 * bundle (`dist/mcp.js`) and inlining it here would make every `crosscode` invocation pay
 * to load the MCP SDK. The two candidates mirror `resolveDaemonLaunch`'s two layouts --
 * bundled beside us when installed from npm, TypeScript source in a monorepo clone.
 */
async function serveMcpServer(): Promise<void> {
  const bundled = new URL("./mcp.js", import.meta.url);
  const source = new URL("../../mcp-server/src/main.ts", import.meta.url);
  const entry = existsSync(fileURLToPath(bundled)) ? bundled : source;
  await import(entry.href);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  try {
    const result = await runCli(args);
    // --json wraps success in {"value":…} so it is symmetric with the {"error":…}
    // failure shape: an agent can branch on which key is present. Without --json the
    // value is printed bare, because the envelope is only noise for a human reader.
    if (result.value !== undefined) process.stdout.write(json ? `${JSON.stringify({ value: result.value })}\n` : `${typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2)}\n`);
    process.exitCode = result.exitCode ?? 0;
  } catch (error) {
    const value = formatError(error);
    process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${JSON.stringify(value, null, 2)}\n`);
    process.exitCode = 1;
  }
}

// realpath, not argv[1] as given: npm installs a `bin` as a symlink into its bin directory,
// so argv[1] is that symlink while import.meta.url is the resolved module. Comparing them
// raw makes the installed `crosscode` binary exit silently having done nothing.
function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return import.meta.url === pathToFileURL(invoked).href;
  }
}

/**
 * Both published bins point at this file, and this is what tells them apart.
 *
 * npm only auto-picks a package's executable when every `bin` entry names the same file, or
 * when one is named after the package -- and `@crosscode/cli`'s unscoped name is `cli`,
 * which matches neither `crosscode` nor `crosscode-mcp`. Shipping two distinct bin targets
 * therefore made `npx @crosscode/cli start` fail outright with "could not determine
 * executable to run". Pointing both at this file satisfies the first rule, so npx resolves
 * `crosscode`, and dispatching on the name we were invoked under keeps `crosscode-mcp`.
 *
 * npm's Windows `.cmd` shims pass the resolved script path as argv[1] rather than the bin
 * name, so there is nothing to dispatch on there; `crosscode mcp` is the spelling that works
 * everywhere, and it is what `crosscode start` writes into an MCP config on Windows.
 */
function invokedAsMcpBin(): boolean {
  const invoked = process.argv[1];
  return Boolean(invoked) && basename(invoked!).replace(/\.(cmd|exe|ps1)$/i, "") === "crosscode-mcp";
}

if (isMainModule()) void (invokedAsMcpBin() ? serveMcpServer() : main());
