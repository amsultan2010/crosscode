// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

// A variable specifier because the module under test is plain JavaScript and the root
// tsconfig compiles TypeScript only; the import still resolves at run time.
const JOIN = "./join.js";

type JoinState = { status: string; repo?: string; cloneCommand?: string; code?: string };
type JoinModule = {
  inviteCodeFromPath: (pathname: string) => string | undefined;
  resolveJoin: (options: { code?: string; accessToken?: string; githubToken?: string; serviceUrl?: string; fetchImpl?: typeof fetch }) => Promise<JoinState>;
  commandBlock: (state: { cloneCommand: string; code: string }) => string;
  renderJoin: (root: HTMLElement, state: JoinState) => void;
};

const load = () => import(JOIN) as Promise<JoinModule>;

const REDEEMED = { projectId: "p1", repo: "acme/app", cloneCommand: "git clone git@github.com:acme/app.git && cd app" };

/**
 * What the service actually puts on the wire. Every route answers `{ ok, data }`, and this
 * fixture used to be the bare invite -- so the page read `body.repo`, the tests agreed with
 * it, and a *successful* redeem rendered as "unreachable" in production while the suite
 * stayed green. The envelope belongs in the fixture for that reason.
 */
const enveloped = (data: unknown) => ({ ok: true, data });

function respond(status: number, body?: unknown): typeof fetch {
  return (async () => (body === undefined ? new Response("", { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))) as unknown as typeof fetch;
}

describe("the invite code in the link", () => {
  it("becomes the code the visitor types", async () => {
    const { inviteCodeFromPath } = await load();

    expect(inviteCodeFromPath("/join/7f3a9c2e")).toBe("CC-7F3A-9C2E");
    expect(inviteCodeFromPath("/join/7f3a9c2e/")).toBe("CC-7F3A-9C2E");
    expect(inviteCodeFromPath("/join/not-a-code")).toBeUndefined();
    expect(inviteCodeFromPath("/docs/cli")).toBeUndefined();
  });
});

/**
 * An invite link is a URL, and a URL can be forwarded, pasted into a group chat, or found in
 * a log. Having the link is not evidence of anything -- access to the repository is the gate,
 * and it is checked before the page shows the visitor a repo name or a command.
 */
describe("a visitor who does not have access to the repository", () => {
  it("is refused, whether the service says forbidden or unauthorized", async () => {
    const { resolveJoin } = await load();

    for (const status of [401, 403]) {
      expect(await resolveJoin({ code: "CC-7F3A-9C2E", accessToken: "token", githubToken: "gho_visitor", serviceUrl: "https://service.example", fetchImpl: respond(status) })).toEqual({ status: "no-access" });
    }
  });

  it("is shown nothing to copy, and is not told what the repository is called", async () => {
    const { renderJoin } = await load();
    const root = document.createElement("div");

    renderJoin(root, { status: "no-access" });

    expect(root.querySelector("pre")).toBeNull();
    expect(root.querySelector("[data-copy-target]")).toBeNull();
    expect(root.textContent).not.toContain("acme/app");
    expect(root.textContent).toContain("access");
  });

  it("is refused before signing in, rather than being shown the repository first", async () => {
    const { resolveJoin } = await load();
    let called = false;

    const state = await resolveJoin({
      code: "CC-7F3A-9C2E",
      accessToken: undefined,
      serviceUrl: "https://service.example",
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch
    });

    expect(state).toEqual({ status: "signed-out" });
    expect(called).toBe(false);
  });

  it("is told an expired code is expired, not that it lacks access", async () => {
    const { resolveJoin } = await load();

    expect(await resolveJoin({ code: "CC-7F3A-9C2E", accessToken: "token", githubToken: "gho_visitor", serviceUrl: "https://service.example", fetchImpl: respond(404) })).toEqual({ status: "expired" });
  });
});

describe("a visitor who does have access", () => {
  it("gets the repo and the clone command from the contract's redeem response", async () => {
    const { resolveJoin } = await load();
    const seen: string[] = [];

    const state = await resolveJoin({
      code: "CC-7F3A-9C2E",
      accessToken: "token",
      githubToken: "gho_visitor",
      serviceUrl: "https://service.example",
      fetchImpl: (async (url: URL) => {
        seen.push(String(url));
        return new Response(JSON.stringify(enveloped(REDEEMED)), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch
    });

    expect(seen).toEqual(["https://service.example/v1/invites/CC-7F3A-9C2E/redeem"]);
    expect(state).toEqual({ status: "ready", code: "CC-7F3A-9C2E", repo: "acme/app", cloneCommand: REDEEMED.cloneCommand });
  });

  /**
   * Redeeming asks GitHub whether this visitor can read the repo, and only the visitor's own
   * OAuth token can answer. The service requires it as a header and 403s without one, which
   * the page would have shown as "you do not have access" -- a denial it invented itself.
   */
  it("sends its own GitHub token, because that is what the repo check is made with", async () => {
    const { resolveJoin } = await load();
    let sent: Headers | undefined;

    await resolveJoin({
      code: "CC-7F3A-9C2E",
      accessToken: "token",
      githubToken: "gho_visitor",
      serviceUrl: "https://service.example",
      fetchImpl: (async (_url: URL, init: RequestInit) => {
        sent = new Headers(init.headers);
        return new Response(JSON.stringify(enveloped(REDEEMED)), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch
    });

    expect(sent?.get("x-crosscode-github-token")).toBe("gho_visitor");
    expect(sent?.get("authorization")).toBe("Bearer token");
  });

  it("treats a session with no GitHub token as signed out rather than spending a redeem on a certain 403", async () => {
    const { resolveJoin } = await load();
    let called = false;

    const state = await resolveJoin({
      code: "CC-7F3A-9C2E",
      accessToken: "token",
      githubToken: undefined,
      serviceUrl: "https://service.example",
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch
    });

    expect(state).toEqual({ status: "signed-out" });
    expect(called).toBe(false);
  });

  // The budget from PLAN.md, asserted rather than trusted.
  it("is shown exactly two lines to paste", async () => {
    const { commandBlock, renderJoin } = await load();
    const root = document.createElement("div");
    const state = { status: "ready", code: "CC-7F3A-9C2E", repo: "acme/app", cloneCommand: REDEEMED.cloneCommand };

    renderJoin(root, state);

    expect(commandBlock(state).split("\n")).toEqual(["git clone git@github.com:acme/app.git && cd app", "crosscode join CC-7F3A-9C2E"]);
    expect(root.querySelector("pre")?.textContent?.trim().split("\n")).toHaveLength(2);
  });
});
