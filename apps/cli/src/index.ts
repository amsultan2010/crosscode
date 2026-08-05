#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { discoverRepository } from "@crosscode/git";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { CliError } from "./errors.js";
import { invite } from "./invite.js";
import { defaultEnvironment, setup, type Environment } from "./setup.js";
import { VERSION } from "./version.js";

/**
 * Five commands, and there is no sixth.
 *
 * `start` `invite` `join` `status` `stop`. Everything Crosscode does that is not one of
 * these is done by the daemon without being asked, or by the user's own agent through MCP.
 * A command surface is the part of a product a first-time user has to read, and this one is
 * meant to be readable in a single breath.
 */

type CliResult = { value?: unknown; exitCode?: number };

export async function runCli(args: string[], directory = process.cwd(), environment: Environment = defaultEnvironment()): Promise<CliResult> {
  // --json is a purely presentational, position-independent flag handled by main(); strip it
  // before commander sees it so it never has to be declared on every subcommand or fought
  // over positionally.
  const parseArgs = args.filter((value) => value !== "--json");

  let result: CliResult = {};
  // Progress goes to stderr, not stdout: --json output has to stay a single parseable object.
  const report = (line: string) => process.stderr.write(`${line}\n`);

  const program = new Command();
  program
    .name("crosscode")
    .description("Real-time codebase sync between teammates")
    .version(VERSION)
    .option("--json", "output compact JSON instead of pretty-printed JSON")
    .exitOverride()
    .configureOutput({ writeOut: (str) => process.stdout.write(str), writeErr: () => {} });

  program
    .command("start")
    .description("set this checkout up end to end: sign in, pick the project, start the daemon, install the agent surface")
    .option("--no-browser", "print the sign-in URL instead of opening a browser, for remote shells and CI")
    .action(async (options: { browser?: boolean }) => {
      result = { value: await setup(directory, environment, { openBrowser: options.browser !== false, report }) };
    });

  program
    .command("invite")
    .description("print a link that invites a teammate to this project")
    .action(async () => {
      result = { value: (await invite(directory, environment)).url };
    });

  program
    .command("join")
    .description("redeem an invite code in this checkout, then set it up exactly as `start` would")
    .argument("<code>", "invite code from the join page, e.g. CC-7F3A-9C2E")
    .option("--no-browser", "print the sign-in URL instead of opening a browser, for remote shells and CI")
    .action(async (code: string, options: { browser?: boolean }) => {
      result = { value: await setup(directory, environment, { code, openBrowser: options.browser !== false, report }) };
    });

  program
    .command("status")
    .description("show what this checkout's daemon is doing")
    .action(async () => {
      result = { value: await environment.createDaemon(await repoRoot(directory)).status() };
    });

  program
    .command("stop")
    .description("stop the daemon for this checkout")
    .action(async () => {
      result = { value: await environment.createDaemon(await repoRoot(directory)).stop() };
    });

  // Answered here rather than by commander's own `--version` handler, which writes the bare
  // string straight to stdout and would break the guarantee that `--json` prints exactly one
  // line of JSON. Returning it as a value routes it through the same envelope as every other
  // command. `.version()` above still registers the flag so `--help` documents it.
  //
  // Only the leading flags are considered, because `--version` is a flag on the root program:
  // anything at or after the first bare word belongs to a subcommand.
  const firstSubcommand = parseArgs.findIndex((value) => !value.startsWith("-"));
  const globalFlags = firstSubcommand < 0 ? parseArgs : parseArgs.slice(0, firstSubcommand);
  if (globalFlags.some((value) => value === "--version" || value === "-V")) return { value: VERSION };

  try {
    await program.parseAsync(parseArgs, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return { exitCode: error.exitCode };
      throw new CliError("USAGE_ERROR", error.message.replace(/^error: /, ""), "Run `crosscode --help` to see available commands.");
    }
    throw error;
  }

  return result;
}

async function repoRoot(directory: string): Promise<string> {
  const repository = await discoverRepository(directory).catch(() => undefined);
  if (!repository) throw new CliError("NOT_A_GIT_REPOSITORY", "Crosscode runs inside a Git repository", "cd into your project first.");
  return repository.root;
}

function formatError(error: unknown): { error: { code: string; message: string; hint?: string } } {
  if (error instanceof CliError) return { error: { code: error.code, message: error.message, hint: error.hint } };
  const message = error instanceof Error ? error.message : "Command failed";
  return { error: { code: "COMMAND_FAILED", message } };
}

/**
 * Loads and runs the MCP server, which starts serving on import.
 *
 * The specifier is built at runtime so esbuild leaves it alone: the MCP server is its own
 * bundle (`dist/mcp.js`) and inlining it here would make every `crosscode` invocation pay to
 * load the MCP SDK. The two candidates are the two layouts the CLI ships in -- bundled beside
 * us when installed from npm, TypeScript source in a monorepo clone.
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
    // --json wraps success in {"value":…} so it is symmetric with the {"error":…} failure
    // shape: an agent can branch on which key is present. Without --json the value is
    // printed bare, because the envelope is only noise for a human reader.
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
 * npm only auto-picks a package's executable when every `bin` entry names the same file, so
 * shipping two distinct bin targets made `npx @crosscode/cli start` fail outright with
 * "could not determine executable to run". Pointing both at this file satisfies that rule,
 * and dispatching on the name we were invoked under keeps `crosscode-mcp` working.
 *
 * npm's Windows `.cmd` shims pass the resolved script path as argv[1] rather than the bin
 * name, so there is nothing to dispatch on there. `CROSSCODE_SERVE_MCP=1` is the spelling
 * that works everywhere, and it is what `crosscode start` writes into a Windows MCP config
 * -- serving MCP is not a sixth command.
 */
function shouldServeMcp(): boolean {
  if (process.env.CROSSCODE_SERVE_MCP === "1") return true;
  const invoked = process.argv[1];
  return Boolean(invoked) && basename(invoked!).replace(/\.(cmd|exe|ps1)$/i, "") === "crosscode-mcp";
}

if (isMainModule()) void (shouldServeMcp() ? serveMcpServer() : main());
