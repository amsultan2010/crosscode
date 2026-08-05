import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { syncDaemonConfigSchema } from "../../../packages/protocol/src/sync.js";
import { installAgentSurface } from "./agent-surface.js";
import { configPath, readConfig } from "./config.js";
import type { DaemonControl } from "./daemon.js";
import { httpSyncService, type SyncService } from "./service.js";
import { setup, type Environment } from "./setup.js";

const exec = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function checkout(repo = "acme/app"): Promise<string> {
  // realpath because git reports the resolved root, and /tmp is a symlink on macOS.
  const root = await realpath(await mkdtemp(join(tmpdir(), "crosscode-setup-")));
  directories.push(root);
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "remote", "add", "origin", `git@github.com:${repo}.git`]);
  return root;
}

const SESSION = { accessToken: "token", refreshToken: "refresh", expiresAt: "2030-01-01T00:00:00.000Z" };

/**
 * A stub of the three workstreams `setup` sits on top of -- the service, the sign-in, and
 * the daemon -- each counting its calls, because "idempotent" here means exactly "called
 * once no matter how many times start runs".
 */
function stubEnvironment(overrides: { service?: Partial<SyncService> } = {}) {
  const calls = { createProject: 0, redeemInvite: 0, signIn: 0, daemonStart: 0 };
  let daemonRunning = false;

  const service: SyncService = {
    createProject: async (request) => {
      calls.createProject += 1;
      return { id: `project-${calls.createProject}`, name: request.name, repo: request.repo, plan: "free", createdAt: "2026-01-01T00:00:00.000Z" };
    },
    createInvite: async () => {
      throw new Error("not used");
    },
    redeemInvite: async () => {
      calls.redeemInvite += 1;
      return { projectId: "project-from-invite", repo: "acme/app", cloneCommand: "git clone git@github.com:acme/app.git && cd app" };
    },
    ...overrides.service
  };

  const daemon: DaemonControl = {
    start: async () => {
      if (daemonRunning) return { alreadyRunning: true, pid: 4242 };
      daemonRunning = true;
      calls.daemonStart += 1;
      return { alreadyRunning: false, pid: 4242 };
    },
    stop: async () => ({ wasRunning: daemonRunning }),
    status: async () => ({ branch: "main", connected: true, paused: false, cursor: 0, pendingConflicts: 0, peers: [] })
  };

  const environment: Environment = {
    serviceUrl: "https://www.getcrosscode.dev",
    createService: () => service,
    signIn: async () => {
      calls.signIn += 1;
      return SESSION;
    },
    createDaemon: () => daemon,
    // The real installer, not a stub: whether installing twice duplicates anything is the
    // question, so it has to be the code that writes the files.
    installAgentSurface: (repoRoot) => installAgentSurface(repoRoot)
  };
  return { environment, calls };
}

describe("crosscode start", () => {
  it("configures a fresh checkout end to end", async () => {
    const root = await checkout();
    const { environment, calls } = stubEnvironment();

    const result = await setup(root, environment);

    expect(result).toMatchObject({ repoRoot: root, repo: "acme/app", projectId: "project-1", signedIn: "just-now", project: "created" });
    expect(calls).toEqual({ createProject: 1, redeemInvite: 0, signIn: 1, daemonStart: 1 });
    // What it wrote is the contract's own shape, not a CLI-private one.
    expect(syncDaemonConfigSchema.parse(JSON.parse(await readFile(await configPath(root), "utf8")))).toMatchObject({
      projectId: "project-1",
      repo: "acme/app"
    });
    expect(result.agent).toMatchObject({ mcp: { changed: true }, skill: { changed: true }, hooks: { changed: true } });
  });

  // The property the invite flow depends on: the person sending the link has already run
  // start, and the person receiving it is told to run the same command.
  it("is idempotent -- one project, one daemon, no duplicated MCP, skill, or hook install", async () => {
    const root = await checkout();
    const { environment, calls } = stubEnvironment();

    const first = await setup(root, environment);
    const second = await setup(root, environment);

    expect(calls).toEqual({ createProject: 1, redeemInvite: 0, signIn: 1, daemonStart: 1 });
    expect(second.projectId).toBe(first.projectId);
    expect(second).toMatchObject({ signedIn: "already", project: "existing", daemon: { alreadyRunning: true } });
    expect(second.agent).toMatchObject({ mcp: { changed: false }, skill: { changed: false }, hooks: { changed: false } });

    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["crosscode"]);
    const settings = JSON.parse(await readFile(join(root, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  // The hook has to reach the entrypoint that reads the tool payload on stdin and can exit 2.
  // `crosscode status` cannot: it ignores stdin and prints CLI status JSON.
  it("installs a hook that runs the pre-edit hook entrypoint", async () => {
    const root = await checkout();
    const { environment } = stubEnvironment();

    await setup(root, environment);

    const settings = JSON.parse(await readFile(join(root, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse[0].hooks).toEqual([{ type: "command", command: "crosscode-mcp hook" }]);
  });

  // 0.1.0 installed a hook pointing at `crosscode status --json`, which never blocks an edit.
  // Upgrading has to repair that entry rather than skip it as "already installed".
  it("repairs the broken hook a previous version installed", async () => {
    const root = await checkout();
    const { environment } = stubEnvironment();
    const settingsPath = join(root, ".claude", "settings.json");
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "./scripts/audit.sh" }] },
          { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "crosscode status --json" }] }
        ]
      }
    }));

    const result = await setup(root, environment);

    expect(result.agent).toMatchObject({ hooks: { changed: true } });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "./scripts/audit.sh" }] },
      { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "crosscode-mcp hook" }] }
    ]);
  });

  it("refuses a checkout that is not a git repository", async () => {
    const bare = await mkdtemp(join(tmpdir(), "crosscode-setup-"));
    directories.push(bare);
    const { environment } = stubEnvironment();

    await expect(setup(bare, environment)).rejects.toMatchObject({ code: "NOT_A_GIT_REPOSITORY" });
  });
});

describe("crosscode join <code>", () => {
  it("redeems the code and leaves the checkout configured exactly as start would", async () => {
    const root = await checkout();
    const { environment, calls } = stubEnvironment();

    const result = await setup(root, environment, { code: "CC-7F3A-9C2E" });

    expect(calls).toEqual({ createProject: 0, redeemInvite: 1, signIn: 1, daemonStart: 1 });
    expect(result).toMatchObject({ projectId: "project-from-invite", repo: "acme/app", project: "joined", daemon: { alreadyRunning: false } });
    expect(await readConfig(root)).toMatchObject({ projectId: "project-from-invite", repo: "acme/app", service: { session: SESSION } });
    expect(result.agent).toMatchObject({ mcp: { changed: true }, skill: { changed: true }, hooks: { changed: true } });
  });

  // Syncing one repo's working tree into another's is the worst thing this command could do.
  it("refuses a code redeemed in the wrong checkout, and says how to fix it", async () => {
    const root = await checkout("acme/other");
    const { environment } = stubEnvironment();

    await expect(setup(root, environment, { code: "CC-7F3A-9C2E" })).rejects.toMatchObject({
      code: "WRONG_REPOSITORY",
      hint: expect.stringContaining("git clone git@github.com:acme/app.git")
    });
  });
});

/**
 * The service is not written yet, so what is asserted here is that the CLI speaks the
 * contract: the route, and a response parsed with the contract's own schema.
 */
describe("the service client speaks the contract", () => {
  it("redeems an invite at POST /v1/invites/:code/redeem", async () => {
    const seen: { url: string; method?: string; authorization?: string }[] = [];
    const service = httpSyncService("https://service.example", "token", (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), method: init.method, authorization: (init.headers as Record<string, string>).authorization });
      return Response.json({ projectId: "p1", repo: "acme/app", cloneCommand: "git clone git@github.com:acme/app.git && cd app" });
    }) as unknown as typeof fetch);

    await service.redeemInvite("CC-7F3A-9C2E");

    expect(seen).toEqual([{ url: "https://service.example/v1/invites/CC-7F3A-9C2E/redeem", method: "POST", authorization: "Bearer token" }]);
  });

  it("rejects a response that does not match the contract rather than passing it on", async () => {
    const service = httpSyncService("https://service.example", "token", (async () => Response.json({ projectId: "p1" })) as unknown as typeof fetch);

    await expect(service.redeemInvite("CC-7F3A-9C2E")).rejects.toThrow();
  });

  it("reports an expired sign-in as its own code", async () => {
    const service = httpSyncService("https://service.example", "token", (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch);

    await expect(service.createInvite({ projectId: "p1", expiresInHours: 168 })).rejects.toMatchObject({ code: "SERVICE_FORBIDDEN" });
  });
});
