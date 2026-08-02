import { describe, expect, it } from "vitest";
import { normalizeRepoRemote, normalizeRepoRoot, projectNameFrom } from "./projects.js";

describe("normalizeRepoRemote", () => {
  it("collapses every spelling of the same repository onto one key", () => {
    // Contract B's dedup key: these are all the same GitHub repository, reported by
    // different clones (ssh, https, credentialed CI checkout, trailing slash, .git).
    const spellings = [
      "git@github.com:Owner/Repo.git",
      "git@github.com:Owner/Repo",
      "ssh://git@github.com/Owner/Repo.git",
      "ssh://git@github.com:22/Owner/Repo.git",
      "https://github.com/Owner/Repo.git",
      "https://github.com/Owner/Repo",
      "https://github.com/Owner/Repo/",
      "https://github.com/Owner/Repo.git/",
      "https://user@github.com/Owner/Repo.git",
      "https://user:ghp_secrettoken@github.com/Owner/Repo.git",
      "https://GitHub.COM/Owner/Repo.git",
      "git://github.com/Owner/Repo.git",
      "  https://github.com/Owner/Repo.git  "
    ];
    for (const spelling of spellings) {
      expect(normalizeRepoRemote(spelling), spelling).toBe("github.com/Owner/Repo");
    }
  });

  it("lowercases only the host, so case-sensitive repository paths stay distinct", () => {
    expect(normalizeRepoRemote("git@GitHub.com:Owner/Repo.git")).toBe("github.com/Owner/Repo");
    expect(normalizeRepoRemote("git@github.com:owner/repo.git")).toBe("github.com/owner/repo");
    expect(normalizeRepoRemote("git@github.com:Owner/Repo.git"))
      .not.toBe(normalizeRepoRemote("git@github.com:owner/repo.git"));
  });

  it("does not confuse different repositories", () => {
    expect(normalizeRepoRemote("git@github.com:owner/one.git")).not.toBe(normalizeRepoRemote("git@github.com:owner/two.git"));
    expect(normalizeRepoRemote("git@github.com:a/repo.git")).not.toBe(normalizeRepoRemote("git@gitlab.com:a/repo.git"));
  });

  it("strips only a trailing .git, not one embedded in a name", () => {
    expect(normalizeRepoRemote("https://github.com/owner/my.gitignore-tools")).toBe("github.com/owner/my.gitignore-tools");
    expect(normalizeRepoRemote("https://github.com/owner/dot.git.git")).toBe("github.com/owner/dot.git");
  });

  it("handles self-hosted hosts, nested groups, and non-default ports", () => {
    expect(normalizeRepoRemote("git@gitlab.example.com:group/subgroup/repo.git")).toBe("gitlab.example.com/group/subgroup/repo");
    expect(normalizeRepoRemote("ssh://git@gitlab.example.com:2222/group/subgroup/repo.git")).toBe("gitlab.example.com/group/subgroup/repo");
    expect(normalizeRepoRemote("https://dev.azure.com/org/project/_git/repo")).toBe("dev.azure.com/org/project/_git/repo");
  });

  it("keeps filesystem remotes as absolute paths", () => {
    expect(normalizeRepoRemote("/srv/git/repo.git")).toBe("/srv/git/repo");
    expect(normalizeRepoRemote("file:///srv/git/repo.git/")).toBe("/srv/git/repo");
    expect(normalizeRepoRemote("/srv//git///repo.git")).toBe("/srv/git/repo");
  });

  it("returns null for anything unusable", () => {
    expect(normalizeRepoRemote(null)).toBeNull();
    expect(normalizeRepoRemote(undefined)).toBeNull();
    expect(normalizeRepoRemote("")).toBeNull();
    expect(normalizeRepoRemote("   ")).toBeNull();
    expect(normalizeRepoRemote("/")).toBeNull();
    expect(normalizeRepoRemote(".git")).toBeNull();
  });
});

describe("normalizeRepoRoot", () => {
  it("drops trailing and duplicate slashes", () => {
    expect(normalizeRepoRoot("/Users/dev/code/app/")).toBe("/Users/dev/code/app");
    expect(normalizeRepoRoot("/Users/dev/code/app///")).toBe("/Users/dev/code/app");
    expect(normalizeRepoRoot("//Users//dev/app")).toBe("/Users/dev/app");
    expect(normalizeRepoRoot("  /Users/dev/app  ")).toBe("/Users/dev/app");
  });

  it("preserves case, since paths are case-sensitive on the machines that report them", () => {
    expect(normalizeRepoRoot("/Users/Dev/App")).toBe("/Users/Dev/App");
  });

  it("rejects relative paths and blanks, which mean nothing across machines", () => {
    expect(normalizeRepoRoot("code/app")).toBeNull();
    expect(normalizeRepoRoot("./app")).toBeNull();
    expect(normalizeRepoRoot("")).toBeNull();
    expect(normalizeRepoRoot(null)).toBeNull();
  });
});

describe("projectNameFrom", () => {
  it("prefers the last remote segment and falls back to the repo root basename", () => {
    expect(projectNameFrom("github.com/owner/repo", "/Users/dev/checkout")).toBe("repo");
    expect(projectNameFrom(null, "/Users/dev/checkout")).toBe("checkout");
    expect(projectNameFrom(null, null)).toBe("project");
  });
});
