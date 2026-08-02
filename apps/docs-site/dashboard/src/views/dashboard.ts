import type { RemoteClaim, RemoteHandoff, RemoteIntent, RemoteOperation, RemoteTask, RemoteValidation, WsFanOutMessage, WorkspaceBillingResponse, ListMembershipsResponse } from "@crosscode/protocol";
import { createWorkspace, fetchBillingStatus, fetchMemberships, fetchProjects, fetchWorkspaceSnapshot, registerReplica, type AuthContext, type PresenceSession, type Project } from "../lib/api.js";
import { riskMix, riskMixEntries, rollUpProjects, summarizeValidations, type ProjectRollup } from "../lib/analytics.js";
import { maybeStartDashboardTour } from "../lib/tour.js";
import { connectStream } from "../lib/ws.js";
import { getStoredReplicaId, getStoredWorkspaceId, setStoredReplicaId, setStoredWorkspaceId } from "../lib/workspace.js";

type Membership = ListMembershipsResponse["memberships"][number];

export function renderDashboard(container: HTMLElement, session: { serviceUrl: string; accessToken: string }): void {
  container.innerHTML = `
    <div class="workspace-bar">
      <label id="team-switcher-label" data-tour="team-switcher" hidden>
        Team
        <select id="team-switcher"></select>
      </label>
      <button type="button" id="create-team-toggle" hidden>Create a team</button>
      <span id="connection-status" class="status-pill" hidden></span>
      <span id="mcp-badge" class="mcp-badge" hidden></span>
    </div>
    <p id="memberships-error" class="section-note" hidden></p>
    <form id="workspace-form" class="create-team-form" hidden>
      <label>
        Workspace name
        <input type="text" name="workspaceId" required autocomplete="off" spellcheck="false" placeholder="e.g. Acme" />
      </label>
      <button type="submit">Create workspace</button>
    </form>
    <div id="sections"></div>
  `;

  const teamLabel = container.querySelector<HTMLLabelElement>("#team-switcher-label")!;
  const teamSelect = container.querySelector<HTMLSelectElement>("#team-switcher")!;
  const createTeamToggle = container.querySelector<HTMLButtonElement>("#create-team-toggle")!;
  const membershipsError = container.querySelector<HTMLParagraphElement>("#memberships-error")!;
  const form = container.querySelector<HTMLFormElement>("#workspace-form")!;
  const statusEl = container.querySelector<HTMLSpanElement>("#connection-status")!;
  const mcpBadgeEl = container.querySelector<HTMLSpanElement>("#mcp-badge")!;
  const sectionsEl = container.querySelector<HTMLDivElement>("#sections")!;

  let socket: WebSocket | undefined;
  let tourStarted = false;
  const auth: AuthContext = { serviceUrl: session.serviceUrl, accessToken: session.accessToken, workspaceId: "" };

  // Creating a team is an ordinary action, not a gate: the form starts collapsed and
  // never replaces the analytics sections. Contract C guarantees every valid user
  // already has a personal workspace, so there is nothing to gate on.
  createTeamToggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector<HTMLInputElement>("input[name=workspaceId]")!.focus();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = String(new FormData(form).get("workspaceId") ?? "").trim();
    if (!name) return;
    const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    button.disabled = true;
    createWorkspace(auth, name)
      .then((created) => {
        form.reset();
        form.hidden = true;
        setStoredWorkspaceId(created.workspaceId);
        // Reload the switcher so the new team appears in it, not just in the stream.
        void loadMemberships();
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

  void loadMemberships();

  async function loadMemberships(): Promise<void> {
    let memberships: Membership[];
    try {
      memberships = await fetchMemberships(auth);
    } catch (error) {
      // A network/auth failure is not the same thing as "this user has no team" --
      // conflating them would offer to create a workspace the user probably already has.
      showMembershipsError(error instanceof Error ? error.message : "Could not load your teams");
      return;
    }
    membershipsError.hidden = true;
    createTeamToggle.hidden = false;
    initTeamSwitcher(memberships);
  }

  function showMembershipsError(message: string): void {
    membershipsError.hidden = false;
    membershipsError.textContent = `Could not load your teams: ${message}`;
    // Deliberately left hidden: offering "create a team" here would misread a transient
    // failure as an empty account.
    createTeamToggle.hidden = true;
    form.hidden = true;
    teamLabel.hidden = true;
  }

  function initTeamSwitcher(memberships: Membership[]): void {
    if (!memberships.length) {
      // Contract C says this cannot happen for a valid user; if it does, the create-team
      // action is already available and there is no workspace to load analytics for.
      form.hidden = false;
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

      // Projects and billing are both non-fatal: Contract D's other three sections are
      // computed entirely from the snapshot and must still render without them.
      const [snapshot, billing, projects] = await Promise.all([
        fetchWorkspaceSnapshot(auth),
        fetchBillingStatus(auth).catch(() => undefined),
        fetchProjects(auth).then((list) => ({ list }), () => ({ list: [] as Project[], failed: true }))
      ]);
      const state = new DashboardState(snapshot, projects.list, "failed" in projects);
      const paint = (): void => {
        renderSections(sectionsEl, state, billing);
        renderMcpBadge(mcpBadgeEl, state.presence);
      };
      paint();
      startTourOnce();

      socket = connectStream(
        session.serviceUrl,
        { workspaceId, replicaId, accessToken: session.accessToken },
        {
          onSubscribed: () => setStatus("online", "Live"),
          onMessage: (message) => {
            state.apply(message);
            paint();
          },
          onError: (message) => setStatus("error", message),
          onClose: () => setStatus("offline", "Disconnected")
        }
      );
    } catch (error) {
      setStatus("error", error instanceof Error ? error.message : "Failed to connect");
    }
  }

  // The spotlight tour needs real, laid-out anchors, so it starts after the first paint --
  // and only once per dashboard mount, no matter how many times a team switch re-renders.
  function startTourOnce(): void {
    if (tourStarted) return;
    tourStarted = true;
    void maybeStartDashboardTour({ root: container });
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

type StatCard = { label: string; value: string; sub: string };

export function renderSections(container: HTMLElement, state: DashboardState, billing: WorkspaceBillingResponse | undefined): void {
  container.innerHTML = [
    overviewSection(state, billing),
    projectsSection(state),
    coordinationSection(state),
    validationSection(state)
  ].join("");
}

// -- Overview -----------------------------------------------------------------

function overviewSection(state: DashboardState, billing: WorkspaceBillingResponse | undefined): string {
  const onlineCount = state.presence.filter((p) => p.status === "online").length;
  const rollups = state.rollups();
  const connectedProjects = rollups.filter((rollup) => rollup.projectId !== null).length;

  const cards: StatCard[] = [
    {
      label: "Live presence",
      value: String(onlineCount),
      sub: `${state.presence.length} known ${state.presence.length === 1 ? "replica" : "replicas"}`
    },
    {
      label: "Connected projects",
      value: state.projectsUnavailable ? "—" : String(connectedProjects),
      sub: state.projectsUnavailable ? "project list unavailable" : "repositories paired to this workspace"
    },
    {
      label: "Total settled edits",
      value: String(state.operations.length),
      sub: "transactions synced to this workspace"
    },
    billing
      ? {
          label: `Plan: ${billing.plan}`,
          value: billing.seatCap === null ? `${billing.currentMemberCount}` : `${billing.currentMemberCount}/${billing.seatCap}`,
          sub: billing.seatCap === null ? "seats used (unlimited plan)" : "seats used"
        }
      : { label: "Plan", value: "—", sub: "billing status unavailable" }
  ];

  const presenceItems = state.presence.map((session) => `
    <li><span class="dot ${escapeHtml(session.status)}"></span> ${escapeHtml(session.actorId)} <span class="muted">(${escapeHtml(session.replicaId)})</span></li>
  `);

  const body = `
    ${statGrid(cards)}
    <div class="panels">
      ${panel("Presence", state.presence.length, presenceItems)}
      <section class="panel panel-wide">
        <h3>Recent edits <span class="muted">${state.operations.length}</span></h3>
        <ul class="history-list">
          ${state.operations.length
            ? state.operations.slice(0, 12).map((operation) => historyItem(state, operation)).join("")
            : '<li class="muted">No edits synced yet</li>'}
        </ul>
      </section>
    </div>
  `;
  return section("overview", "Overview", "Everything live in this workspace right now.", body);
}

function historyItem(state: DashboardState, operation: RemoteOperation): string {
  const paths = operation.transaction.changes.map((change) => `${change.kind} ${change.path}`).join(", ");
  const when = new Date(operation.createdAt).toLocaleString();
  // Presence only knows currently-online-or-recently-seen replicas, so this is
  // best-effort attribution -- falls back to the raw replica id when the replica
  // that made this edit isn't in the live presence list anymore.
  const actor = state.presence.find((p) => p.replicaId === operation.senderReplicaId)?.actorId;
  const who = actor ?? operation.senderReplicaId;
  return `
    <li class="history-item">
      <span class="history-path">${escapeHtml(paths)}</span>
      <span class="history-status">${escapeHtml(who)} &middot; ${escapeHtml(operation.transaction.safety.risk)} risk &middot; ${escapeHtml(when)}</span>
    </li>
  `;
}

// -- Projects -----------------------------------------------------------------

function projectsSection(state: DashboardState): string {
  const rollups = state.rollups();
  const body = state.projectsUnavailable && rollups.length === 0
    ? '<p class="section-note">Project data is unavailable right now. Everything else on this page is still live.</p>'
    : `
      ${statGrid([
        { label: "Projects", value: String(rollups.filter((r) => r.projectId !== null).length), sub: "repositories seen in this workspace" },
        { label: "Active replicas", value: String(rollups.reduce((sum, r) => sum + r.activeReplicas, 0)), sub: "online across all projects" },
        { label: "Unassigned edits", value: String(rollups.find((r) => r.projectId === null)?.editCount ?? 0), sub: "recorded before projects existed" }
      ])}
      ${state.projectsUnavailable ? '<p class="section-note">Project names are unavailable; showing activity by id.</p>' : ""}
      <div class="project-grid">
        ${rollups.length ? rollups.map(projectCard).join("") : '<p class="muted">No projects yet. Pair a repo from your coding agent to see it here.</p>'}
      </div>
    `;
  return section("projects", "Projects", "One card per repository a daemon has reported.", body);
}

function projectCard(rollup: ProjectRollup): string {
  const unassigned = rollup.projectId === null;
  return `
    <article class="project-card${unassigned ? " project-card-unassigned" : ""}" data-project-id="${escapeHtml(rollup.projectId ?? "unassigned")}">
      <h3>${escapeHtml(rollup.name)}</h3>
      <p class="project-remote">${rollup.repoRemote ? escapeHtml(rollup.repoRemote) : `<span class="muted">${unassigned ? "activity with no project" : "no git remote"}</span>`}</p>
      <dl class="project-meta">
        <div><dt>Edits</dt><dd data-project-edits>${rollup.editCount}</dd></div>
        <div><dt>Active replicas</dt><dd data-project-replicas>${rollup.activeReplicas}</dd></div>
        <div><dt>Last activity</dt><dd>${rollup.lastActivityAt ? escapeHtml(new Date(rollup.lastActivityAt).toLocaleString()) : "—"}</dd></div>
      </dl>
    </article>
  `;
}

// -- Coordination -------------------------------------------------------------

function coordinationSection(state: DashboardState): string {
  const openTasks = [...state.tasks.values()].filter((remote) => remote.task.status !== "complete" && remote.task.status !== "cancelled").length;
  const heldClaims = [...state.claims.values()].filter((remote) => !remote.released).length;
  const pendingHandoffs = [...state.handoffs.values()].filter((remote) => remote.handoff.status === "pending").length;

  const body = `
    ${statGrid([
      { label: "Tasks", value: String(state.tasks.size), sub: `${openTasks} not done` },
      { label: "Claims", value: String(state.claims.size), sub: `${heldClaims} currently held` },
      { label: "Handoffs", value: String(state.handoffs.size), sub: `${pendingHandoffs} awaiting response` },
      { label: "Intents", value: String(state.intents.size), sub: "declared by agents" }
    ])}
    <div class="panels">
      ${panel("Tasks", state.tasks.size, [...state.tasks.values()].map((remote) => `
        <li><strong>${escapeHtml(remote.task.title)}</strong> <span class="muted">${escapeHtml(remote.task.status)}</span></li>
      `))}
      ${panel("Claims", state.claims.size, [...state.claims.values()].map((remote) => `
        <li>${escapeHtml(remote.claim.kind)}: ${escapeHtml(remote.claim.target)} ${remote.released ? '<span class="muted">(released)</span>' : ""}</li>
      `))}
      ${panel("Handoffs", state.handoffs.size, [...state.handoffs.values()].map((remote) => `
        <li>${escapeHtml(remote.handoff.status)} <span class="muted">by ${escapeHtml(remote.handoff.requestedBy)}</span></li>
      `))}
      ${panel("Intents", state.intents.size, [...state.intents.values()].map((remote) => `
        <li>${escapeHtml(remote.intent.text)}</li>
      `))}
    </div>
  `;
  return section("coordination", "Coordination", "How concurrent agents stay out of each other's way.", body);
}

// -- Validation & safety ------------------------------------------------------

function validationSection(state: DashboardState): string {
  const summary = summarizeValidations(state.validations);
  const mix = riskMix(state.operations);
  const entries = riskMixEntries(mix);
  const elevated = mix.counts.high + mix.counts.critical;

  const body = `
    ${statGrid([
      { label: "Validation pass rate", value: summary.passRate === null ? "—" : `${summary.passRate}%`, sub: `${summary.passing}/${summary.total} passing` },
      { label: "Recent runs", value: String(summary.total), sub: "validation runs on record" },
      { label: "Elevated-risk edits", value: String(elevated), sub: mix.total ? `of ${mix.total} settled edits` : "no edits recorded yet" }
    ])}
    <div class="panels">
      ${panel("Recent validation runs", state.validations.length, state.validations.slice(0, 20).map((remote) => `
        <li><span class="dot ${remote.validation.exitCode === 0 ? "online" : "error"}"></span> ${escapeHtml(remote.validation.profile)} <span class="muted">exit ${remote.validation.exitCode}</span></li>
      `))}
      <section class="panel panel-wide" data-risk-mix>
        <h3>Risk mix <span class="muted">${mix.total}</span></h3>
        ${mix.total === 0
          ? '<p class="muted">No settled edits yet, so there is no risk mix to show.</p>'
          : `<ul class="risk-mix">
              ${entries.map((entry) => `
                <li data-risk="${entry.risk}">
                  <span class="risk-label">${entry.risk}</span>
                  <span class="risk-bar"><span class="risk-bar-fill" style="width: ${entry.percent}%"></span></span>
                  <span class="risk-count">${entry.count} <span class="muted">(${entry.percent}%)</span></span>
                </li>
              `).join("")}
            </ul>`}
      </section>
    </div>
  `;
  return section("validation", "Validation &amp; safety", "Whether the edits that landed were checked, and how risky they were.", body);
}

// -- Shared markup helpers ----------------------------------------------------

function section(tour: string, heading: string, subtitle: string, body: string): string {
  // `data-tour` values are frozen by Contract D -- the spotlight tour anchors to them.
  return `
    <section class="dash-section" data-tour="${tour}">
      <header class="section-heading">
        <h2>${heading}</h2>
        <p class="muted">${subtitle}</p>
      </header>
      ${body}
    </section>
  `;
}

function statGrid(cards: StatCard[]): string {
  return `<div class="stat-grid">${cards.map((card) => `
    <div class="stat-card">
      <p class="stat-label">${escapeHtml(card.label)}</p>
      <p class="stat-value">${escapeHtml(card.value)}</p>
      <p class="stat-sub">${escapeHtml(card.sub)}</p>
    </div>
  `).join("")}</div>`;
}

function panel(title: string, count: number, items: string[]): string {
  return `
    <section class="panel">
      <h3>${title} <span class="muted">${count}</span></h3>
      <ul>${items.length ? items.join("") : '<li class="muted">Nothing yet</li>'}</ul>
    </section>
  `;
}

export class DashboardState {
  presence: PresenceSession[];
  tasks: Map<string, RemoteTask> = new Map();
  claims: Map<string, RemoteClaim> = new Map();
  handoffs: Map<string, RemoteHandoff> = new Map();
  intents: Map<string, RemoteIntent> = new Map();
  validations: RemoteValidation[];
  operations: RemoteOperation[];
  projects: Project[];
  /** True when `GET /v1/projects` failed: the Projects section degrades instead of vanishing. */
  projectsUnavailable: boolean;

  constructor(
    snapshot: {
      presence: PresenceSession[];
      tasks: RemoteTask[];
      claims: RemoteClaim[];
      handoffs: RemoteHandoff[];
      intents: RemoteIntent[];
      validations: RemoteValidation[];
      operations: RemoteOperation[];
    },
    projects: Project[] = [],
    projectsUnavailable = false
  ) {
    this.presence = snapshot.presence;
    for (const task of snapshot.tasks) this.tasks.set(task.task.id, task);
    for (const claim of snapshot.claims) this.claims.set(claim.claim.id, claim);
    for (const handoff of snapshot.handoffs) this.handoffs.set(handoff.handoff.id, handoff);
    for (const intent of snapshot.intents) this.intents.set(intent.intent.id, intent);
    this.validations = snapshot.validations;
    this.operations = [...snapshot.operations].sort((a, b) => b.serverSequence - a.serverSequence);
    this.projects = projects;
    this.projectsUnavailable = projectsUnavailable;
  }

  rollups(): ProjectRollup[] {
    return rollUpProjects(this.projects, this.operations, this.presence);
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
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
