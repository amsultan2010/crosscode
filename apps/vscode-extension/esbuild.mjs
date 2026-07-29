import { build } from "esbuild";

await build({
  // ".cjs" (not ".js") so Node's ESM loader doesn't reject this CJS bundle under this
  // package's "type": "module" when the real VS Code extension host loads it via `main`.
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.cjs",
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info"
});

await build({
  // ".cjs" (not ".js") so Node's ESM loader doesn't reject this CJS bundle under this
  // package's "type": "module" when VS Code dynamically imports extensionTestsPath.
  entryPoints: ["test/suite/index.ts"],
  bundle: true,
  outfile: "dist/test/suite/index.cjs",
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info"
});
