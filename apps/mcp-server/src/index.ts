import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DaemonClient } from "../../daemon/src/client.js";
import { VERSION } from "../../daemon/src/version.js";
import { ensureDaemonRunning } from "./bootstrap.js";
import { mcpToolCatalog, toolInputSchemas, type ToolName } from "./tool-catalog.js";

export function mcpTools(client: DaemonClient) {
  return {
    get_workspace_state: () => client.status()
  };
}

function errorContent(message: string, hint: string) {
  return { content: [{ type: "text" as const, text: `${message}\n\nHint: ${hint}` }], isError: true as const };
}

export function buildMcpServer(client: DaemonClient): Server {
  const tools = mcpTools(client);
  const server = new Server({ name: "crosscode-mcp", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpToolCatalog() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name as ToolName;
    const tool = tools[name as keyof typeof tools] as ((input?: unknown) => unknown) | undefined;
    if (!tool) {
      return errorContent(
        `Unknown MCP tool: "${request.params.name}"`,
        "Call tools/list to see the available tool names."
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

  return server;
}

export async function serveMcp(directory = process.cwd()): Promise<void> {
  const client = await ensureDaemonRunning(directory);
  const server = buildMcpServer(client);
  await server.connect(new StdioServerTransport());
}
