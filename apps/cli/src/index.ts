#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DaemonClient } from "../../daemon/src/client.js";
import { readDaemonConfig, writeDaemonConfig } from "../../daemon/src/runtime.js";

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
    const updated = { ...settings, workspaceId: args[1] ?? settings.workspaceId };
    await writeDaemonConfig(directory, updated);
    return { value: updated };
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
  if (command === "proposals" && args[1] === "list") return { value: (await client.operations()).filter((operation) => operation.status === "proposed") };
  if (command === "proposals" && args[1] === "inspect") return { value: await client.analyze(args[2] ?? "") };
  if (command === "accept") return { value: await client.accept(args[1] ?? "") };
  if (command === "reject") return { value: await client.reject(args[1] ?? "") };
  if (command === "validate") {
    if (args.includes("--")) throw new Error("Validation commands must come from trusted .crosscode/config.yaml profiles");
    return { value: await client.validate(valueAfter(args, "--profile") ?? "fast") };
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
