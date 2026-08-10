import { describe, expect, it, vi } from "vitest";
import { cliSignInUrl, configuredWebUrl, resolveWebUrl, startLoginCallbackServer, type LoginCallbackServer } from "./browser-login.js";
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

/**
 * Whether the login has settled either way. A pending promise cannot be observed directly,
 * so it races a tick of the event loop: nothing here waits on a duration, and a promise that
 * has already settled wins that race however loaded the machine is.
 */
async function settled(server: LoginCallbackServer): Promise<boolean> {
  const pending = Symbol("pending");
  const raced = await Promise.race([
    server.session.then(() => true, () => true),
    new Promise<typeof pending>((resolve) => setImmediate(() => resolve(pending)))
  ]);
  return raced !== pending;
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

  /**
   * Refusing the *request* and not the login is a deliberate change of contract. Anything on
   * this machine can POST here once it guesses the ephemeral port -- a stale tab from an
   * earlier `crosscode login`, or a page that is fishing for it -- and failing the whole
   * login on one of those meant any of them could kill a sign-in the user was in the middle
   * of, with a state-mismatch error they did not cause. The real callback is still coming.
   */
  it("refuses a callback whose state does not match while the login keeps waiting", async () => {
    for (const body of [{ state: "not-the-state" }, {}]) {
      const server = await startLoginCallbackServer();
      try {
        const response = await post(server, { ...payload(server), ...body, state: (body as { state?: string }).state });
        expect(response.status).toBe(400);
        await expect(settled(server)).resolves.toBe(false);

        // ...and the sign-in the user actually started still completes.
        expect((await post(server, payload(server))).status).toBe(200);
        await expect(server.session).resolves.toMatchObject({ user: { email: "alice@example.com" } });
      } finally {
        await server.close();
      }
    }
  });

  /**
   * The body was buffered with no ceiling, so any local page that found the port could POST
   * unbounded data into the CLI's memory for as long as a login was pending.
   */
  it("refuses a callback body past the cap, and the login is untouched by it", async () => {
    const server = await startLoginCallbackServer();
    try {
      // Well past the 64KiB cap, and valid JSON, so nothing but the size can be refusing it.
      const response = await post(server, { ...payload(server), padding: "x".repeat(512 * 1024) });
      expect(response.status).toBe(413);
      await expect(settled(server)).resolves.toBe(false);

      expect((await post(server, payload(server))).status).toBe(200);
      await expect(server.session).resolves.toMatchObject({ user: { email: "alice@example.com" } });
    } finally {
      await server.close();
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

  // The legacy name still has to work -- someone set it before the dashboard was deleted --
  // but the notice must never touch stdout, which `--json` promises is one line of JSON and
  // nothing else. A warning printed there would break every agent parsing that line.
  it("still honours the deprecated CROSSCODE_DASHBOARD_URL, warning on stderr and never stdout", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const previousWeb = process.env.CROSSCODE_WEB_URL;
    const previousDashboard = process.env.CROSSCODE_DASHBOARD_URL;
    try {
      delete process.env.CROSSCODE_WEB_URL;
      process.env.CROSSCODE_DASHBOARD_URL = "https://legacy.test/";
      expect(configuredWebUrl()).toBe("https://legacy.test/");
      expect(resolveWebUrl()).toBe("https://legacy.test");

      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls[0]![0]).toContain("CROSSCODE_DASHBOARD_URL is deprecated");

      // CROSSCODE_WEB_URL wins when both are set, and that path warns about nothing.
      process.env.CROSSCODE_WEB_URL = "https://current.test/";
      expect(configuredWebUrl()).toBe("https://current.test/");
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      if (previousWeb === undefined) delete process.env.CROSSCODE_WEB_URL; else process.env.CROSSCODE_WEB_URL = previousWeb;
      if (previousDashboard === undefined) delete process.env.CROSSCODE_DASHBOARD_URL; else process.env.CROSSCODE_DASHBOARD_URL = previousDashboard;
    }
  });
});
