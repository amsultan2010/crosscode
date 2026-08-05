import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FileVersion } from "@crosscode/protocol";
import { SyncEngine, type ApplyResult, type EngineOptions } from "./engine.js";
import { git, gitText } from "./git.js";

/**
 * Two or more real checkouts of one throwaway repository, real engines over real git, and
 * an in-process bus standing in for the service. No daemon: this exercises the algorithm,
 * and apps/daemon's own tests exercise the plumbing.
 *
 * The clock is virtual so the 10s hot window is deterministic. Everything else -- the
 * object store, the shadow ref, `merge-file` -- is the real thing.
 */

export class Clock {
  constructor(private ms = 1_000_000) {}
  now = (): number => this.ms;
  advance(ms: number): void { this.ms += ms; }
}

export type Peer = {
  name: string;
  dir: string;
  engine: SyncEngine;
  /** A user (or their agent) edit: writes the file and marks it hot. */
  edit(path: string, content: string | Buffer): Promise<void>;
  remove(path: string): Promise<void>;
  /** A rename the way `git mv` does it, so the new path is tracked and therefore synced. */
  rename(from: string, to: string): Promise<void>;
  read(path: string): Promise<Buffer | null>;
};

export type Bus = {
  peers: Peer[];
  clock: Clock;
  messages: number;
  /** Publish from one peer and deliver to the others. Returns what the receivers did. */
  tick(): Promise<ApplyResult[]>;
  /**
   * Repeat tick() until no message moves, or the bound is hit. Each round steps the clock
   * past the hot window, because a peer that just edited the file defers by design and
   * "settled" has to mean "the user stopped typing too".
   */
  settle(maxRounds?: number): Promise<number>;
  offline: Set<string>;
  queued: Map<string, Array<{ from: string; version: FileVersion }>>;
};

export type World = Bus & { root: string; cleanup(): Promise<void> };

async function run(dir: string, args: string[]): Promise<void> {
  await git(dir, args);
}

export async function createWorld(
  names: string[],
  options: EngineOptions & { clock?: Clock; files?: Record<string, string | Buffer> } = {}
): Promise<World> {
  const clock = options.clock ?? new Clock();
  const root = await mkdtemp(join(tmpdir(), "crosscode-world-"));
  const origin = join(root, "origin");
  await mkdir(origin, { recursive: true });
  await run(origin, ["init", "-q", "-b", "main"]);
  await run(origin, ["config", "user.email", "seed@example.com"]);
  await run(origin, ["config", "user.name", "seed"]);
  await writeFile(join(origin, "README.md"), "seed\n");
  // Only tracked files sync, so everything a scenario touches is in the seed commit.
  for (const [path, content] of Object.entries(options.files ?? {})) {
    await mkdir(dirname(join(origin, path)), { recursive: true });
    await writeFile(join(origin, path), content);
  }
  await run(origin, ["add", "-A"]);
  await run(origin, ["commit", "-qm", "seed"]);

  const peers: Peer[] = [];
  for (const name of names) {
    const dir = join(root, name);
    await run(root, ["clone", "-q", origin, dir]);
    await run(dir, ["config", "user.email", `${name}@example.com`]);
    await run(dir, ["config", "user.name", name]);
    const engine = await SyncEngine.open(dir, { ...options, now: clock.now });
    peers.push({
      name,
      dir,
      engine,
      async edit(path, content) {
        const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), bytes);
        engine.markUserEdit(path, clock.now());
      },
      async remove(path) {
        await rm(join(dir, path), { force: true });
        engine.markUserEdit(path, clock.now());
      },
      async rename(from, to) {
        await mkdir(dirname(join(dir, to)), { recursive: true });
        await run(dir, ["mv", from, to]);
        await engine.refreshTracked();
        engine.markUserEdit(from, clock.now());
        engine.markUserEdit(to, clock.now());
      },
      read(path) {
        return readFile(join(dir, path)).catch(() => null);
      }
    });
  }

  const world: World = {
    peers,
    clock,
    root,
    messages: 0,
    offline: new Set<string>(),
    queued: new Map<string, Array<{ from: string; version: FileVersion }>>(),
    async tick() {
      const results: ApplyResult[] = [];
      for (const sender of peers) {
        const versions = await sender.engine.publishAll();
        for (const version of versions) {
          for (const receiver of peers) {
            if (receiver === sender) continue;
            if (world.offline.has(receiver.name)) {
              const queue = world.queued.get(receiver.name) ?? [];
              queue.push({ from: sender.name, version });
              world.queued.set(receiver.name, queue);
              continue;
            }
            world.messages += 1;
            results.push(await receiver.engine.receive(version, { peer: sender.name }));
          }
        }
      }
      // Deferral is retried on the daemon's timer; the bus stands in for that here.
      for (const peer of peers) results.push(...await peer.engine.retryDeferred());
      return results;
    },
    async settle(maxRounds = 12) {
      let rounds = 0;
      for (; rounds < maxRounds; rounds += 1) {
        clock.advance(60_000);
        const before = world.messages;
        const results = await world.tick();
        if (world.messages === before && !results.some((result) => result.outcome === "write" || result.outcome === "merge" || result.outcome === "delete")) break;
      }
      return rounds;
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    }
  };
  return world;
}

/** Drains everything queued for a peer that was offline, in the order it was sent. */
export async function reconnect(world: World, name: string): Promise<ApplyResult[]> {
  world.offline.delete(name);
  const peer = world.peers.find((candidate) => candidate.name === name)!;
  const queue = world.queued.get(name) ?? [];
  world.queued.delete(name);
  const results: ApplyResult[] = [];
  for (const { from, version } of queue) {
    world.messages += 1;
    results.push(await peer.engine.receive(version, { peer: from }));
  }
  return results;
}

export async function converged(world: World, paths: string[]): Promise<boolean> {
  for (const path of paths) {
    const contents = await Promise.all(world.peers.map((peer) => peer.read(path)));
    const first = contents[0];
    if (!contents.every((content) => (content === null && first === null) || (content !== null && first !== null && content.equals(first)))) return false;
  }
  return true;
}

export async function shadowCommitCount(dir: string): Promise<number> {
  return Number(await gitText(dir, ["rev-list", "--count", "refs/crosscode/shadow"]));
}
