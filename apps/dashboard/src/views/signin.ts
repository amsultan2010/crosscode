import { getSupabaseClient } from "../lib/supabase.js";

export function renderSignIn(container: HTMLElement, onSignedIn: () => void): void {
  container.innerHTML = `
    <div class="auth-card">
      <h1>Sign in</h1>
      <p class="muted">Sign in with the email and password your workspace owner set up in Supabase Auth.</p>
      <form id="signin-form" class="stack">
        <label>
          Email
          <input type="email" name="email" required autocomplete="email" />
        </label>
        <label>
          Password
          <input type="password" name="password" required autocomplete="current-password" />
        </label>
        <button type="submit">Sign in</button>
        <p id="signin-error" class="error" hidden></p>
      </form>
    </div>
  `;

  const form = container.querySelector<HTMLFormElement>("#signin-form")!;
  const errorEl = container.querySelector<HTMLParagraphElement>("#signin-error")!;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void handleSubmit();
  });

  async function handleSubmit(): Promise<void> {
    errorEl.hidden = true;
    const formData = new FormData(form);
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");
    const submitButton = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    submitButton.disabled = true;
    try {
      const { error } = await getSupabaseClient().auth.signInWithPassword({ email, password });
      if (error) throw error;
      onSignedIn();
    } catch (error) {
      errorEl.textContent = error instanceof Error ? error.message : "Sign-in failed";
      errorEl.hidden = false;
    } finally {
      submitButton.disabled = false;
    }
  }
}
