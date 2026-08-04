import { describe, expect, it } from "vitest";
import { DEFAULT_SUPABASE_CONFIG, resolveSupabaseConfig, SupabaseConfigError } from "./supabase-client.js";

const BLANK = { url: "", anonKey: "" };

describe("Supabase configuration resolution", () => {
  it("needs no environment at all: the quickstart runs against the compiled-in default", () => {
    expect(resolveSupabaseConfig({})).toEqual(DEFAULT_SUPABASE_CONFIG);
  });

  it("ships a usable default, so `crosscode signup` works in a fresh checkout", () => {
    expect(DEFAULT_SUPABASE_CONFIG.url).toMatch(/^https:\/\/.+\.supabase\.co$/);
    expect(DEFAULT_SUPABASE_CONFIG.anonKey).not.toBe("");
  });

  it("lets the environment override the default completely", () => {
    const environment = { SUPABASE_URL: "https://self.supabase.co", SUPABASE_ANON_KEY: "self-hosted-anon-key" };
    expect(resolveSupabaseConfig(environment)).toEqual({ url: "https://self.supabase.co", anonKey: "self-hosted-anon-key" });
  });

  it("takes neither half of the default once the environment is set", () => {
    const resolved = resolveSupabaseConfig({ SUPABASE_URL: "https://self.supabase.co", SUPABASE_ANON_KEY: "self-hosted-anon-key" });
    expect(resolved.url).not.toBe(DEFAULT_SUPABASE_CONFIG.url);
    expect(resolved.anonKey).not.toBe(DEFAULT_SUPABASE_CONFIG.anonKey);
  });

  it("trims surrounding whitespace, so a stray newline from a shell heredoc still works", () => {
    expect(resolveSupabaseConfig({ SUPABASE_URL: " https://self.supabase.co\n", SUPABASE_ANON_KEY: " key \n" }))
      .toEqual({ url: "https://self.supabase.co", anonKey: "key" });
  });

  // Half-configuring is the realistic self-hoster slip. Silently pairing their URL with the
  // hosted project's anon key would fail much later, inside Supabase Auth, saying nothing useful.
  it.each([
    ["SUPABASE_ANON_KEY", { SUPABASE_URL: "https://self.supabase.co" }],
    ["SUPABASE_URL", { SUPABASE_ANON_KEY: "self-hosted-anon-key" }],
    ["SUPABASE_ANON_KEY", { SUPABASE_URL: "https://self.supabase.co", SUPABASE_ANON_KEY: "   " }]
  ])("refuses a half-configured environment and names the missing %s", (missing, environment) => {
    expect(() => resolveSupabaseConfig(environment)).toThrow(SupabaseConfigError);
    try {
      resolveSupabaseConfig(environment);
    } catch (error) {
      expect(error).toBeInstanceOf(SupabaseConfigError);
      const failure = error as SupabaseConfigError;
      expect(failure.code).toBe("SUPABASE_CONFIG_MISSING");
      expect(failure.message).toContain(missing);
      expect(failure.hint).toContain("SUPABASE_URL");
      expect(failure.hint).toContain("SUPABASE_ANON_KEY");
    }
  });

  it("fails with a code and a hint -- not a bare COMMAND_FAILED -- when no default is compiled in", () => {
    try {
      resolveSupabaseConfig({}, BLANK);
      expect.unreachable("expected a SupabaseConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(SupabaseConfigError);
      const failure = error as SupabaseConfigError;
      expect(failure.code).toBe("SUPABASE_CONFIG_MISSING");
      expect(failure.hint).toContain("SUPABASE_URL");
      expect(failure.hint).toContain("SUPABASE_ANON_KEY");
    }
  });

  it("still honours the environment when no default is compiled in", () => {
    const environment = { SUPABASE_URL: "https://self.supabase.co", SUPABASE_ANON_KEY: "self-hosted-anon-key" };
    expect(resolveSupabaseConfig(environment, BLANK)).toEqual({ url: "https://self.supabase.co", anonKey: "self-hosted-anon-key" });
  });

  // The service-role key bypasses RLS; it belongs only to `pnpm service:provision`.
  it("never reads or embeds the service-role key", () => {
    const environment = { SUPABASE_SERVICE_ROLE_KEY: "service-role-must-be-ignored" };
    expect(resolveSupabaseConfig(environment)).toEqual(DEFAULT_SUPABASE_CONFIG);
    expect(JSON.stringify(DEFAULT_SUPABASE_CONFIG)).not.toContain("service_role");
  });
});
