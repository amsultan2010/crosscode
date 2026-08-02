import type { RemoteClaim, RemoteHandoff, RemoteIntent, RemoteOperation, RemoteTask, RemoteValidation, WsFanOutMessage, WorkspaceBillingResponse, ListMembershipsResponse } from "@crosscode/protocol";
import { createWorkspace, fetchBillingStatus, fetchMemberships, fetchWorkspaceSnapshot, registerReplica, type AuthContext, type PresenceSession } from "../lib/api.js";
import { connectStream } from "../lib/ws.js";
import { getStoredReplicaId, getStoredWorkspaceId, setStoredReplicaId, setStoredWorkspaceId } from "../lib/workspace.js";

type Membership = ListMembershipsResponse["memberships"][number];

export function renderDashboard(container: HTMLElement, session: { serviceUrl: string; accessToken: string }): void {
  container.innerHTML = `
    <div class="workspace-bar">
      <label id="team-switcher-label" hidden>
        Team
        <select id="team-switcher"></select>
      </label>
      <span id="connection-status" class="status-pill" hidden></span>
      <span id="mcp-badge" class="mcp-badge" hidden></span>
    </div>
    <div id="no-team" hidden>
      <p class="muted">You're not on any team yet. Create one, or ask a teammate for an invite code.</p>
      <form id="workspace-form">
        <label>
          Workspace name
          <input type="text" name="workspaceId" required autocomplete="off" spellcheck="false" placeholder="e.g. Acme" />
        </label>
        <button type="submit">Create workspace</button>
      </form>
    </div>
    <div id="stats" class="stat-grid"></div>
    <div id="panels" class="panels"></div>
  `;

  const noTeam = container.querySelector<HTMLDivElement>("#no-team")!;
  const teamLabel = container.querySelector<HTMLLabelElement>("#team-switcher-label")!;
  const teamSelect = container.querySelector<HTMLSelectElement>("#team-switcher")!;
  const form = container.querySelector<HTMLFormElement>("#workspace-form")!;
  const statusEl = container.querySelector<HTMLSpanElement>("#connection-status")!;
  const mcpBadgeEl = container.querySelector<HTMLSpanElement>("#mcp-badge")!;
  const statsEl = container.querySelector<HTMLDivElement>("#stats")!;
  const panelsEl = container.querySelector<HTMLDivElement>("#panels")!;

  let socket: WebSocket | undefined;
  const auth: AuthContext = { serviceUrl: session.serviceUrl, accessToken: session.accessToken, workspaceId: "" };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = String(new FormData(form).get("workspaceId") ?? "").trim();
    if (!name) return;
    const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    button.disabled = true;
    createWorkspace(auth, name)
      .then((created) => {
        setStoredWorkspaceId(created.workspaceId);
        void connect(created.workspaceId);
      })
      .catch((error: unknown) => setStatus("error", error instanceof Error ? error.message : "Could not create workspace"))
      .finally(() => { button.disabled = false; });
  });

  teamSelect.addEventListener("change", () => {
    if (teamSelect.value) {
      setStoredWorkspaceId(teamSelect.value);
      void connect(teamSelect.value);
    }
  });

  void fetchMemberships(auth).then(
    (memberships) => initTeamSwitcher(memberships),
    () => { noTeam.hidden = false; }
  );

  function initTeamSwitcher(memberships: Membership[]): void {
    if (!memberships.length) {
      noTeam.hidden = false;
      return;
    }
    teamLabel.hidden = false;
    teamSelect.innerHTML = memberships.map((m) => `<option value="${escapeHtml(m.workspaceId)}">${escapeHtml(m.workspaceName)} (${escapeHtml(m.role)})</option>`).join("");
    const stored = getStoredWorkspaceId();
    const initial = memberships.find((m) => m.workspaceId === stored)?.workspaceId ?? memberships[0]!.workspaceId;
    teamSelect.value = initial;
    setStoredWorkspaceId(initial);
    void connect(initial);
  }

  async function connect(workspaceId: string): Promise<void> {
    socket?.close();
    setStatus("connecting", "Connecting…");
    const auth: AuthContext = { ...session, workspaceId };

    let replicaId = getStoredReplicaId(workspaceId);
    try {
      if (!replicaId) {
        const replica = await registerReplica(auth, `dashboard-${Date.now()}`);
        replicaId = replica.replicaId;
        setStoredReplicaId(workspaceId, replicaId);
      }

      const [snapshot, billing] = await Promise.all([
        fetchWorkspaceSnapshot(auth),
        fetchBillingStatus(auth).catch(() => undefined)
      ]);
      const state = new PanelState(snapshot);
      state.render(panelsEl);
      renderStats(statsEl, state, billing);
      renderMcpBadge(mcpBadgeEl, state.presence);

      socket = connectStream(
        session.serviceUrl,
        { workspaceId, replicaId, accessToken: session.accessToken },
        {
          onSubscribed: () => setStatus("online", "Live"),
          onMessage: (message) => {
            state.apply(message);
            state.render(panelsEl);
            renderStats(statsEl, state, billing);
            renderMcpBadge(mcpBadgeEl, state.presence);
          },
          onError: (message) => setStatus("error", message),
          onClose: () => setStatus("offline", "Disconnected")
        }
      );
    } catch (error) {
      setStatus("error", error instanceof Error ? error.message : "Failed to connect");
    }
  }

  function setStatus(kind: string, label: string): void {
    statusEl.hidden = false;
    statusEl.textContent = label;
    statusEl.dataset.kind = kind;
  }
}

function renderMcpBadge(el: HTMLElement, presence: PresenceSession[]): void {
  el.hidden = false;
  // A live presence session means some daemon is currently connected to this
  // workspace over MCP/CLI -- the closest real, honest signal available to a
  // browser-only dashboard for "is the MCP daemon set up and running."
  const connected = presence.some((p) => p.status === "online");
  el.innerHTML = connected
    ? `<span class="dot online"></span> MCP daemon connected`
    : `<span class="dot offline"></span> No MCP daemon detected right now`;
}

function renderStats(container: HTMLElement, state: PanelState, billing: WorkspaceBillingResponse | undefined): void {
  const passing = state.validations.filter((remote) => remote.validation.exitCode === 0).length;
  const passRate = state.validations.length ? Math.round((passing / state.validations.length) * 100) : null;
  const onlineCount = state.presence.filter((p) => p.status === "online").length;

  const cards = [
    {
      label: "Live presence",
      value: String(onlineCount),
      sub: `${state.presence.length} known ${state.presence.length === 1 ? "replica" : "replicas"}`
    },
    {
      label: "Recent operations",
      value: String(state.operations.length),
      sub: "settled edits synced to this workspace"
    },
    {
      label: "Validation pass rate",
      value: passRate === null ? "—" : `${passRate}%`,
      sub: `${passing}/${state.validations.length} passing`
    },
    billing
      ? {
          label: `Plan: ${billing.plan}`,
          value: billing.seatCap === null ? `${billing.currentMemberCount}` : `${billing.currentMemberCount}/${billing.seatCap}`,
          sub: billing.seatCap === null ? "seats used (unlimited plan)" : "seats used"
        }
      : { label: "Plan", value: "—", sub: "billing status unavailable" }
  ];

  container.innerHTML = cards.map((card) => `
    <div class="stat-card">
      <p class="stat-label">${escapeHtml(card.label)}</p>
      <p class="stat-value">${escapeHtml(card.value)}</p>
      <p class="stat-sub">${escapeHtml(card.sub)}</p>
    </div>
  `).join("");
}

class PanelState {
  presence: PresenceSession[];
  tasks: Map<string, RemoteTask> = new Map();
  claims: Map<string, RemoteClaim> = new Map();
  handoffs: Map<string, RemoteHandoff> = new Map();
  intents: Map<string, RemoteIntent> = new Map();
  validations: RemoteValidation[];
  operations: RemoteOperation[];

  constructor(snapshot: {
    presence: PresenceSession[];
    tasks: RemoteTask[];
    claims: RemoteClaim[];
    handoffs: RemoteHandoff[];
    intents: RemoteIntent[];
    validations: RemoteValidation[];
    operations: RemoteOperation[];
  }) {
    this.presence = snapshot.presence;
    for (const task of snapshot.tasks) this.tasks.set(task.task.id, task);
    for (const claim of snapshot.claims) this.claims.set(claim.claim.id, claim);
    for (const handoff of snapshot.handoffs) this.handoffs.set(handoff.handoff.id, handoff);
    for (const intent of snapshot.intents) this.intents.set(intent.intent.id, intent);
    this.validations = snapshot.validations;
    this.operations = [...snapshot.operations].sort((a, b) => b.serverSequence - a.serverSequence);
  }

  apply(message: WsFanOutMessage): void {
    switch (message.type) {
      case "presence": {
        const next = this.presence.filter((p) => p.replicaId !== message.presence.replicaId);
        if (message.presence.status !== "offline") {
          next.push({ ...message.presence, status: message.presence.status === "idle" ? "online" : message.presence.status, cursor: null });
        }
        this.presence = next;
        break;
      }
      case "task":
        this.tasks.set(message.task.task.id, message.task);
        break;
      case "claim":
        this.claims.set(message.claim.claim.id, message.claim);
        break;
      case "handoff":
        this.handoffs.set(message.handoff.handoff.id, message.handoff);
        break;
      case "intent":
        this.intents.set(message.intent.intent.id, message.intent);
        break;
      case "validation":
        this.validations = [message.validation, ...this.validations].slice(0, 50);
        break;
      case "operation":
        this.operations = [message.operation, ...this.operations.filter((op) => op.id !== message.operation.id)].slice(0, 100);
        break;
    }
  }

  render(container: HTMLElement): void {
    container.innerHTML = `
      ${this.panel("Presence", this.presence.length, this.presence.map((session) => `
        <li><span class="dot ${session.status}"></span> ${escapeHtml(session.actorId)} <span class="muted">(${escapeHtml(session.replicaId)})</span></li>
      `))}
      ${this.panel("Tasks", this.tasks.size, [...this.tasks.values()].map((remote) => `
        <li><strong>${escapeHtml(remote.task.title)}</strong> <span class="muted">${escapeHtml(remote.task.status)}</span></li>
      `))}
      ${this.panel("Claims", this.claims.size, [...this.claims.values()].map((remote) => `
        <li>${escapeHtml(remote.claim.kind)}: ${escapeHtml(remote.claim.target)} ${remote.released ? '<span class="muted">(released)</span>' : ""}</li>
      `))}
      ${this.panel("Handoffs", this.handoffs.size, [...this.handoffs.values()].map((remote) => `
        <li>${escapeHtml(remote.handoff.status)} <span class="muted">by ${escapeHtml(remote.handoff.requestedBy)}</span></li>
      `))}
      ${this.panel("Intents", this.intents.size, [...this.intents.values()].map((remote) => `
        <li>${escapeHtml(remote.intent.text)}</li>
      `))}
      ${this.panel("Validation status", this.validations.length, this.validations.map((remote) => `
        <li><span class="dot ${remote.validation.exitCode === 0 ? "online" : "error"}"></span> ${escapeHtml(remote.validation.profile)} <span class="muted">exit ${remote.validation.exitCode}</span></li>
      `))}
      <section class="panel" style="grid-column: 1 / -1;">
        <h2>Edit history <span class="muted">${this.operations.length}</span></h2>
        <ul class="history-list">
          ${this.operations.length ? this.operations.map((operation) => this.historyItem(operation)).join("") : '<li class="muted">No edits synced yet</li>'}
        </ul>
      </section>
    `;
  }

  private historyItem(operation: RemoteOperation): string {
    const paths = operation.transaction.changes.map((change) => `${change.kind} ${change.path}`).join(", ");
    const when = new Date(operation.createdAt).toLocaleString();
    // Presence only knows currently-online-or-recently-seen replicas, so this is
    // best-effort attribution -- falls back to the raw replica id when the replica
    // that made this edit isn't in the live presence list anymore.
    const actor = this.presence.find((p) => p.replicaId === operation.senderReplicaId)?.actorId;
    const who = actor ?? operation.senderReplicaId;
    return `
      <li class="history-item">
        <span class="history-path">${escapeHtml(paths)}</span>
        <span class="history-status">${escapeHtml(who)} &middot; ${escapeHtml(operation.transaction.safety.risk)} risk &middot; ${escapeHtml(when)}</span>
      </li>
    `;
  }

  private panel(title: string, count: number, items: string[]): string {
    return `
      <section class="panel">
        <h2>${title} <span class="muted">${count}</span></h2>
        <ul>${items.length ? items.join("") : '<li class="muted">Nothing yet</li>'}</ul>
      </section>
    `;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
