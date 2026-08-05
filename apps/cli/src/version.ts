/**
 * Version of the published `crosscode` package: what `crosscode --version` reports.
 *
 * scripts/build.mjs substitutes `__CROSSCODE_VERSION__` from the root manifest when it
 * bundles, because an installed bundle has no package.json at a path it can rely on. Run
 * from source through tsx nothing substitutes it: `typeof` on an undeclared identifier is
 * legal JavaScript and yields "undefined", so a working copy reports itself as such instead
 * of claiming to be whatever release it was last built from.
 *
 * Declared here rather than imported from apps/daemon so that the CLI does not depend on a
 * module another workstream is rewriting underneath it.
 */
declare const __CROSSCODE_VERSION__: string;

export const VERSION: string = typeof __CROSSCODE_VERSION__ === "string" ? __CROSSCODE_VERSION__ : "0.0.0-source";

/**
 * The hosted deployment. Crosscode is hosted-only -- there is no `--service` flag and no
 * self-hosting, so this is compiled in rather than configured.
 */
export const SERVICE_URL = "https://www.getcrosscode.dev";
