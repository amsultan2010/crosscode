/**
 * What this server announces as `serverInfo.version`. `scripts/build.mjs` substitutes
 * `__CROSSCODE_VERSION__` from the root manifest at bundle time; run from source through
 * tsx nothing substitutes it, and `typeof` on an undeclared identifier is legal JavaScript,
 * so a working copy says so instead of claiming to be a release.
 */
declare const __CROSSCODE_VERSION__: string;

export const VERSION: string = typeof __CROSSCODE_VERSION__ === "string" ? __CROSSCODE_VERSION__ : "0.0.0-source";
