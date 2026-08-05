import { afterEach, describe, expect, it, vi } from "vitest";
import type { SentryEvent } from "../../service/src/observability.js";
import { createDaemonTelemetry, telemetryEnabled } from "./observability.js";

const DSN = "https://publickey@o1.ingest.sentry.io/4501";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("daemon telemetry", () => {
  it("is off by default", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no network call should happen")));
    vi.stubGlobal("fetch", fetchSpy);

    const telemetry = createDaemonTelemetry({});

    expect(telemetryEnabled({})).toBe(false);
    expect(telemetry.enabled).toBe(false);
    telemetry.capture(new Error("watcher died"), "watch");
    await telemetry.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stays off when only a DSN is present, so an inherited DSN cannot switch it on", () => {
    expect(telemetryEnabled({ CROSSCODE_SENTRY_DSN: DSN })).toBe(false);
    expect(createDaemonTelemetry({ CROSSCODE_SENTRY_DSN: DSN }).enabled).toBe(false);
  });

  it("stays off when the opt-in is set without a DSN", () => {
    expect(telemetryEnabled({ CROSSCODE_ERROR_REPORTING: "on" })).toBe(false);
    expect(createDaemonTelemetry({ CROSSCODE_ERROR_REPORTING: "on" }).enabled).toBe(false);
  });

  it("reports only after both the opt-in and the DSN are set, and sends no path or content", async () => {
    const sent: SentryEvent[] = [];
    const telemetry = createDaemonTelemetry(
      { CROSSCODE_ERROR_REPORTING: "on", CROSSCODE_SENTRY_DSN: DSN },
      { version: "0.1.0", transport: async (event) => { sent.push(event); } }
    );

    expect(telemetry.enabled).toBe(true);
    telemetry.capture(new Error("cannot watch /Users/ana/work/acme/src: EMFILE"), "watch");
    await telemetry.flush();

    expect(sent[0]?.exception.values[0]?.value).toBe("cannot watch [path]: EMFILE");
    expect(sent[0]?.tags).toEqual({ route: "watch", method: "DAEMON", release: "0.1.0" });
    expect(sent[0]?.environment).toBe("daemon");
    expect(JSON.stringify(sent[0])).not.toContain("acme");
  });

  it("accepts the opt-in case-insensitively and rejects anything else", () => {
    expect(telemetryEnabled({ CROSSCODE_ERROR_REPORTING: "ON", CROSSCODE_SENTRY_DSN: DSN })).toBe(true);
    expect(telemetryEnabled({ CROSSCODE_ERROR_REPORTING: "true", CROSSCODE_SENTRY_DSN: DSN })).toBe(false);
    expect(telemetryEnabled({ CROSSCODE_ERROR_REPORTING: "off", CROSSCODE_SENTRY_DSN: DSN })).toBe(false);
  });
});
