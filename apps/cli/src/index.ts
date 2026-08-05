#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { DaemonClient, DaemonUnavailableError } from "../../daemon/src/client.js";
import { BrowserLoginError } from "../../daemon/src/browser-login.js";
import { SupabaseConfigError } from "../../daemon/src/supabase-client.js";
import { readDaemonConfig, redeemInvite, writeDaemonConfig } from "../../daemon/src/runtime.js";
import { VERSION } from "../../daemon/src/version.js";
import { CliError } from "./errors.js";
import { MCP_CLIENTS, parseMcpClient } from "./mcp-config.js";
import { start } from "./start.js";

type CliResult = { value?: unknown; exitCode?: number };

export async function runCli(args: string[], directory = process.cwd()): Promise<CliResult> {
  const command = args[0];

  // Serves MCP over this process's stdio and never returns, so it is handled before the
  // parser rather than as an action that would fall through to printing a result.
  if (command === "mcp") {
    await serveMcpServer();
    return {};
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
    .option("--no-browser", "print the sign-in URL instead of opening a browser, for remote shells and CI")
    .option("--mcp <client>", `MCP client to register with: ${MCP_CLIENTS.join(", ")}`, "claude")
    .option("--no-mcp", "skip MCP client registration")
    .action(async (options: { email?: string; password?: string; web?: string; browser?: boolean; mcp?: string | boolean }) => {
      result = {
        value: await start(directory, {
          email: options.email,
          password: options.password,
          web: options.web,
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
    .command("join")
    .description("join a workspace")
    .argument("[workspaceId]", "workspace id (or use --workspace / --invite)")
    .option("--workspace <id>", "workspace id")
    .option("--invite <code>", "invite code (alternative to --workspace)")
    .action(async (positional: string | undefined, options: { workspace?: string; invite?: string }) => {
      if (options.invite) {
        result = { value: await redeemInvite(directory, options.invite) };
        return;
      }
      const settings = await readDaemonConfig(directory);
      const workspaceId = options.workspace ?? positional;
      if (!workspaceId) throw new CliError("USAGE_ERROR", "Usage: crosscode join --workspace <workspaceId> | --invite <code>", "Run `crosscode start` first to sign in.");
      const updated = { ...settings, workspaceId };
      await writeDaemonConfig(directory, updated);
      result = { value: updated };
    });

  program
    .command("status")
    .description("show workspace and daemon status")
    .action(async () => {
      result = { value: await (await client()).status() };
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
        "Run `crosscode --help` to see available commands."
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
    return { error: { code: error.code, message: error.message, hint: "Run `crosscode start` if this checkout has no configuration, then start the daemon by making one MCP tool call, which starts it for you." } };
  }
  const message = error instanceof Error ? error.message : "Command failed";
  if (message === "Unknown command") return { error: { code: "UNKNOWN_COMMAND", message, hint: "Run `crosscode --help` to see available commands." } };
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
