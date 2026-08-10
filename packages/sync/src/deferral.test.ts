import { mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOT_WINDOW_MS } from "./engine.js";
import { git, gitText } from "./git.js";
import { Clock, createWorld, type World } from "./test-harness.js";

const worlds: World[] = [];
afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.cleanup()));
});

async function world(names: string[], options: Parameters<typeof createWorld>[1] = {}) {
  const created = await createWorld(names, options);
  worlds.push(created);
  return created;
}

describe("hot-file deferral", () => {
  it("never writes a file the user touched in the last ten seconds", async () => {
    const clock = new Clock();
    const target = await world(["alice", "bob"], { clock, files: { "a.txt": "base\n" } });
    const [alice, bob] = target.peers;
    await alice!.edit("a.txt", "alice\nbase\n");
    const [version] = await alice!.engine.publishAll();

    await bob!.edit("a.txt", "base\nbob\n");
    clock.advance(HOT_WINDOW_MS - 1);
    const deferredResult = await bob!.engine.receive(version!, { peer: "alice" });

    expect(deferredResult.outcome).toBe("deferred");
    expect((await bob!.read("a.txt"))!.toString("utf8")).toBe("base\nbob\n");
    expect(bob!.engine.deferredCount).toBe(1);

    // Nothing changes while it stays hot.
    expect(await bob!.engine.retryDeferred()).toHaveLength(0);
    expect((await bob!.read("a.txt"))!.toString("utf8")).toBe("base\nbob\n");

    clock.advance(2);
    const [applied] = await bob!.engine.retryDeferred();

    expect(applied!.outcome).toBe("merge");
    expect((await bob!.read("a.txt"))!.toString("utf8")).toBe("alice\nbase\nbob\n");
    expect(bob!.engine.deferredCount).toBe(0);
  });

  it("does not mark its own writes hot", async () => {
    const clock = new Clock();
    const target = await world(["alice", "bob"], { clock, files: { "a.txt": "base\n" } });
    const [alice, bob] = target.peers;
    await alice!.edit("a.txt", "alice\n");
    const [version] = await alice!.engine.publishAll();
    await bob!.engine.receive(version!, { peer: "alice" });

    // The write bob just made provokes a watcher event. If that counted as a user edit,
    // every applied change would make its own file hot and sync would deadlock at once.
    expect(await bob!.engine.observeChange("a.txt")).toBe(false);
    expect(bob!.engine.isHot("a.txt")).toBe(false);
    // A real edit on top of it still registers.
    await bob!.edit("a.txt", "bob\n");
    expect(await bob!.engine.observeChange("a.txt")).toBe(true);
    expect(bob!.engine.isHot("a.txt")).toBe(true);
  });

  it("cannot defer forever: the ceiling forces the write, with a backup", async () => {
    const clock = new Clock();
    const target = await world(["alice", "bob"], { clock, maxDeferrals: 3, files: { "a.txt": "base\n" } });
    const [alice, bob] = target.peers;
    await alice!.edit("a.txt", "alice\nbase\n");
    const [version] = await alice!.engine.publishAll();

    // A fast typist: every retry finds the file hot again.
    await bob!.edit("a.txt", "base\ntyping 0\n");
    expect((await bob!.engine.receive(version!, { peer: "alice" })).outcome).toBe("deferred");
    let results: Awaited<ReturnType<typeof bob.engine.retryDeferred>> = [];
    for (let attempt = 1; attempt <= 6 && results.length === 0; attempt += 1) {
      clock.advance(100);
      await bob!.edit("a.txt", `base\ntyping ${attempt}\n`);
      results = await bob!.engine.retryDeferred();
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("merge");
    expect(bob!.engine.isHot("a.txt")).toBe(false);
    expect(bob!.engine.stats.forced).toBe(1);
    // Forcing is still not losing: the bytes that were on disk are recoverable.
    expect((await bob!.read("a.txt"))!.toString("utf8")).toContain("alice");
    expect(await gitText(bob!.dir, ["show", "refs/crosscode/backup:a.txt"])).toContain("typing");
  });

  it("neither publishes nor applies a quarantined path", async () => {
    const clock = new Clock();
    const target = await world(["alice", "bob"], { clock, files: { "a.txt": "base\n" } });
    const [alice, bob] = target.peers;
    await alice!.edit("a.txt", "alice\n");
    await bob!.edit("a.txt", "bob\n");
    const [version] = await alice!.engine.publishAll();
    clock.advance(HOT_WINDOW_MS + 1);
    expect((await bob!.engine.receive(version!, { peer: "alice" })).outcome).toBe("conflict");

    // Bob's own edit stays home, so alice never records the mirror-image conflict.
    expect(await bob!.engine.publishAll()).toHaveLength(0);
    await alice!.edit("a.txt", "alice again\n");
    const [second] = await alice!.engine.publishAll();
    expect((await bob!.engine.receive(second!, { peer: "alice" })).outcome).toBe("quarantined");
    expect(bob!.engine.conflicts()).toHaveLength(1);
    expect((await bob!.read("a.txt"))!.toString("utf8")).toBe("bob\n");
  });
});

describe("denylist and path safety", () => {
  it("refuses to publish or apply a secret, or anything outside the checkout", async () => {
    const target = await world(["alice", "bob"], { files: { ".env": "SECRET=1\n", "a.txt": "a\n" } });
    const [alice, bob] = target.peers;
    await alice!.edit(".env", "SECRET=2\n");

    expect(await alice!.engine.publishAll()).toHaveLength(0);
    expect((await bob!.engine.receive({
      path: "../escape.txt", op: "modify", baseHash: null, contentHash: "x", content: "no", encoding: "utf8"
    }, { peer: "alice" })).outcome).toBe("rejected");
    expect((await bob!.engine.receive({
      path: ".env", op: "modify", baseHash: null, contentHash: "x", content: "SECRET=3\n", encoding: "utf8"
    }, { peer: "alice" })).outcome).toBe("rejected");
    expect((await bob!.read(".env"))!.toString("utf8")).toBe("SECRET=1\n");
  });

  it("refuses a path that leaves the checkout through a symlinked directory", async () => {
    const target = await world(["alice", "bob"], { files: { "a.txt": "a\n" } });
    const [, bob] = target.peers;
    // A symlink is an ordinary tracked file to git, so a repository can carry one and every
    // path under it is still `../`-free and passes isSafeRelativePath.
    const outside = join(target.root, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(bob!.dir, "link"));
    await git(bob!.dir, ["add", "link"]);
    await bob!.engine.refreshTracked();

    const result = await bob!.engine.receive({
      path: "link/pwned.txt", op: "modify", baseHash: null, contentHash: "x", content: "pwned\n", encoding: "utf8"
    }, { peer: "alice" });

    expect(result.outcome).toBe("rejected");
    expect(await readFile(join(outside, "pwned.txt")).catch(() => null)).toBeNull();
  });
});
