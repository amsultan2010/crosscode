import { getSupabaseClient } from "../lib/supabase.js";
import { createWorkspace, redeemInvite } from "../lib/api.js";
import { setStoredWorkspaceId } from "../lib/workspace.js";

type Mode = "signin" | "signup";

const SERVICE_URL = import.meta.env.VITE_SERVICE_URL ?? "http://127.0.0.1:8788";

export function renderSignIn(container: HTMLElement, onSignedIn: (justSignedUp: boolean) => void): void {
  let mode: Mode = "signin";
  render();

  function render(): void {
    const isSignup = mode === "signup";
    container.innerHTML = `
      <div class="auth-shell">
        <div class="auth-card">
          <div class="auth-brand">Crosscode</div>
          <div class="auth-tabs">
            <button type="button" data-mode="signin" class="${isSignup ? "" : "active"}">Sign in</button>
            <button type="button" data-mode="signup" class="${isSignup ? "active" : ""}">Sign up</button>
          </div>
          <h1>${isSignup ? "Create your account" : "Welcome back"}</h1>
          <p class="auth-subtitle">
            ${isSignup
              ? "Creates a new workspace for you, or joins one if you have an invite code."
              : "Sign in with the email and password you used to create your account."}
          </p>
          <form id="auth-form" class="stack">
            <label>
              Email
              <input type="email" name="email" required autocomplete="email" />
            </label>
            <label>
              Password
              <input type="password" name="password" required minlength="6" autocomplete="${isSignup ? "new-password" : "current-password"}" />
            </label>
            ${isSignup ? `
            <label>
              Invite code <span class="muted">(optional)</span>
              <input type="text" name="invite" autocomplete="off" spellcheck="false" />
            </label>` : ""}
            <button type="submit">${isSignup ? "Sign up" : "Sign in"}</button>
            <p id="auth-status" class="muted" hidden></p>
            <p id="auth-error" class="error" hidden></p>
          </form>
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
        </div>
      </div>
    `;

    container.querySelectorAll<HTMLButtonElement>(".auth-oauth-btn").forEach((button) => {
      button.addEventListener("click", () => {
        const provider = button.dataset.provider as "google" | "github";
        void getSupabaseClient().auth.signInWithOAuth({ provider, options: { redirectTo: window.location.origin + window.location.pathname } });
      });
    });

    container.querySelectorAll<HTMLButtonElement>(".auth-tabs button").forEach((tab) => {
      tab.addEventListener("click", () => {
        mode = tab.dataset.mode as Mode;
        render();
      });
    });

    const form = container.querySelector<HTMLFormElement>("#auth-form")!;
    const statusEl = container.querySelector<HTMLParagraphElement>("#auth-status")!;
    const errorEl = container.querySelector<HTMLParagraphElement>("#auth-error")!;

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void handleSubmit();
    });

    async function handleSubmit(): Promise<void> {
      errorEl.hidden = true;
      statusEl.hidden = true;
      const formData = new FormData(form);
      const email = String(formData.get("email") ?? "");
      const password = String(formData.get("password") ?? "");
      const submitButton = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
      submitButton.disabled = true;
      submitButton.classList.add("loading");
      try {
        if (isSignup) {
          const { data, error } = await getSupabaseClient().auth.signUp({ email, password });
          if (error) throw error;
          if (!data.session) {
            // Email confirmation is required before a session is issued; nothing more
            // to do here client-side until the user confirms and signs in.
            statusEl.textContent = "Check your email to confirm your account, then sign in.";
            statusEl.hidden = false;
            return;
          }
          const session = { serviceUrl: SERVICE_URL, accessToken: data.session.access_token };
          const invite = String(formData.get("invite") ?? "").trim();
          const { workspaceId } = invite ? await redeemInvite(session, invite) : await createWorkspace(session, `${email}'s workspace`);
          setStoredWorkspaceId(workspaceId);
          onSignedIn(true);
        } else {
          const { error } = await getSupabaseClient().auth.signInWithPassword({ email, password });
          if (error) throw error;
          onSignedIn(false);
        }
      } catch (error) {
        errorEl.textContent = error instanceof Error ? error.message : `${isSignup ? "Sign-up" : "Sign-in"} failed`;
        errorEl.hidden = false;
      } finally {
        submitButton.disabled = false;
        submitButton.classList.remove("loading");
      }
    }
  }
}
