// Accepting the terms, on every surface that asks.
//
// A link in a footer is browsewrap, and a warranty disclaimer nobody assented to protects
// nobody. So each of the four surfaces a person can arrive through -- sign-up, sign-in, the
// /device page `crosscode start` opens, and a /join/:code invite -- shows an unticked
// checkbox next to the thing they are about to do, and the acceptance is recorded by the
// service. A ticked box that only the browser knows about is not evidence.
//
// Two things this module is deliberately careful about:
//
//   * the version is never hardcoded here. `GET /v1/legal` says which version is current;
//     the page prints that version next to the link, and posts back the same value. The
//     service refuses anything else (409), so "the version we recorded is the version they
//     were shown" is checked rather than assumed.
//   * nothing is pre-ticked. A pre-ticked consent box is void under GDPR and weak
//     everywhere else, and there is no code path here that sets `checked`.

const SERVICE_URL = import.meta.env?.VITE_SERVICE_URL ?? "";

function serviceBase(serviceUrl) {
  return serviceUrl || SERVICE_URL || window.location.origin;
}

/**
 * The documents to show and the version to show them at, straight from the service.
 *
 * Returns undefined when the service cannot be reached. The caller decides what that means:
 * every surface here treats it as "do not proceed", because proceeding would mean acting on
 * an acceptance that was never recorded.
 */
export async function fetchLegal({ serviceUrl, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(new URL("/v1/legal", serviceBase(serviceUrl)));
    if (!response.ok) return undefined;
    const { data } = await response.json();
    return Array.isArray(data?.documents) ? data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What this signed-in person still has to accept, and at which version.
 *
 * `outstanding` is empty for somebody already on the current version, and non-empty both for
 * a brand-new account and for one whose stored version predates a change -- which is the
 * whole of the re-acceptance mechanism the terms promise.
 */
export async function fetchOutstanding({ accessToken, serviceUrl, fetchImpl = fetch }) {
  if (!accessToken) return undefined;
  try {
    const response = await fetchImpl(new URL("/v1/legal/acceptances", serviceBase(serviceUrl)), {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) return undefined;
    const { data } = await response.json();
    return Array.isArray(data?.outstanding) ? data : undefined;
  } catch {
    return undefined;
  }
}

/** The `{ document: version }` map to post, built from exactly what was displayed. */
export function acceptancePayload(legal) {
  return Object.fromEntries((legal?.documents ?? []).map((entry) => [entry.document, entry.version]));
}

/**
 * Records the acceptance server-side. `stale` is the service saying the text changed while
 * this page was open -- the one case where the honest answer is "read it again", not "we
 * recorded it anyway".
 */
export async function recordAcceptance({ surface, legal, accessToken, serviceUrl, fetchImpl = fetch }) {
  if (!accessToken) return { status: "signed-out" };
  const documents = acceptancePayload(legal);
  if (Object.keys(documents).length === 0) return { status: "unreachable" };
  let response;
  try {
    response = await fetchImpl(new URL("/v1/legal/acceptances", serviceBase(serviceUrl)), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ surface, documents })
    });
  } catch {
    return { status: "unreachable" };
  }
  if (response.ok) return { status: "recorded" };
  if (response.status === 409) return { status: "stale" };
  return { status: "unreachable" };
}

/**
 * The control itself: a real checkbox with a real `<label for>`, the version printed beside
 * each link, and an empty live region the caller fills in when somebody submits without it.
 *
 * `ageGate` adds the eligibility line the terms require (§3, 16 or over). It is one sentence
 * next to the box, not an age-verification system.
 */
export function consentFieldHtml({ legal, id = "accept-terms", ageGate = false }) {
  const links = (legal?.documents ?? [])
    .map((entry) => `<a href="${entry.url}" target="_blank" rel="noopener">${DOCUMENT_NAMES[entry.document] ?? entry.document}</a> (version ${escapeHtml(entry.version)})`)
    .join(" and ");
  const hintId = ageGate ? `${id}-hint` : undefined;
  const describedBy = [hintId, `${id}-error`].filter(Boolean).join(" ");
  return `
    <div class="consent">
      <input type="checkbox" id="${id}" name="${id}" aria-describedby="${describedBy}" />
      <label for="${id}">I have read and agree to the ${links}.</label>
      ${ageGate ? `<p class="muted" id="${hintId}">You must be at least 16 to use Crosscode.</p>` : ""}
      <p class="error" id="${id}-error" role="alert" hidden></p>
    </div>`;
}

const DOCUMENT_NAMES = { terms: "Terms of Service", privacy: "Privacy Policy", dpa: "Data Processing Addendum" };

/** True only if the visitor ticked the box themselves. Nothing here ever ticks it for them. */
export function consentGiven(root, id = "accept-terms") {
  return Boolean(root.querySelector(`#${id}`)?.checked);
}

export function showConsentError(root, message, id = "accept-terms") {
  const element = root.querySelector(`#${id}-error`);
  if (!element) return;
  element.textContent = message;
  element.hidden = false;
}

/** The message for each way recording an acceptance can fail. */
export const CONSENT_MESSAGES = {
  unticked: "Tick the box to say you agree, then try again.",
  stale: "The terms changed while this page was open. Reload the page and read them again.",
  unreachable: "Couldn't record your acceptance. Try again in a moment.",
  "signed-out": "Sign in first, then accept the terms."
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
