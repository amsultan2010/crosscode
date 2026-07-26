import { PgStore } from "./store.js";

export async function provisionAdmin(argv = process.argv.slice(2), environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [command, first, actorId, role] = argv;
  if (!command || !first || !actorId || !["create", "join"].includes(command)) throw new Error("Usage: service:provision create <workspace-name> <actor-id> | join <workspace-id> <actor-id> [member|viewer]");
  const expectedLength = command === "create" ? 3 : role ? 4 : 3;
  if (argv.length !== expectedLength || !first.trim() || !actorId.trim()) throw new Error("Provisioning arguments are invalid");
  if (first.length > 200 || actorId.length > 200) throw new Error("Workspace and actor values must not exceed 200 characters");
  const databaseUrl = environment.MIGRATION_DATABASE_URL ?? environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL is required");
  const store = new PgStore(databaseUrl);
  try {
    const result = command === "create"
      ? await store.provisionAdmin({ workspaceName: first.trim(), actorId: actorId.trim() })
      : await store.provisionEnrollment({ workspaceId: first.trim(), actorId: actorId.trim(), role: role === "viewer" ? "viewer" : "member" });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  provisionAdmin().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
