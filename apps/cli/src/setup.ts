import { basename } from "node:path";
import { discoverRepository, remoteUrl } from "@crosscode/git";
import type { SyncDaemonConfig } from "../../../packages/protocol/src/sync.js";
import { githubSignIn, type SignIn } from "./auth.js";
import { installAgentSurface, type AgentSurface } from "./agent-surface.js";
import { readConfig, writeConfig } from "./config.js";
import { localDaemon, type DaemonControl } from "./daemon.js";
import { CliError } from "./errors.js";
import { httpSyncService, type SyncService } from "./service.js";
import { SERVICE_URL } from "./version.js";

/**
 * `crosscode start` -- the whole of setup, and the only thing between a stranger and a
 * running, synced daemon. `crosscode join <code>` is the same pipeline with one extra step
 * in front of it, which is why they share this module rather than each doing four fifths of
 * the work.
 *
 * Every step is a no-op when it is already satisfied, so running `start` twice reports state
 * instead of producing a second project, a second daemon, or a duplicated MCP entry. That
 * property is the point of the command, not a nicety: the invite link tells a new teammate
 * to run it, and the person who sent the link has already run it.
 */

/** Every seam onto another workstream, in one place. Tests substitute this whole object. */
export type Environment = {
  serviceUrl: string;
  createService(accessToken: string): SyncService;
  signIn: SignIn;
  createDaemon(repoRoot: string): DaemonControl;
  installAgentSurface(repoRoot: string): Promise<AgentSurface>;
};

export function defaultEnvironment(): Environment {
  return {
    serviceUrl: SERVICE_URL,
    createService: (accessToken) => httpSyncService(SERVICE_URL, accessToken),
    signIn: githubSignIn(),
    createDaemon: (repoRoot) => localDaemon(repoRoot),
    installAgentSurface: (repoRoot) => installAgentSurface(repoRoot)
  };
}

export type SetupOptions = {
  /** Set by `join`: redeem this invite before configuring the checkout. */
  code?: string;
  /** false for a shell with no browser: print the sign-in URL instead of opening it. */
  openBrowser?: boolean;
  /** Progress for a human, on stderr, so `--json` stays a single parseable line. */
  report?: (line: string) => void;
};

export type SetupResult = {
  repoRoot: string;
  repo: string;
  projectId: string;
  branch?: string;
  signedIn: "already" | "just-now";
  project: "existing" | "created" | "joined";
  daemon: { alreadyRunning: boolean; pid: number };
  agent: AgentSurface;
};

export async function setup(directory: string, environment: Environment, options: SetupOptions = {}): Promise<SetupResult> {
  const report = options.report ?? (() => {});
  const repository = await discoverRepository(directory).catch(() => undefined);
  if (!repository) {
    throw new CliError(
      "NOT_A_GIT_REPOSITORY",
      "Crosscode runs inside a Git repository",
      "cd into your project first. Crosscode syncs one checkout at a time, and git is where it keeps the state both sides agreed on."
    );
  }
  const localRepo = await repoSlug(repository.root);

  const existing = await readConfig(repository.root);
  const session = existing?.service.session;
  // Redeeming an invite needs the invitee's own GitHub OAuth token, and a stored session
  // does not carry one: Supabase issues it to the browser at sign-in and never persists it,
  // so it exists for exactly as long as the handshake that produced it. `join` therefore
  // signs in even in a checkout that is already signed in, rather than failing at the
  // redeem call with nothing to offer.
  const reuseSession = session && !options.code;
  if (reuseSession) report("Already signed in for this checkout.");
  const signedIn = reuseSession
    ? undefined
    : await environment.signIn({ serviceUrl: environment.serviceUrl, openBrowser: options.openBrowser !== false, report });
  const activeSession = signedIn?.session ?? session!;

  const service = environment.createService(activeSession.accessToken);
  const { projectId, repo, origin } = await resolveProject(service, existing, localRepo, repository.root, options.code, signedIn?.githubToken, report);

  const config: SyncDaemonConfig = { projectId, repo, service: { url: environment.serviceUrl, session: activeSession } };
  await writeConfig(repository.root, config);

  const daemon = await environment.createDaemon(repository.root).start();
  report(daemon.alreadyRunning ? "A daemon is already running for this checkout." : "Daemon started; this checkout is syncing.");

  const agent = await environment.installAgentSurface(repository.root);
  report(agent.mcp.changed ? `Registered the crosscode MCP server in ${agent.mcp.path}.` : `The crosscode MCP server is already registered in ${agent.mcp.path}.`);
  report(agent.skill.changed ? `Installed the crosscode skill in ${agent.skill.path}.` : "The crosscode skill is already installed.");
  report(agent.hooks.changed ? `Installed the crosscode edit hook in ${agent.hooks.path}.` : "The crosscode edit hook is already installed.");

  return {
    repoRoot: repository.root,
    repo,
    projectId,
    branch: repository.branch,
    signedIn: reuseSession ? "already" : "just-now",
    project: origin,
    daemon,
    agent
  };
}

/**
 * Which project this checkout syncs, in the one order that keeps `start` idempotent:
 * an invite code wins, then whatever this checkout already chose, then a new project.
 *
 * The middle case is the idempotency: a configured checkout never calls `POST /v1/projects`
 * again, so a second `start` cannot mint a duplicate project even if the route is not
 * idempotent on the service's side.
 */
async function resolveProject(
  service: SyncService,
  existing: SyncDaemonConfig | undefined,
  localRepo: string,
  repoRoot: string,
  code: string | undefined,
  githubToken: string | undefined,
  report: (line: string) => void
): Promise<{ projectId: string; repo: string; origin: SetupResult["project"] }> {
  if (code) {
    if (!githubToken) {
      throw new CliError(
        "SIGN_IN_FAILED",
        "The GitHub sign-in did not return a token to check your access to the repository with",
        "Sign in again with `crosscode join <code>`. If it keeps happening, the sign-in page could not read your GitHub authorization."
      );
    }
    const redeemed = await service.redeemInvite(code, githubToken);
    // The invite is for a specific repo, and the point of the join page's verification is
    // that the invitee genuinely has access to it. Running `join` in the wrong checkout
    // would otherwise start syncing one repo's files into another's working tree.
    if (redeemed.repo !== localRepo) {
      throw new CliError(
        "WRONG_REPOSITORY",
        `This invite is for ${redeemed.repo}, but this checkout is ${localRepo}`,
        `Run this instead:\n${redeemed.cloneCommand}\ncrosscode join ${code}`
      );
    }
    report(`Joined ${redeemed.repo}.`);
    return { projectId: redeemed.projectId, repo: redeemed.repo, origin: "joined" };
  }

  if (existing) {
    report(`This checkout already syncs ${existing.repo}.`);
    return { projectId: existing.projectId, repo: existing.repo, origin: "existing" };
  }

  const project = await service.createProject({ name: basename(repoRoot), repo: localRepo });
  report(`Syncing ${project.repo}.`);
  return { projectId: project.id, repo: project.repo, origin: "created" };
}

/**
 * `owner/repo` from the origin remote -- the contract's project identity, and what decides
 * which room this checkout is in. Both the SSH and HTTPS spellings appear in the wild.
 */
export async function repoSlug(repoRoot: string): Promise<string> {
  const url = await remoteUrl(repoRoot);
  if (!url) {
    throw new CliError(
      "NO_ORIGIN_REMOTE",
      "This checkout has no `origin` remote, so there is no repository to sync against",
      "Add one with `git remote add origin git@github.com:owner/repo.git`, then run the command again."
    );
  }
  const match = /(?:[:/])([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match?.[1]) {
    throw new CliError("UNRECOGNISED_REMOTE", `Could not read an owner/repo out of the origin remote: ${url}`, "Crosscode identifies a project by its GitHub owner/repo.");
  }
  return match[1];
}
