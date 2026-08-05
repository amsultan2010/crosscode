import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_TREE, git, gitRaw, gitText, gitTextOrNull } from "./git.js";

/**
 * `refs/crosscode/shadow` -- a commit whose tree is the last state this checkout and its
 * peers agreed on.
 *
 * Everything the apply rule needs falls out of it: the merge base for a 3-way merge, the
 * answer to "have I edited this since we last synced?", an undo target
 * (`git checkout refs/crosscode/shadow -- <path>`), and content storage, since a blob
 * reachable from the shadow survives `git gc` and can still be named by a peer's
 * `baseHash` long after it left anybody's disk.
 *
 * It never moves HEAD, never touches the real index, and never appears in `git log`.
 *
 * The spike wrote a read-tree/write-tree/commit-tree per file per change. That is three
 * process spawns and a full index round trip for one keystroke's worth of edit, which is
 * survivable for twenty files and absurd for a monorepo. Here the tree is held in memory
 * and the changes since the last flush are written in one batch -- see flush().
 */
export const SHADOW_REF = "refs/crosscode/shadow";

/**
 * Where a file the engine was forced to overwrite is kept, so "forced" never means "lost".
 * Same machinery as the shadow, different ref; recover with
 * `git show refs/crosscode/backup:<path>`.
 */
export const BACKUP_REF = "refs/crosscode/backup";

export type TreeEntry = { mode: string; hash: string };

/**
 * Every blob in a tree, by path. A treeish this repository cannot resolve -- HEAD before
 * the first commit -- reads as empty rather than throwing, because "no commit yet" and
 * "commit with no files" mean the same thing to everything that calls this.
 */
async function readTree(root: string, treeish: string): Promise<Map<string, TreeEntry>> {
  const entries = new Map<string, TreeEntry>();
  const result = await gitRaw(root, ["ls-tree", "-r", "-z", treeish]);
  if (result.status !== 0) return entries;
  for (const record of result.stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    // "<mode> <type> <hash>\t<path>" -- the tab is what makes a path with spaces safe.
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, , hash] = record.slice(0, tab).split(" ");
    if (!mode || !hash) continue;
    entries.set(record.slice(tab + 1), { mode, hash });
  }
  return entries;
}

export class ShadowTree {
  private readonly entries = new Map<string, TreeEntry>();
  /** Changes not yet written to the ref. null means "removed". */
  private readonly pending = new Map<string, TreeEntry | null>();

  private constructor(private readonly root: string, readonly ref: string) {}

  static async open(root: string, ref: string = SHADOW_REF): Promise<ShadowTree> {
    const tree = new ShadowTree(root, ref);
    if (!(await gitTextOrNull(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]))) {
      // A fresh checkout agrees with HEAD by definition: nothing has been synced yet, so
      // the committed tree is the last state everybody agreed on. A repository with no
      // commits at all starts from the empty tree rather than failing to start.
      const base = (await gitTextOrNull(root, ["rev-parse", "--verify", "-q", "HEAD^{tree}"])) ?? EMPTY_TREE;
      const commit = await gitText(root, ["commit-tree", base, "-m", "crosscode shadow"]);
      await git(root, ["update-ref", ref, commit]);
    }
    await tree.load();
    return tree;
  }

  private async load(): Promise<void> {
    this.entries.clear();
    for (const [path, entry] of await readTree(this.root, this.ref)) this.entries.set(path, entry);
  }

  /** The blob hash we last agreed on for `path`, or null if the shadow has no such path. */
  get(path: string): string | null {
    return this.entries.get(path)?.hash ?? null;
  }

  entry(path: string): TreeEntry | undefined {
    return this.entries.get(path);
  }

  paths(): string[] {
    return [...this.entries.keys()];
  }

  set(path: string, hash: string, mode = "100644"): void {
    const current = this.entries.get(path);
    if (current?.hash === hash && current.mode === mode) return;
    this.entries.set(path, { mode, hash });
    this.pending.set(path, { mode, hash });
  }

  remove(path: string): void {
    if (!this.entries.has(path)) return;
    this.entries.delete(path);
    this.pending.set(path, null);
  }

  /**
   * Points the ref at `treeish` and forgets everything batched. Used when the working tree
   * changes out from under us wholesale -- a branch switch -- where the state we last
   * agreed on describes files that are no longer there.
   */
  async resetTo(treeish: string): Promise<void> {
    this.pending.clear();
    const tree = await gitText(this.root, ["rev-parse", `${treeish}^{tree}`]);
    const parent = await gitTextOrNull(this.root, ["rev-parse", "--verify", "-q", this.ref]);
    const commit = await gitText(this.root, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "crosscode shadow reset"]);
    await git(this.root, ["update-ref", this.ref, commit]);
    await this.load();
  }

  /**
   * Moves the agreed state from one commit to another *without* discarding what the peers
   * agreed to. This is the answer to a commit or a pull on the branch we are already on,
   * where -- unlike a branch switch -- the working tree was not replaced wholesale.
   *
   * Per path, against the commit we last saw (`from`) and the one HEAD moved to (`to`):
   *
   * - the shadow still agrees with `from` -> nothing uncommitted was ever synced for this
   *   path, so it follows `to`. That is what stops a `git pull` from republishing every
   *   file the merge rewrote: the bytes git just wrote are committed bytes, out of
   *   Crosscode's scope, and a peer who has not pulled must not receive them.
   * - the shadow differs from `from` -> that difference *is* an uncommitted edit this
   *   checkout and its peers agreed on, and a commit does not un-agree it. Keep it, or the
   *   next sweep republishes work everybody already has, advertising a baseHash the peer
   *   never agreed to and inviting a merge against the wrong ancestor.
   *
   * A path committed away (present in `from`, absent from `to`, never edited locally)
   * leaves the shadow, so nothing is published for a file git itself deleted.
   */
  async rebaseOnto(from: string | null, to: string): Promise<void> {
    const before = from ? await readTree(this.root, from) : new Map<string, TreeEntry>();
    const after = await readTree(this.root, to);
    for (const path of new Set([...this.entries.keys(), ...after.keys()])) {
      // undefined on both sides compares equal, which is the "neither knows this path" case.
      if (this.entries.get(path)?.hash !== before.get(path)?.hash) continue;
      const target = after.get(path);
      if (target) this.set(path, target.hash, target.mode);
      else this.remove(path);
    }
  }

  get dirty(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Writes every change since the last flush as one commit on the ref.
   *
   * `update-index --index-info` takes the whole batch on one stdin, so the cost is one
   * index round trip per flush rather than per file. Mode 0 with the null sha is how that
   * format spells a removal.
   */
  async flush(): Promise<void> {
    if (!this.pending.size) return;
    const batch = [...this.pending];
    this.pending.clear();
    const directory = await mkdtemp(join(tmpdir(), "crosscode-shadow-"));
    const env = { GIT_INDEX_FILE: join(directory, "index") };
    try {
      const parent = await gitText(this.root, ["rev-parse", this.ref]);
      await git(this.root, ["read-tree", parent], { env });
      const info = batch
        .map(([path, entry]) => entry
          ? `${entry.mode} ${entry.hash}\t${path}`
          : `0 0000000000000000000000000000000000000000\t${path}`)
        .join("\n");
      await git(this.root, ["update-index", "--index-info"], { env, input: `${info}\n` });
      const tree = await gitText(this.root, ["write-tree"], { env });
      const commit = await gitText(this.root, ["commit-tree", tree, "-p", parent, "-m", `crosscode shadow (${batch.length})`]);
      // Compare-and-swap against the parent we read: a second flush racing this one would
      // otherwise drop whatever it committed.
      await git(this.root, ["update-ref", this.ref, commit, parent]);
    } catch (error) {
      // Put the batch back so the next flush retries it; dropping it would leave the ref
      // permanently behind the in-memory tree and silently break base resolution for peers.
      for (const [path, entry] of batch) if (!this.pending.has(path)) this.pending.set(path, entry);
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
