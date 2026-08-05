import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { SyncDaemonConfig } from "../../../packages/protocol/src/sync.js";
import { CliError } from "./errors.js";

/**
 * GitHub sign-in, as a narrow interface.
 *
 * The contract describes the *result* -- `syncDaemonConfigSchema.service.session` -- but not
 * how it is obtained, and the service's auth routes are being written in parallel. So the
 * shape below is a STUB of another workstream's behaviour: a device-code handshake at
 * `POST /v1/auth/github/device` and `POST /v1/auth/github/device/token`. Everything the CLI
 * keeps afterwards is contract-shaped; only these two route names are invented.
 */

export type Session = NonNullable<SyncDaemonConfig["service"]["session"]>;

export type SignIn = (options: { serviceUrl: string; openBrowser: boolean; report: (line: string) => void }) => Promise<Session>;

/** STUB: route not described by the wire contract. */
const deviceStartSchema = z.object({
  deviceCode: z.string().min(1),
  verificationUrl: z.string().url(),
  userCode: z.string().min(1),
  intervalSeconds: z.number().int().positive().default(5),
  expiresInSeconds: z.number().int().positive().default(900)
});

/** STUB: route not described by the wire contract. */
const devicePollSchema = z.union([
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("complete"),
    session: z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1), expiresAt: z.string().datetime() })
  })
]);

export function githubSignIn(fetchImpl: typeof fetch = fetch, open: (url: string) => void = openBrowser): SignIn {
  return async ({ serviceUrl, openBrowser: shouldOpen, report }) => {
    const start = deviceStartSchema.parse(await postJson(fetchImpl, serviceUrl, "/v1/auth/github/device", {}));
    report(shouldOpen ? `Opening ${start.verificationUrl} to sign in with GitHub…` : `Open this URL to sign in with GitHub:\n${start.verificationUrl}`);
    report(`Confirmation code: ${start.userCode}`);
    if (shouldOpen) open(start.verificationUrl);

    const deadline = start.expiresInSeconds * 1000;
    for (let waited = 0; waited < deadline; waited += start.intervalSeconds * 1000) {
      await delay(start.intervalSeconds * 1000);
      const polled = devicePollSchema.parse(await postJson(fetchImpl, serviceUrl, "/v1/auth/github/device/token", { deviceCode: start.deviceCode }));
      if (polled.status === "complete") {
        report("Signed in with GitHub.");
        return polled.session;
      }
    }
    throw new CliError("SIGN_IN_TIMED_OUT", "The GitHub sign-in was not completed in time", "Run `crosscode start` again.");
  };
}

async function postJson(fetchImpl: typeof fetch, baseUrl: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }).catch((error: Error) => {
    throw new CliError("SERVICE_UNREACHABLE", `Signing in could not reach ${baseUrl}: ${error.message}`, "Check your network connection and try again.");
  });
  if (!response.ok) throw new CliError("SIGN_IN_FAILED", `Signing in failed: ${response.status}`, "Try again, or check https://www.getcrosscode.dev for service status.");
  return response.json();
}

function openBrowser(url: string): void {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  // Detached and ignored: the browser outliving this process is the point, and a machine
  // with no opener should print the URL (already reported) rather than fail the sign-in.
  spawn(command!, args as string[], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}
