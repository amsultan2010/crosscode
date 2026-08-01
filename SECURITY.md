# Security Policy

Crosscode is local-first coordination infrastructure that exchanges Git
transactions between developer/agent checkouts through an authenticated
coordination service. For the detailed threat model, authentication design,
redaction rules, and safety gates, see [docs/security.md](./docs/security.md).
This file only covers how to report a vulnerability.

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
- The actual impact — which trust boundary described in
  [docs/security.md](./docs/security.md) is crossed (e.g. local filesystem
  authority, checkpoint/materialization safety, authenticated HTTP/WebSocket
  access, Supabase JWT verification, excluded-path enforcement)
- Any suggested remediation, if you have one

### Scope

Crosscode is pre-1.0 and does not currently run a hosted/managed coordination
service — deployments run their own Supabase project and service instance.
Reports about a specific self-hosted deployment's configuration (e.g. an
operator exposing the service on a non-loopback interface without TLS) are
still useful, but note that in the report so triage can distinguish
configuration issues from code-level vulnerabilities.

There is no bug bounty program at this time. We still ask that you disclose
responsibly so real issues can be fixed before they're public.
