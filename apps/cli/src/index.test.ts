import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonConfigPath } from "../../daemon/src/runtime.js";
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

describe("crosscode run -- <tool>", () => {
  it("returns the child's exit code on success", async () => {
    const result = await runCli(["run", "--", "node", "-e", "process.exit(0)"]);
    expect(result.exitCode).toBe(0);
  });

  it("passes through a nonzero exit code unchanged", async () => {
    const result = await runCli(["run", "--", "node", "-e", "process.exit(7)"]);
    expect(result.exitCode).toBe(7);
  });

  it("forwards argv exactly as given, including flags that look like CLI options", async () => {
    const result = await runCli([
      "run",
      "--",
      "node",
      "-e",
      "process.exit(process.argv[1] === '--json' && process.argv[2] === '--profile' ? 0 : 1)",
      "--",
      "--json",
      "--profile"
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("rejects when -- is missing or no command follows it", async () => {
    await expect(runCli(["run"])).rejects.toThrow("Usage: crosscode run -- <command> [args]");
    await expect(runCli(["run", "--"])).rejects.toThrow("Usage: crosscode run -- <command> [args]");
  });
});

describe("crosscode login", () => {
  const ACCESS_TOKEN = "eyJhbGciOi.access-token-that-must-never-be-printed.signature";
  const REFRESH_TOKEN = "refresh-token-that-must-never-be-printed";

  it("completes the browser flow from a posted callback and never puts a token in its output", async () => {
    const root = await repo();
    await runCli(["init"], root);
    const printed: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
    try {
      // --no-browser prints the URL instead of opening one, which is also how a test (or
      // a remote shell) learns the ephemeral port and state to post back to.
      const pending = runCli(["login", "--no-browser", "--web", "http://web.test", "--service", "http://127.0.0.1:8788"], root);
      const url = await waitFor(() => printed.join("").match(/http:\/\/web\.test\/auth\/cli\.html\?\S+/)?.[0]);
      const parameters = new URL(url).searchParams;
      const response = await fetch(`http://127.0.0.1:${parameters.get("port")}/callback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          state: parameters.get("state"),
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          expires_at: 1_800_000_000,
          user: { id: "user-1", email: "alice@example.com" }
        })
      });
      expect(response.status).toBe(200);

      const result = await pending;
      expect(result.value).toEqual({ userId: "user-1", email: "alice@example.com" });
      const emitted = `${JSON.stringify(result.value)}${printed.join("")}`;
      expect(emitted).not.toContain(ACCESS_TOKEN);
      expect(emitted).not.toContain(REFRESH_TOKEN);

      // The session went to the 0600 config file the daemon reads instead.
      const path = await daemonConfigPath(root);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(path, "utf8")).toContain(ACCESS_TOKEN);
    } finally {
      stderr.mockRestore();
    }
  });

  it("refuses to open a browser with no TTY instead of blocking on a tab nobody can see", async () => {
    const root = await repo();
    await runCli(["init"], root);
    await expect(runCli(["login", "--web", "http://web.test"], root)).rejects.toThrow("Browser login needs a terminal");
  });

  it("rejects a half-specified headless login", async () => {
    await expect(runCli(["login", "--email", "alice@example.com"])).rejects.toThrow("needs both --email and --password");
  });
});

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the CLI to print its sign-in URL");
}

describe("crosscode signup", () => {
  it("rejects when neither email nor password is available and stdin is not a TTY", async () => {
    await expect(runCli(["signup"])).rejects.toThrow("Usage: crosscode signup --email <email> --password <password>");
  });
});

describe("crosscode join --invite", () => {
  it("requires `crosscode init` before redeeming an invite", async () => {
    await expect(runCli(["join", "--invite", "SOMECODE"])).rejects.toThrow("Run `crosscode init` before `crosscode join --invite`");
  });
});

// Billing status now reads the service's own GET /v1/workspace/billing rather than
// opening a PostgreSQL connection, so it needs a configured checkout and a session --
// not DATABASE_URL, which an end user would never have. --workspace is optional and
// defaults to the workspace this checkout belongs to.
describe("crosscode billing status", () => {
  it("requires `crosscode init` before it can reach the service", async () => {
    await expect(runCli(["billing", "status"])).rejects.toThrow("Run `crosscode init` before talking to the coordination service");
  });

  it("does not require DATABASE_URL", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousMigrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.MIGRATION_DATABASE_URL;
    try {
      await expect(runCli(["billing", "status", "--workspace", "workspace-1"])).rejects.toThrow(
        /coordination service|crosscode init/
      );
    } finally {
      if (previousDatabaseUrl !== undefined) process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousMigrationDatabaseUrl !== undefined) process.env.MIGRATION_DATABASE_URL = previousMigrationDatabaseUrl;
    }
  });
});

describe("crosscode devices / members", () => {
  it("exposes device and member management so the revocation endpoints are reachable from the CLI", async () => {
    const commands = (await runCli(["commands"])).value as Array<{ command: string }>;
    const names = commands.map((entry) => entry.command);
    expect(names).toContain("devices list");
    expect(names).toContain("devices revoke");
    expect(names).toContain("members list");
    expect(names).toContain("members remove");
  });

  it("lists retained checkpoints, which the daemon has always exposed but the CLI could not reach", async () => {
    const commands = (await runCli(["commands"])).value as Array<{ command: string }>;
    expect(commands.map((entry) => entry.command)).toContain("checkpoint list");
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
    const { stdout, exitCode } = await crosscode(["init", "--json"], await repo());
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      value: { workspaceId: expect.any(String), replicaId: expect.any(String), actorId: expect.any(String) }
    });
  });

  it("wraps a failure in {\"error\":{code,message,hint}}", async () => {
    const { stdout, exitCode } = await crosscode(["status", "--json"], await repo());
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      error: { code: "DAEMON_UNAVAILABLE", message: expect.any(String), hint: expect.any(String) }
    });
  });

  it("writes no envelope of its own for `run --`, even with --json, and keeps the child's exit code", async () => {
    const { stdout, exitCode } = await crosscode(
      ["run", "--json", "--", process.execPath, "-e", "console.log('child'); process.exit(7)"],
      await repo()
    );
    expect(stdout).toBe("child\n");
    expect(exitCode).toBe(7);
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
