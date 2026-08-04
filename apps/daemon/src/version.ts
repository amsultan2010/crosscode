/**
 * Version of the published `crosscode` package: what `crosscode --version` reports and what
 * the MCP server announces as `serverInfo.version`.
 *
 * It lives here, in the one module both shipped entrypoints already import, so the two bins
 * cannot drift apart -- `crosscode-mcp` previously carried a hand-written "0.1.0" that
 * nothing kept in step with the manifest.
 *
 * scripts/build.mjs substitutes `__CROSSCODE_VERSION__` from the root manifest when it
 * bundles, because an installed bundle has no package.json at a path it can rely on. Run
 * from source through tsx nothing substitutes it: `typeof` on an undeclared identifier is
 * legal JavaScript and yields "undefined", so a working copy reports itself as such instead
 * of claiming to be whatever release it was last built from. (esbuild replaces the
 * identifier inside `typeof` too, folding the check to a constant in the bundle.)
 */
declare const __CROSSCODE_VERSION__: string;

export const VERSION: string = typeof __CROSSCODE_VERSION__ === "string" ? __CROSSCODE_VERSION__ : "0.0.0-source";
