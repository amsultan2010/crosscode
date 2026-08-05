// Two temp checkouts of one throwaway repo + an in-process bus. No network, no
// service, no websocket. The bus is the only thing standing in for the transport.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, gitText } from "./git.mjs";
import { Replica, SHADOW_REF, walk } from "./replica.mjs";

export function makeWorld(seed) {
  const root = mkdtempSync(join(tmpdir(), "cc-world-"));
  const origin = join(root, "origin");
  mkdirSync(origin);
  git(origin, ["init", "-q", "-b", "main"]);
  for (const [path, content] of Object.entries(seed)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    mkdirSync(dirname(join(origin, path)), { recursive: true });
    writeFileSync(join(origin, path), buf);
  }
  git(origin, ["add", "-A"]);
  git(origin, ["commit", "-q", "-m", "seed"]);

  const clock = { t: 1_000_000, now() { return this.t; }, advance(ms) { this.t += ms; } };
  const dirs = {};
  for (const name of ["A", "B"]) {
    dirs[name] = join(root, name);
    git(root, ["clone", "-q", origin, name]);
  }
  const A = new Replica("A", dirs.A, clock);
  const B = new Replica("B", dirs.B, clock);
  const bus = new Bus([A, B]);
  return { root, origin, A, B, bus, clock, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export class Bus {
  constructor(replicas) {
    this.replicas = replicas;
    this.inbox = new Map(replicas.map((r) => [r.name, []]));
    this.online = true;
    this.messages = 0;
    this.log = [];
  }

  send(units) {
    for (const unit of units) {
      this.messages++;
      for (const r of this.replicas) {
        if (r.name !== unit.from) this.inbox.get(r.name).push(unit);
      }
    }
  }

  publishAll() {
    let active = false;
    for (const r of this.replicas) {
      const units = r.publish();
      if (units.length) {
        active = true;
        this.send(units);
      }
    }
    return active;
  }

  deliver() {
    let active = false;
    if (!this.online) return active;
    for (const r of this.replicas) {
      const queue = this.inbox.get(r.name);
      const retry = [];
      while (queue.length) {
        const unit = queue.shift();
        const outcome = r.receive(unit);
        this.log.push({ to: r.name, path: unit.path, op: unit.op, outcome });
        if (outcome === "deferred" || outcome === "catchup") retry.push(unit);
        else active = true;
      }
      this.inbox.get(r.name).push(...retry);
    }
    return active;
  }

  /** One publish+deliver round for every replica. Returns true if anything happened. */
  round() {
    const published = this.publishAll();
    const delivered = this.deliver();
    return published || delivered;
  }

  /** Run rounds until nothing moves. Throws if it never quiesces (= infinite loop). */
  settle(maxRounds = 25) {
    for (let i = 1; i <= maxRounds; i++) {
      if (!this.round()) return i;
    }
    throw new Error(`did not settle in ${maxRounds} rounds — possible rebroadcast loop`);
  }

  pendingCount() {
    return [...this.inbox.values()].reduce((n, q) => n + q.length, 0);
  }
}

// ---- assertions ---------------------------------------------------------

export function treeOf(replica) {
  const out = new Map();
  for (const p of walk(replica.dir)) out.set(p, readFileSync(join(replica.dir, p)));
  return out;
}

export function diffTrees(a, b) {
  const ta = treeOf(a);
  const tb = treeOf(b);
  const paths = [...new Set([...ta.keys(), ...tb.keys()])].sort();
  const diffs = [];
  for (const p of paths) {
    const x = ta.get(p);
    const y = tb.get(p);
    if (x === undefined) diffs.push(`${p}: missing in ${a.name}`);
    else if (y === undefined) diffs.push(`${p}: missing in ${b.name}`);
    else if (!x.equals(y)) diffs.push(`${p}: bytes differ (${x.length} vs ${y.length})`);
  }
  return diffs;
}

/** The shadow ref must never move HEAD and never appear in `git log`. */
export function shadowInvariants(replica, expectedHead) {
  const problems = [];
  const head = gitText(replica.dir, ["rev-parse", "HEAD"]);
  if (head !== expectedHead) problems.push(`${replica.name}: HEAD moved`);
  const log = gitText(replica.dir, ["log", "--oneline"]).split("\n").filter(Boolean);
  if (log.length !== 1) problems.push(`${replica.name}: git log has ${log.length} commits, expected 1`);
  if (log.some((l) => l.includes("shadow"))) problems.push(`${replica.name}: shadow commit visible in git log`);
  const branches = gitText(replica.dir, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
  if (branches.includes("crosscode")) problems.push(`${replica.name}: shadow ref leaked into refs/heads`);
  gitText(replica.dir, ["rev-parse", SHADOW_REF]); // throws if the ref is missing
  return problems;
}
