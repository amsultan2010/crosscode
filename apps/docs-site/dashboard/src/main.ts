import type { Session } from "@supabase/supabase-js";
import { getSupabaseClient } from "./lib/supabase.js";
import { applyTheme } from "./lib/theme.js";
import { renderSignIn } from "./views/signin.js";
import { renderRedeemInvite } from "./views/redeem-invite.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderOnboarding } from "./views/onboarding.js";
import { renderSettings, initials } from "./views/settings.js";

applyTheme();

const SERVICE_URL = import.meta.env.VITE_SERVICE_URL ?? "http://127.0.0.1:8788";

const app = document.querySelector<HTMLDivElement>("#app")!;
const nav = document.querySelector<HTMLElement>("#app-nav")!;

type Route = "dashboard" | "invite" | "settings" | "onboarding";

function currentRoute(): Route {
  if (window.location.hash === "#/invite") return "invite";
  if (window.location.hash === "#/settings") return "settings";
  if (window.location.hash === "#/onboarding") return "onboarding";
  return "dashboard";
}

function renderNav(session: Session): void {
  nav.hidden = false;
  const displayName = String(session.user.user_metadata?.display_name ?? "");
  const avatarUrl = session.user.user_metadata?.avatar_url as string | undefined;
  const route = currentRoute();
  nav.innerHTML = `
    <a href="#/dashboard" class="${route === "dashboard" ? "active" : ""}">Dashboard</a>
    <a href="#/invite" class="${route === "invite" ? "active" : ""}">Redeem invite</a>
    <div class="account-menu">
      <button type="button" class="account-trigger" id="account-trigger">
        <span class="account-avatar">${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" />` : initials(displayName || session.user.email)}</span>
        ${escapeHtml(displayName || session.user.email || "Account")}
      </button>
      <div class="account-dropdown" id="account-dropdown" hidden>
        <span class="account-email">${escapeHtml(session.user.email ?? "")}</span>
        <a href="#/settings">Settings</a>
        <button type="button" id="account-sign-out">Sign out</button>
      </div>
    </div>
  `;

  const trigger = nav.querySelector<HTMLButtonElement>("#account-trigger")!;
  const dropdown = nav.querySelector<HTMLDivElement>("#account-dropdown")!;
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });
  document.addEventListener("click", () => { dropdown.hidden = true; }, { once: true });
  nav.querySelector<HTMLButtonElement>("#account-sign-out")!.addEventListener("click", () => {
    void getSupabaseClient().auth.signOut();
  });
}

function renderAuthedView(session: Session): void {
  const route = currentRoute();
  if (route === "onboarding") {
    nav.hidden = true;
    renderOnboarding(app, () => {
      window.location.hash = "#/dashboard";
    });
    return;
  }

  renderNav(session);
  if (route === "settings") {
    renderSettings(app, session, () => renderNav(session));
    return;
  }
  const auth = { serviceUrl: SERVICE_URL, accessToken: session.access_token };
  if (route === "invite") {
    renderRedeemInvite(app, auth, () => {
      window.location.hash = "#/dashboard";
    });
  } else {
    renderDashboard(app, auth);
  }
}

function renderUnauthedView(): void {
  nav.hidden = true;
  renderSignIn(app, (justSignedUp) => {
    // onAuthStateChange below re-renders once the session lands; a brand-new
    // signup that hasn't seen onboarding yet gets routed there instead of
    // straight to the dashboard.
    if (justSignedUp) window.location.hash = "#/onboarding";
  });
}

function renderConfigError(message: string): void {
  nav.hidden = true;
  app.innerHTML = `<div class="auth-shell"><div class="auth-card"><h1>Dashboard isn't configured</h1><p class="error">${escapeHtml(message)}</p></div></div>`;
}

try {
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
} catch (error) {
  renderConfigError(error instanceof Error ? error.message : "Failed to initialize the dashboard");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
