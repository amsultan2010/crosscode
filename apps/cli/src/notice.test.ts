import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { confirmTerms, FIRST_RUN_NOTICE, noticeStatePath, PRIVACY_URL, TERMS_URL } from "./notice.js";

/**
 * The notice `crosscode start` shows before it sets anything up.
 *
 * Crosscode writes other people's edits into the working tree of whatever checkout it is
 * pointed at, and §9 of the terms disclaims exactly that. A disclaimer belongs where the risk
 * is taken -- so it is printed in the terminal, and it takes a keypress to get past.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function configHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "crosscode-notice-"));
  directories.push(path);
  return path;
}

function recorder() {
  const lines: string[] = [];
  return { lines, report: (line: string) => { lines.push(line); }, text: () => lines.join("\n") };
}

describe("the first-run notice", () => {
  it("appears once on a machine and not twice", async () => {
    const home = await configHome();
    const first = recorder();
    const second = recorder();
    let keypresses = 0;
    const waitForKeypress = async () => { keypresses += 1; return true; };

    expect(await confirmTerms({ kind: "first-run", configHome: home, report: first.report, waitForKeypress })).toBe(true);
    expect(await confirmTerms({ kind: "first-run", configHome: home, report: second.report, waitForKeypress })).toBe(false);

    expect(first.text()).toContain(FIRST_RUN_NOTICE);
    expect(second.lines).toEqual([]);
    expect(keypresses).toBe(1);
    // The flag is per machine, under the user's config directory -- not per checkout, which
    // would reappear with every clone.
    expect(JSON.parse(await readFile(noticeStatePath(home), "utf8"))).toMatchObject({ noticeVersion: expect.any(Number) });
  });

  it("says what Crosscode will do to the working tree, and where the terms are", async () => {
    const home = await configHome();
    const report = recorder();

    await confirmTerms({ kind: "first-run", configHome: home, report: report.report, waitForKeypress: async () => true });

    const text = report.text();
    expect(text).toContain("writes your teammates' uncommitted edits into this working tree");
    expect(text).toContain("no warranty");
    expect(text).toContain(TERMS_URL);
    expect(text).toContain(PRIVACY_URL);
  });

  it("does not continue when nobody accepts, and says how to accept from a script", async () => {
    const home = await configHome();

    await expect(confirmTerms({
      kind: "first-run", configHome: home, report: () => {}, waitForKeypress: async () => false
    })).rejects.toMatchObject({ code: "TERMS_NOT_ACCEPTED", hint: expect.stringContaining("--yes") });

    // Refused means not acknowledged: the next run asks again rather than treating a
    // Ctrl-C as assent.
    let asked = false;
    await confirmTerms({
      kind: "first-run", configHome: home, report: () => {}, waitForKeypress: async () => { asked = true; return true; }
    });
    expect(asked).toBe(true);
  });
});

describe("where the flag file goes", () => {
  // `XDG_CONFIG_HOME=` exported but empty is an ordinary shell environment, and it is not
  // "no XDG_CONFIG_HOME": read with ??, it made the path relative, so the flag was written
  // into whatever directory the user happened to run `crosscode start` from -- a stray file
  // in their repository, and a notice that appeared again in the next checkout.
  it("falls back to the home directory when XDG_CONFIG_HOME is set but empty", () => {
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "";
    try {
      expect(isAbsolute(noticeStatePath())).toBe(true);
      expect(noticeStatePath()).toBe(join(homedir(), ".config", "crosscode", "first-run.json"));
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });
});

describe("--yes", () => {
  it("accepts without a keypress, so CI and scripted installs do not hang", async () => {
    const home = await configHome();
    const report = recorder();
    const refuseToPrompt = async () => { throw new Error("--yes still waited for a keypress"); };

    const shown = await confirmTerms({ kind: "first-run", assumeYes: true, configHome: home, report: report.report, waitForKeypress: refuseToPrompt });

    expect(shown).toBe(true);
    // Still printed. `--yes` is assent given on the command line, not permission to say
    // nothing about what is being agreed to.
    expect(report.text()).toContain(TERMS_URL);
    expect(report.text()).toContain("Accepted with --yes.");
    // And it counts as having seen it: the next run is silent.
    expect(await confirmTerms({ kind: "first-run", configHome: home, report: () => {}, waitForKeypress: refuseToPrompt })).toBe(false);
  });
});

describe("terms that changed", () => {
  it("is shown whatever the flag file says, because the flag is about the notice, not the terms", async () => {
    const home = await configHome();
    await confirmTerms({ kind: "first-run", configHome: home, report: () => {}, waitForKeypress: async () => true });
    const report = recorder();

    const shown = await confirmTerms({ kind: "changed", configHome: home, report: report.report, waitForKeypress: async () => true });

    expect(shown).toBe(true);
    expect(report.text()).toContain("terms have changed");
    expect(report.text()).toContain(TERMS_URL);
  });
});
