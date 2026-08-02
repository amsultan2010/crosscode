const WORKSPACE_KEY = "crosscode.dashboard.workspaceId";
const REPLICA_KEY_PREFIX = "crosscode.dashboard.replicaId.";

export function getStoredWorkspaceId(): string | null {
  return localStorage.getItem(WORKSPACE_KEY);
}

export function setStoredWorkspaceId(workspaceId: string): void {
  localStorage.setItem(WORKSPACE_KEY, workspaceId);
}

export function getStoredReplicaId(workspaceId: string): string | null {
  return localStorage.getItem(REPLICA_KEY_PREFIX + workspaceId);
}

export function setStoredReplicaId(workspaceId: string, replicaId: string): void {
  localStorage.setItem(REPLICA_KEY_PREFIX + workspaceId, replicaId);
}
