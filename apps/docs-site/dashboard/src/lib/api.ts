import {
  EPOCH_CURSOR,
  type RegisterReplicaResponse,
  type RemoteClaim,
  type RemoteHandoff,
  type RemoteIntent,
  type RemoteOperation,
  type RemoteTask,
  type RemoteValidation,
  type WorkspaceBillingResponse,
  type ListMembershipsResponse
} from "@crosscode/protocol";

export type PresenceSession = {
  replicaId: string;
  actorId: string;
  status: "online" | "offline";
  lastSeenAt: string | null;
  cursor: number | null;
};

export type WorkspaceSnapshot = {
  presence: PresenceSession[];
  tasks: RemoteTask[];
  claims: RemoteClaim[];
  handoffs: RemoteHandoff[];
  intents: RemoteIntent[];
  validations: RemoteValidation[];
  operations: RemoteOperation[];
};

const WORKSPACE_HEADER = "x-crosscode-workspace-id";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type AuthContext = {
  serviceUrl: string;
  accessToken: string;
  workspaceId: string;
};

export type SessionContext = {
  serviceUrl: string;
  accessToken: string;
};

async function request<T>(session: SessionContext, method: string, path: string, options?: { workspaceId?: string; body?: unknown }): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}` };
  if (options?.workspaceId) headers[WORKSPACE_HEADER] = options.workspaceId;
  if (options?.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(path, session.serviceUrl), {
    method,
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : response.statusText;
    throw new ApiError(response.status, message);
  }
  return (payload as { data: T }).data;
}

export async function registerReplica(auth: AuthContext, name: string): Promise<RegisterReplicaResponse> {
  return request<RegisterReplicaResponse>(auth, "POST", "/v1/replicas", { workspaceId: auth.workspaceId, body: { name } });
}

export async function fetchPresence(auth: AuthContext): Promise<PresenceSession[]> {
  const data = await request<{ sessions: PresenceSession[] }>(auth, "GET", "/v1/presence", { workspaceId: auth.workspaceId });
  return data.sessions;
}

export async function fetchTasks(auth: AuthContext): Promise<RemoteTask[]> {
  const data = await request<{ tasks: RemoteTask[]; nextCursor: string }>(
    auth,
    "GET",
    `/v1/tasks?after=${encodeURIComponent(EPOCH_CURSOR)}`,
    { workspaceId: auth.workspaceId }
  );
  return data.tasks;
}

export async function fetchClaims(auth: AuthContext): Promise<RemoteClaim[]> {
  const data = await request<{ claims: RemoteClaim[]; nextCursor: string }>(
    auth,
    "GET",
    `/v1/claims?after=${encodeURIComponent(EPOCH_CURSOR)}`,
    { workspaceId: auth.workspaceId }
  );
  return data.claims;
}

export async function fetchHandoffs(auth: AuthContext): Promise<RemoteHandoff[]> {
  const data = await request<{ handoffs: RemoteHandoff[]; nextCursor: string }>(
    auth,
    "GET",
    `/v1/handoffs?after=${encodeURIComponent(EPOCH_CURSOR)}`,
    { workspaceId: auth.workspaceId }
  );
  return data.handoffs;
}

export async function fetchIntents(auth: AuthContext): Promise<RemoteIntent[]> {
  const data = await request<{ intents: RemoteIntent[]; nextCursor: string }>(
    auth,
    "GET",
    `/v1/intents?after=${encodeURIComponent(EPOCH_CURSOR)}`,
    { workspaceId: auth.workspaceId }
  );
  return data.intents;
}

export async function fetchValidations(auth: AuthContext): Promise<RemoteValidation[]> {
  const data = await request<{ validations: RemoteValidation[]; nextCursor: string }>(
    auth,
    "GET",
    `/v1/validations?after=${encodeURIComponent(EPOCH_CURSOR)}`,
    { workspaceId: auth.workspaceId }
  );
  return data.validations;
}

export async function fetchOperations(auth: AuthContext): Promise<RemoteOperation[]> {
  const data = await request<{ operations: RemoteOperation[]; nextCursor: number }>(
    auth,
    "GET",
    "/v1/operations?afterSequence=0",
    { workspaceId: auth.workspaceId }
  );
  return data.operations;
}

export async function fetchBillingStatus(auth: AuthContext): Promise<WorkspaceBillingResponse> {
  return request<WorkspaceBillingResponse>(auth, "GET", "/v1/workspace/billing", { workspaceId: auth.workspaceId });
}

export async function fetchWorkspaceSnapshot(auth: AuthContext): Promise<WorkspaceSnapshot> {
  const [presence, tasks, claims, handoffs, intents, validations, operations] = await Promise.all([
    fetchPresence(auth),
    fetchTasks(auth),
    fetchClaims(auth),
    fetchHandoffs(auth),
    fetchIntents(auth),
    fetchValidations(auth),
    fetchOperations(auth)
  ]);
  return { presence, tasks, claims, handoffs, intents, validations, operations };
}

export async function redeemInvite(session: SessionContext, code: string): Promise<{ workspaceId: string }> {
  return request<{ workspaceId: string }>(session, "POST", `/v1/invites/${encodeURIComponent(code)}/redeem`, { body: {} });
}

// Self-serve workspace creation for a freshly signed-up account with no membership yet
// (no `workspaceId` header: there is nothing to scope one to before this call succeeds).
export async function createWorkspace(session: SessionContext, name: string): Promise<{ workspaceId: string }> {
  return request<{ workspaceId: string }>(session, "POST", "/v1/workspaces", { body: { name } });
}

// Every workspace ("team") the signed-in user belongs to -- powers the dashboard's
// team switcher instead of asking someone to paste a raw workspace ID.
export async function fetchMemberships(session: SessionContext): Promise<ListMembershipsResponse["memberships"]> {
  const data = await request<ListMembershipsResponse>(session, "GET", "/v1/memberships");
  return data.memberships;
}
