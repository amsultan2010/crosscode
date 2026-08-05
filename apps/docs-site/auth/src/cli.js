import { getSupabaseClient } from "./supabase.js";
import { mountAuthForm } from "./auth-form.js";

// The browser half of `crosscode login`. The CLI starts a loopback server on an
// ephemeral port, opens this page with ?port=&state=, and waits for the POST
// below. The state is echoed back so the CLI can reject a callback it did not
// start; tokens go straight to 127.0.0.1 and are never shown on this page.
const params = new URLSearchParams(window.location.search);
const port = params.get("port");
const state = params.get("state");
const container = document.querySelector("#auth");

void main();

async function main() {
  if (!port || !state) {
    renderMessage(
      "This page needs a terminal",
      "Open it by running <code>crosscode login</code> in your terminal, which supplies the port and state it is waiting on."
    );
    return;
  }
  const { data } = await getSupabaseClient().auth.getSession();
  if (data.session) {
    await handOff(data.session);
  } else {
    mountAuthForm(container, { mode: "signin", onSession: handOff });
  }
}

async function handOff(session) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${encodeURIComponent(port)}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state,
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        user: { id: session.user.id, email: session.user.email }
      })
    });
  } catch {
    renderMessage(
      "Couldn't reach your terminal",
      "The <code>crosscode login</code> command that opened this page is no longer listening. Run it again, or use <code>crosscode login --email &lt;email&gt; --password &lt;password&gt;</code>."
    );
    return;
  }
  // fetch only rejects on a transport failure, so without this a 400 from the CLI --
  // a state mismatch, or a session the callback schema rejected -- rendered as success
  // while the terminal was failing with LOGIN_STATE_MISMATCH or LOGIN_CALLBACK_INVALID.
  if (!response.ok) {
    const detail = await response.json().then((body) => body?.error).catch(() => undefined);
    renderMessage(
      "Your terminal rejected this sign-in",
      `${detail ? `It reported: <code>${escapeHtml(detail)}</code>. ` : ""}Run <code>crosscode login</code> again and complete the sign-in in the tab it opens, so the page and the command belong to the same login.`
    );
    return;
  }
  renderMessage("You're signed in", "Return to your terminal. You can close this tab.");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function renderMessage(heading, body) {
  container.innerHTML = `
    <div class="auth-card">
      <a class="auth-brand" href="/">Crosscode</a>
      <h1>${heading}</h1>
      <p class="auth-subtitle">${body}</p>
    </div>
  `;
}
