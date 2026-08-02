// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_TOUR_STEPS,
  SpotlightTour,
  TOUR_COMPLETED_KEY,
  isTourCompleted,
  maybeStartDashboardTour,
  persistTourCompletion,
  type TourMetadata,
  type TourStep,
  type TourStorage
} from "./tour.js";

const STEPS: TourStep[] = [
  { anchor: "overview", title: "Overview", body: "one" },
  { anchor: "projects", title: "Projects", body: "two" },
  { anchor: "coordination", title: "Coordination", body: "three" }
];

function memoryStorage(initial: Record<string, string> = {}): TourStorage & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    get: (key) => values[key] ?? null,
    set: (key, value) => { values[key] = value; }
  };
}

function mountSections(anchors: string[]): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = anchors.map((anchor) => `<section data-tour="${anchor}"><h2>${anchor}</h2></section>`).join("");
  document.body.append(root);
  return root;
}

function popover(): HTMLElement | null {
  return document.querySelector(".tour-popover");
}

function click(action: string): void {
  document.querySelector<HTMLButtonElement>(`[data-tour-action="${action}"]`)!.click();
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("SpotlightTour", () => {
  it("anchors to the first section and advances through the steps", () => {
    const root = mountSections(["overview", "projects", "coordination"]);
    const tour = new SpotlightTour({ steps: STEPS, root, persistence: { storage: memoryStorage(), metadata: nullMetadata() } });

    expect(tour.start()).toBe(true);
    expect(tour.currentStep?.anchor).toBe("overview");
    expect(popover()?.dataset.tourStep).toBe("overview");
    expect(root.querySelector<HTMLElement>('[data-tour="overview"]')!.dataset.tourActive).toBe("true");

    click("next");
    expect(tour.currentStep?.anchor).toBe("projects");
    // Only the current anchor is lifted above the dim.
    expect(root.querySelectorAll("[data-tour-active]")).toHaveLength(1);
    expect(root.querySelector<HTMLElement>('[data-tour="projects"]')!.dataset.tourActive).toBe("true");

    click("next");
    expect(tour.currentStep?.anchor).toBe("coordination");
    expect(popover()!.querySelector(".tour-next")!.textContent).toBe("Done");
  });

  it("skips a step whose anchor is missing rather than pointing at nothing", () => {
    const root = mountSections(["overview", "coordination"]);
    const tour = new SpotlightTour({ steps: STEPS, root, persistence: { storage: memoryStorage(), metadata: nullMetadata() } });

    tour.start();
    expect(tour.currentStep?.anchor).toBe("overview");
    click("next");
    expect(tour.currentStep?.anchor).toBe("coordination");
  });

  it("treats a hidden anchor as missing", () => {
    const root = mountSections(["overview", "projects", "coordination"]);
    root.querySelector<HTMLElement>('[data-tour="projects"]')!.hidden = true;
    const tour = new SpotlightTour({ steps: STEPS, root, persistence: { storage: memoryStorage(), metadata: nullMetadata() } });

    tour.start();
    click("next");
    expect(tour.currentStep?.anchor).toBe("coordination");
  });

  it("finishes without chrome when no anchor exists at all", async () => {
    const storage = memoryStorage();
    const root = mountSections([]);
    const tour = new SpotlightTour({ steps: STEPS, root, persistence: { storage, metadata: nullMetadata() }, now: () => "2026-08-01T00:00:00.000Z" });

    expect(tour.start()).toBe(false);
    expect(popover()).toBeNull();
    await Promise.resolve();
    expect(storage.values[TOUR_COMPLETED_KEY]).toBe("2026-08-01T00:00:00.000Z");
  });

  it("goes back to the previous anchored step", () => {
    const root = mountSections(["overview", "coordination"]);
    const tour = new SpotlightTour({ steps: STEPS, root, persistence: { storage: memoryStorage(), metadata: nullMetadata() } });
    tour.start();
    click("next");
    expect(tour.currentStep?.anchor).toBe("coordination");
    click("back");
    expect(tour.currentStep?.anchor).toBe("overview");
    // No Back button on the first step.
    expect(popover()!.querySelector('[data-tour-action="back"]')).toBeNull();
  });

  it("is dismissible mid-tour and tears its chrome down", () => {
    const root = mountSections(["overview", "projects", "coordination"]);
    const tour = new SpotlightTour({ steps: STEPS, root, persistence: { storage: memoryStorage(), metadata: nullMetadata() } });
    tour.start();
    click("skip");

    expect(popover()).toBeNull();
    expect(document.querySelector(".tour-overlay")).toBeNull();
    expect(root.querySelectorAll("[data-tour-active]")).toHaveLength(0);
    expect(tour.isRunning).toBe(false);
  });

  it("dismisses on Escape", () => {
    const root = mountSections(["overview"]);
    const tour = new SpotlightTour({ steps: STEPS, root, persistence: { storage: memoryStorage(), metadata: nullMetadata() } });
    tour.start();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(tour.isRunning).toBe(false);
  });

  it("scrolls an off-screen anchor into view", () => {
    const root = mountSections(["overview"]);
    const anchor = root.querySelector<HTMLElement>('[data-tour="overview"]')!;
    const scrollIntoView = vi.fn();
    anchor.scrollIntoView = scrollIntoView;
    anchor.getBoundingClientRect = () => ({ top: -400, bottom: -200, left: 0, right: 100, width: 100, height: 200, x: 0, y: -400, toJSON: () => ({}) });

    new SpotlightTour({ steps: STEPS, root, persistence: { storage: memoryStorage(), metadata: nullMetadata() } }).start();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });

  it("aligns a section taller than the viewport to its start instead of centring it", () => {
    const root = mountSections(["overview"]);
    const anchor = root.querySelector<HTMLElement>('[data-tour="overview"]')!;
    const scrollIntoView = vi.fn();
    anchor.scrollIntoView = scrollIntoView;
    const tall = window.innerHeight + 400;
    anchor.getBoundingClientRect = () => ({ top: 200, bottom: 200 + tall, left: 0, right: 100, width: 100, height: tall, x: 0, y: 200, toJSON: () => ({}) });

    new SpotlightTour({ steps: STEPS, root, persistence: { storage: memoryStorage(), metadata: nullMetadata() } }).start();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
  });

  it("leaves the page alone when the anchor is already comfortably in view", () => {
    const root = mountSections(["overview"]);
    const anchor = root.querySelector<HTMLElement>('[data-tour="overview"]')!;
    const scrollIntoView = vi.fn();
    anchor.scrollIntoView = scrollIntoView;
    anchor.getBoundingClientRect = () => ({ top: 40, bottom: 240, left: 0, right: 100, width: 100, height: 200, x: 0, y: 40, toJSON: () => ({}) });

    new SpotlightTour({ steps: STEPS, root, persistence: { storage: memoryStorage(), metadata: nullMetadata() } }).start();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("repositions the spotlight on window resize", () => {
    const root = mountSections(["overview"]);
    const anchor = root.querySelector<HTMLElement>('[data-tour="overview"]')!;
    anchor.getBoundingClientRect = () => ({ top: 100, bottom: 300, left: 20, right: 220, width: 200, height: 200, x: 20, y: 100, toJSON: () => ({}) });
    new SpotlightTour({ steps: STEPS, root, persistence: { storage: memoryStorage(), metadata: nullMetadata() } }).start();

    anchor.getBoundingClientRect = () => ({ top: 50, bottom: 150, left: 10, right: 110, width: 100, height: 100, x: 10, y: 50, toJSON: () => ({}) });
    window.dispatchEvent(new Event("resize"));

    const spotlight = document.querySelector<HTMLElement>(".tour-spotlight")!;
    expect(spotlight.style.top).toBe("42px");
    expect(spotlight.style.height).toBe("116px");
  });

  it("ships a step for every frozen data-tour anchor", () => {
    expect(DASHBOARD_TOUR_STEPS.map((step) => step.anchor)).toEqual([
      "overview",
      "projects",
      "coordination",
      "validation",
      "team-switcher"
    ]);
  });
});

describe("completion persistence", () => {
  it("mirrors completion locally even when the metadata write fails", async () => {
    const storage = memoryStorage();
    const metadata: TourMetadata = { read: async () => null, write: async () => { throw new Error("offline"); } };

    await expect(persistTourCompletion("2026-08-01T00:00:00.000Z", { storage, metadata })).resolves.toBeUndefined();
    expect(storage.values[TOUR_COMPLETED_KEY]).toBe("2026-08-01T00:00:00.000Z");
    expect(await isTourCompleted({ storage, metadata })).toBe(true);
  });

  it("does not re-run once completion is persisted locally", async () => {
    const root = mountSections(["overview", "projects", "coordination"]);
    const storage = memoryStorage({ [TOUR_COMPLETED_KEY]: "2026-07-31T00:00:00.000Z" });
    const metadata: TourMetadata = { read: vi.fn(async () => null), write: async () => {} };

    const tour = await maybeStartDashboardTour({ steps: STEPS, root, persistence: { storage, metadata } });
    expect(tour).toBeUndefined();
    expect(popover()).toBeNull();
    // The local mirror short-circuits before any network read.
    expect(metadata.read).not.toHaveBeenCalled();
  });

  it("does not re-run when only Supabase metadata records completion", async () => {
    const root = mountSections(["overview"]);
    const storage = memoryStorage();
    const metadata: TourMetadata = { read: async () => "2026-07-31T00:00:00.000Z", write: async () => {} };

    expect(await maybeStartDashboardTour({ steps: STEPS, root, persistence: { storage, metadata } })).toBeUndefined();
    // ...and it mirrors the remote value so the next load skips the round trip.
    expect(storage.values[TOUR_COMPLETED_KEY]).toBe("2026-07-31T00:00:00.000Z");
  });

  it("runs and then persists completion on a first visit", async () => {
    const root = mountSections(["overview", "projects", "coordination"]);
    const storage = memoryStorage();
    const write = vi.fn(async () => {});
    const metadata: TourMetadata = { read: async () => null, write };

    const tour = await maybeStartDashboardTour({
      steps: STEPS,
      root,
      persistence: { storage, metadata },
      now: () => "2026-08-01T12:00:00.000Z"
    });
    expect(tour?.isRunning).toBe(true);

    click("next");
    click("next");
    click("next");
    await Promise.resolve();

    expect(storage.values[TOUR_COMPLETED_KEY]).toBe("2026-08-01T12:00:00.000Z");
    expect(write).toHaveBeenCalledWith("2026-08-01T12:00:00.000Z");
    expect(await isTourCompleted({ storage, metadata })).toBe(true);
  });

  it("falls through to running the tour when the metadata read throws", async () => {
    const root = mountSections(["overview"]);
    const metadata: TourMetadata = { read: async () => { throw new Error("no session"); }, write: async () => {} };
    expect(await isTourCompleted({ storage: memoryStorage(), metadata })).toBe(false);
    expect((await maybeStartDashboardTour({ steps: STEPS, root, persistence: { storage: memoryStorage(), metadata } }))?.isRunning).toBe(true);
  });
});

function nullMetadata(): TourMetadata {
  return { read: async () => null, write: async () => {} };
}
