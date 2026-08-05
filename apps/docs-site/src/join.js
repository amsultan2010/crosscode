// The receiving half of onboarding: /join/:code.
//
// `crosscode invite` prints https://getcrosscode.dev/join/7f3a9c2e. Whoever opens that link
// signs in with GitHub, and this page then verifies they actually have access to the repo
// before it shows them anything. If they do, they get one copy-paste block of two lines and
// nothing else -- two pasted lines is the entire onboarding budget.
//
// The verification is `POST /v1/invites/:code/redeem`, the route the wire contract already
// defines. It gates redemption on repo access and answers with the repo and the clone
// command, which is exactly what this page needs to render; a separate "can I?" route would
// be a second implementation of the same check that could disagree with it.

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
export async function resolveJoin({ code, accessToken, serviceUrl = SERVICE_URL, fetchImpl = fetch }) {
  if (!code) return { status: "bad-link" };
  if (!accessToken) return { status: "signed-out" };

  let response;
  try {
    response = await fetchImpl(new URL(`/v1/invites/${encodeURIComponent(code)}/redeem`, serviceUrl || window.location.origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
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

  const body = await response.json();
  if (!body?.repo || !body?.cloneCommand) return { status: "unreachable" };
  return { status: "ready", code, repo: body.repo, cloneCommand: body.cloneCommand };
}

/** The whole of onboarding, as text. Two lines; a third would be a bug. */
export function commandBlock({ cloneCommand, code }) {
  return `${cloneCommand}\ncrosscode join ${code}`;
}

const MESSAGES = {
  "bad-link": ["That link isn't a Crosscode invite", "Ask whoever invited you to run <code>crosscode invite</code> again and send you the new link."],
  expired: ["This invite has expired", "Invite links last a week. Ask whoever invited you for a fresh one."],
  unreachable: ["Couldn't check this invite", "Something went wrong reaching Crosscode. Reload the page in a moment."],
  "no-access": [
    "You don't have access to this repository",
    "Crosscode only syncs a repository you can already open on GitHub, signed in as the account you just used. Ask the repository's owner for access, then reload this page."
  ]
};

export function renderJoin(root, state) {
  if (state.status === "signed-out") {
    root.innerHTML = `
      <h1>You've been invited to a Crosscode project</h1>
      <p>Sign in with GitHub so we can check you have access to the repository.</p>
      <button type="button" class="button" data-github-signin>Sign in with GitHub</button>`;
    return;
  }

  if (state.status !== "ready") {
    const [title, detail] = MESSAGES[state.status] ?? MESSAGES.unreachable;
    root.innerHTML = `<h1>${title}</h1><p>${detail}</p>`;
    return;
  }

  const block = commandBlock(state);
  root.innerHTML = `
    <h1>You're on ${escapeHtml(state.repo)}</h1>
    <p>Paste these two lines into your terminal. That's the whole setup.</p>
    <pre id="join-commands"><code>${escapeHtml(block)}</code></pre>
    <button type="button" class="button" data-copy-target="join-commands">Copy</button>
    <p class="muted">Don't have the CLI yet? <code>npm install -g @crosscode/cli</code></p>`;
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
  const state = await resolveJoin({ code, accessToken: data.session?.access_token });
  renderJoin(root, state);

  root.querySelector("[data-github-signin]")?.addEventListener("click", () => {
    // Back to this same URL: the code is in the path, so the round trip through GitHub
    // keeps it without a query parameter to carry.
    void supabase.auth.signInWithOAuth({ provider: "github", options: { redirectTo: location.href } });
  });

  root.querySelector("[data-copy-target]")?.addEventListener("click", (event) => {
    void navigator.clipboard.writeText(commandBlock(state));
    event.currentTarget.textContent = "Copied";
  });
}
