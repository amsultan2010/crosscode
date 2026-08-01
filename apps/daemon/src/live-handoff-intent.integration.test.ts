import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempRepo, cleanupTempRepos, waitFor } from "@crosscode/test-fixtures";
import { createServiceServer, PgStore } from "../../service/src/index.js";
import { writeDaemonConfig } from "./runtime.js";
import { provisionTestPrincipal, testSupabaseJwks, TEST_SUPABASE_URL } from "./test-supabase-session.js";
import { spawnDaemon, stopDaemon, stopAllDaemons } from "./test-helpers.js";

const databaseUrl = process.env.CROSSCODE_TEST_DATABASE_URL;

function repository(): Promise<string> {
  return createTempRepo({ prefix: "crosscode-handoff-intent-" });
}

afterEach(async () => {
  await stopAllDaemons();
  await cleanupTempRepos();
});

describe.skipIf(!databaseUrl)("PostgreSQL live handoff and intent coordination", () => {
  it("fans out handoffs and intents live between two daemons and recovers losslessly through the poll fallback", async () => {
    const store = new PgStore(databaseUrl!);
    await store.migrate();
    const owner = await provisionTestPrincipal(store, { workspaceName: "live-handoff-intent-test", actorId: "alice" });
    const bob = await provisionTestPrincipal(store, { workspaceId: owner.principal.workspaceId, actorId: "bob" });
    const server = createServiceServer({ store, jwks: await testSupabaseJwks(), supabaseUrl: TEST_SUPABASE_URL });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;
    try {
      const enrollA = owner;
      const enrollB = bob;
      const rootA = await repository();
      const rootB = await repository();
      await writeDaemonConfig(rootA, { workspaceId: enrollA.principal.workspaceId, replicaId: enrollA.principal.replicaId, actorId: enrollA.principal.actorId, service: { url, session: { accessToken: enrollA.accessToken, refreshToken: "test-unused", expiresAt: enrollA.expiresAt } } });
      await writeDaemonConfig(rootB, { workspaceId: enrollB.principal.workspaceId, replicaId: enrollB.principal.replicaId, actorId: enrollB.principal.actorId, service: { url, session: { accessToken: enrollB.accessToken, refreshToken: "test-unused", expiresAt: enrollB.expiresAt } } });

      // A uploads quickly (short poll); B polls slowly so fast delivery to B can only have
      // arrived over the live WebSocket path, proving live fan-out rather than eventual poll consistency.
      const FAST_POLL_MS = 100;
      const SLOW_POLL_MS = 10_000;
      const daemonA = await spawnDaemon(rootA, { gitPollMs: 100, syncPollMs: FAST_POLL_MS });
      let daemonB = await spawnDaemon(rootB, { gitPollMs: 100, syncPollMs: SLOW_POLL_MS });

      // (a) handoff live fan-out: A captures a transaction, requests a handoff, B sees it live.
      await writeFile(join(rootA, "shared.txt"), "from-a\n");
      const captured = await waitFor(
        () => [...daemonA.running.daemon.operations.values()].find((operation) => operation.transaction.changes.some((change) => change.path === "shared.txt")),
        (operation) => operation !== undefined,
        3_000
      );
      const handoff = await daemonA.running.daemon.runExclusive(() => daemonA.running.daemon.requestHandoff({ operationId: captured!.id, note: "please take shared.txt" }));

      const handoffOnB = await waitFor(() => daemonB.running.daemon.handoffs.get(handoff.id), (value) => value !== undefined, SLOW_POLL_MS - 1_000);
      expect(handoffOnB?.status).toBe("pending");
      expect(handoffOnB?.note).toBe("please take shared.txt");

      const responded = await daemonA.running.daemon.runExclusive(() => daemonA.running.daemon.respondHandoff(handoff.id, "accepted"));
      const respondedOnB = await waitFor(() => daemonB.running.daemon.handoffs.get(handoff.id), (value) => value?.status === "accepted", SLOW_POLL_MS - 1_000);
      expect(respondedOnB?.status).toBe(responded.status);

      // (b) intent live fan-out: A publishes an intent, B sees it live.
      const intent = await daemonA.running.daemon.runExclusive(() => daemonA.running.daemon.publishIntent({ text: "Rename CheckoutResponse.checkoutId to id" }));
      const intentOnB = await waitFor(() => daemonB.running.daemon.intents.get(intent.id), (value) => value !== undefined, SLOW_POLL_MS - 1_000);
      expect(intentOnB?.text).toBe("Rename CheckoutResponse.checkoutId to id");

      // (c) WebSocket torn down: replace daemon B with one that has no live socket at all
      // (a persistent WS outage) but a fast poll, and confirm it still catches up losslessly.
      await stopDaemon(daemonB);
      daemonB = await spawnDaemon(rootB, { gitPollMs: 100, syncPollMs: 150, liveSync: false });

      const postOutageHandoff = await daemonA.running.daemon.runExclusive(() => daemonA.running.daemon.requestHandoff({ operationId: captured!.id, note: "post-outage handoff" }));
      const postOutageIntent = await daemonA.running.daemon.runExclusive(() => daemonA.running.daemon.publishIntent({ text: "Post-outage intent" }));
      const postOutageHandoffOnB = await waitFor(() => daemonB.running.daemon.handoffs.get(postOutageHandoff.id), (value) => value !== undefined, 5_000);
      const postOutageIntentOnB = await waitFor(() => daemonB.running.daemon.intents.get(postOutageIntent.id), (value) => value !== undefined, 5_000);
      expect(postOutageHandoffOnB?.note).toBe("post-outage handoff");
      expect(postOutageIntentOnB?.text).toBe("Post-outage intent");

      // The earlier accepted handoff must still be reflected: no regression through the poll fallback.
      expect(daemonB.running.daemon.handoffs.get(handoff.id)?.status).toBe("accepted");
    } finally {
      // Live daemons keep WebSocket connections open on the server; http.Server#close only
      // invokes its callback once every existing connection has ended, so they must be
      // stopped first or server.close() never resolves.
      await stopAllDaemons();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await store.pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [owner.principal.workspaceId]);
      await store.pool.query("DELETE FROM workspaces WHERE id = $1", [owner.principal.workspaceId]);
      await store.close();
    }
  }, 45_000);
});
