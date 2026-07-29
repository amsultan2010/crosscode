import * as vscode from "vscode";
import { CrosscodeApiClient } from "./client.js";
import { registerCommands } from "./commands.js";
import { CrosscodeDecorationProvider } from "./decorations.js";
import { CrosscodeModel } from "./model.js";
import { ProposalContentProvider, ProposalsTreeProvider } from "./proposalsView.js";
import { StatusTreeProvider } from "./statusView.js";
import { TasksTreeProvider } from "./tasksView.js";
import { ValidationTreeProvider } from "./validationView.js";

export function activate(context: vscode.ExtensionContext): void {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "crosscode.refresh";
  statusBarItem.text = "$(sync) Crosscode";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const directory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!directory) {
    statusBarItem.text = "$(circle-slash) Crosscode: no workspace open";
    return;
  }

  const client = new CrosscodeApiClient(directory);
  const model = new CrosscodeModel(client);
  context.subscriptions.push(model);

  const contentProvider = new ProposalContentProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("crosscode.statusView", new StatusTreeProvider(model)),
    vscode.window.registerTreeDataProvider("crosscode.tasksView", new TasksTreeProvider(model)),
    vscode.window.registerTreeDataProvider("crosscode.proposalsView", new ProposalsTreeProvider(model)),
    vscode.window.registerTreeDataProvider("crosscode.validationView", new ValidationTreeProvider(model)),
    vscode.window.registerFileDecorationProvider(new CrosscodeDecorationProvider(model)),
    vscode.workspace.registerTextDocumentContentProvider("crosscode-proposal", contentProvider),
    model.onDidChange(() => {
      if (model.connectionError) statusBarItem.text = "$(error) Crosscode: disconnected";
      else statusBarItem.text = `$(check) Crosscode: ${model.status?.branch ?? "connected"}`;
    })
  );

  registerCommands(context, client, model, contentProvider);

  model.start();
}

export function deactivate(): void {
  // Disposal of subscriptions (including the model's polling timer) is handled
  // by the extension host via context.subscriptions; the daemon and its sync
  // state are entirely unaffected by this extension stopping or being disabled.
}
