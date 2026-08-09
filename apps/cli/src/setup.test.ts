import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { syncDaemonConfigSchema } from "../../../packages/protocol/src/sync.js";
// The daemon's own reader, imported deliberately: the point of the test below is that the
// two sides agree, so asserting it with the CLI's helper alone would prove nothing.
import { readSyncConfig, syncConfigPath } from "../../daemon/src/sync-config.js";
import { installAgentSurface } from "./agent-surface.js";
import { configPath, readConfig, writeConfig } from "./config.js";
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
/** What the service says is published, and what a fresh account therefore owes. */
const LEGAL_DOCUMENTS = [
  { document: "terms", version: "2026-08-01", url: "/docs/terms.html" },
  { document: "privacy", version: "2026-08-01", url: "/docs/privacy-policy.html" }
];

function stubEnvironment(overrides: { service?: Partial<SyncService>; refreshSession?: Environment["refreshSession"] } = {}) {
  const calls = { createProject: 0, redeemInvite: 0, signIn: 0, daemonStart: 0, refreshSession: 0 };
  /**
   * The terms half, counted separately so the assertions above keep saying exactly what they
   * said: `calls` is the "did start do this twice" ledger.
   */
  const legal = { prompts: [] as string[], accepted: [] as Record<string, string>[] };
  let outstanding = ["terms", "privacy"];
  let noticeSeen = false;
  let daemonRunning = false;

  const service: SyncService = {
    legalStatus: async () => ({ accepted: {}, outstanding, documents: LEGAL_DOCUMENTS }),
    acceptTerms: async (documents) => {
      legal.accepted.push(documents);
      outstanding = [];
    },
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
      return { session: SESSION, githubToken: "gho_test" };
    },
    refreshSession: async (session) => {
      calls.refreshSession += 1;
      return overrides.refreshSession ? overrides.refreshSession(session) : session;
    },
    createDaemon: () => daemon,
    // The real installer, not a stub: whether installing twice duplicates anything is the
    // question, so it has to be the code that writes the files.
    installAgentSurface: (repoRoot) => installAgentSurface(repoRoot),
    // Stands in for notice.ts's flag file: the first-run notice is shown once per machine,
    // and "the terms changed" is shown whenever the service says something is outstanding.
    confirmTerms: async ({ kind }) => {
      if (kind === "first-run" && noticeSeen) return false;
      legal.prompts.push(kind);
      noticeSeen = true;
      return true;
    }
  };
  return { environment, calls, legal };
}

describe("crosscode start", () => {
  it("configures a fresh checkout end to end", async () => {
    const root = await checkout();
    const { environment, calls } = stubEnvironment();

    const result = await setup(root, environment);

    expect(result).toMatchObject({ repoRoot: root, repo: "acme/app", projectId: "project-1", signedIn: "just-now", project: "created" });
    expect(calls).toEqual({ createProject: 1, redeemInvite: 0, signIn: 1, daemonStart: 1, refreshSession: 0 });
    // What it wrote is the contract's own shape, not a CLI-private one.
    expect(syncDaemonConfigSchema.parse(JSON.parse(await readFile(await configPath(root), "utf8")))).toMatchObject({
      projectId: "project-1",
      repo: "acme/app"
    });
    expect(result.agent).toMatchObject({ mcp: { changed: true }, skill: { changed: true }, agents: { changed: true }, hooks: { changed: true } });
  });

  /**
   * The assertion above checks the CLI wrote a valid config *at the path the CLI chooses*,
   * which is exactly half the question and the half that cannot fail. The daemon is the
   * consumer, and for one release it read `crosscode/sync.json` while the CLI wrote
   * `crosscode/config.json` -- so `start` signed in, wrote the config, spawned a daemon that
   * exited with "this checkout is not joined to a Crosscode project", and failed with
   * DAEMON_DID_NOT_START. Both sides were individually correct and separately tested.
   */
  it("writes the config where the daemon actually looks for it", async () => {
    const root = await checkout();
    const { environment } = stubEnvironment();

    await setup(root, environment);

    expect(await syncConfigPath(root)).toBe(await configPath(root));
    expect(await readSyncConfig(root)).toMatchObject({ projectId: "project-1", repo: "acme/app" });
  });

  /**
   * The dead end this closes. Supabase access tokens last an hour and refresh tokens are
   * spent on first use, so a checkout comes back to a session that is on disk and useless.
   * The daemon died on it saying "run `crosscode start`"; `start` saw a session, said
   * "Already signed in for this checkout", and started the same doomed daemon again. There
   * was no way out of that loop from inside the CLI.
   */
  it("signs in again when the stored session cannot be refreshed", async () => {
    const root = await checkout();
    const { environment, calls } = stubEnvironment({ refreshSession: async () => undefined });
    await setup(root, environment);
    await writeConfig(root, { ...(await readSyncConfig(root)), service: { url: environment.serviceUrl, session: { ...SESSION, expiresAt: "2020-01-01T00:00:00.000Z" } } });

    const second = await setup(root, environment);

    expect(calls.refreshSession).toBe(1);
    expect(second.signedIn).toBe("just-now");
    expect(calls.signIn).toBe(2);
  });

  it("reuses a session it can still refresh, without a second sign-in", async () => {
    const root = await checkout();
    const refreshed = { ...SESSION, accessToken: "refreshed", expiresAt: "2031-01-01T00:00:00.000Z" };
    const { environment, calls } = stubEnvironment({ refreshSession: async () => refreshed });
    await setup(root, environment);
    await writeConfig(root, { ...(await readSyncConfig(root)), service: { url: environment.serviceUrl, session: { ...SESSION, expiresAt: "2020-01-01T00:00:00.000Z" } } });

    const second = await setup(root, environment);

    expect(second.signedIn).toBe("already");
    expect(calls.signIn).toBe(1);
    // The refreshed token is what the daemon will be started with, so it has to be stored.
    expect((await readSyncConfig(root)).service.session?.accessToken).toBe("refreshed");
  });

  // The property the invite flow depends on: the person sending the link has already run
  // start, and the person receiving it is told to run the same command.
  it("is idempotent -- one project, one daemon, no duplicated MCP, skill, AGENTS.md, or hook install", async () => {
    const root = await checkout();
    const { environment, calls } = stubEnvironment();

    const first = await setup(root, environment);
    const second = await setup(root, environment);

    expect(calls).toEqual({ createProject: 1, redeemInvite: 0, signIn: 1, daemonStart: 1, refreshSession: 0 });
    expect(second.projectId).toBe(first.projectId);
    expect(second).toMatchObject({ signedIn: "already", project: "existing", daemon: { alreadyRunning: true } });
    expect(second.agent).toMatchObject({ mcp: { changed: false }, skill: { changed: false }, agents: { changed: false }, hooks: { changed: false } });

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

  /**
   * The CLI's half of the acceptance record. The notice is shown, the person presses a key,
   * and *that* is what gets written down -- at the versions the service says are current,
   * because the CLI never composes a version of its own.
   */
  it("records the acceptance the notice asked for, once, at the version the service published", async () => {
    const root = await checkout();
    const { environment, legal } = stubEnvironment();

    await setup(root, environment);
    await setup(root, environment);

    expect(legal.prompts).toEqual(["first-run"]);
    expect(legal.accepted).toEqual([{ terms: "2026-08-01", privacy: "2026-08-01" }]);
  });

  // Terms §11: a material change means accepting again. The notice is per machine, so a
  // machine that has already seen it still has to be shown the change before it is recorded.
  it("shows the notice again when the service says something is outstanding, before recording it", async () => {
    const root = await checkout();
    const { environment, legal } = stubEnvironment();
    await setup(root, environment);

    let outstanding = ["terms"];
    const existing = environment.createService;
    environment.createService = (accessToken) => ({
      ...existing(accessToken),
      legalStatus: async () => ({
        accepted: { terms: "2025-01-01", privacy: "2026-08-01" },
        outstanding,
        documents: LEGAL_DOCUMENTS
      }),
      acceptTerms: async (documents) => {
        legal.accepted.push(documents);
        outstanding = [];
      }
    });

    await setup(root, environment);

    expect(legal.prompts).toEqual(["first-run", "changed"]);
    expect(legal.accepted).toHaveLength(2);
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

    expect(calls).toEqual({ createProject: 0, redeemInvite: 1, signIn: 1, daemonStart: 1, refreshSession: 0 });
    expect(result).toMatchObject({ projectId: "project-from-invite", repo: "acme/app", project: "joined", daemon: { alreadyRunning: false } });
    expect(await readConfig(root)).toMatchObject({ projectId: "project-from-invite", repo: "acme/app", service: { session: SESSION } });
    expect(result.agent).toMatchObject({ mcp: { changed: true }, skill: { changed: true }, agents: { changed: true }, hooks: { changed: true } });
  });

  /**
   * The one place `join` is deliberately not idempotent. Redemption has to prove to GitHub
   * that this person can read the repository, and the token that proves it is Supabase's
   * `provider_token` -- issued to the browser at sign-in and never persisted, so a stored
   * session cannot carry one. Reusing the stored session would mean reaching the redeem
   * call with nothing to offer and being refused.
   */
  it("signs in again in a checkout that is already signed in, because redeeming needs a fresh GitHub token", async () => {
    const root = await checkout();
    const { environment, calls } = stubEnvironment();
    const redeemedWith: (string | undefined)[] = [];
    let outstanding = ["terms", "privacy"];
    environment.createService = () => ({
      createProject: async () => { throw new Error("not used"); },
      createInvite: async () => { throw new Error("not used"); },
      legalStatus: async () => ({ accepted: {}, outstanding, documents: LEGAL_DOCUMENTS }),
      acceptTerms: async () => { outstanding = []; },
      redeemInvite: async (_code: string, githubToken: string) => {
        calls.redeemInvite += 1;
        redeemedWith.push(githubToken);
        return { projectId: "project-from-invite", repo: "acme/app", cloneCommand: "git clone git@github.com:acme/app.git && cd app" };
      }
    });

    await setup(root, environment, { code: "CC-7F3A-9C2E" });
    const second = await setup(root, environment, { code: "CC-7F3A-9C2E" });

    expect(calls.signIn).toBe(2);
    expect(second.signedIn).toBe("just-now");
    expect(redeemedWith).toEqual(["gho_test", "gho_test"]);
  });

  it("refuses to redeem at all when the sign-in produced no GitHub token, rather than being denied by the service", async () => {
    const root = await checkout();
    const { environment, calls } = stubEnvironment();
    environment.signIn = async () => {
      calls.signIn += 1;
      return { session: SESSION, githubToken: undefined };
    };

    await expect(setup(root, environment, { code: "CC-7F3A-9C2E" })).rejects.toMatchObject({ code: "SIGN_IN_FAILED" });
    expect(calls.redeemInvite).toBe(0);
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
    const seen: { url: string; method?: string; authorization?: string; github?: string }[] = [];
    const service = httpSyncService("https://service.example", "token", (async (url: URL, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      seen.push({ url: String(url), method: init.method, authorization: headers.authorization, github: headers["x-crosscode-github-token"] });
      return Response.json({ ok: true, data: { projectId: "p1", repo: "acme/app", cloneCommand: "git clone git@github.com:acme/app.git && cd app" } });
    }) as unknown as typeof fetch);

    await service.redeemInvite("CC-7F3A-9C2E", "gho_test");

    // The GitHub token rides in its own header: the service asks GitHub whether this
    // person can read the repository before it lets them into the room.
    expect(seen).toEqual([{
      url: "https://service.example/v1/invites/CC-7F3A-9C2E/redeem",
      method: "POST",
      authorization: "Bearer token",
      github: "gho_test"
    }]);
  });

  it("rejects a response that does not match the contract rather than passing it on", async () => {
    const service = httpSyncService("https://service.example", "token", (async () => Response.json({ ok: true, data: { projectId: "p1" } })) as unknown as typeof fetch);

    await expect(service.redeemInvite("CC-7F3A-9C2E", "gho_test")).rejects.toThrow();
  });

  it("reports an expired sign-in as its own code", async () => {
    const service = httpSyncService("https://service.example", "token", (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch);

    await expect(service.createInvite({ projectId: "p1", expiresInHours: 168 })).rejects.toMatchObject({ code: "SERVICE_FORBIDDEN" });
  });
});
