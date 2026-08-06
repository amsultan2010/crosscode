// Product analytics for the marketing site: four events that answer one question, which is
// whether anyone gets from the landing page to an account.
//
//   landing_page_view      the landing page was opened
//   install_prompt_copied  a "Copy install prompt" or "Copy command" button was used
//   sign_up_started        the sign-up form was submitted, an OAuth button was clicked, or
//                          a link to /auth/signup.html was followed
//   sign_up_completed      sign-up succeeded, whether it issued a session or asked the
//                          visitor to confirm by email
//
// With no VITE_POSTHOG_KEY this file installs no listeners, sets no storage and sends no
// request. That is the state a fork or a local `pnpm docs:dev` runs in.
//
// Nothing persistent is written to the visitor's device: no cookie, and no storage that
// outlives the tab. The id that groups one visit's events lives in `sessionStorage`, so it
// dies with the tab and cannot link today's visit to next week's. Counting a funnel does
// not need to know who you are twice.
//
// It posts to PostHog's capture endpoint directly rather than loading posthog-js. Four
// events do not need 60 kB of autocapture and session recording on a page whose pitch is
// that we cannot read your code, and every field that leaves the browser is listed below.

const KEY = import.meta.env.VITE_POSTHOG_KEY;
const HOST = (import.meta.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com").replace(/\/$/, "");

const VISIT_ID_STORAGE_KEY = "crosscode_visit_id";
const ONCE_PREFIX = "crosscode_analytics_once:";

if (KEY) install();

function install() {
  if (isLandingPage()) capture("landing_page_view");
  document.addEventListener("click", onClick, true);
  document.addEventListener("submit", onSubmit, true);
  watchForSignUpCompletion();
}

function isLandingPage() {
  return location.pathname === "/" || location.pathname.endsWith("/index.html");
}

function onClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.closest("[data-copy-target]")) {
    capture("install_prompt_copied", { path: location.pathname });
    return;
  }
  // Either the OAuth buttons on the sign-up page or a link that leads to it.
  const link = target.closest("a[href]");
  const startsSignUp = target.closest(".auth-oauth-btn") ? isSignUpPage() : link?.getAttribute("href")?.includes("/auth/signup");
  if (startsSignUp) captureOnce("sign_up_started");
}

function onSubmit(event) {
  if (!(event.target instanceof Element) || event.target.id !== "auth-form") return;
  // The form is shared by sign-in and sign-up; the active tab says which one is on screen.
  const activeTab = document.querySelector(".auth-tabs button.active");
  const mode = activeTab?.dataset.mode ?? (isSignUpPage() ? "signup" : "signin");
  if (mode === "signup") captureOnce("sign_up_started");
}

function isSignUpPage() {
  return location.pathname.includes("/auth/signup");
}

/**
 * Sign-up succeeds in one of two ways, and neither is a navigation: the page either
 * replaces the form with the signed-in card (which carries #sign-out) or reveals the
 * "check your email to confirm" status line. Watching the auth container for both keeps
 * this module out of auth/src, which another workstream owns.
 */
function watchForSignUpCompletion() {
  const container = document.querySelector("#auth");
  if (!container || !isSignUpPage()) return;
  const observer = new MutationObserver(() => {
    const status = container.querySelector("#auth-status");
    const succeeded = Boolean(container.querySelector("#sign-out")) || Boolean(status && !status.hidden && status.textContent?.trim());
    if (!succeeded) return;
    observer.disconnect();
    captureOnce("sign_up_completed");
  });
  observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"], characterData: true });
}

/** Once per browser tab session, so a funnel step is not counted twice by two triggers. */
function captureOnce(event, properties) {
  try {
    if (sessionStorage.getItem(ONCE_PREFIX + event)) return;
    sessionStorage.setItem(ONCE_PREFIX + event, "1");
  } catch {
    // Storage denied (private mode, blocked cookies). Send the event anyway.
  }
  capture(event, properties);
}

export function capture(event, properties = {}) {
  if (!KEY) return;
  const body = JSON.stringify({
    api_key: KEY,
    event,
    distinct_id: distinctId(),
    timestamp: new Date().toISOString(),
    properties: { ...properties, $current_url: location.origin + location.pathname, $referrer: document.referrer || undefined }
  });
  // keepalive so the event survives the navigation that often follows the click.
  void fetch(`${HOST}/i/v0/e/`, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true, mode: "cors" })
    .catch(() => undefined);
}

/**
 * A random id for this visit, held in sessionStorage so that the two pages of the funnel
 * (landing, then sign-up) count as one visit. It is gone when the tab closes, so it cannot
 * be used to recognise a returning visitor. No email, no account id, nothing derived from
 * the visitor. If storage is denied, each page load gets its own in-memory id instead.
 */
let inMemoryVisitId;
function distinctId() {
  try {
    const existing = sessionStorage.getItem(VISIT_ID_STORAGE_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(VISIT_ID_STORAGE_KEY, created);
    return created;
  } catch {
    inMemoryVisitId ??= crypto.randomUUID();
    return inMemoryVisitId;
  }
}
