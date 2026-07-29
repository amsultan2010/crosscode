import * as vscode from "vscode";
import type { Claim, Task } from "@crosscode/protocol";
import type { CrosscodeModel } from "./model.js";

export type TasksNode =
  | { kind: "group"; label: "tasks" | "claims" }
  | { kind: "task"; task: Task }
  | { kind: "claim"; claim: Claim };

export class TasksTreeProvider implements vscode.TreeDataProvider<TasksNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly model: CrosscodeModel) {
    model.onDidChange(() => this.emitter.fire());
  }

  getChildren(element?: TasksNode): TasksNode[] {
    if (!element) return [{ kind: "group", label: "tasks" }, { kind: "group", label: "claims" }];
    if (element.kind === "group" && element.label === "tasks") return this.model.tasks.map((task) => ({ kind: "task", task }));
    if (element.kind === "group" && element.label === "claims") return this.model.claims.map((claim) => ({ kind: "claim", claim }));
    return [];
  }

  getTreeItem(element: TasksNode): vscode.TreeItem {
    if (element.kind === "group") {
      const label = element.label === "tasks" ? `Tasks (${this.model.tasks.length})` : `Claims (${this.model.claims.length})`;
      return new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    }
    if (element.kind === "task") {
      const task = element.task;
      const item = new vscode.TreeItem(task.title, vscode.TreeItemCollapsibleState.None);
      item.description = task.status;
      item.contextValue = "crosscode.task";
      item.tooltip = [`id: ${task.id}`, task.intent, task.paths.length ? `paths: ${task.paths.join(", ")}` : undefined].filter(Boolean).join("\n");
      return item;
    }
    const claim = element.claim;
    const item = new vscode.TreeItem(claim.target, vscode.TreeItemCollapsibleState.None);
    item.description = `${claim.kind} · ${claim.mode}`;
    item.contextValue = "crosscode.claim";
    item.tooltip = `task: ${claim.taskId}\nowner: ${claim.ownerId}`;
    return item;
  }
}
