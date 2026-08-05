---
name: Feature request
about: Suggest an idea or improvement for Crosscode
title: ''
labels: enhancement
assignees: ''
---

## Problem

What problem are you trying to solve? Describe the situation as a
developer/agent working across separate checkouts of the same repository.

## Proposed solution

What would you like Crosscode to do? Note which component this affects
(daemon, CLI, MCP server, coordination service) if known.

## Alternatives considered

Any other approaches you considered, and why you didn't go with them.

## Scope check

Before filing, please check [BUILD_INSTRUCTIONS.md](../../BUILD_INSTRUCTIONS.md)
for current scope decisions. In particular:

- The supported product surface is the daemon and MCP server, plus the CLI as
  the daemon's local tool. MCP is the only integration contract, so requests
  for an editor extension will be declined.
- Deterministic checks decide clear cases; AI only reviews ambiguity and never
  becomes the source of truth. Proposals that would make AI authoritative over
  local files are out of scope.

## Additional context

Anything else: examples, prior art in other tools, related issues.
