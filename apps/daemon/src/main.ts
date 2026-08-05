#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createDaemonTelemetry } from "./observability.js";
import { supervise } from "./supervisor.js";
import { SyncDaemon } from "./sync-daemon.js";
import { VERSION } from "./version.js";

const args = process.argv.slice(2);
const directoryFlag = args.indexOf("--directory");
const directory = directoryFlag >= 0 ? args[directoryFlag + 1] : process.cwd();
/**
 * `--supervise` runs the crash-restart parent; the worker it spawns is this same binary
 * without the flag. One binary, so however the daemon was installed -- bundled, or through
 * tsx from a clone -- the parent already knows how to start the child.
 */
const supervising = args.includes("--supervise");

// Off unless the user set both CROSSCODE_ERROR_REPORTING=on and CROSSCODE_SENTRY_DSN.
const telemetry = createDaemonTelemetry(process.env, { version: VERSION });

if (!directory) {
  process.stderr.write("Usage: crosscode-daemon [--directory <repository>] [--supervise]\n");
  process.exitCode = 1;
} else if (supervising) {
  const supervisor = supervise(
    () => spawn(process.execPath, [process.argv[1]!, "--directory", directory], { stdio: "inherit" }),
    { onEvent: (event) => { if (event.type !== "start") process.stderr.write(`Crosscode daemon ${event.type} (attempt ${event.restarts})\n`); } }
  );
  process.once("SIGINT", () => void supervisor.stop());
  process.once("SIGTERM", () => void supervisor.stop());
  await supervisor.done;
} else {
  const daemon = await SyncDaemon.start(directory).catch(async (error: unknown) => {
    telemetry.capture(error, "startup");
    await telemetry.flush();
    throw error;
  });
  process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, port: daemon.connection.port })}\n`);
  const shutdown = async () => {
    await daemon.stop();
    await telemetry.flush();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
