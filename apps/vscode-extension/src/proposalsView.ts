import * as vscode from "vscode";
import type { StoredOperation } from "../../daemon/src/types.js";
import type { CrosscodeApiClient } from "./client.js";
import type { CrosscodeModel } from "./model.js";

export type ProposalsNode =
  | { kind: "proposal"; operation: StoredOperation }
  | { kind: "file"; operation: StoredOperation; path: string };

export class ProposalsTreeProvider implements vscode.TreeDataProvider<ProposalsNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly model: CrosscodeModel) {
    model.onDidChange(() => this.emitter.fire());
  }

  getChildren(element?: ProposalsNode): ProposalsNode[] {
    if (!element) return this.model.proposals.map((operation) => ({ kind: "proposal", operation }));
    if (element.kind === "proposal") return element.operation.transaction.changes.map((change) => ({ kind: "file", operation: element.operation, path: change.path }));
    return [];
  }

  getTreeItem(element: ProposalsNode): vscode.TreeItem {
    if (element.kind === "proposal") {
      const operation = element.operation;
      const item = new vscode.TreeItem(operation.transaction.intent || operation.id, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${operation.transaction.safety.risk} risk · ${operation.transaction.changes.length} file(s) · from ${operation.senderReplicaId}`;
      item.contextValue = "crosscode.proposal";
      item.id = operation.id;
      return item;
    }
    const item = new vscode.TreeItem(element.path, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "crosscode.proposalFile";
    item.command = { command: "crosscode.showProposalDiff", title: "Show Crosscode Proposal Diff", arguments: [element.operation, element.path] };
    return item;
  }
}

/** Serves in-memory before/after content for the diff editor; the daemon remains the only source of truth. */
export class ProposalContentProvider implements vscode.TextDocumentContentProvider {
  private readonly content = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(uri: vscode.Uri, text: string): void {
    this.content.set(uri.toString(), text);
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? "";
  }
}

export async function showProposalDiff(client: CrosscodeApiClient, contentProvider: ProposalContentProvider, operation: StoredOperation, path: string): Promise<void> {
  const entries = await client.diff(operation.id);
  const entry = entries.find((candidate) => candidate.path === path);
  if (!entry) {
    void vscode.window.showWarningMessage(`Crosscode: no diff available for ${path}`);
    return;
  }
  const beforeUri = vscode.Uri.from({ scheme: "crosscode-proposal", path: `/${operation.id}/before/${path}` });
  const afterUri = vscode.Uri.from({ scheme: "crosscode-proposal", path: `/${operation.id}/after/${path}` });
  contentProvider.set(beforeUri, entry.local ?? entry.base ?? "");
  contentProvider.set(afterUri, entry.proposed ?? "");
  await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, `${path} (local ↔ proposed)`, { preview: true });
}

export async function acceptProposal(client: CrosscodeApiClient, model: CrosscodeModel, node?: ProposalsNode): Promise<void> {
  const operation = node?.operation;
  if (!operation) return;
  const risk = operation.transaction.safety.risk;
  const riskWarning = risk === "high" || risk === "critical" ? ` This is a ${risk}-risk change.` : "";
  const choice = await vscode.window.showWarningMessage(
    `Accept proposal from ${operation.senderReplicaId}?${riskWarning} This materializes the proposed changes into your working tree via the daemon.`,
    { modal: true },
    "Accept"
  );
  if (choice !== "Accept") return;
  await client.accept(operation.id);
  await model.refresh();
}

export async function rejectProposal(client: CrosscodeApiClient, model: CrosscodeModel, node?: ProposalsNode): Promise<void> {
  const operation = node?.operation;
  if (!operation) return;
  const choice = await vscode.window.showWarningMessage(`Reject proposal from ${operation.senderReplicaId}? It will not be applied.`, { modal: true }, "Reject");
  if (choice !== "Reject") return;
  await client.reject(operation.id);
  await model.refresh();
}
