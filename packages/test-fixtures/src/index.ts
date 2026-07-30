import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runDaemonProcess, type ManagedDaemon } from "../../../apps/daemon/src/runtime.js";

const exec = promisify(execFile);

export type { ManagedDaemon };

export type CreateTempRepoOptions = {
  prefix?: string;
  fileName?: string;
  content?: string;
};

const tempRepos: string[] = [];

export async function createTempRepo(options: CreateTempRepoOptions = {}): Promise<string> {
  const { prefix = "crosscode-", fileName = "seed.txt", content = "seed\n" } = options;
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempRepos.push(directory);
  await exec("git", ["init", "-q", "-b", "main", directory]);
  await exec("git", ["-C", directory, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", directory, "config", "user.name", "Test"]);
  await writeFile(join(directory, fileName), content);
  await exec("git", ["-C", directory, "add", "."]);
  await exec("git", ["-C", directory, "commit", "-qm", "initial"]);
  return directory;
}

export async function cleanupTempRepos(): Promise<void> {
  await Promise.all(tempRepos.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}

export async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value: T;
  for (;;) {
    value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  }
}

const daemons = new Set<ManagedDaemon>();

export type SpawnDaemonOptions = Parameters<typeof runDaemonProcess>[1];

export async function spawnDaemon(directory: string, options?: SpawnDaemonOptions): Promise<ManagedDaemon> {
  const daemon = await runDaemonProcess(directory, options);
  daemons.add(daemon);
  return daemon;
}

export async function stopDaemon(daemon: ManagedDaemon): Promise<void> {
  if (!daemons.delete(daemon)) return;
  await daemon.stop();
}

export async function stopAllDaemons(): Promise<void> {
  await Promise.all([...daemons].map((daemon) => stopDaemon(daemon)));
}
