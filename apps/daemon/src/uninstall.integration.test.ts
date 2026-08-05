import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDaemon } from "./index.js";

const exec = promisify(execFile);
const directories: string[] = [];
async function repo(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "crosscode-uninstall-"));
  directories.push(path);
  await exec("git", ["init", "-q", "-b", "main", path]);
  await exec("git", ["-C", path, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", path, "config", "user.name", "Test"]);
  await writeFile(join(path, "a.txt"), "one\n");
  await exec("git", ["-C", path, "add", "."]);
  await exec("git", ["-C", path, "commit", "-qm", "initial"]);
  return path;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("removing Crosscode", () => {
  it("leaves an ordinary functioning repository with all code still present after Crosscode's state is deleted", async () => {
    const receiverRoot = await repo();
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });
    await writeFile(join(receiverRoot, "a.txt"), "two\n");
    await receiver.capture("change");
    receiver.close();

    // "Removing/turning off Crosscode" means deleting all of its state; it never writes anything outside <git-dir>/crosscode.
    await rm(join(receiverRoot, ".git", "crosscode"), { recursive: true, force: true });

    // The synced change is ordinary (still-uncommitted) file content -- exactly what plain
    // `git status`/`git diff` would show if a developer had edited the file by hand.
    expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("two\n");
    expect((await exec("git", ["-C", receiverRoot, "status", "--porcelain"])).stdout.trim()).toBe("M a.txt");
    expect((await exec("git", ["-C", receiverRoot, "log", "--oneline"])).stdout.trim().split("\n")).toHaveLength(1);

    // Ordinary Git commands keep working with no trace of Crosscode left behind.
    await exec("git", ["-C", receiverRoot, "commit", "-aqm", "ordinary commit without Crosscode"]);
    expect((await exec("git", ["-C", receiverRoot, "log", "--oneline"])).stdout.trim().split("\n")).toHaveLength(2);
    expect((await exec("git", ["-C", receiverRoot, "status", "--porcelain"])).stdout).toBe("");
  });
});
