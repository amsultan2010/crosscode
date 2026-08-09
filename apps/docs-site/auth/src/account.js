import { getSupabaseClient } from "./supabase.js";
import { mountAuthForm } from "./auth-form.js";

// The sign-in and sign-up pages. There is nothing behind them on this site: an
// account only exists so `crosscode login` in the terminal has something to
// authenticate against.
export async function mountAccountPage(mode) {
  const container = document.querySelector("#auth");
  const { data } = await getSupabaseClient().auth.getSession();
  if (data.session) {
    renderSignedIn(container, data.session.user.email ?? "");
    return;
  }
  mountAuthForm(container, {
    mode,
    onSession: (session) => renderSignedIn(container, session.user.email ?? "")
  });
}

function renderSignedIn(container, email) {
  container.innerHTML = `
    <div class="auth-card">
      <a class="auth-brand" href="/">crosscode</a>
      <h1>you're signed in</h1>
      <p class="auth-subtitle">signed in as ${email}. everything else happens in your terminal:</p>
      <pre><code>crosscode login</code></pre>
      <p class="auth-subtitle">
        that opens this site once more to hand the session to your local daemon.
        see the <a href="/docs/install.html">install &amp; quickstart</a> guide.
      </p>
      <p class="auth-alt"><button type="button" id="sign-out" class="auth-linklike">sign out</button></p>
    </div>
  `;
  container.querySelector("#sign-out").addEventListener("click", async () => {
    await getSupabaseClient().auth.signOut();
    window.location.reload();
  });
}
