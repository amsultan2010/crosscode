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
      <a class="auth-brand" href="/">crosscode</a>
      <h1>reset your password</h1>
      <p class="auth-subtitle">we'll email you a link that brings you back here to set a new one.</p>
      <form id="auth-form" class="stack">
        <label>
          email
          <input type="email" name="email" required autocomplete="email" />
        </label>
        <button type="submit">send reset link</button>
        <p id="auth-status" class="muted" role="status"></p>
        <p id="auth-error" class="error" role="alert"></p>
      </form>
      <p class="auth-alt"><a href="/auth/signin.html">back to sign in</a></p>
    </div>
  `;
  wire(async (formData) => {
    const email = String(formData.get("email") ?? "");
    const { error } = await getSupabaseClient().auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset.html`
    });
    if (error) throw error;
    return "check your email for the reset link.";
  });
}

function renderUpdateForm() {
  container.innerHTML = `
    <div class="auth-card">
      <a class="auth-brand" href="/">crosscode</a>
      <h1>choose a new password</h1>
      <p class="auth-subtitle">this replaces the password on the account the reset link was sent to.</p>
      <form id="auth-form" class="stack">
        <label>
          new password
          <input type="password" name="password" required minlength="6" autocomplete="new-password" />
        </label>
        <button type="submit">update password</button>
        <p id="auth-status" class="muted" role="status"></p>
        <p id="auth-error" class="error" role="alert"></p>
      </form>
      <p class="auth-alt"><a href="/auth/signin.html">back to sign in</a></p>
    </div>
  `;
  wire(async (formData) => {
    const password = String(formData.get("password") ?? "");
    const { error } = await getSupabaseClient().auth.updateUser({ password });
    if (error) throw error;
    return "password updated. you can sign in with it now, or run `crosscode login`.";
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
        errorEl.textContent = error instanceof Error ? error.message : "request failed";
      } finally {
        submitButton.disabled = false;
      }
    })();
  });
}
