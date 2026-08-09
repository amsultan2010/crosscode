// The receiving half of onboarding: /join/:code.
//
// `crosscode invite` prints https://www.getcrosscode.dev/join/7f3a9c2e. Whoever opens that link
// signs in with GitHub, and this page then verifies they actually have access to the repo
// before it shows them anything. If they do, they get one copy-paste block of two lines and
// nothing else -- two pasted lines is the entire onboarding budget.
//
// The verification is `POST /v1/invites/:code/redeem`, the route the wire contract already
// defines. It gates redemption on repo access and answers with the repo and the clone
// command, which is exactly what this page needs to render; a separate "can I?" route would
// be a second implementation of the same check that could disagree with it.

// An invitee arrives here having never seen the terms, so this page asks before it redeems
// anything. The service enforces the same order -- `POST /v1/invites/:code/redeem` refuses an
// account with no current acceptance recorded -- so the checkbox below is the gate rather
// than a courtesy, and redeeming is what turns this browser into a member of a room.

import { consentFieldHtml, consentGiven, CONSENT_MESSAGES, fetchLegal, fetchOutstanding, recordAcceptance, showConsentError } from "./legal.js";

const SERVICE_URL = import.meta.env?.VITE_SERVICE_URL ?? "";

/**
 * The URL carries the raw code, the human types the grouped form. One value, two spellings,
 * so the page derives the typed one rather than the invite carrying both.
 */
export function inviteCodeFromPath(pathname) {
  const raw = /^\/join\/([0-9a-fA-F]{8})\/?$/.exec(pathname)?.[1];
  if (!raw) return undefined;
  const upper = raw.toUpperCase();
  return `CC-${upper.slice(0, 4)}-${upper.slice(4)}`;
}

/**
 * What the visitor is allowed to see. `no-access` is the case that matters: an invite link is
 * a URL anyone can forward, so having the link is not evidence of anything. The repo is the
 * gate.
 */
export async function resolveJoin({ code, accessToken, githubToken, serviceUrl = SERVICE_URL, fetchImpl = fetch }) {
  if (!code) return { status: "bad-link" };
  if (!accessToken) return { status: "signed-out" };
  // Redeeming asks GitHub whether *this* visitor can read the repo, and only the visitor's
  // own OAuth token can answer that. Supabase hands it over at sign-in and does not keep
  // it, so a session restored from storage has none -- which is a sign-out, not a denial.
  if (!githubToken) return { status: "signed-out" };

  let response;
  try {
    response = await fetchImpl(new URL(`/v1/invites/${encodeURIComponent(code)}/redeem`, serviceUrl || window.location.origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "x-crosscode-github-token": githubToken
      },
      body: "{}"
    });
  } catch {
    return { status: "unreachable" };
  }

  // 403 is the service saying this GitHub account is not on the repo. 404 is a code that
  // expired or was never real. Neither may reveal the repo name -- that would turn the link
  // into a way to enumerate private repositories.
  if (response.status === 401 || response.status === 403) return { status: "no-access" };
  if (response.status === 404 || response.status === 410) return { status: "expired" };
  if (!response.ok) return { status: "unreachable" };

  // Every service route answers `{ ok, data }`, so the invite itself is one level in.
  // Reading it off the envelope is why a *successful* redeem used to render as "unreachable".
  const { data } = await response.json();
  if (!data?.repo || !data?.cloneCommand) return { status: "unreachable" };
  return { status: "ready", code, repo: data.repo, cloneCommand: data.cloneCommand };
}

/** The whole of onboarding, as text. Two lines; a third would be a bug. */
export function commandBlock({ cloneCommand, code }) {
  return `${cloneCommand}\ncrosscode join ${code}`;
}

const MESSAGES = {
  "bad-link": ["that link isn't a crosscode invite", "ask whoever invited you to run <code>crosscode invite</code> again and send you the new link."],
  expired: ["this invite has expired", "invite links last a week. ask whoever invited you for a fresh one."],
  unreachable: ["couldn't check this invite", "something went wrong reaching crosscode. reload the page in a moment."],
  "no-access": [
    "you don't have access to this repository",
    "crosscode only syncs a repository you can already open on github, signed in as the account you just used. ask the repository's owner for access, then reload this page."
  ]
};

export function renderJoin(root, state) {
  if (state.status === "signed-out") {
    root.innerHTML = `
      <h1>you've been invited to a crosscode project</h1>
      <p>sign in with github so we can check you have access to the repository.</p>
      <button type="button" class="button" data-github-signin>sign in with github</button>`;
    return;
  }

  if (state.status !== "ready") {
    const [title, detail] = MESSAGES[state.status] ?? MESSAGES.unreachable;
    root.innerHTML = `<h1>${title}</h1><p>${detail}</p>`;
    return;
  }

  const block = commandBlock(state);
  root.innerHTML = `
    <h1>you're on ${escapeHtml(state.repo)}</h1>
    <p>paste these two lines into your terminal. that's the whole setup.</p>
    <pre id="join-commands"><code>${escapeHtml(block)}</code></pre>
    <button type="button" class="button" data-copy-target="join-commands">copy</button>
    <p class="muted">don't have the cli yet? <code>npm install -g crosscode-cli</code></p>`;
}

/**
 * The one screen between an invite link and a redemption: what Crosscode will do to this
 * person's checkout, and an unticked box saying they agree to the terms that disclaim it.
 */
export function renderJoinConsent(root, state) {
  root.innerHTML = `
    <h1>you've been invited to a crosscode project</h1>
    <p>
      crosscode syncs uncommitted working-tree files between checkouts of the same repository.
      your teammates' edits are written into your working tree, and the files you edit are held
      by the hosted service for about seven days.
    </p>
    <form data-consent-form class="stack">
      ${consentFieldHtml({ legal: state.legal })}
      <button type="submit">accept and join</button>
    </form>`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

/**
 * Browser entry. Guarded so importing this module in a test does not try to mount it, and so
 * the Supabase client -- which needs env vars the test does not set -- is only loaded on the
 * page that actually signs someone in.
 */
export async function mountJoinPage(root, { location = window.location } = {}) {
  const { getSupabaseClient } = await import("../auth/src/supabase.js");
  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getSession();
  const code = inviteCodeFromPath(location.pathname);
  const accessToken = data.session?.access_token;
  const githubToken = data.session?.provider_token ?? undefined;

  const signIn = () => {
    root.querySelector("[data-github-signin]")?.addEventListener("click", () => {
      // Back to this same URL: the code is in the path, so the round trip through GitHub
      // keeps it without a query parameter to carry.
      void supabase.auth.signInWithOAuth({ provider: "github", options: { redirectTo: location.href } });
    });
  };

  const redeem = async () => {
    const state = await resolveJoin({ code, accessToken, githubToken });
    renderJoin(root, state);
    signIn();
    root.querySelector("[data-copy-target]")?.addEventListener("click", (event) => {
      void navigator.clipboard.writeText(commandBlock(state));
      event.currentTarget.textContent = "copied";
    });
  };

  // Consent is asked for before the redeem call, not after: redeeming is what makes this
  // person a member of a room whose files land in their checkout, and the service refuses to
  // do it for an account that has accepted nothing.
  const legal = accessToken && githubToken ? await fetchLegal() : undefined;
  const outstanding = legal ? await fetchOutstanding({ accessToken }) : undefined;
  if (legal && (outstanding?.outstanding?.length ?? 1) > 0) {
    renderJoinConsent(root, { legal });
    root.querySelector("[data-consent-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void (async () => {
        if (!consentGiven(root)) {
          showConsentError(root, CONSENT_MESSAGES.unticked);
          return;
        }
        const recorded = await recordAcceptance({ surface: "join", legal, accessToken });
        if (recorded.status !== "recorded") {
          showConsentError(root, CONSENT_MESSAGES[recorded.status] ?? CONSENT_MESSAGES.unreachable);
          return;
        }
        await redeem();
      })();
    });
    return;
  }

  await redeem();
}
