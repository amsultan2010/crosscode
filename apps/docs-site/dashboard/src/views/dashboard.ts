import type { RemoteClaim, RemoteHandoff, RemoteIntent, RemoteTask, RemoteValidation, WsFanOutMessage } from "@crosscode/protocol";
import { fetchWorkspaceSnapshot, registerReplica, type AuthContext, type PresenceSession } from "../lib/api.js";
import { connectStream } from "../lib/ws.js";
import { getStoredReplicaId, getStoredWorkspaceId, setStoredReplicaId, setStoredWorkspaceId } from "../lib/workspace.js";

export function renderDashboard(container: HTMLElement, session: { serviceUrl: string; accessToken: string }): void {
  const storedWorkspaceId = getStoredWorkspaceId();

  container.innerHTML = `
    <div class="workspace-bar">
      <form id="workspace-form">
        <label>
          Workspace ID
          <input type="text" name="workspaceId" required autocomplete="off" spellcheck="false" value="${storedWorkspaceId ? escapeHtml(storedWorkspaceId) : ""}" />
        </label>
        <button type="submit">Connect</button>
      </form>
      <span id="connection-status" class="status-pill" hidden></span>
    </div>
    <div id="panels" class="panels"></div>
  `;

  const form = container.querySelector<HTMLFormElement>("#workspace-form")!;
  const statusEl = container.querySelector<HTMLSpanElement>("#connection-status")!;
  const panelsEl = container.querySelector<HTMLDivElement>("#panels")!;

  let socket: WebSocket | undefined;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const workspaceId = String(new FormData(form).get("workspaceId") ?? "").trim();
    if (!workspaceId) return;
    setStoredWorkspaceId(workspaceId);
    void connect(workspaceId);
  });

  if (storedWorkspaceId) void connect(storedWorkspaceId);

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

      const snapshot = await fetchWorkspaceSnapshot(auth);
      const state = new PanelState(snapshot);
      state.render(panelsEl);

      socket = connectStream(
        session.serviceUrl,
        { workspaceId, replicaId, accessToken: session.accessToken },
        {
          onSubscribed: () => setStatus("online", "Live"),
          onMessage: (message) => {
            state.apply(message);
            state.render(panelsEl);
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

class PanelState {
  presence: PresenceSession[];
  tasks: Map<string, RemoteTask> = new Map();
  claims: Map<string, RemoteClaim> = new Map();
  handoffs: Map<string, RemoteHandoff> = new Map();
  intents: Map<string, RemoteIntent> = new Map();
  validations: RemoteValidation[];

  constructor(snapshot: {
    presence: PresenceSession[];
    tasks: RemoteTask[];
    claims: RemoteClaim[];
    handoffs: RemoteHandoff[];
    intents: RemoteIntent[];
    validations: RemoteValidation[];
  }) {
    this.presence = snapshot.presence;
    for (const task of snapshot.tasks) this.tasks.set(task.task.id, task);
    for (const claim of snapshot.claims) this.claims.set(claim.claim.id, claim);
    for (const handoff of snapshot.handoffs) this.handoffs.set(handoff.handoff.id, handoff);
    for (const intent of snapshot.intents) this.intents.set(intent.intent.id, intent);
    this.validations = snapshot.validations;
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
