// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

// A variable specifier because the module under test is plain JavaScript and the root
// tsconfig compiles TypeScript only; the import still resolves at run time.
const DEVICE = "./device.js";

type DeviceState = { status: string; userCode?: string; staleSession?: boolean };
type DeviceModule = {
  normalizeUserCode: (input: unknown) => string | undefined;
  bindDeviceCode: (options: { userCode?: unknown; session?: unknown; serviceUrl?: string; fetchImpl?: typeof fetch }) => Promise<DeviceState>;
  renderDevice: (root: HTMLElement, state: DeviceState) => void;
};

const load = () => import(DEVICE) as Promise<DeviceModule>;

const SESSION = { access_token: "access", refresh_token: "refresh", provider_token: "gho_provider" };

function respond(status: number): typeof fetch {
  return (async () => new Response(status === 200 ? JSON.stringify({ ok: true, data: { status: "bound" } }) : "", { status })) as unknown as typeof fetch;
}

describe("the code the visitor types", () => {
  it("is the same code however they type it", async () => {
    const { normalizeUserCode } = await load();

    expect(normalizeUserCode("WDJB-MJHT")).toBe("WDJB-MJHT");
    expect(normalizeUserCode(" wdjb mjht ")).toBe("WDJB-MJHT");
    expect(normalizeUserCode("wdjbmjht")).toBe("WDJB-MJHT");
    expect(normalizeUserCode("WDJB-MJH")).toBeUndefined();
    expect(normalizeUserCode("")).toBeUndefined();
    expect(normalizeUserCode(undefined)).toBeUndefined();
  });
});

describe("handing this browser's session to a terminal", () => {
  it("posts the refresh token and the GitHub token, and authenticates with the access token", async () => {
    const { bindDeviceCode } = await load();
    const seen: { url: string; authorization?: string; body: unknown }[] = [];
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), authorization: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, data: { status: "bound" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const state = await bindDeviceCode({ userCode: "wdjb mjht", session: SESSION, serviceUrl: "https://service.example", fetchImpl });

    expect(state).toEqual({ status: "bound" });
    expect(seen).toEqual([{
      url: "https://service.example/v1/auth/github/device/bind",
      authorization: "Bearer access",
      // The access token is not in the body: it travels where the service can verify it.
      // The GitHub token is, because this handshake is the only moment it exists.
      body: { userCode: "WDJB-MJHT", refreshToken: "refresh", githubToken: "gho_provider" }
    }]);
  });

  it("leaves out a GitHub token the sign-in did not produce, rather than sending an empty one", async () => {
    const { bindDeviceCode } = await load();
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: URL, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true, data: { status: "bound" } }), { status: 200 });
    }) as unknown as typeof fetch;

    await bindDeviceCode({ userCode: "WDJB-MJHT", session: { access_token: "access", refresh_token: "refresh" }, serviceUrl: "https://service.example", fetchImpl });

    expect(body).toEqual({ userCode: "WDJB-MJHT", refreshToken: "refresh" });
  });

  it("never posts a code that is not one, or a session that is not signed in", async () => {
    const { bindDeviceCode } = await load();
    const refuse = (() => { throw new Error("the page called the service when it should not have"); }) as unknown as typeof fetch;

    expect(await bindDeviceCode({ userCode: "nope", session: SESSION, fetchImpl: refuse })).toEqual({ status: "bad-code" });
    expect(await bindDeviceCode({ userCode: "WDJB-MJHT", session: undefined, fetchImpl: refuse })).toEqual({ status: "signed-out" });
  });

  it("turns each refusal into the thing the person should do about it", async () => {
    const { bindDeviceCode } = await load();
    const cases: [number, string][] = [[404, "bad-code"], [410, "expired"], [409, "used"], [403, "not-github"], [500, "unreachable"]];

    for (const [status, expected] of cases) {
      expect(await bindDeviceCode({ userCode: "WDJB-MJHT", session: SESSION, serviceUrl: "https://service.example", fetchImpl: respond(status) }))
        .toEqual({ status: expected });
    }

    const offline = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    expect(await bindDeviceCode({ userCode: "WDJB-MJHT", session: SESSION, serviceUrl: "https://service.example", fetchImpl: offline })).toEqual({ status: "unreachable" });
  });
});

describe("what the page shows", () => {
  it("asks a signed-out visitor to sign in, and asks nobody else to", async () => {
    const { renderDevice } = await load();
    const root = document.createElement("div");

    renderDevice(root, { status: "signed-out" });
    expect(root.querySelector("[data-github-signin]")).not.toBeNull();
    expect(root.querySelector("[data-device-form]")).toBeNull();

    renderDevice(root, { status: "ready" });
    expect(root.querySelector("[data-github-signin]")).toBeNull();
    expect(root.querySelector("[data-device-form]")).not.toBeNull();
  });

  /**
   * Supabase returns the GitHub token once, at sign-in, and never persists it -- so a
   * restored session cannot carry one, and binding it would sign the terminal in while
   * leaving `crosscode join` unable to prove anything to GitHub.
   */
  it("asks a visitor with a restored session to sign in again, and says why", async () => {
    const { renderDevice } = await load();
    const root = document.createElement("div");

    renderDevice(root, { status: "signed-out", staleSession: true });

    expect(root.querySelector("[data-github-signin]")).not.toBeNull();
    expect(root.textContent).toContain("confirm your github access");
  });

  it("keeps a rejected code in the box, and says what was wrong with it", async () => {
    const { renderDevice } = await load();
    const root = document.createElement("div");

    renderDevice(root, { status: "expired", userCode: "WDJB-MJHT" });

    expect(root.querySelector("input")?.value).toBe("WDJB-MJHT");
    expect(root.querySelector("[role=alert]")?.textContent).toContain("expired");
  });

  it("tells a signed-in terminal's owner to go back to it, with nothing left to do here", async () => {
    const { renderDevice } = await load();
    const root = document.createElement("div");

    renderDevice(root, { status: "bound" });

    expect(root.textContent).toContain("signed in");
    expect(root.querySelector("[data-device-form]")).toBeNull();
  });
});
