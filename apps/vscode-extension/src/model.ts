import * as vscode from "vscode";
import type { Claim, Task, Validation } from "@crosscode/protocol";
import type { StoredOperation } from "../../daemon/src/types.js";
import type { CrosscodeApiClient, DaemonStatus } from "./client.js";

/**
 * Polls the daemon and holds the last-known state for all views.
 * Never applies or rejects anything itself: it only reads, and every
 * write goes back through CrosscodeApiClient to the daemon.
 */
export class CrosscodeModel implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  status: DaemonStatus | undefined;
  connectionError: string | undefined;
  tasks: Task[] = [];
  claims: Claim[] = [];
  proposals: StoredOperation[] = [];
  validations: Validation[] = [];

  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly client: CrosscodeApiClient) {}

  start(intervalMs = 5_000): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.emitter.dispose();
  }

  async refresh(): Promise<void> {
    try {
      const [status, tasks, claims, proposals] = await Promise.all([
        this.client.status(),
        this.client.tasks(),
        this.client.claims(),
        this.client.proposals()
      ]);
      this.status = status;
      this.tasks = tasks;
      this.claims = claims;
      this.proposals = proposals;
      this.connectionError = undefined;
    } catch (error) {
      this.status = undefined;
      this.connectionError = error instanceof Error ? error.message : "Daemon unavailable";
    }
    this.emitter.fire();
  }

  setValidations(validations: Validation[]): void {
    this.validations = validations;
    this.emitter.fire();
  }
}
