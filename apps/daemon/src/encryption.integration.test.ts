import { readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempRepo, cleanupTempRepos, waitFor } from "@crosscode/test-fixtures";
import { createServiceServer, PgStore } from "../../service/src/index.js";
import { approveKeyDevice, listKeyDevices, redeemPairingCode, rotateWorkspaceKey, startPairing, workspaceKeyStatus, writeDaemonConfig } from "./runtime.js";
import { provisionTestPrincipal, testSupabaseJwks, TEST_SUPABASE_URL } from "./test-supabase-session.js";
import { spawnDaemon, stopAllDaemons } from "./test-helpers.js";
import { loadKeyring } from "./workspace-key.js";
import type { StoredOperation } from "./types.js";

const databaseUrl = process.env.CROSSCODE_TEST_DATABASE_URL;

function operationForPath(daemon: { running: { daemon: { operations: Map<string, StoredOperation> } } }, path: string): StoredOperation | undefined {
  return [...daemon.running.daemon.operations.values()].find((operation) => operation.transaction.changes.some((change) => change.path === path));
}

afterEach(async () => {
  await stopAllDaemons();
  await cleanupTempRepos();
});

describe.skipIf(!databaseUrl)("PostgreSQL end-to-end encrypted coordination", () => {
  it("encrypts by default, pairs a second device into the key, and rotates", async () => {
    const store = new PgStore(databaseUrl!);
    await store.migrate();
    const owner = await provisionTestPrincipal(store, { workspaceName: `encrypted-${Date.now()}`, actorId: "alice" });
    const workspaceId = owner.principal.workspaceId;
    const server = createServiceServer({ store, jwks: await testSupabaseJwks(), supabaseUrl: TEST_SUPABASE_URL });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const rootA = await createTempRepo({ prefix: "crosscode-e2ee-a-" });
      await writeDaemonConfig(rootA, {
        workspaceId, replicaId: owner.principal.replicaId, actorId: owner.principal.actorId,
        service: { url, session: { accessToken: owner.accessToken, refreshToken: "test-unused", expiresAt: owner.expiresAt } }
      });

      // (a) Nothing was configured and no key was imported: the first daemon in an empty
      // workspace mints one and encrypts from its very first operation. That default is
      // the whole claim on the privacy page, so it is what this asserts.
      const daemonA = await spawnDaemon(rootA, { gitPollMs: 100, syncPollMs: 100 });
      const keyringA = await waitFor(() => loadKeyring(rootA), (value) => value?.currentEpoch === 0, 5_000);
      expect(keyringA!.epochs["0"]).toBeDefined();

      await writeFile(join(rootA, "secret-plan.md"), "# acquisition targets\n");
      const captured = await waitFor(() => operationForPath(daemonA, "secret-plan.md"), (operation) => operation !== undefined, 5_000);
      const stored = await waitFor(
        () => store.pool.query<{ sealed: boolean; transaction: unknown; event: unknown }>(
          "SELECT sealed, transaction, event FROM operations WHERE workspace_id = $1 AND id = $2", [workspaceId, captured!.id]
        ).then((result) => result.rows[0]),
        (row) => row !== undefined,
        5_000
      );

      // What the service actually holds. Not "no afterContent field" -- nothing anywhere
      // in either column that resembles the path, the content, or a hash of the content.
      expect(stored!.sealed).toBe(true);
      const persisted = JSON.stringify([stored!.transaction, stored!.event]);
      for (const secret of ["secret-plan.md", "acquisition targets", captured!.transaction.changes[0]!.afterHash!]) {
        expect(persisted).not.toContain(secret);
      }
      const files = await store.pool.query<{ path: string; after_hash: string | null }>(
        "SELECT path, after_hash FROM operation_files WHERE workspace_id = $1 AND operation_id = $2", [workspaceId, captured!.id]
      );
      expect(files.rows[0]!.path).toMatch(/^[0-9a-f]{64}$/);
      expect(files.rows[0]!.after_hash).toBeNull();

      // (b) A second checkout pairs in. It gets a workspace token immediately but no key:
      // until a human on the first device confirms its fingerprint, it cannot read
      // anything, and it must not fall back to plaintext.
      const rootB = await createTempRepo({ prefix: "crosscode-e2ee-b-" });
      const session = await startPairing(rootA, { pollMs: 100, timeoutMs: 20_000 });
      const paired = await redeemPairingCode(rootB, session.code, { serviceUrl: url, replicaName: `laptop-${Date.now()}`, actorId: "alice" });
      const claim = await session.claimed;
      expect(claim.fingerprint).toBe(paired.deviceFingerprint);
      expect((await workspaceKeyStatus(rootB)).currentEpoch).toBeNull();

      const devices = await listKeyDevices(rootA);
      expect(devices.find((device) => device.replicaId === claim.replicaId)).toMatchObject({ fingerprint: claim.fingerprint, holdsKey: false });

      const approved = await session.approve(claim.replicaId);
      expect(approved).toEqual({ granted: 1, fingerprint: claim.fingerprint });

      // (c) With the key granted, the second device reads the proposal the first one sealed.
      const daemonB = await spawnDaemon(rootB, { gitPollMs: 100, syncPollMs: 100 });
      const proposal = await waitFor(() => operationForPath(daemonB, "secret-plan.md"), (operation) => operation?.status === "proposed", 10_000);
      expect(proposal!.id).toBe(captured!.id);
      expect(proposal!.transaction.changes[0]!.afterContent).toBe("# acquisition targets\n");
      await daemonB.running.daemon.runExclusive(() => daemonB.running.daemon.accept(proposal!.id));
      expect(await readFile(join(rootB, "secret-plan.md"), "utf8")).toBe("# acquisition targets\n");

      // (d) Rotation starts a new epoch and hands it to the devices already holding one,
      // so both keep working; the old epoch stays in the keyring so history stays readable.
      const rotated = await rotateWorkspaceKey(rootA);
      expect(rotated.epoch).toBe(1);
      expect(rotated.granted).toBe(1);

      await writeFile(join(rootA, "after-rotation.md"), "sealed under epoch 1\n");
      const afterRotation = await waitFor(() => operationForPath(daemonB, "after-rotation.md"), (operation) => operation !== undefined, 15_000);
      expect(afterRotation!.transaction.changes[0]!.afterContent).toBe("sealed under epoch 1\n");
      // B picked up the new epoch on its own, and kept the old one, so the proposal it
      // already holds from before the rotation stays readable.
      expect(Object.keys((await loadKeyring(rootB))!.epochs).sort()).toEqual(["0", "1"]);
      const rotatedRow = await store.pool.query<{ key_epoch: number }>(
        "SELECT key_epoch FROM operations WHERE workspace_id = $1 AND id = $2", [workspaceId, afterRotation!.id]
      );
      expect(rotatedRow.rows[0]!.key_epoch).toBe(1);

      // Granting is idempotent, so the daemon's per-minute sweep is not a stream of errors.
      expect((await approveKeyDevice(rootA, claim.replicaId)).granted).toBe(0);
    } finally {
      await stopAllDaemons();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await store.pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [workspaceId]);
      await store.pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await store.close();
    }
  }, 90_000);
});
