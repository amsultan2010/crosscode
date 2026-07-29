import { relative } from "node:path";
import * as vscode from "vscode";
import type { CrosscodeApiClient } from "./client.js";
import type { CrosscodeModel } from "./model.js";
import { acceptProposal, rejectProposal, showProposalDiff, type ProposalContentProvider, type ProposalsNode } from "./proposalsView.js";
import type { TasksNode } from "./tasksView.js";
import { runValidation } from "./validationView.js";

async function createTask(client: CrosscodeApiClient, model: CrosscodeModel): Promise<void> {
  const title = await vscode.window.showInputBox({ prompt: "Crosscode task title" });
  if (!title) return;
  const pathsInput = await vscode.window.showInputBox({ prompt: "Paths this task covers (comma-separated, optional)" });
  const paths = pathsInput ? pathsInput.split(",").map((path) => path.trim()).filter(Boolean) : undefined;
  await client.createTask({ title, paths });
  await model.refresh();
}

async function claimPath(client: CrosscodeApiClient, model: CrosscodeModel, resourceUri?: vscode.Uri): Promise<void> {
  if (!model.tasks.length) {
    void vscode.window.showWarningMessage("Create a Crosscode task before claiming a path.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    model.tasks.map((task) => ({ label: task.title, description: task.status, task })),
    { placeHolder: "Claim a path for which task?" }
  );
  if (!picked) return;

  const root = model.status?.root;
  const uri = resourceUri ?? vscode.window.activeTextEditor?.document.uri;
  const defaultTarget = root && uri?.scheme === "file" ? relative(root, uri.fsPath) : "";
  const target = await vscode.window.showInputBox({ prompt: "Path to claim (relative to repository root)", value: defaultTarget });
  if (!target) return;

  await client.createClaim({ taskId: picked.task.id, kind: "path", target, mode: "exclusive-preferred" });
  await model.refresh();
}

async function releaseClaim(client: CrosscodeApiClient, model: CrosscodeModel, node?: TasksNode): Promise<void> {
  if (!node || node.kind !== "claim") return;
  const choice = await vscode.window.showWarningMessage(`Release the claim on "${node.claim.target}"?`, { modal: true }, "Release");
  if (choice !== "Release") return;
  await client.releaseClaim(node.claim.id);
  await model.refresh();
}

export function registerCommands(
  context: vscode.ExtensionContext,
  client: CrosscodeApiClient,
  model: CrosscodeModel,
  contentProvider: ProposalContentProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("crosscode.refresh", () => model.refresh()),
    vscode.commands.registerCommand("crosscode.createTask", () => createTask(client, model)),
    vscode.commands.registerCommand("crosscode.claimPath", (resourceUri?: vscode.Uri) => claimPath(client, model, resourceUri)),
    vscode.commands.registerCommand("crosscode.releaseClaim", (node?: TasksNode) => releaseClaim(client, model, node)),
    vscode.commands.registerCommand("crosscode.showProposalDiff", (operation, path) => showProposalDiff(client, contentProvider, operation, path)),
    vscode.commands.registerCommand("crosscode.acceptProposal", (node?: ProposalsNode) => acceptProposal(client, model, node)),
    vscode.commands.registerCommand("crosscode.rejectProposal", (node?: ProposalsNode) => rejectProposal(client, model, node)),
    vscode.commands.registerCommand("crosscode.runValidation", () => runValidation(client, model))
  );
}
