# Security Policy

Crosscode syncs uncommitted working-tree files between developer and agent
checkouts through an authenticated coordination service. There is no end-to-end
encryption: the service can read the files it relays, which
[docs/privacy.md](./docs/privacy.md) states plainly. For the detailed threat
model, authentication design, redaction rules, and safety gates, see
[docs/security.md](./docs/security.md). This file only covers how to report a
vulnerability.

## Reporting a vulnerability

If you believe you've found a security vulnerability in Crosscode, please
report it privately rather than opening a public issue or PR.

Preferred: open a private
[GitHub Security Advisory](../../security/advisories/new) for this
repository. This lets maintainers triage and coordinate a fix before any
details become public.

If you're unable to use Security Advisories, open a confidential GitHub issue
or contact the maintainers directly instead of filing a public issue.

Do not open a public issue or PR that discloses an unpatched vulnerability,
exploit path, or security-sensitive proof of concept.

### What to include

To help us reproduce and fix the issue quickly, include:

- The affected component (daemon, CLI, MCP server, or coordination service)
  and, if known, the file/function involved
- Steps to reproduce, or a proof of concept
- The impact, meaning which trust boundary described in
  [docs/security.md](./docs/security.md) is crossed: local filesystem
  authority, shadow-ref and apply-rule safety, authenticated HTTP/WebSocket
  access, Supabase JWT verification, or denylist and excluded-path enforcement
- Any suggested remediation, if you have one

### Scope

Crosscode is pre-1.0. It runs a hosted coordination service at
`https://www.getcrosscode.dev`, which is the default for the CLI and the daemon,
and that service plus the daemon, CLI, and MCP server are in scope. The software
is MIT licensed, so you may run your own instance, but there is no supported
self-hosted deployment. If a report is about your own deployment's
configuration, such as exposing the service on a non-loopback interface without
TLS, say so, so triage can tell configuration issues from code-level
vulnerabilities.

There is no bug bounty program at this time. We still ask that you disclose
responsibly so real issues can be fixed before they're public.
