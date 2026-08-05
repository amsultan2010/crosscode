import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonControl } from "./daemon.js";
import { runCli } from "./index.js";
import type { Environment } from "./setup.js";

const exec = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crosscode-cli-"));
  directories.push(root);
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "remote", "add", "origin", "git@github.com:acme/app.git"]);
  return root;
}

const STATUS = { branch: "main", connected: true, paused: false, cursor: 12, pendingConflicts: 1, peers: [] };

function environmentWithDaemon(daemon: Partial<DaemonControl>): Environment {
  const unused = () => {
    throw new Error("not used by this command");
  };
  return {
    serviceUrl: "https://www.getcrosscode.dev",
    createService: unused,
    signIn: unused,
    createDaemon: () => ({
      start: async () => ({ alreadyRunning: false, pid: 1 }),
      stop: async () => ({ wasRunning: false }),
      status: async () => STATUS,
      ...daemon
    }),
    installAgentSurface: unused
  };
}

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

/**
 * The hard limit from PLAN.md, asserted rather than trusted. A sixth command is the kind of
 * thing that arrives one useful flag at a time, so the count is the test.
 */
describe("the command surface", () => {
  it("is exactly five commands", async () => {
    const { stdout, exitCode } = await crosscode(["--help"], await repo());

    expect(exitCode).toBe(0);
    // Two spaces then the name: a wrapped description continues at a deeper indent, so
    // anchoring on the indent counts commands rather than words.
    const commands = stdout
      .slice(stdout.indexOf("Commands:"))
      .split("\n")
      .slice(1)
      .map((line) => /^ {2}(\S+)/.exec(line)?.[1])
      .filter((name) => name && name !== "help");
    expect(commands).toEqual(["start", "invite", "join", "status", "stop"]);
  });

  it("does not answer to anything else", async () => {
    await expect(runCli(["publish"], await repo())).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });
});

describe("crosscode status", () => {
  it("prints what the sync contract says a status is", async () => {
    const result = await runCli(["status"], await repo(), environmentWithDaemon({}));

    expect(result.value).toEqual(STATUS);
  });

  it("reports DAEMON_UNAVAILABLE, without leaking an absolute path, when nothing is running", async () => {
    const root = await repo();

    await expect(runCli(["status"], root)).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
    await expect(runCli(["status"], root)).rejects.toSatisfy((error) => !(error as Error).message.includes(root));
  });
});

describe("crosscode stop", () => {
  it("stops the daemon for this checkout", async () => {
    const result = await runCli(["stop"], await repo(), environmentWithDaemon({ stop: async () => ({ wasRunning: true }) }));

    expect(result.value).toEqual({ wasRunning: true });
  });
});

// The envelope lives in main(), which only runs in a spawned process, so the documented
// contract has to be asserted by running the CLI for real rather than by calling runCli().
describe("--json output envelope", () => {
  it("wraps a success in {\"value\":…}", async () => {
    const { stdout, exitCode } = await crosscode(["--version", "--json"], await repo());

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ value: expect.stringMatching(/^\d+\.\d+\.\d+/) });
  });

  it("wraps a failure in {\"error\":{code,message,hint}}", async () => {
    const { stdout, exitCode } = await crosscode(["status", "--json"], await repo());

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ error: { code: "DAEMON_UNAVAILABLE", message: expect.any(String), hint: expect.any(String) } });
  });
});

describe("crosscode --version", () => {
  it("reports a version for both --version and -V", async () => {
    const root = await repo();
    for (const flag of ["--version", "-V"]) {
      const { stdout, exitCode } = await crosscode([flag], root);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});
