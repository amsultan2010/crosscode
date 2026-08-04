import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonConfigPath } from "../../daemon/src/runtime.js";
import { runCli } from "./index.js";

const exec = promisify(execFile);
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
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

// Upgrading is a CLI command that opens the payment provider's hosted checkout, not a web
// form: BUILD_INSTRUCTIONS.md keeps the website to landing, auth, and docs.
describe("crosscode billing upgrade / cancel / portal", () => {
  async function configuredRepo(serviceUrl: string): Promise<string> {
    const root = await repo();
    const path = await daemonConfigPath(root);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Written directly rather than through writeDaemonConfig, which would put the refresh
    // token in the real OS keychain.
    await writeFile(path, JSON.stringify({
      workspaceId: "workspace-1",
      actorId: "owner@example.com",
      service: { url: serviceUrl, session: { accessToken: "token", refreshToken: "refresh", expiresAt: "2099-01-01T00:00:00.000Z" } }
    }), { mode: 0o600 });
    return root;
  }

  async function stubService(handler: (request: IncomingMessage, body: string) => unknown): Promise<{ url: string; requests: Array<{ path: string; body: string }> }> {
    const requests: Array<{ path: string; body: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({ path: request.url ?? "/", body });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, data: handler(request, body) }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
  }

  it("asks for annual billing unless --monthly is passed", async () => {
    const service = await stubService(() => ({
      mode: "checkout", plan: "pro", interval: "year", seats: 1,
      url: "https://checkout.example/cs_1", priceCents: 5_000, monthlyEquivalentCents: 500
    }));
    const root = await configuredRepo(service.url);

    await runCli(["billing", "upgrade", "--plan", "pro", "--no-browser"], root);
    // The default with no interval flag at all. Annual is load-bearing at these prices:
    // the processor's fixed fee is ~15% of a $2.50 charge and ~4% of a $25 one.
    expect(JSON.parse(service.requests.at(-1)!.body)).toEqual({ plan: "pro", interval: "year" });

    await runCli(["billing", "upgrade", "--plan", "pro", "--monthly", "--no-browser"], root);
    expect(JSON.parse(service.requests.at(-1)!.body)).toEqual({ plan: "pro", interval: "month" });

    await runCli(["billing", "upgrade", "--plan", "team", "--seats", "8", "--no-browser"], root);
    expect(JSON.parse(service.requests.at(-1)!.body)).toEqual({ plan: "team", interval: "year", seats: 8 });
  });

  it("returns the checkout URL as the command's value so an agent can act on it", async () => {
    const service = await stubService(() => ({
      mode: "checkout", plan: "pro", interval: "year", seats: 1,
      url: "https://checkout.example/cs_1", priceCents: 5_000, monthlyEquivalentCents: 500
    }));
    const root = await configuredRepo(service.url);

    const result = await runCli(["billing", "upgrade", "--plan", "pro", "--no-browser"], root);

    expect(result.value).toMatchObject({ mode: "checkout", url: "https://checkout.example/cs_1" });
  });

  it("rejects an unknown plan and a nonsense seat count before making a request", async () => {
    const service = await stubService(() => ({}));
    const root = await configuredRepo(service.url);

    await expect(runCli(["billing", "upgrade", "--plan", "enterprise"], root)).rejects.toThrow(/Unknown plan/);
    await expect(runCli(["billing", "upgrade", "--plan", "team", "--seats", "0"], root)).rejects.toThrow(/positive integer/);
    // Student is Pro's limits at Essential's price and needs verification, so it is not
    // offered here; the service refuses it too.
    await expect(runCli(["billing", "upgrade", "--plan", "student"], root)).rejects.toThrow(/Unknown plan/);
    await expect(runCli(["billing", "upgrade"], root)).rejects.toThrow(/--plan/);
    expect(service.requests).toEqual([]);
  });

  it("will not cancel a subscription without confirmation in a noninteractive shell", async () => {
    const service = await stubService(() => ({ plan: "pro", cancelAtPeriodEnd: true, currentPeriodEnd: null }));
    const root = await configuredRepo(service.url);

    await expect(runCli(["billing", "cancel"], root)).rejects.toThrow(/requires confirmation/);
    expect(service.requests).toEqual([]);

    const cancelled = await runCli(["billing", "cancel", "--yes"], root);
    expect(cancelled.value).toMatchObject({ cancelAtPeriodEnd: true });
    expect(service.requests.at(-1)!.path).toBe("/v1/workspace/billing/cancel");
  });

  it("exposes the whole subscription lifecycle in the machine-readable catalog", async () => {
    const names = ((await runCli(["commands"])).value as Array<{ command: string }>).map((entry) => entry.command);
    expect(names).toEqual(expect.arrayContaining(["billing status", "billing upgrade", "billing cancel", "billing portal"]));
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

describe("crosscode key / pair", () => {
  it("exposes the whole workspace-key surface, so nothing about encryption needs a web UI", async () => {
    const commands = (await runCli(["commands"])).value as Array<{ command: string }>;
    const names = commands.map((entry) => entry.command);
    for (const name of ["pair", "key status", "key init", "key export", "key import", "key devices", "key approve", "key rotate", "key forget"]) {
      expect(names).toContain(name);
    }
  });

  it("refuses to grant, rotate, or forget a key noninteractively without an explicit flag", async () => {
    const root = await repo();
    // vitest runs with no TTY, which is exactly the agent/CI case being asserted: each of
    // these either hands out the workspace key or destroys access to it, so the caller has
    // to say so in the command rather than be prompted -- and it must never silently
    // proceed just because there was nobody to ask.
    expect(process.stdout.isTTY).toBeFalsy();
    await expect(runCli(["key", "rotate"], root)).rejects.toThrow(/requires confirmation/);
    await expect(runCli(["key", "forget"], root)).rejects.toThrow(/requires confirmation/);
  });

  it("reports a missing keyring as an actionable state rather than a crash", async () => {
    const root = await repo();
    // A checkout that has never synced holds no keyring. The message has to say what to
    // run next, because this is also what a restored-from-backup machine hits.
    await expect(runCli(["key", "status"], root)).rejects.toThrow(/no workspace keyring/i);
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

  // The flag belongs to the root program, so a `-V` anywhere past the first bare word is
  // somebody else's -- a child process's here -- and must reach it untouched rather than
  // being answered as the CLI's own version.
  it("does not intercept a -V bound for a child process", async () => {
    const result = await runCli([
      "run",
      "--",
      "node",
      "-e",
      "process.exit(process.argv[1] === '-V' && process.argv[2] === '--version' ? 0 : 1)",
      "--",
      "-V",
      "--version"
    ]);
    expect(result.exitCode).toBe(0);
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
