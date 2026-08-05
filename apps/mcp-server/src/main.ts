#!/usr/bin/env node
import { serveMcp } from "./index.js";

// Two entrypoints, one bundle: `hook` runs the pre-edit hook for Claude Code and Codex,
// anything else serves MCP over stdio.
if (process.argv[2] === "hook") {
  const { main } = await import("./hook-main.js");
  process.exitCode = await main(process.argv.slice(3));
} else {
  await serveMcp();
}
