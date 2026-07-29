import * as assert from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { DaemonClient } from "../../../daemon/src/client.js";
import type { CrosscodeExtensionApi } from "../../src/extension.js";
import { ProposalsTreeProvider, type ProposalsNode } from "../../src/proposalsView.js";
import { StatusTreeProvider } from "../../src/statusView.js";
import { TasksTreeProvider, type TasksNode } from "../../src/tasksView.js";

const EXTENSION_ID = "crosscode.crosscode-vscode-extension";

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for condition${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

/** Temporarily replaces vscode.window dialog methods so commands that would otherwise show interactive UI can be driven headlessly. */
function stubDialogs(stubs: {
  showInputBox?: string[];
  showQuickPick?: (items: unknown[]) => unknown;
  showWarningMessage?: string;
}): () => void {
  const originalInputBox = vscode.window.showInputBox;
  const originalQuickPick = vscode.window.showQuickPick;
  const originalWarning = vscode.window.showWarningMessage;

  const inputValues = [...(stubs.showInputBox ?? [])];
  (vscode.window as { showInputBox: typeof vscode.window.showInputBox }).showInputBox = (async () => inputValues.shift()) as typeof vscode.window.showInputBox;
  if (stubs.showQuickPick) {
    (vscode.window as { showQuickPick: typeof vscode.window.showQuickPick }).showQuickPick = (async (items: unknown[]) =>
      stubs.showQuickPick!(items)) as unknown as typeof vscode.window.showQuickPick;
  }
  if (stubs.showWarningMessage !== undefined) {
    (vscode.window as { showWarningMessage: typeof vscode.window.showWarningMessage }).showWarningMessage = (async () =>
      stubs.showWarningMessage) as typeof vscode.window.showWarningMessage;
  }

  return () => {
    (vscode.window as { showInputBox: typeof vscode.window.showInputBox }).showInputBox = originalInputBox;
    (vscode.window as { showQuickPick: typeof vscode.window.showQuickPick }).showQuickPick = originalQuickPick;
    (vscode.window as { showWarningMessage: typeof vscode.window.showWarningMessage }).showWarningMessage = originalWarning;
  };
}

export async function run(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(workspaceRoot, "expected a workspace folder to be open");

  const claimedPath = process.env.CROSSCODE_TEST_CLAIM_PATH ?? "claimed.txt";
  const proposedPathA = process.env.CROSSCODE_TEST_PROPOSAL_PATH_A ?? "shared-a.txt";
  const proposedPathB = process.env.CROSSCODE_TEST_PROPOSAL_PATH_B ?? "shared-b.txt";

  const extension = vscode.extensions.getExtension<CrosscodeExtensionApi>(EXTENSION_ID);
  assert.ok(extension, `expected extension ${EXTENSION_ID} to be discovered`);
  const api = extension.isActive ? extension.exports : await extension.activate();
  assert.ok(api, "expected activate() to return the Crosscode test API");
  const { model, decorations } = api;

  const directDaemon = await DaemonClient.connect(workspaceRoot);

  // 1. Status view reflects real daemon status.
  await waitFor(() => model.status);
  const directStatus = await directDaemon.status();
  // model.status.root comes from the daemon's own Git discovery, same as directStatus.root; the
  // vscode-reported workspaceRoot can differ by a /private symlink alias on macOS, so any path we
  // build to match against the model/decorations must be joined from `root`, not `workspaceRoot`.
  const root = directStatus.root;
  assert.strictEqual(model.status?.root, directStatus.root);
  assert.strictEqual(model.status?.branch, directStatus.branch);
  assert.strictEqual(model.status?.workspaceId, directStatus.workspaceId);
  const statusItems = new StatusTreeProvider(model).getChildren();
  assert.ok(statusItems.some((item) => String(item.label).startsWith("Daemon") && item.description === "connected"));

  // 2. Creating a task through the extension's command calls the real daemon.
  const taskTitle = `Integration task ${Date.now()}`;
  let restore = stubDialogs({ showInputBox: [taskTitle, ""] });
  try {
    await vscode.commands.executeCommand("crosscode.createTask");
  } finally {
    restore();
  }
  await waitFor(() => model.tasks.find((task) => task.title === taskTitle));
  const createdTask = model.tasks.find((task) => task.title === taskTitle)!;
  const remoteTasks = await directDaemon.tasks();
  assert.ok(remoteTasks.some((task) => task.id === createdTask.id), "task must be persisted by the real daemon, not only in the extension's cache");

  // 3. Claiming a path through the extension's command calls the real daemon.
  restore = stubDialogs({
    showQuickPick: (items) => (items as Array<{ task: { id: string } }>).find((item) => item.task.id === createdTask.id),
    showInputBox: [claimedPath]
  });
  try {
    await vscode.commands.executeCommand("crosscode.claimPath");
  } finally {
    restore();
  }
  await waitFor(() => model.claims.find((claim) => claim.target === claimedPath));
  const remoteClaims = await directDaemon.claims();
  assert.ok(remoteClaims.some((claim) => claim.target === claimedPath), "claim must be persisted by the real daemon");
  const tasksTreeChildren = new TasksTreeProvider(model).getChildren({ kind: "group", label: "claims" });
  assert.ok(tasksTreeChildren.some((node: TasksNode) => node.kind === "claim" && node.claim.target === claimedPath));

  // 4. A real pending proposal (seeded by a second replica before VS Code launched) appears in the proposals view.
  await waitFor(() => (model.proposals.length >= 2 ? true : undefined));
  const proposalA = model.proposals.find((operation) => operation.transaction.changes.some((change) => change.path === proposedPathA));
  const proposalB = model.proposals.find((operation) => operation.transaction.changes.some((change) => change.path === proposedPathB));
  assert.ok(proposalA, `expected a pending proposal touching ${proposedPathA}`);
  assert.ok(proposalB, `expected a pending proposal touching ${proposedPathB}`);
  const proposalsTreeChildren = new ProposalsTreeProvider(model).getChildren();
  assert.ok(proposalsTreeChildren.some((node) => node.operation.id === proposalA!.id));

  // 5. File decorations badge the claimed and proposed paths in the real workspace.
  const claimedDecoration = decorations.provideFileDecoration(vscode.Uri.file(join(root, claimedPath)));
  assert.strictEqual(claimedDecoration?.badge, "C");
  const proposedDecoration = decorations.provideFileDecoration(vscode.Uri.file(join(root, proposedPathA)));
  assert.strictEqual(proposedDecoration?.badge, "P");
  const untouchedDecoration = decorations.provideFileDecoration(vscode.Uri.file(join(root, "untouched.txt")));
  assert.strictEqual(untouchedDecoration, undefined);

  // 6. Accepting a proposal through the extension causes a real materialization.
  const acceptNode: ProposalsNode = { kind: "proposal", operation: proposalA! };
  restore = stubDialogs({ showWarningMessage: "Accept" });
  try {
    await vscode.commands.executeCommand("crosscode.acceptProposal", acceptNode);
  } finally {
    restore();
  }
  await waitFor(async () => {
    const operations = await directDaemon.operations();
    const accepted = operations.find((operation) => operation.id === proposalA!.id);
    return accepted?.status === "accepted" ? true : undefined;
  });
  const materializedContent = await readFile(join(workspaceRoot, proposedPathA), "utf8");
  assert.strictEqual(materializedContent, "from replica two (a)\n", "accept must materialize the real proposed content into the workspace");

  // 7. Rejecting a proposal through the extension causes a real no-op.
  const rejectNode: ProposalsNode = { kind: "proposal", operation: proposalB! };
  restore = stubDialogs({ showWarningMessage: "Reject" });
  try {
    await vscode.commands.executeCommand("crosscode.rejectProposal", rejectNode);
  } finally {
    restore();
  }
  await waitFor(async () => {
    const operations = await directDaemon.operations();
    const rejected = operations.find((operation) => operation.id === proposalB!.id);
    return rejected?.status === "rejected" ? true : undefined;
  });
  await assert.rejects(readFile(join(workspaceRoot, proposedPathB), "utf8"), "reject must leave the workspace untouched");

  // 8. Running a real configured validation profile shows real pass/fail results.
  restore = stubDialogs({ showInputBox: ["fast"] });
  try {
    await vscode.commands.executeCommand("crosscode.runValidation");
  } finally {
    restore();
  }
  await waitFor(() => (model.validations.length >= 2 ? true : undefined));
  const passing = model.validations.find((validation) => validation.command.includes("exit 0"));
  const failing = model.validations.find((validation) => validation.command.includes("exit 1"));
  assert.strictEqual(passing?.exitCode, 0);
  assert.notStrictEqual(failing?.exitCode, 0);
}
