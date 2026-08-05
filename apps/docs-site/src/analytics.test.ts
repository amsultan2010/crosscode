// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// A variable specifier because the module under test is plain JavaScript and the root
// tsconfig compiles TypeScript only; the import still resolves at run time.
const ANALYTICS = "./analytics.js";

async function loadAnalytics(key?: string) {
  vi.resetModules();
  if (key === undefined) vi.stubEnv("VITE_POSTHOG_KEY", "");
  else vi.stubEnv("VITE_POSTHOG_KEY", key);
  return import(ANALYTICS) as Promise<{ capture: (event: string, properties?: Record<string, unknown>) => void }>;
}

/** Typed parameters so the call tuples below are ordinary [url, init] pairs. */
function stubFetch() {
  const fetchSpy = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response("")));
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function landingPageWithCopyButton() {
  window.history.replaceState({}, "", "/");
  document.body.innerHTML = `<button data-copy-target="install-prompt-text" type="button">Copy install prompt</button>`;
  return document.querySelector("button") as HTMLButtonElement;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  sessionStorage.clear();
  localStorage.clear();
});

describe("site analytics without a PostHog key", () => {
  it("sends nothing on load, on a copy click, or on an explicit capture", async () => {
    const fetchSpy = stubFetch();
    const button = landingPageWithCopyButton();

    const analytics = await loadAnalytics(undefined);
    button.click();
    analytics.capture("landing_page_view");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem("crosscode_distinct_id")).toBeNull();
  });
});

describe("site analytics with a PostHog key", () => {
  it("captures the landing page view and the install prompt copy", async () => {
    const fetchSpy = stubFetch();
    const button = landingPageWithCopyButton();

    await loadAnalytics("phc_test_key");
    button.click();

    const events = fetchSpy.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(events.map((event) => event.event)).toEqual(["landing_page_view", "install_prompt_copied"]);
    expect(events[0].api_key).toBe("phc_test_key");
    expect(events[0].distinct_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://us.i.posthog.com/i/v0/e/");
  });

  it("counts sign_up_started once even when a link click and a form submit both fire", async () => {
    const fetchSpy = stubFetch();
    window.history.replaceState({}, "", "/auth/signup.html");
    document.body.innerHTML = `
      <a href="/auth/signup.html">Create an account</a>
      <div id="auth">
        <div class="auth-tabs"><button data-mode="signin"></button><button data-mode="signup" class="active"></button></div>
        <form id="auth-form"><button type="submit">Sign up</button></form>
        <p id="auth-status" hidden></p>
      </div>`;

    await loadAnalytics("phc_test_key");
    document.querySelector("a")?.click();
    document.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    const events = fetchSpy.mock.calls.map(([, init]) => JSON.parse(String(init.body)).event);
    expect(events).toEqual(["sign_up_started"]);
  });

  it("captures sign_up_completed when the page asks the visitor to confirm by email", async () => {
    const fetchSpy = stubFetch();
    window.history.replaceState({}, "", "/auth/signup.html");
    document.body.innerHTML = `<div id="auth"><form id="auth-form"></form><p id="auth-status" hidden></p></div>`;

    await loadAnalytics("phc_test_key");
    const status = document.querySelector("#auth-status") as HTMLParagraphElement;
    status.textContent = "Check your email to confirm your account, then sign in.";
    status.hidden = false;
    await vi.waitFor(() => {
      expect(fetchSpy.mock.calls.some(([, init]) => JSON.parse(String(init.body)).event === "sign_up_completed")).toBe(true);
    });
  });

  it("does not treat a sign-in submit on the shared form as a sign-up", async () => {
    const fetchSpy = stubFetch();
    window.history.replaceState({}, "", "/auth/signin.html");
    document.body.innerHTML = `
      <div id="auth">
        <div class="auth-tabs"><button data-mode="signin" class="active"></button><button data-mode="signup"></button></div>
        <form id="auth-form"></form>
      </div>`;

    await loadAnalytics("phc_test_key");
    document.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
