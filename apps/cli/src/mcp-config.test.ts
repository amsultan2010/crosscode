import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseMcpClient, registerMcpServer, resolveMcpLaunch } from "./mcp-config.js";

const directories: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "crosscode-mcp-config-"));
  directories.push(directory);
  return directory;
}

/** A directory holding an executable named `name`, to stand in for a PATH entry. */
async function binDir(name: string): Promise<string> {
  const directory = await tempDir();
  const path = join(directory, name);
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, 0o755);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("resolveMcpLaunch", () => {
  it("uses the short command when the bin is installed somewhere durable", async () => {
    const directory = await binDir("crosscode-mcp");

    expect(resolveMcpLaunch("1.2.3", { PATH: directory }, "linux")).toEqual({ command: "crosscode-mcp", args: [] });
  });

  it("writes an npx invocation when nothing is on PATH, so the entry survives this process", () => {
    expect(resolveMcpLaunch("1.2.3", { PATH: "" }, "linux")).toEqual({
      command: "npx",
      args: ["-y", "--package", "@crosscode/cli@1.2.3", "crosscode-mcp"]
    });
  });

  // The whole point of the check: `npx @crosscode/cli start` finds `crosscode-mcp` on PATH,
  // but only inside a cache directory npm may evict, so the short command would break later.
  it("rejects a bin inside npx's cache and falls back to npx", async () => {
    const cache = await tempDir();
    const directory = join(cache, "_npx", "abc123", "node_modules", ".bin");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "crosscode-mcp"), "#!/bin/sh\n");
    await chmod(join(directory, "crosscode-mcp"), 0o755);

    expect(resolveMcpLaunch("1.2.3", { PATH: directory }, "linux").command).toBe("npx");
    expect(resolveMcpLaunch("1.2.3", { PATH: directory, npm_config_cache: cache }, "linux").command).toBe("npx");
  });

  // Windows .cmd shims lose the bin name, so the basename dispatch in index.ts cannot fire.
  // There is no `crosscode mcp` subcommand to fall back on -- the CLI has exactly five
  // commands -- so the entry carries the environment variable that serves MCP instead.
  it("sets CROSSCODE_SERVE_MCP on Windows, where the crosscode-mcp bin cannot identify itself", async () => {
    const directory = await binDir("crosscode-mcp.cmd");

    expect(resolveMcpLaunch("1.2.3", { PATH: directory }, "win32")).toEqual({
      command: "crosscode-mcp",
      args: [],
      env: { CROSSCODE_SERVE_MCP: "1" }
    });
    expect(resolveMcpLaunch("1.2.3", { PATH: "" }, "win32")).toEqual({
      command: "npx",
      args: ["-y", "--package", "@crosscode/cli@1.2.3", "crosscode-mcp"],
      env: { CROSSCODE_SERVE_MCP: "1" }
    });
  });
});

describe("registerMcpServer", () => {
  const launch = { command: "crosscode-mcp", args: [] };

  it("creates the client's config file when there is none", async () => {
    const root = await tempDir();

    const registration = await registerMcpServer(root, "claude", launch);

    expect(registration.changed).toBe(true);
    expect(registration.path).toBe(join(root, ".mcp.json"));
    expect(JSON.parse(await readFile(registration.path, "utf8"))).toEqual({
      mcpServers: { crosscode: { command: "crosscode-mcp", args: [] } }
    });
  });

  it("creates the parent directory for clients that nest their config", async () => {
    const root = await tempDir();

    const registration = await registerMcpServer(root, "cursor", launch);

    expect(registration.path).toBe(join(root, ".cursor", "mcp.json"));
    expect(JSON.parse(await readFile(registration.path, "utf8")).mcpServers.crosscode.command).toBe("crosscode-mcp");
  });

  it("leaves unrelated servers and top-level settings alone", async () => {
    const root = await tempDir();
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ someOtherSetting: 1, mcpServers: { other: { command: "other-mcp" } } }));

    await registerMcpServer(root, "claude", launch);

    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"))).toEqual({
      someOtherSetting: 1,
      mcpServers: { other: { command: "other-mcp" }, crosscode: { command: "crosscode-mcp", args: [] } }
    });
  });

  it("reports an unchanged file rather than rewriting it, so re-running start is a no-op", async () => {
    const root = await tempDir();
    await registerMcpServer(root, "claude", launch);

    expect((await registerMcpServer(root, "claude", launch)).changed).toBe(false);
  });

  it("writes OpenCode's own shape", async () => {
    const root = await tempDir();

    const registration = await registerMcpServer(root, "opencode", { command: "npx", args: ["-y", "@crosscode/cli"] });

    expect(JSON.parse(await readFile(registration.path, "utf8"))).toEqual({
      mcp: { crosscode: { type: "local", command: ["npx", "-y", "@crosscode/cli"], enabled: true } }
    });
  });

  // Overwriting a file we cannot parse would destroy MCP entries the user depends on.
  it("refuses a config file that is not parseable JSON, leaving it untouched", async () => {
    const root = await tempDir();
    await writeFile(join(root, ".mcp.json"), "{ not json");

    await expect(registerMcpServer(root, "claude", launch)).rejects.toMatchObject({ code: "CONFIG_UNPARSEABLE" });
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe("{ not json");
  });
});

describe("parseMcpClient", () => {
  it("names the supported clients in its hint when given something else", () => {
    expect(() => parseMcpClient("emacs")).toThrowError(expect.objectContaining({
      code: "USAGE_ERROR",
      hint: expect.stringContaining("claude, cursor, gemini, opencode")
    }));
  });
});
