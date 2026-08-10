import type { ChildProcess } from "node:child_process";

/**
 * Keeps the daemon running. It watches a checkout for the length of a working day, and a
 * crash that stays crashed is silent data loss from the user's point of view -- their
 * teammate's edits simply stop arriving, with nothing on screen to say so.
 *
 * Restarts back off, and a process that dies immediately over and over is given up on
 * rather than respawned forever: at that point it is a broken install, not a blip.
 */

export type SupervisorOptions = {
  /** Consecutive failures before giving up. */
  maxRestarts?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  /** A run that lasts this long is treated as healthy, and resets the backoff. */
  healthyAfterMs?: number;
  onEvent?: (event: { type: "start" | "restart" | "gave-up"; restarts: number; detail?: string }) => void;
};

export type Supervisor = {
  readonly restarts: number;
  /** Resolves when the supervisor stops for good: either it was asked to, or it gave up. */
  readonly done: Promise<void>;
  stop(): Promise<void>;
};

export function supervise(spawnChild: () => ChildProcess, options: SupervisorOptions = {}): Supervisor {
  const maxRestarts = options.maxRestarts ?? 10;
  const initialBackoff = options.backoffMs ?? 500;
  const maxBackoff = options.maxBackoffMs ?? 30_000;
  const healthyAfterMs = options.healthyAfterMs ?? 10_000;

  let restarts = 0;
  let backoff = initialBackoff;
  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let finish: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });

  const run = () => {
    if (stopped) return;
    const startedAt = Date.now();
    options.onEvent?.({ type: restarts === 0 ? "start" : "restart", restarts });
    const current = spawnChild();
    child = current;
    let settled = false;
    const ended = (clean: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      if (child === current) child = undefined;
      if (stopped || clean) { finish(); return; }
      if (Date.now() - startedAt >= healthyAfterMs) { restarts = 0; backoff = initialBackoff; }
      if (restarts >= maxRestarts) {
        options.onEvent?.({ type: "gave-up", restarts, detail });
        finish();
        return;
      }
      restarts += 1;
      timer = setTimeout(run, backoff);
      timer.unref();
      backoff = Math.min(backoff * 2, maxBackoff);
    };
    current.once("exit", (code, signal) => ended(code === 0 && !signal, `exit ${code ?? signal}`));
    // A child that never spawned -- a missing or non-executable daemon binary -- emits
    // "error" and no "exit" at all. Waiting only for "exit" left the supervisor holding a
    // process that does not exist: no restart, no "gave up", and nothing on stderr.
    current.once("error", (error) => { current.kill(); ended(false, error.message); });
  };

  run();

  return {
    get restarts() { return restarts; },
    done,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      const current = child;
      if (current && current.exitCode === null) {
        current.kill("SIGTERM");
        await new Promise<void>((exited) => current.once("exit", () => exited()));
      }
      finish();
    }
  };
}
