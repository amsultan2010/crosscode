import { describe, expect, it } from "vitest";
import { githubSignIn } from "./auth.js";

/**
 * The CLI's half of the device handshake, against a scripted service.
 *
 * The shapes here are the ones apps/service/src/http.ts actually sends, envelope included:
 * this file and apps/service/src/device-flow.test.ts describe the two ends of the same
 * wire, and a change to one that is not made to the other should fail here.
 */

const SESSION = { accessToken: "access", refreshToken: "refresh", expiresAt: "2030-01-01T00:00:00.000Z" };

function service(responses: unknown[]): { fetchImpl: typeof fetch; requests: { path: string; body: unknown }[] } {
  const requests: { path: string; body: unknown }[] = [];
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    requests.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (next === undefined) throw new Error("The CLI asked more of the service than the test scripted");
    return Response.json({ ok: true, data: next });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

const started = (overrides: Record<string, unknown> = {}) => ({
  deviceCode: "device-code",
  userCode: "WDJB-MJHT",
  verificationUrl: "https://www.getcrosscode.dev/device",
  intervalSeconds: 1,
  expiresInSeconds: 900,
  ...overrides
});

describe("crosscode's GitHub sign-in", () => {
  it("waits out a pending handshake and keeps the session it is finally handed", async () => {
    const { fetchImpl, requests } = service([
      started(),
      { status: "pending" },
      { status: "complete", session: SESSION, githubToken: "gho_provider" }
    ]);
    const lines: string[] = [];
    let opened: string | undefined;

    const result = await githubSignIn(fetchImpl, (url) => { opened = url; })({
      serviceUrl: "https://service.example",
      openBrowser: true,
      report: (line) => lines.push(line)
    });

    expect(result).toEqual({ session: SESSION, githubToken: "gho_provider" });
    expect(requests.map((request) => request.path)).toEqual([
      "/v1/auth/github/device", "/v1/auth/github/device/token", "/v1/auth/github/device/token"
    ]);
    // Every poll names the code this CLI is holding, and nothing else.
    expect(requests[1]!.body).toEqual({ deviceCode: "device-code" });
    // The two things the human needs: where to go, and what to type when they get there.
    expect(opened).toBe("https://www.getcrosscode.dev/device");
    expect(lines.join("\n")).toContain("https://www.getcrosscode.dev/device");
    expect(lines.join("\n")).toContain("WDJB-MJHT");
  });

  it("prints the URL instead of opening one when there is no browser to open", async () => {
    const { fetchImpl } = service([started(), { status: "complete", session: SESSION }]);
    const lines: string[] = [];
    let opened = false;

    const result = await githubSignIn(fetchImpl, () => { opened = true; })({
      serviceUrl: "https://service.example",
      openBrowser: false,
      report: (line) => lines.push(line)
    });

    expect(opened).toBe(false);
    expect(lines[0]).toContain("https://www.getcrosscode.dev/device");
    // A sign-in that produced no GitHub token is still a sign-in; only `join` needs one.
    expect(result).toEqual({ session: SESSION, githubToken: undefined });
  });

  it("gives up when nobody signs in before the handshake expires", async () => {
    const { fetchImpl } = service([started({ expiresInSeconds: 1 }), { status: "pending" }]);

    await expect(githubSignIn(fetchImpl, () => {})({
      serviceUrl: "https://service.example",
      openBrowser: false,
      report: () => {}
    })).rejects.toMatchObject({ code: "SIGN_IN_TIMED_OUT" });
  });

  it("reports a refusal and an unreachable service as different things", async () => {
    const refusing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(githubSignIn(refusing, () => {})({ serviceUrl: "https://service.example", openBrowser: false, report: () => {} }))
      .rejects.toMatchObject({ code: "SIGN_IN_FAILED" });

    const unreachable = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as typeof fetch;
    await expect(githubSignIn(unreachable, () => {})({ serviceUrl: "https://service.example", openBrowser: false, report: () => {} }))
      .rejects.toMatchObject({ code: "SERVICE_UNREACHABLE" });
  });

  it("refuses a response that is not the handshake it expects, rather than carrying it onward", async () => {
    const { fetchImpl } = service([started(), { status: "complete", session: { accessToken: "access" } }]);

    await expect(githubSignIn(fetchImpl, () => {})({ serviceUrl: "https://service.example", openBrowser: false, report: () => {} }))
      .rejects.toThrow();
  });
});
