import { relative } from "node:path";
import * as vscode from "vscode";
import type { CrosscodeModel } from "./model.js";

export class CrosscodeDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  constructor(private readonly model: CrosscodeModel) {
    model.onDidChange(() => this.emitter.fire(undefined));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const root = this.model.status?.root;
    if (!root || uri.scheme !== "file") return undefined;
    const relativePath = relative(root, uri.fsPath);
    if (relativePath.startsWith("..")) return undefined;

    const hasProposal = this.model.proposals.some((operation) => operation.transaction.changes.some((change) => change.path === relativePath));
    if (hasProposal) return { badge: "P", tooltip: "Crosscode: a pending proposal touches this file", color: new vscode.ThemeColor("charts.orange") };

    const hasClaim = this.model.claims.some((claim) => claim.kind === "path" && (relativePath === claim.target || relativePath.startsWith(`${claim.target}/`)));
    if (hasClaim) return { badge: "C", tooltip: "Crosscode: this path is claimed", color: new vscode.ThemeColor("charts.blue") };

    return undefined;
  }
}
