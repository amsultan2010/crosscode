import { chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";
import { createWorld, type World } from "./test-harness.js";

/**
 * The executable bit, end to end.
 *
 * Git tracks exactly one bit of a file's mode -- 100644 or 100755 -- and until it travelled
 * on the wire the receiver derived it from its own disk. A script one agent wrote and
 * `chmod +x`'d therefore arrived at the peer non-executable, which is not a cosmetic
 * difference: the peer's agent runs `./script.sh` and gets "permission denied" for a file
 * both of them believe is in sync.
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

async function executable(dir: string, path: string): Promise<boolean> {
  return ((await stat(join(dir, path))).mode & 0o111) !== 0;
}

describe("file mode on the wire", () => {
  it("delivers a newly created executable file executable at the peer", async () => {
    const target = await world(["alice", "bob"], { files: { "a.txt": "a\n" } });
    const [alice, bob] = target.peers;
    await alice!.edit("script.sh", "#!/bin/sh\necho hello\n");
    await chmod(join(alice!.dir, "script.sh"), 0o755);
    await git(alice!.dir, ["add", "--", "script.sh"]);

    await target.settle();

    expect((await bob!.read("script.sh"))!.toString("utf8")).toBe("#!/bin/sh\necho hello\n");
    expect(await executable(bob!.dir, "script.sh")).toBe(true);
  });

  it("propagates a chmod +x that changed no bytes at all, once", async () => {
    const target = await world(["alice", "bob"], { files: { "run.sh": "#!/bin/sh\n" } });
    const [alice, bob] = target.peers;
    await chmod(join(alice!.dir, "run.sh"), 0o755);

    const [version] = await alice!.engine.publishAll();

    // Nothing about the content moved, so this change exists only in the mode field: a
    // sweep that compared content alone would have found nothing to send.
    expect(version!.mode).toBe("100755");
    expect(version!.contentHash).toBe(version!.baseHash);
    expect((await bob!.engine.receive(version!, { peer: "alice" })).outcome).toBe("write");
    expect(await executable(bob!.dir, "run.sh")).toBe(true);
    // And it is agreed on both sides, so neither of them says it again.
    expect(await bob!.engine.publishAll()).toEqual([]);
    expect(await alice!.engine.publishAll()).toEqual([]);
  });

  it("leaves the mode alone for a peer that does not send one", async () => {
    const target = await world(["alice", "bob"], { files: { "run.sh": "#!/bin/sh\n" } });
    const [alice, bob] = target.peers;
    await chmod(join(bob!.dir, "run.sh"), 0o755);
    await alice!.edit("run.sh", "#!/bin/sh\necho edited\n");
    const [version] = await alice!.engine.publishAll();

    // An older peer omits the field entirely. Reading that silence as 0644 would strip an
    // executable bit it never had an opinion about.
    const { mode, ...older } = version!;
    expect((await bob!.engine.receive(older, { peer: "alice" })).outcome).toBe("write");

    expect((await bob!.read("run.sh"))!.toString("utf8")).toBe("#!/bin/sh\necho edited\n");
    expect(await executable(bob!.dir, "run.sh")).toBe(true);
  });

  it("keeps the mode across a conflict resolution", async () => {
    const target = await world(["alice", "bob"], { files: { "a.txt": "a\n" } });
    const [alice, bob] = target.peers;
    // Both of them write the same new script, so there is no ancestor to merge from.
    for (const [peer, body] of [[alice!, "echo alice\n"], [bob!, "echo bob\n"]] as const) {
      await peer.edit("tool.sh", `#!/bin/sh\n${body}`);
      await chmod(join(peer.dir, "tool.sh"), 0o755);
      await git(peer.dir, ["add", "--", "tool.sh"]);
    }

    await target.settle();
    const conflict = bob!.engine.conflicts()[0]!;
    expect(conflict.path).toBe("tool.sh");
    const resolved = await bob!.engine.resolveConflict(conflict.id, "#!/bin/sh\necho both\n");

    // The agent hands back text and nothing else, and this file does not exist in the
    // shadow yet, so the mode has to come from the version that conflicted.
    expect(await executable(bob!.dir, "tool.sh")).toBe(true);
    expect(resolved!.mode).toBe("100755");
    expect((await alice!.engine.receive(resolved!, { peer: "bob" })).outcome).toBe("write");
    expect(await executable(alice!.dir, "tool.sh")).toBe(true);
  });
});
