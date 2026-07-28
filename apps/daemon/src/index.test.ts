import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationService } from "../../service/src/index.js";
import { contentHash } from "@crosscode/core";
import { LocalDaemon } from "./index.js";

const exec = promisify(execFile); const directories: string[] = [];
async function repo(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "crosscode-daemon-")); directories.push(path); await exec("git", ["init", "-q", "-b", "main", path]); await exec("git", ["-C", path, "config", "user.email", "test@example.com"]); await exec("git", ["-C", path, "config", "user.name", "Test"]); await writeFile(join(path, "a.txt"), "one\n"); await exec("git", ["-C", path, "add", "."]); await exec("git", ["-C", path, "commit", "-qm", "initial"]); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("local daemon coordination", () => {
  it("shares a proposal only after explicit acceptance", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" }); const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });
    await writeFile(join(senderRoot, "a.txt"), "two\n"); const operation = await sender.capture("change", service);
    await receiver.sync(service); expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("one\n");
    await receiver.accept(operation.id); expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("two\n");
  });

  it("refuses stale-base proposals without overwriting local work", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" }); const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });
    await writeFile(join(senderRoot, "a.txt"), "sender\n"); const operation = await sender.capture("change", service);
    await writeFile(join(receiverRoot, "a.txt"), "receiver\n"); await receiver.sync(service);
    await expect(receiver.accept(operation.id)).rejects.toThrow("stale"); expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("receiver\n");
  });

  it("restores local state from its SQLite event store after restart", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    const task = await daemon.createTask({ title: "Persist this task", paths: ["a.txt"] });
    const claim = await daemon.createClaim({ taskId: task.id, kind: "path", target: "a.txt", mode: "exclusive-preferred" });
    await writeFile(join(root, "a.txt"), "changed\n");
    const operation = await daemon.capture("persist operation");
    const checkpoint = await daemon.checkpoint("persist checkpoint");
    const statePath = join(root, ".git", "crosscode", "state.sqlite");
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, ".git", "crosscode"))).mode & 0o777).toBe(0o700);

    const restarted = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    expect(restarted.tasks.get(task.id)).toEqual(task);
    expect(restarted.claims.get(claim.id)).toEqual(claim);
    expect(restarted.operations.get(operation.id)).toMatchObject({ id: operation.id, status: "local" });
    expect(restarted.checkpoints).toContainEqual(expect.objectContaining({ ref: checkpoint.ref, message: "persist checkpoint" }));

    const database = new DatabaseSync(statePath, { readOnly: true });
    const events = database.prepare("SELECT sequence, type, payload FROM local_events ORDER BY sequence").all() as Array<{ sequence: number; type: string; payload: string }>;
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["task.created", "claim.created", "transaction.created", "checkpoint.created"]));
    expect(events.every((event, index) => event.sequence === index + 1)).toBe(true);
    expect(JSON.parse(events.find((event) => event.type === "task.created")!.payload)).toEqual(task);
    expect(database.prepare("SELECT COUNT(*) AS count FROM task_projection").get()).toEqual({ count: 1 });
    database.close();
  });

  it("captures settled filesystem edits as a single local transaction", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    const captured = new Promise<string>((resolveCapture) => daemon.onTransaction((operation) => resolveCapture(operation.id)));
    const watcher = await daemon.watch({ debounceMs: 40 });
    await writeFile(join(root, "a.txt"), "two\n");

    const operationId = await captured;
    await watcher.close();
    expect(daemon.operations.get(operationId)?.transaction.changes).toMatchObject([{ path: "a.txt", kind: "modify" }]);
  });

  it("does not capture excluded filesystem paths", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    const watcher = await daemon.watch({ debounceMs: 40 });
    await writeFile(join(root, ".env"), "TOKEN=not-for-sync\n");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    await watcher.close();

    expect(daemon.operations.size).toBe(0);
  });

  it("does not advance the remote cursor for offline local work", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" }); const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });
    await writeFile(join(receiverRoot, "offline.txt"), "local only\n");
    await receiver.capture("offline work");
    await writeFile(join(senderRoot, "a.txt"), "shared\n");
    const remote = await sender.capture("shared work", service);

    const proposals = await receiver.sync(service);
    expect(proposals).toMatchObject([{ id: remote.id, status: "proposed" }]);
  });

  it("does not repeat an already captured uncommitted edit", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await writeFile(join(root, "a.txt"), "first\n");
    await daemon.capture("first edit");
    await writeFile(join(root, "b.txt"), "second\n");
    const second = await daemon.capture("second edit");

    expect(second.transaction.changes).toMatchObject([{ path: "b.txt", kind: "add" }]);
  });

  it("captures a Git rename as a safe delete and add transaction", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await exec("git", ["-C", root, "mv", "a.txt", "b.txt"]);

    const operation = await daemon.capture("rename file");

    expect(operation.transaction.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "a.txt", kind: "delete" }),
      expect.objectContaining({ path: "b.txt", kind: "add", afterContent: "one\n" })
    ]));
  });

  it("rejects symlink traversal and honors committed configured exclusions", async () => {
    const root = await repo();
    const outside = await mkdtemp(join(tmpdir(), "crosscode-outside-"));
    directories.push(outside);
    await writeFile(join(outside, "secret.txt"), "outside\n");
    await symlink(outside, join(root, "linked"));
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await expect(daemon.capture("read symlink")).rejects.toThrow(/symbolic link/i);

    await rm(join(root, "linked"));
    await mkdir(join(root, ".crosscode"), { recursive: true });
    await writeFile(join(root, ".crosscode", "config.yaml"), "version: 1\nvalidation:\n  profiles:\n    fast:\n      commands:\n        - node --version\nexcludedPaths:\n  - private/**\n");
    await mkdir(join(root, "private"), { recursive: true });
    await writeFile(join(root, "private", "ignored.txt"), "ignored\n");
    await exec("git", ["-C", root, "add", "-f", ".crosscode/config.yaml", "private/ignored.txt"]);
    await exec("git", ["-C", root, "commit", "-qm", "add exclusions"]);
    await writeFile(join(root, "private", "ignored.txt"), "still ignored\n");
    await expect(daemon.capture("excluded edit")).rejects.toThrow("No eligible");
  });

  it("refuses to materialize an incoming proposal under a committed exclusion", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    for (const root of [senderRoot, receiverRoot]) {
      await mkdir(join(root, "private"), { recursive: true });
      await writeFile(join(root, "private", "ignored.txt"), "base\n");
      await exec("git", ["-C", root, "add", "private/ignored.txt"]);
      await exec("git", ["-C", root, "commit", "-qm", "add exclusions"]);
    }
    await mkdir(join(receiverRoot, ".crosscode"), { recursive: true });
    await writeFile(join(receiverRoot, ".crosscode", "config.yaml"), "version: 1\nvalidation:\n  profiles:\n    fast:\n      commands:\n        - node --version\nexcludedPaths:\n  - private/**\n");
    await exec("git", ["-C", receiverRoot, "add", ".crosscode/config.yaml"]);
    await exec("git", ["-C", receiverRoot, "commit", "-qm", "configure exclusions"]);
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });
    await writeFile(join(senderRoot, "private", "ignored.txt"), "remote\n");
    const remote = await sender.capture("excluded remote edit", service);
    await receiver.sync(service);

    await expect(receiver.accept(remote.id)).rejects.toThrow("excluded path");
    expect(await readFile(join(receiverRoot, "private", "ignored.txt"), "utf8")).toBe("base\n");
  });

  it("rolls back a partially applied transaction when reopening after interruption", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    for (const root of [senderRoot, receiverRoot]) {
      await writeFile(join(root, "b.txt"), "base b\n");
      await exec("git", ["-C", root, "add", "b.txt"]);
      await exec("git", ["-C", root, "commit", "-qm", "add b"]);
    }
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });
    await writeFile(join(senderRoot, "a.txt"), "remote a\n");
    await writeFile(join(senderRoot, "b.txt"), "remote b\n");
    const remote = await sender.capture("two-file edit", service);
    await receiver.sync(service);
    const checkpoint = await receiver.checkpoint("before interrupted apply");
    const proposal = receiver.operations.get(remote.id)!;
    const applying = { ...proposal, status: "applying" as const, materializationCheckpoint: checkpoint.ref };
    receiver.operations.set(remote.id, applying);
    await (receiver as unknown as { persist(type: string, payload: unknown): Promise<void> }).persist("transaction.applying", applying);
    await writeFile(join(receiverRoot, "a.txt"), "remote a\n");
    receiver.close();

    const restarted = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });
    expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(receiverRoot, "b.txt"), "utf8")).toBe("base b\n");
    expect(restarted.operations.get(remote.id)?.status).toBe("proposed");
  });

  it("preserves newer developer edits instead of rolling them back after an interruption", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });
    await writeFile(join(senderRoot, "a.txt"), "remote\n");
    const remote = await sender.capture("remote edit", service);
    await receiver.sync(service);
    const checkpoint = await receiver.checkpoint("before interrupted apply");
    const proposal = receiver.operations.get(remote.id)!;
    const applying = { ...proposal, status: "applying" as const, materializationCheckpoint: checkpoint.ref };
    receiver.operations.set(remote.id, applying);
    await (receiver as unknown as { persist(type: string, payload: unknown): Promise<void> }).persist("transaction.applying", applying);
    receiver.close();
    await writeFile(join(receiverRoot, "a.txt"), "new developer edit\n");

    const restarted = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });

    expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("new developer edit\n");
    expect(restarted.operations.get(remote.id)?.status).toBe("conflicted");
  });

  it("records a local transaction durably before publishing it", async () => {
    const root = await repo(); const service = new CoordinationService();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    const originalReceive = service.receive.bind(service);
    let durableAtPublish = false;
    service.receive = (event, transaction) => {
      const database = new DatabaseSync(join(root, ".git", "crosscode", "state.sqlite"), { readOnly: true });
      durableAtPublish = database.prepare("SELECT COUNT(*) AS count FROM operation_projection WHERE id = ?").get(transaction.id)!.count === 1;
      database.close();
      return originalReceive(event, transaction);
    };
    await writeFile(join(root, "a.txt"), "published\n");

    await daemon.capture("durable publish", service);

    expect(durableAtPublish).toBe(true);
  });

  it("persists a stable outbox event and reconnects without applying remote files", async () => {
    const root = await repo();
    let daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await writeFile(join(root, "a.txt"), "offline\n");
    const local = await daemon.capture("offline durable event");
    const queued = [...daemon.outbound.values()].find((record) => record.event.id === local.id)!;
    daemon.close();

    daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    expect(daemon.outbound.get(queued.event.id)?.event).toEqual(queued.event);
    const remoteTransaction = {
      ...local.transaction,
      id: "remote-operation",
      changes: [{ ...local.transaction.changes[0]!, afterContent: "remote\n", afterHash: contentHash("remote\n") }]
    };
    const result = await daemon.syncRemote({
      upload: async (record) => ({ id: record.transaction.id, workspaceId: "w", senderReplicaId: "replica", transaction: record.transaction, sequence: 1, createdAt: new Date().toISOString() }),
      list: async () => ({ operations: [
        { id: local.id, workspaceId: "w", senderReplicaId: "replica", transaction: local.transaction, sequence: 1, createdAt: new Date().toISOString() },
        { id: remoteTransaction.id, workspaceId: "w", senderReplicaId: "other", transaction: remoteTransaction, sequence: 2, createdAt: new Date().toISOString() }
      ], nextCursor: 2 }),
      uploadTask: async (record) => ({ eventId: record.event.id, workspaceId: "w", senderReplicaId: "replica", task: record.event.payload, updatedAt: new Date().toISOString() }),
      listTasks: async (after) => ({ tasks: [], nextCursor: after }),
      uploadClaim: async (record) => ({ eventId: record.event.id, workspaceId: "w", senderReplicaId: "replica", claim: record.event.payload, released: record.event.type === "claim.released", updatedAt: new Date().toISOString() }),
      listClaims: async (after) => ({ claims: [], nextCursor: after })
    });

    expect(result).toEqual({ uploaded: 1, downloaded: 1, cursor: 2 });
    expect(daemon.outbound.get(queued.event.id)?.acknowledgedServerSequence).toBe(1);
    expect(daemon.operations.get("remote-operation")?.status).toBe("proposed");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("offline\n");
  });

  it("recognizes a same-HEAD hard reset as a Git transition", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await writeFile(join(root, "a.txt"), "dirty\n");
    await exec("git", ["-C", root, "reset", "--hard", "HEAD"]);

    await expect(daemon.observeGitTransition()).resolves.toMatchObject({ kind: "reset", paused: true });
  });

  it("rejects binary working-tree content instead of decoding it lossily", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await writeFile(join(root, "binary.dat"), Buffer.from([0xff, 0x00, 0xfe]));

    await expect(daemon.capture("binary edit")).rejects.toThrow(/binary/i);
  });

  it("pauses proposal application after a Git branch transition until proposals are re-analyzed", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" }); const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });
    await writeFile(join(senderRoot, "a.txt"), "shared\n");
    const remote = await sender.capture("shared work", service);
    await receiver.sync(service);
    await exec("git", ["-C", receiverRoot, "switch", "-c", "other"]);

    await expect(receiver.observeGitTransition()).resolves.toMatchObject({ kind: "branch-switch", paused: true });
    await expect(receiver.accept(remote.id)).rejects.toThrow("paused");
    await receiver.reanalyzePendingOperations();
    await expect(receiver.accept(remote.id)).resolves.toMatchObject({ status: "accepted" });
  });

  it("stays paused for the duration of a merge operation", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await exec("git", ["-C", root, "switch", "-c", "feature"]);
    await writeFile(join(root, "feature.txt"), "feature\n");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "feature"]);
    await exec("git", ["-C", root, "switch", "main"]);
    await exec("git", ["-C", root, "merge", "--no-ff", "--no-commit", "feature"]);

    await expect(daemon.observeGitTransition()).resolves.toMatchObject({ kind: "git-operation", paused: true });
    await daemon.reanalyzePendingOperations();
    await expect(daemon.status()).resolves.toMatchObject({ materializationPaused: true });

    await exec("git", ["-C", root, "merge", "--abort"]);
    await expect(daemon.observeGitTransition()).resolves.toMatchObject({ kind: "git-operation", paused: true });
    await daemon.reanalyzePendingOperations();
    await expect(daemon.status()).resolves.toMatchObject({ materializationPaused: false });
  });
});
