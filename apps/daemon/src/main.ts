#!/usr/bin/env node
import { createDaemonTelemetry } from "./observability.js";
import { runDaemonProcess } from "./runtime.js";
import { VERSION } from "./version.js";

const args = process.argv.slice(2);
const directoryFlag = args.indexOf("--directory");
const directory = directoryFlag >= 0 ? args[directoryFlag + 1] : process.cwd();

// Off unless the user set both CROSSCODE_ERROR_REPORTING=on and CROSSCODE_SENTRY_DSN.
const telemetry = createDaemonTelemetry(process.env, { version: VERSION });

if (!directory) {
  process.stderr.write("Usage: crosscode-daemon [--directory <repository>]\n");
  process.exitCode = 1;
} else {
  const managed = await runDaemonProcess(directory).catch(async (error: unknown) => {
    telemetry.capture(error, "startup");
    await telemetry.flush();
    throw error;
  });
  process.stdout.write(`${JSON.stringify({ ready: true, pid: managed.connection.pid, port: managed.connection.port })}\n`);
  const shutdown = async () => {
    await managed.stop();
    await telemetry.flush();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
