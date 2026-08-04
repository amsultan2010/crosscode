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
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = parseJson(Buffer.concat(chunks).toString("utf8"));
      const echoed = typeof body?.state === "string" ? body.state : undefined;
      if (echoed !== state) {
        respond(response, 400, { ok: false, error: "state mismatch" });
        settle.reject(new BrowserLoginError(
          "LOGIN_STATE_MISMATCH",
          "The sign-in callback did not echo this login's state value",
          "Run `crosscode login` again and complete the sign-in in the tab it opens."
        ));
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
 * Base URL of the crosscode website: `--web`, then `CROSSCODE_WEB_URL`, then the
 * `CROSSCODE_DASHBOARD_URL` the MCP server already uses to name a deployed site, then the
 * hosted default. Self-hosters override with any of the first three.
 */
export function resolveWebUrl(explicit?: string): string {
  const url = explicit ?? process.env.CROSSCODE_WEB_URL ?? process.env.CROSSCODE_DASHBOARD_URL ?? DEFAULT_WEB_URL;
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
