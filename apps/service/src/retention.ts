import { PgStore, type RetentionSweepResult } from "./store.js";

/**
 * The scheduled half of per-plan history retention. `pnpm service:prune` stays the manual
 * admin tool; this is what makes retention actually happen on a running deployment.
 *
 * It opens its own connection because it must: the request-serving role is deliberately
 * denied DELETE on operations (assertRuntimePrivileges), so the sweep is configured with a
 * privileged URL and is simply off when one is not supplied.
 */
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

export type RetentionSweep = { stop: () => Promise<void> };

export type RetentionSweepOptions = {
  /** A role with DELETE on operations -- not the service's least-privilege runtime role. */
  databaseUrl: string;
  intervalMs?: number;
  onSwept?: (results: readonly RetentionSweepResult[]) => void;
  onError?: (error: unknown) => void;
};

export function startRetentionSweep(options: RetentionSweepOptions): RetentionSweep {
  const store = new PgStore(options.databaseUrl);
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  // One sweep at a time. A sweep that outruns its interval (a large backlog on its first
  // run, say) must not have a second one pile up behind it competing for the same row locks.
  let inFlight: Promise<void> = Promise.resolve();
  let running = false;
  let stopped = false;

  const sweep = (): void => {
    if (running || stopped) return;
    running = true;
    inFlight = store.pruneOperationsByRetention()
      .then((results) => {
        options.onSwept?.(results.filter((result) => result.deleted > 0));
      })
      .catch((error: unknown) => {
        // A failed sweep is a cost problem, never a correctness one: nothing was deleted,
        // so no cursor was invalidated. Report it and let the next tick try again.
        options.onError?.(error);
      })
      .finally(() => { running = false; });
  };

  const timer = setInterval(sweep, intervalMs);
  // Retention must never be the reason the process stays alive.
  timer.unref();
  sweep();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      await store.close();
    }
  };
}
