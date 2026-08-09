import { zodToJsonSchema } from "zod-to-json-schema";
import { z, type ZodTypeAny } from "zod";
import {
  conflictSchema,
  conflictSummarySchema,
  pauseRequestSchema,
  resolveConflictRequestSchema,
  syncStatusSchema
} from "@crosscode/protocol";

const noInput = z.object({}).strict();

export const TOOL_NAMES = ["status", "conflicts", "resolve", "pause"] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const toolInputSchemas: Record<ToolName, ZodTypeAny> = {
  status: noInput,
  conflicts: noInput,
  resolve: resolveConflictRequestSchema,
  pause: pauseRequestSchema
};

export const toolDescriptions: Record<ToolName, string> = {
  status:
    "Crosscode sync status for this checkout: branch, connected, paused, and who else is working on what. "
    + "Read-only, and nothing here is worth reporting to the user unless they asked.",
  conflicts:
    "List unresolved sync conflicts. Each carries ours/theirs/ancestor text for a 3-way merge. "
    + "A conflicted file is frozen -- neither sent nor received -- until it is resolved.",
  resolve:
    "Resolve one conflict with your merged file content. The content is written to disk and republished to the team. "
    + "Merge it yourself; only ask the user when the two changes genuinely contradict each other.",
  pause:
    "Pause or resume syncing for this checkout. Pause only when the user asks, or around a rebase, bisect, or bulk rewrite. Always resume afterwards."
};

/**
 * What every tool answers with. The piggybacked conflicts are summaries; only the
 * `conflicts` tool declares the full merge sides, which is the whole point of the split.
 */
const resultBase = {
  conflicts: z.array(conflictSummarySchema),
  attention: z.string().optional()
};

export const toolOutputSchemas: Record<ToolName, ZodTypeAny> = {
  status: z.object({ ...resultBase, status: syncStatusSchema }).strict(),
  conflicts: z.object({ ...resultBase, conflicts: z.array(conflictSchema) }).strict(),
  resolve: z.object({ ...resultBase, resolved: z.string().min(1) }).strict(),
  pause: z.object({ ...resultBase, status: syncStatusSchema }).strict()
};

export interface ToolCatalogEntry {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export function mcpToolCatalog(): ToolCatalogEntry[] {
  return TOOL_NAMES.map((name) => ({
    name,
    description: toolDescriptions[name],
    inputSchema: zodToJsonSchema(toolInputSchemas[name], { target: "jsonSchema7" }) as Record<string, unknown>,
    outputSchema: zodToJsonSchema(toolOutputSchemas[name], { target: "jsonSchema7" }) as Record<string, unknown>
  }));
}
