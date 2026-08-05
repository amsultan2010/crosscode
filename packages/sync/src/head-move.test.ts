import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOT_WINDOW_MS } from "./engine.js";
import { git, gitText, headCommit } from "./git.js";
import { Clock, createWorld, type World } from "./test-harness.js";

/**
 * What a commit or a pull on the *same branch* does to the agreed state.
 *
 * A branch switch replaces the working tree, so resetToHead() is right for it. A commit
 * does not: the bytes on disk after `git commit` are the bytes everybody agreed to a moment
 * before it, and the peers did not un-agree them by one of us running git. These tests pin
 * the difference, because the naive answer -- resetToHead() on every HEAD move -- passes the
 * obvious case and fails all three of the ones below.
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

async function commit(dir: string, paths: string[], message: string): Promise<void> {
  await git(dir, ["add", "--", ...paths]);
  await git(dir, ["commit", "-qm", message]);
}

describe("a HEAD move on the branch we are already on", () => {
  it("keeps the agreed state, so committing one file does not republish the others", async () => {
    const target = await world(["alice", "bob"], { files: { "a.txt": "a\n", "b.txt": "b\n" } });
    const [alice, bob] = target.peers;
    await alice!.edit("a.txt", "alice edits a\n");
    await alice!.edit("b.txt", "alice edits b\n");
    await target.settle();
    expect((await bob!.read("b.txt"))!.toString("utf8")).toBe("alice edits b\n");

    // Only a.txt is committed. b.txt stays uncommitted -- and stays agreed.
    const before = await headCommit(alice!.dir);
    await commit(alice!.dir, ["a.txt"], "commit a");
    await alice!.engine.rebaseOntoHead(before);

    // Nothing to say: a.txt now matches HEAD and b.txt is still what bob agreed to.
    // resetToHead() would have dropped b.txt's agreed blob back to the seed commit's and
    // republished it, with a baseHash bob never agreed to.
    expect(await alice!.engine.publishAll()).toEqual([]);
    expect(alice!.engine.shadowHash("a.txt")).toBe(await gitText(alice!.dir, ["rev-parse", "HEAD:a.txt"]));
    expect(alice!.engine.shadowHash("b.txt")).toBe(await gitText(alice!.dir, ["hash-object", "b.txt"]));
  });

  it("does not push committed bytes at a peer who has not pulled", async () => {
    const target = await world(["alice", "bob"], { files: { "a.txt": "a\n", "shared.txt": "shared\n" } });
    const [alice, bob] = target.peers;
    // An uncommitted edit both of them hold. It must survive the pull untouched.
    await alice!.edit("a.txt", "uncommitted, and agreed\n");
    await target.settle();

    // Somebody else committed a change to shared.txt upstream, and alice pulls it.
    const origin = join(target.root, "origin");
    await writeFile(join(origin, "shared.txt"), "shared, from upstream\n");
    await commit(origin, ["shared.txt"], "upstream edit");
    const before = await headCommit(alice!.dir);
    await git(alice!.dir, ["pull", "-q", "--no-rebase", "origin", "main"]);
    await alice!.engine.rebaseOntoHead(before);

    // shared.txt moved on disk, but git moved it: it is committed content, out of scope,
    // and bob -- who has not pulled -- must not receive it as a working-tree change.
    const versions = await alice!.engine.publishAll();
    expect(versions.map((version) => version.path)).toEqual([]);
    expect((await bob!.read("shared.txt"))!.toString("utf8")).toBe("shared\n");
    // And the uncommitted edit is still agreed, so it is not republished either.
    expect((await alice!.read("a.txt"))!.toString("utf8")).toBe("uncommitted, and agreed\n");
    expect(alice!.engine.shadowHash("a.txt")).toBe(await gitText(alice!.dir, ["hash-object", "a.txt"]));
  });

  it("does not lose an incoming change that is still in flight", async () => {
    const clock = new Clock();
    const target = await world(["alice", "bob"], { clock, files: { "a.txt": "base\n", "notes.txt": "notes\n" } });
    const [alice, bob] = target.peers;

    await alice!.edit("a.txt", "alice\nbase\n");
    const [version] = await alice!.engine.publishAll();
    // Bob is typing in a.txt, so alice's change is deferred rather than written.
    await bob!.edit("a.txt", "base\nbob\n");
    clock.advance(HOT_WINDOW_MS - 1);
    expect((await bob!.engine.receive(version!, { peer: "alice" })).outcome).toBe("deferred");
    expect(bob!.engine.deferredCount).toBe(1);

    // ...and now bob commits something unrelated. A commit says nothing about a change
    // that is mid-flight; resetToHead() would drop it on the floor and it would never
    // arrive, because the sender has already advanced its shadow past it.
    const before = await headCommit(bob!.dir);
    await bob!.edit("notes.txt", "bob's notes\n");
    await commit(bob!.dir, ["notes.txt"], "unrelated commit");
    await bob!.engine.rebaseOntoHead(before);
    expect(bob!.engine.deferredCount).toBe(1);

    clock.advance(2);
    const [applied] = await bob!.engine.retryDeferred();
    expect(applied!.outcome).toBe("merge");
    expect((await bob!.read("a.txt"))!.toString("utf8")).toBe("alice\nbase\nbob\n");
  });
});
