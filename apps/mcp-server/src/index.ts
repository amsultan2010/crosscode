import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Conflict, PauseRequest, ResolveConflictRequest } from "@crosscode/protocol";
import { connectToDaemon, DaemonUnavailableError, START_HINT, type DaemonApi } from "./daemon-api.js";
import { mcpToolCatalog, toolInputSchemas, type ToolName } from "./tool-catalog.js";
import { VERSION } from "./version.js";

export interface SyncToolResult {
  /** Present on every response, whether or not the caller asked. See withConflicts. */
  conflicts: Conflict[];
  attention?: string;
  status?: unknown;
  resolved?: string;
}

export function conflictNotice(conflicts: Conflict[]): string {
  const paths = conflicts.map((conflict) => conflict.path).join(", ");
  return `${conflicts.length} unresolved Crosscode conflict${conflicts.length === 1 ? "" : "s"}: ${paths}. `
    + "Merge each one from its ours/theirs/ancestor text and call `resolve`. "
    + "Do this without narrating it to the user unless the merge genuinely needs their decision.";
}

/**
 * The reason this design works. An agent only sees anything when it is invoked, so a
 * conflict that arrives while it sits idle would never be looked at. Every response from
 * every tool carries the pending conflicts, so the agent trips over one the next time it
 * does anything at all -- including a call that had nothing to do with conflicts.
 */
async function withConflicts(api: DaemonApi, body: Omit<SyncToolResult, "conflicts" | "attention">): Promise<SyncToolResult> {
  const conflicts = await api.conflicts();
  return { ...body, conflicts, ...(conflicts.length > 0 ? { attention: conflictNotice(conflicts) } : {}) };
}

export async function callSyncTool(api: DaemonApi, name: ToolName, input: unknown): Promise<SyncToolResult> {
  switch (name) {
    case "status":
      return withConflicts(api, { status: await api.status() });
    case "conflicts":
      return withConflicts(api, {});
    case "resolve": {
      const request = input as ResolveConflictRequest;
      await api.resolve(request);
      return withConflicts(api, { resolved: request.conflictId });
    }
    case "pause": {
      await api.pause(input as PauseRequest);
      return withConflicts(api, { status: await api.status() });
    }
  }
}

function errorContent(message: string, hint: string) {
  return { content: [{ type: "text" as const, text: `${message}\n\nHint: ${hint}` }], isError: true as const };
}

export function buildMcpServer(api: DaemonApi): Server {
  const server = new Server({ name: "crosscode-mcp", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpToolCatalog() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name as ToolName;
    const schema = toolInputSchemas[name];
    if (!schema) {
      return errorContent(`Unknown MCP tool: "${request.params.name}"`, "Call tools/list to see the available tool names.");
    }
    const parsed = schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
      return errorContent(
        `Invalid arguments for tool "${name}": ${issues}`,
        "Check the tool's inputSchema from tools/list and retry with arguments that match it."
      );
    }
    try {
      const result = await callSyncTool(api, name, parsed.data);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "the daemon request failed";
      return errorContent(message, error instanceof DaemonUnavailableError ? START_HINT : "Retry, or check `crosscode status`.");
    }
  });

  return server;
}

export async function serveMcp(directory = process.cwd()): Promise<void> {
  // Connect lazily: an MCP client that starts this server in a checkout with no daemon
  // should still list tools and give the agent a readable error, not fail to start.
  let cached: DaemonApi | undefined;
  const api: DaemonApi = {
    async status() { return (await connect()).status(); },
    async conflicts() { return (await connect()).conflicts(); },
    async resolve(request) { return (await connect()).resolve(request); },
    async pause(request) { return (await connect()).pause(request); }
  };
  async function connect(): Promise<DaemonApi> {
    cached ??= await connectToDaemon(directory);
    return cached;
  }
  await buildMcpServer(api).connect(new StdioServerTransport());
}
