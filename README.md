# Crosscode

Functional, local-first coordination primitives for multiple people or coding agents working in separate Git checkouts.

## Run

```bash
pnpm install
pnpm test
pnpm crosscode -- init --json
pnpm daemon
```

With the daemon running, use another terminal:

```bash
pnpm crosscode -- status --json
pnpm crosscode -- task create "Implement checkout API" --path server/routes/checkout --json
pnpm crosscode -- claim path server/routes/checkout --task TASK_ID --json
pnpm crosscode -- checkpoint --message "before integration" --json
pnpm crosscode -- validate --profile fast --json
```

Validation profiles come only from the committed `.crosscode/config.yaml`; commands are never accepted over the daemon API.

The implemented MVP provides runtime-validated protocol contracts; repository discovery; safe hidden checkpoints; change transactions; typed append-only local events and SQLite projections; automatic filesystem and Git-transition observation; a sequenced coordination service; explicit proposal acceptance/rejection; stale-base protection; local task and claim state; validation provenance; a loopback authenticated daemon API; a scriptable HTTP-backed CLI; and a provider-neutral MCP tool mapping.

The VS Code/Cursor extension and external AI semantic-review provider are deliberately deferred. Publishing is intentionally not automated: Crosscode never stages, commits, pushes, or changes a user's branch on its own.
