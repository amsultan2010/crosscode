import { describe, expect, it } from "vitest";
import { contentHash, redactPath } from "./index.js";

describe("core safety rules", () => {
  it("detects secret paths", () => {
    expect(redactPath(".env")).toBe(true);
    expect(redactPath("keys/service.pem")).toBe(true);
    expect(redactPath("src/index.ts")).toBe(false);
  });

  // The exact list the README and docs/security.md enumerate. If a category moves, the
  // copy moves with it.
  it.each([
    ".env",
    ".env.local",
    "apps/service/.env.production",
    ".envrc",
    ".npmrc",
    ".netrc",
    ".pgpass",
    ".htpasswd",
    ".pypirc",
    ".git-credentials",
    "home/.aws/credentials",
    ".aws/config",
    ".ssh/known_hosts",
    ".gnupg/secring.gpg",
    ".kube/config",
    "id_ed25519",
    "keys/id_rsa.pub",
    "credentials",
    "config/credentials.yml",
    "secrets/db.txt",
    "aws-credentials.json",
    "db_credentials.yaml",
    "gcp-service-account.json",
    "service-account-key.json",
    "terraform.tfvars",
    "infra/prod.tfvars.json",
    "infra/terraform.tfstate",
    "kubeconfig",
    "kubeconfig.yaml",
    "certs/server.key",
    "certs/bundle.p12",
    "certs/store.jks",
    "vpn/office.ovpn",
    "keys/backup.gpg",
    "keys/release.asc",
    "auth/AuthKey_ABC123.p8"
  ])("never sends %s", (path) => {
    expect(redactPath(path)).toBe(true);
  });

  // A false positive is silent: the file just stops syncing. These are ordinary source
  // files that only look credential-shaped, and they must keep moving.
  it.each([
    "src/keyboard.ts",
    "docs/api-keys-guide.md",
    "lib/secretsanta.js",
    "packages/core/src/index.ts",
    "src/monkeyboard/keys.tsx",
    "docs/environment.md",
    "app/services/account.ts",
    "src/credentialsProvider.ts"
  ])("still syncs %s", (path) => {
    expect(redactPath(path)).toBe(false);
  });

  // Judgement call: a file whose own name is `credentials` stays denied even when it looks
  // like a test. Test fixtures are where checked-in secrets most often hide, and the cost
  // of being wrong is asymmetric -- an unsynced test file is an annoyance, a synced
  // credential is an incident.
  it("keeps denying credentials-named test files", () => {
    expect(redactPath("test/credentials.test.ts")).toBe(true);
  });

  it("hashes content stably and distinguishes different content", () => {
    expect(contentHash("a")).toBe(contentHash("a"));
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
});
