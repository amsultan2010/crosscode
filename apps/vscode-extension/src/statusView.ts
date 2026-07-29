import * as vscode from "vscode";
import type { CrosscodeModel } from "./model.js";

function line(label: string, description?: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  if (description) item.description = description;
  return item;
}

export class StatusTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly model: CrosscodeModel) {
    model.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): vscode.TreeItem[] {
    if (this.model.connectionError) {
      return [line("Daemon: disconnected", this.model.connectionError)];
    }
    const status = this.model.status;
    if (!status) return [line("Daemon: connecting…")];
    return [
      line("Repository", status.root),
      line("Branch", `${status.branch ?? "(detached)"}${status.dirty ? " · dirty" : ""}`),
      line("Daemon", "connected"),
      line("Service", status.service.configured ? (status.service.online ? "online" : "offline") : "not configured"),
      line("Outbox", `${status.pendingOutbound} pending`),
      line("Tasks", `${status.tasks}`),
      line("Claims", `${status.claims}`),
      line("Proposals", `${status.proposals}`)
    ];
  }
}
