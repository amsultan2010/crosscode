// Thin git plumbing wrapper. Every git call in the spike goes through here so the
// environment is hermetic (no user config, deterministic identity).
import { spawnSync } from "node:child_process";

const ENV = {
  GIT_AUTHOR_NAME: "spike",
  GIT_AUTHOR_EMAIL: "spike@example.com",
  GIT_COMMITTER_NAME: "spike",
  GIT_COMMITTER_EMAIL: "spike@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null"
};

export function raw(dir, args, { input, env } = {}) {
  const r = spawnSync("git", args, {
    cwd: dir,
    input,
    env: { ...process.env, ...ENV, ...env },
    maxBuffer: 1 << 28
  });
  if (r.error) throw r.error;
  return { status: r.status, out: r.stdout ?? Buffer.alloc(0), err: (r.stderr ?? "").toString() };
}

export function git(dir, args, opts) {
  const r = raw(dir, args, opts);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.err}`);
  return r.out;
}

export function gitText(dir, args, opts) {
  return git(dir, args, opts).toString().trim();
}

/** Returns null instead of throwing (used for "does this path exist in the shadow tree?"). */
export function gitTextOrNull(dir, args, opts) {
  const r = raw(dir, args, opts);
  return r.status === 0 ? r.out.toString().trim() : null;
}
