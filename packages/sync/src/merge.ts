import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRaw } from "./git.js";

/**
 * A NUL byte in the first 8 KB is git's own heuristic for "this is not text", and it is
 * the one the engine has to agree with: `git merge-file` refuses anything it considers
 * binary, so a file we think is text and git does not is a file we would try to merge and
 * then have to handle the refusal for anyway.
 */
export function isBinary(content: Buffer | null): boolean {
  return content !== null && content.subarray(0, 8_000).includes(0);
}

export type MergeResult =
  | { clean: true; content: Buffer }
  | { clean: false; refused: boolean };

/**
 * 3-way merge of text. `ours` and `theirs` are mirrored on the two peers, and `merge-file`
 * is deterministic and order-symmetric for disjoint hunks, so both sides compute the same
 * bytes from mirrored arguments -- which is what makes a concurrent edit converge in one
 * round instead of ping-ponging.
 *
 * The exit code is the conflict count, so 0 is clean and 3 means three conflicted hunks.
 * **Above 127 it is not a count at all, it is a refusal** -- notably "Cannot merge binary
 * files", where stdout is *empty*. Treating that empty stdout as a merge result truncates
 * the file to zero bytes, which is why the range check is here and not at the call site.
 */
export async function mergeFile(root: string, ours: Buffer, base: Buffer, theirs: Buffer): Promise<MergeResult> {
  const directory = await mkdtemp(join(tmpdir(), "crosscode-merge-"));
  try {
    await Promise.all([
      writeFile(join(directory, "ours"), ours),
      writeFile(join(directory, "base"), base),
      writeFile(join(directory, "theirs"), theirs)
    ]);
    const result = await gitRaw(directory, ["merge-file", "-p", "-L", "ours", "-L", "ancestor", "-L", "theirs", "ours", "base", "theirs"]);
    if (result.status > 127) return { clean: false, refused: true };
    if (result.status !== 0) return { clean: false, refused: false };
    return { clean: true, content: result.stdout };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A unified diff from `base` to `next`, or null when git declines to produce one. Only
 * worth sending for a large text file; below the threshold the full content is smaller
 * than the machinery around a patch.
 */
export async function makePatch(root: string, base: Buffer, next: Buffer): Promise<string | null> {
  const directory = await mkdtemp(join(tmpdir(), "crosscode-diff-"));
  try {
    await mkdir(join(directory, "a"));
    await mkdir(join(directory, "b"));
    await writeFile(join(directory, "a", "f"), base);
    await writeFile(join(directory, "b", "f"), next);
    // --no-index exits 1 when the files differ, which is the only case worth a patch.
    const result = await gitRaw(directory, ["diff", "--no-index", "--unified=3", "--", "a/f", "b/f"]);
    return result.status === 1 ? result.stdout.toString("utf8") : null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function applyPatch(base: Buffer, patch: string): Promise<Buffer | null> {
  const directory = await mkdtemp(join(tmpdir(), "crosscode-apply-"));
  try {
    await writeFile(join(directory, "f"), base);
    const result = await gitRaw(directory, ["apply", "-p2"], { input: patch });
    if (result.status !== 0) return null;
    return await readFile(join(directory, "f"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
