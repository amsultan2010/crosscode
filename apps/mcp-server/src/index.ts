import { createInterface } from "node:readline";
import { DaemonClient } from "../../daemon/src/client.js";

export function mcpTools(client: DaemonClient) {
  return {
    get_workspace_state: () => client.status(),
    list_tasks: () => client.tasks(),
    claim_task: (input: { title: string; paths?: string[] }) => client.createTask({ title: input.title, paths: input.paths }),
    claim_scope: (input: { taskId: string; target: string }) => client.createClaim({ taskId: input.taskId, target: input.target, kind: "path", mode: "exclusive-preferred" }),
    publish_intent: (input: { intent: string }) => client.capture(input.intent),
    list_remote_proposals: async () => (await client.operations()).filter((operation) => operation.status === "proposed"),
    request_handoff: (input: { operationId: string }) => ({ operationId: input.operationId, requested: true }),
    announce_interface_change: (input: { intent: string }) => client.capture(input.intent),
    request_validation: (input: { profile: string }) => client.validate(input.profile),
    create_checkpoint: () => client.checkpoint()
  };
}

export async function serveMcp(directory = process.cwd()): Promise<void> {
  const tools = mcpTools(await DaemonClient.connect(directory));
  const lines = createInterface({ input: process.stdin });
  lines.on("line", async (line) => {
    try {
      const request = JSON.parse(line) as { id: string | number; method: string; params?: unknown };
      const tool = tools[request.method as keyof typeof tools] as ((input?: unknown) => unknown) | undefined;
      if (!tool) throw new Error("Unknown MCP tool");
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: await tool(request.params) })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", error: { message: error instanceof Error ? error.message : "Request failed" } })}\n`);
    }
  });
}
