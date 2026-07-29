import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { findAstDependentFiles, findSymbolReferences } from "./index.js";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })))); });

async function repo(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "crosscode-ast-graph-"));
  directories.push(directory);
  await exec("git", ["init", "-q", directory]);
  await exec("git", ["-C", directory, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", directory, "config", "user.name", "Test"]);
  return directory;
}
async function commitAll(directory: string): Promise<void> {
  await exec("git", ["-C", directory, "add", "."]);
  await exec("git", ["-C", directory, "commit", "-qm", "seed"]);
}

describe("AST-based TypeScript import graph", () => {
  it("finds a direct importer via a real import statement", async () => {
    const directory = await repo();
    await writeFile(join(directory, "lib.ts"), "export function greet(name: string): string { return name; }\n");
    await writeFile(join(directory, "caller.ts"), "import { greet } from \"./lib\";\ngreet(\"world\");\n");
    await commitAll(directory);

    await expect(findAstDependentFiles(directory, ["greet"], "lib.ts")).resolves.toEqual(["caller.ts"]);
  });

  it("finds transitive importers across multiple hops", async () => {
    const directory = await repo();
    await writeFile(join(directory, "lib.ts"), "export function greet(name: string): string { return name; }\n");
    await writeFile(join(directory, "caller.ts"), "import { greet } from \"./lib\";\nexport function callGreet(name: string): string { return greet(name); }\n");
    await writeFile(join(directory, "consumer.ts"), "import { callGreet } from \"./caller\";\ncallGreet(\"world\");\n");
    await writeFile(join(directory, "unrelated.ts"), "export const other = 1;\n");
    await commitAll(directory);

    await expect(findAstDependentFiles(directory, ["greet"], "lib.ts")).resolves.toEqual(["caller.ts", "consumer.ts"]);
  });

  it("does not false-positive on a file that only mentions the symbol name in a comment or string, unlike the textual search", async () => {
    const directory = await repo();
    await writeFile(join(directory, "lib.ts"), "export function greet(name: string): string { return name; }\n");
    await writeFile(join(directory, "mentions-only.ts"), "// this file talks about greet but never imports it\nexport const message = \"please call greet() yourself\";\n");
    await commitAll(directory);

    await expect(findAstDependentFiles(directory, ["greet"], "lib.ts")).resolves.toEqual([]);
    await expect(findSymbolReferences(directory, ["greet"], "lib.ts")).resolves.toEqual(["mentions-only.ts"]);
  });

  it("resolves imports from subdirectories and .tsx files", async () => {
    const directory = await repo();
    await mkdir(join(directory, "components"), { recursive: true });
    await writeFile(join(directory, "lib.ts"), "export function greet(name: string): string { return name; }\n");
    await writeFile(join(directory, "components", "widget.tsx"), "import { greet } from \"../lib\";\nexport const Widget = () => greet(\"world\");\n");
    await commitAll(directory);

    await expect(findAstDependentFiles(directory, ["greet"], "lib.ts")).resolves.toEqual(["components/widget.tsx"]);
  });

  it("does not treat an unrelated named import from the same module as a dependent", async () => {
    const directory = await repo();
    await writeFile(join(directory, "lib.ts"), "export function greet(name: string): string { return name; }\nexport const other = 1;\n");
    await writeFile(join(directory, "caller.ts"), "import { other } from \"./lib\";\nconsole.log(other);\n");
    await commitAll(directory);

    await expect(findAstDependentFiles(directory, ["greet"], "lib.ts")).resolves.toEqual([]);
  });

  it("falls back to undefined for non-TypeScript changed files so callers use the textual search", async () => {
    const directory = await repo();
    await writeFile(join(directory, "notes.md"), "# notes\n");
    await commitAll(directory);

    await expect(findAstDependentFiles(directory, ["greet"], "notes.md")).resolves.toBeUndefined();
  });
});
