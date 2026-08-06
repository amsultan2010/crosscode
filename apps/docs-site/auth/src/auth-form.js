import { getSupabaseClient } from "./supabase.js";
import { consentFieldHtml, consentGiven, CONSENT_MESSAGES, fetchLegal, recordAcceptance, showConsentError } from "../../src/legal.js";

const SERVICE_URL = import.meta.env.VITE_SERVICE_URL ?? "http://127.0.0.1:8788";

// Self-serve workspace creation for a freshly signed-up account with no membership
// yet. Everything else about a workspace (invites, members, pairing) is CLI-only.
async function createWorkspace(accessToken, name) {
  const response = await fetch(new URL("/v1/workspaces", SERVICE_URL), {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(payload && typeof payload === "object" && "error" in payload ? String(payload.error) : response.statusText);
  }
}

/**
 * The terms, on the two pages an account is made and used from.
 *
 * Sign-up gets an unticked checkbox and the eligibility line the terms require; sign-in gets
 * the statement immediately above the button it applies to. Both are recorded server-side
 * the moment a session exists -- a ticked box the service never hears about proves nothing,
 * and the surface is recorded so the record says which of the two it was.
 *
 * Never pre-ticked. There is no code path here that sets `checked`.
 */
export function legalNoticeHtml(isSignup, legal) {
  if (!legal) return "";
  if (isSignup) return consentFieldHtml({ legal, ageGate: true });
  const links = legal.documents
    .map((entry) => `<a href="${entry.url}" target="_blank" rel="noopener">${entry.document === "terms" ? "Terms of Service" : "Privacy Policy"}</a> (version ${entry.version})`)
    .join(" and ");
  return `<p class="muted consent" id="accept-terms-notice">By signing in you agree to the ${links}.</p>
          <p class="error" id="accept-terms-error" role="alert" hidden></p>`;
}

// Renders the shared email/password + OAuth form. `onSession` is called with the
// Supabase session once one is issued; each page decides what to do with it.
export async function mountAuthForm(container, { mode = "signin", onSession }) {
  // Fetched once, before anything is drawn: the version shown beside the link has to be the
  // version the service will record, and the service is the only thing that knows it.
  const legal = await fetchLegal();
  render();

  function render() {
    const isSignup = mode === "signup";
    container.innerHTML = `
      <div class="auth-card">
        <a class="auth-brand" href="/">Crosscode</a>
        <div class="auth-tabs" role="group" aria-label="Account">
          <button type="button" data-mode="signin" aria-pressed="${isSignup ? "false" : "true"}" class="${isSignup ? "" : "active"}">Sign in</button>
          <button type="button" data-mode="signup" aria-pressed="${isSignup ? "true" : "false"}" class="${isSignup ? "active" : ""}">Sign up</button>
        </div>
        <h1>${isSignup ? "Create your account" : "Welcome back"}</h1>
        <p class="auth-subtitle">
          ${isSignup
            ? "An account is only needed for the hosted coordination service. Once it exists, run <code>crosscode login</code> in your terminal."
            : "Sign in with the email and password you used to create your account."}
        </p>
        <form id="auth-form" class="stack">
          <label>
            Email
            <input type="email" name="email" required autocomplete="email" aria-describedby="auth-error" />
          </label>
          <label>
            Password
            <input type="password" name="password" required minlength="6" autocomplete="${isSignup ? "new-password" : "current-password"}" aria-describedby="auth-error" />
          </label>
          ${legalNoticeHtml(isSignup, legal)}
          <button type="submit">${isSignup ? "Sign up" : "Sign in"}</button>
          <!-- Both stay in the DOM and empty rather than toggling the hidden attribute.
               A live region a screen reader cannot see when the text arrives announces
               nothing, and hidden takes the element out of the accessibility tree
               entirely, so the old pattern wrote the message and then hid the only thing
               that could have read it out. -->
          <p id="auth-status" class="muted" role="status"></p>
          <p id="auth-error" class="error" role="alert"></p>
        </form>
        <p class="auth-alt"><a href="/auth/reset.html">Forgot your password?</a></p>
        <div class="auth-divider"><span>or</span></div>
        <div class="auth-oauth-group">
          <button type="button" data-provider="google" class="auth-oauth-btn">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.47c-.28 1.5-1.13 2.78-2.4 3.63v3.02h3.88c2.27-2.09 3.57-5.17 3.57-8.84Z"/><path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.88-3.02c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.27v3.12C3.25 21.3 7.31 24 12 24Z"/><path fill="#FBBC05" d="M5.27 14.27a7.2 7.2 0 0 1 0-4.54V6.62H1.27a12 12 0 0 0 0 10.76l4-3.11Z"/><path fill="#EA4335" d="M12 4.77c1.77 0 3.35.61 4.6 1.8l3.44-3.44C17.95 1.19 15.23 0 12 0 7.31 0 3.25 2.7 1.27 6.62l4 3.11C6.22 6.88 8.87 4.77 12 4.77Z"/></svg>
            Continue with Google
          </button>
          <button type="button" data-provider="github" class="auth-oauth-btn">
            <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
            Continue with GitHub
          </button>
        </div>
        <p class="auth-foot">
          There is no web app behind this. <a href="/docs/install.html">Install and quickstart</a>
        </p>
      </div>
    `;

    container.querySelectorAll(".auth-oauth-btn").forEach((button) => {
      button.addEventListener("click", () => {
        // The OAuth flow leaves this page, so the acceptance cannot be recorded here -- the
        // service asks again on /device before it signs any terminal in. What the tick does
        // here is stop an account being created by somebody who has not agreed at all.
        if (isSignup && legal && !consentGiven(container)) {
          showConsentError(container, CONSENT_MESSAGES.unticked);
          return;
        }
        void getSupabaseClient().auth.signInWithOAuth({
          provider: button.dataset.provider,
          options: { redirectTo: window.location.href }
        });
      });
    });

    container.querySelectorAll(".auth-tabs button").forEach((tab) => {
      tab.addEventListener("click", () => {
        mode = tab.dataset.mode;
        render();
      });
    });

    const form = container.querySelector("#auth-form");
    const statusEl = container.querySelector("#auth-status");
    const errorEl = container.querySelector("#auth-error");

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void handleSubmit();
    });

    const inputs = [...form.querySelectorAll("input")];

    async function handleSubmit() {
      errorEl.textContent = "";
      statusEl.textContent = "";
      for (const input of inputs) input.removeAttribute("aria-invalid");
      const formData = new FormData(form);
      const email = String(formData.get("email") ?? "");
      const password = String(formData.get("password") ?? "");
      const submitButton = form.querySelector("button[type=submit]");
      // Checked before Supabase is called, so a sign-up that was never consented to does not
      // leave an account behind.
      if (isSignup && legal && !consentGiven(container)) {
        showConsentError(container, CONSENT_MESSAGES.unticked);
        return;
      }
      submitButton.disabled = true;
      try {
        if (isSignup) {
          const { data, error } = await getSupabaseClient().auth.signUp({ email, password });
          if (error) throw error;
          if (!data.session) {
            // Email confirmation is required before a session is issued; nothing more
            // to do here client-side until the user confirms and signs in.
            statusEl.textContent = "Check your email to confirm your account, then sign in.";
            return;
          }
          // Recorded before the workspace is created, so the first thing this account does
          // is the acceptance rather than something the acceptance was meant to cover.
          if (!await acceptTerms(data.session)) return;
          await createWorkspace(data.session.access_token, `${email}'s workspace`);
          await onSession(data.session);
        } else {
          const { data, error } = await getSupabaseClient().auth.signInWithPassword({ email, password });
          if (error) throw error;
          if (!await acceptTerms(data.session)) return;
          await onSession(data.session);
        }
      } catch (error) {
        errorEl.textContent = error instanceof Error ? error.message : `${isSignup ? "Sign-up" : "Sign-in"} failed`;
        // The service cannot say which field was wrong -- "invalid login credentials" is
        // deliberately one answer for both -- so both are marked, and both point at the
        // one message via aria-describedby.
        for (const input of inputs) input.setAttribute("aria-invalid", "true");
      } finally {
        submitButton.disabled = false;
      }
    }

    /**
     * Writes the acceptance down. False means it was not recorded and the flow stops there:
     * carrying on would sign somebody in having told them they agreed to something the
     * service has no record of them agreeing to.
     */
    async function acceptTerms(session) {
      if (!legal || !session?.access_token) return true;
      const recorded = await recordAcceptance({
        surface: isSignup ? "signup" : "signin",
        legal,
        accessToken: session.access_token
      });
      if (recorded.status === "recorded") return true;
      showConsentError(container, CONSENT_MESSAGES[recorded.status] ?? CONSENT_MESSAGES.unreachable);
      return false;
    }
  }
}
