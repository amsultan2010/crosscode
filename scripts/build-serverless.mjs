// Bundles the coordination service's serverless entrypoint into apps/service/dist/serverless.js.
//
// Why this exists: every workspace package in this repo has `exports` pointing at its
// TypeScript source, which is fine for tsx and vitest and fatal on a function platform.
// Vercel compiles apps/docs-site/api/[...path].ts, traces its import of
// `@crosscode/service/serverless` through the pnpm link, copies the resolved file verbatim,
// and Node then refuses to load a .ts file out of node_modules. Production returned 500 on
// every route for that reason.
//
// The fix is one self-contained JavaScript file that `exports["./serverless"]` points at,
// which is the same call scripts/build.mjs already makes for the published CLI and for the
// same reason: the nine workspace packages have no external consumers, so bundling costs
// nothing and removes every resolution step that has to hold at runtime. npm dependencies
// are inlined too, not left external, because the traced function sits under
// apps/docs-site/ where pnpm has not linked pg or jose -- an external import would resolve
// during this build and fail in the deployment.
//
// `pnpm service` (tsx apps/service/src/main.ts) is untouched: it runs the TypeScript
// sources directly and never reads dist/.
import { builtinModules } from "node:module";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Resolved against this file rather than the working directory, because Vercel runs the
// build from apps/docs-site and `pnpm --filter @crosscode/service build` runs it from
// apps/service.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTFILE = "apps/service/dist/serverless.js";

// Optional native addons that pg and ws probe for behind try/catch and run without. esbuild
// leaves them as requires that throw, which is the same answer the probe already handles.
const OPTIONAL_NATIVE = new Set(["pg-native", "bufferutil", "utf-8-validate"]);

await rm(new URL("../apps/service/dist", import.meta.url), { recursive: true, force: true });

const result = await build({
  absWorkingDir: ROOT,
  entryPoints: ["apps/service/src/serverless.ts"],
  outfile: OUTFILE,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  // pg and ws are CommonJS and call require() at load time. esbuild's ESM output routes
  // those through a __require shim that throws "Dynamic require of X is not supported"
  // unless a real require exists in scope, so give it one. Without this banner the bundle
  // builds, resolves, and dies on first import, which is the same shape of failure as the
  // TypeScript specifier it replaces.
  banner: {
    js: 'import { createRequire as __nodeCreateRequire } from "node:module";\nconst require = __nodeCreateRequire(import.meta.url);'
  },
  // Nothing external. See the header: the deployment cannot resolve bare specifiers from
  // the directory the function lands in.
  external: [],
  metafile: true,
  logLevel: "info"
});

assertSelfContained(result.metafile);
console.log(`built ${OUTFILE}`);

/**
 * Fails the build if the output still reaches outside itself for anything but a Node
 * builtin. A bundle that resolves a package here and not in the deployment is exactly the
 * failure this file exists to stop, and the metafile says which specifiers survived.
 */
function assertSelfContained(metafile) {
  const external = (metafile.outputs[OUTFILE]?.imports ?? [])
    .filter((entry) => entry.external)
    .map((entry) => entry.path)
    .filter((path) => !isNodeBuiltin(path) && !OPTIONAL_NATIVE.has(path));
  if (external.length === 0) return;
  throw new Error(`${OUTFILE} still imports ${[...new Set(external)].join(", ")}, which will not resolve where the function is deployed`);
}

function isNodeBuiltin(specifier) {
  return builtinModules.includes(specifier.replace(/^node:/, "").split("/")[0]);
}
