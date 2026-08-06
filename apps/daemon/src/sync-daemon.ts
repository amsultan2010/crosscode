import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { relative } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import {
  pauseRequestSchema,
  resolveConflictRequestSchema,
  syncStatusSchema,
  type Change,
  type Conflict,
  type FileVersion,
  type Presence,
  type SyncDaemonConfig,
  type SyncStatus
} from "@crosscode/protocol";
import { currentBranch, headCommit, inProgressOperation, isAncestor, repositoryRoot, SyncEngine, type EngineOptions, type GitOperation } from "@crosscode/sync";
import {
  assertNotAlreadyRunning,
  daemonDescriptorSchema,
  readSyncConfig,
  readSyncState,
  removeOwnedDescriptor,
  writeDaemonDescriptor,
  writeSyncState,
  type DaemonDescriptor
} from "./sync-config.js";
import { SyncServiceClient } from "./sync-service-client.js";

/**
 * The plumbing around the engine: a watcher, a socket, a cursor, and a loopback API.
 *
 * Everything that decides *what happens to a file* lives in @crosscode/sync. What lives
 * here is when to ask: debounce a burst of writes into one publish, hold everything while
 * git is mid-rebase, catch up from the cursor after a reconnect, and let the MCP server
 * and the CLI see conflicts.
 */

export type SyncDaemonOptions = {
  /** Per-file quiet period before a change is published. */
  debounceMs?: number;
  /** How often the batched shadow tree is written to its ref. */
  flushMs?: number;
  /** How often changes queued behind a hot file are retried. */
  deferralMs?: number;
  /** How often the daemon looks for a branch switch or an in-progress git operation. */
  gitPollMs?: number;
  port?: number;
  actor?: string;
  engine?: EngineOptions;
  /** Off in tests that drive the engine directly. */
  stream?: boolean;
};

const IGNORED = /(^|\/)(\.git|node_modules|dist|build|coverage|\.next|target|vendor)(\/|$)/;

/**
 * Roots with a live daemon in *this* process. The on-disk descriptor catches a second
 * daemon in another process; it cannot catch two in the same one, where the pid matches.
 */
const running = new Set<string>();

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class SyncDaemon {
  private watcher?: FSWatcher;
  private server?: Server;
  private descriptor?: DaemonDescriptor;
  private timers: NodeJS.Timeout[] = [];
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  private readonly dirty = new Set<string>();
  /** Changes that arrived while sync was paused, applied in order when it resumes. */
  private readonly held: Change[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private peers: Presence[] = [];
  private operation: GitOperation | undefined;
  private userPaused = false;
  private stopped = false;
  private cursor = 0;
  private lastError: string | undefined;
  /** Set while a peer is on a commit this checkout does not contain. See reviewPeerHeads. */
  private headNotice: string | undefined;
  /** The (our HEAD, peers' HEADs) the notice above was worked out from. */
  private reviewedHeads = "";

  private constructor(
    readonly root: string,
    readonly config: SyncDaemonConfig,
    readonly engine: SyncEngine,
    private client: SyncServiceClient,
    private branch: string,
    private head: string | null,
    private readonly options: Required<Pick<SyncDaemonOptions, "debounceMs" | "flushMs" | "deferralMs" | "gitPollMs">> & SyncDaemonOptions
  ) {}

  static async start(directory: string, options: SyncDaemonOptions = {}): Promise<SyncDaemon> {
    const root = await repositoryRoot(directory);
    if (running.has(root)) throw new Error("A Crosscode daemon is already running for this worktree");
    await assertNotAlreadyRunning(root);
    running.add(root);
    const config = await readSyncConfig(root);
    const state = await readSyncState(root);
    const branch = await currentBranch(root);
    const engine = await SyncEngine.open(root, options.engine ?? {});
    const client = new SyncServiceClient(config, branch, state.branch === branch ? state.replicaId : undefined);
    const daemon = new SyncDaemon(root, config, engine, client, branch, await headCommit(root), {
      debounceMs: options.debounceMs ?? 300,
      flushMs: options.flushMs ?? 2_000,
      deferralMs: options.deferralMs ?? 1_000,
      gitPollMs: options.gitPollMs ?? 1_000,
      ...options
    });
    daemon.cursor = state.branch === branch ? state.cursor : 0;
    try { await daemon.open(); }
    catch (error) { running.delete(root); await daemon.stop().catch(() => {}); throw error; }
    return daemon;
  }

  private async open(): Promise<void> {
    this.operation = await inProgressOperation(this.root);
    await this.startHttp();
    await this.startWatcher();
    if (this.options.stream ?? true) await this.startStream();
    this.timers.push(interval(() => void this.enqueue(() => this.engine.flush()), this.options.flushMs));
    this.timers.push(interval(() => void this.enqueue(() => this.retryDeferred()), this.options.deferralMs));
    this.timers.push(interval(() => void this.enqueue(() => this.observeGit()), this.options.gitPollMs));
    // Anything edited while the daemon was down is still a change the peers need.
    await this.enqueue(() => this.publishAll());
  }

  // ---- serialization ----------------------------------------------------

  /**
   * One task at a time. The engine mutates a shadow tree and a working tree; a publish
   * interleaved with an apply would compute a diff against a state neither of them meant.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(() => undefined, (error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Crosscode sync error: ${this.lastError}\n`);
    });
    return result;
  }

  async drain(): Promise<void> {
    await this.tail;
  }

  // ---- watching ---------------------------------------------------------

  private async startWatcher(): Promise<void> {
    const watcher = chokidar.watch(this.root, {
      ignored: (path) => IGNORED.test(relative(this.root, path).split("\\").join("/")),
      ignoreInitial: true
    });
    const settle = (absolute: string) => {
      const path = relative(this.root, absolute).split("\\").join("/");
      if (!path || IGNORED.test(path) || !this.engine.watchable(path)) return;
      // Mark the file hot now, not after the debounce: the hot window is about when the
      // user last touched the file, and this is the moment we learned they did. It also
      // filters our own writes, which must never make their own file hot.
      void this.engine.observeChange(path).then((isUser) => {
        if (!isUser || this.stopped) return;
        this.dirty.add(path);
        const existing = this.debounce.get(path);
        if (existing) clearTimeout(existing);
        this.debounce.set(path, setTimeout(() => {
          this.debounce.delete(path);
          void this.enqueue(() => this.publishDirty());
        }, this.options.debounceMs).unref());
      }).catch(() => {});
    };
    watcher.on("add", settle).on("change", settle).on("unlink", settle);
    await new Promise<void>((ready) => watcher.once("ready", ready));
    this.watcher = watcher;
  }

  // ---- publishing -------------------------------------------------------

  get paused(): boolean {
    return this.userPaused || this.operation !== undefined;
  }

  private async publishDirty(): Promise<void> {
    if (this.paused || !this.dirty.size) return;
    await this.trackHead();
    const paths = [...this.dirty];
    this.dirty.clear();
    await this.send(await this.engine.publish(paths));
  }

  private async publishAll(): Promise<void> {
    if (this.paused) return;
    await this.trackHead();
    this.dirty.clear();
    await this.send(await this.engine.publishAll());
  }

  private async send(versions: FileVersion[]): Promise<void> {
    if (!versions.length) return;
    try {
      this.cursor = Math.max(this.cursor, await this.client.publish(versions));
      await this.persist();
      await this.announce(versions.map((version) => version.path));
    } catch (error) {
      // The shadow has already advanced, so re-publishing is not as simple as retrying the
      // request: the next full sweep is what re-derives whatever did not land. Recording
      // the failure keeps it visible in `crosscode status`.
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  // ---- receiving --------------------------------------------------------

  private async startStream(): Promise<void> {
    if (!this.client.id) {
      const registered = await this.client.register();
      // A cursor from the service beats ours only when we have none: it knows where the
      // history starts, we know where we got to.
      if (!this.cursor) this.cursor = registered.cursor;
      await this.persist();
    }
    this.client.start({
      onChange: (change) => { void this.enqueue(() => this.receive(change)); },
      onPresence: (peers) => {
        this.peers = peers.filter((peer) => peer.replicaId !== this.client.id);
        void this.enqueue(() => this.reviewPeerHeads());
      },
      // Announce on every (re)subscribe: a peer that joins after we committed would
      // otherwise never learn our HEAD, since presence is only sent when something happens.
      onConnected: () => { void this.enqueue(async () => { await this.catchUp(); await this.announce(); }); },
      onDisconnected: () => {},
      // The stream's fallback. Same catch-up, on a timer instead of on a subscribe, so a
      // checkout that can never open a socket still receives its peers' edits. Presence is
      // not sent here: it lives only on the socket, so the room goes quiet but not blind.
      onPoll: () => this.enqueue(() => this.catchUp())
    }, () => this.cursor);
  }

  private async receive(change: Change): Promise<void> {
    if (change.replicaId === this.client.id) { this.advance(change.sequence); return; }
    if (change.branch !== this.branch) return;
    if (this.paused) { this.held.push(change); return; }
    await this.apply(change);
  }

  private async apply(change: Change): Promise<void> {
    let result = await this.engine.receive(change.version, { peer: change.replicaId });
    if (result.outcome === "catchup") {
      // The sender built on a blob we have never held, so we are genuinely behind. Fill
      // the gap from the cursor and retry once; a second miss has to surface rather than
      // loop, which is what allowCatchup: false forces.
      await this.catchUp();
      result = await this.engine.receive(change.version, { peer: change.replicaId, allowCatchup: false });
    }
    // A merge leaves this replica holding bytes neither side has seen: ours and theirs
    // combined. Publishing it once is what tells the peer we agree, and the peer answers
    // with a no-op because it already has those exact bytes.
    if (result.outcome === "merge") await this.send(await this.engine.publish([change.version.path]));
    this.advance(change.sequence);
    await this.persist();
  }

  private advance(sequence: number): void {
    this.cursor = Math.max(this.cursor, sequence);
  }

  /**
   * Drains everything the service has after our cursor. Runs on every (re)subscribe, which
   * is what turns a dropped socket into a gap that closes itself.
   */
  private async catchUp(): Promise<void> {
    for (let page = 0; page < 100; page += 1) {
      const response = await this.client.changes(this.cursor);
      if ("status" in response) {
        // Our cursor points into history retention has deleted. Nothing can fill that gap
        // incrementally, so adopt the watermark and re-publish our whole working state:
        // every peer then merges us in from content rather than from a change we lost.
        process.stderr.write(`Crosscode: sync history before sequence ${response.resyncFrom} is no longer retained (${response.retentionDays} days); resynchronizing from full content.\n`);
        this.cursor = response.resyncFrom;
        await this.persist();
        await this.engine.refreshTracked();
        await this.send(await this.engine.publishAll());
        return;
      }
      for (const change of response.changes) {
        if (change.sequence <= 0) continue;
        if (change.replicaId === this.client.id || change.branch !== this.branch) { this.advance(change.sequence); continue; }
        await this.apply(change);
      }
      this.cursor = Math.max(this.cursor, response.cursor);
      if (response.changes.length === 0) break;
    }
    await this.persist();
  }

  private async retryDeferred(): Promise<void> {
    if (this.paused) return;
    const results = await this.engine.retryDeferred();
    const merged = results.filter((result) => result.outcome === "merge").map((result) => result.path);
    // Whatever was queued behind the hot window is now applied, so the path can publish
    // again -- both the merge and any local edit that was held back with it.
    const paths = new Set([...merged, ...results.map((result) => result.path)]);
    if (paths.size) await this.send(await this.engine.publish(paths));
  }

  // ---- git transitions --------------------------------------------------

  /**
   * Auto-pause during a rebase, merge, or bisect, and resync when it finishes. A rebase
   * rewrites the working tree once per commit; publishing those would broadcast a dozen
   * intermediate states nobody asked for.
   *
   * Also where a plain `git commit` or `git pull` on the branch we are already on is
   * noticed: HEAD moves and neither the branch check nor the operation check fires, so
   * without trackHead the shadow would stay pointed at a tree that no longer describes
   * what is committed.
   */
  private async observeGit(): Promise<void> {
    const operation = await inProgressOperation(this.root);
    const branch = await currentBranch(this.root);
    const wasBusy = this.operation !== undefined;
    this.operation = operation;

    if (branch !== this.branch) {
      // A different branch is a different room, and the working tree it left behind has
      // nothing to do with what we had agreed. Start over on the new one.
      this.branch = branch;
      await this.engine.resetToHead();
      this.head = await headCommit(this.root);
      this.held.length = 0;
      this.cursor = 0;
      this.headNotice = undefined;
      this.reviewedHeads = "";
      this.client.stop();
      this.client = new SyncServiceClient(this.config, branch);
      if (this.options.stream ?? true) await this.startStream();
      await this.publishAll();
      return;
    }

    await this.trackHead();
    if (wasBusy && !operation) await this.resume();
  }

  /**
   * Same-branch HEAD move: rebase the agreed state onto the new commit and tell the peers
   * where we are now.
   *
   * Deliberately *not* engine.resetToHead(). A commit changes what is in history, not what
   * the peers agreed to hold uncommitted, so the agreed blobs survive and so does
   * everything in flight -- see SyncEngine.rebaseOntoHead.
   *
   * Called before every publish as well as from the poll, because the poll is a second
   * behind: `git pull` rewrites files, the watcher debounce is shorter than the poll
   * interval, and publishing that burst before noticing the move is exactly how committed
   * bytes would be pushed at a peer who has not pulled.
   */
  private async trackHead(): Promise<boolean> {
    const head = await headCommit(this.root);
    if (head === this.head) return false;
    const previous = this.head;
    this.head = head;
    await this.engine.rebaseOntoHead(previous);
    // Presence is the only thing on the wire that can carry this: our peers' checkouts are
    // now behind ours, and nothing else would ever tell them.
    await this.announce();
    // Our own move can also be the pull that clears a notice, so re-read it from here
    // rather than waiting for a peer to say something.
    await this.reviewPeerHeads();
    return true;
  }

  /** Tells the room where this checkout is. Silent when there is no stream to say it on. */
  private async announce(paths: string[] = []): Promise<void> {
    if (!this.client.id || !this.client.streaming) return;
    await this.client.presence(paths, this.options.actor ?? "you", this.head ?? undefined).catch(() => {});
  }

  /**
   * Works out whether any peer has committed something this checkout does not have.
   *
   * A peer's HEAD we already contain is a peer that is behind us, and their own daemon is
   * the one that tells them. Anything else -- a commit that is not an ancestor of ours, or
   * one this repository has never heard of because it was never fetched -- means their
   * branch has moved somewhere we can only reach by pulling.
   */
  private async reviewPeerHeads(): Promise<void> {
    // Presence arrives on every publish from every peer, and the answer only changes when
    // one of the commits does. Without this, a busy room costs a `merge-base` per keystroke.
    const signature = [this.head, ...this.peers.map((peer) => `${peer.replicaId}@${peer.head ?? ""}`).sort()].join("|");
    if (signature === this.reviewedHeads) return;
    this.reviewedHeads = signature;

    const ahead: Presence[] = [];
    for (const peer of this.peers) {
      if (!peer.head || peer.head === this.head) continue;
      if (this.head && await isAncestor(this.root, peer.head, this.head)) continue;
      ahead.push(peer);
    }
    this.headNotice = ahead.length ? headMoveNotice(ahead, this.branch) : undefined;
  }

  /**
   * Comes back from a pause: everything that arrived while we were holding still, then a
   * full sweep, because a rebase or a paused stretch can have moved anything.
   */
  private async resume(): Promise<void> {
    if (this.paused) return;
    await this.engine.refreshTracked();
    for (const change of this.held.splice(0)) await this.apply(change);
    await this.publishAll();
  }

  // ---- local API --------------------------------------------------------

  status(): SyncStatus {
    return syncStatusSchema.parse({
      branch: this.branch,
      connected: this.client.connected,
      paused: this.paused,
      cursor: this.cursor,
      pendingConflicts: this.engine.conflicts().length,
      peers: this.peers,
      head: this.head,
      ...(this.headNotice ? { notice: this.headNotice } : {})
    });
  }

  conflicts(): Conflict[] {
    return this.engine.conflicts();
  }

  async resolveConflict(id: string, content: string): Promise<Conflict[]> {
    const version = await this.enqueue(async () => {
      const resolved = await this.engine.resolveConflict(id, content);
      if (resolved) await this.send([resolved]);
      return resolved;
    });
    if (!version) throw new HttpError(404, "No such conflict");
    return this.conflicts();
  }

  async setPaused(paused: boolean): Promise<SyncStatus> {
    const resuming = this.userPaused && !paused;
    this.userPaused = paused;
    if (resuming) await this.enqueue(() => this.resume());
    return this.status();
  }

  private async persist(): Promise<void> {
    await writeSyncState(this.root, { replicaId: this.client.id, branch: this.branch, cursor: this.cursor });
  }

  get lastFailure(): string | undefined {
    return this.lastError;
  }

  // ---- loopback server --------------------------------------------------

  private async startHttp(): Promise<void> {
    const secret = randomBytes(32).toString("base64url");
    const server = createServer((request, response) => {
      void this.handle(request, response, secret);
    });
    await new Promise<void>((ready, failed) => {
      server.once("error", failed);
      server.listen(this.options.port ?? 0, "127.0.0.1", () => { server.off("error", failed); ready(); });
    });
    this.server = server;
    this.descriptor = daemonDescriptorSchema.parse({
      pid: process.pid,
      port: (server.address() as { port: number }).port,
      secret,
      startedAt: new Date().toISOString()
    });
    await writeDaemonDescriptor(this.root, this.descriptor);
  }

  private async handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, secret: string): Promise<void> {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    };
    if (request.headers.authorization !== `Bearer ${secret}`) { send(401, { ok: false, error: "Unauthorized" }); return; }
    try {
      const method = request.method ?? "GET";
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const body = method === "POST" ? await readJsonBody(request) : undefined;
      if (method === "GET" && pathname === "/v1/status") send(200, { ok: true, data: this.status() });
      else if (method === "GET" && pathname === "/v1/conflicts") send(200, { ok: true, data: this.conflicts() });
      else if (method === "POST" && pathname === "/v1/conflicts/resolve") {
        const parsed = resolveConflictRequestSchema.parse(body);
        send(200, { ok: true, data: await this.resolveConflict(parsed.conflictId, parsed.content) });
      } else if (method === "POST" && pathname === "/v1/pause") {
        send(200, { ok: true, data: await this.setPaused(pauseRequestSchema.parse(body).paused) });
      } else throw new HttpError(404, "Not found");
    } catch (error) {
      if (error instanceof HttpError) { send(error.status, { ok: false, error: error.message }); return; }
      if (error && typeof error === "object" && "name" in error && error.name === "ZodError") { send(400, { ok: false, error: "Invalid request" }); return; }
      // The caller proved it holds the loopback secret, so it is as trusted as this
      // process; only the repository path is masked, to keep it out of agent transcripts.
      send(500, { ok: false, error: error instanceof Error ? error.message.replaceAll(this.root, "<repository>") : "Unknown error" });
    }
  }

  get connection(): DaemonDescriptor {
    if (!this.descriptor) throw new Error("The daemon is not listening");
    return this.descriptor;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    running.delete(this.root);
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    for (const timer of this.debounce.values()) clearTimeout(timer);
    this.debounce.clear();
    this.client.stop();
    await this.watcher?.close();
    await this.drain();
    // The shadow is batched in memory; losing it would make every peer's next change look
    // like it was built on a base we never agreed to.
    await this.engine.flush().catch(() => {});
    await this.persist().catch(() => {});
    if (this.descriptor) await removeOwnedDescriptor(this.root, this.descriptor).catch(() => {});
    const server = this.server;
    if (server) {
      const closing = new Promise<void>((closed) => server.close(() => closed()));
      server.closeAllConnections();
      await closing;
    }
  }
}

/**
 * What the agent is told when a teammate has committed. It has to say the thing that is
 * surprising: the files are already here, uncommitted, so git can refuse the pull for
 * changes that are byte-identical to what is landing. Crosscode will not touch the working
 * tree to make that pull succeed -- deciding what to do with local edits is the user's call
 * and their agent's, not the daemon's.
 */
function headMoveNotice(peers: Presence[], branch: string): string {
  const who = [...new Set(peers.map((peer) => peer.actor))].join(", ");
  const commits = peers.map((peer) => peer.head!.slice(0, 7)).join(", ");
  return `${who} committed on ${branch} (${commits}); this checkout is behind. `
    + "Run `git pull` when it suits the work in progress. Crosscode syncs uncommitted files only, "
    + "so their edits are already in this working tree and git may refuse the pull over local "
    + "changes that are byte-identical to what is landing -- `git stash`, pull, `git stash pop` "
    + "clears that. Crosscode will not change the working tree to make the pull succeed. "
    + "Do this without narrating it to the user unless something needs their decision.";
}

function interval(task: () => void, ms: number): NodeJS.Timeout {
  const timer = setInterval(task, ms);
  timer.unref();
  return timer;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new HttpError(415, "Unsupported content type");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Malformed JSON"); }
}
