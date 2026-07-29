import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node22",
  // "typescript" is @crosscode/git's dependency for its AST dependency-graph
  // feature, which this extension never calls; @crosscode/git lazy-loads it
  // on first actual use, so it is safe to exclude from this bundle.
  external: ["vscode", "typescript"],
  sourcemap: true,
  logLevel: "info"
});
