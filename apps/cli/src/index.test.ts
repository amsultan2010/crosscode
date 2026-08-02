import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("crosscode -- signup", () => {
  it("rejects when neither email nor password is available and stdin is not a TTY", async () => {
    await expect(runCli(["signup"])).rejects.toThrow("Usage: crosscode -- signup --email <email> --password <password>");
  });
});

describe("crosscode join --invite", () => {
  it("requires `crosscode init` before redeeming an invite", async () => {
    await expect(runCli(["join", "--invite", "SOMECODE"])).rejects.toThrow("Run `crosscode init` before `crosscode join --invite`");
  });
});

describe("crosscode billing status", () => {
  it("rejects when --workspace is missing", async () => {
    await expect(runCli(["billing", "status"])).rejects.toThrow("Usage: crosscode billing status --workspace <workspaceId>");
  });

  it("rejects when neither DATABASE_URL nor MIGRATION_DATABASE_URL is set", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousMigrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.MIGRATION_DATABASE_URL;
    try {
      await expect(runCli(["billing", "status", "--workspace", "workspace-1"])).rejects.toThrow(
        "DATABASE_URL or MIGRATION_DATABASE_URL is required"
      );
    } finally {
      if (previousDatabaseUrl !== undefined) process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousMigrationDatabaseUrl !== undefined) process.env.MIGRATION_DATABASE_URL = previousMigrationDatabaseUrl;
    }
  });
});
