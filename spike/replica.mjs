// One replica = one checkout + its shadow ref + the apply rule from PLAN.md.
//
// Shadow ref: refs/crosscode/shadow points at a commit whose tree is the last state
// both sides agreed on. It is built with commit-tree/update-ref against a throwaway
// index, so it never moves HEAD, never touches the real index, and never shows up in
// `git log`. It doubles as content storage: every blob we have ever agreed on stays
// reachable, which is how a receiver resolves a `baseHash` it no longer has on disk.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, gitText, gitTextOrNull, raw } from "./git.mjs";

export const SHADOW_REF = "refs/crosscode/shadow";
export const HOT_WINDOW_MS = 10_000;
/** Above this, a text change ships as a unified diff instead of full content. */
export const PATCH_THRESHOLD_BYTES = 16 * 1024;

const DENYLIST = [/^\.env/, /\.pem$/, /\.key$/, /(^|\/)credentials$/];

function isBinary(buf) {
  return buf !== null && buf.subarray(0, 8000).includes(0);
}

function walk(root, base = "", out = []) {
  for (const e of readdirSync(join(root, base), { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, rel, out);
    else out.push(rel);
  }
  return out;
}

export class Replica {
  constructor(name, dir, clock) {
    this.name = name;
    this.dir = dir;
    this.clock = clock;
    this.conflicts = [];
    /** Paths quarantined by an unresolved conflict: we neither publish nor apply them. */
    this.conflicted = new Set();
    /** path -> virtual ms of the last *user* edit. Self-writes never land here. */
    this.lastEdit = new Map();
    this.deferred = [];
    this.stats = { writes: 0, merges: 0, deletes: 0, noops: 0, deferrals: 0, catchups: 0 };
    this.initShadow();
  }

  // ---- shadow ref -------------------------------------------------------

  initShadow() {
    const tree = gitText(this.dir, ["rev-parse", "HEAD^{tree}"]);
    const commit = gitText(this.dir, ["commit-tree", tree, "-m", "crosscode shadow"]);
    git(this.dir, ["update-ref", SHADOW_REF, commit]);
  }

  shadowCommit() {
    return gitText(this.dir, ["rev-parse", SHADOW_REF]);
  }

  shadowHash(path) {
    const line = gitTextOrNull(this.dir, ["ls-tree", "-z", SHADOW_REF, "--", path]);
    if (!line) return null;
    return line.split(/\s+/)[2] ?? null;
  }

  shadowPaths() {
    return gitText(this.dir, ["ls-tree", "-r", "--name-only", SHADOW_REF]).split("\n").filter(Boolean);
  }

  /** Move exactly one path in the shadow tree. blobHash === null means "removed". */
  setShadow(path, blobHash) {
    const idx = join(mkdtempSync(join(tmpdir(), "cc-idx-")), "index");
    const env = { GIT_INDEX_FILE: idx };
    const parent = this.shadowCommit();
    git(this.dir, ["read-tree", parent], { env });
    if (blobHash) git(this.dir, ["update-index", "--add", "--cacheinfo", `100644,${blobHash},${path}`], { env });
    else git(this.dir, ["update-index", "--force-remove", "--", path], { env });
    const tree = gitText(this.dir, ["write-tree"], { env });
    const commit = gitText(this.dir, ["commit-tree", tree, "-p", parent, "-m", `shadow ${path}`]);
    git(this.dir, ["update-ref", SHADOW_REF, commit]);
    rmSync(dirname(idx), { recursive: true, force: true });
  }

  // ---- object store -----------------------------------------------------

  store(buf) {
    return git(this.dir, ["hash-object", "-w", "--stdin"], { input: buf }).toString().trim();
  }

  readBlob(hash) {
    if (!hash) return null;
    const r = raw(this.dir, ["cat-file", "blob", hash]);
    return r.status === 0 ? r.out : null;
  }

  hashOf(buf) {
    return git(this.dir, ["hash-object", "--stdin"], { input: buf }).toString().trim();
  }

  // ---- working tree -----------------------------------------------------

  abs(path) {
    return join(this.dir, path);
  }

  read(path) {
    return existsSync(this.abs(path)) ? readFileSync(this.abs(path)) : null;
  }

  diskHash(path) {
    const buf = this.read(path);
    return buf === null ? null : this.hashOf(buf);
  }

  syncPaths() {
    const set = new Set([...walk(this.dir), ...this.shadowPaths()]);
    return [...set].filter((p) => !DENYLIST.some((re) => re.test(p))).sort();
  }

  /** A user (or their agent) edit. This is the only thing that marks a file hot. */
  edit(path, content) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    mkdirSync(dirname(this.abs(path)), { recursive: true });
    writeFileSync(this.abs(path), buf);
    this.lastEdit.set(path, this.clock.now());
  }

  remove(path) {
    rmSync(this.abs(path), { force: true });
    this.lastEdit.set(path, this.clock.now());
  }

  rename(from, to) {
    const buf = this.read(from);
    this.remove(from);
    this.edit(to, buf);
  }

  /** Daemon-initiated write: does NOT mark the file hot (that would deadlock sync). */
  writeSynced(path, buf) {
    mkdirSync(dirname(this.abs(path)), { recursive: true });
    writeFileSync(this.abs(path), buf);
  }

  isHot(path) {
    const t = this.lastEdit.get(path);
    return t !== undefined && this.clock.now() - t < HOT_WINDOW_MS;
  }

  // ---- publish ----------------------------------------------------------

  /**
   * Whatever the watcher would have seen: every synced path whose disk bytes differ
   * from the shadow. Sending advances our shadow to what we sent: that is what makes
   * an applied write stop looking like a local edit (loop suppression).
   */
  publish() {
    const units = [];
    for (const path of this.syncPaths()) {
      if (this.conflicted.has(path)) continue;
      const L = this.diskHash(path);
      const S = this.shadowHash(path);
      if (L === S) continue;

      if (L === null) {
        units.push({ from: this.name, path, op: "delete", baseHash: S, contentHash: null, wireBytes: 0 });
        this.setShadow(path, null);
        continue;
      }

      const content = this.read(path);
      this.store(content);
      const base = this.readBlob(S);
      const unit = { from: this.name, path, op: "modify", baseHash: S, contentHash: L };

      if (base && !isBinary(base) && !isBinary(content) && content.length > PATCH_THRESHOLD_BYTES) {
        const patch = makePatch(base, content);
        if (patch !== null && patch.length < content.length) {
          unit.patch = patch;
          unit.wireBytes = Buffer.byteLength(patch);
        }
      }
      if (unit.patch === undefined) {
        unit.content = content;
        unit.wireBytes = content.length;
      }
      units.push(unit);
      this.setShadow(path, L);
    }
    return units;
  }

  // ---- apply rule -------------------------------------------------------

  /**
   * Returns one of: write | merge | delete | conflict | noop | deferred | catchup.
   * L = hash of my working copy, S = hash of my shadow entry.
   */
  receive(unit) {
    const { path } = unit;
    const L = this.diskHash(path);
    const S = this.shadowHash(path);

    // Loop suppression: I already have exactly these bytes, or we already agreed on
    // them. Never write, never rebroadcast.
    if (unit.op === "modify" && unit.contentHash === L) {
      if (S !== L) this.setShadow(path, L);
      this.stats.noops++;
      return "noop";
    }
    if (unit.op === "delete" && L === null) {
      if (S !== null) this.setShadow(path, null);
      this.stats.noops++;
      return "noop";
    }
    if (this.conflicted.has(path)) {
      this.stats.noops++;
      return "noop";
    }
    if (this.isHot(path)) {
      this.stats.deferrals++;
      return "deferred";
    }

    const base = unit.baseHash ? this.readBlob(unit.baseHash) : null;
    if (unit.baseHash && base === null) {
      this.stats.catchups++;
      return "catchup";
    }

    if (unit.op === "delete") {
      // Silent only if my copy is the agreed state AND the sender deleted that same
      // state. A delete built on an older base is a delete-vs-edit collision.
      if (L === S && unit.baseHash === S) {
        rmSync(this.abs(path), { force: true });
        this.setShadow(path, null);
        this.stats.deletes++;
        return "delete";
      }
      // They deleted, I edited. Not expressible as a 3-way text merge.
      this.recordConflict(path, this.read(path), null, base, "delete-vs-edit");
      return "conflict";
    }

    const theirs = this.resolve(unit);
    if (theirs === null) {
      this.stats.catchups++;
      return "catchup";
    }
    this.store(theirs);

    // Case 1: my copy is exactly the last agreed state AND the sender built on it.
    if (L === S && unit.baseHash === S) {
      this.writeSynced(path, theirs);
      this.setShadow(path, unit.contentHash);
      this.stats.writes++;
      return "write";
    }

    if (L === null) {
      // I deleted it, they edited it: mirror of delete-vs-edit.
      this.recordConflict(path, null, theirs, base, "edit-vs-delete");
      return "conflict";
    }

    const ours = this.read(path);
    if (isBinary(ours) || isBinary(theirs) || isBinary(base)) {
      this.recordConflict(path, ours, theirs, base, "binary");
      return "conflict";
    }
    if (base === null) {
      // Both sides created the same path independently; no ancestor to merge from.
      this.recordConflict(path, ours, theirs, null, "no-common-ancestor");
      return "conflict";
    }

    // Case 2 (and the crossing case PLAN.md's rule 3 does not cover): 3-way merge
    // against the ancestor the *sender* built from, which git still has because the
    // shadow ref kept it reachable.
    const merged = mergeFile(ours, base, theirs);
    if (!merged.clean) {
      this.recordConflict(path, ours, theirs, base, "same-lines");
      return "conflict";
    }
    this.writeSynced(path, merged.content);
    // Shadow := theirs, so the next publish ships the merged result back exactly once.
    this.setShadow(path, unit.contentHash);
    this.stats.merges++;
    return "merge";
  }

  resolve(unit) {
    if (unit.content) return unit.content;
    const base = this.readBlob(unit.baseHash);
    if (base === null) return null;
    const out = applyPatch(base, unit.patch);
    if (out === null || this.hashOf(out) !== unit.contentHash) return null;
    return out;
  }

  recordConflict(path, ours, theirs, ancestor, reason) {
    this.conflicts.push({
      replica: this.name,
      path,
      reason,
      ours: ours === null ? null : ours.toString("utf8"),
      theirs: theirs === null ? null : theirs.toString("utf8"),
      ancestor: ancestor === null ? null : ancestor.toString("utf8")
    });
    // Quarantine: until someone resolves this, we neither publish nor apply this path.
    // Without it the peer records the mirror-image conflict the moment it publishes.
    this.conflicted.add(path);
  }
}

// ---- text merge / patch helpers -----------------------------------------

function tmp() {
  return mkdtempSync(join(tmpdir(), "cc-merge-"));
}

export function mergeFile(ours, base, theirs) {
  const d = tmp();
  try {
    writeFileSync(join(d, "ours"), ours);
    writeFileSync(join(d, "base"), base);
    writeFileSync(join(d, "theirs"), theirs);
    const r = raw(d, ["merge-file", "-p", "-L", "ours", "-L", "ancestor", "-L", "theirs", "ours", "base", "theirs"]);
    // Exit code is the number of conflict hunks. Anything >127 is a hard refusal,
    // notably "Cannot merge binary files", where stdout is EMPTY.
    if (r.status === null || r.status > 127) {
      return { clean: false, refused: true, content: r.out, error: r.err.trim() };
    }
    return { clean: r.status === 0, refused: false, content: r.out };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

function makePatch(base, next) {
  const d = tmp();
  try {
    mkdirSync(join(d, "a"));
    mkdirSync(join(d, "b"));
    writeFileSync(join(d, "a", "f"), base);
    writeFileSync(join(d, "b", "f"), next);
    const r = raw(d, ["diff", "--no-index", "--unified=3", "--", "a/f", "b/f"]);
    if (r.status !== 1) return null;
    return r.out.toString("utf8");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

function applyPatch(base, patch) {
  const d = tmp();
  try {
    writeFileSync(join(d, "f"), base);
    const r = raw(d, ["apply", "-p2"], { input: patch });
    if (r.status !== 0) return null;
    return readFileSync(join(d, "f"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

export { isBinary, walk, statSync };
