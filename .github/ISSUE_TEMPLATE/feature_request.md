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

Before filing, please check [PLAN.md](../../PLAN.md), which is the single source
of truth for scope. In particular:

- The supported surface is the daemon and MCP server, plus the CLI as the
  daemon's local tool. MCP is the only integration contract, so requests for an
  editor extension, a web app, or a TUI will be declined.
- The hard limits are five CLI commands, four MCP tools, and one skill. A
  request that adds to any of those has to argue why it belongs in the product
  rather than in your own agent.
- Crosscode delivers information and never judges a change. Requests that make
  it classify risk, review code, or resolve a conflict on its own are out of
  scope; that work belongs to the coding agent already on your machine.

## Additional context

Anything else: examples, prior art in other tools, related issues.
