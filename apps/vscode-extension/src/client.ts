import { DaemonClient } from "../../daemon/src/client.js";
import type { StoredOperation } from "../../daemon/src/types.js";
import type { Claim, Task, Validation } from "@crosscode/protocol";

export type DaemonStatus = Awaited<ReturnType<DaemonClient["status"]>>;
export type ProposalDiff = Awaited<ReturnType<DaemonClient["diff"]>>;

export interface DaemonApi {
  status(): Promise<DaemonStatus>;
  tasks(): Promise<Task[]>;
  createTask(input: { title: string; intent?: string; paths?: string[]; status?: Task["status"] }): Promise<Task>;
  updateTask(id: string, input: { title: string; intent?: string; paths?: string[]; status?: Task["status"] }): Promise<Task>;
  claims(): Promise<Claim[]>;
  createClaim(input: { taskId: string; kind: Claim["kind"]; target: string; mode: Claim["mode"]; expiresAt?: string }): Promise<Claim>;
  releaseClaim(id: string): Promise<Claim>;
  operations(): Promise<StoredOperation[]>;
  diff(id: string): Promise<ProposalDiff>;
  accept(id: string): Promise<StoredOperation>;
  reject(id: string): Promise<StoredOperation>;
  validate(profile: string): Promise<Validation[]>;
}

export type ConnectFn = (directory: string) => Promise<DaemonApi>;

/**
 * Thin client-side wrapper over the daemon's authenticated HTTP API.
 * Holds no sync authority of its own: every method delegates to the daemon,
 * and a failed call drops the cached connection so the next call reconnects
 * (the daemon descriptor rotates its secret whenever the daemon restarts).
 */
export class CrosscodeApiClient {
  private connection: DaemonApi | undefined;
  private connecting: Promise<DaemonApi> | undefined;
  private lastError: string | undefined;

  constructor(private readonly directory: string, private readonly connectFn: ConnectFn = DaemonClient.connect) {}

  getLastError(): string | undefined {
    return this.lastError;
  }

  private async ensureConnected(): Promise<DaemonApi> {
    if (this.connection) return this.connection;
    if (!this.connecting) {
      this.connecting = this.connectFn(this.directory).finally(() => {
        this.connecting = undefined;
      });
    }
    this.connection = await this.connecting;
    return this.connection;
  }

  private async call<T>(fn: (api: DaemonApi) => Promise<T>): Promise<T> {
    try {
      const api = await this.ensureConnected();
      const result = await fn(api);
      this.lastError = undefined;
      return result;
    } catch (error) {
      this.connection = undefined;
      this.lastError = error instanceof Error ? error.message : "Unknown daemon error";
      throw error;
    }
  }

  status(): Promise<DaemonStatus> {
    return this.call((api) => api.status());
  }

  tasks(): Promise<Task[]> {
    return this.call((api) => api.tasks());
  }

  createTask(input: { title: string; intent?: string; paths?: string[]; status?: Task["status"] }): Promise<Task> {
    return this.call((api) => api.createTask(input));
  }

  updateTask(id: string, input: { title: string; intent?: string; paths?: string[]; status?: Task["status"] }): Promise<Task> {
    return this.call((api) => api.updateTask(id, input));
  }

  claims(): Promise<Claim[]> {
    return this.call((api) => api.claims());
  }

  createClaim(input: { taskId: string; kind: Claim["kind"]; target: string; mode: Claim["mode"]; expiresAt?: string }): Promise<Claim> {
    return this.call((api) => api.createClaim(input));
  }

  releaseClaim(id: string): Promise<Claim> {
    return this.call((api) => api.releaseClaim(id));
  }

  async proposals(): Promise<StoredOperation[]> {
    const operations = await this.call((api) => api.operations());
    return operations.filter((operation) => operation.status === "proposed");
  }

  diff(id: string): Promise<ProposalDiff> {
    return this.call((api) => api.diff(id));
  }

  accept(id: string): Promise<StoredOperation> {
    return this.call((api) => api.accept(id));
  }

  reject(id: string): Promise<StoredOperation> {
    return this.call((api) => api.reject(id));
  }

  validate(profile: string): Promise<Validation[]> {
    return this.call((api) => api.validate(profile));
  }
}
