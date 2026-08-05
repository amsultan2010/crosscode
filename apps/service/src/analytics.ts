/**
 * Product analytics: how many people actually use Crosscode, and what they do with it.
 *
 * Captured server-side only. The service already observes every meaningful action, so no
 * key ships in the published CLI, no developer machine makes an outbound analytics call,
 * and there is nothing for a user to opt out of because nothing runs on their machine.
 *
 * Three properties, mirroring observability.ts:
 *
 * 1. **No key, no anything.** Without POSTHOG_KEY nothing is constructed and no socket is
 *    opened. Every capture returns immediately.
 * 2. **No content and no personal identifiers.** The distinct id is the Supabase user id,
 *    a UUID. File paths, file content, branch names, repo names, emails and GitHub logins
 *    are never sent. Properties are built from an allowlist, never spread from an object.
 * 3. **Never breaks a request.** Capture is fire-and-forget; a PostHog outage or a slow
 *    response can neither fail nor delay the API call that triggered it.
 *
 * Deliberately no posthog-node dependency: the capture API is one POST of JSON, which is
 * the whole transport below, and the service is bundled for a serverless function where
 * every dependency is cold-start cost.
 */

/** The events worth counting. Adding one is a deliberate act, not a spread of whatever is handy. */
export type AnalyticsEvent =
  /** A person reached the service for the first time. The closest honest measure of "installs". */
  | "user_activated"
  | "project_created"
  | "invite_created"
  | "invite_redeemed"
  /** A checkout started syncing. Counts active machines, and with it active users. */
  | "replica_registered"
  /** A batch of file changes was published. The measure of real use, not just setup. */
  | "changes_published";

export type AnalyticsProperties = {
  /** How many file versions were in the batch. Never which files. */
  versionCount?: number;
  /** Whether the actor was new to the service, so activation is countable without a join. */
  isNewUser?: boolean;
};

export type Analytics = {
  readonly enabled: boolean;
  capture(event: AnalyticsEvent, userId: string, properties?: AnalyticsProperties): void;
  /** Resolves once in-flight captures settle. For tests and for a graceful shutdown. */
  flush(): Promise<void>;
};

export type CaptureTransport = (payload: unknown) => Promise<void>;

const INERT: Analytics = {
  enabled: false,
  capture() {},
  flush: async () => {}
};

export function createAnalytics(
  environment: NodeJS.ProcessEnv = process.env,
  transport?: CaptureTransport
): Analytics {
  const key = environment.POSTHOG_KEY;
  if (!key) return INERT;
  const host = (environment.POSTHOG_HOST ?? "https://us.i.posthog.com").replace(/\/$/, "");
  const send = transport ?? httpTransport(`${host}/i/v0/e/`);
  const inFlight = new Set<Promise<void>>();

  return {
    enabled: true,
    capture(event, userId, properties) {
      const payload = {
        api_key: key,
        event,
        distinct_id: userId,
        properties: {
          // Allowlisted, never spread. Anything not named here cannot reach PostHog.
          ...(properties?.versionCount === undefined ? {} : { version_count: properties.versionCount }),
          ...(properties?.isNewUser === undefined ? {} : { is_new_user: properties.isNewUser }),
          $lib: "crosscode-service"
        },
        timestamp: new Date().toISOString()
      };
      // Swallowed on purpose: analytics must never fail or delay the request that caused it.
      const pending = send(payload).catch(() => {});
      inFlight.add(pending);
      void pending.finally(() => inFlight.delete(pending));
    },
    async flush() {
      await Promise.all([...inFlight]);
    }
  };
}

function httpTransport(url: string): CaptureTransport {
  return async (payload) => {
    // A hung analytics host must not keep a serverless function alive to its timeout.
    const abort = AbortSignal.timeout(3_000);
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: abort
    });
  };
}
