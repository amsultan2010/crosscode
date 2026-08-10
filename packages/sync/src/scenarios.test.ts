import { afterEach, describe, expect, it } from "vitest";
import { HOT_WINDOW_MS } from "./engine.js";
import { git, gitText } from "./git.js";
import { Clock, converged, createWorld, reconnect, shadowCommitCount, type World } from "./test-harness.js";

/**
 * The nine scenarios the phase 2 spike proved, re-run against the real git-backed engine.
 * The spike used a synchronous bus, a virtual clock, and a shadow commit per file per
 * change; only the virtual clock survives here, because the 10s hot window is the one
 * thing that cannot be exercised in real time.
 */

const worlds: World[] = [];
afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.cleanup()));
});

async function world(names: string[], options: Parameters<typeof createWorld>[1] = {}) {
  const created = await createWorld(names, options);
  worlds.push(created);
  return created;
}

const lines = (count: number, tag = "line") => Array.from({ length: count }, (_, index) => `${tag} ${index + 1}`).join("\n") + "\n";
function edited(source: string, index: number, replacement: string): string {
  const parts = source.split("\n");
  parts[index] = replacement;
  return parts.join("\n");
}

const conflictsOf = (target: World) => target.peers.flatMap((peer) => peer.engine.conflicts());

describe("1 - disjoint files", () => {
  it("converges byte-identically with zero conflicts and a bounded message count", async () => {
    const target = await world(["alice", "bob"], { files: { "a.txt": "a\n", "b.txt": "b\n" } });
    const [alice, bob] = target.peers;
    await alice!.edit("a.txt", "alice was here\n");
    await bob!.edit("b.txt", "bob was here\n");

    await target.settle();

    expect(await converged(target, ["a.txt", "b.txt"])).toBe(true);
    expect(await alice!.read("b.txt")).toEqual(Buffer.from("bob was here\n"));
    expect(await bob!.read("a.txt")).toEqual(Buffer.from("alice was here\n"));
    expect(conflictsOf(target)).toHaveLength(0);
    // Two edits, two peers: two messages. The bound is what fails the test if an applied
    // write ever starts looking like a local edit again and republishes forever.
    expect(target.messages).toBe(2);
  });
});

describe("1b - membership", () => {
  it("syncs a newly tracked file whose name begins with a space", async () => {
    const target = await world(["alice", "bob"], { files: { "a.txt": "a\n" } });
    const [alice, bob] = target.peers;
    await alice!.edit(" spaced.txt", "one\n");
    await git(alice!.dir, ["add", "--", " spaced.txt"]);

    await target.settle();

    // `ls-files -z` sorts this record first, so trimming its output eats the leading space
    // and the file is keyed under a name that does not exist: it silently never syncs.
    expect((await bob!.read(" spaced.txt"))?.toString("utf8")).toBe("one\n");
  });
});

describe("2 - same file, disjoint hunks", () => {
  it("auto-merges on both sides with zero conflicts and terminates", async () => {
    const base = lines(20);
    const target = await world(["alice", "bob"], { files: { "shared.txt": base } });
    const [alice, bob] = target.peers;
    await alice!.edit("shared.txt", edited(base, 1, "ALICE"));
    await bob!.edit("shared.txt", edited(base, 17, "BOB"));

    await target.settle();

    expect(await converged(target, ["shared.txt"])).toBe(true);
    const merged = (await alice!.read("shared.txt"))!.toString("utf8");
    expect(merged).toContain("ALICE");
    expect(merged).toContain("BOB");
    expect(conflictsOf(target)).toHaveLength(0);
    // Both sides compute the same merge from mirrored arguments and echo it once each:
    // four messages, not a ping-pong.
    expect(target.messages).toBeLessThanOrEqual(6);
  });

  it("keeps the merge base alive across git gc", async () => {
    const base = lines(20);
    const target = await world(["alice", "bob"], { files: { "shared.txt": base } });
    const [alice, bob] = target.peers;
    await alice!.edit("shared.txt", edited(base, 1, "ALICE"));
    const versions = await alice!.engine.publishAll();
    await alice!.engine.flush();
    await bob!.edit("shared.txt", edited(base, 17, "BOB"));
    await bob!.engine.publishAll();
    await bob!.engine.flush();
    // The ancestor of the crossing merge is now a blob in no commit but the shadow's.
    await git(bob!.dir, ["gc", "--prune=now", "--quiet"]);
    target.clock.advance(60_000);

    const result = await bob!.engine.receive(versions[0]!, { peer: "alice" });

    expect(result.outcome).toBe("merge");
  });
});

describe("3 - same file, same lines", () => {
  it("produces exactly one conflict, with the right three sides, and writes nothing", async () => {
    const base = lines(10);
    const target = await world(["alice", "bob"], { files: { "shared.txt": base } });
    const [alice, bob] = target.peers;
    const alices = edited(base, 4, "ALICE OWNS THIS LINE");
    const bobs = edited(base, 4, "BOB OWNS THIS LINE");
    await alice!.edit("shared.txt", alices);
    await bob!.edit("shared.txt", bobs);

    await target.settle();

    const conflicts = conflictsOf(target);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.path).toBe("shared.txt");
    expect(conflicts[0]!.ours).toBe(bobs);
    expect(conflicts[0]!.theirs).toBe(alices);
    expect(conflicts[0]!.ancestor).toBe(base);
    expect(conflicts[0]!.binary).toBe(false);
    // Nothing is written on either side: each still holds exactly what its user typed.
    expect((await bob!.read("shared.txt"))!.toString("utf8")).toBe(bobs);
    expect((await alice!.read("shared.txt"))!.toString("utf8")).toBe(alices);
  });

  it("publishes the resolution so the peer takes it silently", async () => {
    const base = lines(10);
    const target = await world(["alice", "bob"], { files: { "shared.txt": base } });
    const [alice, bob] = target.peers;
    await alice!.edit("shared.txt", edited(base, 4, "ALICE"));
    await bob!.edit("shared.txt", edited(base, 4, "BOB"));
    await target.settle();
    const conflict = bob!.engine.conflicts()[0]!;

    const resolved = edited(base, 4, "ALICE AND BOB");
    const version = await bob!.engine.resolveConflict(conflict.id, resolved);
    const applied = await alice!.engine.receive(version!, { peer: "bob" });

    expect(applied.outcome).toBe("write");
    expect((await alice!.read("shared.txt"))!.toString("utf8")).toBe(resolved);
    expect(bob!.engine.conflicts()).toHaveLength(0);
    await target.settle();
    expect(await converged(target, ["shared.txt"])).toBe(true);
  });
});

describe("4 - delete versus edit", () => {
  it("applies an uncontested delete silently", async () => {
    const target = await world(["alice", "bob"], { files: { "gone.txt": "bye\n" } });
    const [alice, bob] = target.peers;
    await alice!.remove("gone.txt");

    await target.settle();

    expect(await bob!.read("gone.txt")).toBeNull();
    expect(conflictsOf(target)).toHaveLength(0);
  });

  it("surfaces exactly one conflict when a delete races an edit", async () => {
    const target = await world(["alice", "bob"], { files: { "gone.txt": "original\n" } });
    const [alice, bob] = target.peers;
    await alice!.remove("gone.txt");
    await bob!.edit("gone.txt", "bob still wants this\n");

    await target.settle();

    const conflicts = conflictsOf(target);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.ours).toBe("bob still wants this\n");
    expect(conflicts[0]!.theirs).toBeNull();
    expect(conflicts[0]!.ancestor).toBe("original\n");
    // Losing an edit is worse than keeping a stale file, so the edited file stays.
    expect(await bob!.read("gone.txt")).not.toBeNull();
  });
});

describe("5 - rename", () => {
  it("travels as a delete plus an add and converges", async () => {
    const target = await world(["alice", "bob"], { files: { "old.txt": "content\n" } });
    const [alice, bob] = target.peers;
    await alice!.rename("old.txt", "new.txt");

    await target.settle();

    expect(await bob!.read("old.txt")).toBeNull();
    expect((await bob!.read("new.txt"))!.toString("utf8")).toBe("content\n");
    expect(conflictsOf(target)).toHaveLength(0);
  });

  it("links the two halves so a conflict can say where the work went", async () => {
    const target = await world(["alice", "bob"], { files: { "old.txt": "content\n" } });
    const [alice] = target.peers;
    await alice!.rename("old.txt", "new.txt");

    const versions = await alice!.engine.publishAll();

    const added = versions.find((version) => version.path === "new.txt")!;
    expect(added.renamedFrom).toBe("old.txt");
  });
});

describe("6 - binary", () => {
  const binary = (seed: number, size = 512) => Buffer.from(Array.from({ length: size }, (_, index) => (index * seed) % 256));

  it("delivers a one-sided binary change byte-exactly", async () => {
    const target = await world(["alice", "bob"], { files: { "asset.bin": binary(3) } });
    const [alice, bob] = target.peers;
    const next = binary(7);
    await alice!.edit("asset.bin", next);

    await target.settle();

    expect(await bob!.read("asset.bin")).toEqual(next);
    expect(conflictsOf(target)).toHaveLength(0);
  });

  it("never merges concurrent binary edits", async () => {
    const target = await world(["alice", "bob"], { files: { "asset.bin": binary(3) } });
    const [alice, bob] = target.peers;
    await alice!.edit("asset.bin", binary(7));
    await bob!.edit("asset.bin", binary(11));

    await target.settle();

    const conflicts = conflictsOf(target);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.binary).toBe(true);
    expect(conflicts[0]!.ours).toBeNull();
    // The file must still be the receiver's own bytes: `git merge-file` refuses binaries
    // with an empty stdout, and writing that would truncate the file to nothing.
    expect(await bob!.read("asset.bin")).toEqual(binary(11));
    expect((await bob!.read("asset.bin"))!.length).toBe(512);
  });
});

describe("7 - large file", () => {
  it("ships a patch instead of the whole file, and the peer rebuilds it exactly", async () => {
    const base = lines(4_000, "a fairly long line of text to push this file over the threshold");
    const target = await world(["alice", "bob"], { files: { "large.txt": base } });
    const [alice, bob] = target.peers;
    const next = edited(base, 2_000, "CHANGED");
    await alice!.edit("large.txt", next);

    const versions = await alice!.engine.publishAll();

    expect(base.length).toBeGreaterThan(16 * 1024);
    expect(versions[0]!.patch).toBeDefined();
    expect(versions[0]!.content).toBeUndefined();
    expect(versions[0]!.patch!.length).toBeLessThan(1_000);
    expect((await bob!.engine.receive(versions[0]!, { peer: "alice" })).outcome).toBe("write");
    expect((await bob!.read("large.txt"))!.toString("utf8")).toBe(next);
  });
});

describe("6b - text that is not UTF-8", () => {
  // Latin-1 "café\n": no NUL byte, so isBinary() calls it text, but the bytes are not valid
  // UTF-8. Shipping them as a utf8 string replaces 0xE9 with U+FFFD, and the receiver then
  // holds bytes that do not hash to the contentHash its shadow just recorded.
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);

  it("delivers bytes that are not valid UTF-8 exactly as they were written", async () => {
    const target = await world(["alice", "bob"], { files: { "notes.txt": "cafe\n" } });
    const [alice, bob] = target.peers;
    await alice!.edit("notes.txt", latin1);

    await target.settle();

    expect(await bob!.read("notes.txt")).toEqual(latin1);
    expect(conflictsOf(target)).toHaveLength(0);
  });

  it("hands the peer a contentHash that matches what it wrote", async () => {
    const target = await world(["alice", "bob"], { files: { "notes.txt": "cafe\n" } });
    const [alice, bob] = target.peers;
    await alice!.edit("notes.txt", latin1);

    const [version] = await alice!.engine.publishAll();
    expect((await bob!.engine.receive(version!, { peer: "alice" })).outcome).toBe("write");

    // A shadow that names bytes the disk does not hold republishes the file forever, on a
    // baseHash no peer can resolve.
    expect(bob!.engine.shadowHash("notes.txt")).toBe(await gitText(bob!.dir, ["hash-object", "notes.txt"]));
    expect(await bob!.engine.publishAll()).toEqual([]);
  });

  it("does not hand the agent mojibake as the three sides of a conflict", async () => {
    const target = await world(["alice", "bob"], { files: { "notes.txt": "cafe\n" } });
    const [alice, bob] = target.peers;
    await alice!.edit("notes.txt", Buffer.concat([latin1, Buffer.from("alice\n")]));
    await bob!.edit("notes.txt", Buffer.concat([latin1, Buffer.from("bob\n")]));

    await target.settle();

    const conflicts = conflictsOf(target);
    expect(conflicts).toHaveLength(1);
    // Nothing here round-trips through a string, so the sides are withheld rather than
    // mangled -- a resolution built on mangled text would be written back as corruption.
    expect(conflicts[0]!.binary).toBe(true);
    expect(conflicts[0]!.ours).toBeNull();
    expect(conflicts[0]!.theirs).toBeNull();
  });
});

describe("8 - offline, then reconnect", () => {
  it("drains the backlog on reconnect and converges", async () => {
    const target = await world(["alice", "bob"], { files: { "a.txt": "0\n" } });
    const [alice, bob] = target.peers;
    target.offline.add("bob");

    for (let round = 1; round <= 3; round += 1) {
      await alice!.edit("a.txt", `${round}\n`);
      await target.tick();
    }
    expect(await bob!.read("a.txt")).toEqual(Buffer.from("0\n"));

    const results = await reconnect(target, "bob");

    expect(results.every((result) => result.outcome === "write")).toBe(true);
    expect(await converged(target, ["a.txt"])).toBe(true);
    expect(conflictsOf(target)).toHaveLength(0);
  });
});

describe("9 - rapid interleaved edits", () => {
  it("converges with zero conflicts and a bounded number of messages", async () => {
    const clock = new Clock();
    const target = await world(["alice", "bob"], { clock, files: { "a.txt": "0\n", "b.txt": "0\n" } });
    const [alice, bob] = target.peers;

    for (let round = 1; round <= 12; round += 1) {
      await alice!.edit("a.txt", `alice ${round}\n`);
      await bob!.edit("b.txt", `bob ${round}\n`);
      clock.advance(300);
      await target.tick();
    }
    clock.advance(HOT_WINDOW_MS + 1);
    await target.settle();

    expect(await converged(target, ["a.txt", "b.txt"])).toBe(true);
    expect(conflictsOf(target)).toHaveLength(0);
    // 24 edits, two peers, one message each: anything materially above that is a
    // rebroadcast loop rather than sync.
    expect(target.messages).toBeLessThanOrEqual(30);
  });

  it("batches the shadow instead of committing once per file per change", async () => {
    const clock = new Clock();
    const target = await world(["alice", "bob"], { clock, files: { "a.txt": "0\n", "b.txt": "0\n" } });
    const [alice, bob] = target.peers;

    for (let round = 1; round <= 12; round += 1) {
      await alice!.edit("a.txt", `alice ${round}\n`);
      await bob!.edit("b.txt", `bob ${round}\n`);
      clock.advance(300);
      await target.tick();
    }
    await alice!.engine.flush();

    // One flush, one commit, however many files moved -- plus the commit that created the
    // ref. The spike would have written one per file per change.
    expect(await shadowCommitCount(alice!.dir)).toBe(2);
  });
});
