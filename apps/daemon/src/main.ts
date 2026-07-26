#!/usr/bin/env node
import { runDaemonProcess } from "./runtime.js";

const args = process.argv.slice(2);
const directoryFlag = args.indexOf("--directory");
const directory = directoryFlag >= 0 ? args[directoryFlag + 1] : process.cwd();

if (!directory) {
  process.stderr.write("Usage: crosscode-daemon [--directory <repository>]\n");
  process.exitCode = 1;
} else {
  const managed = await runDaemonProcess(directory);
  process.stdout.write(`${JSON.stringify({ ready: true, pid: managed.connection.pid, port: managed.connection.port })}\n`);
  const shutdown = async () => {
    await managed.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
