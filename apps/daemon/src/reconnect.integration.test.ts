import { readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempRepo, cleanupTempRepos } from "@crosscode/test-fixtures";
import { createServiceServer, PgStore } from "../../service/src/index.js";
import { LocalDaemon } from "./index.js";
import { CoordinationServiceClient } from "./service-client.js";

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
    const owner = await store.provisionAdmin({ workspaceName: "reconnect-test", actorId: "sender" });
    const member = await store.provisionEnrollment({ workspaceId: owner.workspaceId, actorId: "receiver" });
    let server = createServiceServer({ store, jwtSecret: "daemon-reconnect-secret-with-at-least-32-bytes" });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;
    try {
      const senderEnrollment = await CoordinationServiceClient.enroll(url, owner.enrollmentToken);
      const receiverEnrollment = await CoordinationServiceClient.enroll(url, member.enrollmentToken);
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
      const senderClient = new CoordinationServiceClient(senderEnrollment.principal, { url, replicaSecret: senderEnrollment.replicaSecret });
      const receiverClient = new CoordinationServiceClient(receiverEnrollment.principal, { url, replicaSecret: receiverEnrollment.replicaSecret });

      await sender.syncRemote(senderClient);
      await sender.syncRemote(senderClient);
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      server = createServiceServer({ store, jwtSecret: "daemon-reconnect-secret-with-at-least-32-bytes" });
      await new Promise<void>((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
      await receiver.syncRemote(receiverClient);
      await receiver.syncRemote(receiverClient);

      expect((await store.listOperations(owner.workspaceId, 0, 100)).items).toHaveLength(1);
      expect([...receiver.operations.values()].filter((operation) => operation.status === "proposed")).toHaveLength(1);
      expect(await readFile(join(receiverRoot, "a.txt"), "utf8")).toBe("one\n");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await store.pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [owner.workspaceId]);
      await store.pool.query("DELETE FROM workspaces WHERE id = $1", [owner.workspaceId]);
      await store.close();
    }
  });
});
