import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createServerlessHandler } from "./serverless.js";

function request(url: string, method = "GET"): IncomingMessage {
  return { url, method, headers: {}, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
}

function response(): ServerResponse & { statusCode: number } {
  const res = {
    statusCode: 0,
    setHeader() {},
    end() {},
    writeHead(this: { statusCode: number }, status: number) { this.statusCode = status; return this; }
  };
  return res as unknown as ServerResponse & { statusCode: number };
}

describe("serverless adapter", () => {
  it("answers the health probe without reading any configuration", async () => {
    const handler = createServerlessHandler({});
    const res = response();
    await handler(request("/health"), res);
    expect(res.statusCode).toBe(200);
  });

  // A missing variable fails every database-backed request while /health keeps answering
  // 200, so the probe must not be the only thing anyone looks at. The Sentry capture that
  // now wraps this construction cannot be asserted here -- createServerlessHandler builds
  // its own reporter and takes no transport -- so it is verified against the live
  // deployment instead; what this pins is that the failure still surfaces, loudly and by
  // name, rather than being swallowed by the try/catch that reports it.
  it("still rethrows a configuration failure, naming the missing variable", async () => {
    const handler = createServerlessHandler({ SUPABASE_URL: "https://project.supabase.co" });
    await expect(handler(request("/v1/changes"), response())).rejects.toThrow(/DATABASE_URL/);
  });
});
