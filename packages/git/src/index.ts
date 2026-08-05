import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
async function git(root: string, args: string[]): Promise<string> { return (await exec("git", ["-C", root, ...args])).stdout.trim(); }
async function gitBuffer(root: string, args: string[]): Promise<Buffer> {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile("git", ["-C", root, ...args], { encoding: null }, (error, stdout) => {
      if (error) rejectOutput(error);
      else resolveOutput(stdout);
    });
  });
}
async function gitWithIndex(root: string, index: string, args: string[]): Promise<string> { return (await exec("git", ["-C", root, ...args], { env: { ...process.env, GIT_INDEX_FILE: index } })).stdout.trim(); }

export type RepositoryState = { root: string; head?: string; headReflog?: string; branch?: string; worktree: string; remotes: string[]; dirty: boolean; indexTree?: string; operation?: "merge" | "rebase" | "cherry-pick" | "revert" };
export async function discoverRepository(directory: string): Promise<RepositoryState> {
  const root = await git(directory, ["rev-parse", "--show-toplevel"]);
  const [head, headReflog, branch, remotes, porcelain, merge, cherryPick, revert, rebaseMerge, rebaseApply] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]).catch(() => undefined),
    git(root, ["reflog", "show", "-1", "--format=%H%x00%gs", "HEAD"]).catch(() => undefined),
    git(root, ["branch", "--show-current"]).catch(() => undefined),
    git(root, ["remote"]).then((value) => value ? value.split("\n") : []),
    git(root, ["status", "--porcelain"]),
    git(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).catch(() => undefined),
    git(root, ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"]).catch(() => undefined),
    git(root, ["rev-parse", "-q", "--verify", "REVERT_HEAD"]).catch(() => undefined),
    resolveGitPath(root, "rebase-merge").then((path) => lstat(path)).then(() => true).catch(() => false),
    resolveGitPath(root, "rebase-apply").then((path) => lstat(path)).then(() => true).catch(() => false)
  ]);
  const indexTree = await git(root, ["write-tree"]).catch(() => undefined);
  const operation = merge ? "merge" : cherryPick ? "cherry-pick" : revert ? "revert" : rebaseMerge || rebaseApply ? "rebase" : undefined;
  return { root, head, headReflog, branch, worktree: root, remotes, dirty: Boolean(porcelain), indexTree, operation };
}
/** Fetch URL of a remote, or undefined when the checkout has no such remote configured. */
export async function remoteUrl(root: string, name = "origin"): Promise<string | undefined> {
  const url = await git(root, ["remote", "get-url", name]).catch(() => undefined);
  return url ? url : undefined;
}
export async function blobHash(root: string, path: string): Promise<string | undefined> { return git(root, ["hash-object", path]).catch(() => undefined); }
export async function resolveGitPath(root: string, path: string): Promise<string> { return resolve(root, await git(root, ["rev-parse", "--git-path", path])); }
export async function snapshotWorktreeTree(root: string): Promise<string> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "crosscode-index-"));
  const index = join(directory, "index");
  try {
    await gitWithIndex(root, index, ["read-tree", "HEAD"]).catch(() => gitWithIndex(root, index, ["read-tree", "--empty"]));
    await gitWithIndex(root, index, ["add", "-A", "--", "."]);
    return await gitWithIndex(root, index, ["write-tree"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function createCheckpoint(root: string, replicaId: string, message: string): Promise<{ ref: string; commit: string; tree: string }> {
  const tree = await snapshotWorktreeTree(root);
  const parent = await git(root, ["rev-parse", "HEAD"]).catch(() => undefined);
  const commit = await git(root, parent ? ["commit-tree", tree, "-p", parent, "-m", message] : ["commit-tree", tree, "-m", message]);
  const ref = `refs/crosscode/checkpoints/${replicaId}/${Date.now()}-${randomUUID()}`;
  await git(root, ["update-ref", ref, commit]);
  return { ref, commit, tree };
}
/** Every checkpoint ref this replica owns, oldest first (the ref name embeds its timestamp). */
export async function listCheckpointRefs(root: string, replicaId: string): Promise<string[]> {
  const prefix = `refs/crosscode/checkpoints/${replicaId}`;
  const output = await git(root, ["for-each-ref", "--format=%(refname)", prefix]).catch(() => "");
  return output ? output.split("\n").filter(Boolean).sort() : [];
}

/**
 * Retires this replica's oldest checkpoint refs, keeping the newest `keep` plus anything
 * in `retain`.
 *
 * Checkpoints are cheap to make and are made constantly -- on every capture, every
 * validation command, every Git transition, and before every accept -- and each one pins
 * a commit and a tree as a GC root. Left alone they accumulate for the life of the
 * checkout and quietly bloat `.git`, so creating one now also retires the oldest.
 *
 * Deleting a ref only drops Crosscode's hold on those objects; Git's own gc decides when
 * they actually go, and any checkpoint still named by an in-flight operation is passed in
 * via `retain` so a rollback target is never collected out from under it.
 */
export async function pruneCheckpointRefs(
  root: string, replicaId: string, keep: number, retain: readonly string[] = []
): Promise<string[]> {
  if (keep < 0) throw new Error("Checkpoint retention must not be negative");
  const refs = await listCheckpointRefs(root, replicaId);
  const protectedRefs = new Set(retain);
  const prunable = refs.filter((ref) => !protectedRefs.has(ref));
  const excess = prunable.slice(0, Math.max(0, prunable.length - keep));
  const deleted: string[] = [];
  for (const ref of excess) {
    // Best-effort per ref: a concurrent daemon may have deleted it already, and failing
    // the surrounding checkpoint over housekeeping would be strictly worse.
    const removed = await git(root, ["update-ref", "-d", ref]).then(() => true).catch(() => false);
    if (removed) deleted.push(ref);
  }
  return deleted;
}

export async function publishCommit(root: string, branch: string, message: string): Promise<{ branch: string; commit: string; tree: string; previous?: string }> {
  const ref = `refs/heads/${branch}`;
  const tip = await git(root, ["rev-parse", "-q", "--verify", ref]).catch(() => undefined);
  if (!tip) throw new Error(`Branch does not exist: ${branch}`);
  const tree = await snapshotWorktreeTree(root);
  const commit = await git(root, ["commit-tree", tree, "-p", tip, "-m", message]);
  await git(root, ["update-ref", ref, commit, tip]);
  return { branch, commit, tree, previous: tip };
}

function safeRelativePath(path: string): string {
  if (!path || path.includes("\0") || path.startsWith("/") || path.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")) throw new Error("Checkpoint path must be a safe repository-relative path");
  return path;
}

function safeCheckpointRef(ref: string): string {
  if (!/^refs\/crosscode\/checkpoints\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..")) throw new Error("Checkpoint ref is invalid");
  return ref;
}

export async function safeRepositoryPath(root: string, path: string): Promise<string> {
  const relative = safeRelativePath(path);
  const canonicalRoot = await realpath(root);
  const parts = relative.split("/").filter((part) => part && part !== ".");
  let current = canonicalRoot;
  for (const part of parts) {
    current = join(current, part);
    const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!entry) break;
    if (entry.isSymbolicLink()) throw new Error(`Repository path contains a symbolic link: ${path}`);
  }
  const destination = resolve(canonicalRoot, ...parts);
  if (!destination.startsWith(`${canonicalRoot}/`)) throw new Error("Repository path escapes repository root");
  return destination;
}

export async function inspectCheckpoint(root: string, ref: string): Promise<{ ref: string; commit: string; tree: string; files: string[] }> {
  const checkpointRef = safeCheckpointRef(ref);
  const [commit, tree, files] = await Promise.all([git(root, ["rev-parse", checkpointRef]), git(root, ["rev-parse", `${checkpointRef}^{tree}`]), git(root, ["ls-tree", "-r", "--name-only", checkpointRef])]);
  return { ref: checkpointRef, commit, tree, files: files ? files.split("\n") : [] };
}

export async function readRevisionFile(root: string, revision: string, path: string): Promise<Buffer> {
  const relative = safeRelativePath(path);
  if (!/^(?:HEAD|refs\/crosscode\/checkpoints\/[A-Za-z0-9._/-]+)$/.test(revision) || revision.includes("..")) throw new Error("Revision is invalid");
  return gitBuffer(root, ["show", "--end-of-options", `${revision}:${relative}`]);
}

export async function restoreCheckpointFile(root: string, ref: string, path: string): Promise<void> {
  const checkpointRef = safeCheckpointRef(ref); const relative = safeRelativePath(path); const content = await readRevisionFile(root, checkpointRef, relative); const destination = await safeRepositoryPath(root, relative);
  await mkdir(dirname(destination), { recursive: true }); const temporary = join(dirname(destination), `.${basename(destination)}.crosscode-restore`);
  await writeFile(temporary, content); await rename(temporary, destination);
}

export async function findSymbolReferences(root: string, symbols: string[], excludePath: string): Promise<string[]> {
  const files = new Set<string>();
  for (const symbol of symbols) {
    if (!symbol) continue;
    const output = await exec("git", ["-C", root, "grep", "-l", "-e", symbol, "--", `:!${excludePath}`])
      .then(({ stdout }) => stdout)
      .catch((error: { code?: number }) => { if (error.code === 1) return ""; throw error; });
    for (const file of output.split("\n").filter(Boolean)) if (file !== excludePath) files.add(file);
  }
  return [...files].sort();
}

export async function unifiedDiff(before: string | undefined, after: string | undefined): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "crosscode-diff-"));
  try {
    const beforePath = join(directory, "before"); const afterPath = join(directory, "after");
    await Promise.all([writeFile(beforePath, before ?? ""), writeFile(afterPath, after ?? "")]);
    return await exec("git", ["diff", "--no-index", "--unified=0", "--no-color", "--", beforePath, afterPath])
      .then(({ stdout }) => stdout)
      .catch((error: { code?: number; stdout?: string }) => { if (error.code === 1) return error.stdout ?? ""; throw error; });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function threeWayMerge(base: string, current: string, proposed: string): Promise<{ clean: boolean; content: string }> {
  const directory = await mkdtemp(join(tmpdir(), "crosscode-merge-"));
  try {
    const basePath = join(directory, "base"); const currentPath = join(directory, "current"); const proposedPath = join(directory, "proposed");
    await Promise.all([writeFile(basePath, base), writeFile(currentPath, current), writeFile(proposedPath, proposed)]);
    // `git merge-file` exits 0 on a clean merge and non-zero otherwise -- the conflict
    // count for a conflicted merge, negative on a real error. Either way the merge is not
    // clean, and the partially-merged stdout is only useful to show a human, so both
    // collapse to the same result.
    return await exec("git", ["merge-file", "-p", currentPath, basePath, proposedPath])
      .then(({ stdout }) => ({ clean: true, content: stdout }))
      .catch((error: { stdout?: string }) => ({ clean: false, content: error.stdout ?? "" }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
