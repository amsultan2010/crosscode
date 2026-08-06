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

If you're unable to use Security Advisories, email
**security@getcrosscode.dev**. That address reaches the maintainer directly.
Encrypted mail is not currently supported; if you need it, say so in a first
message with no details in it and we'll arrange a channel.

Do not open a public issue or PR that discloses an unpatched vulnerability,
exploit path, or security-sensitive proof of concept.

### What happens next

Crosscode is maintained by one person, so these are honest targets rather than
a staffed SLA. If a deadline slips you will hear that it slipped, not silence.

- **Acknowledgement within 3 business days.** If you haven't heard anything by
  then, assume the mail went astray and ping the other channel.
- **An initial assessment within 10 business days**: whether it reproduces,
  the severity as we see it, and a rough fix timeline.
- **Progress updates at least every 14 days** until it's resolved.
- Fixes ship as fast as the severity warrants. Something that exposes other
  people's file contents gets fixed and deployed the same week; the hosted
  service is deployed continuously, so a service-side fix reaches everyone
  without you doing anything.

### Disclosure

We coordinate disclosure with you.

- Please give us **90 days** from your report before publishing, or until a fix
  is released, whichever comes first. If we need longer we'll ask and explain
  why; if we're unresponsive or the issue is being actively exploited, publish
  A stalled report is not a reason to leave users exposed.
- When a fix ships, we publish a GitHub Security Advisory describing the issue
  and its impact.
- You'll be credited by name or handle in that advisory unless you'd rather not
  be. Tell us which you prefer.

### Safe harbor for good-faith research

If you research in good faith under this policy, we will not pursue or support
any legal action against you, and we will not ask a third party to. Concretely:
we won't bring a claim under computer-misuse or anti-circumvention law, we won't
treat your testing as a breach of [docs/terms.md](./docs/terms.md) or of your
account terms, and we won't terminate your account for it. If a third party
brings a claim about research that stayed within this policy, we'll make clear
that it was authorised.

Good faith means, concretely:

- **Test against your own project, your own account, and your own data.** Do
  not access, modify, or retain another user's file contents, sessions, or
  account. If you stumble into someone else's data, stop, don't save it, and
  tell us what you saw so we can assess the exposure.
- **Don't degrade the service.** No denial of service, no load or stress
  testing against the hosted service, no spam or social engineering of the
  maintainer or of any user, no physical attacks on infrastructure.
- **Use the minimum access needed to demonstrate the issue**, and stop as soon
  as you've proven it. Proving you can read one row is enough; dumping the
  table is not.
- **Report promptly** and keep it private until disclosure is coordinated as
  described above.

This is the same promise [docs/terms.md](./docs/terms.md) §4 makes: good-faith
security research on your own project is welcome and is not a breach of the
terms. Work outside these limits (hitting other users, or degrading the
service) isn't covered, and nothing here waives the rights of any third party,
including our hosting providers.

If you're unsure whether something is in bounds, ask at
security@getcrosscode.dev before you do it. Asking first is always the right
call and never counts against you.

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

Crosscode runs a hosted coordination service at
`https://www.getcrosscode.dev`, which is the default for the CLI and the daemon,
and that service plus the daemon, CLI, and MCP server are in scope. The software
is MIT licensed, so you may run your own instance, but there is no supported
self-hosted deployment. If a report is about your own deployment's
configuration, such as exposing the service on a non-loopback interface without
TLS, say so, so triage can tell configuration issues from code-level
vulnerabilities.

There is no bug bounty program at this time. We still ask that you disclose
responsibly so real issues can be fixed before they're public.
