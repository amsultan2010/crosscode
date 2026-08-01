export interface McpResourceEntry {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  text: string;
}

const TOOL_SEQUENCING_GUIDE = `# Crosscode MCP tool sequencing

This resource explains how the crosscode MCP tools relate to each other, so an
agent can pick the right tool and call order without reading external docs.

## Before editing anything

1. \`get_workspace_state\` — orient yourself: HEAD, branch, dirty state, pending counts.
2. \`claim_task\` — create (or find via \`list_tasks\`) a task for the work you're about
   to do, optionally scoped to paths.
3. \`claim_scope\` — advertise a finer-grained path claim against that task so other
   agents know to avoid those files.
4. \`check_change_scope\` — check the paths you're about to touch against existing
   claims and pending remote proposals. Call this right before writing, not just
   once at the start of a session.

## Announcing what happened (three variants, pick one per change)

After making edits, capture them as a durable transaction with exactly one of:

- \`publish_intent\` — default variant; use when the change isn't specifically a
  summary of finished work or an interface change.
- \`submit_change_summary\` — use when reporting what was done, after the fact.
- \`announce_interface_change\` — use when the edit changes a public API or contract
  other agents depend on. Prefer this over the other two whenever it applies, since
  it's what other agents watch for before relying on your interfaces.

These three differ only in the \`kind\` tag on the resulting transaction; the
daemon and other agents use that tag to decide how much scrutiny the change needs.

## Validation and checkpoints

- \`request_validation\` — run a named validation profile after edits, before
  handing off or checkpointing, to confirm the change is sound.
- \`create_checkpoint\` — snapshot the worktree with a Git checkpoint (without
  moving HEAD) once validated.

## Handoff and remote-review lifecycle

- \`list_remote_proposals\` — poll for operations proposed by other agents/replicas
  that are awaiting local review.
- \`request_handoff\` — after publishing an intent/summary/interface-change, ask
  another participant to accept or decline the resulting operation.
- \`list_pending_semantic_reviews\` — poll for ambiguous change bundles the daemon
  needs this agent's judgment on before it can proceed.
- \`submit_semantic_review\` — answer a pending review's \`requestId\` with a
  classification, confidence, affected symbols, evidence, invariants to preserve,
  an optional proposed resolution, and whether it requires human approval.

## Reviewing and resolving a proposal

Once \`list_remote_proposals\` surfaces an operationId, resolve it fully through MCP
without needing shell access to the CLI:

1. \`inspect_proposal\` — fetch the operation and a human-readable analysis of it.
2. \`diff_proposal\` — see the per-path diff, classification, risk, and dependents.
3. \`list_proposal_artifacts\` — if the diff shows conflicts, see what the daemon
   captured about them.
4. \`accept_proposal\` (applies it locally; pass \`reviewApprovals\` if a path needed
   semantic-review sign-off) or \`reject_proposal\` (discards it) — exactly one of
   these two is the terminal step for a given proposal.

## Publishing

\`publish_branch\` runs a validation profile and pushes/commits accepted changes to a
branch. It requires \`confirm: true\` since publishing is not easily reversible; pass
\`dryRun: true\` first to preview without publishing. Call it only after the changes
you're publishing have been accepted (via \`accept_proposal\`) or are your own
validated edits.

## Typical loop

\`get_workspace_state\` → \`claim_task\` → \`claim_scope\` → \`check_change_scope\` →
(edit files) → \`publish_intent\`/\`submit_change_summary\`/\`announce_interface_change\`
→ \`request_validation\` → \`create_checkpoint\` → \`request_handoff\` (if applicable).
Interleave \`list_remote_proposals\` and \`list_pending_semantic_reviews\` throughout
to stay responsive to other agents; resolve each proposal with \`inspect_proposal\` →
\`diff_proposal\` → \`accept_proposal\`/\`reject_proposal\`, then \`publish_branch\` when
ready to push accepted work.
`;

export function mcpResources(): McpResourceEntry[] {
  return [
    {
      uri: "crosscode://guidance/tool-sequencing",
      name: "Crosscode MCP tool sequencing guidance",
      description:
        "Explains when and why to call each crosscode MCP tool relative to the others: scope claims before editing, the three change-announcement variants, and the handoff/review lifecycle.",
      mimeType: "text/markdown",
      text: TOOL_SEQUENCING_GUIDE
    }
  ];
}
