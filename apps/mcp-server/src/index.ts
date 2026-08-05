import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { DaemonClient } from "../../daemon/src/client.js";
import { VERSION } from "../../daemon/src/version.js";
import { ensureDaemonRunning } from "./bootstrap.js";
import { mcpResources } from "./resources.js";
import { mcpToolCatalog, toolInputSchemas, type ToolName } from "./tool-catalog.js";

export function mcpTools(client: DaemonClient) {
  return {
    get_workspace_state: () => client.status(),
    publish_intent: (input: { intent: string }) => client.capture(input.intent),
    submit_change_summary: (input: { summary: string }) => client.capture(input.summary, "summary"),
    announce_interface_change: (input: { intent: string }) => client.capture(input.intent, "interface-change")
  };
}

function errorContent(message: string, hint: string) {
  return { content: [{ type: "text" as const, text: `${message}\n\nHint: ${hint}` }], isError: true as const };
}

export function buildMcpServer(client: DaemonClient): Server {
  const tools = mcpTools(client);
  const server = new Server({ name: "crosscode-mcp", version: VERSION }, { capabilities: { tools: {}, resources: {} } });

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
