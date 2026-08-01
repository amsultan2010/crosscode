import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { pathOverlaps } from "@crosscode/core";
import { DaemonClient } from "../../daemon/src/client.js";
import { ensureDaemonRunning } from "./bootstrap.js";
import { mcpResources } from "./resources.js";
import { mcpToolCatalog, submitSemanticReviewInputSchema, toolInputSchemas, type ToolName } from "./tool-catalog.js";

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
    submit_semantic_review: ({ requestId, ...review }: z.infer<typeof submitSemanticReviewInputSchema>) =>
      client.submitSemanticReview(requestId, review),
    inspect_proposal: (input: { operationId: string }) => client.analyze(input.operationId),
    diff_proposal: (input: { operationId: string }) => client.diff(input.operationId),
    list_proposal_artifacts: (input: { operationId: string }) => client.artifacts(input.operationId),
    accept_proposal: (input: { operationId: string; reviewApprovals?: Record<string, string> }) =>
      client.accept(input.operationId, input.reviewApprovals ? { reviewApprovals: input.reviewApprovals } : undefined),
    reject_proposal: (input: { operationId: string }) => client.reject(input.operationId),
    publish_branch: (input: { branch: string; profile: string; message?: string; dryRun?: boolean; confirm: true }) =>
      client.publish({ branch: input.branch, profile: input.profile, message: input.message, dryRun: input.dryRun })
  };
}

function errorContent(message: string, hint: string) {
  return { content: [{ type: "text" as const, text: `${message}\n\nHint: ${hint}` }], isError: true as const };
}

export function buildMcpServer(client: DaemonClient): Server {
  const tools = mcpTools(client);
  const server = new Server({ name: "crosscode-mcp", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpToolCatalog() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name as ToolName;
    const tool = tools[name as keyof typeof tools] as ((input?: unknown) => unknown) | undefined;
    if (!tool) {
      return errorContent(
        `Unknown MCP tool: "${request.params.name}"`,
        "Call tools/list to see the available tool names, or read the crosscode://guidance/tool-sequencing resource for how they fit together."
      );
    }
    const schema = toolInputSchemas[name];
    const parsed = schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
      return errorContent(
        `Invalid arguments for tool "${name}": ${issues}`,
        "Check the tool's inputSchema from tools/list and retry with arguments that match it."
      );
    }
    const result = await tool(parsed.data);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: mcpResources().map(({ uri, name: resourceName, description, mimeType }) => ({ uri, name: resourceName, description, mimeType }))
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = mcpResources().find((entry) => entry.uri === request.params.uri);
    if (!resource) throw new Error(`Unknown MCP resource: ${request.params.uri}`);
    return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }] };
  });

  return server;
}

export async function serveMcp(directory = process.cwd()): Promise<void> {
  const client = await ensureDaemonRunning(directory);
  const server = buildMcpServer(client);
  await server.connect(new StdioServerTransport());
}
