import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonStateStore, type DaemonSnapshot } from "./state.js";
import type { LocalOperation } from "./types.js";

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
    operations: [],
    outbound: [],
    remoteCursor: 0,
    capturedHashes: {}, gitState: { worktree: "/tmp/x" }, materializationPaused: false
  };
}

function operation(id: string, content: string): LocalOperation {
  return {
    id,
    workspaceId: "w",
    senderReplicaId: "replica",
    transaction: {
      id,
      base: { files: [] },
      changes: [{ path: "a.txt", kind: "add", afterContent: content, afterHash: `hash-${content}` }],
      provenance: { source: "filesystem", confidence: "known" },
      safety: { risk: "low", requiresApproval: false }
    },
    sequence: 0,
    createdAt: new Date(0).toISOString()
  };
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
      const operations = [operation("t1", "one"), operation("t2", "two")];
      store.record({ ...emptySnapshot(), operations }, { type: "transaction.created", payload: operations[0]! });
      store.record({ ...emptySnapshot(), operations }, { type: "transaction.created", payload: operations[1]! });

      expect(store.load().operations.map((entry) => entry.id)).toEqual(["t1", "t2"]);
    } finally {
      store.close();
    }
  });

  it("applies an update to an existing row", async () => {
    const store = await DaemonStateStore.open(await statePath());
    try {
      store.record({ ...emptySnapshot(), operations: [operation("t1", "one")] }, { type: "transaction.created", payload: operation("t1", "one") });
      const renamed = { ...operation("t1", "one"), sequence: 4 };
      store.record({ ...emptySnapshot(), operations: [renamed] }, { type: "transaction.published", payload: renamed });

      expect(store.load().operations).toHaveLength(1);
      expect(store.load().operations[0]?.sequence).toBe(4);
    } finally {
      store.close();
    }
  });

  it("removes rows that disappear from the snapshot", async () => {
    const store = await DaemonStateStore.open(await statePath());
    try {
      const operations = [operation("t1", "one"), operation("t2", "two")];
      store.record({ ...emptySnapshot(), operations }, { type: "transaction.created", payload: operations[0]! });
      store.record({ ...emptySnapshot(), operations: [operations[1]!] }, { type: "transaction.created", payload: operations[1]! });

      expect(store.load().operations.map((entry) => entry.id)).toEqual(["t2"]);
    } finally {
      store.close();
    }
  });

  it("diffs against what is really on disk after a reopen, not an empty cache", async () => {
    const path = await statePath();
    const first = await DaemonStateStore.open(path);
    first.record({ ...emptySnapshot(), operations: [operation("t1", "one"), operation("t2", "two")] }, { type: "transaction.created", payload: operation("t1", "one") });
    first.close();

    // A fresh store must know t1/t2 are already persisted, or this removal is skipped
    // and rows survive that the snapshot no longer contains.
    const second = await DaemonStateStore.open(path);
    try {
      second.record({ ...emptySnapshot(), operations: [operation("t2", "two")] }, { type: "transaction.created", payload: operation("t2", "two") });
      expect(second.load().operations.map((entry) => entry.id)).toEqual(["t2"]);
    } finally {
      second.close();
    }
  });

  it("does not lose a write when a later event rolls back", async () => {
    const store = await DaemonStateStore.open(await statePath());
    try {
      store.record({ ...emptySnapshot(), operations: [operation("t1", "one")] }, { type: "transaction.created", payload: operation("t1", "one") });

      // localEventSchema rejects this, so record() throws and rolls back mid-transaction,
      // leaving the diff cache describing writes that never landed.
      expect(() => store.record(
        { ...emptySnapshot(), operations: [operation("t1", "one"), operation("t2", "two")] },
        { type: "transaction.created", payload: { nonsense: true } as unknown as LocalOperation }
      )).toThrow();

      expect(store.load().operations.map((entry) => entry.id)).toEqual(["t1"]);

      // The next good write must still land, and must still see t1 as present.
      store.record({ ...emptySnapshot(), operations: [operation("t1", "one"), operation("t3", "three")] }, { type: "transaction.created", payload: operation("t3", "three") });
      expect(store.load().operations.map((entry) => entry.id)).toEqual(["t1", "t3"]);
    } finally {
      store.close();
    }
  });

  it("advances the event sequence on every recorded event", async () => {
    const store = await DaemonStateStore.open(await statePath());
    try {
      const first = store.record({ ...emptySnapshot(), operations: [operation("t1", "one")] }, { type: "transaction.created", payload: operation("t1", "one") });
      const second = store.record({ ...emptySnapshot(), operations: [operation("t1", "one")] }, { type: "transaction.created", payload: operation("t1", "one") });

      expect(second).toBeGreaterThan(first);
      expect(store.load().eventSequence).toBe(second);
    } finally {
      store.close();
    }
  });
});
