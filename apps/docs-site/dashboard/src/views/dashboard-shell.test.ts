// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptySnapshot, fixtureProjects, fullSnapshot } from "../lib/test-fixtures.js";

// The shell around the sections -- team switcher, the optional create-team action, and the
// difference between "this fetch failed" and "this user has no team". Mocked at the module
// boundary so no network, WebSocket or Supabase client is involved.

const fetchMemberships = vi.fn();
const fetchWorkspaceSnapshot = vi.fn();
const fetchProjects = vi.fn();
const fetchBillingStatus = vi.fn();
const registerReplica = vi.fn();
const createWorkspace = vi.fn();

vi.mock("../lib/api.js", () => ({
  fetchMemberships: (...args: unknown[]) => fetchMemberships(...args),
  fetchWorkspaceSnapshot: (...args: unknown[]) => fetchWorkspaceSnapshot(...args),
  fetchProjects: (...args: unknown[]) => fetchProjects(...args),
  fetchBillingStatus: (...args: unknown[]) => fetchBillingStatus(...args),
  registerReplica: (...args: unknown[]) => registerReplica(...args),
  createWorkspace: (...args: unknown[]) => createWorkspace(...args)
}));
vi.mock("../lib/ws.js", () => ({ connectStream: () => ({ close: () => {} }) }));
vi.mock("../lib/tour.js", () => ({ maybeStartDashboardTour: async () => undefined }));

const { renderDashboard } = await import("./dashboard.js");

const SESSION = { serviceUrl: "http://service.test", accessToken: "token" };
const MEMBERSHIPS = [
  { workspaceId: "ws-1", workspaceName: "Ada's workspace", role: "owner" },
  { workspaceId: "ws-2", workspaceName: "Acme platform", role: "member" }
];

/** Lets every queued microtask in renderDashboard's fetch chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  renderDashboard(container, SESSION);
  return container;
}

const visible = (container: HTMLElement, selector: string): boolean => {
  const element = container.querySelector<HTMLElement>(selector);
  return !!element && !element.hidden;
};

const sectionAnchors = (container: HTMLElement): Array<string | undefined> =>
  [...container.querySelectorAll<HTMLElement>(".dash-section")].map((section) => section.dataset.tour);

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  vi.clearAllMocks();
  fetchMemberships.mockResolvedValue(MEMBERSHIPS);
  fetchWorkspaceSnapshot.mockResolvedValue(fullSnapshot());
  fetchProjects.mockResolvedValue(fixtureProjects());
  fetchBillingStatus.mockResolvedValue({ plan: "team", seatCap: 10, currentMemberCount: 4 });
  registerReplica.mockResolvedValue({ replicaId: "replica-dashboard" });
  createWorkspace.mockResolvedValue({ workspaceId: "ws-3" });
});

describe("dashboard shell", () => {
  it("renders all four sections for a user with memberships", async () => {
    const container = mount();
    await settle();

    expect(sectionAnchors(container)).toEqual(["overview", "projects", "coordination", "validation"]);
    expect(visible(container, "#team-switcher-label")).toBe(true);
    expect(container.querySelectorAll("#team-switcher option")).toHaveLength(2);
    expect(container.querySelector("#no-team")).toBeNull();
  });

  it("offers create-a-team as an optional collapsed action, not a gate", async () => {
    const container = mount();
    await settle();

    // Available, but the form itself stays collapsed and nothing is hidden behind it.
    expect(visible(container, "#create-team-toggle")).toBe(true);
    expect(visible(container, "#workspace-form")).toBe(false);

    container.querySelector<HTMLButtonElement>("#create-team-toggle")!.click();

    expect(visible(container, "#workspace-form")).toBe(true);
    // The whole point: the analytics are still there next to the open form.
    expect(sectionAnchors(container)).toEqual(["overview", "projects", "coordination", "validation"]);
    expect(visible(container, "#team-switcher-label")).toBe(true);
  });

  it("collapses the form and reloads the switcher after creating a team", async () => {
    const container = mount();
    await settle();
    container.querySelector<HTMLButtonElement>("#create-team-toggle")!.click();

    fetchMemberships.mockResolvedValue([...MEMBERSHIPS, { workspaceId: "ws-3", workspaceName: "New team", role: "owner" }]);
    const form = container.querySelector<HTMLFormElement>("#workspace-form")!;
    form.querySelector<HTMLInputElement>("input[name=workspaceId]")!.value = "New team";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();

    expect(createWorkspace).toHaveBeenCalledWith(expect.anything(), "New team");
    expect(visible(container, "#workspace-form")).toBe(false);
    expect(container.querySelectorAll("#team-switcher option")).toHaveLength(3);
    expect(sectionAnchors(container)).toEqual(["overview", "projects", "coordination", "validation"]);
  });

  it("shows an error state -- not the create-team form -- when fetchMemberships fails", async () => {
    fetchMemberships.mockRejectedValue(new Error("network down"));
    const container = mount();
    await settle();

    const error = container.querySelector<HTMLElement>("#memberships-error")!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("network down");
    // A failed fetch is not an empty account: no create-team affordance, no team switcher.
    expect(visible(container, "#workspace-form")).toBe(false);
    expect(visible(container, "#create-team-toggle")).toBe(false);
    expect(visible(container, "#team-switcher-label")).toBe(false);
  });

  it("distinguishes an empty membership list from a failed fetch", async () => {
    // Contract C says this should be unreachable, but if it happens it is not an error:
    // the create-team action is offered and no error banner is shown.
    fetchMemberships.mockResolvedValue([]);
    const container = mount();
    await settle();

    expect(visible(container, "#memberships-error")).toBe(false);
    expect(visible(container, "#create-team-toggle")).toBe(true);
    expect(visible(container, "#workspace-form")).toBe(true);
  });

  it("shows the whole dashboard -- empty, not gated -- for a user with no team", async () => {
    fetchMemberships.mockResolvedValue([]);
    const container = mount();
    await settle();

    // Every section is there, so the page explains itself instead of being blank.
    expect(sectionAnchors(container)).toEqual(["overview", "projects", "coordination", "validation"]);
    expect(container.querySelector("#no-team")!.textContent).toContain("aren't in a team yet");
    expect(container.querySelector("#no-team a")!.getAttribute("href")).toBe("#/invite");
    // Nothing was fetched for a workspace that does not exist.
    expect(fetchWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  it("still renders every section when the workspace snapshot is empty", async () => {
    fetchWorkspaceSnapshot.mockResolvedValue(emptySnapshot());
    fetchProjects.mockRejectedValue(new Error("no projects endpoint"));
    fetchBillingStatus.mockRejectedValue(new Error("no billing"));
    const container = mount();
    await settle();

    expect(sectionAnchors(container)).toEqual(["overview", "projects", "coordination", "validation"]);
  });
});
