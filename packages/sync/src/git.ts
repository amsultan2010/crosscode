import { spawn } from "node:child_process";

/**
 * Git plumbing, buffer-in / buffer-out.
 *
 * Everything the engine stores travels as raw bytes -- a binary asset is as much a synced
 * file as a source file -- so nothing here decodes to a string on the way past. `execFile`
 * with a string encoding corrupts exactly the files that are hardest to notice being
 * corrupted, which is why this is spawn-based instead.
 *
 * Exit codes are returned rather than thrown by `gitRaw`, because two of the commands the
 * engine leans on report meaning through them: `merge-file` returns the conflict count, and
 * anything above 127 from it is a refusal (see mergeFile in merge.ts).
 */

export type GitResult = { status: number; stdout: Buffer; stderr: string };

/**
 * Commits made for `refs/crosscode/*` never enter history and never carry the user's name.
 * They also must not fail on a machine where `user.email` was never configured, which is
 * what an unset identity would do to `commit-tree`.
 */
const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Crosscode",
  GIT_AUTHOR_EMAIL: "daemon@crosscode.local",
  GIT_COMMITTER_NAME: "Crosscode",
  GIT_COMMITTER_EMAIL: "daemon@crosscode.local"
};

export function gitRaw(
  cwd: string,
  args: readonly string[],
  options: { input?: Buffer | string; env?: NodeJS.ProcessEnv } = {}
): Promise<GitResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...COMMIT_IDENTITY, ...options.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", rejectResult);
    child.on("close", (code, signal) => {
      resolveResult({
        // A killed process has no exit code; report it as a hard failure rather than 0.
        status: code ?? (signal ? 128 : 1),
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8")
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function git(cwd: string, args: readonly string[], options?: { input?: Buffer | string; env?: NodeJS.ProcessEnv }): Promise<Buffer> {
  const result = await gitRaw(cwd, args, options);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim()}`);
  return result.stdout;
}

export async function gitText(cwd: string, args: readonly string[], options?: { input?: Buffer | string; env?: NodeJS.ProcessEnv }): Promise<string> {
  return (await git(cwd, args, options)).toString("utf8").trim();
}

/** null instead of throwing, for the many "does git know about this?" questions. */
export async function gitTextOrNull(cwd: string, args: readonly string[]): Promise<string | null> {
  const result = await gitRaw(cwd, args);
  return result.status === 0 ? result.stdout.toString("utf8").trim() : null;
}

/** Git's canonical empty tree. Nameable in every repository without being written first. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export async function repositoryRoot(directory: string): Promise<string> {
  return gitText(directory, ["rev-parse", "--show-toplevel"]);
}

/** The commit HEAD points at, or null in a repository with no commits yet. */
export async function headCommit(root: string): Promise<string | null> {
  return gitTextOrNull(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
}

/**
 * Whether `commit` is already contained in `descendant`. False when either is unknown to
 * this repository, which is the answer that matters: a peer's commit we have never fetched
 * is not one we contain, so we are the one that has to pull.
 */
export async function isAncestor(root: string, commit: string, descendant: string): Promise<boolean> {
  return (await gitRaw(root, ["merge-base", "--is-ancestor", commit, descendant])).status === 0;
}

export async function currentBranch(root: string): Promise<string> {
  const branch = await gitTextOrNull(root, ["branch", "--show-current"]);
  return branch || "HEAD";
}

/**
 * Writes bytes into the object store and returns the blob hash. `--stdin` never runs a
 * clean filter, so the hash is of exactly these bytes -- which is what makes a hash the
 * engine hands a peer resolvable back to the same bytes on the other side.
 */
export async function writeBlob(root: string, content: Buffer): Promise<string> {
  return gitText(root, ["hash-object", "-w", "--stdin"], { input: content });
}

export async function hashBlob(root: string, content: Buffer): Promise<string> {
  return gitText(root, ["hash-object", "--stdin"], { input: content });
}

/** The blob's bytes, or null when this repository has never seen that object. */
export async function readBlob(root: string, hash: string | null): Promise<Buffer | null> {
  if (!hash) return null;
  const result = await gitRaw(root, ["cat-file", "blob", hash]);
  return result.status === 0 ? result.stdout : null;
}

/** Tracked paths, which is the entire universe of files Crosscode will ever sync. */
export async function trackedPaths(root: string): Promise<string[]> {
  // Not gitText: it trims, and a path may legitimately begin or end with whitespace -- which
  // `ls-files` sorts first, so the trim silently renames it and the file never syncs. The NUL
  // separators already delimit the records exactly.
  const output = (await git(root, ["ls-files", "-z"])).toString("utf8");
  return output.split("\0").filter(Boolean);
}

export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";

/**
 * The in-progress git operation, if any. Sync pauses for the whole of one: a rebase
 * rewrites the working tree dozens of times, and publishing each intermediate state would
 * broadcast commits the user has not finished making.
 */
export async function inProgressOperation(root: string): Promise<GitOperation | undefined> {
  const gitDir = await gitText(root, ["rev-parse", "--absolute-git-dir"]);
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) return "rebase";
  if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert";
  if (existsSync(join(gitDir, "BISECT_LOG"))) return "bisect";
  return undefined;
}
