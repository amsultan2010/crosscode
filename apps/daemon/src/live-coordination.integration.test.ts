import { readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PresenceUpdate } from "@crosscode/protocol";
import { createTempRepo, cleanupTempRepos, waitFor } from "@crosscode/test-fixtures";
import { createServiceServer, PgStore } from "../../service/src/index.js";
import { CoordinationServiceClient } from "./service-client.js";
import { writeDaemonConfig } from "./runtime.js";
import { spawnDaemon, stopDaemon, stopAllDaemons, type ManagedDaemon } from "./test-helpers.js";
import type { StoredOperation } from "./types.js";

const databaseUrl = process.env.CROSSCODE_TEST_DATABASE_URL;

function operationForPath(daemon: ManagedDaemon, path: string): StoredOperation | undefined {
  return [...daemon.running.daemon.operations.values()].find((operation) => operation.transaction.changes.some((change) => change.path === path));
}

function repository(): Promise<string> {
  return createTempRepo({ prefix: "crosscode-live-" });
}

afterEach(async () => {
  await stopAllDaemons();
  await cleanupTempRepos();
});

describe.skipIf(!databaseUrl)("PostgreSQL live WebSocket coordination", () => {
  it("fans out presence and proposals live to three daemons and still recovers via poll after a WebSocket outage", async () => {
    const store = new PgStore(databaseUrl!);
    await store.migrate();
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
      const SLOW_POLL_MS = 10_000;
      const daemonA = await spawnDaemon(rootA, { gitPollMs: 100, syncPollMs: FAST_POLL_MS, onPresence: (presence) => presenceLogA.push(presence) });
      const daemonB = await spawnDaemon(rootB, { gitPollMs: 100, syncPollMs: SLOW_POLL_MS, onPresence: (presence) => presenceLogB.push(presence) });
      await waitFor(() => seenOnline(presenceLogA, enrollB.principal.replicaId), Boolean, 2_000);

      let daemonC = await spawnDaemon(rootC, { gitPollMs: 100, syncPollMs: SLOW_POLL_MS });
      await waitFor(() => seenOnline(presenceLogA, enrollC.principal.replicaId), Boolean, 2_000);
      await waitFor(() => seenOnline(presenceLogB, enrollC.principal.replicaId), Boolean, 2_000);

      // (a) presence: disconnecting C is visible to A and B live, and reconnecting is visible again.
      await stopDaemon(daemonC);
      await waitFor(() => seenOffline(presenceLogA, enrollC.principal.replicaId), Boolean, 2_000);
      await waitFor(() => seenOffline(presenceLogB, enrollC.principal.replicaId), Boolean, 2_000);

      daemonC = await spawnDaemon(rootC, { gitPollMs: 100, syncPollMs: SLOW_POLL_MS });
      await waitFor(() => seenOnline(presenceLogA, enrollC.principal.replicaId), Boolean, 2_000);

      // (b) live fan-out: A's filesystem edit is captured by its own watcher, uploaded quickly, and pushed live to B and C.
      await writeFile(join(rootA, "shared.txt"), "from-a\n");
      const captured = await waitFor(() => operationForPath(daemonA, "shared.txt"), (operation) => operation !== undefined, 3_000);
      const sharedId = captured!.id;

      const proposedOnB = await waitFor(() => operationForPath(daemonB, "shared.txt"), (operation) => operation?.status === "proposed", SLOW_POLL_MS - 1_000);
      const proposedOnC = await waitFor(() => operationForPath(daemonC, "shared.txt"), (operation) => operation?.status === "proposed", SLOW_POLL_MS - 1_000);
      expect(proposedOnB?.id).toBe(sharedId);
      expect(proposedOnC?.id).toBe(sharedId);

      await daemonB.running.daemon.runExclusive(() => daemonB.running.daemon.accept(sharedId));
      await daemonC.running.daemon.runExclusive(() => daemonC.running.daemon.accept(sharedId));
      expect(await readFile(join(rootB, "shared.txt"), "utf8")).toBe("from-a\n");
      expect(await readFile(join(rootC, "shared.txt"), "utf8")).toBe("from-a\n");

      // (c) task/claim live fan-out: A creates a task and claim, both are pushed live to B and C.
      const task = await daemonA.running.daemon.runExclusive(() => daemonA.running.daemon.createTask({ title: "Coordinate shared.txt" }));
      const claim = await daemonA.running.daemon.runExclusive(() => daemonA.running.daemon.createClaim({ taskId: task.id, kind: "path", target: "shared.txt", mode: "exclusive-preferred" }));

      const taskOnB = await waitFor(() => daemonB.running.daemon.tasks.get(task.id), (value) => value !== undefined, SLOW_POLL_MS - 1_000);
      const taskOnC = await waitFor(() => daemonC.running.daemon.tasks.get(task.id), (value) => value !== undefined, SLOW_POLL_MS - 1_000);
      expect(taskOnB?.title).toBe("Coordinate shared.txt");
      expect(taskOnC?.title).toBe("Coordinate shared.txt");
      const claimOnB = await waitFor(() => daemonB.running.daemon.claims.get(claim.id), (value) => value !== undefined, SLOW_POLL_MS - 1_000);
      const claimOnC = await waitFor(() => daemonC.running.daemon.claims.get(claim.id), (value) => value !== undefined, SLOW_POLL_MS - 1_000);
      expect(claimOnB?.target).toBe("shared.txt");
      expect(claimOnC?.target).toBe("shared.txt");

      // Releasing the claim live-removes it from B and C without waiting for their slow poll.
      await daemonA.running.daemon.runExclusive(() => daemonA.running.daemon.releaseClaim(claim.id));
      await waitFor(() => daemonB.running.daemon.claims.has(claim.id), (value) => value === false, SLOW_POLL_MS - 1_000);
      await waitFor(() => daemonC.running.daemon.claims.has(claim.id), (value) => value === false, SLOW_POLL_MS - 1_000);

      // (d) WebSocket torn down mid-session: replace daemon C with one that has no live socket at all
      // (a persistent WS outage) but a fast poll, and confirm it still catches up with no data loss.
      await stopDaemon(daemonC);
      daemonC = await spawnDaemon(rootC, { gitPollMs: 100, syncPollMs: 150, liveSync: false });

      await writeFile(join(rootA, "post-outage.txt"), "after-outage\n");
      const recoveredOnC = await waitFor(() => operationForPath(daemonC, "post-outage.txt"), (operation) => operation?.status === "proposed", 5_000);
      expect(recoveredOnC).toBeDefined();
      await daemonC.running.daemon.runExclusive(() => daemonC.running.daemon.accept(recoveredOnC!.id));
      expect(await readFile(join(rootC, "post-outage.txt"), "utf8")).toBe("after-outage\n");

      // The original shared.txt content from before the outage must still be intact: no overwrite, no loss.
      expect(await readFile(join(rootC, "shared.txt"), "utf8")).toBe("from-a\n");

      // A replica with no live socket still catches up on tasks/claims through the poll fallback.
      const postOutageTask = await daemonA.running.daemon.runExclusive(() => daemonA.running.daemon.createTask({ title: "Post-outage task" }));
      const postOutageClaim = await daemonA.running.daemon.runExclusive(() => daemonA.running.daemon.createClaim({ taskId: postOutageTask.id, kind: "path", target: "post-outage.txt", mode: "shared" }));
      const postOutageTaskOnC = await waitFor(() => daemonC.running.daemon.tasks.get(postOutageTask.id), (value) => value !== undefined, 5_000);
      const postOutageClaimOnC = await waitFor(() => daemonC.running.daemon.claims.get(postOutageClaim.id), (value) => value !== undefined, 5_000);
      expect(postOutageTaskOnC?.title).toBe("Post-outage task");
      expect(postOutageClaimOnC?.target).toBe("post-outage.txt");

      // The earlier claim release must still be reflected: no resurrection through the poll fallback.
      expect(daemonC.running.daemon.claims.has(claim.id)).toBe(false);
    } finally {
      // Live daemons keep WebSocket connections open on the server; http.Server#close only
      // invokes its callback once every existing connection has ended, so they must be
      // stopped first or server.close() never resolves.
      await stopAllDaemons();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await store.pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [owner.workspaceId]);
      await store.pool.query("DELETE FROM workspaces WHERE id = $1", [owner.workspaceId]);
      await store.close();
    }
  }, 45_000);
});
