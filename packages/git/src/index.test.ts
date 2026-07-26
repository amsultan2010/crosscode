import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createCheckpoint, discoverRepository, inspectCheckpoint, restoreCheckpointFile, threeWayMerge } from "./index.js";

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
});
