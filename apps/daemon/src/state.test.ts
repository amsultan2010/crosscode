import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EPOCH_CURSOR, type Task } from "@crosscode/protocol";
import { DaemonStateStore, type DaemonSnapshot } from "./state.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "crosscode-state-"));
  directories.push(directory);
  return join(directory, "state.sqlite");
}

function emptySnapshot(): Omit<DaemonSnapshot, "eventSequence"> {
  return {
    tasks: [], claims: [], operations: [], validations: [], checkpoints: [], handoffs: [], intents: [],
    outbound: [], taskOutbound: [], claimOutbound: [], handoffOutbound: [], intentOutbound: [], validationOutbound: [],
    remoteCursor: 0,
    remoteTaskCursor: EPOCH_CURSOR, remoteClaimCursor: EPOCH_CURSOR, remoteHandoffCursor: EPOCH_CURSOR,
    remoteIntentCursor: EPOCH_CURSOR, remoteValidationCursor: EPOCH_CURSOR,
    capturedHashes: {}, gitState: { worktree: "/tmp/x" }, materializationPaused: false
  };
}

function task(id: string, title: string): Task {
  return { id, title, ownerId: "a", status: "active", paths: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
}

/**
 * record() writes each projection table by diffing against a cache of what is already on
 * disk, rather than deleting and re-inserting every row on every event. These cover the
 * cases where that cache could drift out of step with the database.
 */
describe("projection persistence", () => {
  it("keeps rows that did not change", async () => {
    const store = await DaemonStateStore.open(await statePath());
    try {
      const tasks = [task("t1", "one"), task("t2", "two")];
      store.record({ ...emptySnapshot(), tasks }, { type: "task.created", payload: tasks[0]! });
      store.record({ ...emptySnapshot(), tasks }, { type: "task.created", payload: tasks[1]! });

      expect(store.load().tasks.map((entry) => entry.id)).toEqual(["t1", "t2"]);
    } finally {
      store.close();
    }
  });

  it("applies an update to an existing row", async () => {
    const store = await DaemonStateStore.open(await statePath());
    try {
      store.record({ ...emptySnapshot(), tasks: [task("t1", "one")] }, { type: "task.created", payload: task("t1", "one") });
      store.record({ ...emptySnapshot(), tasks: [task("t1", "renamed")] }, { type: "task.updated", payload: task("t1", "renamed") });

      expect(store.load().tasks).toHaveLength(1);
      expect(store.load().tasks[0]?.title).toBe("renamed");
    } finally {
      store.close();
    }
  });

  it("removes rows that disappear from the snapshot", async () => {
    const store = await DaemonStateStore.open(await statePath());
    try {
      const tasks = [task("t1", "one"), task("t2", "two")];
      store.record({ ...emptySnapshot(), tasks }, { type: "task.created", payload: tasks[0]! });
      store.record({ ...emptySnapshot(), tasks: [tasks[1]!] }, { type: "task.updated", payload: tasks[1]! });

      expect(store.load().tasks.map((entry) => entry.id)).toEqual(["t2"]);
    } finally {
      store.close();
    }
  });

  it("diffs against what is really on disk after a reopen, not an empty cache", async () => {
    const path = await statePath();
    const first = await DaemonStateStore.open(path);
    first.record({ ...emptySnapshot(), tasks: [task("t1", "one"), task("t2", "two")] }, { type: "task.created", payload: task("t1", "one") });
    first.close();

    // A fresh store must know t1/t2 are already persisted, or this removal is skipped
    // and rows survive that the snapshot no longer contains.
    const second = await DaemonStateStore.open(path);
    try {
      second.record({ ...emptySnapshot(), tasks: [task("t2", "two")] }, { type: "task.updated", payload: task("t2", "two") });
      expect(second.load().tasks.map((entry) => entry.id)).toEqual(["t2"]);
    } finally {
      second.close();
    }
  });

  it("does not lose a write when a later event rolls back", async () => {
    const store = await DaemonStateStore.open(await statePath());
    try {
      store.record({ ...emptySnapshot(), tasks: [task("t1", "one")] }, { type: "task.created", payload: task("t1", "one") });

      // localEventSchema rejects this, so record() throws and rolls back mid-transaction,
      // leaving the diff cache describing writes that never landed.
      expect(() => store.record(
        { ...emptySnapshot(), tasks: [task("t1", "one"), task("t2", "two")] },
        { type: "task.created", payload: { nonsense: true } as unknown as Task }
      )).toThrow();

      expect(store.load().tasks.map((entry) => entry.id)).toEqual(["t1"]);

      // The next good write must still land, and must still see t1 as present.
      store.record({ ...emptySnapshot(), tasks: [task("t1", "one"), task("t3", "three")] }, { type: "task.created", payload: task("t3", "three") });
      expect(store.load().tasks.map((entry) => entry.id)).toEqual(["t1", "t3"]);
    } finally {
      store.close();
    }
  });

  it("advances the event sequence on every recorded event", async () => {
    const store = await DaemonStateStore.open(await statePath());
    try {
      const first = store.record({ ...emptySnapshot(), tasks: [task("t1", "one")] }, { type: "task.created", payload: task("t1", "one") });
      const second = store.record({ ...emptySnapshot(), tasks: [task("t1", "one")] }, { type: "task.updated", payload: task("t1", "one") });

      expect(second).toBeGreaterThan(first);
      expect(store.load().eventSequence).toBe(second);
    } finally {
      store.close();
    }
  });
});
