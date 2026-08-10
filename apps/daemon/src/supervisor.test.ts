import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { supervise } from "./supervisor.js";

const node = (script: string) => () => spawn(process.execPath, ["-e", script], { stdio: "ignore" });

describe("supervisor", () => {
  it("restarts a daemon that crashes", async () => {
    let starts = 0;
    const supervisor = supervise(() => { starts += 1; return spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: "ignore" }); }, {
      maxRestarts: 3,
      backoffMs: 10,
      healthyAfterMs: 1_000
    });

    await supervisor.done;

    // One start plus three restarts, then it stops rather than respawning a broken
    // install forever.
    expect(starts).toBe(4);
    expect(supervisor.restarts).toBe(3);
  });

  it("leaves a clean exit alone", async () => {
    let starts = 0;
    const supervisor = supervise(() => { starts += 1; return spawn(process.execPath, ["-e", ""], { stdio: "ignore" }); }, { backoffMs: 10 });

    await supervisor.done;

    expect(starts).toBe(1);
  });

  /**
   * A spawn that never happens -- a missing or non-executable daemon binary -- emits
   * "error" and no "exit" at all. Waiting only for "exit" meant `crosscode-daemon
   * --supervise` sat there forever: no child, no restart, no "gave up", and nothing on
   * stderr to say the install was broken.
   */
  it("gives up instead of waiting forever when the child cannot be spawned", async () => {
    let starts = 0;
    const events: string[] = [];
    const supervisor = supervise(
      () => { starts += 1; return spawn(join(tmpdir(), "crosscode-no-such-daemon-binary"), [], { stdio: "ignore" }); },
      { maxRestarts: 2, backoffMs: 10, healthyAfterMs: 1_000, onEvent: (event) => events.push(event.type) }
    );

    await supervisor.done;

    expect(starts).toBe(3);
    expect(events).toContain("gave-up");
  });

  it("stops the child when it is asked to stop", async () => {
    const supervisor = supervise(node("setInterval(() => {}, 1000)"), { backoffMs: 10 });

    await supervisor.stop();
    await supervisor.done;

    expect(supervisor.restarts).toBe(0);
  });
});
