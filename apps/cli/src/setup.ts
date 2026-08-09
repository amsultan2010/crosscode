import { basename } from "node:path";
import { discoverRepository, remoteUrl } from "@crosscode/git";
import type { SyncDaemonConfig } from "../../../packages/protocol/src/sync.js";
import { githubSignIn, type SignIn } from "./auth.js";
import { installAgentSurface, type AgentSurface } from "./agent-surface.js";
import { readConfig, writeConfig } from "./config.js";
import { localDaemon, type DaemonControl } from "./daemon.js";
import { CliError } from "./errors.js";
import { confirmTerms, type ConfirmKind } from "./notice.js";
import { httpSyncService, type SyncService } from "./service.js";
import { refreshStoredSession, type StoredSession } from "../../daemon/src/supabase-client.js";
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
  /** Trades a refresh token for a live one, or resolves undefined if it cannot. */
  refreshSession(session: StoredSession): Promise<StoredSession | undefined>;
  createDaemon(repoRoot: string): DaemonControl;
  installAgentSurface(repoRoot: string): Promise<AgentSurface>;
  /**
   * Shows the terms notice and waits for a keypress. Returns whether it prompted -- see
   * notice.ts, and see acceptTerms below for why the difference matters.
   */
  confirmTerms(options: { kind: ConfirmKind; assumeYes: boolean; report: (line: string) => void }): Promise<boolean>;
};

export function defaultEnvironment(): Environment {
  return {
    serviceUrl: SERVICE_URL,
    createService: (accessToken) => httpSyncService(SERVICE_URL, accessToken),
    signIn: githubSignIn(),
    refreshSession: (session) => refreshStoredSession(session).catch(() => undefined),
    createDaemon: (repoRoot) => localDaemon(repoRoot),
    installAgentSurface: (repoRoot) => installAgentSurface(repoRoot),
    confirmTerms: (options) => confirmTerms(options)
  };
}

export type SetupOptions = {
  /** Set by `join`: redeem this invite before configuring the checkout. */
  code?: string;
  /** false for a shell with no browser: print the sign-in URL instead of opening it. */
  openBrowser?: boolean;
  /** Progress for a human, on stderr, so `--json` stays a single parseable line. */
  report?: (line: string) => void;
  /** `--yes`: accept the terms from the command line, for CI and scripted installs. */
  assumeYes?: boolean;
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
  const assumeYes = options.assumeYes === true;
  // Before anything else, including before finding out whether this is even a repository:
  // what the notice describes is what the rest of this function sets in motion.
  const noticeShown = await environment.confirmTerms({ kind: "first-run", assumeYes, report });
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
  //
  // A stored session is only worth reusing if it still works. Supabase access tokens last
  // an hour and refresh tokens are spent on first use, so "there is a session on disk" and
  // "this checkout can talk to the service" are different questions. Answering the first
  // one left the user with no way out: the daemon died on the dead session telling them to
  // run `crosscode start`, and `start` said "Already signed in for this checkout" and
  // started the same doomed daemon again.
  const usable = session && !options.code ? await usableSession(session, environment) : undefined;
  if (usable) report("Already signed in for this checkout.");
  else if (session && !options.code) report("This checkout's sign-in has expired; signing in again.");
  const signedIn = usable
    ? undefined
    : await environment.signIn({ serviceUrl: environment.serviceUrl, openBrowser: options.openBrowser !== false, report });
  const activeSession = signedIn?.session ?? usable!;

  const service = environment.createService(activeSession.accessToken);
  await acceptTerms(service, environment, { assumeYes, noticeShown, report });
  const { projectId, repo, origin } = await resolveProject(service, existing, localRepo, repository.root, options.code, signedIn?.githubToken, report);

  const config: SyncDaemonConfig = { projectId, repo, service: { url: environment.serviceUrl, session: activeSession } };
  await writeConfig(repository.root, config);

  const daemon = await environment.createDaemon(repository.root).start();
  report(daemon.alreadyRunning ? "A daemon is already running for this checkout." : "Daemon started; this checkout is syncing.");

  const agent = await environment.installAgentSurface(repository.root);
  report(agent.mcp.changed ? `Registered the crosscode MCP server in ${agent.mcp.path}.` : `The crosscode MCP server is already registered in ${agent.mcp.path}.`);
  report(agent.skill.changed ? `Installed the crosscode skill in ${agent.skill.path}.` : "The crosscode skill is already installed.");
  report(agent.agents.changed ? `Installed the crosscode guidance in ${agent.agents.path}.` : "The crosscode guidance in AGENTS.md is already installed.");
  report(agent.hooks.changed ? `Installed the crosscode edit hook in ${agent.hooks.path}.` : "The crosscode edit hook is already installed.");

  return {
    repoRoot: repository.root,
    repo,
    projectId,
    branch: repository.branch,
    signedIn: usable ? "already" : "just-now",
    project: origin,
    daemon,
    agent
  };
}

/**
 * The stored session if it can still be used, refreshed first if it is close to expiring,
 * and undefined if the refresh token is spent or revoked -- in which case the only way
 * forward is signing in again, which is what the caller does.
 */
async function usableSession(session: StoredSession, environment: Environment): Promise<StoredSession | undefined> {
  if (Date.parse(session.expiresAt) - Date.now() > EXPIRY_MARGIN_MS) return session;
  return environment.refreshSession(session);
}

/** Refresh this far ahead of expiry, so setup never hands the daemon a token about to die. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Records this person's acceptance, but only of something they were actually shown.
 *
 * The service is asked what is outstanding rather than the CLI deciding: a fresh account
 * owes everything, an account whose stored version predates a change owes the changed
 * documents, and an account that is up to date owes nothing and is not asked. That last case
 * is what keeps `crosscode start` from re-recording an acceptance on every run.
 *
 * The notice is shown again when something is outstanding and this run did not already show
 * it -- which is exactly the "the terms changed since you last accepted" case. Recording
 * without showing anything would be the CLI agreeing on the user's behalf.
 */
async function acceptTerms(
  service: SyncService,
  environment: Environment,
  options: { assumeYes: boolean; noticeShown: boolean; report: (line: string) => void }
): Promise<void> {
  const status = await service.legalStatus();
  if (status.outstanding.length === 0) return;
  if (!options.noticeShown) {
    await environment.confirmTerms({ kind: "changed", assumeYes: options.assumeYes, report: options.report });
  }
  // Straight from the answer above: the version recorded is the version the service says is
  // current, and the service refuses anything else.
  await service.acceptTerms(Object.fromEntries(status.documents.map((document) => [document.document, document.version])));
  options.report("Recorded your acceptance of the Crosscode terms and privacy policy.");
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
