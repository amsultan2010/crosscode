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
  it("uploads an offline event once and downloads it as an unapplied proposal", async () => {
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

      expect((await store.listOperations(sender_.principal.workspaceId, 0, 100)).items).toHaveLength(1);
      expect([...receiver.operations.values()].filter((operation) => operation.status === "proposed")).toHaveLength(1);
      expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("one\n");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await store.pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [sender_.principal.workspaceId]);
      await store.pool.query("DELETE FROM workspaces WHERE id = $1", [sender_.principal.workspaceId]);
      await store.close();
    }
  });
});
