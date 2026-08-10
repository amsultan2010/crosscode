import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { platform } from "node:os";
import { z } from "zod";
import { DEFAULT_WEB_URL } from "./hosted.js";

/** No callback within this window means the person never finished signing in. */
export const LOGIN_CALLBACK_TIMEOUT_MS = 300_000;

/**
 * Ceiling on a callback body. A Supabase session is a couple of kilobytes, so this is orders
 * of magnitude of headroom -- it exists because the endpoint is reachable by any page that
 * finds the ephemeral port, and an unbounded buffer there is unbounded memory in the CLI for
 * as long as the login is pending.
 */
const MAX_CALLBACK_BODY_BYTES = 64 * 1024;

/**
 * The website posts this to `http://127.0.0.1:<port>/callback` after a successful Supabase
 * sign-in. Field names are the Supabase session's own snake_case shape on purpose: the page
 * forwards what its client handed it rather than renaming anything in the browser.
 */
export const cliCallbackSessionSchema = z.object({
  state: z.string().min(1),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_at: z.number().int().positive(),
  user: z.object({ id: z.string().min(1), email: z.string().min(1) })
});
export type CliCallbackSession = z.infer<typeof cliCallbackSessionSchema>;

/** Carries a stable `code` and an actionable `hint` so the CLI can report both verbatim. */
export class BrowserLoginError extends Error {
  constructor(public readonly code: string, message: string, public readonly hint: string) {
    super(message);
  }
}

// The POST comes from the website's origin, so the browser sends a preflight first; without
// these three headers on the OPTIONS response the fetch never reaches the handler at all.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type"
} as const;

export type LoginCallbackServer = {
  port: number;
  /** Random value echoed by the website; anything else is somebody else's request. */
  state: string;
  /** Resolves with the posted session, or rejects with a `BrowserLoginError`. */
  session: Promise<CliCallbackSession>;
  close: () => Promise<void>;
};

/**
 * Loopback half of `crosscode login`: binds 127.0.0.1 on an ephemeral port and waits for the
 * website to hand back the session it just created. Bound to loopback only, so nothing off
 * this machine can reach the endpoint at all.
 */
export async function startLoginCallbackServer(options: { timeoutMs?: number } = {}): Promise<LoginCallbackServer> {
  const state = randomBytes(16).toString("hex");
  let settle!: { resolve: (session: CliCallbackSession) => void; reject: (error: unknown) => void };
  const session = new Promise<CliCallbackSession>((resolve, reject) => { settle = { resolve, reject }; });
  // A rejection can land before the caller gets around to awaiting `session` (a bad callback
  // is rejected inside the request handler); this keeps that from reading as unhandled.
  session.catch(() => {});
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== "/callback") { response.writeHead(404, CORS_HEADERS).end(); return; }
    if (request.method === "OPTIONS") { response.writeHead(204, CORS_HEADERS).end(); return; }
    if (request.method !== "POST") { response.writeHead(405, CORS_HEADERS).end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // Past the cap the bytes are counted and dropped rather than kept, which is the whole
      // point: what is bounded is this process's memory. The rest of the body is still read
      // to the end so the 413 below can be written on a socket the sender is still reading,
      // instead of racing a destroy against its own response.
      if (size > MAX_CALLBACK_BODY_BYTES) { oversized = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (oversized) { respond(response, 413, { ok: false, error: "callback body too large" }); return; }
      const body = parseJson(Buffer.concat(chunks).toString("utf8"));
      const echoed = typeof body?.state === "string" ? body.state : undefined;
      if (echoed !== state) {
        // Only this request is refused. Anything can POST here -- a stale tab from an
        // earlier login, a page that guessed the port -- and failing the whole login on one
        // would let any of them kill a sign-in the user is in the middle of. The real
        // callback echoes the state, so the login goes on waiting for it, and the timeout
        // is what ends the wait if it never comes.
        respond(response, 400, { ok: false, error: "state mismatch" });
        return;
      }
      const parsed = cliCallbackSessionSchema.safeParse(body);
      if (!parsed.success) {
        respond(response, 400, { ok: false, error: "malformed session payload" });
        settle.reject(new BrowserLoginError(
          "LOGIN_CALLBACK_INVALID",
          `The sign-in callback payload was malformed: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
          "Make sure --web points at a crosscode website that serves /auth/cli.html, or log in with --email/--password."
        ));
        return;
      }
      respond(response, 200, { ok: true });
      settle.resolve(parsed.data);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const timer = setTimeout(() => settle.reject(new BrowserLoginError(
    "LOGIN_TIMEOUT",
    `No sign-in callback arrived within ${Math.round((options.timeoutMs ?? LOGIN_CALLBACK_TIMEOUT_MS) / 1_000)}s`,
    "Retry `crosscode login`, or use `crosscode login --no-browser` to open the URL yourself, or `crosscode login --email <email> --password <password>` for a headless login."
  )), options.timeoutMs ?? LOGIN_CALLBACK_TIMEOUT_MS);
  timer.unref();
  return {
    port: (server.address() as AddressInfo).port,
    state,
    session,
    close: () => {
      clearTimeout(timer);
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function parseJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function respond(response: import("node:http").ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { ...CORS_HEADERS, "content-type": "application/json" }).end(JSON.stringify(payload));
}

/** The page on the crosscode website that signs the person in and posts the session back. */
export function cliSignInUrl(webUrl: string, port: number, state: string): string {
  const url = new URL("/auth/cli.html", webUrl);
  url.searchParams.set("port", String(port));
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Warns once per process that `CROSSCODE_DASHBOARD_URL` is deprecated.
 *
 * On stderr, never stdout: README and AGENTS both promise that with `--json` stdout is one
 * line of JSON and nothing else, and an agent parsing that line would choke on a notice
 * printed above it. A deprecation warning that breaks the output contract is a worse bug
 * than the stale name it warns about.
 */
let dashboardUrlWarned = false;

/**
 * The configured website URL, or undefined when none is set.
 *
 * The precedence chain lives here alone because it used to be written out twice -- once
 * here and once in the MCP server's bootstrap -- which is how the two could have drifted.
 *
 * `CROSSCODE_DASHBOARD_URL` is deprecated: it is still read so setups configured before the
 * web dashboard was deleted keep working, but it names a site that no longer has a dashboard.
 * The notice goes to stderr and never stdout, and only once per process. README and AGENTS
 * both promise that with `--json` stdout is one line of JSON and nothing else, so a notice
 * printed above that line would be a worse bug than the stale name it warns about.
 */
export function configuredWebUrl(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  if (environment.CROSSCODE_WEB_URL) return environment.CROSSCODE_WEB_URL;
  if (!environment.CROSSCODE_DASHBOARD_URL) return undefined;
  if (!dashboardUrlWarned) {
    dashboardUrlWarned = true;
    process.stderr.write("crosscode: CROSSCODE_DASHBOARD_URL is deprecated and will be removed; set CROSSCODE_WEB_URL instead.\n");
  }
  return environment.CROSSCODE_DASHBOARD_URL;
}

/**
 * Base URL of the crosscode website: `--web`, then the environment (via configuredWebUrl,
 * which owns that precedence chain), then the hosted default in hosted.ts. Because there is
 * now a default, this no longer throws `WEB_URL_REQUIRED` -- bare `crosscode login` targets
 * the hosted site, and self-hosters override with the flag or the environment.
 */
export function resolveWebUrl(explicit?: string): string {
  const url = explicit ?? configuredWebUrl() ?? DEFAULT_WEB_URL;
  return url.replace(/\/+$/, "");
}

/**
 * Best-effort: hands a URL to the platform's default browser. Never throws and never blocks
 * -- headless environments (CI, containers, remote sessions) have nothing to open, and the
 * caller is still free to print the URL and wait.
 */
export function openInBrowser(url: string): void {
  try {
    const os = platform();
    const child = os === "darwin"
      ? spawn("open", [url], { detached: true, stdio: "ignore" })
      : os === "win32"
        ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
        : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Nothing to open; the caller prints the URL instead.
  }
}
