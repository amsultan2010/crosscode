// The browser half of `crosscode start`: /device.
//
// A terminal cannot receive an OAuth redirect, so signing in is a device handshake. The CLI
// prints a URL and a short confirmation code; this page is that URL. Whoever opens it signs
// in with GitHub here, types the code their terminal is showing, and the service hands that
// session to the terminal holding the matching device code.
//
// Two things this page does that are not obvious:
//
//   * it posts the *refresh* token, not just the access token. The access token arrives in
//     the Authorization header where the service can verify it; the refresh token has to
//     travel in the body because nobody but Supabase can verify one, and a daemon that
//     could not refresh would be signed out within the hour.
//   * it posts `provider_token`, the GitHub OAuth token Supabase returns at sign-in and
//     then forgets. `crosscode join` needs it to prove to GitHub that the person joining
//     can actually read the repository, and this handshake is the only moment it exists.

const SERVICE_URL = import.meta.env?.VITE_SERVICE_URL ?? "";

/** One spelling of the code, so "wdjb mjht" and "WDJB-MJHT" are the same thing typed twice. */
export function normalizeUserCode(input) {
  const bare = String(input ?? "").trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z0-9]{8}$/.test(bare)) return undefined;
  return `${bare.slice(0, 4)}-${bare.slice(4)}`;
}

/**
 * Hands this browser's session to the terminal that printed `userCode`.
 *
 * Every refusal the service can give is its own state, because they are different things
 * for the person to do: retype it, ask the terminal for a fresh one, or realise their
 * terminal already picked it up.
 */
export async function bindDeviceCode({ userCode, session, serviceUrl = SERVICE_URL, fetchImpl = fetch }) {
  if (!session?.access_token) return { status: "signed-out" };
  const code = normalizeUserCode(userCode);
  if (!code) return { status: "bad-code" };

  let response;
  try {
    response = await fetchImpl(new URL("/v1/auth/github/device/bind", serviceUrl || window.location.origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({
        userCode: code,
        refreshToken: session.refresh_token,
        ...(session.provider_token ? { githubToken: session.provider_token } : {})
      })
    });
  } catch {
    return { status: "unreachable" };
  }

  if (response.ok) return { status: "bound" };
  if (response.status === 404) return { status: "bad-code" };
  if (response.status === 410) return { status: "expired" };
  // 409 is a code that is spent -- either the terminal already collected it, or somebody
  // else signed it in. Both mean this page has nothing left to do with it.
  if (response.status === 409) return { status: "used" };
  // 403 is a session with no GitHub identity behind it, which the service refuses because
  // everything downstream of sign-in asks GitHub about this person.
  if (response.status === 403) return { status: "not-github" };
  return { status: "unreachable" };
}

const MESSAGES = {
  "bad-code": ["That code doesn't look right", "Copy the confirmation code from your terminal exactly as it appears, then try again."],
  expired: ["That code has expired", "Confirmation codes last fifteen minutes. Run <code>crosscode start</code> again for a fresh one."],
  used: ["That code has already been used", "Run <code>crosscode start</code> again if your terminal is still waiting."],
  "not-github": ["Sign in with GitHub", "Crosscode checks your access to a repository on GitHub, so it needs a GitHub sign-in rather than another provider."],
  unreachable: ["Couldn't reach Crosscode", "Something went wrong on the way to the service. Try again in a moment."]
};

export function renderDevice(root, state) {
  if (state.status === "signed-out") {
    root.innerHTML = `
      <h1>Sign in to Crosscode</h1>
      <p>Your terminal is waiting. Sign in with GitHub, then type the confirmation code it's showing.</p>
      <button type="button" class="button" data-github-signin>Sign in with GitHub</button>
      ${state.staleSession ? "<p class=\"muted\">You're already signed in, but Crosscode needs to confirm your GitHub access again before it can set up a terminal.</p>" : ""}`;
    return;
  }

  if (state.status === "bound") {
    root.innerHTML = `
      <h1>Your terminal is signed in</h1>
      <p>You can close this tab and go back to it. Setup carries on from there.</p>`;
    return;
  }

  const [title, detail] = MESSAGES[state.status] ?? [];
  root.innerHTML = `
    <h1>Enter your confirmation code</h1>
    <p>It's the code <code>crosscode start</code> printed in your terminal.</p>
    ${title ? `<p class="error" role="alert"><strong>${title}.</strong> ${detail}</p>` : ""}
    <form data-device-form class="stack">
      <label>Confirmation code
        <input name="userCode" autocomplete="off" autocapitalize="characters" spellcheck="false"
               placeholder="WDJB-MJHT" value="${escapeHtml(state.userCode ?? "")}" required />
      </label>
      <button type="submit">Sign in this terminal</button>
    </form>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

/**
 * Browser entry. Guarded the same way the join page is: importing this module in a test
 * must not try to mount it or load a Supabase client the test has no env vars for.
 */
export async function mountDevicePage(root, { location = window.location } = {}) {
  const { getSupabaseClient } = await import("../auth/src/supabase.js");
  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getSession();
  // The CLI's URL is bare, but a link that carries the code costs the human one less thing
  // to retype and is no less safe -- the code does nothing without the sign-in beside it.
  const fromLink = new URL(location.href).searchParams.get("code") ?? "";

  const show = (state) => {
    renderDevice(root, state);
    root.querySelector("[data-github-signin]")?.addEventListener("click", () => {
      // Back to this same URL, so a code carried in the query survives the round trip
      // through GitHub.
      //
      // `repo` is asked for because of what happens after sign-in: joining a project is
      // gated on GitHub agreeing this person can read the repository, and GitHub answers
      // "no such repository" for a private one unless the token carries that scope. It is
      // a broad scope for a narrow question -- GitHub's OAuth apps have no read-only
      // equivalent -- and the token it produces is used for exactly that one question, in
      // memory, and never written down.
      void supabase.auth.signInWithOAuth({ provider: "github", options: { redirectTo: location.href, scopes: "repo" } });
    });
    root.querySelector("[data-device-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const userCode = new FormData(event.currentTarget).get("userCode");
      void bindDeviceCode({ userCode, session }).then((next) => { show({ ...next, userCode }); });
    });
  };

  // A session with no `provider_token` is a session Supabase restored from storage rather
  // than one it just minted: the GitHub token is returned once, at sign-in, and never
  // persisted. Binding one of those would sign the terminal in and leave `crosscode join`
  // with nothing to prove repository access with, so this asks for the sign-in again --
  // one click, and instant for a browser GitHub has already authorized.
  const session = data.session?.provider_token ? data.session : undefined;
  show(session ? { status: "ready", userCode: fromLink } : { status: "signed-out", staleSession: Boolean(data.session) });
}
