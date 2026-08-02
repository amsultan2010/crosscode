import type { Session } from "@supabase/supabase-js";
import { getSupabaseClient } from "./lib/supabase.js";
import { renderSignIn } from "./views/signin.js";
import { renderRedeemInvite } from "./views/redeem-invite.js";
import { renderDashboard } from "./views/dashboard.js";

const SERVICE_URL = import.meta.env.VITE_SERVICE_URL ?? "http://127.0.0.1:8788";

const app = document.querySelector<HTMLDivElement>("#app")!;
const nav = document.querySelector<HTMLElement>("#app-nav")!;

type Route = "dashboard" | "invite";

function currentRoute(): Route {
  return window.location.hash === "#/invite" ? "invite" : "dashboard";
}

function renderNav(session: Session): void {
  nav.hidden = false;
  nav.innerHTML = `
    <a href="#/dashboard" class="${currentRoute() === "dashboard" ? "active" : ""}">Dashboard</a>
    <a href="#/invite" class="${currentRoute() === "invite" ? "active" : ""}">Redeem invite</a>
    <span class="muted">${escapeHtml(session.user.email ?? session.user.id)}</span>
    <button id="sign-out" type="button">Sign out</button>
  `;
  nav.querySelector<HTMLButtonElement>("#sign-out")!.addEventListener("click", () => {
    void getSupabaseClient().auth.signOut();
  });
}

function renderAuthedView(session: Session): void {
  renderNav(session);
  const auth = { serviceUrl: SERVICE_URL, accessToken: session.access_token };
  if (currentRoute() === "invite") {
    renderRedeemInvite(app, auth, () => {
      window.location.hash = "#/dashboard";
    });
  } else {
    renderDashboard(app, auth);
  }
}

function renderUnauthedView(): void {
  nav.hidden = true;
  renderSignIn(app, () => {
    // onAuthStateChange below re-renders once the session lands.
  });
}

window.addEventListener("hashchange", () => {
  void getSupabaseClient().auth.getSession().then(({ data }) => {
    if (data.session) renderAuthedView(data.session);
  });
});

getSupabaseClient().auth.onAuthStateChange((_event, session) => {
  if (session) renderAuthedView(session);
  else renderUnauthedView();
});

void getSupabaseClient().auth.getSession().then(({ data }) => {
  if (data.session) renderAuthedView(data.session);
  else renderUnauthedView();
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
