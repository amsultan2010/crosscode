// The nine scenarios plus the two guards. Each returns a list of checks.
import { gitText } from "./git.mjs";
import { diffTrees, makeWorld, shadowInvariants } from "./harness.mjs";
import { HOT_WINDOW_MS, SHADOW_REF as SHADOW_REF_NAME, mergeFile } from "./replica.mjs";

const COOL = HOT_WINDOW_MS + 1000;

function numbered(n, tag = "line") {
  return Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";
}

function replaceLine(text, oneBased, next) {
  const rows = text.split("\n");
  rows[oneBased - 1] = next;
  return rows.join("\n");
}

function binaryBlob(seedByte, size = 512) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 7 + seedByte) % 256;
  b[10] = 0;
  b[200] = 0;
  return b;
}

function runner(name) {
  const checks = [];
  return {
    name,
    checks,
    check(label, ok, detail = "") {
      checks.push({ label, ok: Boolean(ok), detail });
      return Boolean(ok);
    }
  };
}

/** Checks every scenario shares: convergence bookkeeping and the shadow-ref rules. */
function commonChecks(r, w, { maxMessages, expectConverged = true, expectConflicts = 0 }) {
  const head = gitText(w.origin, ["rev-parse", "HEAD"]);
  const problems = [...shadowInvariants(w.A, head), ...shadowInvariants(w.B, head)];
  r.check("shadow ref never moves HEAD / never shows in git log", problems.length === 0, problems.join("; "));
  const conflicts = [...w.A.conflicts, ...w.B.conflicts];
  r.check(
    `conflicts recorded == ${expectConflicts}`,
    conflicts.length === expectConflicts,
    conflicts.map((c) => `${c.replica}:${c.path}:${c.reason}`).join(", ")
  );
  if (expectConverged) {
    const diffs = diffTrees(w.A, w.B);
    r.check("working trees byte-identical", diffs.length === 0, diffs.join("; "));
  }
  r.check(
    `bounded message count (<= ${maxMessages})`,
    w.bus.messages <= maxMessages,
    `sent ${w.bus.messages}`
  );
  r.check("no messages left in flight", w.bus.pendingCount() === 0, `${w.bus.pendingCount()} pending`);
  return r;
}

// 1 — edits to completely different files
export function scenario1() {
  const r = runner("1. disjoint files");
  const w = makeWorld({ "src/auth.ts": numbered(40, "auth"), "src/billing.ts": numbered(40, "billing") });
  try {
    w.A.edit("src/auth.ts", replaceLine(numbered(40, "auth"), 12, "auth 12 // changed by A"));
    w.B.edit("src/billing.ts", replaceLine(numbered(40, "billing"), 30, "billing 30 // changed by B"));
    w.clock.advance(COOL);
    const rounds = w.bus.settle();
    r.check("settled without user interaction", rounds <= 4, `${rounds} rounds`);
    r.check("A picked up B's edit", w.A.read("src/billing.ts").includes("changed by B"));
    r.check("B picked up A's edit", w.B.read("src/auth.ts").includes("changed by A"));
    return commonChecks(r, w, { maxMessages: 4 });
  } finally {
    w.cleanup();
  }
}

// 2 — same file, non-overlapping hunks (concurrent: neither has published yet)
export function scenario2() {
  const r = runner("2. same file, disjoint hunks");
  const base = numbered(220, "code");
  const w = makeWorld({ "src/app.ts": base });
  try {
    w.A.edit("src/app.ts", replaceLine(base, 10, "code 10 // A"));
    w.B.edit("src/app.ts", replaceLine(base, 200, "code 200 // B"));
    w.clock.advance(COOL);
    const rounds = w.bus.settle();
    r.check("settled", rounds <= 6, `${rounds} rounds`);
    const a = w.A.read("src/app.ts").toString();
    const b = w.B.read("src/app.ts").toString();
    r.check("A has both hunks", a.includes("// A") && a.includes("// B"));
    r.check("B has both hunks", b.includes("// A") && b.includes("// B"));
    r.check("no conflict markers written", !a.includes("<<<<<<<") && !b.includes("<<<<<<<"));
    r.check("merges happened silently", w.A.stats.merges + w.B.stats.merges >= 1);
    return commonChecks(r, w, { maxMessages: 8 });
  } finally {
    w.cleanup();
  }
}

// 3 — same file, same lines
export function scenario3() {
  const r = runner("3. same file, same lines");
  const base = numbered(40, "code");
  const w = makeWorld({ "src/app.ts": base });
  try {
    const aText = replaceLine(base, 12, "code 12 // A's version");
    const bText = replaceLine(base, 12, "code 12 // B's version");
    w.A.edit("src/app.ts", aText);
    w.B.edit("src/app.ts", bText);
    w.clock.advance(COOL);

    // A's debounce fires first; B is still holding its edit.
    w.bus.send(w.A.publish());
    w.bus.deliver();

    const conflicts = [...w.A.conflicts, ...w.B.conflicts];
    r.check("exactly one conflict recorded", conflicts.length === 1, `${conflicts.length}`);
    const c = conflicts[0];
    r.check("conflict is on the receiving side", c?.replica === "B");
    r.check("ours == B's bytes", c?.ours === bText);
    r.check("theirs == A's bytes", c?.theirs === aText);
    r.check("ancestor == the shared base", c?.ancestor === base);
    r.check("nothing written to disk", w.B.read("src/app.ts").toString() === bText);
    r.check("no conflict markers on disk", !w.B.read("src/app.ts").toString().includes("<<<<<<<"));

    // Keep running: the conflicted path must not ping-pong or re-conflict.
    const rounds = w.bus.settle();
    r.check("quiesces after the conflict", rounds <= 3, `${rounds} rounds`);
    r.check("still exactly one conflict", w.A.conflicts.length + w.B.conflicts.length === 1);
    r.check("A's copy untouched", w.A.read("src/app.ts").toString() === aText);
    return commonChecks(r, w, { maxMessages: 4, expectConverged: false, expectConflicts: 1 });
  } finally {
    w.cleanup();
  }
}

// 4 — delete on one side, edit on the other
export function scenario4() {
  const r = runner("4. delete vs edit");
  const base = numbered(30, "calc");
  const w = makeWorld({ "src/calc.ts": base, "src/other.ts": numbered(10, "other") });
  try {
    // 4a: plain delete, nobody else touched it.
    w.A.remove("src/other.ts");
    w.clock.advance(COOL);
    w.bus.settle();
    r.check("4a: plain delete propagates silently", w.B.read("src/other.ts") === null);
    r.check("4a: no conflict for a plain delete", w.A.conflicts.length + w.B.conflicts.length === 0);

    // 4b: A deletes; B has an unpublished edit to the same file.
    const bText = replaceLine(base, 5, "calc 5 // B needs this");
    w.A.remove("src/calc.ts");
    w.B.edit("src/calc.ts", bText);
    w.clock.advance(COOL);
    w.bus.send(w.A.publish());
    w.bus.deliver();

    const conflicts = [...w.A.conflicts, ...w.B.conflicts];
    r.check("4b: exactly one conflict", conflicts.length === 1, `${conflicts.length}`);
    r.check("4b: reason is delete-vs-edit", conflicts[0]?.reason === "delete-vs-edit");
    r.check("4b: theirs is null (a deletion)", conflicts[0]?.theirs === null);
    r.check("4b: ancestor preserved", conflicts[0]?.ancestor === base);
    r.check("4b: B's file NOT deleted", w.B.read("src/calc.ts")?.toString() === bText);
    w.bus.settle();
    r.check("4b: still exactly one conflict", w.A.conflicts.length + w.B.conflicts.length === 1);
    return commonChecks(r, w, { maxMessages: 6, expectConverged: false, expectConflicts: 1 });
  } finally {
    w.cleanup();
  }
}

// 5 — rename
export function scenario5() {
  const r = runner("5. rename");
  const base = numbered(20, "util");
  const w = makeWorld({ "src/util.ts": base, "src/keep.ts": numbered(5, "keep") });
  try {
    w.A.rename("src/util.ts", "src/helpers.ts");
    w.clock.advance(COOL);
    const rounds = w.bus.settle();
    r.check("settled", rounds <= 5, `${rounds} rounds`);
    r.check("B has the new path", w.B.read("src/helpers.ts")?.toString() === base);
    r.check("B lost the old path", w.B.read("src/util.ts") === null);
    r.check("shipped as delete + add (no rename op)", w.bus.messages === 2, `${w.bus.messages} messages`);
    return commonChecks(r, w, { maxMessages: 2 });
  } finally {
    w.cleanup();
  }
}

// 5b — rename racing an edit to the old path. Documented behaviour, not a spec.
export function scenario5b() {
  const r = runner("5b. rename vs edit on the old path (observed behaviour)");
  const base = numbered(20, "util");
  const w = makeWorld({ "src/util.ts": base });
  try {
    const bText = replaceLine(base, 7, "util 7 // B's work");
    w.A.rename("src/util.ts", "src/helpers.ts");
    w.B.edit("src/util.ts", bText);
    w.clock.advance(COOL);
    w.bus.send(w.A.publish());
    w.bus.deliver();
    w.bus.settle();

    const conflicts = [...w.A.conflicts, ...w.B.conflicts];
    r.check("one conflict on the deleted path", conflicts.length === 1 && conflicts[0].path === "src/util.ts", JSON.stringify(conflicts.map((c) => `${c.replica}:${c.path}`)));
    r.check("B keeps its edited old file", w.B.read("src/util.ts")?.toString() === bText);
    r.check(
      "new path arrives WITHOUT B's edit (content loss risk)",
      w.B.read("src/helpers.ts")?.toString() === base
    );
    return commonChecks(r, w, { maxMessages: 4, expectConverged: false, expectConflicts: 1 });
  } finally {
    w.cleanup();
  }
}

// 6 — binary file
export function scenario6() {
  const r = runner("6. binary file");
  const seed = binaryBlob(1);
  const w = makeWorld({ "assets/logo.bin": seed, "src/x.ts": numbered(5, "x") });
  try {
    // 6a: one-sided binary edit is a plain overwrite.
    const aBin = binaryBlob(9);
    w.A.edit("assets/logo.bin", aBin);
    w.clock.advance(COOL);
    w.bus.settle();
    r.check("6a: one-sided binary edit propagates byte-exact", w.B.read("assets/logo.bin").equals(aBin));
    r.check("6a: no conflict", w.A.conflicts.length + w.B.conflicts.length === 0);

    // 6b: concurrent binary edits must never be line-merged.
    const a2 = binaryBlob(33);
    const b2 = binaryBlob(77);
    w.A.edit("assets/logo.bin", a2);
    w.B.edit("assets/logo.bin", b2);
    w.clock.advance(COOL);
    w.bus.send(w.A.publish());
    w.bus.deliver();

    const conflicts = [...w.A.conflicts, ...w.B.conflicts];
    r.check("6b: exactly one conflict", conflicts.length === 1, `${conflicts.length}`);
    r.check("6b: reason is binary", conflicts[0]?.reason === "binary");
    r.check("6b: B's bytes untouched", w.B.read("assets/logo.bin").equals(b2));

    // Evidence for the report: what an implementation without a binary check gets
    // back from git merge-file when it hands it two binaries.
    const naive = mergeFile(b2, aBin, a2);
    r.check(
      "6b: merge-file refuses binaries and returns EMPTY stdout (evidence)",
      naive.refused && naive.content.length === 0,
      `refused=${naive.refused}, stdout=${naive.content.length} bytes, err="${naive.error ?? ""}"`
    );
    w.bus.settle();
    return commonChecks(r, w, { maxMessages: 6, expectConverged: false, expectConflicts: 1 });
  } finally {
    w.cleanup();
  }
}

// 7 — large file / patch-vs-full-content threshold
export function scenario7() {
  const r = runner("7. large file, patch vs full content");
  const big = numbered(9000, "row");
  const w = makeWorld({ "src/big.ts": big, "src/small.ts": numbered(5, "s") });
  try {
    r.check("seed file exceeds the threshold", Buffer.byteLength(big) > 64 * 1024, `${Buffer.byteLength(big)} bytes`);
    w.A.edit("src/big.ts", replaceLine(big, 4000, "row 4000 // A"));
    w.B.edit("src/small.ts", replaceLine(numbered(5, "s"), 2, "s 2 // B"));
    w.clock.advance(COOL);
    const units = w.A.publish();
    const bigUnit = units.find((u) => u.path === "src/big.ts");
    r.check("large edit ships as a patch", bigUnit?.patch !== undefined);
    r.check(
      "patch is <2% of the full content",
      bigUnit.wireBytes < Buffer.byteLength(big) * 0.02,
      `${bigUnit.wireBytes} vs ${Buffer.byteLength(big)} bytes`
    );
    w.bus.send(units);
    w.bus.settle();
    r.check("patched file reconstructed exactly", w.B.read("src/big.ts").toString().includes("row 4000 // A"));

    const smallUnits = w.B.publish();
    // (already published by settle) — re-check encoding rule on a fresh small edit
    w.B.edit("src/small.ts", replaceLine(numbered(5, "s"), 3, "s 3 // B again"));
    w.clock.advance(COOL);
    const su = w.B.publish().find((u) => u.path === "src/small.ts");
    r.check("small edit ships full content", su?.content !== undefined && su.patch === undefined);
    w.bus.send(su ? [su] : []);
    w.bus.settle();
    r.check("unused publish returned nothing", smallUnits.length === 0);

    // Concurrent distant edits in the large file still merge cleanly.
    const cur = w.A.read("src/big.ts").toString();
    w.A.edit("src/big.ts", replaceLine(cur, 100, "row 100 // A2"));
    w.B.edit("src/big.ts", replaceLine(cur, 8000, "row 8000 // B2"));
    w.clock.advance(COOL);
    w.bus.settle();
    const finalA = w.A.read("src/big.ts").toString();
    r.check("both distant edits survive", finalA.includes("// A2") && finalA.includes("// B2"));
    return commonChecks(r, w, { maxMessages: 14 });
  } finally {
    w.cleanup();
  }
}

// 8 — both sides offline, then reconnect with queued changes
export function scenario8() {
  const r = runner("8. offline, then reconnect");
  const shared = numbered(220, "shared");
  const w = makeWorld({
    "src/shared.ts": shared,
    "src/a-only.ts": numbered(10, "a"),
    "src/b-only.ts": numbered(10, "b")
  });
  try {
    w.bus.online = false;
    let aText = shared;
    let bText = shared;
    for (const [line, tag] of [[10, "A1"], [11, "A2"]]) {
      aText = replaceLine(aText, line, `shared ${line} // ${tag}`);
      w.A.edit("src/shared.ts", aText);
      w.A.edit("src/a-only.ts", replaceLine(numbered(10, "a"), 3, `a 3 // ${tag}`));
      w.clock.advance(COOL);
      w.bus.round();
    }
    bText = replaceLine(bText, 200, "shared 200 // B1");
    w.B.edit("src/shared.ts", bText);
    w.B.edit("src/b-only.ts", replaceLine(numbered(10, "b"), 4, "b 4 // B1"));
    w.clock.advance(COOL);
    w.bus.round();
    r.check("changes queued while offline", w.bus.pendingCount() > 0, `${w.bus.pendingCount()} queued`);
    r.check("nothing applied while offline", !w.B.read("src/a-only.ts").includes("A2"));

    w.bus.online = true;
    const rounds = w.bus.settle();
    r.check("drained on reconnect", rounds <= 8, `${rounds} rounds`);
    const s = w.A.read("src/shared.ts").toString();
    r.check("all queued edits present", s.includes("// A2") && s.includes("// B1"));
    r.check("A has B's file", w.A.read("src/b-only.ts").includes("B1"));
    r.check("B has A's file", w.B.read("src/a-only.ts").includes("A2"));
    return commonChecks(r, w, { maxMessages: 20 });
  } finally {
    w.cleanup();
  }
}

// 9 — rapid interleaved edits, many changes in flight
export function scenario9() {
  const r = runner("9. rapid interleaved edits");
  const seed = {};
  for (const f of ["p", "q", "r", "s"]) seed[`src/${f}.ts`] = numbered(300, f);
  const w = makeWorld(seed);
  try {
    for (let i = 0; i < 12; i++) {
      const file = `src/${["p", "q", "r", "s"][i % 4]}.ts`;
      const aLine = 20 + i * 3;
      const bLine = 250 - i * 3;
      w.A.edit(file, replaceLine(w.A.read(file).toString(), aLine, `${file} ${aLine} // A${i}`));
      w.B.edit(file, replaceLine(w.B.read(file).toString(), bLine, `${file} ${bLine} // B${i}`));
      // Sub-hot-window churn: publishes fly while writes get deferred.
      w.clock.advance(400);
      w.bus.round();
    }
    r.check("deferrals actually happened", w.A.stats.deferrals + w.B.stats.deferrals > 0, `${w.A.stats.deferrals + w.B.stats.deferrals}`);
    w.clock.advance(COOL);
    const rounds = w.bus.settle();
    r.check("converged after the storm", rounds <= 20, `${rounds} rounds`);
    let allEdits = true;
    for (const f of ["p", "q", "r", "s"]) {
      const t = w.A.read(`src/${f}.ts`).toString();
      if (!t.includes("// A") || !t.includes("// B")) allEdits = false;
    }
    r.check("edits from both sides survive in every file", allEdits);
    r.check("no conflict markers", !["p", "q", "r", "s"].some((f) => w.A.read(`src/${f}.ts`).toString().includes("<<<<<<<")));
    return commonChecks(r, w, { maxMessages: 120 });
  } finally {
    w.cleanup();
  }
}

// Guard — hot-file deferral
export function guardHotFile() {
  const r = runner("guard: hot-file deferral");
  const base = numbered(40, "code");
  const w = makeWorld({ "src/app.ts": base });
  try {
    const aText = replaceLine(base, 5, "code 5 // A");
    w.A.edit("src/app.ts", aText);
    w.clock.advance(COOL);
    const units = w.A.publish();

    // B touches the same file 2s ago — inside the hot window.
    const bText = replaceLine(base, 30, "code 30 // B");
    w.B.edit("src/app.ts", bText);
    w.clock.advance(2000);

    w.bus.send(units);
    w.bus.deliver();
    r.check("incoming change deferred, not written", w.B.read("src/app.ts").toString() === bText);
    r.check("deferral counted", w.B.stats.deferrals === 1, `${w.B.stats.deferrals}`);
    r.check("unit still queued for retry", w.bus.pendingCount() === 1);

    w.clock.advance(COOL);
    const rounds = w.bus.settle();
    r.check("applied once the file cools", w.B.read("src/app.ts").toString().includes("// A"), `${rounds} rounds`);
    r.check("B's own edit survived the merge", w.B.read("src/app.ts").toString().includes("// B"));
    return commonChecks(r, w, { maxMessages: 4 });
  } finally {
    w.cleanup();
  }
}

// Guard — loop suppression
export function guardLoopSuppression() {
  const r = runner("guard: loop suppression");
  const base = numbered(220, "code");
  const w = makeWorld({ "src/app.ts": base });
  try {
    w.A.edit("src/app.ts", replaceLine(base, 10, "code 10 // A"));
    w.B.edit("src/app.ts", replaceLine(base, 200, "code 200 // B"));
    w.clock.advance(COOL);
    const rounds = w.bus.settle();
    const applied = w.bus.log.filter((e) => ["write", "merge", "delete"].includes(e.outcome)).length;
    const suppressed = w.bus.log.filter((e) => e.outcome === "noop").length;
    r.check("terminates", rounds <= 6, `${rounds} rounds`);
    // Each side merges once (2 applies), each rebroadcasts the merged result once,
    // and each recognises the echo as bytes it already has (2 suppressed no-ops).
    r.check("exactly one merge per side", applied === 2, `${applied} applied writes/merges`);
    r.check("the echo is suppressed, not applied", suppressed === 2, `${suppressed} suppressed`);
    r.check("total messages bounded", w.bus.messages <= 6, `${w.bus.messages}`);
    return commonChecks(r, w, { maxMessages: 6 });
  } finally {
    w.cleanup();
  }
}

// Guard — PLAN.md claims the shadow ref gives you "content storage in git's own
// object store" for free. That is only true if the blobs stay REACHABLE: a real
// daemon outlives `git gc`, and a merge base that is not in any commit gets pruned.
export function guardShadowKeepsBasesAlive() {
  const r = runner("guard: shadow ref keeps merge bases alive across git gc");
  const seed = numbered(220, "code");
  const w = makeWorld({ "src/app.ts": seed });
  try {
    // Sync to a v1 that is never committed anywhere.
    const v1 = replaceLine(seed, 100, "code 100 // v1");
    w.A.edit("src/app.ts", v1);
    w.clock.advance(COOL);
    w.bus.settle();
    const v1Hash = w.B.shadowHash("src/app.ts");
    r.check("both sides agreed on an uncommitted v1", w.B.read("src/app.ts").toString() === v1);

    const headObjects = gitText(w.B.dir, ["rev-list", "--objects", "HEAD"]);
    r.check("v1 is unreachable from HEAD", !headObjects.includes(v1Hash));
    const shadowObjects = gitText(w.B.dir, ["rev-list", "--objects", SHADOW_REF_NAME]);
    r.check("v1 IS reachable from the shadow ref", shadowObjects.includes(v1Hash));

    // Concurrent edits on top of v1: the merge base is v1.
    w.A.edit("src/app.ts", replaceLine(v1, 10, "code 10 // A"));
    w.B.edit("src/app.ts", replaceLine(v1, 200, "code 200 // B"));
    w.clock.advance(COOL);

    for (const rep of [w.A, w.B]) gitText(rep.dir, ["gc", "--prune=now", "-q"]);
    r.check("v1 blob survived git gc", w.B.readBlob(v1Hash)?.toString() === v1);

    w.bus.settle();
    const a = w.A.read("src/app.ts").toString();
    r.check("merge against the gc'd base still works", a.includes("// A") && a.includes("// B"));
    return commonChecks(r, w, { maxMessages: 8 });
  } finally {
    w.cleanup();
  }
}

export const ALL = [
  scenario1,
  scenario2,
  scenario3,
  scenario4,
  scenario5,
  scenario5b,
  scenario6,
  scenario7,
  scenario8,
  scenario9,
  guardHotFile,
  guardLoopSuppression,
  guardShadowKeepsBasesAlive
];
