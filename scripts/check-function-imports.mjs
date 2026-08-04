// Checks that every module a Vercel function imports resolves to JavaScript that Node can
// actually load.
//
// The failure this catches shipped to production and stayed there: the build was green, the
// static site served fine, and every API route returned 500 because
// apps/docs-site/api/[...path].ts imported `@crosscode/service/serverless`, which resolved
// through the pnpm workspace link to a .ts file. Vercel's tracer copied it verbatim and Node
// refused to load TypeScript out of node_modules. Nothing in CI looked at where an import
// pointed, so nothing failed.
//
// Runs without a deployment. Pass file paths to check them instead of the default set.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_ENTRIES = ["apps/docs-site/api/[...path].ts"];
const LOADABLE = [".js", ".mjs", ".cjs", ".node"];

const entries = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_ENTRIES.map((entry) => ROOT + entry);
let failures = 0;

for (const entry of entries) {
  if (!existsSync(entry)) {
    console.error(`FAIL ${entry}: no such file`);
    failures += 1;
    continue;
  }
  // createRequire rather than import.meta.resolve: the latter dropped its parent-URL
  // argument, and resolution has to start at the function file, not at this script.
  const resolveFrom = createRequire(entry).resolve;
  for (const specifier of await runtimeImports(entry)) {
    let path;
    try {
      path = resolveFrom(specifier);
    } catch (error) {
      console.error(`FAIL ${entry} -> ${specifier}: does not resolve (${error.code ?? error.message})`);
      failures += 1;
      continue;
    }
    if (!existsSync(path)) {
      console.error(`FAIL ${entry} -> ${specifier}: resolves to ${path}, which is not a file on disk`);
      failures += 1;
      continue;
    }
    if (!LOADABLE.some((extension) => path.endsWith(extension))) {
      console.error(`FAIL ${entry} -> ${specifier}: resolves to ${path}, which Node cannot load. Build it to JavaScript.`);
      failures += 1;
      continue;
    }
    // Resolving is not the same as loading: a bundle can point at a real .js file whose own
    // imports are missing. Importing it is the only check that covers that.
    try {
      await import(pathToFileURL(path));
    } catch (error) {
      console.error(`FAIL ${entry} -> ${specifier}: resolves to ${path} but throws on import: ${error.message}`);
      failures += 1;
      continue;
    }
    console.log(`ok   ${specifier} -> ${path}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} import(s) will not load in a deployed function.`);
  process.exit(1);
}
console.log("\nEvery function import resolves to loadable JavaScript.");

/**
 * Static import specifiers with runtime meaning. `import type` erases at compile time and
 * never reaches the deployment, so it is skipped; node: builtins always resolve.
 */
async function runtimeImports(file) {
  const source = await readFile(file, "utf8");
  const matches = source.matchAll(/^\s*import\s+(?!type\s)(?:[^;'"]*?\sfrom\s+)?["']([^"']+)["']/gm);
  return [...new Set([...matches].map((match) => match[1]))].filter((specifier) => !specifier.startsWith("node:"));
}
