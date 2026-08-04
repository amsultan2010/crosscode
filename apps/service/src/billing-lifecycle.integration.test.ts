// The Phase 10 lifecycle decisions, exercised against real PostgreSQL rather than against a
// fake store -- because every one of them is a claim about what the database does under a
// plan change, and the interesting half of them ("nothing is deleted") can only be checked
// by looking at rows that are still there afterwards.
import { randomUUID } from "node:crypto";
import { contentHash } from "@crosscode/core";
import type { TransactionCreatedEvent } from "@crosscode/protocol";
import { describe, expect, it } from "vitest";
import { BillingLimitError, PLAN_LIMITS, type SubscriptionState } from "./billing.js";
import { applyStripeWebhookEvent } from "./billing-webhook.js";
import { StoreConflictError, PgStore, type Membership } from "./store.js";
import { stripeWebhookEventSchema } from "./stripe.js";

const databaseUrl = process.env.CROSSCODE_TEST_DATABASE_URL;

function subscription(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    subscriptionId: `sub_${randomUUID()}`, customerId: `cus_${randomUUID()}`, status: "active",
    plan: "pro", interval: "year", seats: 1, cancelAtPeriodEnd: false, currentPeriodEnd: null,
    ...overrides
  };
}

async function ownedWorkspace(store: PgStore): Promise<{ workspaceId: string; memberId: string; userId: string; membership: Membership }> {
  const userId = randomUUID();
  const provisioned = await store.provisionAdmin({
    workspaceName: `test-${randomUUID()}`, userId, actorId: `owner-${randomUUID()}@example.com`
  });
  return { ...provisioned, userId, membership: await store.resolveMembership(userId, provisioned.workspaceId) };
}

function makeEvent(membership: Membership, replicaId: string, id: string, clientSequence: number): TransactionCreatedEvent {
  return {
    id, schemaVersion: 1, workspaceId: membership.workspaceId, replicaId, actorId: membership.actorId,
    type: "transaction.created", clientSequence, createdAt: new Date().toISOString(),
    payload: {
      id, base: { files: [] },
      changes: [{ path: `${id}.txt`, kind: "add", afterContent: "test", afterHash: contentHash("test") }],
      provenance: { source: "filesystem", confidence: "known" },
      safety: { risk: "low", requiresApproval: false }
    }
  };
}

describe.skipIf(!databaseUrl)("billing lifecycle", () => {
  it("keeps existing members when a downgrade takes the workspace below its seat count, and refuses new ones", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const { workspaceId } = await ownedWorkspace(store);
      // One subscription throughout: a plan change moves the existing subscription rather
      // than creating a second one, which is what the service's checkout route does too.
      const state = subscription({ plan: "pro" });
      await store.applySubscriptionState({ workspaceId, state });

      // Pro seats 25; fill past what essential (10) allows.
      for (let index = 0; index < 11; index += 1) {
        await store.addMember({ workspaceId, userId: randomUUID(), actorId: `member-${index}-${randomUUID()}@example.com` });
      }
      expect(await store.countActiveMembers(workspaceId)).toBe(12);

      await store.applySubscriptionState({ workspaceId, state: { ...state, plan: "essential" } });

      // Over the cap and staying that way: nobody is disabled, nobody loses access.
      expect(await store.getWorkspacePlan(workspaceId)).toBe("essential");
      expect(await store.countActiveMembers(workspaceId)).toBe(12);
      // The refusal lands only on the *next* seat.
      await expect(store.addMember({ workspaceId, userId: randomUUID(), actorId: `extra-${randomUUID()}@example.com` }))
        .rejects.toBeInstanceOf(BillingLimitError);
      expect(await store.countActiveMembers(workspaceId)).toBe(12);
    } finally {
      await store.close();
    }
  });

  it("clamps auto-always down to auto-if-clean on downgrade instead of erroring or leaving it set", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const { workspaceId, membership } = await ownedWorkspace(store);
      const state = subscription({ plan: "pro" });
      await store.applySubscriptionState({ workspaceId, state });
      await store.setWorkspaceAutonomyTier(membership, 2);
      expect(await store.getWorkspaceAutonomyTier(workspaceId)).toBe(2);

      // Cancellation lands: free's limits apply, and auto-always is the paid wall.
      await store.applySubscriptionState({ workspaceId, state: { ...state, status: "canceled" } });

      // Falls back rather than failing: the workspace keeps auto-applying clean proposals.
      expect(await store.getWorkspaceAutonomyTier(workspaceId)).toBe(1);
      expect(await store.getWorkspacePlan(workspaceId)).toBe("free");
      // And the wall is real on the way back up: the write path refuses tier 2 on free.
      await expect(store.setWorkspaceAutonomyTier(membership, 2)).rejects.toBeInstanceOf(BillingLimitError);
    } finally {
      await store.close();
    }
  });

  it("holds every paid limit through a payment failure, then falls to free's without deleting anything", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const { workspaceId, membership } = await ownedWorkspace(store);
      const healthy = subscription({ plan: "pro" });
      await store.applySubscriptionState({ workspaceId, state: healthy });
      await store.setWorkspaceAutonomyTier(membership, 2);
      for (let index = 0; index < 9; index += 1) {
        await store.addMember({ workspaceId, userId: randomUUID(), actorId: `member-${index}-${randomUUID()}@example.com` });
      }

      const failing: SubscriptionState = { ...healthy, status: "past_due" };
      const graced = await store.applySubscriptionState({ workspaceId, state: failing });

      // Nothing changes yet. A card that fails mid-task must not cost anyone access.
      expect(graced.plan).toBe("pro");
      expect(graced.gracePeriodEndsAt).not.toBeNull();
      expect(await store.getWorkspaceAutonomyTier(workspaceId)).toBe(2);
      await expect(store.addMember({ workspaceId, userId: randomUUID(), actorId: `during-grace-${randomUUID()}@example.com` }))
        .resolves.toBeDefined();

      // A second failure event must not push the deadline out; the first failure sets it.
      const deadline = graced.gracePeriodEndsAt;
      expect((await store.applySubscriptionState({ workspaceId, state: failing })).gracePeriodEndsAt).toBe(deadline);

      // Move the deadline into the past, as time would.
      await store.pool.query("UPDATE workspaces SET grace_period_ends_at = now() - interval '1 day' WHERE id = $1", [workspaceId]);

      // Enforced from the read, before any sweep has run: free's cap is 5 and there are 11.
      expect(await store.getWorkspacePlan(workspaceId)).toBe("free");
      expect(await store.getWorkspaceAutonomyTier(workspaceId)).toBe(1);
      await expect(store.addMember({ workspaceId, userId: randomUUID(), actorId: `after-grace-${randomUUID()}@example.com` }))
        .rejects.toBeInstanceOf(BillingLimitError);

      const sweptCount = await store.expireBillingGracePeriods();
      expect(sweptCount).toBeGreaterThanOrEqual(1);
      const swept = await store.getWorkspaceBilling(workspaceId);
      expect(swept.plan).toBe("free");
      // Still naming what was being paid for, and still holding every member: an unpaid
      // invoice is not a reason to delete anybody's workspace.
      expect(swept.billingPlan).toBe("pro");
      expect(await store.countActiveMembers(workspaceId)).toBe(11);

      // A successful payment afterwards restores everything, grace period cleared.
      const recovered = await store.applySubscriptionState({ workspaceId, state: healthy });
      expect(recovered.plan).toBe("pro");
      expect(recovered.gracePeriodEndsAt).toBeNull();
    } finally {
      await store.close();
    }
  });

  it("fixes each operation's retention at write time, so a downgrade cannot shorten history already promised", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const { workspaceId, userId, membership } = await ownedWorkspace(store);
      const state = subscription({ plan: "pro" });
      await store.applySubscriptionState({ workspaceId, state });
      const replica = await store.registerReplica(userId, workspaceId, `replica-${randomUUID()}`);
      const underPro = randomUUID();
      await store.appendOperation(membership, makeEvent(membership, replica.replicaId, underPro, 1));

      await store.applySubscriptionState({ workspaceId, state: { ...state, plan: "essential" } });
      const underEssential = randomUUID();
      await store.appendOperation(membership, makeEvent(membership, replica.replicaId, underEssential, 2));

      const stamped = await store.pool.query<{ id: string; retention_days: number }>(
        "SELECT id, retention_days FROM operations WHERE workspace_id = $1 ORDER BY server_sequence", [workspaceId]
      );

      // The row written under pro keeps pro's 90-day promise; only new rows get the
      // shorter window. Shrinking retention stops history being extended, it never
      // retroactively deletes -- and the retention worker prunes on this column.
      expect(stamped.rows.map((row) => row.retention_days))
        .toEqual([PLAN_LIMITS.pro.historyRetentionDays, PLAN_LIMITS.essential.historyRetentionDays]);
      expect(stamped.rows.map((row) => row.id)).toEqual([underPro, underEssential]);
    } finally {
      await store.close();
    }
  });

  it("reassigns who pays when the payer leaves, and cancels nothing", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const { workspaceId, memberId, membership } = await ownedWorkspace(store);
      const second = await store.addMember({ workspaceId, userId: randomUUID(), actorId: `co-owner-${randomUUID()}@example.com`, role: "owner" });
      const state = subscription({ plan: "pro", currentPeriodEnd: "2026-09-01T00:00:00.000Z", cancelAtPeriodEnd: true });
      await store.linkStripeCustomer(workspaceId, state.customerId, memberId);
      await store.applySubscriptionState({ workspaceId, state });
      expect((await store.getWorkspaceBilling(workspaceId)).billingOwnerMemberId).toBe(memberId);

      // The other owner removes the payer.
      const coOwner = await store.resolveMembership(
        (await store.pool.query<{ user_id: string }>("SELECT user_id FROM members WHERE id = $1", [second.memberId])).rows[0]!.user_id,
        workspaceId
      );
      await store.disableMember(coOwner, memberId);

      const after = await store.getWorkspaceBilling(workspaceId);
      // The subscription belongs to the workspace, so it survives its originator intact.
      expect(after.billingOwnerMemberId).toBe(second.memberId);
      expect(after.stripeSubscriptionId).toBe(state.subscriptionId);
      expect(after.plan).toBe("pro");
      expect(after.currentPeriodEnd).toBe("2026-09-01T00:00:00.000Z");
      expect(after.cancelAtPeriodEnd).toBe(true);
      // And a workspace can never be left with nobody who could manage it.
      await expect(store.disableMember(coOwner, second.memberId)).rejects.toBeInstanceOf(StoreConflictError);
      expect(membership.role).toBe("owner");
    } finally {
      await store.close();
    }
  });

  it("processes a webhook once, ignores its redelivery, and retries one that failed halfway", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const first = `evt_${randomUUID()}`;
      const abandoned = `evt_${randomUUID()}`;

      expect(await store.claimBillingEvent(first, "customer.subscription.updated")).toBe(true);
      await store.completeBillingEvent(first, null);
      // Stripe redelivers freely; a completed event must never be applied twice.
      expect(await store.claimBillingEvent(first, "customer.subscription.updated")).toBe(false);

      // Claimed but never completed -- the handler died mid-flight. Stripe's retry has to
      // get through, or the plan change is lost forever.
      expect(await store.claimBillingEvent(abandoned, "invoice.payment_failed")).toBe(true);
      expect(await store.claimBillingEvent(abandoned, "invoice.payment_failed")).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("routes a webhook to the workspace the database says owns the subscription, not the one the body claims", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const mine = await ownedWorkspace(store);
      const theirs = await ownedWorkspace(store);
      const state = subscription({ plan: "pro" });
      await store.applySubscriptionState({ workspaceId: mine.workspaceId, state });
      const provider = {
        getSubscriptionState: async () => ({ ...state, plan: "unlimited" as const })
      } as unknown as Parameters<typeof applyStripeWebhookEvent>[1];

      // A body naming somebody else's workspace alongside a subscription this database has
      // already mapped: the mapping wins, so the claim in the payload buys nothing.
      const outcome = await applyStripeWebhookEvent(store, provider, stripeWebhookEventSchema.parse({
        id: `evt_${randomUUID()}`,
        type: "customer.subscription.updated",
        data: { object: { id: state.subscriptionId, customer: state.customerId, metadata: { workspaceId: theirs.workspaceId } } }
      }));

      expect(outcome).toEqual({ workspaceId: mine.workspaceId, applied: true });
      expect((await store.getWorkspaceBilling(mine.workspaceId)).plan).toBe("unlimited");
      expect((await store.getWorkspaceBilling(theirs.workspaceId)).plan).toBe("free");
    } finally {
      await store.close();
    }
  });

  it("ignores a dead subscription's trailing events once the workspace has bought a new one", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const { workspaceId } = await ownedWorkspace(store);
      const old = subscription({ plan: "pro" });
      await store.applySubscriptionState({ workspaceId, state: old });
      await store.applySubscriptionState({ workspaceId, state: { ...old, status: "canceled" } });

      // They resubscribe: a brand new Stripe subscription against the same customer.
      const fresh = subscription({ plan: "unlimited", customerId: old.customerId });
      await store.applySubscriptionState({ workspaceId, state: fresh });
      expect(await store.getWorkspacePlan(workspaceId)).toBe("unlimited");

      // The old subscription's final invoice event turns up late. Applying it would take
      // away the plan they just paid for.
      await store.applySubscriptionState({ workspaceId, state: { ...old, status: "canceled" } });

      const after = await store.getWorkspaceBilling(workspaceId);
      expect(after.plan).toBe("unlimited");
      expect(after.stripeSubscriptionId).toBe(fresh.subscriptionId);
    } finally {
      await store.close();
    }
  });

  it("applies an out-of-order redelivery as the state Stripe reports now, not as the state it described then", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const { workspaceId } = await ownedWorkspace(store);
      const state = subscription({ plan: "pro" });
      await store.applySubscriptionState({ workspaceId, state });
      await store.applySubscriptionState({ workspaceId, state: { ...state, status: "canceled" } });
      expect(await store.getWorkspacePlan(workspaceId)).toBe("free");

      // An "upgraded to pro" event from before the cancellation arrives late. Because the
      // handler re-reads authoritative state rather than trusting the body, it cannot
      // resurrect the plan.
      const provider = {
        getSubscriptionState: async () => ({ ...state, status: "canceled" as const })
      } as unknown as Parameters<typeof applyStripeWebhookEvent>[1];
      await applyStripeWebhookEvent(store, provider, stripeWebhookEventSchema.parse({
        id: `evt_${randomUUID()}`, type: "customer.subscription.updated",
        data: { object: { id: state.subscriptionId, customer: state.customerId } }
      }));

      expect(await store.getWorkspacePlan(workspaceId)).toBe("free");
    } finally {
      await store.close();
    }
  });
});
