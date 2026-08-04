import { describe, expect, it } from "vitest";
import { cliSignInUrl, resolveWebUrl, startLoginCallbackServer, type LoginCallbackServer } from "./browser-login.js";
import { DEFAULT_WEB_URL } from "./hosted.js";

async function post(server: LoginCallbackServer, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/callback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function payload(server: LoginCallbackServer, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: server.state,
    access_token: "eyJhbGciOi.access.signature",
    refresh_token: "refresh-token-value",
    expires_at: 1_800_000_000,
    user: { id: "user-1", email: "alice@example.com" },
    ...overrides
  };
}

describe("crosscode login callback server", () => {
  it("mints a 32-character state and accepts the session the website posts back", async () => {
    const server = await startLoginCallbackServer();
    try {
      expect(server.state).toMatch(/^[0-9a-f]{32}$/);
      const response = await post(server, payload(server));
      expect(response.status).toBe(200);
      await expect(server.session).resolves.toMatchObject({
        access_token: "eyJhbGciOi.access.signature",
        user: { id: "user-1", email: "alice@example.com" }
      });
    } finally {
      await server.close();
    }
  });

  it("answers the CORS preflight so the fetch from the website is allowed", async () => {
    const server = await startLoginCallbackServer();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/callback`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
      expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
    } finally {
      await server.close();
    }
  });

  it("rejects a callback whose state does not match, and one with no state at all", async () => {
    for (const body of [{ state: "not-the-state" }, {}]) {
      const server = await startLoginCallbackServer();
      try {
        const response = await post(server, { ...payload(server), ...body, state: (body as { state?: string }).state });
        expect(response.status).toBe(400);
        await expect(server.session).rejects.toMatchObject({ code: "LOGIN_STATE_MISMATCH" });
      } finally {
        await server.close();
      }
    }
  });

  it("rejects a state-matching callback that is missing session fields", async () => {
    const server = await startLoginCallbackServer();
    try {
      const response = await post(server, { state: server.state, access_token: "only-this" });
      expect(response.status).toBe(400);
      await expect(server.session).rejects.toMatchObject({ code: "LOGIN_CALLBACK_INVALID" });
    } finally {
      await server.close();
    }
  });

  it("times out when no callback ever arrives", async () => {
    const server = await startLoginCallbackServer({ timeoutMs: 20 });
    try {
      await expect(server.session).rejects.toMatchObject({
        code: "LOGIN_TIMEOUT",
        hint: expect.stringContaining("--no-browser")
      });
    } finally {
      await server.close();
    }
  });
});

describe("sign-in URL resolution", () => {
  it("builds the frozen /auth/cli.html URL with the port and state", () => {
    expect(cliSignInUrl("https://example.test", 5678, "abc")).toBe("https://example.test/auth/cli.html?port=5678&state=abc");
  });

  it("prefers --web, then CROSSCODE_WEB_URL, then the hosted default", () => {
    const previousWeb = process.env.CROSSCODE_WEB_URL;
    const previousDashboard = process.env.CROSSCODE_DASHBOARD_URL;
    try {
      process.env.CROSSCODE_WEB_URL = "https://env.test/";
      expect(resolveWebUrl("https://flag.test/")).toBe("https://flag.test");
      expect(resolveWebUrl()).toBe("https://env.test");
      delete process.env.CROSSCODE_WEB_URL;
      delete process.env.CROSSCODE_DASHBOARD_URL;
      // Falling back to the hosted site is what makes bare `crosscode login` work.
      expect(resolveWebUrl()).toBe(DEFAULT_WEB_URL);
      expect(DEFAULT_WEB_URL).not.toMatch(/\/$/);
    } finally {
      if (previousWeb === undefined) delete process.env.CROSSCODE_WEB_URL; else process.env.CROSSCODE_WEB_URL = previousWeb;
      if (previousDashboard === undefined) delete process.env.CROSSCODE_DASHBOARD_URL; else process.env.CROSSCODE_DASHBOARD_URL = previousDashboard;
    }
  });
});
