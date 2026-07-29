import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationService } from "../../service/src/index.js";
import { contentHash } from "@crosscode/core";
import { unifiedDiff } from "@crosscode/git";
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

    const statePath = join(receiverRoot, ".git", "crosscode", "state.sqlite");
    const database = new DatabaseSync(statePath, { readOnly: true });
    const rows = database.prepare("SELECT operation_id, path, classification, base_content, local_content, proposed_content, dependents, merged_candidate FROM conflict_artifact").all() as Array<{ operation_id: string; path: string; classification: string; base_content: string; local_content: string; proposed_content: string; dependents: string | null; merged_candidate: string | null }>;
    database.close();
    expect(rows).toEqual([{ operation_id: operation.id, path: "a.txt", classification: "stale-base", base_content: "one\n", local_content: "receiver\n", proposed_content: "sender\n", dependents: null, merged_candidate: null }]);
  });

  it("resolves a stale base through a clean three-way merge and records the merged candidate for approval", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const base = "line1\nline2\nline3\n";
    await writeFile(join(senderRoot, "a.txt"), base); await exec("git", ["-C", senderRoot, "commit", "-aqm", "seed"]);
    await writeFile(join(receiverRoot, "a.txt"), base); await exec("git", ["-C", receiverRoot, "commit", "-aqm", "seed"]);
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });

    await writeFile(join(senderRoot, "a.txt"), "LINE1\nline2\nline3\n");
    const operation = await sender.capture("edit line 1", service);
    await writeFile(join(receiverRoot, "a.txt"), "line1\nline2\nLINE3\n");
    await receiver.sync(service);

    await expect(receiver.accept(operation.id)).rejects.toThrow("three-way merge");
    expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("line1\nline2\nLINE3\n");
    expect(receiver.operations.get(operation.id)?.status).toBe("proposed");

    const statePath = join(receiverRoot, ".git", "crosscode", "state.sqlite");
    const database = new DatabaseSync(statePath, { readOnly: true });
    const rows = database.prepare("SELECT classification, merged_candidate FROM conflict_artifact WHERE operation_id = ?").all(operation.id) as Array<{ classification: string; merged_candidate: string }>;
    database.close();
    expect(rows).toEqual([{ classification: "stale-base-resolved", merged_candidate: "LINE1\nline2\nLINE3\n" }]);
  });

  it("classifies an overlapping delete-vs-modify conflict distinctly and records which side deleted", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });
    await writeFile(join(senderRoot, "a.txt"), "sender-edit\n");
    const operation = await sender.capture("edit", service);
    await receiver.sync(service);

    const deleteChange = { path: "a.txt", kind: "delete" as const, beforeHash: contentHash("one\n") };
    const pendingLocal = { id: "fake-local-op", workspaceId: "w", senderReplicaId: "receiver", transaction: { id: "fake-local-op", base: { files: [] }, changes: [deleteChange], provenance: { source: "filesystem" as const, confidence: "known" as const }, safety: { risk: "low" as const, requiresApproval: false } }, sequence: 1, createdAt: new Date().toISOString(), status: "local" as const };
    receiver.operations.set(pendingLocal.id, pendingLocal);

    await expect(receiver.accept(operation.id)).rejects.toThrow("requires local human approval");
    expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("one\n");

    const statePath = join(receiverRoot, ".git", "crosscode", "state.sqlite");
    const database = new DatabaseSync(statePath, { readOnly: true });
    const rows = database.prepare("SELECT classification FROM conflict_artifact WHERE operation_id = ?").all(operation.id) as Array<{ classification: string }>;
    database.close();
    expect(rows).toEqual([{ classification: "delete-vs-modify" }]);
    expect(receiver.operations.get(operation.id)?.transaction.safety).toEqual({ risk: "high", requiresApproval: true });
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
      listClaims: async (after) => ({ claims: [], nextCursor: after }),
      uploadHandoff: async (record) => ({ eventId: record.event.id, workspaceId: "w", senderReplicaId: "replica", handoff: record.event.payload, updatedAt: new Date().toISOString() }),
      listHandoffs: async (after) => ({ handoffs: [], nextCursor: after }),
      uploadIntent: async (record) => ({ eventId: record.event.id, workspaceId: "w", senderReplicaId: "replica", intent: record.event.payload, updatedAt: new Date().toISOString() }),
      listIntents: async (after) => ({ intents: [], nextCursor: after })
    });

    expect(result).toEqual({ uploaded: 1, downloaded: 1, cursor: 2 });
    expect(daemon.outbound.get(queued.event.id)?.acknowledgedServerSequence).toBe(1);
    expect(daemon.operations.get("remote-operation")?.status).toBe("proposed");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("offline\n");
  });

  it("enqueues outbound handoff and intent events and synchronizes them with the coordination service", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await writeFile(join(root, "a.txt"), "changed\n");
    const captured = await daemon.capture("local edit for handoff");
    const handoff = await daemon.requestHandoff({ operationId: captured.id, note: "please take over" });
    expect([...daemon.handoffOutbound.values()].some((record) => record.event.payload.id === handoff.id)).toBe(true);
    const responded = await daemon.respondHandoff(handoff.id, "accepted");
    expect(daemon.handoffOutbound.get(responded.id)?.event.type).toBe("handoff.responded");

    const intent = await daemon.publishIntent({ text: "Rename foo to bar", taskId: "task-1" });
    expect([...daemon.intentOutbound.values()].some((record) => record.event.payload.id === intent.id)).toBe(true);

    const remoteHandoffRecord = { eventId: "remote-handoff-event", workspaceId: "w", senderReplicaId: "other", handoff: { id: "remote-handoff", operationId: "operation-x", requestedBy: "other-actor", status: "pending" as const, createdAt: new Date().toISOString() }, updatedAt: new Date().toISOString() };
    const remoteIntentRecord = { eventId: "remote-intent-event", workspaceId: "w", senderReplicaId: "other", intent: { id: "remote-intent", actorId: "other-actor", text: "Remote intent", createdAt: new Date().toISOString() }, updatedAt: new Date().toISOString() };
    const uploadedHandoffs: string[] = [];
    const uploadedIntents: string[] = [];
    const result = await daemon.syncRemote({
      upload: async (record) => ({ id: record.transaction.id, workspaceId: "w", senderReplicaId: "replica", transaction: record.transaction, sequence: 1, createdAt: new Date().toISOString() }),
      list: async () => ({ operations: [], nextCursor: 0 }),
      uploadTask: async (record) => ({ eventId: record.event.id, workspaceId: "w", senderReplicaId: "replica", task: record.event.payload, updatedAt: new Date().toISOString() }),
      listTasks: async (after) => ({ tasks: [], nextCursor: after }),
      uploadClaim: async (record) => ({ eventId: record.event.id, workspaceId: "w", senderReplicaId: "replica", claim: record.event.payload, released: record.event.type === "claim.released", updatedAt: new Date().toISOString() }),
      listClaims: async (after) => ({ claims: [], nextCursor: after }),
      uploadHandoff: async (record) => { uploadedHandoffs.push(record.event.payload.id); return { eventId: record.event.id, workspaceId: "w", senderReplicaId: "replica", handoff: record.event.payload, updatedAt: new Date().toISOString() }; },
      listHandoffs: async () => ({ handoffs: [remoteHandoffRecord], nextCursor: remoteHandoffRecord.updatedAt }),
      uploadIntent: async (record) => { uploadedIntents.push(record.event.payload.id); return { eventId: record.event.id, workspaceId: "w", senderReplicaId: "replica", intent: record.event.payload, updatedAt: new Date().toISOString() }; },
      listIntents: async () => ({ intents: [remoteIntentRecord], nextCursor: remoteIntentRecord.updatedAt })
    });

    expect(uploadedHandoffs).toEqual([responded.id]);
    expect(uploadedIntents).toEqual([intent.id]);
    expect(daemon.handoffs.get("remote-handoff")).toEqual(remoteHandoffRecord.handoff);
    expect(daemon.intents.get("remote-intent")).toEqual(remoteIntentRecord.intent);
    expect(result.uploaded).toBe(1);
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

  it("computes real hunk overlap for a conflicting pending change instead of a hardcoded false", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const base = "line1\nline2\nline3\nline4\nline5\nline6\n";
    await writeFile(join(senderRoot, "a.txt"), base); await exec("git", ["-C", senderRoot, "commit", "-aqm", "seed"]);
    await writeFile(join(receiverRoot, "a.txt"), base); await exec("git", ["-C", receiverRoot, "commit", "-aqm", "seed"]);
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });
    await writeFile(join(senderRoot, "a.txt"), "line1\nline2\nline3\nline4\nLINE5\nLINE6\n");
    const operation = await sender.capture("edit bottom lines", service);
    operation.transaction.changes[0]!.unifiedPatch = "@@ -5,2 +5,2 @@\n-line5\n-line6\n+LINE5\n+LINE6\n";
    await receiver.sync(service);
    receiver.operations.get(operation.id)!.transaction.changes[0]!.unifiedPatch = operation.transaction.changes[0]!.unifiedPatch;

    const nonOverlapping = { path: "a.txt", kind: "modify" as const, beforeHash: contentHash(base), afterHash: contentHash("LINE1\nLINE2\nline3\nline4\nline5\nline6\n"), afterContent: "LINE1\nLINE2\nline3\nline4\nline5\nline6\n", unifiedPatch: "@@ -1,2 +1,2 @@\n-line1\n-line2\n+LINE1\n+LINE2\n" };
    const pendingLocal = { id: "fake-local-op", workspaceId: "w", senderReplicaId: "receiver", transaction: { id: "fake-local-op", base: { files: [] }, changes: [nonOverlapping], provenance: { source: "filesystem" as const, confidence: "known" as const }, safety: { risk: "low" as const, requiresApproval: false } }, sequence: 1, createdAt: new Date().toISOString(), status: "local" as const };
    receiver.operations.set(pendingLocal.id, pendingLocal);

    await receiver.accept(operation.id);
    expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("line1\nline2\nline3\nline4\nLINE5\nLINE6\n");
  });

  it("requires approval when a conflicting pending change overlaps the same hunk range", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const base = "line1\nline2\nline3\nline4\nline5\nline6\n";
    await writeFile(join(senderRoot, "a.txt"), base); await exec("git", ["-C", senderRoot, "commit", "-aqm", "seed"]);
    await writeFile(join(receiverRoot, "a.txt"), base); await exec("git", ["-C", receiverRoot, "commit", "-aqm", "seed"]);
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });
    await writeFile(join(senderRoot, "a.txt"), "line1\nline2\nline3\nline4\nLINE5\nLINE6\n");
    const operation = await sender.capture("edit bottom lines", service);
    await receiver.sync(service);
    receiver.operations.get(operation.id)!.transaction.changes[0]!.unifiedPatch = "@@ -5,2 +5,2 @@\n-line5\n-line6\n+LINE5\n+LINE6\n";

    const overlapping = { path: "a.txt", kind: "modify" as const, beforeHash: contentHash(base), afterHash: contentHash("line1\nline2\nline3\nline4\nLINE5\nline6\n"), afterContent: "line1\nline2\nline3\nline4\nLINE5\nline6\n", unifiedPatch: "@@ -5,1 +5,1 @@\n-line5\n+LINE5\n" };
    const pendingLocal = { id: "fake-local-op", workspaceId: "w", senderReplicaId: "receiver", transaction: { id: "fake-local-op", base: { files: [] }, changes: [overlapping], provenance: { source: "filesystem" as const, confidence: "known" as const }, safety: { risk: "low" as const, requiresApproval: false } }, sequence: 1, createdAt: new Date().toISOString(), status: "local" as const };
    receiver.operations.set(pendingLocal.id, pendingLocal);

    await expect(receiver.accept(operation.id)).rejects.toThrow("requires local human approval");
    expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe(base);
  });

  it("populates unifiedPatch with a real diff during capture, end-to-end, without any test manually setting the field", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const base = "line1\nline2\nline3\nline4\nline5\nline6\n";
    await writeFile(join(senderRoot, "a.txt"), base); await exec("git", ["-C", senderRoot, "commit", "-aqm", "seed"]);
    await writeFile(join(receiverRoot, "a.txt"), base); await exec("git", ["-C", receiverRoot, "commit", "-aqm", "seed"]);
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });

    await writeFile(join(senderRoot, "a.txt"), "line1\nline2\nline3\nline4\nLINE5\nLINE6\n");
    const operation = await sender.capture("edit bottom lines", service);
    expect(operation.transaction.changes[0]!.unifiedPatch).toMatch(/^@@ -5,2 \+5,2 @@/m);
    await receiver.sync(service);
    expect(receiver.operations.get(operation.id)!.transaction.changes[0]!.unifiedPatch).toBe(operation.transaction.changes[0]!.unifiedPatch);

    const nonOverlappingContent = "LINE1\nLINE2\nline3\nline4\nline5\nline6\n";
    const nonOverlapping = { path: "a.txt", kind: "modify" as const, beforeHash: contentHash(base), afterHash: contentHash(nonOverlappingContent), afterContent: nonOverlappingContent, unifiedPatch: await unifiedDiff(base, nonOverlappingContent) };
    const pendingLocal = { id: "fake-local-op", workspaceId: "w", senderReplicaId: "receiver", transaction: { id: "fake-local-op", base: { files: [] }, changes: [nonOverlapping], provenance: { source: "filesystem" as const, confidence: "known" as const }, safety: { risk: "low" as const, requiresApproval: false } }, sequence: 1, createdAt: new Date().toISOString(), status: "local" as const };
    receiver.operations.set(pendingLocal.id, pendingLocal);

    await receiver.accept(operation.id);
    expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("line1\nline2\nline3\nline4\nLINE5\nLINE6\n");
  });

  it("requires approval when real capture-generated diffs overlap the same hunk range, without manually set patches", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const base = "line1\nline2\nline3\nline4\nline5\nline6\n";
    await writeFile(join(senderRoot, "a.txt"), base); await exec("git", ["-C", senderRoot, "commit", "-aqm", "seed"]);
    await writeFile(join(receiverRoot, "a.txt"), base); await exec("git", ["-C", receiverRoot, "commit", "-aqm", "seed"]);
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });

    await writeFile(join(senderRoot, "a.txt"), "line1\nline2\nline3\nline4\nLINE5\nLINE6\n");
    const operation = await sender.capture("edit bottom lines", service);
    await receiver.sync(service);
    expect(receiver.operations.get(operation.id)!.transaction.changes[0]!.unifiedPatch).toMatch(/^@@ -5,2 \+5,2 @@/m);

    const overlappingContent = "line1\nline2\nline3\nline4\nLINE5\nline6\n";
    const overlapping = { path: "a.txt", kind: "modify" as const, beforeHash: contentHash(base), afterHash: contentHash(overlappingContent), afterContent: overlappingContent, unifiedPatch: await unifiedDiff(base, overlappingContent) };
    const pendingLocal = { id: "fake-local-op", workspaceId: "w", senderReplicaId: "receiver", transaction: { id: "fake-local-op", base: { files: [] }, changes: [overlapping], provenance: { source: "filesystem" as const, confidence: "known" as const }, safety: { risk: "low" as const, requiresApproval: false } }, sequence: 1, createdAt: new Date().toISOString(), status: "local" as const };
    receiver.operations.set(pendingLocal.id, pendingLocal);

    await expect(receiver.accept(operation.id)).rejects.toThrow("requires local human approval");
    expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe(base);
  });

  it("classifies an exported interface change with known dependents as interface-impact, including transitive dependents beyond the direct caller", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const lib = "export function greet(name: string): string { return name; }\n";
    const caller = "import { greet } from \"./lib\";\nexport function callGreet(name: string): string { return greet(name); }\n";
    const consumer = "import { callGreet } from \"./caller\";\ncallGreet(\"world\");\n";
    for (const root of [senderRoot, receiverRoot]) {
      await writeFile(join(root, "lib.ts"), lib);
      await writeFile(join(root, "caller.ts"), caller);
      await writeFile(join(root, "consumer.ts"), consumer);
      await exec("git", ["-C", root, "add", "."]);
      await exec("git", ["-C", root, "commit", "-qm", "seed"]);
    }
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });

    await writeFile(join(senderRoot, "lib.ts"), "export function greet(name: string, loud: boolean): string { return name; }\n");
    const operation = await sender.capture("widen greet signature", service);
    await receiver.sync(service);

    const diff = await receiver.diffProposal(operation.id);
    const libChange = diff.find((entry) => entry.path === "lib.ts");
    expect(libChange).toMatchObject({ classification: "interface-impact", risk: "high", requiresApproval: true, dependents: ["caller.ts", "consumer.ts"] });

    const statePath = join(receiverRoot, ".git", "crosscode", "state.sqlite");
    await expect(receiver.accept(operation.id)).rejects.toThrow("requires local human approval");
    const database = new DatabaseSync(statePath, { readOnly: true });
    const rows = database.prepare("SELECT classification, dependents FROM conflict_artifact WHERE operation_id = ? AND path = ?").all(operation.id, "lib.ts") as Array<{ classification: string; dependents: string }>;
    database.close();
    expect(rows).toEqual([{ classification: "interface-impact", dependents: JSON.stringify(["caller.ts", "consumer.ts"]) }]);
  });

  it("reads back the persisted conflict_artifact rows for an operation directly, independent of live recomputation", async () => {
    const senderRoot = await repo(); const receiverRoot = await repo(); const service = new CoordinationService();
    const lib = "export function greet(name: string): string { return name; }\n";
    const caller = "import { greet } from \"./lib\";\nexport function callGreet(name: string): string { return greet(name); }\n";
    for (const root of [senderRoot, receiverRoot]) {
      await writeFile(join(root, "lib.ts"), lib);
      await writeFile(join(root, "caller.ts"), caller);
      await exec("git", ["-C", root, "add", "."]);
      await exec("git", ["-C", root, "commit", "-qm", "seed"]);
    }
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });

    await writeFile(join(senderRoot, "lib.ts"), "export function greet(name: string, loud: boolean): string { return name; }\n");
    const operation = await sender.capture("widen greet signature", service);
    await receiver.sync(service);
    await expect(receiver.accept(operation.id)).rejects.toThrow("requires local human approval");

    expect(() => receiver.conflictArtifacts("nonexistent")).toThrow("Proposal was not found");
    const artifacts = receiver.conflictArtifacts(operation.id);
    expect(artifacts).toMatchObject([{ operationId: operation.id, path: "lib.ts", classification: "interface-impact", baseContent: lib, localContent: lib, proposedContent: "export function greet(name: string, loud: boolean): string { return name; }\n", dependents: ["caller.ts"] }]);

    // Further local edits change what a live diffProposal would recompute, but the
    // historical artifact row -- written at classification time -- does not change.
    await writeFile(join(receiverRoot, "caller.ts"), "export const unrelated = 1;\n");
    expect(receiver.conflictArtifacts(operation.id)).toEqual(artifacts);
  });

  it("rejects publish when no validation for the profile has passed", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await daemon.validate("fast", ["exit 1"]);

    await expect(daemon.publish({ branch: "main", profile: "fast" })).rejects.toThrow("No passing validation found for profile fast");
  });

  it("rejects publish when the working tree changed since the last passing validation", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await daemon.validate("fast", ["true"]);
    await writeFile(join(root, "a.txt"), "changed after validation\n");

    await expect(daemon.publish({ branch: "main", profile: "fast" })).rejects.toThrow("Working tree changed since the last validation; re-run validate before publishing");
  });

  it("returns a dry-run publish plan without moving the branch ref", async () => {
    const root = await repo();
    await writeFile(join(root, "a.txt"), "two\n");
    const initialHead = (await exec("git", ["-C", root, "rev-parse", "refs/heads/main"])).stdout.trim();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    const [validation] = await daemon.validate("fast", ["true"]);

    const result = await daemon.publish({ branch: "main", profile: "fast", dryRun: true });

    expect(result).toMatchObject({ branch: "main", tree: validation!.tree });
    expect("changedPaths" in result && result.changedPaths).toEqual([{ path: "a.txt", kind: "modify" }]);
    expect((await exec("git", ["-C", root, "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(initialHead);
  });

  it("records the runner identity that performed a validation", async () => {
    const root = await repo();
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor-42" });

    const [validation] = await daemon.validate("fast", ["true"]);

    expect(validation!.runnerId).toBe("actor-42");
  });
});
