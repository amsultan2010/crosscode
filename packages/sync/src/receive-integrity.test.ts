import { afterEach, describe, expect, it } from "vitest";
import { createWorld, type World } from "./test-harness.js";

/**
 * Two things the receiver must not take on trust: that the bytes in a version are the bytes
 * its `contentHash` names, and that it is the only thing touching this path right now.
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

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
function edited(source: string, index: number, replacement: string): string {
  const parts = source.split("\n");
  parts[index] = replacement;
  return parts.join("\n");
}

describe("content that does not match its hash", () => {
  it("is refused rather than written and recorded as agreed", async () => {
    const target = await world(["alice", "bob"], { files: { "a.txt": "a\n" } });
    const [alice, bob] = target.peers;
    const agreed = bob!.engine.shadowHash("a.txt");
    await alice!.edit("a.txt", "alice\n");
    const [version] = await alice!.engine.publishAll();

    // Anything that mangles the payload between the two of them looks like this. Writing it
    // would also record `contentHash` in bob's shadow as the state everybody agreed on, so
    // every baseHash bob advertises for this path afterwards names bytes nobody holds.
    const result = await bob!.engine.receive({ ...version!, content: "not what the hash says\n" }, { peer: "alice" });

    expect(result.outcome).toBe("rejected");
    expect((await bob!.read("a.txt"))!.toString("utf8")).toBe("a\n");
    expect(bob!.engine.shadowHash("a.txt")).toBe(agreed);
  });
});

describe("two changes to one path arriving at once", () => {
  it("does not let the second overwrite the first with no conflict recorded", async () => {
    const base = lines(10);
    const target = await world(["alice", "bob", "carol"], { files: { "shared.txt": base } });
    const [alice, bob, carol] = target.peers;
    await alice!.edit("shared.txt", edited(base, 4, "ALICE OWNS THIS LINE"));
    await carol!.edit("shared.txt", edited(base, 4, "CAROL OWNS THIS LINE"));
    const [fromAlice] = await alice!.engine.publishAll();
    const [fromCarol] = await carol!.engine.publishAll();

    // Not awaited in turn: this is a websocket delivering two frames back to back, which is
    // exactly how the daemon calls receive(). Both of them read bob's disk and shadow before
    // either writes, so without a per-path lock both conclude the sender built on the state
    // bob holds, both write, and one peer's edit is gone with nothing to show for it.
    const results = await Promise.all([
      bob!.engine.receive(fromAlice!, { peer: "alice" }),
      bob!.engine.receive(fromCarol!, { peer: "carol" })
    ]);

    expect(results.filter((result) => result.outcome === "write")).toHaveLength(1);
    expect(bob!.engine.conflicts()).toHaveLength(1);
    expect(results.some((result) => result.outcome === "conflict")).toBe(true);
  });

  it("still applies both when the two changes are to different paths", async () => {
    const target = await world(["alice", "bob"], { files: { "a.txt": "a\n", "b.txt": "b\n" } });
    const [alice, bob] = target.peers;
    await alice!.edit("a.txt", "alice a\n");
    await alice!.edit("b.txt", "alice b\n");
    const versions = await alice!.engine.publishAll();

    const results = await Promise.all(versions.map((version) => bob!.engine.receive(version, { peer: "alice" })));

    expect(results.map((result) => result.outcome)).toEqual(["write", "write"]);
    expect((await bob!.read("a.txt"))!.toString("utf8")).toBe("alice a\n");
    expect((await bob!.read("b.txt"))!.toString("utf8")).toBe("alice b\n");
  });
});
