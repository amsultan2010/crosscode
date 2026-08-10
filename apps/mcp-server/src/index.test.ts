import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { connectToDaemon, DaemonUnavailableError } from "./daemon-api.js";
import { callSyncTool } from "./index.js";
import { startFakeDaemon, sampleConflict, type FakeDaemon } from "./fake-daemon.js";
import { TOOL_NAMES } from "./tool-catalog.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const mcpMain = join(repoRoot, "apps/mcp-server/src/main.ts");

const daemons: FakeDaemon[] = [];
const clients: Client[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fakeDaemon(conflicts: ReturnType<typeof sampleConflict>[] = []): Promise<FakeDaemon> {
  const daemon = await startFakeDaemon({ conflicts });
  daemons.push(daemon);
  return daemon;
}

async function apiFor(daemon: FakeDaemon) {
  process.env.CROSSCODE_DAEMON_URL = daemon.url;
  process.env.CROSSCODE_DAEMON_SECRET = daemon.secret;
  return connectToDaemon();
}

async function stdioClient(daemon: FakeDaemon): Promise<Client> {
  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [mcpMain],
    cwd: repoRoot,
    env: { ...process.env, CROSSCODE_DAEMON_URL: daemon.url, CROSSCODE_DAEMON_SECRET: daemon.secret } as Record<string, string>,
    stderr: "inherit"
  });
  const client = new Client({ name: "crosscode-mcp-test-client", version: "0.1.0" });
  clients.push(client);
  await client.connect(transport);
  return client;
}

function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe("tool catalog", () => {
  it("is exactly the four tools the plan allows", () => {
    expect([...TOOL_NAMES]).toEqual(["status", "conflicts", "resolve", "pause"]);
  });
});

describe("the four tools", () => {
  it("reports status from the daemon", async () => {
    const result = await callSyncTool(await apiFor(await fakeDaemon()), "status", {});
    expect(result.status).toMatchObject({ branch: "main", connected: true, paused: false });
    expect(result.conflicts).toEqual([]);
    expect(result.attention).toBeUndefined();
  });

  it("lists conflicts with the three merge sides", async () => {
    const daemon = await fakeDaemon([sampleConflict("src/a.ts")]);
    const result = await callSyncTool(await apiFor(daemon), "conflicts", {});
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ path: "src/a.ts", ours: "ours\n", theirs: "theirs\n", ancestor: "base\n" });
  });

  it("resolves a conflict with the agent's merged content and stops reporting it", async () => {
    const daemon = await fakeDaemon([sampleConflict("src/a.ts", "c1")]);
    const result = await callSyncTool(await apiFor(daemon), "resolve", { conflictId: "c1", content: "merged\n" });
    expect(daemon.resolved).toEqual([{ conflictId: "c1", content: "merged\n" }]);
    expect(result.resolved).toBe("c1");
    expect(result.conflicts).toEqual([]);
  });

  it("pauses and resumes, and answers with the new state", async () => {
    const daemon = await fakeDaemon();
    const api = await apiFor(daemon);
    expect((await callSyncTool(api, "pause", { paused: true })).status).toMatchObject({ paused: true });
    expect((await callSyncTool(api, "pause", { paused: false })).status).toMatchObject({ paused: false });
    expect(daemon.paused).toEqual([{ paused: true }, { paused: false }]);
  });
});

describe("the piggybacked payload is a summary", () => {
  // Three whole copies of every conflicted file used to ride out on calls that had nothing
  // to do with conflicts. The entry still rides along; the file text does not.
  const MERGE_SIDES = ["ours", "theirs", "ancestor"] as const;

  it("carries path and id but none of the merge sides on status, pause, and resolve", async () => {
    const daemon = await fakeDaemon([sampleConflict("src/auth.ts", "c1"), sampleConflict("src/db.ts", "c2")]);
    const api = await apiFor(daemon);

    for (const call of [
      () => callSyncTool(api, "status", {}),
      () => callSyncTool(api, "pause", { paused: false }),
      () => callSyncTool(api, "resolve", { conflictId: "c1", content: "merged\n" })
    ]) {
      const result = await call();
      expect(result.conflicts.length).toBeGreaterThan(0);
      for (const conflict of result.conflicts) {
        expect(conflict).toMatchObject({ path: expect.any(String), id: expect.any(String) });
        for (const side of MERGE_SIDES) expect(Object.keys(conflict)).not.toContain(side);
      }
    }
  });

  it("still names the conflicting path in attention", async () => {
    const result = await callSyncTool(await apiFor(await fakeDaemon([sampleConflict("src/auth.ts")])), "status", {});
    expect(result.attention).toContain("src/auth.ts");
    expect(result.attention).toContain("resolve");
  });
});

describe("conflicts piggyback on every response", () => {
  // The whole design rests on this: an agent only looks at anything when it is invoked, so
  // a conflict that lands while it is idle has to ride out on the next response of any tool.
  it("puts a pending conflict in the response of a tool call that never asked for one", async () => {
    const daemon = await fakeDaemon([sampleConflict("src/auth.ts")]);
    const api = await apiFor(daemon);

    for (const call of [
      () => callSyncTool(api, "status", {}),
      () => callSyncTool(api, "pause", { paused: false })
    ]) {
      const result = await call();
      expect(result.conflicts.map((conflict) => conflict.path)).toEqual(["src/auth.ts"]);
      expect(result.attention).toContain("src/auth.ts");
      expect(result.attention).toContain("resolve");
    }
  });

  it("appears on a conflict that arrived between two calls", async () => {
    const daemon = await fakeDaemon();
    const api = await apiFor(daemon);
    expect((await callSyncTool(api, "status", {})).conflicts).toEqual([]);

    daemon.conflicts = [sampleConflict("src/late.ts")];

    expect((await callSyncTool(api, "status", {})).conflicts.map((conflict) => conflict.path)).toEqual(["src/late.ts"]);
  });
});

describe("no daemon", () => {
  it("reports one actionable error instead of starting anything", async () => {
    delete process.env.CROSSCODE_DAEMON_URL;
    delete process.env.CROSSCODE_DAEMON_SECRET;
    await expect(connectToDaemon("/")).rejects.toThrow(DaemonUnavailableError);
  });

  // A descriptor a dying daemon left half-written is one more way of not reaching one. It
  // used to come out as a raw SyntaxError, which the tool handler cannot tell from a failed
  // request -- so the agent was told "the daemon request failed" and never shown the one
  // hint that fixes it.
  it("reports an unreadable descriptor as DAEMON_UNAVAILABLE, with the hint that fixes it", async () => {
    delete process.env.CROSSCODE_DAEMON_URL;
    delete process.env.CROSSCODE_DAEMON_SECRET;
    const root = await mkdtemp(join(tmpdir(), "crosscode-mcp-descriptor-"));
    directories.push(root);
    await promisify(execFile)("git", ["init", "-q", root]);
    await mkdir(join(root, ".git", "crosscode"), { recursive: true });
    await writeFile(join(root, ".git", "crosscode", "daemon.json"), '{"port": 4');

    await expect(connectToDaemon(root)).rejects.toThrow(DaemonUnavailableError);
  });
});

describe("over real MCP stdio", () => {
  it("lists exactly four tools, each with an output schema", async () => {
    const client = await stdioClient(await fakeDaemon());

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["conflicts", "pause", "resolve", "status"]);
    for (const tool of tools) {
      expect(tool.outputSchema).toMatchObject({ type: "object" });
      expect(Object.keys((tool.outputSchema as { properties: object }).properties)).toContain("conflicts");
    }
  }, 20_000);

  it("piggybacks a conflict onto a status call, as structured content the schema accepts", async () => {
    const client = await stdioClient(await fakeDaemon([sampleConflict("src/auth.ts")]));

    // The SDK client validates structuredContent against the tool's declared outputSchema and
    // throws if it does not match, so this call is the check.
    const result = await client.callTool({ name: "status", arguments: {} });
    const structured = result.structuredContent as { conflicts: Array<Record<string, unknown>>; attention: string };
    expect(structured.conflicts.map((conflict) => conflict.path)).toEqual(["src/auth.ts"]);
    expect(Object.keys(structured.conflicts[0]!)).not.toContain("ours");
    expect(structured.attention).toContain("src/auth.ts");
    expect(textOf(result)).toEqual(structured);
  }, 20_000);

  it("returns the full merge sides from the conflicts tool", async () => {
    const client = await stdioClient(await fakeDaemon([sampleConflict("src/auth.ts")]));
    const result = await client.callTool({ name: "conflicts", arguments: {} });
    expect((result.structuredContent as { conflicts: Array<Record<string, unknown>> }).conflicts[0])
      .toMatchObject({ ours: "ours\n", theirs: "theirs\n", ancestor: "base\n" });
  }, 20_000);

  it("rejects arguments that do not match the contract", async () => {
    const client = await stdioClient(await fakeDaemon());
    const result = await client.callTool({ name: "resolve", arguments: { conflictId: "c1" } });
    expect(result.isError).toBe(true);
  }, 20_000);
});
