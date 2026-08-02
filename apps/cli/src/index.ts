#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { DaemonClient } from "../../daemon/src/client.js";
import { login, logout, readDaemonConfig, redeemInvite, signup, writeDaemonConfig } from "../../daemon/src/runtime.js";

type CliResult = { value?: unknown; exitCode?: number };

class CliError extends Error {
  constructor(public readonly code: string, message: string, public readonly hint?: string) {
    super(message);
  }
}

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
    if (separator < 0 || !args[separator + 1]) throw new CliError("USAGE_ERROR", "Usage: crosscode run -- <command> [args]");
    const child = spawn(args[separator + 1]!, args.slice(separator + 2), { cwd: directory, stdio: "inherit" });
    const exitCode = await new Promise<number>((resolveRun, rejectRun) => {
      child.once("error", rejectRun);
      child.once("exit", (code) => resolveRun(code ?? 1));
    });
    return { exitCode };
  }

  if (command === "validate" && args.includes("--")) {
    throw new CliError("UNTRUSTED_VALIDATION_ARGS", "Validation commands must come from trusted .crosscode/config.yaml profiles");
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
    .option("--json", "output compact JSON instead of pretty-printed JSON")
    .exitOverride()
    .configureOutput({ writeOut: (str) => process.stdout.write(str), writeErr: () => {} });

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
      if (!workspaceId) throw new CliError("USAGE_ERROR", "Usage: crosscode join --workspace <workspaceId> | --invite <code> (run `crosscode -- login` first)");
      const updated = { ...settings, workspaceId };
      await writeDaemonConfig(directory, updated);
      result = { value: updated };
    });

  program
    .command("login")
    .description("log in to the crosscode service")
    .option("--email <email>", "account email")
    .option("--password <password>", "account password")
    .option("--service <url>", "service URL")
    .action(async (options: { email?: string; password?: string; service?: string }) => {
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
        throw new CliError("USAGE_ERROR", "Usage: crosscode -- login --email <email> --password <password> [--service <url>] (or set CROSSCODE_EMAIL/CROSSCODE_PASSWORD)");
      }
      const updated = await login(directory, { email, password, serviceUrl });
      result = { value: { workspaceId: updated.workspaceId, actorId: updated.actorId, service: { url: updated.service!.url, loggedIn: true } } };
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
        throw new CliError("USAGE_ERROR", "Usage: crosscode -- signup --email <email> --password <password> [--invite <code>] [--service <url>] (or set CROSSCODE_EMAIL/CROSSCODE_PASSWORD)");
      }
      let updated = await signup(directory, { email, password, serviceUrl });
      if (options.invite) updated = await redeemInvite(directory, options.invite);
      result = { value: { workspaceId: updated.workspaceId, actorId: updated.actorId, service: { url: updated.service!.url, loggedIn: true } } };
    });

  program
    .command("logout")
    .description("log out of the crosscode service")
    .action(async () => {
      await logout(directory);
      result = { value: { loggedOut: true } };
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

  const checkpoint = program
    .command("checkpoint")
    .description("create a checkpoint")
    .option("--message <message>", "checkpoint message")
    .action(async (options: { message?: string }) => {
      result = { value: await (await client()).checkpoint(options.message) };
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
        throw new CliError("USAGE_ERROR", 'Usage: crosscode publish --branch <branch> --profile <name> [--message "..."] [--dry-run] [--yes]');
      }
      const input = { branch: options.branch, profile: options.profile, message: options.message, dryRun: Boolean(options.dryRun) };
      if (!options.yes) {
        if (!process.stdout.isTTY) throw new CliError("CONFIRMATION_REQUIRED", "Publishing requires confirmation; pass --yes in noninteractive environments", "Pass --yes to publish without an interactive prompt.");
        const confirmed = await confirm(`Publish to branch "${input.branch}"? [y/N] `);
        if (!confirmed) throw new CliError("CANCELLED", "Publish cancelled");
      }
      result = { value: await (await client()).publish(input) };
    });

  program
    .command("commands")
    .description("list the full command tree as machine-readable JSON")
    .action(() => {
      result = { value: buildCatalog(program) };
    });

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
  const message = error instanceof Error ? error.message : "Command failed";
  if (message === "Unknown command") return { error: { code: "UNKNOWN_COMMAND", message, hint: "Run `crosscode commands --json` to see available commands." } };
  if (message.startsWith("Crosscode daemon is unavailable")) {
    return { error: { code: "DAEMON_UNAVAILABLE", message, hint: "Run `crosscode init` and make sure the daemon is running." } };
  }
  return { error: { code: "COMMAND_FAILED", message } };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  try {
    const result = await runCli(args);
    if (result.value !== undefined) process.stdout.write(json ? `${JSON.stringify(result.value)}\n` : `${typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2)}\n`);
    process.exitCode = result.exitCode ?? 0;
  } catch (error) {
    const value = formatError(error);
    process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${JSON.stringify(value, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
