import { zodToJsonSchema } from "zod-to-json-schema";
import { z, type ZodTypeAny } from "zod";
import { semanticReviewSchema } from "@crosscode/core";
import {
  acceptOperationRequestSchema,
  captureRequestSchema,
  changeScopeRequestSchema,
  changeSummaryRequestSchema,
  checkpointRequestSchema,
  claimRequestSchema,
  handoffRequestSchema,
  publishRequestSchema,
  setWorkspaceAutonomyRequestSchema,
  taskRequestSchema,
  validationRequestSchema
} from "@crosscode/protocol";

const emptyInputSchema = z.object({}).strict();
const claimTaskInputSchema = taskRequestSchema.pick({ title: true, paths: true });
const claimScopeInputSchema = claimRequestSchema.pick({ taskId: true, target: true });
const publishIntentInputSchema = captureRequestSchema.omit({ kind: true });
const announceInterfaceChangeInputSchema = captureRequestSchema.omit({ kind: true });
export const submitSemanticReviewInputSchema = semanticReviewSchema.extend({ requestId: z.string() });

const operationIdInputSchema = z.object({ operationId: z.string().min(1).max(200) }).strict();
const acceptProposalInputSchema = operationIdInputSchema.extend({
  reviewApprovals: acceptOperationRequestSchema.unwrap().shape.reviewApprovals
});
const publishBranchInputSchema = publishRequestSchema.extend({
  confirm: z.literal(true)
});

export const TOOL_NAMES = [
  "get_workspace_state",
  "list_tasks",
  "claim_task",
  "claim_scope",
  "publish_intent",
  "check_change_scope",
  "submit_change_summary",
  "list_remote_proposals",
  "request_handoff",
  "announce_interface_change",
  "request_validation",
  "create_checkpoint",
  "list_pending_semantic_reviews",
  "submit_semantic_review",
  "inspect_proposal",
  "diff_proposal",
  "list_proposal_artifacts",
  "accept_proposal",
  "reject_proposal",
  "publish_branch",
  "get_workspace_autonomy",
  "set_workspace_autonomy"
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const toolInputSchemas: Record<ToolName, ZodTypeAny> = {
  get_workspace_state: emptyInputSchema,
  list_tasks: emptyInputSchema,
  claim_task: claimTaskInputSchema,
  claim_scope: claimScopeInputSchema,
  publish_intent: publishIntentInputSchema,
  check_change_scope: changeScopeRequestSchema,
  submit_change_summary: changeSummaryRequestSchema,
  list_remote_proposals: emptyInputSchema,
  request_handoff: handoffRequestSchema,
  announce_interface_change: announceInterfaceChangeInputSchema,
  request_validation: validationRequestSchema,
  create_checkpoint: checkpointRequestSchema,
  list_pending_semantic_reviews: emptyInputSchema,
  submit_semantic_review: submitSemanticReviewInputSchema,
  inspect_proposal: operationIdInputSchema,
  diff_proposal: operationIdInputSchema,
  list_proposal_artifacts: operationIdInputSchema,
  accept_proposal: acceptProposalInputSchema,
  reject_proposal: operationIdInputSchema,
  publish_branch: publishBranchInputSchema,
  get_workspace_autonomy: emptyInputSchema,
  set_workspace_autonomy: setWorkspaceAutonomyRequestSchema
};

export const toolDescriptions: Record<ToolName, string> = {
  get_workspace_state:
    "Read the local daemon's workspace status: HEAD, branch, dirty state, and pending counts. Call this first to orient before claiming tasks, checking scope, or capturing changes.",
  list_tasks:
    "List tasks known to the local daemon. Call before claim_task to see if your work is already tracked, or after claim_task to confirm it registered.",
  claim_task:
    "Create a task, optionally scoped to a set of paths, so other agents can see what you're about to work on. Call before editing; use claim_scope afterward for finer-grained path claims tied to this task.",
  claim_scope:
    "Advertise a path claim against an existing task so other agents avoid the same files. Call after claim_task and before editing. check_change_scope is how other agents (and you) read these claims back.",
  publish_intent:
    "Capture the current working-tree edits as a durable transaction tagged with a general intent. This is the default of the three capture variants (publish_intent / submit_change_summary / announce_interface_change); use it when the change is neither a specific summary nor an interface change. Call after making edits.",
  check_change_scope:
    "Check whether a set of paths overlaps existing claims or pending remote proposals before editing. Call this before writing to files to avoid colliding with another agent's claimed scope or an in-flight proposal.",
  submit_change_summary:
    "Capture the current working-tree edits as a durable transaction tagged as a change summary, for reporting what was done. One of three capture variants (publish_intent / submit_change_summary / announce_interface_change); call after edits, in place of publish_intent when you're summarizing completed work rather than stating intent.",
  list_remote_proposals:
    "List remote operations that are proposed and awaiting local review. Call periodically to discover incoming changes that may need request_validation or a response via submit_semantic_review.",
  request_handoff:
    "Request a handoff of a proposed operation to another participant for review. Call after publish_intent, submit_change_summary, or announce_interface_change has produced an operation you want someone else to accept or decline.",
  announce_interface_change:
    "Capture the current working-tree edits as a durable transaction tagged as an interface change. One of three capture variants (publish_intent / submit_change_summary / announce_interface_change); use this instead of the others when the edit changes a public API or contract other agents depend on.",
  request_validation:
    "Run a named validation profile and return its results. Call after making edits, before requesting a handoff or creating a checkpoint, to confirm the change is sound.",
  create_checkpoint:
    "Create a Git checkpoint of the current worktree without moving HEAD. Call after edits have been validated, to durably snapshot progress without committing to a branch.",
  list_pending_semantic_reviews:
    "List semantic reviews awaiting this agent's judgment: ambiguous change bundles the daemon needs reasoned about before it can proceed. Call periodically; each entry's requestId is answered with submit_semantic_review.",
  submit_semantic_review:
    "Submit this agent's semantic review for a pending requestId: classification, confidence, affected symbols, evidence, invariants to preserve, an optional proposed resolution, and whether it requires human approval. Call only after list_pending_semantic_reviews surfaces a requestId needing judgment.",
  inspect_proposal:
    "Fetch a proposed operation and a human-readable analysis of it. Call on an operationId from list_remote_proposals before diff_proposal or accept_proposal/reject_proposal, to understand what a proposal contains.",
  diff_proposal:
    "Get the per-path diff for a proposed operation: base/local/proposed content, classification, risk, and dependents. Call after inspect_proposal and before deciding to accept_proposal or reject_proposal, especially when requiresApproval or risk looks high.",
  list_proposal_artifacts:
    "List conflict artifacts recorded for a proposed operation. Call when diff_proposal shows conflicting or unmergeable changes, to see what the daemon captured about the conflict before you accept_proposal or reject_proposal.",
  accept_proposal:
    "Accept a proposed operation, applying it locally; pass reviewApprovals when a path required semantic-review sign-off. Call after inspecting it with inspect_proposal/diff_proposal. This is the terminal counterpart to reject_proposal.",
  reject_proposal:
    "Reject a proposed operation, discarding it without applying it locally. Call after inspecting it with inspect_proposal/diff_proposal. This is the terminal counterpart to accept_proposal.",
  publish_branch:
    "Publish accepted changes to a branch by running the named validation profile and pushing/committing the result; requires confirm: true since this is not easily reversible. Call request_validation first if you want a dry look at validation independent of publishing, and pass dryRun: true here to preview without publishing.",
  get_workspace_autonomy:
    "Read this workspace's autonomy tier (0=always_ask, 1=auto_if_clean, 2=auto_always), which controls how eagerly the daemon auto-applies incoming proposals without an explicit accept_proposal call.",
  set_workspace_autonomy:
    "Set this workspace's autonomy tier (0=always_ask, 1=auto_if_clean, 2=auto_always); owner/admin only, and tier >= 1 requires semantic review (externalAiReview) already enabled for the workspace. Auto-apply always still runs through the same approval gates as accept_proposal -- this never bypasses them."
};

export interface ToolCatalogEntry {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function mcpToolCatalog(): ToolCatalogEntry[] {
  return TOOL_NAMES.map((name) => ({
    name,
    description: toolDescriptions[name],
    inputSchema: zodToJsonSchema(toolInputSchemas[name], { target: "jsonSchema7" }) as Record<string, unknown>
  }));
}
