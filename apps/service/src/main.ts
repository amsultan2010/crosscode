import { readFile } from "node:fs/promises";
import { createSupabaseJwks } from "./auth.js";
import { assertSafeServiceBinding, createServiceServer, type BillingOptions } from "./http.js";
import { createObservability, observeRequest } from "./observability.js";
import { DEFAULT_SWEEP_INTERVAL_MS, startRetentionSweep } from "./retention.js";
import { PgStore } from "./store.js";
import { StripeBillingProvider, parseStripePriceCatalog } from "./stripe.js";

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
  const billing = loadBilling(environment);
  const store = new PgStore(databaseUrl);
  // Inert unless SENTRY_DSN is set. Created before the store check so a startup that
  // fails on privileges is reported rather than only printed to a log nobody watches.
  const reporter = createObservability(environment);
  let server: ReturnType<typeof createServiceServer>;
  try {
    await store.assertRuntimePrivileges();
    // trustProxy rides the same flag: it is the operator asserting there is a real
    // reverse proxy in front, which is exactly the condition under which
    // x-forwarded-for is trustworthy and the socket address is not.
    server = createServiceServer({ store, jwks, supabaseUrl, tls, allowedOrigins, billing, trustProxy: trustProxyTls });
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
  const retention = startConfiguredRetentionSweep(environment);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await retention?.stop();
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

/**
 * Enforces PLAN_LIMITS[plan].historyRetentionDays on a schedule, if this deployment gave it
 * a role that can. DATABASE_URL deliberately cannot delete operations, so the sweep needs
 * CROSSCODE_RETENTION_DATABASE_URL (or the MIGRATION_DATABASE_URL that already exists for
 * `pnpm service:migrate`). Without one, retention only happens when an admin runs
 * `pnpm service:prune`, which is worth saying out loud at startup rather than leaving the
 * operator to discover from a growing bill.
 */
function startConfiguredRetentionSweep(environment: NodeJS.ProcessEnv) {
  const databaseUrl = environment.CROSSCODE_RETENTION_DATABASE_URL ?? environment.MIGRATION_DATABASE_URL;
  if (!databaseUrl) {
    process.stdout.write("Crosscode retention sweep is disabled: set CROSSCODE_RETENTION_DATABASE_URL to a role with DELETE on operations, or run 'pnpm service:prune' manually\n");
    return undefined;
  }
  const intervalMs = parseSweepIntervalMs(environment.CROSSCODE_RETENTION_SWEEP_MINUTES);
  process.stdout.write(`Crosscode retention sweep running every ${Math.round(intervalMs / 60_000)} minute(s)\n`);
  return startRetentionSweep({
    databaseUrl,
    intervalMs,
    onSwept: (results) => {
      for (const result of results) {
        process.stdout.write(`Crosscode retention: workspace ${result.workspaceId} (${result.plan}, ${result.retentionDays}d) deleted ${result.deleted} operation(s) through sequence ${result.prunedThrough}\n`);
      }
    },
    onError: (error: unknown) => {
      process.stderr.write(`Crosscode retention sweep failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  });
}

function parseSweepIntervalMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SWEEP_INTERVAL_MS;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error("CROSSCODE_RETENTION_SWEEP_MINUTES must be a positive integer");
  return Number(value) * 60_000;
}

/**
 * Builds the Stripe provider, or returns undefined for a deployment that sells nothing --
 * a self-hoster, or local development. Undefined is not a degraded mode: the checkout
 * routes answer 503 and the webhook route does not exist, which is the correct surface for
 * a service with no payment provider behind it.
 *
 * CROSSCODE_STRIPE_WEBHOOK_SECRET is required alongside the key rather than optional. A
 * deployment that can take money but cannot verify what Stripe tells it about that money
 * would silently never grant anything, and would be the exact configuration in which an
 * unauthenticated route is worth attacking.
 */
function loadBilling(environment: NodeJS.ProcessEnv): BillingOptions | undefined {
  const secretKey = environment.CROSSCODE_STRIPE_SECRET_KEY;
  if (!secretKey) return undefined;
  const webhookSecret = required(environment.CROSSCODE_STRIPE_WEBHOOK_SECRET, "CROSSCODE_STRIPE_WEBHOOK_SECRET");
  const prices = parseStripePriceCatalog(required(environment.CROSSCODE_STRIPE_PRICES, "CROSSCODE_STRIPE_PRICES"));
  // Both are pages on the marketing site; neither is a dashboard. Checkout itself is
  // Stripe-hosted, so all the site has to do is say "you're done, back to your terminal".
  const successUrl = required(environment.CROSSCODE_STRIPE_SUCCESS_URL, "CROSSCODE_STRIPE_SUCCESS_URL");
  const cancelUrl = environment.CROSSCODE_STRIPE_CANCEL_URL ?? successUrl;
  return {
    provider: new StripeBillingProvider({
      secretKey, prices, successUrl, cancelUrl,
      portalReturnUrl: environment.CROSSCODE_STRIPE_PORTAL_RETURN_URL,
      apiVersion: environment.CROSSCODE_STRIPE_API_VERSION
    }),
    webhookSecret
  };
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
