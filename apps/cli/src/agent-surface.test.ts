import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installAgentSurface } from "./agent-surface.js";

/**
 * What `crosscode start` leaves in the checkout for the agent to read. The question these
 * tests exist for is drift: the skill's wording lives in `skills/crosscode/SKILL.md`, the
 * installer ships a generated copy, and for one release the two were different documents --
 * the installed one was missing `conflictId`, the no-polling rule, the binary case, and the
 * DAEMON_UNAVAILABLE fallback, while the README said the repo file was what the agent is told.
 */

const SKILL_SOURCE = new URL("../../../skills/crosscode/SKILL.md", import.meta.url);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function checkout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crosscode-agent-surface-"));
  directories.push(root);
  return root;
}

describe("the installed agent surface", () => {
  it("installs the repository's own skill, byte for byte", async () => {
    const root = await checkout();

    const surface = await installAgentSurface(root);

    expect(surface.skill.changed).toBe(true);
    expect(await readFile(surface.skill.path, "utf8")).toBe(await readFile(SKILL_SOURCE, "utf8"));
  });

  it("writes an AGENTS.md block with the skill's body and none of its frontmatter", async () => {
    const root = await checkout();

    const surface = await installAgentSurface(root);

    expect(surface.agents.path).toBe(join(root, "AGENTS.md"));
    const written = await readFile(surface.agents.path, "utf8");
    expect(written.startsWith("<!-- crosscode:start -->\n# Crosscode\n")).toBe(true);
    expect(written.trimEnd().endsWith("<!-- crosscode:end -->")).toBe(true);
    expect(written).not.toContain("name: crosscode");
    // The parts the inlined copy used to be missing, so this is also the drift assertion for
    // what non-Claude agents are told.
    expect(written).toContain("conflictId");
    expect(written).toContain("Do not call the tools speculatively");
    expect(written).toContain("DAEMON_UNAVAILABLE");
  });

  it("keeps an existing AGENTS.md verbatim and appends the block once", async () => {
    const root = await checkout();
    const path = join(root, "AGENTS.md");
    const user = "# House rules\n\nRun `pnpm test` before you claim anything passes.\n";
    await writeFile(path, user);

    const first = await installAgentSurface(root);
    const afterFirst = await readFile(path, "utf8");
    const second = await installAgentSurface(root);

    expect(first.agents.changed).toBe(true);
    expect(second.agents.changed).toBe(false);
    expect(afterFirst.startsWith(user)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(afterFirst);
    expect(afterFirst.match(/<!-- crosscode:start -->/g)).toHaveLength(1);
  });

  it("replaces only what is between the markers when the block has to be updated", async () => {
    const root = await checkout();
    const path = join(root, "AGENTS.md");
    await writeFile(path, "# House rules\n\n<!-- crosscode:start -->\nstale guidance\n<!-- crosscode:end -->\n\nCall the tests yourself.\n");

    await installAgentSurface(root);

    const written = await readFile(path, "utf8");
    expect(written).not.toContain("stale guidance");
    expect(written.startsWith("# House rules\n\n<!-- crosscode:start -->\n")).toBe(true);
    expect(written.endsWith("<!-- crosscode:end -->\n\nCall the tests yourself.\n")).toBe(true);
  });

  it("installs everything exactly once, so a second start rewrites nothing", async () => {
    const root = await checkout();

    const first = await installAgentSurface(root);
    const bytes = await Promise.all([first.skill.path, first.agents.path].map((path) => readFile(path, "utf8")));
    const second = await installAgentSurface(root);

    expect(first).toMatchObject({ skill: { changed: true }, agents: { changed: true } });
    expect(second).toMatchObject({ skill: { changed: false }, agents: { changed: false } });
    expect(await Promise.all([second.skill.path, second.agents.path].map((path) => readFile(path, "utf8")))).toEqual(bytes);
  });
});
