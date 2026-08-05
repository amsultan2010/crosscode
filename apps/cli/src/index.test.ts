import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./index.js";

const exec = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crosscode-cli-"));
  directories.push(root);
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", root, "config", "user.name", "Test"]);
  await writeFile(join(root, "a.txt"), "one\n");
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-qm", "initial"]);
  return root;
}

describe("crosscode join --invite", () => {
  it("requires `crosscode init` before redeeming an invite", async () => {
    await expect(runCli(["join", "--invite", "SOMECODE"])).rejects.toThrow("Run `crosscode init` before `crosscode join --invite`");
  });
});

// The envelope lives in main(), which only runs in a spawned process, so the documented
// contract has to be asserted by running the CLI for real rather than by calling runCli().
const cliEntry = fileURLToPath(new URL("./index.ts", import.meta.url));
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

async function crosscode(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  try {
    const { stdout } = await exec(process.execPath, ["--import", tsxLoader, cliEntry, ...args], { cwd });
    return { stdout, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? "", exitCode: failure.code ?? 1 };
  }
}

describe("--json output envelope", () => {
  it("wraps a success in {\"value\":…}", async () => {
    const { stdout, exitCode } = await crosscode(["--version", "--json"], await repo());
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ value: expect.stringMatching(/^\d+\.\d+\.\d+/) });
  });

  it("wraps a failure in {\"error\":{code,message,hint}}", async () => {
    const { stdout, exitCode } = await crosscode(["status", "--json"], await repo());
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      error: { code: "DAEMON_UNAVAILABLE", message: expect.any(String), hint: expect.any(String) }
    });
  });

});

describe("crosscode --version", () => {
  // Registered but never wired: the parse loop already handled commander's `commander.version`
  // error code, while `.version()` was never called -- so the published binary answered
  // `--version` with USAGE_ERROR, on the one flag everyone tries first after installing.
  it("reports a version for both --version and -V", async () => {
    const root = await repo();
    for (const flag of ["--version", "-V"]) {
      const { stdout, exitCode } = await crosscode([flag], root);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("honours --json like every other command", async () => {
    const { stdout, exitCode } = await crosscode(["--version", "--json"], await repo());
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ value: expect.stringMatching(/^\d+\.\d+\.\d+/) });
  });

});

describe("DAEMON_UNAVAILABLE", () => {
  // README documents this as the code an agent branches on when there is no daemon for
  // the worktree. The common case -- no descriptor at all -- used to escape as a raw
  // ENOENT under COMMAND_FAILED, with an absolute path in the message, so the one code
  // agents are told to handle was unreachable in exactly the situation it names.
  it("is what a command reports when no daemon is running", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crosscode-cli-"));
    try {
      await exec("git", ["init", "-q", directory]);
      await expect(runCli(["status"], directory)).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not leak an absolute path into the message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crosscode-cli-"));
    try {
      await exec("git", ["init", "-q", directory]);
      await runCli(["status"], directory);
      expect.unreachable("status should fail without a daemon");
    } catch (error) {
      expect((error as Error).message).not.toContain(directory);
      expect((error as Error).message).toContain("no daemon is running for this worktree");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
