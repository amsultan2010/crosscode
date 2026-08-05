// The reporter itself lives in the service app and is imported by relative path, the same
// way apps/cli imports ../../daemon/src/client.js: the bundle in scripts/build.mjs resolves
// it at build time, and one copy of the redaction rules is the only way both processes stay
// held to the same ones. Nothing from the service's runtime comes with it; observability.ts
// imports node:crypto and a type.
import { createErrorReporter, type Transport } from "../../service/src/observability.js";

/**
 * Crash reporting for the daemon, which runs on a user's machine watching a checkout.
 *
 * Off unless the user turns it on. `docs/privacy.md` says the service cannot read your
 * code and that encryption is on by default with nothing to switch on; a reporter that
 * defaulted to sending anything from a developer's laptop would contradict that page. So
 * this needs two things set, not one:
 *
 *   CROSSCODE_ERROR_REPORTING=on
 *   CROSSCODE_SENTRY_DSN=https://...
 *
 * A DSN alone does nothing, which means inheriting a DSN from a shell profile or a CI
 * environment cannot silently start reporting. What gets sent, and nothing else: the error
 * type, a redacted one-line message, stack frames as basename plus line number, the daemon
 * stage that failed ("startup", "watch", "publish"), and the daemon version. No file
 * contents, no paths, no diffs, no repository name, no email, no workspace or device id.
 */

/** Stages a daemon failure can be attributed to. Fixed strings, never derived from input. */
export type DaemonStage = "startup" | "watch" | "publish" | "sync";

export type DaemonTelemetry = {
  enabled: boolean;
  capture: (error: unknown, stage: DaemonStage) => void;
  flush: () => Promise<void>;
};

const OFF: DaemonTelemetry = { enabled: false, capture: () => {}, flush: () => Promise.resolve() };

export function telemetryEnabled(environment: NodeJS.ProcessEnv): boolean {
  return environment.CROSSCODE_ERROR_REPORTING?.trim().toLowerCase() === "on" && Boolean(environment.CROSSCODE_SENTRY_DSN);
}

export function createDaemonTelemetry(
  environment: NodeJS.ProcessEnv = process.env,
  options: { version?: string; transport?: Transport } = {}
): DaemonTelemetry {
  if (!telemetryEnabled(environment)) return OFF;
  const reporter = createErrorReporter({
    dsn: environment.CROSSCODE_SENTRY_DSN,
    environment: "daemon",
    release: options.version,
    transport: options.transport
  });
  return {
    enabled: reporter.enabled,
    capture: (error, stage) => { reporter.capture(error, { route: stage, method: "DAEMON" }); },
    flush: () => reporter.flush()
  };
}
