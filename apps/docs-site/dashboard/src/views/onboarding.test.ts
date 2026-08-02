// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderOnboarding } from "./onboarding.js";

// The pairing endpoints (Contract A) are being built in parallel workstreams, so
// these tests drive the real client code against a mocked `fetch` -- the request
// shapes asserted here are the contract's, not the mock's.

const SESSION = { serviceUrl: "http://127.0.0.1:8788", accessToken: "jwt-token" };
const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const PAIRING_ID = "22222222-2222-2222-2222-222222222222";
const NOW = Date.parse("2026-08-01T12:00:00.000Z");

type StatusBody = {
  status: "pending" | "claimed" | "expired";
  claimedAt?: string | null;
  replicaId?: string | null;
  actorId?: string | null;
};

type FetchHandlers = {
  memberships?: () => Response;
  mint?: () => Response;
  status?: () => Response;
};

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) } as unknown as Response;
}

function errorResponse(status: number, message: string): Response {
  return { ok: false, status, statusText: "Error", json: async () => ({ error: message }) } as unknown as Response;
}

/** Records every call so tests can assert the paths/headers the contract mandates. */
const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];

function installFetch(handlers: FetchHandlers): void {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? "GET", headers });

    if (url.endsWith("/docs/install-prompt.md")) {
      return { ok: true, status: 200, statusText: "OK", text: async () => "````text\nInstall Crosscode\n````" } as unknown as Response;
    }
    if (url.endsWith("/v1/memberships")) {
      return (handlers.memberships ?? (() => jsonResponse({ memberships: [{ workspaceId: WORKSPACE_ID, workspaceName: "Ada's workspace", role: "owner" }] })))();
    }
    if (url.endsWith("/v1/pairing-codes")) {
      return (handlers.mint ?? (() => jsonResponse({ code: "K4T9-2WQZ", expiresAt: new Date(NOW + 15 * 60_000).toISOString(), pairingId: PAIRING_ID })))();
    }
    if (url.includes("/v1/pairing-codes/")) {
      return (handlers.status ?? (() => jsonResponse({ status: "pending", claimedAt: null, replicaId: null, actorId: null } satisfies StatusBody)))();
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** Renders onboarding and walks from the welcome slide to the connect step. */
async function openConnectStep(handlers: FetchHandlers = {}): Promise<{ container: HTMLElement; onDone: ReturnType<typeof vi.fn> }> {
  installFetch(handlers);
  const container = document.createElement("div");
  document.body.append(container);
  const onDone = vi.fn();
  renderOnboarding(container, SESSION, onDone);
  next(container).click();
  await vi.advanceTimersByTimeAsync(0);
  return { container, onDone };
}

function next(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>("#onboarding-next")!;
}

beforeEach(() => {
  calls.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("onboarding pairing flow", () => {
  it("mints a code on the connect step and renders it", async () => {
    const { container } = await openConnectStep();

    expect(container.querySelector("[data-testid=pairing-code]")?.textContent).toBe("K4T9-2WQZ");
    expect(container.querySelector("#pairing-countdown")?.textContent).toBe("15:00");

    const mintCall = calls.find((call) => call.url.endsWith("/v1/pairing-codes"))!;
    expect(mintCall.method).toBe("POST");
    expect(mintCall.headers.authorization).toBe("Bearer jwt-token");
    expect(mintCall.headers["x-crosscode-workspace-id"]).toBe(WORKSPACE_ID);
  });

  it("polls every 2s and advances the step when the code is claimed", async () => {
    let status: StatusBody = { status: "pending", claimedAt: null, replicaId: null, actorId: null };
    const { container } = await openConnectStep({ status: () => jsonResponse(status) });

    next(container).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector("#verify-status")?.getAttribute("data-status")).toBe("pending");
    expect(next(container).disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(container.querySelector("#verify-status")?.getAttribute("data-status")).toBe("pending");
    expect(calls.filter((call) => call.url.includes(`/v1/pairing-codes/${PAIRING_ID}`))).toHaveLength(1);

    status = { status: "claimed", claimedAt: new Date(NOW).toISOString(), replicaId: "r1", actorId: "ada@laptop" };
    await vi.advanceTimersByTimeAsync(2_000);

    expect(container.textContent).toContain("Your agent is connected");
    expect(container.textContent).toContain("ada@laptop");
    expect(next(container).disabled).toBe(false);

    // Polling stops once the code is settled.
    const pollCount = calls.filter((call) => call.url.includes(`/v1/pairing-codes/${PAIRING_ID}`)).length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.filter((call) => call.url.includes(`/v1/pairing-codes/${PAIRING_ID}`))).toHaveLength(pollCount);
  });

  it("routes to the dashboard from the connected step", async () => {
    const { container, onDone } = await openConnectStep({
      status: () => jsonResponse({ status: "claimed", claimedAt: new Date(NOW).toISOString(), replicaId: "r1", actorId: "ada@laptop" } satisfies StatusBody)
    });
    next(container).click();
    await vi.advanceTimersByTimeAsync(2_000);

    next(container).click();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("surfaces a re-mint action when the code expires, and mints a fresh one", async () => {
    let status: StatusBody = { status: "expired", claimedAt: null, replicaId: null, actorId: null };
    const { container } = await openConnectStep({ status: () => jsonResponse(status) });

    next(container).click();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(container.querySelector("#verify-status")?.getAttribute("data-status")).toBe("expired");
    const remint = container.querySelector<HTMLButtonElement>("#pairing-remint")!;
    expect(remint.textContent).toContain("Mint a new code");

    status = { status: "pending", claimedAt: null, replicaId: null, actorId: null };
    const mintsBefore = calls.filter((call) => call.method === "POST" && call.url.endsWith("/v1/pairing-codes")).length;
    remint.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.filter((call) => call.method === "POST" && call.url.endsWith("/v1/pairing-codes"))).toHaveLength(mintsBefore + 1);
    expect(container.querySelector("[data-testid=pairing-code]")?.textContent).toBe("K4T9-2WQZ");
    expect(container.querySelector("#pairing-expired")).toBeNull();
  });

  it("expires locally when the countdown runs out, without waiting for a poll", async () => {
    const { container } = await openConnectStep();
    next(container).click();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(container.querySelector("#verify-status")?.getAttribute("data-status")).toBe("expired");
    expect(container.querySelector("#pairing-remint")).not.toBeNull();
  });

  it("skipping the blocking verify step still reaches the dashboard", async () => {
    const { container, onDone } = await openConnectStep();
    next(container).click();
    await vi.advanceTimersByTimeAsync(0);

    expect(next(container).disabled).toBe(true);
    container.querySelector<HTMLButtonElement>("#onboarding-skip")!.click();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("shows an error instead of a blank step when minting fails", async () => {
    const { container } = await openConnectStep({ mint: () => errorResponse(500, "pairing service unavailable") });

    expect(container.querySelector("#pairing-error")?.textContent).toContain("pairing service unavailable");
    expect(container.querySelector("#pairing-remint")).not.toBeNull();
    expect(container.querySelector("[data-testid=pairing-code]")).toBeNull();
  });

  it("keeps polling and says so when a poll request fails", async () => {
    let failing = true;
    const { container } = await openConnectStep({
      status: () => (failing ? errorResponse(503, "service unavailable") : jsonResponse({ status: "pending", claimedAt: null, replicaId: null, actorId: null } satisfies StatusBody))
    });
    next(container).click();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(container.querySelector("#verify-error")?.textContent).toContain("service unavailable");
    expect(container.querySelector("#verify-status")?.getAttribute("data-status")).toBe("pending");

    failing = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(container.querySelector("#verify-error")).toBeNull();
  });

  it("stops polling when a newer instance takes over the same container", async () => {
    const { container } = await openConnectStep();
    next(container).click();
    await vi.advanceTimersByTimeAsync(2_000);
    const pollsBefore = calls.filter((call) => call.url.includes(`/v1/pairing-codes/${PAIRING_ID}`)).length;
    expect(pollsBefore).toBeGreaterThan(0);

    // main.ts re-renders the authed view on token refresh.
    renderOnboarding(container, SESSION, vi.fn());
    await vi.advanceTimersByTimeAsync(10_000);

    expect(calls.filter((call) => call.url.includes(`/v1/pairing-codes/${PAIRING_ID}`))).toHaveLength(pollsBefore);
    expect(container.textContent).toContain("Welcome to Crosscode");
  });

  it("never gates onboarding on team creation", async () => {
    const { container } = await openConnectStep();
    expect(container.querySelector("#workspace-form")).toBeNull();
    expect(container.textContent).not.toContain("Create workspace");
  });
});
