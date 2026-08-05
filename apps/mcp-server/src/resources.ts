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

\`get_workspace_state\`: orient yourself: HEAD, branch, dirty state, pending counts.

## Announcing what happened (three variants, pick one per change)

After making edits, capture them as a durable transaction with exactly one of:

- \`publish_intent\`: the default variant. Use it when the change isn't specifically a
  summary of finished work or an interface change.
- \`submit_change_summary\`: use when reporting what was done, after the fact.
- \`announce_interface_change\`: use when the edit changes a public API or contract
  other agents depend on. Prefer this over the other two whenever it applies, since
  it's what other agents watch for before relying on your interfaces.

These three differ only in the \`kind\` tag on the resulting transaction; the
daemon and other agents use that tag to decide how much scrutiny the change needs.

## Typical loop

\`get_workspace_state\` → (edit files) →
\`publish_intent\`/\`submit_change_summary\`/\`announce_interface_change\`.
`;

export function mcpResources(): McpResourceEntry[] {
  return [
    {
      uri: "crosscode://guidance/tool-sequencing",
      name: "Crosscode MCP tool sequencing guidance",
      description:
        "Explains when and why to call each crosscode MCP tool relative to the others: orienting before editing, and the three change-announcement variants.",
      mimeType: "text/markdown",
      text: TOOL_SEQUENCING_GUIDE
    }
  ];
}
