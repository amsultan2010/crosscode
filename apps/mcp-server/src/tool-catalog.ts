import { zodToJsonSchema } from "zod-to-json-schema";
import { z, type ZodTypeAny } from "zod";
import { captureRequestSchema, changeSummaryRequestSchema } from "@crosscode/protocol";

const emptyInputSchema = z.object({}).strict();
const publishIntentInputSchema = captureRequestSchema.omit({ kind: true });
const announceInterfaceChangeInputSchema = captureRequestSchema.omit({ kind: true });

export const TOOL_NAMES = [
  "get_workspace_state",
  "publish_intent",
  "submit_change_summary",
  "announce_interface_change"
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const toolInputSchemas: Record<ToolName, ZodTypeAny> = {
  get_workspace_state: emptyInputSchema,
  publish_intent: publishIntentInputSchema,
  submit_change_summary: changeSummaryRequestSchema,
  announce_interface_change: announceInterfaceChangeInputSchema
};

export const toolDescriptions: Record<ToolName, string> = {
  get_workspace_state:
    "Read the local daemon's workspace status: HEAD, branch, dirty state, and pending counts. Call this first to orient before capturing changes.",
  publish_intent:
    "Capture the current working-tree edits as a durable transaction tagged with a general intent. This is the default of the three capture variants (publish_intent / submit_change_summary / announce_interface_change); use it when the change is neither a specific summary nor an interface change. Call after making edits.",
  submit_change_summary:
    "Capture the current working-tree edits as a durable transaction tagged as a change summary, for reporting what was done. One of three capture variants (publish_intent / submit_change_summary / announce_interface_change); call after edits, in place of publish_intent when you're summarizing completed work rather than stating intent.",
  announce_interface_change:
    "Capture the current working-tree edits as a durable transaction tagged as an interface change. One of three capture variants (publish_intent / submit_change_summary / announce_interface_change); use this instead of the others when the edit changes a public API or contract other agents depend on."
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
