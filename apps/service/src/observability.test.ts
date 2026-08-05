import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEvent, createErrorReporter, createObservability, normalizeRoute, observeRequest, parseDsn, redact,
  type SentryEvent
} from "./observability.js";

const DSN = "https://publickey@o1.ingest.sentry.io/4501";

function fakeRequest(url: string, method = "GET", headers: Record<string, string> = {}): IncomingMessage {
  return { url, method, headers } as unknown as IncomingMessage;
}

/** Enough of a ServerResponse to emit finish with a status. */
function fakeResponse(statusCode: number) {
  const emitter = new EventEmitter() as unknown as ServerResponse & { finish: () => void };
  emitter.statusCode = statusCode;
  emitter.finish = () => { emitter.emit("finish"); };
  return emitter;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createObservability without a DSN", () => {
  it("is inert and opens no socket", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no network call should happen")));
    vi.stubGlobal("fetch", fetchSpy);

    const reporter = createObservability({});

    expect(reporter.enabled).toBe(false);
    // Capturing must not throw, must not report, and must not reach fetch.
    reporter.capture(new Error("boom"), { route: "/v1/health", method: "GET" });
    await reporter.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("attaches no response listener, so a 5xx costs nothing when reporting is off", () => {
    const reporter = createObservability({});
    const response = fakeResponse(500);

    const context = observeRequest(reporter, fakeRequest("/v1/operations?cursor=8"), response);

    expect(response.listenerCount("finish")).toBe(0);
    expect(context).toEqual({ route: "/v1/operations", method: "GET", requestId: undefined });
  });

  it("stays inert for a DSN that is not a DSN", () => {
    expect(createObservability({ SENTRY_DSN: "not-a-url" }).enabled).toBe(false);
    expect(createObservability({ SENTRY_DSN: "https://o1.ingest.sentry.io/4501" }).enabled).toBe(false);
    expect(parseDsn(DSN)).toEqual({
      endpoint: "https://o1.ingest.sentry.io/api/4501/envelope/",
      publicKey: "publickey",
      dsn: "https://publickey@o1.ingest.sentry.io/4501"
    });
  });
});

describe("redaction before transport", () => {
  it("strips file contents and paths from an error before it reaches the transport", async () => {
    const sent: SentryEvent[] = [];
    const reporter = createErrorReporter({ dsn: DSN, transport: async (event) => { sent.push(event); } });

    // The shape that must never leave the process: a path, a source line, and a payload.
    const error = new Error(
      "Failed to seal /Users/ana/work/acme/src/billing.ts: const STRIPE_KEY = \"sk_live_51NfakeSecretValue\"\n" +
      "  offending chunk: aGVsbG8gdGhpcyBpcyBjaXBoZXJ0ZXh0IGZvciBhIGZpbGU="
    );

    reporter.capture(error, { route: "/v1/workspaces/:id/operations", method: "POST", status: 500, requestId: "iad1::abc-123" });
    await reporter.flush();

    expect(sent).toHaveLength(1);
    const value = sent[0]?.exception.values[0]?.value ?? "";
    expect(value).toBe("Failed to seal [path]: const STRIPE_KEY = [redacted]");
    for (const secret of ["ana", "acme", "billing.ts", "sk_live", "aGVsbG8", "ciphertext"]) {
      expect(value).not.toContain(secret);
    }
    // Nothing else in the event carries free text either.
    const serialized = JSON.stringify(sent[0]);
    for (const secret of ["ana", "acme", "billing.ts", "sk_live", "aGVsbG8"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(sent[0]?.tags).toEqual({ route: "/v1/workspaces/:id/operations", method: "POST", status: "500", request_id: "iad1::abc-123" });
  });

  it("drops custom error properties, cause, and the raw stack string", async () => {
    const sent: SentryEvent[] = [];
    const reporter = createErrorReporter({ dsn: DSN, transport: async (event) => { sent.push(event); } });
    const error = Object.assign(new Error("write failed"), {
      cause: new Error("diff: -export const token = 'shhh'"),
      filePath: "/Users/ana/work/acme/src/secret.ts",
      patch: "@@ -1 +1 @@ -const a = 1"
    });

    reporter.capture(error, { route: "/v1/operations", method: "POST" });
    await reporter.flush();

    const serialized = JSON.stringify(sent[0]);
    expect(serialized).not.toContain("secret.ts");
    expect(serialized).not.toContain("shhh");
    expect(serialized).not.toContain("@@");
    expect(sent[0]?.exception.values[0]).not.toHaveProperty("stacktrace.value");
    // Frames survive as locations, which are Crosscode's own code, with basenames only.
    const frames = sent[0]?.exception.values[0]?.stacktrace?.frames ?? [];
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(frame.filename).not.toContain("/");
  });

  it("redacts the shapes user content arrives in", () => {
    expect(redact("no such file or directory")).toBe("no such file or directory");
    expect(redact("cannot read src/app/main.ts")).toBe("cannot read [path]");
    expect(redact("cannot read ./relative/path.txt")).toBe("cannot read [path]");
    expect(redact("cannot read C:\\Users\\ana\\repo\\a.ts")).toBe("cannot read [path]");
    expect(redact("task title: 'ship the acquisition page'")).toBe("task title: [redacted]");
    expect(redact("hash mismatch 9f2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d")).toBe("hash mismatch [redacted]");
    expect(redact("line one\nline two")).toBe("line one");
    expect(redact(`padded ${"x".repeat(300)}`).length).toBeLessThanOrEqual(203);
  });

  it("keeps a status of 500 and the route template, and nothing from the query string", () => {
    expect(normalizeRoute("/v1/workspaces/7e0a1b2c-3d4e-5f60-8798-aabbccddeeff/operations?since=4")).toBe("/v1/workspaces/:id/operations");
    expect(normalizeRoute("/api/v1/health")).toBe("/api/v1/health");
    expect(normalizeRoute("/")).toBe("/");
    expect(normalizeRoute("/v1/tasks/Ship%20the%20billing%20page")).toBe("/v1/tasks/:id");
  });

  it("names the error type only when it is a plain identifier", () => {
    const named = Object.assign(new Error("x"), { name: "PayloadTooLargeError" });
    expect(buildEvent(named, { route: "/", method: "GET" }, "test").exception.values[0]?.type).toBe("PayloadTooLargeError");
    const hostile = Object.assign(new Error("x"), { name: "/Users/ana/secret.ts" });
    expect(buildEvent(hostile, { route: "/", method: "GET" }, "test").exception.values[0]?.type).toBe("Error");
    expect(buildEvent("thrown string", { route: "/", method: "GET" }, "test").exception.values[0]?.value).toBe("thrown string");
  });
});

describe("observeRequest", () => {
  it("reports a 5xx response with route, method, status and request id", async () => {
    const sent: SentryEvent[] = [];
    const reporter = createErrorReporter({ dsn: DSN, transport: async (event) => { sent.push(event); } });
    const response = fakeResponse(503);

    observeRequest(reporter, fakeRequest("/v1/workspaces/7e0a1b2c3d4e/tasks", "POST", { "x-vercel-id": "iad1::xyz" }), response);
    response.finish();
    await reporter.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.tags).toEqual({ route: "/v1/workspaces/:id/tasks", method: "POST", status: "503", request_id: "iad1::xyz" });
    expect(sent[0]?.transaction).toBe("POST /v1/workspaces/:id/tasks");
  });

  it("ignores responses below 500 and rejects a client-supplied request id that is not id-shaped", async () => {
    const sent: SentryEvent[] = [];
    const reporter = createErrorReporter({ dsn: DSN, transport: async (event) => { sent.push(event); } });
    const response = fakeResponse(404);

    const context = observeRequest(reporter, fakeRequest("/v1/tasks", "GET", { "x-request-id": "/Users/ana/secret.ts" }), response);
    response.finish();
    await reporter.flush();

    expect(context.requestId).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("swallows a transport failure rather than failing the request", async () => {
    const reporter = createErrorReporter({ dsn: DSN, transport: () => Promise.reject(new Error("sentry is down")) });

    reporter.capture(new Error("boom"), { route: "/v1/tasks", method: "GET" });

    await expect(reporter.flush()).resolves.toBeUndefined();
  });
});
