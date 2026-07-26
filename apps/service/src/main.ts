import { readFile } from "node:fs/promises";
import { assertSafeServiceBinding, createServiceServer } from "./http.js";
import { PgStore } from "./store.js";

export async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const databaseUrl = required(environment.DATABASE_URL, "DATABASE_URL");
  const jwtSecret = required(environment.CROSSCODE_JWT_SECRET, "CROSSCODE_JWT_SECRET");
  if (Buffer.byteLength(jwtSecret) < 32) throw new Error("CROSSCODE_JWT_SECRET must contain at least 32 bytes");
  const host = environment.CROSSCODE_SERVICE_HOST ?? "127.0.0.1";
  const port = parsePort(environment.CROSSCODE_SERVICE_PORT ?? "8788");
  const tls = await loadTls(environment);
  assertSafeServiceBinding(host, Boolean(tls));
  const store = new PgStore(databaseUrl);
  let server: ReturnType<typeof createServiceServer>;
  try {
    await store.assertRuntimePrivileges();
    server = createServiceServer({ store, jwtSecret, tls });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
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
