import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationService } from "../../service/src/index.js";
import { LocalDaemon } from "./index.js";

const exec = promisify(execFile);
const directories: string[] = [];
async function repo(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "crosscode-publish-"));
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

describe("publish integration", () => {
  it("publishes accepted, validated work as an ordinary commit without disturbing unrelated files or Git identity", async () => {
    const senderRoot = await repo();
    const receiverRoot = await repo();
    const service = new CoordinationService();
    const sender = await LocalDaemon.open(senderRoot, { workspaceId: "w", replicaId: "sender", actorId: "a" });
    const receiver = await LocalDaemon.open(receiverRoot, { workspaceId: "w", replicaId: "receiver", actorId: "b" });

    await writeFile(join(senderRoot, "a.txt"), "two\n");
    const operation = await sender.capture("change", service);
    await receiver.sync(service);
    await receiver.accept(operation.id);
    expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("two\n");

    await writeFile(join(receiverRoot, "unrelated.txt"), "leave me alone\n");
    const initialHead = (await exec("git", ["-C", receiverRoot, "rev-parse", "refs/heads/main"])).stdout.trim();

    await receiver.validate("fast", ["true"]);
    const result = await receiver.publish({ branch: "main", profile: "fast" });

    if (!("commit" in result)) throw new Error("Expected a completed publish result");
    expect(result.previous).toBe(initialHead);
    expect((await exec("git", ["-C", receiverRoot, "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(result.commit);
    expect((await exec("git", ["-C", receiverRoot, "log", "-1", "--format=%P", result.commit])).stdout.trim()).toBe(initialHead);
    expect((await exec("git", ["-C", receiverRoot, "show", `${result.commit}:a.txt`])).stdout).toBe("two\n");

    expect(await readFile(join(receiverRoot, "unrelated.txt"), "utf8")).toBe("leave me alone\n");
    expect((await exec("git", ["-C", receiverRoot, "branch", "--show-current"])).stdout.trim()).toBe("main");
  });

  it("leaves the checked-out branch, HEAD, and index unchanged when publishing a different branch", async () => {
    const root = await repo();
    await exec("git", ["-C", root, "branch", "release"]);
    const daemon = await LocalDaemon.open(root, { workspaceId: "w", replicaId: "replica", actorId: "actor" });
    await writeFile(join(root, "a.txt"), "two\n");
    const headBefore = (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    const branchBefore = (await exec("git", ["-C", root, "branch", "--show-current"])).stdout.trim();

    await daemon.validate("fast", ["true"]);
    const result = await daemon.publish({ branch: "release", profile: "fast" });

    if (!("commit" in result)) throw new Error("Expected a completed publish result");
    expect((await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);
    expect((await exec("git", ["-C", root, "branch", "--show-current"])).stdout.trim()).toBe(branchBefore);
    expect((await exec("git", ["-C", root, "diff", "--cached"])).stdout).toBe("");
    expect((await exec("git", ["-C", root, "rev-parse", "refs/heads/release"])).stdout.trim()).toBe(result.commit);
    expect((await exec("git", ["-C", root, "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(headBefore);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("two\n");
  });
});
