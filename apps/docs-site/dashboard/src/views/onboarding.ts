import {
  fetchMemberships,
  fetchPairingStatus,
  mintPairingCode,
  type AuthContext,
  type PairingStatusResponse,
  type SessionContext
} from "../lib/api.js";

// Contract A: poll every 2s; the code's own 15-minute TTL is what ends the poll.
const POLL_INTERVAL_MS = 2_000;

const WELCOME = {
  title: "Welcome to Crosscode",
  body: "Crosscode keeps several coding agents working in the same repository without stepping on each other. This dashboard is a read-only window into your workspace -- live presence, tasks, claims, proposals, and validation status. Accepting or rejecting a proposal still happens through your terminal or coding agent, never from a browser.",
  sub: "Two steps: point an MCP-capable agent at Crosscode, then watch it connect."
};

type Pairing =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; code: string; pairingId: string; expiresAt: number };

type Verification = {
  status: PairingStatusResponse["status"];
  actorId: string | null;
  /** Set when a poll request itself failed -- distinct from a "not yet claimed" answer. */
  error?: string;
};

// main.ts re-renders the authed view on every auth event (including token
// refreshes), which would otherwise leave the previous instance's poll timer
// writing into the shared container. Only the newest instance stays live.
let activeInstance = 0;

export function renderOnboarding(container: HTMLElement, session: SessionContext, onDone: () => void): void {
  const instance = ++activeInstance;
  // 0 welcome, 1 connect, 2 verify, 3 connected. Workstream 4's spotlight tour
  // takes over once we hand control back at #/dashboard.
  let index = 0;
  let installPrompt: string | undefined;
  let auth: AuthContext | undefined;
  let pairing: Pairing = { kind: "loading" };
  let verification: Verification = { status: "pending", actorId: null };
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let finished = false;

  render();

  /** True once this instance has handed off, or a newer instance has taken over. */
  function stale(): boolean {
    return finished || activeInstance !== instance;
  }

  function finish(): void {
    if (finished) return;
    finished = true;
    stopTimers();
    onDone();
  }

  function stopTimers(): void {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    if (countdownTimer !== undefined) clearInterval(countdownTimer);
    pollTimer = undefined;
    countdownTimer = undefined;
  }

  async function mint(): Promise<void> {
    stopTimers();
    pairing = { kind: "loading" };
    verification = { status: "pending", actorId: null };
    render();
    try {
      if (stale()) return;
      if (!auth) {
        // Contract C guarantees a valid user always has at least a personal
        // workspace, so this is a lookup, not a create-a-team gate.
        const memberships = await fetchMemberships(session);
        const workspaceId = memberships[0]?.workspaceId;
        if (!workspaceId) throw new Error("Your personal workspace isn't ready yet. Try again in a moment.");
        auth = { ...session, workspaceId };
      }
      const minted = await mintPairingCode(auth);
      if (stale()) return;
      // The countdown is a display affordance; `GET /v1/pairing-codes/:id` stays
      // authoritative on expiry, so an unparseable timestamp falls back to the
      // contract's 15-minute TTL rather than reading as instantly expired.
      const expiresAt = Date.parse(minted.expiresAt);
      pairing = {
        kind: "ready",
        code: minted.code,
        pairingId: minted.pairingId,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 15 * 60_000
      };
      render();
      startTimers();
    } catch (error) {
      if (stale()) return;
      pairing = { kind: "error", message: errorMessage(error, "Couldn't create a pairing code.") };
      render();
    }
  }

  function startTimers(): void {
    stopTimers();
    schedulePoll();
    countdownTimer = setInterval(tickCountdown, 1_000);
  }

  function schedulePoll(): void {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
  }

  async function poll(): Promise<void> {
    if (stale() || pairing.kind !== "ready" || !auth) return;
    const { pairingId } = pairing;
    try {
      const status = await fetchPairingStatus(auth, pairingId);
      // A re-mint while this request was in flight makes the answer stale.
      if (stale() || pairing.kind !== "ready" || pairing.pairingId !== pairingId) return;
      verification = { status: status.status, actorId: status.actorId };
      if (status.status === "pending") {
        render();
        schedulePoll();
        return;
      }
      stopTimers();
      if (status.status === "claimed") index = 3;
      render();
    } catch (error) {
      if (stale() || pairing.kind !== "ready" || pairing.pairingId !== pairingId) return;
      // A failed poll is not a failed pairing -- say so plainly and keep trying.
      verification = { ...verification, error: errorMessage(error, "Couldn't reach the service.") };
      render();
      schedulePoll();
    }
  }

  function tickCountdown(): void {
    if (stale()) { stopTimers(); return; }
    if (pairing.kind !== "ready") return;
    if (remainingMs() > 0) {
      const el = container.querySelector<HTMLElement>("#pairing-countdown");
      if (el) el.textContent = formatRemaining(remainingMs());
      return;
    }
    // The clock ran out locally; surface the re-mint action without waiting for
    // the next poll to confirm what the countdown already shows.
    stopTimers();
    verification = { ...verification, status: "expired" };
    render();
  }

  function remainingMs(): number {
    return pairing.kind === "ready" ? Math.max(0, pairing.expiresAt - Date.now()) : 0;
  }

  function render(): void {
    const total = 4;
    container.innerHTML = `
      <div class="onboarding-shell">
        <div class="onboarding-progress">
          ${Array.from({ length: total }, (_, i) => `<span class="${i <= index ? "done" : ""}"></span>`).join("")}
        </div>
        <div class="onboarding-step">${stepHtml()}</div>
        <div class="onboarding-actions">
          ${index < 3 ? `<button type="button" class="skip" id="onboarding-skip">Skip for now</button>` : `<span></span>`}
          <button type="button" class="next" id="onboarding-next"${nextDisabled() ? " disabled" : ""}>${nextLabel()}</button>
        </div>
      </div>
    `;

    container.querySelector<HTMLButtonElement>("#onboarding-skip")?.addEventListener("click", finish);
    container.querySelector<HTMLButtonElement>("#onboarding-next")!.addEventListener("click", () => {
      if (index >= 3) {
        finish();
        return;
      }
      index += 1;
      if (index === 1 && pairing.kind !== "ready") {
        void mint();
        return;
      }
      render();
    });

    container.querySelector<HTMLButtonElement>("#pairing-remint")?.addEventListener("click", () => { void mint(); });
    bindCopy("#onboarding-copy-code", () => (pairing.kind === "ready" ? pairing.code : undefined), "Copy code");
    bindCopy("#onboarding-copy", () => installPrompt, "Copy prompt");
    if (index === 1) loadInstallPrompt();
  }

  function nextLabel(): string {
    if (index === 0) return "Continue";
    if (index === 1) return "I've handed over the code";
    if (index === 2) return "Waiting for your agent…";
    return "Go to dashboard";
  }

  // The verify step is blocking -- but only for the primary action. Skip is
  // always there, and it lands on the same dashboard.
  function nextDisabled(): boolean {
    return index === 2;
  }

  function stepHtml(): string {
    if (index === 0) {
      return `<h1>${escapeHtml(WELCOME.title)}</h1><p>${escapeHtml(WELCOME.body)}</p><p class="muted">${escapeHtml(WELCOME.sub)}</p>`;
    }
    if (index === 1) return connectHtml();
    if (index === 2) return verifyHtml();
    return connectedHtml();
  }

  function connectHtml(): string {
    return `
      <h1>Connect your coding agent</h1>
      <p>Paste the prompt below into Claude Code, Codex CLI, OpenCode, Cursor, or any other MCP-capable agent. It installs the Crosscode MCP server for a project.</p>
      <div class="onboarding-install">
        <button type="button" id="onboarding-copy">Copy prompt</button>
        <pre id="onboarding-install-text">Loading…</pre>
      </div>
      <h2 class="pairing-heading">Then give it this pairing code</h2>
      <p>Tell your agent: <em>"pair this Crosscode workspace using code ${pairing.kind === "ready" ? escapeHtml(pairing.code) : "…"}"</em>. The code is single-use and links this account to the daemon running on your machine.</p>
      ${pairingBlockHtml()}
    `;
  }

  function verifyHtml(): string {
    return `
      <h1>Waiting for your agent</h1>
      <p>Keep this tab open. As soon as your agent redeems the code, this page confirms it.</p>
      ${pairingBlockHtml()}
      ${statusHtml()}
    `;
  }

  function connectedHtml(): string {
    const who = verification.actorId;
    return `
      <h1>Your agent is connected</h1>
      <p>${who ? `<strong>${escapeHtml(who)}</strong> claimed the pairing code.` : "The pairing code was claimed."} Your daemon is now bound to your workspace.</p>
      <p class="muted">Next up: a quick tour of the dashboard. You can create a team and invite people whenever you want -- it's optional, and nothing here waits on it.</p>
    `;
  }

  function pairingBlockHtml(): string {
    if (pairing.kind === "loading") {
      return `<div class="pairing-block" data-state="loading"><p class="muted" id="pairing-loading">Minting a one-time pairing code…</p></div>`;
    }
    if (pairing.kind === "error") {
      return `
        <div class="pairing-block" data-state="error">
          <p class="error" id="pairing-error">${escapeHtml(pairing.message)}</p>
          <button type="button" id="pairing-remint">Try again</button>
        </div>
      `;
    }
    const expired = verification.status === "expired";
    return `
      <div class="pairing-block" data-state="${expired ? "expired" : "ready"}">
        <div class="pairing-code-row">
          <code class="pairing-code" data-testid="pairing-code">${escapeHtml(pairing.code)}</code>
          <button type="button" id="onboarding-copy-code">Copy code</button>
        </div>
        ${expired
          ? `<p class="error" id="pairing-expired">This code expired. Mint a new one to keep going.</p>
             <button type="button" id="pairing-remint">Mint a new code</button>`
          : `<p class="muted">Expires in <span id="pairing-countdown">${formatRemaining(remainingMs())}</span></p>`}
      </div>
    `;
  }

  function statusHtml(): string {
    const label = verification.status === "claimed"
      ? "Connected"
      : verification.status === "expired"
        ? "Code expired"
        : "Waiting for a daemon to claim this code…";
    return `
      <p class="pairing-status" id="verify-status" data-status="${verification.status}">
        <span class="dot ${verification.status === "claimed" ? "online" : verification.status === "expired" ? "error" : "offline"}"></span>
        ${escapeHtml(label)}
      </p>
      ${verification.error ? `<p class="error" id="verify-error">${escapeHtml(verification.error)} Retrying every 2 seconds.</p>` : ""}
    `;
  }

  function bindCopy(selector: string, value: () => string | undefined, idleLabel: string): void {
    const button = container.querySelector<HTMLButtonElement>(selector);
    button?.addEventListener("click", () => {
      const text = value();
      if (!text || !navigator.clipboard) return;
      void navigator.clipboard.writeText(text).then(() => {
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = idleLabel; }, 1500);
      });
    });
  }

  function loadInstallPrompt(): void {
    const pre = container.querySelector<HTMLPreElement>("#onboarding-install-text");
    if (!pre) return;
    if (installPrompt) {
      pre.textContent = installPrompt;
      return;
    }
    void fetch("/docs/install-prompt.md")
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error("not found"))))
      .then((text) => {
        // The doc wraps the actual copy-pasteable prompt in a 4-backtick fence
        // (```` ```text ... ``` ````, 4 backticks since the prompt itself contains
        // 3-backtick fenced blocks) surrounded by explanatory prose -- extract just
        // the fenced content, matching what the landing page's copy button sends.
        const match = text.match(/````text\n([\s\S]*?)\n````/);
        installPrompt = (match ? match[1] : text)!.trimEnd();
        const target = container.querySelector<HTMLPreElement>("#onboarding-install-text");
        if (target) target.textContent = installPrompt;
      })
      .catch(() => {
        const target = container.querySelector<HTMLPreElement>("#onboarding-install-text");
        if (target) target.textContent = "Couldn't load the install prompt -- see the Docs page instead.";
      });
  }
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
