import { getSupabaseClient } from "./supabase.js";

// Two states on one page: request a reset email, then set the new password once
// Supabase sends the user back here from that email.
const container = document.querySelector("#auth");
const arrivedFromEmail = window.location.hash.includes("type=recovery");

getSupabaseClient().auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") renderUpdateForm();
});

if (arrivedFromEmail) renderUpdateForm();
else renderRequestForm();

function renderRequestForm() {
  container.innerHTML = `
    <div class="auth-card">
      <a class="auth-brand" href="/">Crosscode</a>
      <h1>Reset your password</h1>
      <p class="auth-subtitle">We'll email you a link that brings you back here to set a new one.</p>
      <form id="auth-form" class="stack">
        <label>
          Email
          <input type="email" name="email" required autocomplete="email" />
        </label>
        <button type="submit">Send reset link</button>
        <p id="auth-status" class="muted" role="status"></p>
        <p id="auth-error" class="error" role="alert"></p>
      </form>
      <p class="auth-alt"><a href="/auth/signin.html">Back to sign in</a></p>
    </div>
  `;
  wire(async (formData) => {
    const email = String(formData.get("email") ?? "");
    const { error } = await getSupabaseClient().auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset.html`
    });
    if (error) throw error;
    return "Check your email for the reset link.";
  });
}

function renderUpdateForm() {
  container.innerHTML = `
    <div class="auth-card">
      <a class="auth-brand" href="/">Crosscode</a>
      <h1>Choose a new password</h1>
      <p class="auth-subtitle">This replaces the password on the account the reset link was sent to.</p>
      <form id="auth-form" class="stack">
        <label>
          New password
          <input type="password" name="password" required minlength="6" autocomplete="new-password" />
        </label>
        <button type="submit">Update password</button>
        <p id="auth-status" class="muted" role="status"></p>
        <p id="auth-error" class="error" role="alert"></p>
      </form>
      <p class="auth-alt"><a href="/auth/signin.html">Back to sign in</a></p>
    </div>
  `;
  wire(async (formData) => {
    const password = String(formData.get("password") ?? "");
    const { error } = await getSupabaseClient().auth.updateUser({ password });
    if (error) throw error;
    return "Password updated. You can sign in with it now, or run `crosscode login`.";
  });
}

function wire(submit) {
  const form = container.querySelector("#auth-form");
  const statusEl = container.querySelector("#auth-status");
  const errorEl = container.querySelector("#auth-error");
  const submitButton = form.querySelector("button[type=submit]");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      // Emptied rather than hidden: `hidden` drops the live region out of the
      // accessibility tree, so a message written into a hidden one is announced to nobody.
      errorEl.textContent = "";
      statusEl.textContent = "";
      submitButton.disabled = true;
      try {
        statusEl.textContent = await submit(new FormData(form));
      } catch (error) {
        errorEl.textContent = error instanceof Error ? error.message : "Request failed";
      } finally {
        submitButton.disabled = false;
      }
    })();
  });
}
