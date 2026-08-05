import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Error reporting for the coordination service, and the shared half of the daemon's
 * (see apps/daemon/src/observability.ts, which imports createErrorReporter from here).
 *
 * Two properties this module exists to guarantee:
 *
 * 1. **No DSN, no anything.** Without SENTRY_DSN nothing is constructed, no listener is
 *    attached and no socket is opened. createErrorReporter returns a reporter whose
 *    enabled flag is false and whose capture is a function that returns immediately.
 * 2. **No user code or content leaves the process.** The event is built field by field
 *    from an allowlist rather than by handing an Error to an SDK that serializes whatever
 *    it finds. Custom properties, `cause`, request bodies, headers and environment are
 *    never read. The one field that can carry caller-supplied text is the error message,
 *    and it goes through redact() first. See the tests in observability.test.ts.
 *
 * There is no @sentry/node dependency on purpose. The daemon is bundled into the
 * published `@crosscode/cli` tarball (scripts/build.mjs), so every runtime dependency the
 * reporter needs is one more real npm package users install to run a watcher. Sentry's
 * ingest API is one POST of an envelope, which is the whole transport below.
 */

export type RequestContext = {
  /** Route template with identifiers removed, e.g. "/v1/workspaces/:id/operations". */
  route: string;
  method: string;
  status?: number;
  requestId?: string;
};

export type SentryEvent = {
  event_id: string;
  timestamp: number;
  platform: "node";
  level: "error";
  environment: string;
  server_name?: string;
  transaction?: string;
  tags: Record<string, string>;
  exception: { values: [{ type: string; value: string; stacktrace?: { frames: StackFrame[] } }] };
};

type StackFrame = { function?: string; filename: string; lineno?: number; colno?: number };

/** Injectable so tests can assert on the exact event that would have gone over the wire. */
export type Transport = (event: SentryEvent) => Promise<void>;

export type ErrorReporter = {
  enabled: boolean;
  capture: (error: unknown, context: RequestContext) => void;
  /** Awaits every in-flight send. Resolves immediately when there is nothing in flight. */
  flush: () => Promise<void>;
};

const DISABLED: ErrorReporter = { enabled: false, capture: () => {}, flush: () => Promise.resolve() };

export type ReporterOptions = {
  dsn: string | undefined;
  environment?: string;
  release?: string;
  transport?: Transport;
};

export function createErrorReporter(options: ReporterOptions): ErrorReporter {
  const dsn = options.dsn ? parseDsn(options.dsn) : undefined;
  if (!dsn) return DISABLED;
  const transport = options.transport ?? httpTransport(dsn);
  const environment = options.environment ?? "production";
  const inFlight = new Set<Promise<void>>();
  return {
    enabled: true,
    capture(error, context) {
      const event = buildEvent(error, context, environment, options.release);
      // A failed report must never become the thing that takes the service down, and it
      // must not surface as an unhandled rejection either.
      const sent = transport(event).catch(() => undefined);
      inFlight.add(sent);
      void sent.finally(() => inFlight.delete(sent));
    },
    async flush() {
      await Promise.all([...inFlight]);
    }
  };
}

/** Reads SENTRY_DSN and friends. Absent DSN gives the inert reporter. */
export function createObservability(environment: NodeJS.ProcessEnv = process.env, transport?: Transport): ErrorReporter {
  return createErrorReporter({
    dsn: environment.SENTRY_DSN,
    environment: environment.SENTRY_ENVIRONMENT ?? environment.VERCEL_ENV ?? "production",
    release: environment.SENTRY_RELEASE ?? environment.VERCEL_GIT_COMMIT_SHA,
    transport
  });
}

/**
 * Attaches the 5xx watcher and returns the context to use if the handler throws.
 *
 * The status a handler ends up writing is not visible from a try/catch around it, and
 * http.ts (owned elsewhere) answers most failures with a 500 response rather than a thrown
 * error, so the response's own finish event is the only place both are observable.
 */
export function observeRequest(reporter: ErrorReporter, request: IncomingMessage, response: ServerResponse): RequestContext {
  const context: RequestContext = {
    route: normalizeRoute(request.url ?? "/"),
    method: (request.method ?? "GET").toUpperCase(),
    requestId: requestIdOf(request)
  };
  if (!reporter.enabled) return context;
  response.once("finish", () => {
    if (response.statusCode < 500) return;
    reporter.capture(new Error(`HTTP ${response.statusCode}`), { ...context, status: response.statusCode });
  });
  return context;
}

/**
 * Platform-assigned ids only. A client-supplied x-request-id would be attacker-controlled
 * free text arriving in a tag, so it is accepted only in the shape an id has.
 */
function requestIdOf(request: IncomingMessage): string | undefined {
  const header = request.headers["x-vercel-id"] ?? request.headers["x-request-id"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !/^[\w:.-]{1,64}$/.test(value)) return undefined;
  return value;
}

/**
 * Turns a request path into a route template. Every segment that is not a fixed part of
 * the API surface becomes ":id", so a workspace id, a device id or anything else a caller
 * put in a path cannot reach Sentry. The query string is dropped whole.
 */
export function normalizeRoute(url: string): string {
  const path = url.split("?")[0] ?? "/";
  const segments = path.split("/").filter(Boolean).slice(0, 8);
  if (segments.length === 0) return "/";
  return `/${segments.map((segment) => /^[a-z][a-z0-9-]{0,31}$/.test(segment) && !/^v?[0-9a-f]{8,}$/.test(segment) ? segment : ":id").join("/")}`;
}

/**
 * Aggressive, deliberately lossy redaction of an error message.
 *
 * The service handles file payloads, paths, diffs, task titles and handoff notes, and any
 * of them can end up interpolated into an error. Rather than enumerate the messages that
 * are safe, this removes every shape those values take: quoted spans, path-like tokens,
 * long opaque runs (ciphertext, hashes, tokens), and everything after the first line. What
 * survives is the fixed English of the message plus small numbers, which is what makes an
 * error identifiable without saying anything about what the user was editing.
 */
export function redact(message: string): string {
  const firstLine = message.split("\n", 1)[0] ?? "";
  const redacted = firstLine
    .replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, "[redacted]")
    // Any whitespace-free run containing a separator is a path, absolute or relative,
    // POSIX or Windows. Trailing punctuation is put back so the sentence still reads.
    .replace(/\S*[/\\]\S*/g, (match) => `[path]${/[)\]},.;:!?]+$/.exec(match)?.[0] ?? ""}`)
    .replace(/\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|rb|c|h|cc|cpp|css|scss|html|ya?ml|toml|sql|sh|env)\b/gi, "[path]")
    .replace(/\b[A-Za-z0-9+/=_-]{24,}\b/g, "[redacted]");
  return redacted.length > 200 ? `${redacted.slice(0, 200)}...` : redacted;
}

export function buildEvent(error: unknown, context: RequestContext, environment: string, release?: string): SentryEvent {
  const source = error instanceof Error ? error : undefined;
  const tags: Record<string, string> = { route: context.route, method: context.method };
  if (context.status !== undefined) tags.status = String(context.status);
  if (context.requestId) tags.request_id = context.requestId;
  if (release) tags.release = release;
  return {
    event_id: randomUUID().replace(/-/g, ""),
    timestamp: Math.floor(Date.now() / 1_000),
    platform: "node",
    level: "error",
    environment,
    transaction: `${context.method} ${context.route}`,
    tags,
    exception: {
      values: [{
        type: errorType(source?.name),
        value: redact(source ? source.message : String(error)),
        ...(source?.stack ? { stacktrace: { frames: parseFrames(source.stack) } } : {})
      }]
    }
  };
}

function errorType(name: string | undefined): string {
  return name && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error";
}

/**
 * Stack frames are locations in Crosscode's own code, so they carry no user data. Only the
 * parsed shape is sent. The raw stack string is dropped because its first line is
 * the message, which would route around redact(), and because absolute install paths on a
 * contributor's laptop are nobody's business either.
 */
function parseFrames(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n").slice(1, 31)) {
    const match = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!match) continue;
    frames.push({
      ...(match[1] ? { function: match[1] } : {}),
      filename: (match[2] ?? "").split("/").pop() ?? "unknown",
      lineno: Number(match[3]),
      colno: Number(match[4])
    });
  }
  // Sentry orders frames oldest first; a Node stack is newest first.
  return frames.reverse();
}

export type ParsedDsn = { endpoint: string; publicKey: string; dsn: string };

/** Sentry DSNs look like https://<publicKey>@<host>/<projectId>. */
export function parseDsn(dsn: string): ParsedDsn | undefined {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, "");
    if (!url.username || !projectId) return undefined;
    return {
      endpoint: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
      publicKey: url.username,
      dsn: `${url.protocol}//${url.username}@${url.host}/${projectId}`
    };
  } catch {
    return undefined;
  }
}

function httpTransport(dsn: ParsedDsn): Transport {
  return async (event) => {
    const envelope = [
      JSON.stringify({ event_id: event.event_id, dsn: dsn.dsn, sent_at: new Date().toISOString() }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(event)
    ].join("\n");
    await fetch(dsn.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_client=crosscode/1, sentry_key=${dsn.publicKey}`
      },
      body: envelope,
      signal: AbortSignal.timeout(5_000)
    });
  };
}
