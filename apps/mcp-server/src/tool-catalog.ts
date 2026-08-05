import { zodToJsonSchema } from "zod-to-json-schema";
import { z, type ZodTypeAny } from "zod";

const emptyInputSchema = z.object({}).strict();

export const TOOL_NAMES = [
  "get_workspace_state"
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const toolInputSchemas: Record<ToolName, ZodTypeAny> = {
  get_workspace_state: emptyInputSchema
};

export const toolDescriptions: Record<ToolName, string> = {
  get_workspace_state:
    "Read the local daemon's workspace status: HEAD, branch, dirty state, and pending counts."
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
