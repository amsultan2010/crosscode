import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z, type ZodTypeAny } from "zod";
import { pathOverlaps, semanticReviewSchema } from "@crosscode/core";
import {
  captureRequestSchema,
  changeScopeRequestSchema,
  changeSummaryRequestSchema,
  checkpointRequestSchema,
  claimRequestSchema,
  handoffRequestSchema,
  taskRequestSchema,
  validationRequestSchema
} from "@crosscode/protocol";
import { DaemonClient } from "../../daemon/src/client.js";
import { ensureDaemonRunning } from "./bootstrap.js";

const emptyInputSchema = z.object({}).strict();
const claimTaskInputSchema = taskRequestSchema.pick({ title: true, paths: true });
const claimScopeInputSchema = claimRequestSchema.pick({ taskId: true, target: true });
const publishIntentInputSchema = captureRequestSchema.omit({ kind: true });
const announceInterfaceChangeInputSchema = captureRequestSchema.omit({ kind: true });
const submitSemanticReviewInputSchema = semanticReviewSchema.extend({ requestId: z.string() });

export function mcpTools(client: DaemonClient) {
  return {
    get_workspace_state: () => client.status(),
    list_tasks: () => client.tasks(),
    claim_task: (input: { title: string; paths?: string[] }) => client.createTask({ title: input.title, paths: input.paths }),
    claim_scope: (input: { taskId: string; target: string }) => client.createClaim({ taskId: input.taskId, target: input.target, kind: "path", mode: "exclusive-preferred" }),
    publish_intent: (input: { intent: string }) => client.capture(input.intent),
    check_change_scope: async (input: { paths: string[] }) => {
      const [claims, operations] = await Promise.all([
        client.claims().catch(() => [] as Awaited<ReturnType<typeof client.claims>>),
        client.operations()
      ]);
      const overlaps: Array<{ path: string; with: "claim" | "operation"; target: string; ownerId?: string; operationId?: string }> = [];
      for (const path of input.paths) {
        for (const claim of claims) {
          if (pathOverlaps(path, claim.target)) overlaps.push({ path, with: "claim", target: claim.target, ownerId: claim.ownerId });
        }
        for (const operation of operations) {
          if (operation.status !== "proposed") continue;
          for (const change of operation.transaction.changes) {
            if (pathOverlaps(path, change.path)) overlaps.push({ path, with: "operation", target: change.path, operationId: operation.id });
          }
        }
      }
      return { clear: overlaps.length === 0, overlaps };
    },
    submit_change_summary: (input: { summary: string }) => client.capture(input.summary, "summary"),
    list_remote_proposals: async () => (await client.operations()).filter((operation) => operation.status === "proposed"),
    request_handoff: (input: { operationId: string; note?: string }) => client.requestHandoff(input),
    announce_interface_change: (input: { intent: string }) => client.capture(input.intent, "interface-change"),
    request_validation: (input: { profile: string }) => client.validate(input.profile),
    create_checkpoint: () => client.checkpoint(),
    list_pending_semantic_reviews: () => client.pendingSemanticReviews(),
    submit_semantic_review: ({ requestId, ...review }: z.infer<typeof submitSemanticReviewInputSchema>) => client.submitSemanticReview(requestId, review)
  };
}

type ToolName = keyof ReturnType<typeof mcpTools>;

const toolInputSchemas: Record<ToolName, ZodTypeAny> = {
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
  submit_semantic_review: submitSemanticReviewInputSchema
};

const toolDescriptions: Record<ToolName, string> = {
  get_workspace_state: "Read the local daemon's workspace status: HEAD, branch, dirty state, and pending counts.",
  list_tasks: "List tasks known to the local daemon.",
  claim_task: "Create a task, optionally scoped to a set of paths.",
  claim_scope: "Advertise a path claim against a task so other agents can see it.",
  publish_intent: "Capture the current working-tree edits as a durable transaction tagged with an intent.",
  check_change_scope: "Check whether a set of paths overlaps existing claims or pending remote proposals before editing.",
  submit_change_summary: "Capture the current working-tree edits as a durable transaction tagged as a change summary.",
  list_remote_proposals: "List remote operations that are proposed and awaiting local review.",
  request_handoff: "Request a handoff of a proposed operation to another participant for review.",
  announce_interface_change: "Capture the current working-tree edits as a durable transaction tagged as an interface change.",
  request_validation: "Run a named validation profile and return its results.",
  create_checkpoint: "Create a Git checkpoint of the current worktree without moving HEAD.",
  list_pending_semantic_reviews: "List semantic reviews awaiting this agent's judgment: an ambiguous change bundle the daemon needs reasoned about before it can proceed.",
  submit_semantic_review: "Submit this agent's semantic review for a pending requestId: classification, confidence, affected symbols, evidence, invariants to preserve, an optional proposed resolution, and whether it requires human approval."
};

export function buildMcpServer(client: DaemonClient): Server {
  const tools = mcpTools(client);
  const server = new Server({ name: "crosscode-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (Object.keys(tools) as ToolName[]).map((name) => ({
      name,
      description: toolDescriptions[name],
      inputSchema: zodToJsonSchema(toolInputSchemas[name], { target: "jsonSchema7" }) as Record<string, unknown>
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name as ToolName;
    const tool = tools[name] as ((input?: unknown) => unknown) | undefined;
    if (!tool) throw new Error(`Unknown MCP tool: ${request.params.name}`);
    const schema = toolInputSchemas[name];
    const input = schema.parse(request.params.arguments ?? {});
    const result = await tool(input);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  return server;
}

export async function serveMcp(directory = process.cwd()): Promise<void> {
  const client = await ensureDaemonRunning(directory);
  const server = buildMcpServer(client);
  await server.connect(new StdioServerTransport());
}
