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
            <button type="button" data-provider="google" class="auth-oauth-btn">Continue with Google</button>
            <button type="button" data-provider="github" class="auth-oauth-btn">Continue with GitHub</button>
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
