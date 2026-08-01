#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { DaemonClient } from "../../daemon/src/client.js";
import { login, logout, readDaemonConfig, writeDaemonConfig } from "../../daemon/src/runtime.js";

type CliResult = { value?: unknown; exitCode?: number };

const valueAfter = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

export async function runCli(args: string[], directory = process.cwd()): Promise<CliResult> {
  const command = args[0];
  if (command === "init") {
    const settings = { workspaceId: randomUUID(), replicaId: randomUUID(), actorId: process.env.USER ?? "local-user" };
    await writeDaemonConfig(directory, settings);
    return { value: settings };
  }
  if (command === "join") {
    const settings = await readDaemonConfig(directory);
    const workspaceId = valueAfter(args, "--workspace") ?? args[1];
    if (!workspaceId) throw new Error("Usage: crosscode join --workspace <workspaceId> (run `crosscode -- login` first)");
    const updated = { ...settings, workspaceId };
    await writeDaemonConfig(directory, updated);
    return { value: updated };
  }
  if (command === "login") {
    let email = valueAfter(args, "--email") ?? process.env.CROSSCODE_EMAIL;
    let password = valueAfter(args, "--password") ?? process.env.CROSSCODE_PASSWORD;
    const serviceUrl = valueAfter(args, "--service");
    if ((!email || !password) && process.stdout.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      if (!email) email = await rl.question("Email: ");
      if (!password) password = await rl.question("Password: ");
      rl.close();
    }
    if (!email || !password) throw new Error("Usage: crosscode -- login --email <email> --password <password> [--service <url>] (or set CROSSCODE_EMAIL/CROSSCODE_PASSWORD)");
    const updated = await login(directory, { email, password, serviceUrl });
    return { value: { workspaceId: updated.workspaceId, actorId: updated.actorId, service: { url: updated.service!.url, loggedIn: true } } };
  }
  if (command === "logout") {
    await logout(directory);
    return { value: { loggedOut: true } };
  }
  if (command === "run") {
    const separator = args.indexOf("--");
    if (separator < 0 || !args[separator + 1]) throw new Error("Usage: crosscode run -- <command> [args]");
    const child = spawn(args[separator + 1]!, args.slice(separator + 2), { cwd: directory, stdio: "inherit" });
    const exitCode = await new Promise<number>((resolveRun, rejectRun) => {
      child.once("error", rejectRun);
      child.once("exit", (code) => resolveRun(code ?? 1));
    });
    return { exitCode };
  }

  const client = await DaemonClient.connect(directory);
  if (command === "status") return { value: await client.status() };
  if (command === "checkpoint" && args[1] === "inspect") return { value: await client.inspectCheckpoint(args[2] ?? "") };
  if (command === "checkpoint" && args[1] === "restore") return { value: await client.restoreCheckpoint(args[2] ?? "", args[3] ?? "") };
  if (command === "checkpoint") return { value: await client.checkpoint(valueAfter(args, "--message")) };
  if (command === "task" && args[1] === "create") return { value: await client.createTask({ title: args[2] ?? "", paths: valueAfter(args, "--path") ? [valueAfter(args, "--path")!] : [] }) };
  if (command === "claim" && args[1] === "path") return { value: await client.createClaim({ taskId: valueAfter(args, "--task") ?? "", kind: "path", target: args[2] ?? "", mode: "exclusive-preferred" }) };
  if (command === "intent") return { value: await client.publishIntent({ text: args[1] ?? "", taskId: valueAfter(args, "--task") }) };
  if (command === "handoff" && args[1] === "request") return { value: await client.requestHandoff({ operationId: args[2] ?? "", note: valueAfter(args, "--note") }) };
  if (command === "handoff" && args[1] === "respond") return { value: await client.respondHandoff(args[2] ?? "", (valueAfter(args, "--decision") ?? "") as "accepted" | "declined") };
  if (command === "proposals" && args[1] === "list") return { value: (await client.operations()).filter((operation) => operation.status === "proposed") };
  if (command === "proposals" && args[1] === "inspect") return { value: await client.analyze(args[2] ?? "") };
  if (command === "proposals" && args[1] === "diff") return { value: await client.diff(args[2] ?? "") };
  if (command === "proposals" && args[1] === "artifacts") return { value: await client.artifacts(args[2] ?? "") };
  if (command === "accept") return { value: await client.accept(args[1] ?? "") };
  if (command === "reject") return { value: await client.reject(args[1] ?? "") };
  if (command === "validate") {
    if (args.includes("--")) throw new Error("Validation commands must come from trusted .crosscode/config.yaml profiles");
    return { value: await client.validate(valueAfter(args, "--profile") ?? "fast") };
  }
  if (command === "publish") {
    const branch = valueAfter(args, "--branch");
    const profile = valueAfter(args, "--profile");
    if (!branch || !profile) throw new Error("Usage: crosscode publish --branch <branch> --profile <name> [--message \"...\"] [--dry-run] [--yes]");
    const input = { branch, profile, message: valueAfter(args, "--message"), dryRun: args.includes("--dry-run") };
    if (!args.includes("--yes")) {
      if (!process.stdout.isTTY) throw new Error("Publishing requires confirmation; pass --yes in noninteractive environments");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Publish to branch "${branch}"? [y/N] `);
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) throw new Error("Publish cancelled");
    }
    return { value: await client.publish(input) };
  }
  throw new Error("Unknown command");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  try {
    const result = await runCli(args);
    if (result.value !== undefined) process.stdout.write(json ? `${JSON.stringify(result.value)}\n` : `${typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2)}\n`);
    process.exitCode = result.exitCode ?? 0;
  } catch (error) {
    const value = { error: error instanceof Error ? error.message : "Command failed" };
    process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${JSON.stringify(value, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
