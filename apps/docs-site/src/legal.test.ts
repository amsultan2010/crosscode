// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

// A variable specifier because the modules under test are plain JavaScript and the root
// tsconfig compiles TypeScript only; the imports still resolve at run time.
const LEGAL = "./legal.js";
const DEVICE = "./device.js";
const JOIN = "./join.js";
const AUTH_FORM = "../auth/src/auth-form.js";

type Legal = { documents: { document: string; version: string; url: string }[]; required: string[] };
type LegalModule = {
  fetchLegal: (options?: { serviceUrl?: string; fetchImpl?: typeof fetch }) => Promise<Legal | undefined>;
  fetchOutstanding: (options: { accessToken?: string; serviceUrl?: string; fetchImpl?: typeof fetch }) => Promise<{ outstanding: string[] } | undefined>;
  acceptancePayload: (legal: Legal) => Record<string, string>;
  recordAcceptance: (options: { surface: string; legal: Legal; accessToken?: string; serviceUrl?: string; fetchImpl?: typeof fetch }) => Promise<{ status: string }>;
  consentFieldHtml: (options: { legal: Legal; id?: string; ageGate?: boolean }) => string;
  consentGiven: (root: HTMLElement, id?: string) => boolean;
  showConsentError: (root: HTMLElement, message: string, id?: string) => void;
};

const load = () => import(LEGAL) as Promise<LegalModule>;

const LEGAL_DOCUMENTS: Legal = {
  documents: [
    { document: "terms", version: "2026-08-01", url: "/docs/terms.html" },
    { document: "privacy", version: "2026-08-01", url: "/docs/privacy-policy.html" }
  ],
  required: ["terms", "privacy"]
};

const enveloped = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), {
  status: 200, headers: { "content-type": "application/json" }
});

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

/**
 * A pre-ticked consent box is void under GDPR and weak everywhere else, so this is asserted
 * rather than trusted: nothing in this module produces a `checked` attribute, and the box is
 * not consent until somebody ticks it themselves.
 */
describe("the consent control", () => {
  it("is a real, unticked checkbox with a label that points at it", async () => {
    const { consentFieldHtml, consentGiven } = await load();

    const html = consentFieldHtml({ legal: LEGAL_DOCUMENTS });
    const root = mount(html);
    const box = root.querySelector("input[type=checkbox]") as HTMLInputElement;

    expect(html).not.toContain("checked");
    expect(box.checked).toBe(false);
    expect(consentGiven(root)).toBe(false);
    expect(root.querySelector(`label[for="${box.id}"]`)).not.toBeNull();

    box.checked = true;
    expect(consentGiven(root)).toBe(true);
  });

  it("shows the version beside each link, so the text recorded is the text on screen", async () => {
    const { consentFieldHtml } = await load();

    const root = mount(consentFieldHtml({ legal: LEGAL_DOCUMENTS }));

    expect(root.textContent).toContain("version 2026-08-01");
    expect(root.querySelector('a[href="/docs/terms.html"]')).not.toBeNull();
    expect(root.querySelector('a[href="/docs/privacy-policy.html"]')).not.toBeNull();
  });

  // Terms §3 requires 16 or over. One line next to the control, on the surface where an
  // account is made -- not an age-verification system.
  it("states the age requirement where an account is created, and describes the box with it", async () => {
    const { consentFieldHtml } = await load();

    const signup = mount(consentFieldHtml({ legal: LEGAL_DOCUMENTS, ageGate: true }));
    const elsewhere = mount(consentFieldHtml({ legal: LEGAL_DOCUMENTS }));

    expect(signup.textContent).toContain("at least 16");
    expect(elsewhere.textContent).not.toContain("at least 16");
    const described = (signup.querySelector("input") as HTMLInputElement).getAttribute("aria-describedby") ?? "";
    expect(described.split(" ")).toContain("accept-terms-hint");
    expect(described.split(" ")).toContain("accept-terms-error");
  });

  it("puts a refusal in the live region the checkbox already points at", async () => {
    const { consentFieldHtml, showConsentError } = await load();
    const root = mount(consentFieldHtml({ legal: LEGAL_DOCUMENTS }));

    showConsentError(root, "Tick the box.");

    const error = root.querySelector("#accept-terms-error") as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe("Tick the box.");
  });
});

describe("recording an acceptance", () => {
  it("posts the versions it was told to display, with the surface it was displayed on", async () => {
    const { fetchLegal, recordAcceptance } = await load();
    const seen: { url: string; authorization?: string; body: unknown }[] = [];
    const fetchImpl = (async (url: URL, init?: RequestInit) => {
      if (!init) return enveloped(LEGAL_DOCUMENTS);
      seen.push({
        url: String(url),
        authorization: (init.headers as Record<string, string>).authorization,
        body: JSON.parse(String(init.body))
      });
      return enveloped({ accepted: {}, outstanding: [] });
    }) as unknown as typeof fetch;

    const legal = await fetchLegal({ serviceUrl: "https://service.example", fetchImpl });
    const result = await recordAcceptance({ surface: "device", legal: legal!, accessToken: "access", serviceUrl: "https://service.example", fetchImpl });

    expect(result).toEqual({ status: "recorded" });
    expect(seen).toEqual([{
      url: "https://service.example/v1/legal/acceptances",
      authorization: "Bearer access",
      // Straight from GET /v1/legal. The page never composes a version of its own.
      body: { surface: "device", documents: { terms: "2026-08-01", privacy: "2026-08-01" } }
    }]);
  });

  it("reports a text that changed while the page was open as its own thing, not as a failure", async () => {
    const { recordAcceptance } = await load();
    const respond = (status: number) => (async () => new Response("", { status })) as unknown as typeof fetch;

    expect(await recordAcceptance({ surface: "join", legal: LEGAL_DOCUMENTS, accessToken: "a", serviceUrl: "https://s.example", fetchImpl: respond(409) })).toEqual({ status: "stale" });
    expect(await recordAcceptance({ surface: "join", legal: LEGAL_DOCUMENTS, accessToken: "a", serviceUrl: "https://s.example", fetchImpl: respond(500) })).toEqual({ status: "unreachable" });
    expect(await recordAcceptance({ surface: "join", legal: LEGAL_DOCUMENTS, accessToken: undefined, serviceUrl: "https://s.example", fetchImpl: respond(200) })).toEqual({ status: "signed-out" });
  });

  it("treats an unreachable service as no versions at all, rather than inventing one", async () => {
    const { fetchLegal, fetchOutstanding } = await load();
    const offline = (async () => { throw new Error("network"); }) as unknown as typeof fetch;

    expect(await fetchLegal({ serviceUrl: "https://s.example", fetchImpl: offline })).toBeUndefined();
    expect(await fetchOutstanding({ accessToken: "a", serviceUrl: "https://s.example", fetchImpl: offline })).toBeUndefined();
    expect(await fetchOutstanding({ accessToken: undefined, serviceUrl: "https://s.example", fetchImpl: offline })).toBeUndefined();
  });
});

describe("the surfaces that show it", () => {
  it("puts the checkbox in the /device form, beside the button that signs a terminal in", async () => {
    const { renderDevice } = await import(DEVICE) as { renderDevice: (root: HTMLElement, state: unknown) => void };
    const root = document.createElement("div");

    renderDevice(root, { status: "ready", needsConsent: true, legal: LEGAL_DOCUMENTS });

    const box = root.querySelector("[data-device-form] input[type=checkbox]") as HTMLInputElement;
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);
    expect(root.querySelector('[data-device-form] a[href="/docs/terms.html"]')).not.toBeNull();
  });

  it("leaves the /device form alone for somebody who has already accepted the current version", async () => {
    const { renderDevice } = await import(DEVICE) as { renderDevice: (root: HTMLElement, state: unknown) => void };
    const root = document.createElement("div");

    renderDevice(root, { status: "ready", needsConsent: false, legal: LEGAL_DOCUMENTS });

    expect(root.querySelector("input[type=checkbox]")).toBeNull();
    expect(root.querySelector("[data-device-form]")).not.toBeNull();
  });

  /**
   * An invitee arrives here having never seen the terms, and redeeming is what puts their
   * checkout in a room. So the consent screen comes first and shows nothing to copy.
   */
  it("asks an invitee before it shows them anything to paste", async () => {
    const { renderJoinConsent } = await import(JOIN) as { renderJoinConsent: (root: HTMLElement, state: unknown) => void };
    const root = document.createElement("div");

    renderJoinConsent(root, { legal: LEGAL_DOCUMENTS });

    const box = root.querySelector("[data-consent-form] input[type=checkbox]") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(root.querySelector("pre")).toBeNull();
    expect(root.textContent).toContain("working tree");
  });

  it("puts the checkbox and the age line on sign-up, and the notice above the button on sign-in", async () => {
    const { legalNoticeHtml } = await import(AUTH_FORM) as {
      legalNoticeHtml: (isSignup: boolean, legal: Legal) => string;
    };

    const signup = mount(legalNoticeHtml(true, LEGAL_DOCUMENTS));
    const signin = mount(legalNoticeHtml(false, LEGAL_DOCUMENTS));

    expect((signup.querySelector("input[type=checkbox]") as HTMLInputElement).checked).toBe(false);
    expect(signup.textContent).toContain("at least 16");
    // Sign-in uses the adjacent-statement form rather than a second checkbox, and still
    // names both documents and their versions.
    expect(signin.querySelector("input")).toBeNull();
    expect(signin.textContent).toContain("by signing in you agree");
    expect(signin.textContent).toContain("version 2026-08-01");
    expect(signin.querySelector('a[href="/docs/privacy-policy.html"]')).not.toBeNull();
  });
});
