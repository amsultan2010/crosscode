# Crosscode MVP architecture

Each checkout runs a `LocalDaemon`. It observes Git state, captures settled working-tree changes as immutable transactions, writes checkpoint refs under `refs/crosscode/checkpoints/`, and keeps incoming work as a proposal until it is accepted locally.

The coordination service is intentionally a small append-only operation sequencer for the MVP. A transaction is accepted only when the recipient's current content hash matches the sender's base hash. Otherwise it is marked conflicted and no local file is changed. Sensitive paths (`.env`, keys, auth, migrations, lockfiles, and deploy files) are blocked from automatic materialization.

Local metadata is kept below `.git/crosscode/`; it is never added to the repository worktree. Git remains sufficient to restore all source code.
