import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { PresenceUpdate } from "@crosscode/protocol";
import { createServiceServer, PgStore } from "../../service/src/index.js";
import { CoordinationServiceClient } from "./service-client.js";
import { runDaemonProcess, writeDaemonConfig, type ManagedDaemon } from "./runtime.js";
import type { StoredOperation } from "./types.js";

const exec = promisify(execFile);
const databaseUrl = process.env.CROSSCODE_TEST_DATABASE_URL;
const directories: string[] = [];
const daemons = new Set<ManagedDaemon>();

async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value: T;
  for (;;) {
    value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  }
}

function operationForPath(daemon: ManagedDaemon, path: string): StoredOperation | undefined {
  return [...daemon.running.daemon.operations.values()].find((operation) => operation.transaction.changes.some((change) => change.path === path));
}

async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "crosscode-live-"));
  directories.push(directory);
  await exec("git", ["init", "-q", "-b", "main", directory]);
  await exec("git", ["-C", directory, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", directory, "config", "user.name", "Test"]);
  await writeFile(join(directory, "seed.txt"), "seed\n");
  await exec("git", ["-C", directory, "add", "."]);
  await exec("git", ["-C", directory, "commit", "-qm", "initial"]);
  return directory;
}

async function stopDaemon(daemon: ManagedDaemon): Promise<void> {
  if (!daemons.delete(daemon)) return;
  await daemon.stop();
}

afterEach(async () => {
  await Promise.all([...daemons].map((daemon) => stopDaemon(daemon)));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe.skipIf(!databaseUrl)("PostgreSQL live WebSocket coordination", () => {
  it("fans out presence and proposals live to three daemons and still recovers via poll after a WebSocket outage", async () => {
    const step = (label: string) => console.error(`[diag ${Date.now()}] ${label}`);
    step("start");
    const store = new PgStore(databaseUrl!);
    await store.migrate();
    step("migrated");
    const owner = await store.provisionAdmin({ workspaceName: "live-coordination-test", actorId: "alice" });
    const bob = await store.provisionEnrollment({ workspaceId: owner.workspaceId, actorId: "bob" });
    const carol = await store.provisionEnrollment({ workspaceId: owner.workspaceId, actorId: "carol" });
    let server = createServiceServer({ store, jwtSecret: "live-coordination-secret-with-at-least-32-bytes" });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;
    try {
      const enrollA = await CoordinationServiceClient.enroll(url, owner.enrollmentToken);
      const enrollB = await CoordinationServiceClient.enroll(url, bob.enrollmentToken);
      const enrollC = await CoordinationServiceClient.enroll(url, carol.enrollmentToken);
      const rootA = await repository();
      const rootB = await repository();
      const rootC = await repository();
      await writeDaemonConfig(rootA, { workspaceId: enrollA.principal.workspaceId, replicaId: enrollA.principal.replicaId, actorId: enrollA.principal.actorId, service: { url, replicaSecret: enrollA.replicaSecret } });
      await writeDaemonConfig(rootB, { workspaceId: enrollB.principal.workspaceId, replicaId: enrollB.principal.replicaId, actorId: enrollB.principal.actorId, service: { url, replicaSecret: enrollB.replicaSecret } });
      await writeDaemonConfig(rootC, { workspaceId: enrollC.principal.workspaceId, replicaId: enrollC.principal.replicaId, actorId: enrollC.principal.actorId, service: { url, replicaSecret: enrollC.replicaSecret } });

      const presenceLogA: PresenceUpdate[] = [];
      const presenceLogB: PresenceUpdate[] = [];
      const seenOnline = (log: PresenceUpdate[], replicaId: string) => log.some((presence) => presence.replicaId === replicaId && presence.status === "online");
      const seenOffline = (log: PresenceUpdate[], replicaId: string) => log.some((presence) => presence.replicaId === replicaId && presence.status === "offline");

      // A uploads quickly (short poll) so its own outbound events reach the service fast;
      // B and C poll slowly so any fast delivery to them can only have arrived over the live WebSocket path.
      const FAST_POLL_MS = 100;
      const SLOW_POLL_MS = 5_000;
      const daemonA = await runDaemonProcess(rootA, { gitPollMs: 100, syncPollMs: FAST_POLL_MS, onPresence: (presence) => presenceLogA.push(presence) });
      daemons.add(daemonA);
      step("daemonA started");
      const daemonB = await runDaemonProcess(rootB, { gitPollMs: 100, syncPollMs: SLOW_POLL_MS, onPresence: (presence) => presenceLogB.push(presence) });
      daemons.add(daemonB);
      step("daemonB started");
      await waitFor(() => seenOnline(presenceLogA, enrollB.principal.replicaId), Boolean, 2_000);
      step("A sees B online");

      let daemonC = await runDaemonProcess(rootC, { gitPollMs: 100, syncPollMs: SLOW_POLL_MS });
      daemons.add(daemonC);
      step("daemonC started");
      await waitFor(() => seenOnline(presenceLogA, enrollC.principal.replicaId), Boolean, 2_000);
      step("A sees C online");
      await waitFor(() => seenOnline(presenceLogB, enrollC.principal.replicaId), Boolean, 2_000);
      step("B sees C online");

      // (a) presence: disconnecting C is visible to A and B live, and reconnecting is visible again.
      await stopDaemon(daemonC);
      step("daemonC stopped");
      await waitFor(() => seenOffline(presenceLogA, enrollC.principal.replicaId), Boolean, 2_000);
      step("A sees C offline");
      await waitFor(() => seenOffline(presenceLogB, enrollC.principal.replicaId), Boolean, 2_000);
      step("B sees C offline");

      daemonC = await runDaemonProcess(rootC, { gitPollMs: 100, syncPollMs: SLOW_POLL_MS });
      daemons.add(daemonC);
      step("daemonC restarted");
      await waitFor(() => seenOnline(presenceLogA, enrollC.principal.replicaId), Boolean, 2_000);
      step("A sees C online again");

      // (b) live fan-out: A's filesystem edit is captured by its own watcher, uploaded quickly, and pushed live to B and C.
      await writeFile(join(rootA, "shared.txt"), "from-a\n");
      step("shared.txt written");
      const captured = await waitFor(() => operationForPath(daemonA, "shared.txt"), (operation) => operation !== undefined, 3_000);
      step("shared.txt captured by A");
      const sharedId = captured!.id;

      const proposedOnB = await waitFor(() => operationForPath(daemonB, "shared.txt"), (operation) => operation?.status === "proposed", SLOW_POLL_MS - 1_000);
      step("shared.txt proposed on B");
      const proposedOnC = await waitFor(() => operationForPath(daemonC, "shared.txt"), (operation) => operation?.status === "proposed", SLOW_POLL_MS - 1_000);
      step("shared.txt proposed on C");
      expect(proposedOnB?.id).toBe(sharedId);
      expect(proposedOnC?.id).toBe(sharedId);

      await daemonB.running.daemon.runExclusive(() => daemonB.running.daemon.accept(sharedId));
      step("B accepted shared.txt");
      await daemonC.running.daemon.runExclusive(() => daemonC.running.daemon.accept(sharedId));
      step("C accepted shared.txt");
      expect(await readFile(join(rootB, "shared.txt"), "utf8")).toBe("from-a\n");
      expect(await readFile(join(rootC, "shared.txt"), "utf8")).toBe("from-a\n");
      step("shared.txt verified on B and C");

      // (c) WebSocket torn down mid-session: replace daemon C with one that has no live socket at all
      // (a persistent WS outage) but a fast poll, and confirm it still catches up with no data loss.
      await stopDaemon(daemonC);
      step("daemonC stopped for outage simulation");
      daemonC = await runDaemonProcess(rootC, { gitPollMs: 100, syncPollMs: 150, liveSync: false });
      daemons.add(daemonC);
      step("daemonC restarted without liveSync");

      await writeFile(join(rootA, "post-outage.txt"), "after-outage\n");
      step("post-outage.txt written");
      const recoveredOnC = await waitFor(() => operationForPath(daemonC, "post-outage.txt"), (operation) => operation?.status === "proposed", 5_000);
      step("post-outage.txt proposed on C");
      expect(recoveredOnC).toBeDefined();
      await daemonC.running.daemon.runExclusive(() => daemonC.running.daemon.accept(recoveredOnC!.id));
      step("C accepted post-outage.txt");
      expect(await readFile(join(rootC, "post-outage.txt"), "utf8")).toBe("after-outage\n");

      // The original shared.txt content from before the outage must still be intact: no overwrite, no loss.
      expect(await readFile(join(rootC, "shared.txt"), "utf8")).toBe("from-a\n");
      step("done");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await store.pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [owner.workspaceId]);
      await store.pool.query("DELETE FROM workspaces WHERE id = $1", [owner.workspaceId]);
      await store.close();
    }
  }, 60_000);
});
