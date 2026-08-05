import { describe, expect, it } from "vitest";
import { createAnalytics, type CaptureTransport } from "./analytics.js";

function recorder(): { sent: any[]; transport: CaptureTransport } {
  const sent: any[] = [];
  return { sent, transport: async (payload) => { sent.push(payload); } };
}

describe("product analytics", () => {
  it("is completely inert without a key: nothing constructed, nothing sent", async () => {
    const { sent, transport } = recorder();
    const analytics = createAnalytics({}, transport);
    expect(analytics.enabled).toBe(false);
    analytics.capture("project_created", "user-1");
    await analytics.flush();
    expect(sent).toEqual([]);
  });

  it("captures the event, the distinct id, and the allowlisted properties", async () => {
    const { sent, transport } = recorder();
    const analytics = createAnalytics({ POSTHOG_KEY: "phc_test" }, transport);
    analytics.capture("changes_published", "user-1", { versionCount: 3 });
    await analytics.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      api_key: "phc_test",
      event: "changes_published",
      distinct_id: "user-1"
    });
    expect(sent[0].properties).toMatchObject({ version_count: 3, $lib: "crosscode-service" });
  });

  // The whole point of building properties from an allowlist: a caller cannot widen what
  // leaves the process by passing extra fields, however they got there.
  it("sends nothing beyond the allowlist, even when handed extra fields", async () => {
    const { sent, transport } = recorder();
    const analytics = createAnalytics({ POSTHOG_KEY: "phc_test" }, transport);
    analytics.capture("changes_published", "user-1", {
      versionCount: 1,
      path: "src/secret.ts",
      content: "an API key",
      email: "someone@example.com"
    } as never);
    await analytics.flush();
    expect(Object.keys(sent[0].properties).sort()).toEqual(["$lib", "version_count"]);
    expect(JSON.stringify(sent[0])).not.toContain("secret");
    expect(JSON.stringify(sent[0])).not.toContain("example.com");
  });

  // A PostHog outage must never turn into a failed API request for a user.
  it("swallows a transport failure rather than rejecting", async () => {
    const analytics = createAnalytics({ POSTHOG_KEY: "phc_test" }, async () => {
      throw new Error("posthog is down");
    });
    expect(() => analytics.capture("project_created", "user-1")).not.toThrow();
    await expect(analytics.flush()).resolves.toBeUndefined();
  });
});
