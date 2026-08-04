import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createCheckpoint, discoverRepository, findSymbolReferences, inspectCheckpoint, listCheckpointRefs, pruneCheckpointRefs, publishCommit, restoreCheckpointFile, threeWayMerge, unifiedDiff } from "./index.js";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })))); });

describe("git safety", () => {
  it("writes a hidden checkpoint without moving HEAD or index", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crosscode-git-")); directories.push(directory);
    await exec("git", ["init", "-q", directory]);
    await exec("git", ["-C", directory, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", directory, "config", "user.name", "Test"]);
    await writeFile(join(directory, "a.txt"), "before\n");
    await exec("git", ["-C", directory, "add", "."]); await exec("git", ["-C", directory, "commit", "-qm", "initial"]);
    const before = (await exec("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(directory, "a.txt"), "after\n");
    await writeFile(join(directory, "untracked.txt"), "untracked\n");
    const checkpoint = await createCheckpoint(directory, "replica", "save work");
    expect(checkpoint.ref).toMatch(/^refs\/crosscode\/checkpoints\/replica\//);
    expect((await exec("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim()).toBe(before);
    expect((await exec("git", ["-C", directory, "diff", "--cached"])).stdout).toBe("");
    expect((await discoverRepository(directory)).head).toBe(before);
    await expect(inspectCheckpoint(directory, checkpoint.ref)).resolves.toMatchObject({ files: ["a.txt", "untracked.txt"] });
  });

  it("inspects and restores a checkpoint file without moving HEAD or the index", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crosscode-git-")); directories.push(directory);
    await exec("git", ["init", "-q", directory]); await exec("git", ["-C", directory, "config", "user.email", "test@example.com"]); await exec("git", ["-C", directory, "config", "user.name", "Test"]);
    await writeFile(join(directory, "a.txt"), "base\n"); await exec("git", ["-C", directory, "add", "."]); await exec("git", ["-C", directory, "commit", "-qm", "initial"]);
    const head = (await exec("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(directory, "a.txt"), "checkpoint\n"); const checkpoint = await createCheckpoint(directory, "replica", "save work");
    await writeFile(join(directory, "a.txt"), "later\n");

    await expect(inspectCheckpoint(directory, checkpoint.ref)).resolves.toMatchObject({ ref: checkpoint.ref, files: ["a.txt"] });
    await restoreCheckpointFile(directory, checkpoint.ref, "a.txt");
    expect(await readFile(join(directory, "a.txt"), "utf8")).toBe("checkpoint\n");
    expect((await exec("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect((await exec("git", ["-C", directory, "diff", "--cached"])).stdout).toBe("");
    await expect(inspectCheckpoint(directory, "--output=/tmp/crosscode-injected")).rejects.toThrow("invalid");
  });

  it("restores checkpoint bytes without UTF-8 conversion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crosscode-git-")); directories.push(directory);
    await exec("git", ["init", "-q", directory]); await exec("git", ["-C", directory, "config", "user.email", "test@example.com"]); await exec("git", ["-C", directory, "config", "user.name", "Test"]);
    const binary = Buffer.from([0xff, 0x00, 0xfe, 0x01]);
    await writeFile(join(directory, "binary.dat"), binary); await exec("git", ["-C", directory, "add", "."]); await exec("git", ["-C", directory, "commit", "-qm", "binary"]);
    const checkpoint = await createCheckpoint(directory, "replica", "save binary");
    await writeFile(join(directory, "binary.dat"), Buffer.from([0x01]));

    await restoreCheckpointFile(directory, checkpoint.ref, "binary.dat");

    expect(await readFile(join(directory, "binary.dat"))).toEqual(binary);
  });

  it("uses Git three-way merge analysis without writing files", async () => {
    await expect(threeWayMerge("one\ntwo\nthree\n", "one-local\ntwo\nthree\n", "one\ntwo\nthree-remote\n")).resolves.toMatchObject({ clean: true, content: "one-local\ntwo\nthree-remote\n" });
  });

  it("produces a real unified diff with parseable hunk headers for changed line ranges", async () => {
    const before = "line1\nline2\nline3\nline4\nline5\nline6\n";
    const after = "line1\nline2\nline3\nline4\nLINE5\nLINE6\n";
    const patch = await unifiedDiff(before, after);
    expect(patch).toMatch(/^@@ -5,2 \+5,2 @@/m);
    expect(patch).toContain("-line5");
    expect(patch).toContain("+LINE5");
  });

  it("produces an empty diff for identical content and full-file diffs for add/delete", async () => {
    await expect(unifiedDiff("same\n", "same\n")).resolves.toBe("");
    await expect(unifiedDiff(undefined, "new\n")).resolves.toMatch(/^@@ -0,0 \+1 @@\n\+new/m);
    await expect(unifiedDiff("gone\n", undefined)).resolves.toMatch(/^@@ -1 \+0,0 @@\n-gone/m);
  });

  it("finds other tracked files that reference a changed exported symbol", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crosscode-git-")); directories.push(directory);
    await exec("git", ["init", "-q", directory]); await exec("git", ["-C", directory, "config", "user.email", "test@example.com"]); await exec("git", ["-C", directory, "config", "user.name", "Test"]);
    await writeFile(join(directory, "lib.ts"), "export function greet(name: string): string { return name; }\n");
    await writeFile(join(directory, "caller.ts"), "import { greet } from \"./lib\";\ngreet(\"world\");\n");
    await writeFile(join(directory, "unrelated.ts"), "export const other = 1;\n");
    await exec("git", ["-C", directory, "add", "."]); await exec("git", ["-C", directory, "commit", "-qm", "initial"]);

    await expect(findSymbolReferences(directory, ["greet"], "lib.ts")).resolves.toEqual(["caller.ts"]);
    await expect(findSymbolReferences(directory, ["nonexistentSymbol"], "lib.ts")).resolves.toEqual([]);
  });

  it("publishes a fast-forward commit built from the working tree onto a branch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crosscode-git-")); directories.push(directory);
    await exec("git", ["init", "-q", "-b", "main", directory]); await exec("git", ["-C", directory, "config", "user.email", "test@example.com"]); await exec("git", ["-C", directory, "config", "user.name", "Test"]);
    await writeFile(join(directory, "a.txt"), "one\n"); await exec("git", ["-C", directory, "add", "."]); await exec("git", ["-C", directory, "commit", "-qm", "initial"]);
    const initial = (await exec("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(directory, "a.txt"), "two\n");

    const result = await publishCommit(directory, "main", "publish work");

    expect(result.previous).toBe(initial);
    expect((await exec("git", ["-C", directory, "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(result.commit);
    expect((await exec("git", ["-C", directory, "log", "-1", "--format=%P", result.commit])).stdout.trim()).toBe(initial);
    expect((await exec("git", ["-C", directory, "show", `${result.commit}:a.txt`])).stdout).toBe("two\n");
  });

  it("rejects publishing when the branch tip moves concurrently between resolving the tip and updating the ref", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crosscode-git-")); directories.push(directory);
    await exec("git", ["init", "-q", "-b", "main", directory]); await exec("git", ["-C", directory, "config", "user.email", "test@example.com"]); await exec("git", ["-C", directory, "config", "user.name", "Test"]);
    await writeFile(join(directory, "a.txt"), "one\n"); await exec("git", ["-C", directory, "add", "."]); await exec("git", ["-C", directory, "commit", "-qm", "initial"]);
    const initial = (await exec("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(directory, "a.txt"), "two\n");

    // publishCommit resolves the tip first, then does several sequential plumbing calls to build
    // the tree before its final compare-and-swap update-ref. Racing a single fast commit against
    // it moves the branch tip out from under the tip publishCommit already resolved.
    const publishing = publishCommit(directory, "main", "publish work");
    await exec("git", ["-C", directory, "commit", "--allow-empty", "-qm", "concurrent"]);
    const concurrentCommit = (await exec("git", ["-C", directory, "rev-parse", "refs/heads/main"])).stdout.trim();
    expect(concurrentCommit).not.toBe(initial);

    await expect(publishing).rejects.toThrow();
    expect((await exec("git", ["-C", directory, "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(concurrentCommit);
  });

  it("never touches HEAD, the index, or the checked-out branch when publishing a different branch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crosscode-git-")); directories.push(directory);
    await exec("git", ["init", "-q", "-b", "main", directory]); await exec("git", ["-C", directory, "config", "user.email", "test@example.com"]); await exec("git", ["-C", directory, "config", "user.name", "Test"]);
    await writeFile(join(directory, "a.txt"), "one\n"); await exec("git", ["-C", directory, "add", "."]); await exec("git", ["-C", directory, "commit", "-qm", "initial"]);
    await exec("git", ["-C", directory, "branch", "release"]);
    const headBefore = (await exec("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim();
    const branchBefore = (await exec("git", ["-C", directory, "branch", "--show-current"])).stdout.trim();
    await writeFile(join(directory, "a.txt"), "two\n");

    const result = await publishCommit(directory, "release", "publish work");

    expect((await exec("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);
    expect((await exec("git", ["-C", directory, "branch", "--show-current"])).stdout.trim()).toBe(branchBefore);
    expect((await exec("git", ["-C", directory, "diff", "--cached"])).stdout).toBe("");
    expect(await readFile(join(directory, "a.txt"), "utf8")).toBe("two\n");
    expect((await exec("git", ["-C", directory, "rev-parse", "refs/heads/release"])).stdout.trim()).toBe(result.commit);
    expect((await exec("git", ["-C", directory, "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(headBefore);
  });
});

describe("checkpoint retention", () => {
  async function repositoryWithCommit(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "crosscode-git-")); directories.push(directory);
    await exec("git", ["init", "-q", "-b", "main", directory]);
    await exec("git", ["-C", directory, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", directory, "config", "user.name", "Test"]);
    await writeFile(join(directory, "a.txt"), "one\n");
    await exec("git", ["-C", directory, "add", "."]);
    await exec("git", ["-C", directory, "commit", "-qm", "initial"]);
    return directory;
  }

  it("keeps only the newest refs, so a long-lived checkout stops accumulating them forever", async () => {
    const directory = await repositoryWithCommit();
    const refs: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(directory, "a.txt"), `revision ${index}\n`);
      refs.push((await createCheckpoint(directory, "replica-a", `checkpoint ${index}`)).ref);
    }
    expect(await listCheckpointRefs(directory, "replica-a")).toHaveLength(5);

    const deleted = await pruneCheckpointRefs(directory, "replica-a", 2);

    expect(deleted).toHaveLength(3);
    const remaining = await listCheckpointRefs(directory, "replica-a");
    expect(remaining).toHaveLength(2);
    expect(remaining).toEqual(refs.slice(-2).sort());
    // Really gone from the ref namespace, not just from our own bookkeeping.
    await expect(exec("git", ["-C", directory, "rev-parse", "--verify", refs[0]!])).rejects.toBeDefined();
  });

  it("retains a checkpoint an in-flight operation still names, however old it is", async () => {
    const directory = await repositoryWithCommit();
    const refs: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      await writeFile(join(directory, "a.txt"), `revision ${index}\n`);
      refs.push((await createCheckpoint(directory, "replica-a", `checkpoint ${index}`)).ref);
    }
    const oldest = refs[0]!;

    const deleted = await pruneCheckpointRefs(directory, "replica-a", 1, [oldest]);

    expect(deleted).not.toContain(oldest);
    expect(await listCheckpointRefs(directory, "replica-a")).toContain(oldest);
    // The rollback target still resolves, which is the whole point of retaining it.
    expect((await exec("git", ["-C", directory, "rev-parse", "--verify", oldest])).stdout.trim()).toHaveLength(40);
  });

  it("leaves another replica's checkpoints alone", async () => {
    const directory = await repositoryWithCommit();
    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(directory, "a.txt"), `mine ${index}\n`);
      await createCheckpoint(directory, "replica-a", `mine ${index}`);
    }
    await writeFile(join(directory, "a.txt"), "theirs\n");
    await createCheckpoint(directory, "replica-b", "theirs");

    await pruneCheckpointRefs(directory, "replica-a", 0);

    expect(await listCheckpointRefs(directory, "replica-a")).toHaveLength(0);
    expect(await listCheckpointRefs(directory, "replica-b")).toHaveLength(1);
  });
});
