import { createClient } from "@supabase/supabase-js";
import { PgStore } from "./store.js";

// "actorId" in the CLI usage below is now an email address used to create or invite a
// Supabase Auth user, not an arbitrary local string as it was before Supabase Auth.
export async function provisionAdmin(argv = process.argv.slice(2), environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [command, first, email, role] = argv;
  if (!command || !first || !email || !["create", "join"].includes(command)) throw new Error("Usage: service:provision create <workspace-name> <email> | join <workspace-id> <email> [member|viewer]");
  const expectedLength = command === "create" ? 3 : role ? 4 : 3;
  if (argv.length !== expectedLength || !first.trim() || !email.trim()) throw new Error("Provisioning arguments are invalid");
  if (first.length > 200 || email.length > 200) throw new Error("Workspace and email values must not exceed 200 characters");
  const databaseUrl = environment.MIGRATION_DATABASE_URL ?? environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL is required");
  const supabaseUrl = environment.SUPABASE_URL;
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const store = new PgStore(databaseUrl);
  try {
    const { data, error } = command === "create"
      ? await supabase.auth.admin.createUser({ email: email.trim(), email_confirm: true })
      : await supabase.auth.admin.inviteUserByEmail(email.trim());
    if (error || !data.user) throw new Error(error?.message ?? "Failed to create or invite Supabase user");
    const userId = data.user.id;

    const result = command === "create"
      ? await store.provisionAdmin({ workspaceName: first.trim(), userId, actorId: email.trim() })
      : await store.addMember({ workspaceId: first.trim(), userId, actorId: email.trim(), role: role === "viewer" ? "viewer" : "member" });
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
