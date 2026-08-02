import type { ChangeTransaction, RemoteOperation, RemoteValidation } from "@crosscode/protocol";
import type { PresenceSession, Project } from "./api.js";

// `riskSchema` is not re-exported as a named type by the protocol package.
export type Risk = ChangeTransaction["safety"]["risk"];

// Contract D is deliberately frontend-only: every number below is derived from the
// workspace snapshot the dashboard already streams plus `GET /v1/projects`. Keeping the
// derivations as pure functions here (rather than inline in the view) is what makes them
// testable without a DOM.

export const UNASSIGNED_PROJECT_NAME = "Unassigned";

export type ProjectRollup = {
  /** `null` is the "Unassigned" bucket: activity recorded before projects existed. */
  projectId: string | null;
  name: string;
  repoRemote: string | null;
  lastActivityAt: string | null;
  editCount: number;
  activeReplicas: number;
};

export type RiskMix = {
  counts: Record<Risk, number>;
  total: number;
};

export type ValidationSummary = {
  total: number;
  passing: number;
  /** `null` when nothing has been validated yet -- rendered as "—", never as 0%. */
  passRate: number | null;
};

const RISK_ORDER: Risk[] = ["low", "medium", "high", "critical"];

// Contract B adds a nullable `project_id` to `operations`; the protocol type on this branch
// predates it, so read it defensively instead of asserting a shape the server may not send.
export function operationProjectId(operation: RemoteOperation): string | null {
  return (operation as RemoteOperation & { projectId?: string | null }).projectId ?? null;
}

export function presenceProjectId(session: PresenceSession): string | null {
  return session.projectId ?? null;
}

export function summarizeValidations(validations: RemoteValidation[]): ValidationSummary {
  const total = validations.length;
  const passing = validations.filter((remote) => remote.validation.exitCode === 0).length;
  return { total, passing, passRate: total === 0 ? null : Math.round((passing / total) * 100) };
}

export function riskMix(operations: RemoteOperation[]): RiskMix {
  const counts: Record<Risk, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const operation of operations) counts[operation.transaction.safety.risk] += 1;
  return { counts, total: operations.length };
}

export function riskMixEntries(mix: RiskMix): Array<{ risk: Risk; count: number; percent: number }> {
  return RISK_ORDER.map((risk) => ({
    risk,
    count: mix.counts[risk],
    percent: mix.total === 0 ? 0 : Math.round((mix.counts[risk] / mix.total) * 100)
  }));
}

/**
 * One card per known project, plus an "Unassigned" bucket for operations and replicas whose
 * `project_id` is null. Projects with no activity yet still get a card -- a freshly paired
 * repo should be visible before its first edit lands.
 */
export function rollUpProjects(
  projects: Project[],
  operations: RemoteOperation[],
  presence: PresenceSession[]
): ProjectRollup[] {
  const rollups = new Map<string | null, ProjectRollup>();
  for (const project of projects) {
    rollups.set(project.id, {
      projectId: project.id,
      name: project.name,
      repoRemote: project.repoRemote,
      lastActivityAt: project.lastActivityAt,
      editCount: 0,
      activeReplicas: 0
    });
  }

  const bucketFor = (projectId: string | null): ProjectRollup => {
    const existing = rollups.get(projectId);
    if (existing) return existing;
    // Either the Unassigned bucket, or an id that `GET /v1/projects` didn't return (a
    // project created after this page loaded). Both are real and shouldn't be dropped.
    const created: ProjectRollup = {
      projectId,
      name: projectId === null ? UNASSIGNED_PROJECT_NAME : projectId,
      repoRemote: null,
      lastActivityAt: null,
      editCount: 0,
      activeReplicas: 0
    };
    rollups.set(projectId, created);
    return created;
  };

  for (const operation of operations) {
    const bucket = bucketFor(operationProjectId(operation));
    bucket.editCount += 1;
    // Live-streamed operations can be newer than the server's `lastActivityAt`, so take
    // whichever is later rather than trusting either one alone.
    if (bucket.lastActivityAt === null || operation.createdAt > bucket.lastActivityAt) {
      bucket.lastActivityAt = operation.createdAt;
    }
  }

  for (const session of presence) {
    if (session.status !== "online") continue;
    bucketFor(presenceProjectId(session)).activeReplicas += 1;
  }

  return [...rollups.values()].sort(compareRollups);
}

function compareRollups(a: ProjectRollup, b: ProjectRollup): number {
  // Unassigned is a leftovers bucket, not a project -- it always sorts last.
  if ((a.projectId === null) !== (b.projectId === null)) return a.projectId === null ? 1 : -1;
  if (a.lastActivityAt === b.lastActivityAt) return a.name.localeCompare(b.name);
  if (a.lastActivityAt === null) return 1;
  if (b.lastActivityAt === null) return -1;
  return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
}
