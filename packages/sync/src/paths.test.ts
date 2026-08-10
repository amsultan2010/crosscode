import { describe, expect, it } from "vitest";
import { isDenied, isSafeRelativePath } from "./paths.js";

describe("what Crosscode refuses to sync", () => {
  it("refuses the files `crosscode start` installs into the checkout", () => {
    // Observed the first time two real checkouts joined one project: the teammate arrived
    // holding three conflicts before typing anything, because each checkout had installed
    // its own copy of these and no two shared an ancestor.
    expect(isDenied(".mcp.json")).toBe(true);
    expect(isDenied(".claude/settings.json")).toBe(true);
    expect(isDenied(".claude/skills/crosscode/SKILL.md")).toBe(true);
  });

  it("still syncs the rest of the agent's directory, which is the team's to share", () => {
    expect(isDenied(".claude/skills/deploy/SKILL.md")).toBe(false);
    expect(isDenied(".claude/commands/review.md")).toBe(false);
    expect(isDenied("src/index.ts")).toBe(false);
  });

  it("still refuses secrets, which is what the denylist was for first", () => {
    expect(isDenied(".env")).toBe(true);
    expect(isDenied(".env.local")).toBe(true);
  });

  it("refuses anything that would escape the checkout or touch git's own state", () => {
    expect(isSafeRelativePath("../outside")).toBe(false);
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath(".git/config")).toBe(false);
    expect(isSafeRelativePath("src/a.ts")).toBe(true);
  });

  it("refuses the same escapes spelled with a backslash", () => {
    // The drive-letter check says this path is joined on Windows too, and there `\` is the
    // separator: `..\outside` escapes the checkout exactly as `../outside` does, while
    // `.git\config` reaches git's own state, and neither contains a `/` to split on.
    expect(isSafeRelativePath("..\\outside")).toBe(false);
    expect(isSafeRelativePath("src\\..\\..\\outside")).toBe(false);
    expect(isSafeRelativePath(".git\\config")).toBe(false);
    expect(isSafeRelativePath("src\\a.ts")).toBe(true);
  });
});
