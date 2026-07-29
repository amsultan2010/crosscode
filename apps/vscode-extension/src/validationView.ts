import * as vscode from "vscode";
import type { Validation } from "@crosscode/protocol";
import type { CrosscodeApiClient } from "./client.js";
import type { CrosscodeModel } from "./model.js";

type ValidationNode = { kind: "empty" } | { kind: "result"; validation: Validation };

export class ValidationTreeProvider implements vscode.TreeDataProvider<ValidationNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly model: CrosscodeModel) {
    model.onDidChange(() => this.emitter.fire());
  }

  getChildren(): ValidationNode[] {
    if (!this.model.validations.length) return [{ kind: "empty" }];
    return this.model.validations.map((validation) => ({ kind: "result", validation }));
  }

  getTreeItem(element: ValidationNode): vscode.TreeItem {
    if (element.kind === "empty") return new vscode.TreeItem("Run “Crosscode: Validate” to check the workspace", vscode.TreeItemCollapsibleState.None);
    const validation = element.validation;
    const passed = validation.exitCode === 0;
    const item = new vscode.TreeItem(`${passed ? "$(pass)" : "$(error)"} ${validation.profile}: ${validation.command}`, vscode.TreeItemCollapsibleState.None);
    item.description = `${passed ? "pass" : `fail (${validation.exitCode})`} · ${validation.durationMs}ms`;
    item.tooltip = new vscode.MarkdownString(`\`\`\`\n${validation.output.slice(0, 4_000)}\n\`\`\``);
    return item;
  }
}

export async function runValidation(client: CrosscodeApiClient, model: CrosscodeModel): Promise<void> {
  const profile = await vscode.window.showInputBox({ prompt: "Validation profile to run (from committed .crosscode/config.yaml)", value: "fast" });
  if (!profile) return;
  try {
    const results = await client.validate(profile);
    model.setValidations(results);
    const failed = results.filter((result) => result.exitCode !== 0);
    if (failed.length) void vscode.window.showErrorMessage(`Crosscode validation "${profile}": ${failed.length} of ${results.length} command(s) failed.`);
    else void vscode.window.showInformationMessage(`Crosscode validation "${profile}": all ${results.length} command(s) passed.`);
  } catch (error) {
    void vscode.window.showErrorMessage(`Crosscode validation failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
