import { describe, expect, it, vi } from "vitest";
import { CrosscodeApiClient, type DaemonApi } from "./client.js";

function fakeStatus() {
  return {
    root: "/repo", worktree: "/repo", remotes: [], dirty: false, workspaceId: "w", replicaId: "r",
    tasks: 0, claims: 0, proposals: 0, materializationPaused: false, eventSequence: 0, remoteCursor: 0,
    pendingOutbound: 0, service: { configured: false, online: false }
  };
}

function fakeApi(overrides: Partial<DaemonApi> = {}): DaemonApi {
  return {
    status: vi.fn(async () => fakeStatus()),
    tasks: vi.fn(async () => []),
    createTask: vi.fn(async (input) => ({ id: "t1", ownerId: "actor", status: "planned", paths: [], createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z", ...input })),
    updateTask: vi.fn(async (id, input) => ({ id, ownerId: "actor", status: "planned", paths: [], createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z", ...input })),
    claims: vi.fn(async () => []),
    createClaim: vi.fn(async (input) => ({ id: "c1", ownerId: "actor", createdAt: "2024-01-01T00:00:00.000Z", ...input })),
    releaseClaim: vi.fn(async (id) => ({ id, taskId: "t1", ownerId: "actor", kind: "path" as const, target: "src", mode: "exclusive-preferred" as const, createdAt: "2024-01-01T00:00:00.000Z" })),
    operations: vi.fn(async () => []),
    diff: vi.fn(async () => []),
    accept: vi.fn(async (id) => ({ id, status: "accepted" }) as never),
    reject: vi.fn(async (id) => ({ id, status: "rejected" }) as never),
    validate: vi.fn(async () => []),
    ...overrides
  };
}

describe("CrosscodeApiClient", () => {
  it("connects once and reuses the connection across calls", async () => {
    const api = fakeApi();
    const connectFn = vi.fn(async () => api);
    const client = new CrosscodeApiClient("/repo", connectFn);

    await client.status();
    await client.tasks();

    expect(connectFn).toHaveBeenCalledTimes(1);
    expect(connectFn).toHaveBeenCalledWith("/repo");
  });

  it("does not connect twice for concurrent calls", async () => {
    const api = fakeApi();
    const connectFn = vi.fn(async () => api);
    const client = new CrosscodeApiClient("/repo", connectFn);

    await Promise.all([client.status(), client.tasks(), client.claims()]);

    expect(connectFn).toHaveBeenCalledTimes(1);
  });

  it("drops the cached connection and reports the error after a failed call", async () => {
    const api = fakeApi({ status: vi.fn(async () => { throw new Error("daemon unavailable"); }) });
    const connectFn = vi.fn(async () => api);
    const client = new CrosscodeApiClient("/repo", connectFn);

    await expect(client.status()).rejects.toThrow("daemon unavailable");
    expect(client.getLastError()).toBe("daemon unavailable");

    await client.tasks();
    expect(connectFn).toHaveBeenCalledTimes(2);
    expect(client.getLastError()).toBeUndefined();
  });

  it("propagates a failed connection attempt as the last error", async () => {
    const connectFn = vi.fn(async (): Promise<DaemonApi> => { throw new Error("no daemon descriptor"); });
    const client = new CrosscodeApiClient("/repo", connectFn);

    await expect(client.status()).rejects.toThrow("no daemon descriptor");
    expect(client.getLastError()).toBe("no daemon descriptor");
  });

  it("filters operations down to proposed proposals only", async () => {
    const operations = [
      { id: "op1", status: "proposed" },
      { id: "op2", status: "accepted" },
      { id: "op3", status: "proposed" }
    ] as never;
    const api = fakeApi({ operations: vi.fn(async () => operations) });
    const client = new CrosscodeApiClient("/repo", vi.fn(async () => api));

    const proposals = await client.proposals();

    expect(proposals.map((operation) => operation.id)).toEqual(["op1", "op3"]);
  });

  it("delegates accept/reject/validate/releaseClaim to the daemon API", async () => {
    const api = fakeApi();
    const client = new CrosscodeApiClient("/repo", vi.fn(async () => api));

    await client.accept("op1");
    await client.reject("op2");
    await client.validate("fast");
    await client.releaseClaim("c1");

    expect(api.accept).toHaveBeenCalledWith("op1");
    expect(api.reject).toHaveBeenCalledWith("op2");
    expect(api.validate).toHaveBeenCalledWith("fast");
    expect(api.releaseClaim).toHaveBeenCalledWith("c1");
  });
});
