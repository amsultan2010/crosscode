import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDaemonLaunch } from "./launch.js";

const directories: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "crosscode-launch-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("resolveDaemonLaunch", () => {
  it("runs the bundled daemon with the current node binary when installed from npm", async () => {
    const dist = await tempDir();
    const bundled = join(dist, "daemon.js");
    await writeFile(bundled, "");

    expect(resolveDaemonLaunch(dist)).toEqual({ command: process.execPath, args: [bundled] });
  });

  it("falls back to tsx and the daemon source in a monorepo clone", async () => {
    const repoRoot = await tempDir();
    await mkdir(join(repoRoot, "apps", "daemon", "src"), { recursive: true });
    await mkdir(join(repoRoot, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(repoRoot, "apps", "daemon", "src", "main.ts"), "");
    await writeFile(join(repoRoot, "node_modules", ".bin", "tsx"), "");

    expect(resolveDaemonLaunch(join(repoRoot, "apps", "daemon", "src"))).toEqual({
      command: join(repoRoot, "node_modules", ".bin", "tsx"),
      args: [join(repoRoot, "apps", "daemon", "src", "main.ts")]
    });
  });

  it("names both candidate paths when neither layout is present", async () => {
    const directory = await tempDir();

    expect(() => resolveDaemonLaunch(directory)).toThrow(/no bundled daemon at .*daemon\.js.*main\.ts/s);
  });

  // The default argument is what actually runs in production; a clone has to resolve
  // without being told where it is.
  it("resolves this checkout with no explicit module directory", () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

    expect(resolveDaemonLaunch()).toEqual({
      command: join(repoRoot, "node_modules", ".bin", "tsx"),
      args: [join(repoRoot, "apps", "daemon", "src", "main.ts")]
    });
  });
});
