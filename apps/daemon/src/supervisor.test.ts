import { spawn } from "node:child_process";
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

  it("stops the child when it is asked to stop", async () => {
    const supervisor = supervise(node("setInterval(() => {}, 1000)"), { backoffMs: 10 });

    await supervisor.stop();
    await supervisor.done;

    expect(supervisor.restarts).toBe(0);
  });
});
