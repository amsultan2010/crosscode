# Privacy: what we can and can't see

Crosscode syncs your edits between checkouts, so your code passes through our
coordination service. This page says exactly what that service can read.

**We can't read your code.** File contents, patches, file paths, content hashes, and the
change intent attached to a transaction are encrypted on your machine before they are sent,
under a key generated on your machine that we never receive. The service stores ciphertext
and relays it. This is not a policy we promise to follow. We do not have the key.

That covers the file payload and nothing else. Coordination metadata still reaches us in
the clear: task titles, claim targets, published intents, handoff notes, and validation
output. Those can contain file paths and descriptions of what you are working on. The
[full list is below](#what-we-can-see).

Encryption is on by default. There is nothing to switch on.

## What that means concretely

If someone dumped our database, subpoenaed us, or an engineer here went looking, they
would get ciphertext for every file payload, and readable rows for the coordination
metadata listed below. We cannot decrypt the payloads for them, for you, or for anyone. If
you lose every copy of your key, we cannot recover your history either. That is the same
fact stated from the other side.

Losing the key costs you the coordination history: past proposals, their diffs, the
descriptions attached to them. It does not cost you any source code. Your repository is an
ordinary Git repository the whole time, on your disk, and it always was.

You can print a recovery code with `crosscode key export` and keep it in your password
manager. We recommend it.

## What we can see

Encryption doesn't hide everything, and it would be dishonest to imply otherwise. In the
clear:

- **Your account email**, and the workspace, device, and project identifiers we use to
  decide who is allowed to sync with whom.
- **Your repository's git remote URL**, for example `github.com/acme/project-name`. We
  key projects on it. If a repository's *name* is itself confidential, self-host.
- **Timestamps and sizes.** When you were active, how many files an edit touched, and
  roughly how large the encrypted payload is. A big change looks like a big change.
- **Whether each file in a change was added, modified, deleted, or renamed**, but not
  which file.
- **Task titles, claim targets, published intents, handoff notes, and validation output.**
  None of these are encrypted yet. They can contain file paths and descriptions of what
  you're working on. The file payload, which is the actual code, is encrypted. We would
  rather say this plainly than let "end-to-end encrypted" imply more than it covers.

We cannot see your file contents, your file paths, your diffs, hashes of your files, or the
change intent recorded with a transaction.

## How long we keep it

Your plan's retention window (`crosscode billing status` shows it) is how long a proposal
stays on our side before it is deleted. That is a deletion schedule, not a privacy control,
because the ciphertext was unreadable to us the whole time it was there. A checkout that has been
offline longer than the window is told to resynchronize rather than handed a partial
history, so it finds out that it missed something instead of silently believing it is
up to date.

## What we never do

- No third-party AI provider ever sees your code. Crosscode's AI reviewer runs on the
  coding agent already on your machine. We store no model provider credentials.
- We don't push to your Git remotes. Nothing in Crosscode does.
- We don't sell or share your data, and there is little to sell: we hold ciphertext.

## Adding a second machine

When you pair a new device, both machines print a short fingerprint like `K4T9-2WQZ-8HMP`.
**Compare them before confirming.** We relay the new device's encryption key, and that
comparison is what proves we relayed the real one instead of substituting our own. It
takes three seconds and it is the one step where being lazy actually costs you something.

## Removing someone from a workspace

Removing a member ends their access immediately, and their devices stop syncing on their
next request. Run `crosscode key rotate` afterwards and everything from that moment on is
unreadable to them.

What rotation cannot do is un-share what they already downloaded. They had a full checkout
of the repository. No product can reach back into a copy someone already has, and we would
rather tell you that than let you believe otherwise.

## If you'd rather not trust us at all

Self-host. Crosscode is MIT-licensed, the coordination service is one Node process, and
self-hosting is free forever with no limits. Then none of this is a question of trust,
because none of your data reaches us.

---

The algorithms, the key exchange, the threat model, and what we gave up to get here are in
the [safety model](/docs/safety.html#end-to-end-encryption).
