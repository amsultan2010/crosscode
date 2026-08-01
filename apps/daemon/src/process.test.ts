import { spawn, execFile, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationService } from "../../service/src/index.js";
import { runCli } from "../../cli/src/index.js";
import { DaemonClient } from "./client.js";
import { LocalDaemon } from "./index.js";
import { daemonConnectionPath } from "./runtime.js";

const exec = promisify(execFile);
const directories: string[] = [];
const children = new Set<ChildProcess>();

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (await accept(value)) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for condition${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function fixture(): Promise<{ sender: string; receiver: string }> {
  const root = await mkdtemp(join(tmpdir(), "crosscode-process-"));
  directories.push(root);
  const seed = join(root, "seed");
  const sender = join(root, "sender");
  const receiver = join(root, "receiver");
  await exec("git", ["init", "-q", "-b", "main", seed]);
  await exec("git", ["-C", seed, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", seed, "config", "user.name", "Test"]);
  await writeFile(join(seed, "a.txt"), "one\n");
  await exec("git", ["-C", seed, "add", "."]);
  await exec("git", ["-C", seed, "commit", "-qm", "initial"]);
  await exec("git", ["clone", "-q", seed, sender]);
  await exec("git", ["clone", "-q", seed, receiver]);
  for (const checkout of [sender, receiver]) {
    await exec("git", ["-C", checkout, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", checkout, "config", "user.name", "Test"]);
  }
  await mkdir(join(receiver, ".git", "crosscode"), { recursive: true });
  await writeFile(join(receiver, ".git", "crosscode", "config.json"), JSON.stringify({ workspaceId: "w", replicaId: "receiver", actorId: "actor" }));
  return { sender, receiver };
}

function startProcess(directory: string): ChildProcess {
  const entry = resolve("apps/daemon/src/main.ts");
  const child = spawn(process.execPath, ["--import", "tsx", entry, "--directory", directory], { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function stop(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

afterEach(async () => {
  await Promise.all([...children].map((child) => stop(child, "SIGKILL")));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("daemon process lifecycle", () => {
  it("survives restart with offline work and proposals, and observes Git transitions", async () => {
    const { sender, receiver } = await fixture();
    const service = new CoordinationService();
    const sending = await LocalDaemon.open(sender, { workspaceId: "w", replicaId: "sender", actorId: "sender" });
    const receiving = await LocalDaemon.open(receiver, { workspaceId: "w", replicaId: "receiver", actorId: "actor" });
    await writeFile(join(sender, "a.txt"), "remote\n");
    const remote = await sending.capture("remote change", service);
    await receiving.sync(service);
    sending.close();
    receiving.close();

    const first = startProcess(receiver);
    const client = await waitFor(() => DaemonClient.connect(receiver), () => true);
    expect((await stat(await daemonConnectionPath(receiver))).mode & 0o777).toBe(0o600);
    const duplicate = startProcess(receiver);
    const duplicateExit = await new Promise<number | null>((resolveExit) => duplicate.once("exit", (code) => resolveExit(code)));
    expect(duplicateExit).toBe(1);
    await expect(runCli(["status", "--json"], receiver)).resolves.toMatchObject({ value: { workspaceId: "w", replicaId: "receiver" } });
    await expect(runCli(["task", "create", "No accidental flags", "--json"], receiver)).resolves.toMatchObject({ value: { paths: [] } });
    await writeFile(join(receiver, "offline.txt"), "offline\n");
    const operations = await waitFor(() => client.operations(), (items) => items.some((item) => item.status === "local" && item.transaction.changes.some((change) => change.path === "offline.txt")));
    expect(operations).toEqual(expect.arrayContaining([expect.objectContaining({ id: remote.id, status: "proposed" })]));
    const beforeTransition = await client.status();

    await exec("git", ["-C", receiver, "switch", "-c", "other"]);
    const afterTransition = await waitFor(() => client.status(), (status) => status.branch === "other" && status.eventSequence > beforeTransition.eventSequence && !status.materializationPaused);
    expect(afterTransition.materializationPaused).toBe(false);
    expect(await readFile(join(receiver, "a.txt"), "utf8")).toBe("one\n");
    expect((await client.checkpoints()).length).toBeGreaterThan(0);

    await stop(first, "SIGKILL");
    await expect(runCli(["status", "--json"], receiver)).rejects.toThrow(/daemon/i);

    const second = startProcess(receiver);
    const restarted = await waitFor(() => DaemonClient.connect(receiver), async (candidate) => (await candidate.status()).eventSequence >= afterTransition.eventSequence);
    const restored = await restarted.operations();
    expect(restored).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: remote.id, status: "proposed" }),
      expect.objectContaining({
        status: "local",
        transaction: expect.objectContaining({
          changes: expect.arrayContaining([expect.objectContaining({ path: "offline.txt" })])
        })
      })
    ]));
    const restoredCheckpoints = await restarted.checkpoints();
    expect(restoredCheckpoints.length).toBeGreaterThan(0);
    const checkpointFiles = await Promise.all(restoredCheckpoints.map((checkpoint) => restarted.inspectCheckpoint(checkpoint.ref).then((value) => value.files)));
    expect(checkpointFiles.some((files) => files.includes("offline.txt"))).toBe(true);
    expect(await readFile(join(receiver, "a.txt"), "utf8")).toBe("one\n");

    await stop(second, "SIGTERM");
    await expect(access(await daemonConnectionPath(receiver))).rejects.toThrow();
  }, 45_000);
});
