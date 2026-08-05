import { readFile } from "node:fs/promises";
import { createSupabaseJwks } from "./auth.js";
import { assertSafeServiceBinding, createServiceServer } from "./http.js";
import { createObservability, observeRequest } from "./observability.js";
import { createAnalytics } from "./analytics.js";
import { PgStore } from "./store.js";

export async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Supabase's pooled Postgres connection string is a standard `postgres://` URL, so
  // DATABASE_URL works exactly as it did against the self-hosted database.
  const databaseUrl = required(environment.DATABASE_URL, "DATABASE_URL");
  const supabaseUrl = required(environment.SUPABASE_URL, "SUPABASE_URL");
  // Supabase signs access tokens with an asymmetric key (verified via its JWKS
  // endpoint), not a shared secret, so there is no SUPABASE_JWT_SECRET to configure.
  // createSupabaseJwks fetches and caches the project's public keys; build it once
  // and reuse it for the life of the process.
  const jwks = createSupabaseJwks(supabaseUrl);
  const host = environment.CROSSCODE_SERVICE_HOST ?? "127.0.0.1";
  const port = parsePort(environment.CROSSCODE_SERVICE_PORT ?? "8788");
  const tls = await loadTls(environment);
  // Managed hosts (Fly, Railway, Render, Cloud Run) terminate TLS at their edge and
  // route plaintext to the container, so the process must bind 0.0.0.0 with no cert of
  // its own. That is only safe when something in front is actually doing the TLS, which
  // no process can detect -- hence an explicit opt-in rather than a guess.
  const trustProxyTls = environment.CROSSCODE_TRUST_PROXY_TLS === "true";
  assertSafeServiceBinding(host, Boolean(tls) || trustProxyTls);
  const allowedOrigins = parseAllowedOrigins(environment.CROSSCODE_ALLOWED_ORIGINS);
  const store = new PgStore(databaseUrl, environment.DATABASE_CA_CERT);
  // Inert unless SENTRY_DSN is set. Created before the store check so a startup that
  // fails on privileges is reported rather than only printed to a log nobody watches.
  const reporter = createObservability(environment);
  let server: ReturnType<typeof createServiceServer>;
  try {
    await store.assertRuntimePrivileges();
    // trustProxy rides the same flag: it is the operator asserting there is a real
    // reverse proxy in front, which is exactly the condition under which
    // x-forwarded-for is trustworthy and the socket address is not.
    server = createServiceServer({
      store, jwks, supabaseUrl, tls, allowedOrigins, trustProxy: trustProxyTls,
      // Where invite links point. Set it per deployment; the default is production.
      appUrl: environment.CROSSCODE_APP_URL,
      // Inert unless POSTHOG_KEY is set.
      analytics: createAnalytics(environment)
    });
    // A second request listener alongside the route handler: it only reads the status the
    // response ends with, so it cannot change what any route does.
    server.on("request", (request, response) => { observeRequest(reporter, request, response); });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    reporter.capture(error, { route: "/startup", method: "PROCESS" });
    await reporter.flush();
    await store.close();
    throw error;
  }
  process.stdout.write(`Crosscode service listening on ${tls ? "https" : "http"}://${host}:${port}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  };
  const onSignal = () => void stop()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(`Service shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

async function loadTls(environment: NodeJS.ProcessEnv) {
  const keyPath = environment.CROSSCODE_TLS_KEY;
  const certPath = environment.CROSSCODE_TLS_CERT;
  if (!keyPath && !certPath) return undefined;
  if (!keyPath || !certPath) throw new Error("CROSSCODE_TLS_KEY and CROSSCODE_TLS_CERT must be configured together");
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  return { key, cert };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Comma-separated exact origins, e.g. "https://crosscode-one.vercel.app". */
function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((origin) => origin.trim()).filter(Boolean).map((origin) => {
    // A trailing slash or a path here would silently never match the browser's Origin
    // header, which sends scheme://host[:port] and nothing else.
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`CROSSCODE_ALLOWED_ORIGINS entry is not a valid origin: ${origin}`);
    }
    return parsed.origin;
  });
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("CROSSCODE_SERVICE_PORT must be an integer");
  const port = Number(value);
  if (port < 1 || port > 65_535) throw new Error("CROSSCODE_SERVICE_PORT must be between 1 and 65535");
  return port;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
