# Spike: does the shadow-ref + 3-way-merge core actually converge?

Throwaway proof for PLAN.md phase 2. **Not product code. Do not merge to main.**

```
node spike/run.mjs           # 15 scenarios, one pass/fail line each
VERBOSE=1 node spike/run.mjs # every individual check
```

Two temp clones of one throwaway repo, two `Replica` objects, an in-process `Bus`.
No network, no service, no websocket, no timers — a virtual clock so the ~10s hot
window is exercised deterministically.

| file | what |
|---|---|
| `git.mjs` | hermetic git plumbing wrapper |
| `replica.mjs` | shadow ref, sync unit, apply rule, hot-file deferral, loop suppression |
| `harness.mjs` | two checkouts, the bus (with offline mode), convergence assertions |
| `scenarios.mjs` | the 9 scenarios + 3 guards |
| `literal-plan.mjs` | counterexamples: PLAN.md's rule implemented *literally* |
| `run.mjs` | entry point |

## Verdict

**The design holds — but PLAN.md's apply rule as written does not.** Rule 1 is wrong
and rule 3 is a dead end. Both are fixable in about five lines, and the fixed rule
converges in every scenario. Detail in "What PLAN.md gets wrong" below.

## Results

| # | scenario | result |
|---|---|---|
| 1 | disjoint files | PASS — converged, 0 conflicts, 2 messages |
| 2 | same file, disjoint hunks | PASS — converged, 0 conflicts, 4 messages |
| 3 | same file, same lines | PASS — exactly 1 conflict, nothing written |
| 4 | delete vs edit | PASS — plain delete silent; delete-vs-edit = 1 conflict |
| 5 | rename | PASS — converged (as delete + add) |
| 5b | rename racing an edit to the old path | PASS as *documented behaviour* — see below |
| 6 | binary file | PASS — one-sided byte-exact, concurrent = 1 conflict |
| 7 | large file, patch threshold | PASS — 189-byte patch for an 80 KB file |
| 8 | offline, then reconnect | PASS — queued, drained, converged, 0 conflicts |
| 9 | rapid interleaved edits (24 edits) | PASS — converged, 0 conflicts, 32 messages |
| G1 | hot-file deferral | PASS — deferred then applied on cooldown |
| G2 | loop suppression | PASS — 1 merge per side, echo suppressed, 4 messages |
| G3 | shadow keeps merge bases alive across `git gc` | PASS |
| C1 | counterexample: literal rule 1 | reproduces **silent data loss** |
| C2 | counterexample: no shadow advance on send | reproduces **infinite rebroadcast** |

The assertions are load-bearing, not decorative — four mutations of `replica.mjs`
each turn scenarios red: dropping the crossing-case base check → 7 fail, dropping
loop suppression → 1 fail, dropping hot-file deferral → 2 fail, dropping conflict
quarantine → 4 fail.

## What PLAN.md gets wrong

### 1. Rule 1 (`L == S` → write it) silently destroys work

The rule never says when the *sender's* shadow advances, and both readings break.

**If the sender advances its shadow on send** (it must — see below), then two people
editing the same file at the same time each end up with `L == S` and an incoming unit
built on the *old* base. Rule 1 fires. Each side overwrites its own edit with the
peer's. `literal-plan.mjs` reproduces it: A and B edit lines 10 and 200 of the same
file, and end up with each other's file, both edits partially gone, **zero conflicts
recorded**. Nobody is told anything.

**If the sender does not advance its shadow on send,** a one-sided edit never stops
being "a local change", so it republishes on every tick forever — 10 messages for 1
edit over 10 ticks in the counterexample.

Rule 1 needs the sender's base checked too:

```
L === S && unit.baseHash === S   → write, silent
```

### 2. Rule 3 handles the wrong direction

"Sender built from something else → catch up, retry" assumes I am *behind* the
sender. The overwhelmingly common case is the opposite: the sender is behind *me*
because our messages crossed. There is nothing to catch up to, so "retry" spins
forever.

The fix is the whole point of the shadow ref and PLAN.md misses it: **resolve the
base by content hash out of git's object store.** The sender's `baseHash` is a blob
we agreed on earlier, so it is still reachable from a shadow commit, and a normal
3-way merge works. Guard G3 proves this survives `git gc --prune=now` — the base of
scenario 2's merge is a blob in no commit but the shadow's. Genuine catch-up is then
only needed when the blob really is missing (peer far ahead, or a pruned repo).

### 3. A conflicted path must be quarantined

PLAN.md says "conflict → surface" and stops there. If the receiver only records the
conflict, its own unpublished edit is still pending — the moment its debounce fires,
the *peer* records the mirror-image conflict, and both agents try to fix the same
collision. Removing the quarantine in this spike turns 4 scenarios red (2 conflicts
where the success criteria demand exactly 1). Requirement: while a path is
conflicted, neither publish nor apply it.

### 4. The sync unit cannot express a delete or a rename

`{ path, baseHash, contentHash, content-or-patch }` has no operation field. This
spike added `op: "modify" | "delete"` with `contentHash: null`; without it a delete
is indistinguishable from an empty file. Renames are worse — see below.

### 5. Binaries are not mentioned at all, and the failure mode is nasty

`git merge-file` **refuses** two binaries: exit 255, `error: Cannot merge binary
files: ours`, and — the dangerous part — **empty stdout**. An implementation that
checks "did it exit non-zero?" survives. One that treats exit code as a conflict
count (which is exactly what it is for text) and writes stdout **truncates the file
to zero bytes**. The rule needs an explicit binary check before merge, and concurrent
binary edits have to be a conflict; there is no third option.

## Surprises

**Rename is the weakest spot.** A rename is two units, delete + add, with no relation
between them. If the peer has an unpublished edit to the old path you get (5b) a
delete-vs-edit conflict on the old path *and* the new path arrives holding the
pre-edit content. The peer's work is not lost, but it is now in a file that has been
renamed out from under it, and the conflict record says nothing about where it went.
Convergence is fine; the human/agent story is bad. Phase 4 should carry a
`renamedFrom` hint so the conflict can say "your edit is on the old path, it moved
to X".

**Delete-vs-edit is not a 3-way merge and never will be.** It is a policy decision
with no correct answer. This spike keeps the edited file and records a conflict —
defensible, because losing an edit is worse than a stale file, but it does mean a
deleted file can come back if resolution is sloppy.

**Loop suppression is mostly free.** Advancing the shadow on send does the work: an
applied write stops looking like a local edit because it *is* the shadow. The
explicit "I already have these bytes" check only matters for the crossing case, where
both sides independently compute the same merge and echo it at each other once
(mutation M2 breaks exactly one scenario). Termination came out at 4 messages for a
two-sided concurrent merge, not the feared ping-pong. `git merge-file` being
deterministic and order-symmetric for disjoint hunks is what makes this work — both
sides compute byte-identical merges from mirrored arguments.

**Hot-file deferral is more dangerous than it looks.** The daemon's own writes must
never mark a file hot or sync deadlocks instantly. In this spike that is the
`edit()` / `writeSynced()` split; in a real daemon it is a watcher event you cannot
distinguish from a user's without bookkeeping. Also: under sustained sub-10s typing
(scenario 9) a file can defer indefinitely. It converged only because the storm ended.

## What Phase 4 should do differently

1. **Ship the corrected apply rule**, not PLAN.md's: base check in case 1, base
   resolution by hash in case 2, catch-up only when the blob is genuinely absent.
2. **Quarantine conflicted paths** until resolved, both directions.
3. **Add `op` to the sync unit**, plus a rename hint.
4. **Binary check before merge**, and never trust `merge-file` stdout without
   checking the exit code range (>127 is refusal, not a conflict count).
5. **Batch shadow updates.** This spike does a `read-tree`/`write-tree`/`commit-tree`
   per file per change — fine for 20 files, absurd for a monorepo. Keep the shadow
   tree in memory, flush on a timer.
6. **Bound the hot-file queue.** Deferral needs a ceiling (retry N times, then force
   with a backup to the shadow) or a fast typist starves sync forever.
7. **Handle a genuinely missing base blob.** The spike returns `catchup` and retries;
   it never fires in these 9 scenarios, so that path is *unproven*. A real
   implementation needs full-content resync there, and it must be tested.
8. **Line endings and no-trailing-newline files.** Not covered here at all;
   `merge-file` is sensitive to both and CRLF repos will generate phantom conflicts.

## Known limits of this spike

- Two replicas only. Three-way convergence (PLAN.md phase 4 wants three daemons) is
  not proven, and the shadow is a single "agreed state" — with N peers it is not
  obvious that one shadow per checkout is enough. **Test this before building it.**
- Delivery is in-order and lossless. Reordering and duplication are untested.
- `syncPaths()` walks the whole checkout instead of honouring "tracked files only".
  The denylist exists but is unexercised.
- No real file watcher, no real timers, no concurrency — a virtual clock and a
  synchronous bus. Nothing here says anything about watcher cost or debounce.
