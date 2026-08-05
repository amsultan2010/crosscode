// Counterexamples: what happens if you implement PLAN.md's apply rule *literally*.
//
//   1. L == S                              -> write it, silent
//   2. L != S and sender built from S      -> 3-way merge
//   3. sender built from something else    -> catch up from cursor, retry
//
// The rule never says when the SENDER's shadow advances, and both readings break.
// These two demos are expected to FAIL to converge; the checks assert the failure,
// so if a future change makes them converge, the checks go red and you know.
import { diffTrees, makeWorld } from "./harness.mjs";
import { HOT_WINDOW_MS, Replica, mergeFile } from "./replica.mjs";

const COOL = HOT_WINDOW_MS + 1000;

class LiteralReplica extends Replica {
  constructor(name, dir, clock, advanceShadowOnSend) {
    super(name, dir, clock);
    this.advanceShadowOnSend = advanceShadowOnSend;
  }

  publish() {
    const units = [];
    for (const path of this.syncPaths()) {
      const L = this.diskHash(path);
      const S = this.shadowHash(path);
      if (L === S || L === null) continue;
      const content = this.read(path);
      this.store(content);
      units.push({ from: this.name, path, op: "modify", baseHash: S, contentHash: L, content, wireBytes: content.length });
      if (this.advanceShadowOnSend) this.setShadow(path, L);
    }
    return units;
  }

  receive(unit) {
    const L = this.diskHash(unit.path);
    const S = this.shadowHash(unit.path);
    const theirs = unit.content;
    if (L === S) {
      // Rule 1, taken at face value: no check that the sender built on S.
      this.store(theirs);
      this.writeSynced(unit.path, theirs);
      this.setShadow(unit.path, unit.contentHash);
      this.stats.writes++;
      return "write";
    }
    if (unit.baseHash === S) {
      const merged = mergeFile(this.read(unit.path), this.readBlob(S), theirs);
      if (merged.clean) {
        this.store(theirs);
        this.writeSynced(unit.path, merged.content);
        this.setShadow(unit.path, unit.contentHash);
        this.stats.merges++;
        return "merge";
      }
      this.recordConflict(unit.path, this.read(unit.path), theirs, this.readBlob(S), "same-lines");
      return "conflict";
    }
    // Rule 3.
    this.stats.catchups++;
    return "catchup";
  }
}

function literalWorld(seed, advanceShadowOnSend) {
  const w = makeWorld(seed);
  w.A = new LiteralReplica("A", w.A.dir, w.clock, advanceShadowOnSend);
  w.B = new LiteralReplica("B", w.B.dir, w.clock, advanceShadowOnSend);
  w.bus.replicas = [w.A, w.B];
  return w;
}

function numbered(n) {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
}

function replaceLine(text, i, next) {
  const rows = text.split("\n");
  rows[i - 1] = next;
  return rows.join("\n");
}

function runner(name) {
  const checks = [];
  return { name, checks, check: (label, ok, detail = "") => checks.push({ label, ok: Boolean(ok), detail }) };
}

/**
 * Reading A: the sender advances its shadow when it sends.
 * Concurrent edits then hit rule 1 on both sides — each blindly overwrites its own
 * work with the peer's. Edits are LOST and the replicas end up permanently swapped.
 */
export function literalRule1DataLoss() {
  const r = runner("counterexample: PLAN.md rule 1 loses data on concurrent edits");
  const base = numbered(220);
  const w = literalWorld({ "src/app.ts": base }, true);
  try {
    const aText = replaceLine(base, 10, "line 10 // A");
    const bText = replaceLine(base, 200, "line 200 // B");
    w.A.edit("src/app.ts", aText);
    w.B.edit("src/app.ts", bText);
    w.clock.advance(COOL);
    for (let i = 0; i < 6; i++) w.bus.round();

    const a = w.A.read("src/app.ts").toString();
    const b = w.B.read("src/app.ts").toString();
    r.check("A's own edit was destroyed", !a.includes("// A"), a.includes("// A") ? "survived" : "gone");
    r.check("B's own edit was destroyed", !b.includes("// B"), b.includes("// B") ? "survived" : "gone");
    r.check("the two replicas ended up swapped, not merged", a === bText && b === aText);
    r.check("trees did NOT converge", diffTrees(w.A, w.B).length > 0);
    r.check("and it is silent — zero conflicts recorded", w.A.conflicts.length + w.B.conflicts.length === 0);
    return r;
  } finally {
    w.cleanup();
  }
}

/**
 * Reading B: the sender does NOT advance its shadow (only "agreement" does).
 * Then a one-sided edit republishes the same unit on every single tick, forever.
 */
export function literalRule1InfiniteRebroadcast() {
  const r = runner("counterexample: not advancing the sender's shadow rebroadcasts forever");
  const base = numbered(40);
  const w = literalWorld({ "src/app.ts": base }, false);
  try {
    w.A.edit("src/app.ts", replaceLine(base, 10, "line 10 // A"));
    w.clock.advance(COOL);
    for (let i = 0; i < 10; i++) w.bus.round();
    r.check("B did receive the edit", w.B.read("src/app.ts").toString().includes("// A"));
    r.check(
      "but A re-sent the same unit on every tick",
      w.bus.messages === 10,
      `${w.bus.messages} messages for 1 edit over 10 ticks`
    );
    r.check("never quiesces", w.bus.messages > 1);
    return r;
  } finally {
    w.cleanup();
  }
}

export const COUNTEREXAMPLES = [literalRule1DataLoss, literalRule1InfiniteRebroadcast];
