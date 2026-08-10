import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  conflictSchema,
  fileVersionSchema,
  type Conflict,
  type FileVersion
} from "@crosscode/protocol";
import {
  hashBlob,
  readBlob,
  repositoryRoot,
  trackedPaths,
  writeBlob
} from "./git.js";
import { applyPatch, isBinary, makePatch, mergeFile } from "./merge.js";
import { isDenied, isSafeRelativePath } from "./paths.js";
import { BACKUP_REF, ShadowTree, SHADOW_REF } from "./shadow.js";

export { SHADOW_REF, BACKUP_REF };

/** Never write a file the user or their agent touched this recently. */
export const HOT_WINDOW_MS = 10_000;

/**
 * How many times an incoming change may be deferred for a hot file before it is written
 * anyway. Without a ceiling, sustained sub-10s typing defers the same change forever and
 * a fast typist starves sync; the forced write backs the user's bytes up first.
 */
export const MAX_DEFERRALS = 20;

/** Above this, a text change ships as a unified diff instead of full content. */
export const PATCH_THRESHOLD_BYTES = 16 * 1024;

export type ApplyOutcome =
  /** Written silently: my copy was the agreed state and the sender built on it. */
  | "write"
  /** 3-way merged and written silently. */
  | "merge"
  | "delete"
  /** Surfaced to the user's agent. Nothing was written. */
  | "conflict"
  /** Already have these bytes, or already agreed on them. */
  | "noop"
  /** The file is hot; queued for retry. */
  | "deferred"
  /** The path is conflicted, so it is neither published nor applied. */
  | "quarantined"
  /** The sender's base is not in this object store; the caller must catch up and retry. */
  | "catchup"
  /** Denied by the secret denylist, or not a safe repository-relative path. */
  | "rejected";

export type ApplyResult = { path: string; outcome: ApplyOutcome; conflict?: Conflict };

/** Git's two file modes, which are the only two Crosscode carries. See `mode` in the protocol. */
type FileMode = NonNullable<FileVersion["mode"]>;

/**
 * A git tree entry's mode narrowed to one of those two. A tree can legitimately hold others
 * -- 120000 for a symlink, 160000 for a submodule -- and neither is a mode this engine has
 * any business writing to a regular file, so they read as "no opinion" rather than as 0644.
 */
function fileMode(mode: string | undefined): FileMode | undefined {
  return mode === "100755" || mode === "100644" ? mode : undefined;
}

export type EngineOptions = {
  hotWindowMs?: number;
  maxDeferrals?: number;
  patchThresholdBytes?: number;
  /** Injectable for tests; the hot window is the only thing that reads a clock. */
  now?: () => number;
};

export type EngineStats = {
  writes: number;
  merges: number;
  deletes: number;
  noops: number;
  conflicts: number;
  deferrals: number;
  forced: number;
  catchups: number;
  published: number;
};

type Deferred = { version: FileVersion; peer?: string; attempts: number };

/**
 * The sync engine: shadow ref, apply rule, quarantine, hot-file deferral, loop
 * suppression. It owns a checkout and nothing else -- no sockets, no timers, no watcher --
 * so the whole algorithm is exercisable with two directories and no daemon.
 *
 * The apply rule, for an incoming change to P where L is my disk and S is my shadow:
 *
 *   1. L === S *and the sender built from S* -> write it, silent.
 *   2. otherwise -> 3-way merge against the sender's base, resolved by content hash out of
 *      git's object store. Clean writes silently; a collision surfaces and writes nothing.
 *   3. only if that base blob is genuinely missing -> catch up from the cursor, retry.
 *
 * Clause 1's base check is load-bearing and PLAN.md's original wording lacked it: with the
 * sender advancing its shadow on send (which it must, or one edit republishes forever),
 * two people editing the same file concurrently both reach L === S and would each
 * overwrite their own work with the peer's, silently, with no conflict recorded.
 */
export class SyncEngine {
  private readonly hotWindowMs: number;
  private readonly maxDeferrals: number;
  private readonly patchThresholdBytes: number;
  private readonly now: () => number;

  /** path -> ms of the last *user* edit. Our own writes never land here. */
  private readonly lastEdit = new Map<string, number>();
  /** path -> hash we last wrote ourselves, so the watcher event it causes is not a user edit. */
  private readonly selfWrites = new Map<string, string | null>();
  /** Paths held by an unresolved conflict: neither published nor applied. */
  private readonly quarantined = new Set<string>();
  private readonly pendingConflicts = new Map<string, Conflict>();
  /** conflict id -> the hash the resolution should claim as its base. See resolveConflict. */
  private readonly conflictBase = new Map<string, string | null>();
  /** conflict id -> the mode the resolution should be written with, when the sender named one. */
  private readonly conflictMode = new Map<string, FileMode>();
  private readonly deferred = new Map<string, Deferred>();
  /** path -> tail of the chain of applies in flight for it. Dropped when the chain drains. */
  private readonly applying = new Map<string, Promise<void>>();
  private tracked = new Set<string>();

  readonly stats: EngineStats = { writes: 0, merges: 0, deletes: 0, noops: 0, conflicts: 0, deferrals: 0, forced: 0, catchups: 0, published: 0 };

  private constructor(
    readonly root: string,
    private readonly shadow: ShadowTree,
    private readonly backup: ShadowTree,
    options: EngineOptions
  ) {
    this.hotWindowMs = options.hotWindowMs ?? HOT_WINDOW_MS;
    this.maxDeferrals = options.maxDeferrals ?? MAX_DEFERRALS;
    this.patchThresholdBytes = options.patchThresholdBytes ?? PATCH_THRESHOLD_BYTES;
    this.now = options.now ?? Date.now;
  }

  static async open(directory: string, options: EngineOptions = {}): Promise<SyncEngine> {
    const root = await repositoryRoot(directory);
    const engine = new SyncEngine(root, await ShadowTree.open(root, SHADOW_REF), await ShadowTree.open(root, BACKUP_REF), options);
    await engine.refreshTracked();
    return engine;
  }

  // ---- membership -------------------------------------------------------

  /**
   * Only tracked files sync. Re-read after anything that changes what git tracks --
   * a commit, a checkout, a `git add` of a new file.
   */
  async refreshTracked(): Promise<void> {
    this.tracked = new Set(await trackedPaths(this.root));
  }

  /** Whether this path is one Crosscode syncs at all -- what the watcher filters on. */
  watchable(path: string): boolean {
    if (!isSafeRelativePath(path) || isDenied(path)) return false;
    // A tracked file that was deleted is no longer in `ls-files`' answer on some paths,
    // and the shadow is what remembers we were syncing it, so a delete still publishes.
    return this.tracked.has(path) || this.shadow.get(path) !== null;
  }

  /**
   * Whether this path may be published from here right now.
   *
   * A conflicted path is quarantined, and so, for the same reason, is one with an
   * incoming change still queued behind the hot window: publishing our side of a change
   * we have not applied yet is precisely how both peers end up recording mirror-image
   * conflicts and both agents sit down to fix the same collision. Deferral has a ceiling,
   * so this holds a path back for a bounded time, never indefinitely.
   */
  publishable(path: string): boolean {
    return this.watchable(path) && !this.quarantined.has(path) && !this.deferred.has(path);
  }

  /** Whether a path arriving from a peer may be written here. */
  receivable(path: string): boolean {
    return isSafeRelativePath(path) && !isDenied(path);
  }

  /**
   * Whether a parent directory of `path` is a symlink.
   *
   * A symlink is an ordinary tracked file to git, so a repository can legitimately carry one
   * and every path under it is still `../`-free and passes isSafeRelativePath. Writing one of
   * those means `mkdir -p` through the link and landing a peer's bytes wherever it points --
   * `.git/hooks`, `~/.ssh` -- which is the escape the path check exists to prevent. Only the
   * parents matter: the final component is replaced by a rename, never followed.
   */
  private async escapesRoot(path: string): Promise<boolean> {
    let current = this.root;
    for (const part of path.split("/").slice(0, -1)) {
      current = join(current, part);
      const info = await lstat(current).catch(() => null);
      if (!info) return false;
      if (info.isSymbolicLink()) return true;
    }
    return false;
  }

  // ---- working tree -----------------------------------------------------

  private absolute(path: string): string {
    return join(this.root, path);
  }

  private async read(path: string): Promise<Buffer | null> {
    return readFile(this.absolute(path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EISDIR") return null;
      throw error;
    });
  }

  private async diskHash(path: string): Promise<string | null> {
    const content = await this.read(path);
    return content === null ? null : hashBlob(this.root, content);
  }

  private async modeOf(path: string): Promise<FileMode> {
    const info = await stat(this.absolute(path)).catch(() => undefined);
    return info && (info.mode & 0o111) !== 0 ? "100755" : "100644";
  }

  /**
   * Applies a mode with no content write. `chmod +x` alone changes no bytes, so there is
   * nothing to rename into place -- and the watcher event it provokes is still one of ours,
   * which is why the self-write is recorded even though the hash did not move.
   */
  private async setMode(path: string, mode: FileMode): Promise<void> {
    await chmod(this.absolute(path), mode === "100755" ? 0o755 : 0o644);
    this.selfWrites.set(path, await this.diskHash(path));
  }

  /**
   * Our own write. Recorded in `selfWrites` so the watcher event it provokes is not
   * mistaken for the user typing -- a daemon that marks its own writes hot deadlocks sync
   * on the first change it applies.
   */
  private async writeSynced(path: string, content: Buffer, mode: FileMode): Promise<void> {
    const destination = this.absolute(path);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID().slice(0, 8)}.crosscode`);
    await writeFile(temporary, content, { mode: mode === "100755" ? 0o755 : 0o644 });
    await rename(temporary, destination);
    this.selfWrites.set(path, await hashBlob(this.root, content));
  }

  private async removeSynced(path: string): Promise<void> {
    await rm(this.absolute(path), { force: true });
    this.selfWrites.set(path, null);
  }

  /**
   * Tells the engine the watcher saw `path` change, and answers whether that was the user.
   * Only a user edit marks a file hot.
   */
  async observeChange(path: string): Promise<boolean> {
    const disk = await this.diskHash(path);
    if (this.selfWrites.get(path) === disk) return false;
    this.selfWrites.delete(path);
    this.lastEdit.set(path, this.now());
    return true;
  }

  /** Test/daemon seam: record a user edit without consulting the disk. */
  markUserEdit(path: string, at = this.now()): void {
    this.lastEdit.set(path, at);
  }

  isHot(path: string): boolean {
    const at = this.lastEdit.get(path);
    return at !== undefined && this.now() - at < this.hotWindowMs;
  }

  // ---- publish ----------------------------------------------------------

  /**
   * Every path whose disk bytes differ from the shadow, as sync units.
   *
   * Sending advances our shadow to what we sent. That is what stops an applied write from
   * looking like a local edit on the next pass -- without it a single edit republishes on
   * every tick, forever.
   */
  async publish(paths: Iterable<string>): Promise<FileVersion[]> {
    const versions: FileVersion[] = [];
    const deletedBase = new Map<string, string>();
    const created: FileVersion[] = [];
    for (const path of [...new Set(paths)].sort()) {
      if (!this.publishable(path)) continue;
      const content = await this.read(path);
      const local = content === null ? null : await writeBlob(this.root, content);
      const entry = this.shadow.entry(path);
      const agreed = entry?.hash ?? null;
      const mode = content === null ? null : await this.modeOf(path);
      // Same bytes *and* the same mode is what "nothing to say" means. Comparing content
      // alone would leave `chmod +x` stranded on the machine it was run on: git tracks the
      // executable bit, so a script that is executable here and not at the peer is a real
      // difference between the two checkouts, and this is the only sweep that can notice it.
      if (local === agreed && (agreed === null || mode === entry?.mode)) continue;

      if (local === null) {
        versions.push(fileVersionSchema.parse({ path, op: "delete", baseHash: agreed, contentHash: null }));
        if (agreed) deletedBase.set(agreed, path);
        this.shadow.remove(path);
        continue;
      }

      const version = await this.modify(path, content!, local, agreed, mode!);
      versions.push(version);
      if (agreed === null) created.push(version);
      this.shadow.set(path, local, mode!);
    }
    // A rename travels as a delete plus a modify with no relation between them. Linking
    // them here is what lets a conflict on the old path say where the work went, instead
    // of leaving an edit stranded in a file that was renamed out from under it.
    for (const version of created) {
      const from = version.contentHash ? deletedBase.get(version.contentHash) : undefined;
      if (from) version.renamedFrom = from;
    }
    this.stats.published += versions.length;
    return versions;
  }

  /** A full sweep: every tracked path plus everything the shadow remembers. */
  async publishAll(): Promise<FileVersion[]> {
    await this.refreshTracked();
    return this.publish([...this.tracked, ...this.shadow.paths()]);
  }

  private async modify(path: string, content: Buffer, local: string, agreed: string | null, mode: FileMode): Promise<FileVersion> {
    const base = await readBlob(this.root, agreed);
    // Text that is not valid UTF-8 -- latin-1, shift-jis, a stray 0xff -- has no NUL byte, so
    // isBinary() calls it text, and `toString("utf8")` would replace every offending byte with
    // U+FFFD. The peer would then write bytes that do not hash to the contentHash it records in
    // its shadow, and republish the file forever against a baseHash nobody can resolve. Base64
    // is the encoding that survives it; the wire has no third option.
    const binary = isBinary(content) || isBinary(base) || !isUtf8(content);
    if (!binary && base && content.length > this.patchThresholdBytes) {
      const patch = await makePatch(this.root, base, content);
      if (patch !== null && Buffer.byteLength(patch) < content.length) {
        return fileVersionSchema.parse({ path, op: "modify", baseHash: agreed, contentHash: local, patch, mode });
      }
    }
    return fileVersionSchema.parse({
      path,
      op: "modify",
      baseHash: agreed,
      contentHash: local,
      content: binary ? content.toString("base64") : content.toString("utf8"),
      encoding: binary ? "base64" : "utf8",
      mode
    });
  }

  // ---- apply ------------------------------------------------------------

  /**
   * Applies one incoming version, serialized against everything else in flight for the same
   * path.
   *
   * The lock is the whole of the correctness argument here: every clause of the apply rule
   * reads the disk and the shadow, decides, and only then writes, with an await at each
   * step. Two versions for one path arriving close together -- two peers, or a peer and a
   * retried deferral -- would otherwise both read the *pre-write* state, both conclude the
   * sender built on the state they hold, and both write. The second wins and the first
   * peer's edit is gone with no conflict recorded, which is the one failure mode this engine
   * exists to prevent. Per path, not global: unrelated files have no reason to wait on each
   * other, and a repository-wide lock would serialize a whole checkout behind one slow merge.
   */
  async receive(version: FileVersion, options: { peer?: string; allowCatchup?: boolean } = {}): Promise<ApplyResult> {
    return this.serialize(version.path, () => this.receiveNow(version, options));
  }

  private serialize<T>(path: string, work: () => Promise<T>): Promise<T> {
    const previous = this.applying.get(path) ?? Promise.resolve();
    // `then(work, work)` and not `finally`: one apply throwing must not cancel the next.
    const result = previous.then(work, work);
    const tail = result.then(() => {}, () => {});
    this.applying.set(path, tail);
    void tail.then(() => {
      // Only if nothing chained on behind us, or we would drop somebody else's tail.
      if (this.applying.get(path) === tail) this.applying.delete(path);
    });
    return result;
  }

  private async receiveNow(version: FileVersion, options: { peer?: string; allowCatchup?: boolean }): Promise<ApplyResult> {
    const { path } = version;
    if (!this.receivable(path)) return { path, outcome: "rejected" };

    const local = await this.diskHash(path);
    const agreed = this.shadow.get(path);

    // Loop suppression: I already have exactly these bytes, or we already agreed on them.
    // Never write, never rebroadcast.
    if (version.op === "modify" && version.contentHash === local) {
      const disk = await this.modeOf(path);
      // ...except that identical bytes can still differ in mode, and a `chmod +x` carrying
      // the bytes it did not change is exactly what that looks like on the wire. Suppressing
      // it with the content is how the executable bit would silently never propagate.
      if (version.mode && version.mode !== disk && !this.quarantined.has(path)) {
        await this.setMode(path, version.mode);
        this.shadow.set(path, local!, version.mode);
        this.stats.writes += 1;
        return { path, outcome: "write" };
      }
      // The shadow describes this checkout's disk, so it records the mode actually there --
      // not one we declined to apply because the path is quarantined.
      if (agreed !== local) this.shadow.set(path, local!, disk);
      this.stats.noops += 1;
      return { path, outcome: "noop" };
    }
    if (version.op === "delete" && local === null) {
      if (agreed !== null) this.shadow.remove(path);
      this.stats.noops += 1;
      return { path, outcome: "noop" };
    }
    if (this.quarantined.has(path)) {
      return { path, outcome: "quarantined" };
    }
    if (this.isHot(path)) {
      const existing = this.deferred.get(path);
      this.deferred.set(path, { version, peer: options.peer, attempts: existing ? existing.attempts + 1 : 1 });
      this.stats.deferrals += 1;
      return { path, outcome: "deferred" };
    }
    return this.applyNow(version, local, agreed, options);
  }

  private async applyNow(
    version: FileVersion,
    local: string | null,
    agreed: string | null,
    options: { peer?: string; allowCatchup?: boolean }
  ): Promise<ApplyResult> {
    const { path } = version;
    if (await this.escapesRoot(path)) return { path, outcome: "rejected" };
    // The patch path checks its rebuilt bytes against `contentHash` and falls back when they
    // do not match; full content was taken on trust. Anything that mangles a payload in
    // transit -- a bad encode at the sender, a truncated frame -- would then be written to
    // disk *and* recorded in the shadow as the state we agreed on, so every baseHash we
    // advertise for this path afterwards names bytes no peer can resolve. One hash is
    // cheaper than that, and there is no useful recovery from bytes that are not what the
    // sender said they were, so the version is refused outright rather than merged.
    if (version.content !== undefined
      && (await hashBlob(this.root, Buffer.from(version.content, version.encoding))) !== version.contentHash) {
      return { path, outcome: "rejected" };
    }
    const allowCatchup = options.allowCatchup ?? true;
    const base = await readBlob(this.root, version.baseHash);
    if (version.baseHash && base === null) {
      // Clause 3. The sender built on something this object store has never held, which
      // means we are genuinely behind rather than crossing. Only the caller can fix that.
      if (allowCatchup) {
        this.stats.catchups += 1;
        return { path, outcome: "catchup" };
      }
      // Catch-up already happened and the base is still absent. Merging is impossible, so
      // the one safe answer is to surface it rather than pick a side.
      return this.conflict(path, await this.read(path), await this.contentOf(version), null, options.peer, version.renamedFrom, version.mode);
    }

    if (version.op === "delete") {
      // Silent only if my copy is the agreed state *and* the sender deleted that same
      // state. A delete built on an older base is a delete racing an edit.
      if (local === agreed && version.baseHash === agreed) {
        await this.removeSynced(path);
        this.shadow.remove(path);
        this.stats.deletes += 1;
        return { path, outcome: "delete" };
      }
      // Delete versus edit is not a 3-way merge and never will be: it is a policy call
      // with no correct answer. Keep the edited file and let the agent decide, because
      // losing an edit is worse than keeping a stale file.
      return this.conflict(path, await this.read(path), null, base, options.peer, version.renamedFrom, version.mode);
    }

    const theirs = await this.contentOf(version, base);
    if (theirs === null) {
      // A patch we cannot rebuild the sender's exact bytes from. Same remedy as a missing
      // base: catch up and retry, rather than write something that hashes differently.
      if (allowCatchup) {
        this.stats.catchups += 1;
        return { path, outcome: "catchup" };
      }
      return this.conflict(path, await this.read(path), null, base, options.peer, version.renamedFrom, version.mode);
    }
    await writeBlob(this.root, theirs);
    // The sender's mode when it said one, and otherwise whatever this file already is: a
    // peer that predates the field has nothing to say about the mode, and reading its
    // silence as 0644 would strip the executable bit off a file it never touched.
    const mode = version.mode ?? await this.modeOf(path);

    // Clause 1.
    if (local === agreed && version.baseHash === agreed) {
      await this.writeSynced(path, theirs, mode);
      this.shadow.set(path, version.contentHash!, mode);
      this.stats.writes += 1;
      return { path, outcome: "write" };
    }

    if (local === null) {
      // I deleted it, they edited it: the mirror of delete-versus-edit.
      return this.conflict(path, null, theirs, base, options.peer, version.renamedFrom, version.mode);
    }

    const ours = (await this.read(path))!;
    if (isBinary(ours) || isBinary(theirs) || isBinary(base)) {
      // Binaries are never merged. `git merge-file` refuses them with exit 255 and empty
      // stdout, and there is no third option to concurrent binary edits but a conflict.
      return this.conflict(path, ours, theirs, base, options.peer, version.renamedFrom, version.mode);
    }
    if (base === null) {
      // Both sides created this path independently; there is no ancestor to merge from.
      return this.conflict(path, ours, theirs, null, options.peer, version.renamedFrom, version.mode);
    }

    // Clause 2: 3-way merge against the ancestor the *sender* built from, which git still
    // has because the shadow ref kept it reachable. This is the crossing case -- the
    // sender is behind me because our messages crossed -- and it is the common one.
    const merged = await mergeFile(this.root, ours, base, theirs);
    if (!merged.clean) {
      return this.conflict(path, ours, theirs, base, options.peer, version.renamedFrom, version.mode);
    }
    await this.writeSynced(path, merged.content, mode);
    // Shadow := theirs, so the next publish ships the merged result back exactly once.
    this.shadow.set(path, version.contentHash!, mode);
    this.stats.merges += 1;
    return { path, outcome: "merge" };
  }

  /** The sender's bytes: full content, or the patch replayed onto the base and verified. */
  private async contentOf(version: FileVersion, base?: Buffer | null): Promise<Buffer | null> {
    if (version.op === "delete") return null;
    if (version.content !== undefined) return Buffer.from(version.content, version.encoding);
    if (version.patch === undefined) return null;
    const ancestor = base ?? await readBlob(this.root, version.baseHash);
    if (ancestor === null) return null;
    const rebuilt = await applyPatch(ancestor, version.patch);
    if (rebuilt === null) return null;
    // A patch that replays to different bytes than the sender had is not usable; falling
    // back to catch-up is strictly better than writing something nobody agreed on.
    return (await hashBlob(this.root, rebuilt)) === version.contentHash ? rebuilt : null;
  }

  private async conflict(
    path: string,
    ours: Buffer | null,
    theirs: Buffer | null,
    ancestor: Buffer | null,
    peer: string | undefined,
    renamedFrom: string | undefined,
    mode: FileMode | undefined
  ): Promise<ApplyResult> {
    // Not valid UTF-8 is as unpresentable here as a NUL byte is, and for the same reason as
    // in modify(): the three sides go out as strings, and the agent's resolution comes back
    // as one. Mojibake the agent cannot see is worse than a conflict it must open the file for.
    const binary = [ours, theirs, ancestor].some((side) => isBinary(side) || (side !== null && !isUtf8(side)));
    const conflict = conflictSchema.parse({
      id: randomUUID(),
      path,
      detectedAt: new Date().toISOString(),
      ours: binary || ours === null ? null : ours.toString("utf8"),
      theirs: binary || theirs === null ? null : theirs.toString("utf8"),
      ancestor: binary || ancestor === null ? null : ancestor.toString("utf8"),
      binary,
      ...(renamedFrom ? { renamedFrom } : {}),
      ...(peer ? { peer } : {})
    });
    this.pendingConflicts.set(conflict.id, conflict);
    // The resolution is built on top of *their* bytes, so that is the base it claims when
    // it is published; the peer then sees L === S === baseHash and writes it silently
    // instead of merging our resolution against the change it already applied. A delete
    // has no bytes to claim, so that case falls back to the shadow at publish time.
    this.conflictBase.set(conflict.id, theirs === null ? null : await writeBlob(this.root, theirs));
    // The mode travels with the resolution for the same reason the base does: the agent
    // hands back text, not a mode, and the file the resolution replaces may not exist here
    // yet -- two peers each creating the same executable script is a conflict whose
    // resolution would otherwise land 0644 on both of them.
    if (mode) this.conflictMode.set(conflict.id, mode);
    // Quarantine. If the receiver only recorded the conflict, its own unpublished edit
    // would still go out on the next debounce, the peer would record the mirror-image
    // conflict, and both agents would sit down to fix the same collision.
    this.quarantined.add(path);
    this.deferred.delete(path);
    this.stats.conflicts += 1;
    return { path, outcome: "conflict", conflict };
  }

  // ---- deferral ---------------------------------------------------------

  /**
   * Retries everything queued behind a hot file. Anything that has waited out its ceiling
   * is applied anyway, after its current bytes are backed up to `refs/crosscode/backup` --
   * the apply rule still runs, so a genuine collision still surfaces as a conflict rather
   * than an overwrite.
   */
  async retryDeferred(): Promise<ApplyResult[]> {
    const results: ApplyResult[] = [];
    for (const [path, entry] of [...this.deferred]) {
      if (this.quarantined.has(path)) { this.deferred.delete(path); continue; }
      const cool = !this.isHot(path);
      if (!cool && entry.attempts < this.maxDeferrals) {
        entry.attempts += 1;
        this.stats.deferrals += 1;
        continue;
      }
      if (!cool) {
        const current = await this.read(path);
        if (current) this.backup.set(path, await writeBlob(this.root, current), await this.modeOf(path));
        await this.backup.flush();
        this.lastEdit.delete(path);
        this.stats.forced += 1;
      }
      this.deferred.delete(path);
      // Same chain a live receive takes: a retried deferral reads the disk and the shadow
      // exactly like one, so letting it race a fresh arrival for the same path would lose
      // an edit in precisely the way the lock in receive() exists to stop.
      results.push(await this.serialize(path, async () =>
        this.applyNow(entry.version, await this.diskHash(path), this.shadow.get(path), { peer: entry.peer })));
    }
    return results;
  }

  get deferredCount(): number {
    return this.deferred.size;
  }

  // ---- conflicts --------------------------------------------------------

  conflicts(): Conflict[] {
    return [...this.pendingConflicts.values()];
  }

  /**
   * Records the agent's merged result: written to disk, agreed with ourselves, and handed
   * back as the unit to publish. The path leaves quarantine only here.
   */
  async resolveConflict(id: string, content: string): Promise<FileVersion | null> {
    const conflict = this.pendingConflicts.get(id);
    if (!conflict) return null;
    const bytes = Buffer.from(content, "utf8");
    const mode = this.conflictMode.get(id) ?? fileMode(this.shadow.entry(conflict.path)?.mode) ?? await this.modeOf(conflict.path);
    const base = this.conflictBase.get(id) ?? this.shadow.get(conflict.path);
    const hash = await writeBlob(this.root, bytes);
    await this.writeSynced(conflict.path, bytes, mode);
    this.shadow.set(conflict.path, hash, mode);
    this.pendingConflicts.delete(id);
    this.conflictBase.delete(id);
    this.conflictMode.delete(id);
    this.quarantined.delete(conflict.path);
    return fileVersionSchema.parse({
      path: conflict.path,
      op: "modify",
      baseHash: base,
      contentHash: hash,
      content,
      encoding: "utf8",
      mode
    });
  }

  /** Drops a conflict without writing anything: the user resolved it in their editor. */
  dismissConflict(id: string): boolean {
    const conflict = this.pendingConflicts.get(id);
    if (!conflict) return false;
    this.pendingConflicts.delete(id);
    this.conflictBase.delete(id);
    this.conflictMode.delete(id);
    this.quarantined.delete(conflict.path);
    return true;
  }

  // ---- shadow -----------------------------------------------------------

  /**
   * Re-bases the agreed state on HEAD and drops everything in flight. A branch switch
   * replaces the working tree wholesale, so the old agreed state describes files that are
   * no longer there and every deferral and quarantine queued against it is meaningless.
   */
  async resetToHead(): Promise<void> {
    await this.shadow.resetTo("HEAD");
    this.deferred.clear();
    this.quarantined.clear();
    this.pendingConflicts.clear();
    this.conflictBase.clear();
    this.conflictMode.clear();
    this.lastEdit.clear();
    this.selfWrites.clear();
    await this.refreshTracked();
  }

  /**
   * HEAD moved on the branch we are already on: a commit, a pull, a reset. Unlike a branch
   * switch this does not replace the working tree, so the agreed state is still about the
   * files that are there and everything in flight is still about the same content.
   *
   * That is the whole difference from resetToHead(). A commit does not un-agree anything --
   * the bytes on disk are the bytes the peers agreed to a moment ago -- so resetting the
   * shadow to HEAD would republish every uncommitted file that is already in sync, against
   * a baseHash no peer agreed to, and would throw away deferrals, quarantines and pending
   * conflicts that a commit has nothing to say about. The shadow is rebased instead, and
   * only the tracked set is re-read, because that is the one thing a commit really changes.
   */
  async rebaseOntoHead(previousHead: string | null): Promise<void> {
    await this.shadow.rebaseOnto(previousHead, "HEAD");
    await this.refreshTracked();
  }

  /** Writes the batched shadow changes to the ref. The daemon calls this on a timer. */
  async flush(): Promise<void> {
    await this.shadow.flush();
    await this.backup.flush();
  }

  get shadowDirty(): boolean {
    return this.shadow.dirty;
  }

  shadowHash(path: string): string | null {
    return this.shadow.get(path);
  }
}
