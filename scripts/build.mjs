// Bundles the three shipped entrypoints into dist/ with esbuild.
//
// Why bundle instead of emitting per-package JavaScript: apps/cli and apps/mcp-server
// import the daemon by relative path (`../../daemon/src/client.js`), which escapes the
// package root an npm tarball is rooted at. esbuild resolves those at build time, so one
// published package needs no import rewriting and no version lockstep across the nine
// workspace packages -- none of which have external consumers.
import { chmod, readFile, rm } from "node:fs/promises";
import { build } from "esbuild";

// Substituted into apps/daemon/src/version.ts, which both bins read. Taking it from the
// manifest rather than a second hand-maintained constant means `crosscode --version` cannot
// disagree with the version npm actually published.
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

// Real npm packages the bundles require at runtime. These stay external and are declared
// as `dependencies` of the published package; everything else (the @crosscode/* workspace
// packages) is inlined. Keep this list and the root manifest's `dependencies` in sync --
// assertNothingVendored below fails the build if a dependency is missing from here.
const EXTERNAL = [
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/sdk/*",
  "@supabase/supabase-js",
  "chokidar",
  "commander",
  "minimatch",
  "typescript",
  "ws",
  "yaml",
  "zod",
  "zod-to-json-schema"
];

const ENTRYPOINTS = [
  // Both bins: `crosscode` and `crosscode-mcp` point at this file and it dispatches on the
  // name it was invoked under, because npm only auto-resolves `npx <pkg>` when every bin
  // entry names one file. See the comment on invokedAsMcpBin in apps/cli/src/index.ts.
  { in: "apps/cli/src/index.ts", out: "cli" },
  // Not a bin any more: imported by the bundle above when it is serving MCP. Kept a separate
  // bundle so `crosscode <anything else>` does not pay to load the MCP SDK.
  { in: "apps/mcp-server/src/main.ts", out: "mcp" },
  // Not a bin: spawned by the MCP bootstrap, which locates it next to its own bundle.
  { in: "apps/daemon/src/main.ts", out: "daemon" }
];

/**
 * Fails the build if anything from node_modules got inlined. A dependency that is bundled
 * rather than declared works in the monorepo and breaks only once the tarball is installed
 * somewhere else, which is exactly the class of failure this package has to stop shipping.
 */
function assertNothingVendored(metafile) {
  const vendored = Object.keys(metafile.inputs).filter((input) => input.includes("node_modules"));
  if (vendored.length === 0) return;
  const unique = [...new Set(vendored.map((input) => input.replace(/^.*node_modules\//, "").split("/").slice(0, 2).join("/")))];
  throw new Error(`Bundled ${vendored.length} file(s) from node_modules. Add to EXTERNAL and to the root manifest's dependencies: ${unique.join(", ")}`);
}

await rm("dist", { recursive: true, force: true });

const result = await build({
  entryPoints: ENTRYPOINTS,
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  define: { __CROSSCODE_VERSION__: JSON.stringify(version) },
  external: EXTERNAL,
  metafile: true,
  logLevel: "info"
});

assertNothingVendored(result.metafile);

// npm sets the exec bit on `bin` targets at install time, but not for `node dist/cli.js`
// straight out of a build, and not for the daemon, which is never a bin.
for (const entry of ENTRYPOINTS) await chmod(`dist/${entry.out}.js`, 0o755);
