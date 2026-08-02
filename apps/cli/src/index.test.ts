import { describe, expect, it } from "vitest";
import { runCli } from "./index.js";

describe("crosscode run -- <tool>", () => {
  it("returns the child's exit code on success", async () => {
    const result = await runCli(["run", "--", "node", "-e", "process.exit(0)"]);
    expect(result.exitCode).toBe(0);
  });

  it("passes through a nonzero exit code unchanged", async () => {
    const result = await runCli(["run", "--", "node", "-e", "process.exit(7)"]);
    expect(result.exitCode).toBe(7);
  });

  it("forwards argv exactly as given, including flags that look like CLI options", async () => {
    const result = await runCli([
      "run",
      "--",
      "node",
      "-e",
      "process.exit(process.argv[1] === '--json' && process.argv[2] === '--profile' ? 0 : 1)",
      "--",
      "--json",
      "--profile"
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("rejects when -- is missing or no command follows it", async () => {
    await expect(runCli(["run"])).rejects.toThrow("Usage: crosscode run -- <command> [args]");
    await expect(runCli(["run", "--"])).rejects.toThrow("Usage: crosscode run -- <command> [args]");
  });
});

describe("crosscode -- signup", () => {
  it("rejects when neither email nor password is available and stdin is not a TTY", async () => {
    await expect(runCli(["signup"])).rejects.toThrow("Usage: crosscode -- signup --email <email> --password <password>");
  });
});

describe("crosscode join --invite", () => {
  it("requires `crosscode init` before redeeming an invite", async () => {
    await expect(runCli(["join", "--invite", "SOMECODE"])).rejects.toThrow("Run `crosscode init` before `crosscode join --invite`");
  });
});

describe("crosscode billing status", () => {
  it("rejects when --workspace is missing", async () => {
    await expect(runCli(["billing", "status"])).rejects.toThrow("Usage: crosscode billing status --workspace <workspaceId>");
  });

  it("rejects when neither DATABASE_URL nor MIGRATION_DATABASE_URL is set", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousMigrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.MIGRATION_DATABASE_URL;
    try {
      await expect(runCli(["billing", "status", "--workspace", "workspace-1"])).rejects.toThrow(
        "DATABASE_URL or MIGRATION_DATABASE_URL is required"
      );
    } finally {
      if (previousDatabaseUrl !== undefined) process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousMigrationDatabaseUrl !== undefined) process.env.MIGRATION_DATABASE_URL = previousMigrationDatabaseUrl;
    }
  });
});
