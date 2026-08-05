import { readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempRepo, cleanupTempRepos } from "@crosscode/test-fixtures";
import { createServiceServer, PgStore } from "../../service/src/index.js";
import { LocalDaemon } from "./index.js";
import { CoordinationServiceClient } from "./service-client.js";
import { provisionTestPrincipal, testSupabaseJwks, TEST_SUPABASE_URL } from "./test-supabase-session.js";

const databaseUrl = process.env.CROSSCODE_TEST_DATABASE_URL;

afterEach(async () => {
  await cleanupTempRepos();
});

function repository(): Promise<string> {
  return createTempRepo({ prefix: "crosscode-reconnect-", fileName: "a.txt", content: "one\n" });
}

describe.skipIf(!databaseUrl)("PostgreSQL daemon reconnect", () => {
  it("uploads an offline event once and downloads it without writing it to the working tree", async () => {
    const store = new PgStore(databaseUrl!);
    await store.migrate();
    const sender_ = await provisionTestPrincipal(store, { workspaceName: "reconnect-test", actorId: "sender" });
    const receiver_ = await provisionTestPrincipal(store, { workspaceId: sender_.principal.workspaceId, actorId: "receiver" });
    let server = createServiceServer({ store, jwks: await testSupabaseJwks(), supabaseUrl: TEST_SUPABASE_URL });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;
    try {
      const senderEnrollment = sender_;
      const receiverEnrollment = receiver_;
      const senderRoot = await repository();
      const receiverRoot = await repository();
      let sender = await LocalDaemon.open(senderRoot, senderEnrollment.principal);
      const receiver = await LocalDaemon.open(receiverRoot, receiverEnrollment.principal);
      await writeFile(join(senderRoot, "a.txt"), "remote\n");
      const local = await sender.capture("offline upload");
      const stableEvent = sender.outbound.get(local.id)!.event;
      sender.close();
      sender = await LocalDaemon.open(senderRoot, senderEnrollment.principal);
      expect(sender.outbound.get(local.id)!.event).toEqual(stableEvent);
      const senderClient = new CoordinationServiceClient(senderEnrollment.principal, { url, session: { accessToken: senderEnrollment.accessToken, refreshToken: "test-unused", expiresAt: senderEnrollment.expiresAt } });
      const receiverClient = new CoordinationServiceClient(receiverEnrollment.principal, { url, session: { accessToken: receiverEnrollment.accessToken, refreshToken: "test-unused", expiresAt: receiverEnrollment.expiresAt } });

      await sender.syncRemote(senderClient);
      await sender.syncRemote(senderClient);
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      server = createServiceServer({ store, jwks: await testSupabaseJwks(), supabaseUrl: TEST_SUPABASE_URL });
      await new Promise<void>((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
      await receiver.syncRemote(receiverClient);
      await receiver.syncRemote(receiverClient);

      const page = await store.listOperations(sender_.principal.workspaceId, 0, 100);
      expect(page.status === "ok" && page.items).toHaveLength(1);
      expect([...receiver.operations.values()]).toHaveLength(1);
      expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("one\n");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await store.pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [sender_.principal.workspaceId]);
      await store.pool.query("DELETE FROM workspaces WHERE id = $1", [sender_.principal.workspaceId]);
      await store.close();
    }
  });

  // End to end over a real service and a real daemon: the replica has been offline long
  // enough that retention deleted everything it had not downloaded. A plain age-based
  // DELETE would answer its cursor with an empty list -- identical to "you are caught up" --
  // and it would carry on, permanently missing two proposals with nothing logged anywhere.
  it("tells a replica whose cursor fell out of the retention window to resync instead of serving it a short list", async () => {
    const store = new PgStore(databaseUrl!);
    await store.migrate();
    const sender_ = await provisionTestPrincipal(store, { workspaceName: "retention-resync-test", actorId: "sender" });
    const receiver_ = await provisionTestPrincipal(store, { workspaceId: sender_.principal.workspaceId, actorId: "receiver" });
    const workspaceId = sender_.principal.workspaceId;
    const server = createServiceServer({ store, jwks: await testSupabaseJwks(), supabaseUrl: TEST_SUPABASE_URL });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const senderRoot = await repository();
      const receiverRoot = await repository();
      const sender = await LocalDaemon.open(senderRoot, sender_.principal);
      const receiver = await LocalDaemon.open(receiverRoot, receiver_.principal);
      const senderClient = new CoordinationServiceClient(sender_.principal, { url, session: { accessToken: sender_.accessToken, refreshToken: "test-unused", expiresAt: sender_.expiresAt } });
      const receiverClient = new CoordinationServiceClient(receiver_.principal, { url, session: { accessToken: receiver_.accessToken, refreshToken: "test-unused", expiresAt: receiver_.expiresAt } });

      await writeFile(join(senderRoot, "a.txt"), "seen by the receiver\n");
      await sender.capture("first");
      await sender.syncRemote(senderClient);
      await receiver.syncRemote(receiverClient);
      expect((await receiver.status()).remoteCursor).toBe(1);

      // Two more proposals the receiver never downloads, because it is offline.
      for (const content of ["second\n", "third\n"]) {
        await writeFile(join(senderRoot, "a.txt"), content);
        await sender.capture(`capture ${content.trim()}`);
        await sender.syncRemote(senderClient);
      }
      await store.pool.query("UPDATE operations SET created_at = now() - interval '40 days' WHERE workspace_id = $1", [workspaceId]);
      const swept = await store.pruneOperationsByRetention();
      expect(swept.find((result) => result.workspaceId === workspaceId)).toMatchObject({ deleted: 3, prunedThrough: 3 });

      await receiver.syncRemote(receiverClient);

      const status = await receiver.status();
      expect(status.remoteCursor).toBe(3);
      expect(status.service.lastResyncMessage).toContain("resynchronized from sequence 1 to 3");
      // The loss is real and now explicit: the receiver never saw operations 2 and 3, and
      // says so, rather than reporting a clean sync it did not have.
      expect([...receiver.operations.values()]).toHaveLength(1);
      // Steady state afterwards: the adopted cursor is servable, so the next sync is quiet.
      await expect(receiver.syncRemote(receiverClient)).resolves.toMatchObject({ downloaded: 0, cursor: 3 });

      // A daemon released before this status omits protocolVersion. It gets a hard 410 --
      // never a 200 it could read as a successful, empty page.
      const legacy = await fetch(`${url}/v1/operations?afterSequence=1`, {
        headers: { authorization: `Bearer ${receiver_.accessToken}`, "x-crosscode-workspace-id": workspaceId }
      });
      expect(legacy.status).toBe(410);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await store.pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [workspaceId]);
      await store.pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await store.close();
    }
  });
});
