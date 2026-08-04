---
name: Bug report
about: Report a problem with the daemon, CLI, MCP server, or coordination service
title: ''
labels: bug
assignees: ''
---

## Description

A clear description of what went wrong.

## Component

Which part of Crosscode is affected? (delete the ones that don't apply)

- Daemon (`apps/daemon`)
- CLI (`apps/cli`, `pnpm crosscode -- ...`)
- MCP server (`apps/mcp-server`)
- Coordination service (`apps/service`)
- Docs site (`apps/docs-site`)
- Other / not sure

## Steps to reproduce

1. ...
2. ...
3. ...

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Include exact error messages if any.

## Environment

- OS: (macOS/Linux/Windows, version)
- Node.js version: (`node -v`)
- pnpm version: (`pnpm -v`)
- Crosscode commit/branch:
- Coordination service: self-hosted against Supabase, or `infra/docker-compose.yml` local Postgres?

## Worktree / daemon state (if relevant)

- Output of `pnpm crosscode -- status --json`, if the daemon is running
- Was there a pending checkpoint, unaccepted proposal, or in-progress
  validation at the time?
- Any relevant daemon log output (redact secrets/tokens first)

## Additional context

Anything else that might help: screenshots, logs, related issues.
