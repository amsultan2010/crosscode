import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { connectToDaemon } from "./daemon-api.js";
import { extractPath, runHook } from "./hook.js";
import { startFakeDaemon, sampleConflict, type FakeDaemon } from "./fake-daemon.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const mcpMain = join(repoRoot, "apps/mcp-server/src/main.ts");

const daemons: FakeDaemon[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
});

async function fakeDaemon(conflicts: ReturnType<typeof sampleConflict>[] = []): Promise<FakeDaemon> {
  const daemon = await startFakeDaemon({ conflicts });
  daemons.push(daemon);
  return daemon;
}

async function apiFor(daemon: FakeDaemon) {
  process.env.CROSSCODE_DAEMON_URL = daemon.url;
  process.env.CROSSCODE_DAEMON_SECRET = daemon.secret;
  return connectToDaemon();
}

/** What Claude Code sends a PreToolUse hook before an Edit. */
function claudeEditPayload(filePath: string) {
  return { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: filePath, old_string: "a", new_string: "b" } };
}

describe("pre-edit hook", () => {
  it("surfaces a conflict on the file the agent is about to edit", async () => {
    const daemon = await fakeDaemon([sampleConflict("src/auth.ts")]);
    const decision = await runHook(await apiFor(daemon), claudeEditPayload("/repo/src/auth.ts"));

    expect(decision?.path).toBe("/repo/src/auth.ts");
    expect(decision?.reason).toContain("src/auth.ts");
    expect(decision?.reason).toContain("resolve");
  });

  it("stays silent for a file with no conflict", async () => {
    const daemon = await fakeDaemon([sampleConflict("src/auth.ts")]);
    await expect(runHook(await apiFor(daemon), claudeEditPayload("/repo/src/billing.ts"))).resolves.toBeUndefined();
  });

  it("stays silent when the daemon is unreachable, rather than blocking the edit", async () => {
    const failing = { conflicts: () => Promise.reject(new Error("down")) } as never;
    await expect(runHook(failing, claudeEditPayload("/repo/src/auth.ts"))).resolves.toBeUndefined();
  });

  it("finds the path in the shapes different clients send", () => {
    expect(extractPath(claudeEditPayload("/repo/a.ts"))).toBe("/repo/a.ts");
    expect(extractPath({ tool_name: "Write", tool_input: { file_path: "/repo/b.ts" } })).toBe("/repo/b.ts");
    expect(extractPath({ arguments: { path: "/repo/c.ts" } })).toBe("/repo/c.ts");
    expect(extractPath({ path: "/repo/d.ts" })).toBe("/repo/d.ts");
    expect(extractPath({ tool_name: "Bash", tool_input: { command: "ls" } })).toBeUndefined();
  });

  it("runs as a real hook process: blocks with exit 2 and an explanation on stderr", async () => {
    const daemon = await fakeDaemon([sampleConflict("src/auth.ts")]);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(
        tsxBin,
        [mcpMain, "hook"],
        { env: { ...process.env, CROSSCODE_DAEMON_URL: daemon.url, CROSSCODE_DAEMON_SECRET: daemon.secret } },
        (_error, stdout, stderr) => resolve({ code: child.exitCode, stdout, stderr })
      );
      child.stdin!.end(JSON.stringify(claudeEditPayload("/repo/src/auth.ts")));
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("src/auth.ts");
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" }
    });
  }, 20_000);

  it("lets an unrelated edit through with exit 0 and no output", async () => {
    const daemon = await fakeDaemon([sampleConflict("src/auth.ts")]);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(
        tsxBin,
        [mcpMain, "hook"],
        { env: { ...process.env, CROSSCODE_DAEMON_URL: daemon.url, CROSSCODE_DAEMON_SECRET: daemon.secret } },
        (_error, stdout, stderr) => resolve({ code: child.exitCode, stdout, stderr })
      );
      child.stdin!.end(JSON.stringify(claudeEditPayload("/repo/src/billing.ts")));
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  }, 20_000);
});
