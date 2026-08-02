import type { RemoteClaim, RemoteHandoff, RemoteIntent, RemoteOperation, RemoteTask, RemoteValidation } from "@crosscode/protocol";
import type { PresenceSession, Project, WorkspaceSnapshot } from "./api.js";
import type { Risk } from "./analytics.js";

// Shared fixtures for the dashboard tests. Kept close to the real payload shapes so the
// sections are exercised against something a live service could actually return.

export function presence(overrides: Partial<PresenceSession> & { replicaId: string }): PresenceSession {
  return {
    actorId: `actor-${overrides.replicaId}`,
    status: "online",
    lastSeenAt: "2026-07-30T10:00:00.000Z",
    cursor: null,
    ...overrides
  };
}

export function operation(overrides: {
  id: string;
  serverSequence: number;
  createdAt?: string;
  risk?: Risk;
  projectId?: string | null;
  senderReplicaId?: string;
  path?: string;
}): RemoteOperation {
  const op: RemoteOperation & { projectId?: string | null } = {
    id: overrides.id,
    eventId: `event-${overrides.id}`,
    workspaceId: "ws-1",
    senderReplicaId: overrides.senderReplicaId ?? "replica-a",
    serverSequence: overrides.serverSequence,
    createdAt: overrides.createdAt ?? "2026-07-30T10:00:00.000Z",
    transaction: {
      id: `tx-${overrides.id}`,
      base: { files: [] },
      changes: [{ path: overrides.path ?? "src/index.ts", kind: "modify", afterContent: "x" }],
      provenance: { source: "mcp", confidence: "known" },
      safety: { risk: overrides.risk ?? "low", requiresApproval: false }
    }
  };
  // Contract B's `project_id` on operations is not in the protocol type on this branch.
  if (overrides.projectId !== undefined) op.projectId = overrides.projectId;
  return op;
}

export function validation(overrides: { eventId: string; exitCode: number; profile?: string }): RemoteValidation {
  return {
    eventId: overrides.eventId,
    workspaceId: "ws-1",
    senderReplicaId: "replica-a",
    createdAt: "2026-07-30T10:00:00.000Z",
    validation: {
      id: `val-${overrides.eventId}`,
      profile: overrides.profile ?? "unit",
      command: "pnpm test",
      exitCode: overrides.exitCode,
      durationMs: 1_200,
      output: "",
      runnerId: "replica-a",
      createdAt: "2026-07-30T10:00:00.000Z"
    }
  };
}

export function project(overrides: Partial<Project> & { id: string; name: string }): Project {
  return {
    workspaceId: "ws-1",
    repoRemote: null,
    repoRoot: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    lastActivityAt: null,
    ...overrides
  };
}

export function task(id: string, status: RemoteTask["task"]["status"] = "active"): RemoteTask {
  return {
    eventId: `event-${id}`,
    workspaceId: "ws-1",
    senderReplicaId: "replica-a",
    updatedAt: "2026-07-30T10:00:00.000Z",
    task: {
      id,
      title: `Task ${id}`,
      ownerId: "actor-a",
      status,
      paths: [],
      createdAt: "2026-07-30T09:00:00.000Z",
      updatedAt: "2026-07-30T10:00:00.000Z"
    }
  };
}

export function claim(id: string, released = false): RemoteClaim {
  return {
    eventId: `event-${id}`,
    workspaceId: "ws-1",
    senderReplicaId: "replica-a",
    updatedAt: "2026-07-30T10:00:00.000Z",
    released,
    claim: {
      id,
      taskId: "task-1",
      ownerId: "actor-a",
      kind: "path",
      target: "src/index.ts",
      mode: "exclusive-preferred",
      createdAt: "2026-07-30T09:30:00.000Z"
    }
  };
}

export function handoff(id: string, status: RemoteHandoff["handoff"]["status"] = "pending"): RemoteHandoff {
  return {
    eventId: `event-${id}`,
    workspaceId: "ws-1",
    senderReplicaId: "replica-a",
    updatedAt: "2026-07-30T10:00:00.000Z",
    handoff: {
      id,
      operationId: "op-1",
      requestedBy: "actor-a",
      status,
      createdAt: "2026-07-30T09:45:00.000Z"
    }
  };
}

export function intent(id: string, text: string): RemoteIntent {
  return {
    eventId: `event-${id}`,
    workspaceId: "ws-1",
    senderReplicaId: "replica-a",
    updatedAt: "2026-07-30T10:00:00.000Z",
    intent: { id, text, actorId: "actor-a", createdAt: "2026-07-30T09:50:00.000Z" }
  };
}

export function emptySnapshot(): WorkspaceSnapshot {
  return { presence: [], tasks: [], claims: [], handoffs: [], intents: [], validations: [], operations: [] };
}

export function fullSnapshot(): WorkspaceSnapshot {
  return {
    presence: [
      presence({ replicaId: "replica-a", projectId: "proj-1" }),
      presence({ replicaId: "replica-b", projectId: "proj-2" }),
      presence({ replicaId: "replica-c", status: "offline", projectId: "proj-1" }),
      presence({ replicaId: "replica-d", projectId: null })
    ],
    tasks: [task("task-1"), task("task-2", "complete")],
    claims: [claim("claim-1"), claim("claim-2", true)],
    handoffs: [handoff("handoff-1"), handoff("handoff-2", "accepted")],
    intents: [intent("intent-1", "Refactor the parser")],
    validations: [
      validation({ eventId: "v1", exitCode: 0 }),
      validation({ eventId: "v2", exitCode: 0 }),
      validation({ eventId: "v3", exitCode: 1, profile: "e2e" })
    ],
    operations: [
      operation({ id: "op-1", serverSequence: 1, projectId: "proj-1", risk: "low", createdAt: "2026-07-30T09:00:00.000Z" }),
      operation({ id: "op-2", serverSequence: 2, projectId: "proj-1", risk: "high", createdAt: "2026-07-30T11:00:00.000Z" }),
      operation({ id: "op-3", serverSequence: 3, projectId: "proj-2", risk: "medium", createdAt: "2026-07-30T10:00:00.000Z" }),
      operation({ id: "op-4", serverSequence: 4, projectId: null, risk: "critical", createdAt: "2026-07-29T10:00:00.000Z" })
    ]
  };
}

export function fixtureProjects(): Project[] {
  return [
    project({ id: "proj-1", name: "crosscode", repoRemote: "github.com/acme/crosscode", lastActivityAt: "2026-07-30T08:00:00.000Z" }),
    project({ id: "proj-2", name: "website", repoRemote: "github.com/acme/website", lastActivityAt: "2026-07-28T08:00:00.000Z" }),
    project({ id: "proj-3", name: "scratch", repoRoot: "/home/dev/scratch" })
  ];
}
