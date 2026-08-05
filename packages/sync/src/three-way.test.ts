import { afterEach, describe, expect, it } from "vitest";
import { converged, createWorld, type World } from "./test-harness.js";

/**
 * Three peers. The spike only ever ran two, and flagged as unproven whether one shadow per
 * checkout is enough when there is more than one peer to agree with -- the shadow holds a
 * single "last agreed" hash, not one per peer.
 *
 * It is enough, and the reason is that clause 2 resolves its base by content hash rather
 * than by who sent it: when C's change arrives built on a base that is not this replica's
 * current shadow, it is still an ordinary 3-way merge against a blob the shadow kept
 * reachable. The single shadow only ever costs an extra merge, never a wrong answer.
 */

const worlds: World[] = [];
afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.cleanup()));
});

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
function edited(source: string, index: number, replacement: string): string {
  const parts = source.split("\n");
  parts[index] = replacement;
  return parts.join("\n");
}

describe("three peers", () => {
  it("converges on disjoint files with zero conflicts", async () => {
    const target = await createWorld(["alice", "bob", "carol"], { files: { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" } });
    worlds.push(target);
    const [alice, bob, carol] = target.peers;
    await alice!.edit("a.txt", "alice\n");
    await bob!.edit("b.txt", "bob\n");
    await carol!.edit("c.txt", "carol\n");

    await target.settle();

    expect(await converged(target, ["a.txt", "b.txt", "c.txt"])).toBe(true);
    expect(target.peers.flatMap((peer) => peer.engine.conflicts())).toHaveLength(0);
    expect(target.messages).toBe(6);
  });

  it("converges on three disjoint hunks of one file with zero conflicts", async () => {
    const base = lines(30);
    const target = await createWorld(["alice", "bob", "carol"], { files: { "shared.txt": base } });
    worlds.push(target);
    const [alice, bob, carol] = target.peers;
    await alice!.edit("shared.txt", edited(base, 1, "ALICE"));
    await bob!.edit("shared.txt", edited(base, 14, "BOB"));
    await carol!.edit("shared.txt", edited(base, 27, "CAROL"));

    const rounds = await target.settle(20);

    expect(await converged(target, ["shared.txt"])).toBe(true);
    const result = (await alice!.read("shared.txt"))!.toString("utf8");
    expect(result).toContain("ALICE");
    expect(result).toContain("BOB");
    expect(result).toContain("CAROL");
    expect(target.peers.flatMap((peer) => peer.engine.conflicts())).toHaveLength(0);
    // Termination is the thing under test: an extra merge per peer is fine, an unbounded
    // exchange is not.
    expect(rounds).toBeLessThan(20);
    expect(target.messages).toBeLessThanOrEqual(30);
  });

  it("surfaces exactly one conflict when two of the three collide on a line", async () => {
    const base = lines(20);
    const target = await createWorld(["alice", "bob", "carol"], { files: { "shared.txt": base } });
    worlds.push(target);
    const [alice, bob, carol] = target.peers;
    await alice!.edit("shared.txt", edited(base, 9, "ALICE"));
    await bob!.edit("shared.txt", edited(base, 9, "BOB"));
    await carol!.edit("shared.txt", edited(base, 2, "CAROL"));

    await target.settle(20);

    const conflicts = target.peers.flatMap((peer) => peer.engine.conflicts());
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.path).toBe("shared.txt");
    // Carol's edit is disjoint from the collision, so it still lands everywhere it can.
    expect((await alice!.read("shared.txt"))!.toString("utf8")).toContain("CAROL");
    expect((await carol!.read("shared.txt"))!.toString("utf8")).toContain("CAROL");
  });
});
