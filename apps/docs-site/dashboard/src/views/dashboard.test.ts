// @vitest-environment happy-dom
import type { WorkspaceBillingResponse } from "@crosscode/protocol";
import { describe, expect, it } from "vitest";
import { emptySnapshot, fixtureProjects, fullSnapshot } from "../lib/test-fixtures.js";
import { DashboardState, renderSections } from "./dashboard.js";

const BILLING: WorkspaceBillingResponse = {
  plan: "team",
  seatCap: 10,
  currentMemberCount: 3,
  entitlements: []
} as unknown as WorkspaceBillingResponse;

function render(state: DashboardState, billing: WorkspaceBillingResponse | undefined): HTMLElement {
  const container = document.createElement("div");
  renderSections(container, state, billing);
  return container;
}

function section(container: HTMLElement, tour: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-tour="${tour}"]`);
  expect(element, `missing section [data-tour="${tour}"]`).not.toBeNull();
  return element!;
}

function statCards(root: HTMLElement): Array<{ label: string; value: string }> {
  return [...root.querySelectorAll(".stat-card")].map((card) => ({
    label: card.querySelector(".stat-label")!.textContent!.trim(),
    value: card.querySelector(".stat-value")!.textContent!.trim()
  }));
}

function statValue(root: HTMLElement, label: string): string | undefined {
  return statCards(root).find((card) => card.label === label)?.value;
}

const populated = (): DashboardState => new DashboardState(fullSnapshot(), fixtureProjects());

describe("dashboard sections", () => {
  it("renders all four sections with their frozen data-tour anchors and a heading each", () => {
    const container = render(populated(), BILLING);
    const anchors = [...container.querySelectorAll<HTMLElement>(".dash-section")].map((el) => el.dataset.tour);
    expect(anchors).toEqual(["overview", "projects", "coordination", "validation"]);

    for (const anchor of anchors) {
      const root = section(container, anchor!);
      expect(root.querySelector(".section-heading h2")!.textContent!.trim()).not.toBe("");
      expect(root.querySelectorAll(".stat-card").length).toBeGreaterThan(0);
    }
  });

  it("renders every section from an empty snapshot without throwing", () => {
    const container = render(new DashboardState(emptySnapshot(), []), undefined);
    expect(container.querySelectorAll(".dash-section")).toHaveLength(4);
    expect(statValue(section(container, "validation"), "Validation pass rate")).toBe("—");
    expect(statValue(section(container, "overview"), "Plan")).toBe("—");
    expect(section(container, "validation").textContent).toContain("no risk mix to show");
    expect(section(container, "projects").textContent).toContain("No projects yet");
  });

  it("shows Contract D's four overview stats", () => {
    const overview = section(render(populated(), BILLING), "overview");
    expect(statCards(overview).map((card) => card.label)).toEqual([
      "Live presence",
      "Connected projects",
      "Total settled edits",
      "Plan: team"
    ]);
    expect(statValue(overview, "Live presence")).toBe("3");
    expect(statValue(overview, "Connected projects")).toBe("3");
    expect(statValue(overview, "Total settled edits")).toBe("4");
    expect(statValue(overview, "Plan: team")).toBe("3/10");
  });

  it("renders one project card per project plus Unassigned, with the right per-project numbers", () => {
    const projects = section(render(populated(), BILLING), "projects");
    const cards = [...projects.querySelectorAll<HTMLElement>(".project-card")];
    expect(cards.map((card) => card.dataset.projectId)).toEqual(["proj-1", "proj-2", "proj-3", "unassigned"]);

    const edits = (card: HTMLElement): string => card.querySelector("[data-project-edits]")!.textContent!.trim();
    const replicas = (card: HTMLElement): string => card.querySelector("[data-project-replicas]")!.textContent!.trim();

    expect(cards[0]!.querySelector("h3")!.textContent).toBe("crosscode");
    expect(cards[0]!.querySelector(".project-remote")!.textContent).toContain("github.com/acme/crosscode");
    expect([edits(cards[0]!), replicas(cards[0]!)]).toEqual(["2", "1"]);
    expect([edits(cards[1]!), replicas(cards[1]!)]).toEqual(["1", "1"]);
    expect([edits(cards[2]!), replicas(cards[2]!)]).toEqual(["0", "0"]);

    const unassigned = cards[3]!;
    expect(unassigned.querySelector("h3")!.textContent).toBe("Unassigned");
    expect([edits(unassigned), replicas(unassigned)]).toEqual(["1", "1"]);
  });

  it("keeps the other three sections when the projects fetch failed", () => {
    const state = new DashboardState(fullSnapshot(), [], true);
    const container = render(state, BILLING);

    expect(container.querySelectorAll(".dash-section")).toHaveLength(4);
    expect(statValue(section(container, "overview"), "Connected projects")).toBe("—");
    // Names came from the failed call, but the per-project activity in the snapshot is
    // still real, so it is shown by id rather than thrown away.
    expect(section(container, "projects").textContent).toContain("Project names are unavailable");
    expect([...section(container, "projects").querySelectorAll<HTMLElement>(".project-card")].map((card) => card.dataset.projectId))
      .toEqual(["proj-1", "proj-2", "unassigned"]);
    // Coordination and validation are snapshot-only and unaffected.
    expect(statValue(section(container, "coordination"), "Tasks")).toBe("2");
    expect(statValue(section(container, "validation"), "Validation pass rate")).toBe("67%");
  });

  it("renders the coordination counts and panels", () => {
    const coordination = section(render(populated(), BILLING), "coordination");
    expect(statCards(coordination).map((card) => `${card.label}=${card.value}`)).toEqual([
      "Tasks=2",
      "Claims=2",
      "Handoffs=2",
      "Intents=1"
    ]);
    const panelTitles = [...coordination.querySelectorAll(".panel h3")].map((h) => h.textContent!.trim().split(" ")[0]);
    expect(panelTitles).toEqual(["Tasks", "Claims", "Handoffs", "Intents"]);
    expect(coordination.textContent).toContain("Refactor the parser");
  });

  it("renders the pass rate, recent runs and risk mix", () => {
    const validation = section(render(populated(), BILLING), "validation");
    expect(statValue(validation, "Validation pass rate")).toBe("67%");
    expect(statValue(validation, "Recent runs")).toBe("3");
    expect(statValue(validation, "Elevated-risk edits")).toBe("2");

    const risks = [...validation.querySelectorAll<HTMLElement>(".risk-mix li")].map((li) => ({
      risk: li.dataset.risk,
      count: li.querySelector(".risk-count")!.textContent!.trim().split(" ")[0]
    }));
    expect(risks).toEqual([
      { risk: "low", count: "1" },
      { risk: "medium", count: "1" },
      { risk: "high", count: "1" },
      { risk: "critical", count: "1" }
    ]);
  });

  it("re-renders with live-streamed operations applied", () => {
    const state = populated();
    state.apply({
      type: "operation",
      operation: {
        ...fullSnapshot().operations[0]!,
        id: "op-live",
        serverSequence: 9,
        transaction: { ...fullSnapshot().operations[0]!.transaction, safety: { risk: "critical", requiresApproval: true } }
      }
    });
    const container = render(state, BILLING);
    expect(statValue(section(container, "overview"), "Total settled edits")).toBe("5");
    expect(statValue(section(container, "validation"), "Elevated-risk edits")).toBe("3");
  });

  it("escapes hostile content instead of injecting it", () => {
    const snapshot = emptySnapshot();
    snapshot.presence = [{ replicaId: "<img src=x onerror=alert(1)>", actorId: "evil", status: "online", lastSeenAt: null, cursor: null }];
    const container = render(new DashboardState(snapshot, []), BILLING);
    expect(container.querySelector("img")).toBeNull();
    expect(section(container, "overview").textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
