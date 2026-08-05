import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { SyncDaemonConfig } from "../../../packages/protocol/src/sync.js";
import { CliError } from "./errors.js";

/**
 * GitHub sign-in, as a narrow interface.
 *
 * A terminal cannot receive an OAuth redirect, so this is a device handshake against the
 * service: `POST /v1/auth/github/device` opens one and answers with a URL and a short code
 * to carry to a browser, and `POST /v1/auth/github/device/token` is asked every few seconds
 * until somebody has signed in there. What comes back is the contract's
 * `syncDaemonConfigSchema.service.session`, which is what the daemon runs on.
 */

export type Session = NonNullable<SyncDaemonConfig["service"]["session"]>;

/**
 * The session, plus the GitHub OAuth token that came with it when there was one.
 *
 * The token is separate from the session because it is never written to disk: redeeming an
 * invite has to prove to GitHub that this person can read the repository, and this is the
 * one moment the token exists -- Supabase hands it to the browser at sign-in and does not
 * keep it. `crosscode join` uses it once, in memory, and lets it go.
 */
export type SignInResult = { session: Session; githubToken: string | undefined };

export type SignIn = (options: { serviceUrl: string; openBrowser: boolean; report: (line: string) => void }) => Promise<SignInResult>;

const deviceStartSchema = z.object({
  deviceCode: z.string().min(1),
  verificationUrl: z.string().url(),
  userCode: z.string().min(1),
  intervalSeconds: z.number().int().positive().default(5),
  expiresInSeconds: z.number().int().positive().default(900)
});

const devicePollSchema = z.union([
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("complete"),
    session: z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1), expiresAt: z.string().datetime() }),
    /** Absent when the browser sign-in produced no GitHub token; `join` is what needs one. */
    githubToken: z.string().min(1).optional()
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
        return { session: polled.session, githubToken: polled.githubToken };
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
  return serviceData(await response.json());
}

/**
 * The service answers every route with `{ ok, data }`, so the shape a schema describes is
 * always one level in. Unwrapped here rather than in each schema so the schemas stay a
 * description of the thing itself.
 */
function serviceData(body: unknown): unknown {
  return typeof body === "object" && body !== null && "data" in body ? (body as { data: unknown }).data : body;
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
