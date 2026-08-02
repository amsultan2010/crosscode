import { getSupabaseClient } from "./supabase.js";

// Anchored spotlight tour over the live dashboard. It attaches to real elements by their
// `data-tour` attribute (Contract D freezes those values), dims everything else, and is
// dismissible at any point.

export const TOUR_COMPLETED_KEY = "crosscode.dashboard.onboardingCompletedAt";

export type TourStep = {
  /** `data-tour` value of the element to anchor to. */
  anchor: string;
  title: string;
  body: string;
};

export const DASHBOARD_TOUR_STEPS: TourStep[] = [
  {
    anchor: "overview",
    title: "Your workspace at a glance",
    body: "Live presence, connected projects, settled edits and seat usage. These update in real time as your agents work."
  },
  {
    anchor: "projects",
    title: "One card per repository",
    body: "Every repo a daemon has paired from shows up here with its remote, last activity, edit count and how many replicas are on it right now."
  },
  {
    anchor: "coordination",
    title: "How agents stay out of each other's way",
    body: "Tasks, file claims, handoffs and declared intents — the coordination surface that keeps concurrent edits from colliding."
  },
  {
    anchor: "validation",
    title: "Safety and validation",
    body: "Validation pass rate, recent runs, and the risk mix of the edits that landed. High-risk changes are worth a second look."
  },
  {
    anchor: "team-switcher",
    title: "Working with a team",
    body: "You start in a personal workspace. Create a team whenever you want, then switch between them here."
  }
];

export type TourStorage = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

export type TourMetadata = {
  read(): Promise<string | null>;
  write(completedAt: string): Promise<void>;
};

const browserStorage: TourStorage = {
  get: (key) => {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set: (key, value) => {
    try { localStorage.setItem(key, value); } catch { /* private mode: the metadata copy is the fallback */ }
  }
};

const supabaseMetadata: TourMetadata = {
  read: async () => {
    const { data } = await getSupabaseClient().auth.getUser();
    const value = data.user?.user_metadata?.onboarding_completed_at;
    return typeof value === "string" ? value : null;
  },
  write: async (completedAt) => {
    const { error } = await getSupabaseClient().auth.updateUser({ data: { onboarding_completed_at: completedAt } });
    if (error) throw error;
  }
};

export type TourPersistence = { storage?: TourStorage; metadata?: TourMetadata };

/**
 * The tour has run if either copy says so. The local mirror is checked first so a signed-in
 * user who already finished doesn't pay a network round trip on every dashboard load.
 */
export async function isTourCompleted(persistence: TourPersistence = {}): Promise<boolean> {
  const storage = persistence.storage ?? browserStorage;
  if (storage.get(TOUR_COMPLETED_KEY)) return true;
  const metadata = persistence.metadata ?? supabaseMetadata;
  try {
    const remote = await metadata.read();
    if (remote) {
      // Mirror it locally so a second device only asks the network once.
      storage.set(TOUR_COMPLETED_KEY, remote);
      return true;
    }
  } catch {
    // Auth/network trouble: fall through and let the tour run rather than blocking on it.
  }
  return false;
}

/**
 * Writes the local mirror *first* and unconditionally. Contract D: a Supabase metadata write
 * failure must never cause the tour to re-run on every load.
 */
export async function persistTourCompletion(completedAt: string, persistence: TourPersistence = {}): Promise<void> {
  const storage = persistence.storage ?? browserStorage;
  storage.set(TOUR_COMPLETED_KEY, completedAt);
  const metadata = persistence.metadata ?? supabaseMetadata;
  try {
    await metadata.write(completedAt);
  } catch {
    // Already mirrored locally; nothing more to do from the browser.
  }
}

export type SpotlightTourOptions = {
  steps?: TourStep[];
  root?: ParentNode;
  mount?: HTMLElement;
  persistence?: TourPersistence;
  /** ISO timestamp recorded on completion; injectable so tests don't depend on the clock. */
  now?: () => string;
  onFinish?: () => void;
};

export class SpotlightTour {
  readonly steps: TourStep[];
  private readonly root: ParentNode;
  private readonly mount: HTMLElement;
  private readonly persistence: TourPersistence;
  private readonly now: () => string;
  private readonly onFinish: (() => void) | undefined;

  private index = -1;
  private overlay: HTMLDivElement | undefined;
  private spotlight: HTMLDivElement | undefined;
  private popover: HTMLDivElement | undefined;
  private finished = false;

  constructor(options: SpotlightTourOptions = {}) {
    this.steps = options.steps ?? DASHBOARD_TOUR_STEPS;
    this.root = options.root ?? document;
    this.mount = options.mount ?? document.body;
    this.persistence = options.persistence ?? {};
    this.now = options.now ?? (() => new Date().toISOString());
    this.onFinish = options.onFinish;
  }

  get currentIndex(): number {
    return this.index;
  }

  get currentStep(): TourStep | undefined {
    return this.steps[this.index];
  }

  get isRunning(): boolean {
    return this.index >= 0 && !this.finished;
  }

  /** Returns false (and persists completion) when not a single step has a live anchor. */
  start(): boolean {
    const first = this.nextAnchoredIndex(0);
    if (first === undefined) {
      void this.finish();
      return false;
    }
    this.buildChrome();
    this.goTo(first);
    return true;
  }

  next(): void {
    const following = this.nextAnchoredIndex(this.index + 1);
    if (following === undefined) {
      void this.finish();
      return;
    }
    this.goTo(following);
  }

  previous(): void {
    for (let candidate = this.index - 1; candidate >= 0; candidate -= 1) {
      if (this.anchorFor(candidate)) {
        this.goTo(candidate);
        return;
      }
    }
  }

  /** Dismissing counts as completion: a tour the user closed should not come back. */
  dismiss(): void {
    void this.finish();
  }

  anchorFor(index: number): HTMLElement | null {
    const step = this.steps[index];
    if (!step) return null;
    const element = this.root.querySelector<HTMLElement>(`[data-tour="${step.anchor}"]`);
    // A hidden anchor (the team switcher before memberships load, say) is as good as
    // missing -- spotlighting it would dim the page and point at nothing.
    if (!element || element.hidden || element.closest("[hidden]")) return null;
    return element;
  }

  /** The first index at or after `from` whose anchor actually exists; undefined if none do. */
  private nextAnchoredIndex(from: number): number | undefined {
    for (let candidate = Math.max(0, from); candidate < this.steps.length; candidate += 1) {
      if (this.anchorFor(candidate)) return candidate;
    }
    return undefined;
  }

  private goTo(index: number): void {
    this.index = index;
    const anchor = this.anchorFor(index);
    if (!anchor) {
      this.next();
      return;
    }
    anchor.dataset.tourActive = "true";
    for (const other of this.root.querySelectorAll<HTMLElement>("[data-tour-active]")) {
      if (other !== anchor) delete other.dataset.tourActive;
    }
    this.renderPopover(index);
    this.scrollAnchorIntoView(anchor);
    this.position(anchor);
  }

  private scrollAnchorIntoView(anchor: HTMLElement): void {
    // Not every host implements scrollIntoView (happy-dom in tests, older embedded views).
    if (typeof anchor.scrollIntoView !== "function") return;
    const rect = anchor.getBoundingClientRect();
    const viewport = window.innerHeight || 0;
    // A section taller than the viewport can't be centred usefully -- centring it pushes
    // its own heading off the top -- so those get aligned to their start instead.
    const block = rect.height > viewport - 80 ? "start" : "center";
    const settled = block === "start" ? rect.top >= 0 && rect.top < viewport * 0.25 : rect.top >= 0 && rect.bottom <= viewport;
    if (settled) return;
    anchor.scrollIntoView({ block, behavior: "smooth" });
    // Smooth scrolling settles asynchronously; re-place the chrome once it has.
    window.setTimeout(() => { if (this.isRunning) this.reposition(); }, 320);
  }

  private buildChrome(): void {
    const overlay = document.createElement("div");
    overlay.className = "tour-overlay";
    overlay.dataset.tourOverlay = "true";

    const spotlight = document.createElement("div");
    spotlight.className = "tour-spotlight";
    overlay.append(spotlight);

    // The popover is a sibling of the overlay, not a child: the overlay's z-index creates
    // a stacking context, so a nested popover would paint *under* the lifted anchor.
    const popover = document.createElement("div");
    popover.className = "tour-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-modal", "false");

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) this.dismiss();
    });
    popover.addEventListener("click", (event) => {
      const action = (event.target as HTMLElement | null)?.dataset?.tourAction;
      if (action === "next") this.next();
      else if (action === "back") this.previous();
      else if (action === "skip") this.dismiss();
    });

    this.mount.append(overlay, popover);
    this.overlay = overlay;
    this.spotlight = spotlight;
    this.popover = popover;

    window.addEventListener("resize", this.reposition);
    window.addEventListener("scroll", this.reposition, true);
    document.addEventListener("keydown", this.onKeyDown);
  }

  private renderPopover(index: number): void {
    const popover = this.popover;
    const step = this.steps[index];
    if (!popover || !step) return;
    const remaining = this.nextAnchoredIndex(index + 1) !== undefined;
    const hasPrevious = this.steps.slice(0, index).some((_, candidate) => this.anchorFor(candidate));
    popover.dataset.tourStep = step.anchor;
    popover.innerHTML = `
      <p class="tour-step-count">Step ${index + 1} of ${this.steps.length}</p>
      <h3>${escapeHtml(step.title)}</h3>
      <p class="tour-body">${escapeHtml(step.body)}</p>
      <div class="tour-actions">
        <button type="button" data-tour-action="skip" class="tour-skip">Skip tour</button>
        <span class="tour-spacer"></span>
        ${hasPrevious ? '<button type="button" data-tour-action="back">Back</button>' : ""}
        <button type="button" data-tour-action="next" class="tour-next">${remaining ? "Next" : "Done"}</button>
      </div>
    `;
  }

  private reposition = (): void => {
    if (!this.isRunning) return;
    const anchor = this.anchorFor(this.index);
    // The anchor can vanish mid-tour (a re-render, a section that emptied out).
    if (!anchor) { this.next(); return; }
    this.position(anchor);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.isRunning) return;
    if (event.key === "Escape") this.dismiss();
    else if (event.key === "ArrowRight") this.next();
    else if (event.key === "ArrowLeft") this.previous();
  };

  private position(anchor: HTMLElement): void {
    const spotlight = this.spotlight;
    const popover = this.popover;
    if (!spotlight || !popover) return;
    const rect = anchor.getBoundingClientRect();
    const pad = 8;
    spotlight.style.top = `${rect.top - pad}px`;
    spotlight.style.left = `${rect.left - pad}px`;
    spotlight.style.width = `${rect.width + pad * 2}px`;
    spotlight.style.height = `${rect.height + pad * 2}px`;

    const viewportHeight = window.innerHeight || 0;
    const viewportWidth = window.innerWidth || 0;
    const popoverRect = popover.getBoundingClientRect();
    const popoverHeight = popoverRect.height || 180;
    const popoverWidth = popoverRect.width || 320;

    // Prefer below the anchor; flip above when there isn't room, then clamp to the viewport
    // so the popover never lands half off-screen after a resize.
    const below = rect.bottom + pad * 2;
    const above = rect.top - popoverHeight - pad * 2;
    const top = below + popoverHeight <= viewportHeight || above < 0 ? below : above;
    const left = Math.min(Math.max(pad, rect.left), Math.max(pad, viewportWidth - popoverWidth - pad));
    popover.style.top = `${Math.max(pad, Math.min(top, Math.max(pad, viewportHeight - popoverHeight - pad)))}px`;
    popover.style.left = `${left}px`;
  }

  private async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.teardown();
    this.onFinish?.();
    await persistTourCompletion(this.now(), this.persistence);
  }

  private teardown(): void {
    window.removeEventListener("resize", this.reposition);
    window.removeEventListener("scroll", this.reposition, true);
    document.removeEventListener("keydown", this.onKeyDown);
    for (const element of this.root.querySelectorAll<HTMLElement>("[data-tour-active]")) {
      delete element.dataset.tourActive;
    }
    this.overlay?.remove();
    this.popover?.remove();
    this.overlay = undefined;
    this.spotlight = undefined;
    this.popover = undefined;
  }
}

/** Runs the tour once, on first arrival at the dashboard. */
export async function maybeStartDashboardTour(options: SpotlightTourOptions = {}): Promise<SpotlightTour | undefined> {
  if (await isTourCompleted(options.persistence)) return undefined;
  const tour = new SpotlightTour(options);
  tour.start();
  return tour;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
