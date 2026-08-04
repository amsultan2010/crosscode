#!/usr/bin/env tsx
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpToolCatalog } from "./tool-catalog.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const docsPath = join(repoRoot, "docs", "mcp-clients.md");

const BEGIN_MARKER = "<!-- BEGIN GENERATED TOOL CATALOG (apps/mcp-server/src/generate-tool-docs.ts) -->";
const END_MARKER = "<!-- END GENERATED TOOL CATALOG -->";

function renderCatalog(): string {
  const lines = mcpToolCatalog().map((tool) => `- **\`${tool.name}\`**: ${tool.description}`);
  return [BEGIN_MARKER, "", ...lines, "", END_MARKER].join("\n");
}

async function main(): Promise<void> {
  const original = await readFile(docsPath, "utf8");
  const beginIndex = original.indexOf(BEGIN_MARKER);
  const endIndex = original.indexOf(END_MARKER);
  if (beginIndex === -1 || endIndex === -1) {
    throw new Error(`Could not find generated tool catalog markers in ${docsPath}`);
  }
  const before = original.slice(0, beginIndex);
  const after = original.slice(endIndex + END_MARKER.length);
  const updated = `${before}${renderCatalog()}${after}`;
  await writeFile(docsPath, updated);
}

await main();
