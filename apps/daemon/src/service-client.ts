import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  claimIngestReceiptSchema,
  claimCursorResponseSchema,
  createWorkspaceKeyGrantsRequestSchema,
  isSealedTransaction,
  listWorkspaceKeyRecipientsResponseSchema,
  registerDeviceKeyRequestSchema,
  sealedTransactionCreatedEventSchema,
  workspaceKeyStateResponseSchema,
  handoffCursorResponseSchema,
  handoffIngestReceiptSchema,
  intentCursorResponseSchema,
  intentIngestReceiptSchema,
  operationsResponseSchema,
  OPERATIONS_PROTOCOL_VERSION,
  registerReplicaRequestSchema,
  registerReplicaResponseSchema,
  serviceIngestReceiptSchema,
  setWorkspaceAutonomyRequestSchema,
  taskIngestReceiptSchema,
  taskCursorResponseSchema,
  transactionCreatedEventSchema,
  validationCursorResponseSchema,
  validationIngestReceiptSchema,
  workspaceAutonomyResponseSchema,
  type DaemonConfig,
  type RemoteClaim,
  type RemoteHandoff,
  type RemoteIntent,
  type RemoteTask,
  type RemoteValidation,
  type SealedTransaction
} from "@crosscode/protocol";
import type { LocalOperation } from "./types.js";
import type { ClaimOutboundRecord, HandoffOutboundRecord, IntentOutboundRecord, OutboundRecord, TaskOutboundRecord, ValidationOutboundRecord } from "./state.js";
import type { RemoteCursorTooOld, RemoteSyncTransport } from "./index.js";
import { getSupabaseClient, toStoredSession, type StoredSession } from "./supabase-client.js";
import { MissingEpochKeyError, openTransaction, sealTransaction } from "./sealing.js";
import {
  createDeviceKeyring, createKeyring, currentEpochKey, deviceFingerprint, hasEpochKeys, keyIdFor, rotateKeyring,
  unwrapEpochKey, withEpochKey, wrapEpochKey, type Keyring, type KeyringSource
} from "./workspace-key.js";

type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

export type CoordinationServiceIdentity = Pick<DaemonConfig, "workspaceId" | "actorId"> & { replicaId?: string };

export type CoordinationServiceHooks = {
  onSessionRefreshed?: (session: StoredSession) => Promise<void> | void;
  onReplicaRegistered?: (replicaId: string) => Promise<void> | void;
};

/**
 * identity.replicaId is mutated in place by ensureReplicaRegistered() so callers that
 * hold a reference to the same identity object observe the newly assigned id.
 */
export class CoordinationServiceClient implements RemoteSyncTransport {
  // Exactly one of these is set: a Supabase session (from `crosscode login`) or a
  // `ccw_` workspace token (from `crosscode join --pair`). The workspace token covers the
  // daemon ingest/read surface only and cannot be refreshed, so a 401 on it is terminal.
  private session: StoredSession | undefined;
  private readonly workspaceToken: string | undefined;

  /**
   * How often a device that already holds a key re-checks for grants to install and
   * recipients to grant to. Rotation and pairing both propagate through those two calls,
   * and neither is urgent enough to justify running them on the 1s sync loop. A device
   * that holds *no* key ignores this and checks every sync, because it is blocked.
   */
  private static readonly KEY_POLL_INTERVAL_MS = 60_000;
  private lastKeyPollAt = 0;
  private deviceKeyRegistered = false;
  /**
   * The operation the download cursor is currently parked in front of because this device
   * holds no key for it, plus the epochs it held at that moment and whether a key sync has
   * run since. See list(): the pair is what separates "a grant is in flight" from
   * "this really is unreadable".
   */
  private blocked: { sequence: number; signature: string; polled: boolean } | undefined;
  /** Last known value of the service's encryption latch; see sealingKeyring(). */
  private workspaceEncrypted = false;

  constructor(
    private readonly identity: CoordinationServiceIdentity,
    private readonly service: NonNullable<DaemonConfig["service"]>,
    private readonly hooks: CoordinationServiceHooks = {},
    /**
     * This checkout's workspace keyring. Undefined disables end-to-end encryption for
     * this install entirely (self-hosted deployments, and the in-process test transports
     * that never touch a real service) -- in which case payloads go out in plaintext and
     * an already-encrypted workspace refuses them, which is the intended failure.
     */
    private readonly keys?: KeyringSource
  ) {
    if (!service.session && !service.workspaceToken) {
      throw new Error("Run 'crosscode login' or 'crosscode join --pair <code>' before starting the daemon");
    }
    this.session = service.session;
    this.workspaceToken = service.workspaceToken;
  }

  get replicaId(): string | undefined {
    return this.identity.replicaId;
  }

  /**
   * `repo` tells the service which repository this replica is a checkout of, so it can
   * upsert the matching project (Contract B). It is optional: a daemon started outside a
   * git repository simply registers without one and its replica stays unattributed.
   */
  async ensureReplicaRegistered(name?: string, repo?: { repoRoot?: string | null; repoRemote?: string | null }): Promise<string> {
    if (this.identity.replicaId) return this.identity.replicaId;
    const data = await this.authorizedRequest("/v1/replicas", "POST", registerReplicaRequestSchema.parse({
      name: name ?? defaultReplicaName(),
      repoRoot: repo?.repoRoot ?? undefined,
      repoRemote: repo?.repoRemote ?? undefined,
      // Registered with the replica so there is never a window in which a brand-new
      // device is eligible for grants but has no key on file to receive them.
      devicePublicKey: (await this.deviceKeyring())?.device.publicKey
    }));
    const response = registerReplicaResponseSchema.parse(data);
    this.identity.replicaId = response.replicaId;
    await this.hooks.onReplicaRegistered?.(response.replicaId);
    return response.replicaId;
  }

  /**
   * The credential the live-sync WebSocket subscribes with: a refreshed Supabase access
   * token, or the `ccw_` workspace token when this install was paired rather than logged
   * in. The gateway accepts either, so a paired install gets live sync instead of being
   * left on the polling loop -- it already reaches the same ingest and read surface over
   * HTTP with this exact credential.
   */
  async getValidAccessToken(): Promise<string> {
    if (!this.session) {
      if (this.workspaceToken) return this.workspaceToken;
      throw new Error("Live sync needs a credential; run 'crosscode login' or 'crosscode join --pair <code>'");
    }
    if (isExpiringSoon(this.session.expiresAt)) await this.refreshAccessToken();
    return this.session.accessToken;
  }

  async refreshAccessToken(): Promise<string> {
    if (!this.session) throw new Error("Workspace tokens cannot be refreshed; run 'crosscode join --pair <code>' again");
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: this.session.refreshToken });
    if (error || !data.session) throw new Error(`Supabase session refresh failed: ${error?.message ?? "no session returned"}; run 'crosscode login' again`);
    this.session = toStoredSession(data.session);
    await this.hooks.onSessionRefreshed?.(this.session);
    return this.session.accessToken;
  }

  /**
   * Uploads one transaction, sealed if this checkout holds a workspace key. The seal
   * happens here and nowhere else: everything upstream -- capture, classification,
   * review, materialization -- works on plaintext, and this is the last point before the
   * payload becomes something the coordination service will store.
   */
  async upload(record: OutboundRecord): Promise<LocalOperation> {
    const plain = transactionCreatedEventSchema.parse(record.event);
    const keyring = await this.sealingKeyring();
    const event = keyring
      ? sealedTransactionCreatedEventSchema.parse({
          ...plain,
          type: "transaction.sealed",
          payload: sealTransaction(plain.payload, keyring, { workspaceId: plain.workspaceId, replicaId: plain.replicaId })
        })
      : plain;
    const data = await this.authorizedRequest("/v1/events", "POST", { event });
    const receipt = serviceIngestReceiptSchema.parse(data);
    return {
      id: receipt.operationId,
      workspaceId: this.identity.workspaceId,
      senderReplicaId: this.requireReplicaId(),
      transaction: record.transaction,
      sequence: receipt.serverSequence,
      createdAt: event.createdAt
    };
  }

  /**
   * `unreadable` names the server sequences this device could not open because it holds
   * no key for the epoch that sealed them -- the only legitimate reason for a gap in an
   * otherwise dense cursor. Reporting them keeps the daemon's anti-omission check intact:
   * a gap the transport did not declare is still treated as the service hiding an
   * operation, rather than being quietly tolerated because encryption exists.
   *
   * `protocolVersion` tells the service this client understands the cursor-too-old status.
   * Without it the service answers an unservable cursor with 410 rather than a body an
   * older daemon could misread, so sending it is what opts this daemon into resynchronizing
   * instead of failing.
   */
  async list(after: number): Promise<{ operations: LocalOperation[]; nextCursor: number; unreadable: number[] } | RemoteCursorTooOld> {
    const data = operationsResponseSchema.parse(
      await this.authorizedRequest(`/v1/operations?afterSequence=${after}&protocolVersion=${OPERATIONS_PROTOCOL_VERSION}`, "GET")
    );
    // History this device never downloaded is gone from the service entirely -- a
    // different loss from a sealed operation it cannot open, and handled by the daemon
    // adopting the watermark rather than by declaring a gap.
    if ("status" in data) return { status: data.status, resyncFrom: data.resyncFrom, retentionDays: data.retentionDays };
    const keyring = await this.keys?.get();
    const operations: LocalOperation[] = [];
    const unreadable: number[] = [];
    let cursor = after;
    for (const parsed of data.operations) {
      // Already validated: operationsResponseSchema parsed every entry through
      // remoteOperationSchema. Re-parsing each one here cost a second pass through the
      // sealed/plaintext union, inside the daemon's exclusive lock, on every sync.
      const binding = { workspaceId: parsed.workspaceId, replicaId: parsed.senderReplicaId };
      let transaction = parsed.transaction;
      if (isSealedTransaction(transaction)) {
        const missing = keyring
          ? this.openOrReportMissing(transaction, keyring, binding)
          : { missing: true as const };
        if ("missing" in missing) {
          // Two very different situations reach here. Usually a grant is already on its
          // way -- another device just rotated -- and the right move is to hold the cursor
          // where it is and try again in a second, because advancing past the operation
          // would drop it for good. Only once a key sync has run and left this device with
          // the same keys it already had is the operation actually unreadable, and only
          // then is the gap declared and stepped over.
          const signature = Object.keys(keyring?.epochs ?? {}).sort().join(",");
          if (this.blocked?.sequence === parsed.serverSequence && this.blocked.signature === signature && this.blocked.polled) {
            this.blocked = undefined;
            unreadable.push(parsed.serverSequence);
            cursor = parsed.serverSequence;
            continue;
          }
          this.blocked = { sequence: parsed.serverSequence, signature, polled: false };
          // Seeing an epoch we do not hold is the signal that a grant is probably waiting
          // for us. Force the next key sync rather than waiting out the ordinary poll
          // interval, so a rotation costs the rest of the workspace seconds, not a minute.
          this.lastKeyPollAt = 0;
          break;
        }
        transaction = missing.transaction;
      }
      operations.push({ id: parsed.id, workspaceId: parsed.workspaceId, senderReplicaId: parsed.senderReplicaId, transaction, sequence: parsed.serverSequence, createdAt: parsed.createdAt });
      cursor = parsed.serverSequence;
    }
    if (operations.length + unreadable.length === data.operations.length) cursor = data.nextCursor;
    return { nextCursor: cursor, operations, unreadable };
  }

  /**
   * Opens a sealed transaction, distinguishing "no key for this epoch" from tampering. A
   * failed authentication tag, a path-token mismatch, or a payload that does not parse
   * means the payload was altered in transit or at rest, and must stop the sync rather
   * than be downgraded into "we skipped one".
   */
  private openOrReportMissing(
    sealed: SealedTransaction,
    keyring: Keyring,
    binding: { workspaceId: string; replicaId: string }
  ): { transaction: LocalOperation["transaction"] } | { missing: true } {
    try {
      return { transaction: openTransaction(sealed, keyring, binding) };
    } catch (error) {
      if (error instanceof MissingEpochKeyError) return { missing: true };
      throw error;
    }
  }

  async uploadTask(record: TaskOutboundRecord): Promise<RemoteTask> {
    const data = await this.authorizedRequest("/v1/tasks", "POST", { event: record.event });
    const receipt = taskIngestReceiptSchema.parse(data);
    return {
      eventId: receipt.eventId,
      workspaceId: this.identity.workspaceId,
      senderReplicaId: this.requireReplicaId(),
      task: record.event.payload,
      updatedAt: receipt.updatedAt
    };
  }

  async listTasks(after: string): Promise<{ tasks: RemoteTask[]; nextCursor: string }> {
    const data = taskCursorResponseSchema.parse(await this.authorizedRequest(`/v1/tasks?after=${encodeURIComponent(after)}`, "GET"));
    return { tasks: data.tasks, nextCursor: data.nextCursor };
  }

  async uploadClaim(record: ClaimOutboundRecord): Promise<RemoteClaim> {
    const data = await this.authorizedRequest("/v1/claims", "POST", { event: record.event });
    const receipt = claimIngestReceiptSchema.parse(data);
    return {
      eventId: receipt.eventId,
      workspaceId: this.identity.workspaceId,
      senderReplicaId: this.requireReplicaId(),
      claim: record.event.payload,
      released: record.event.type === "claim.released",
      updatedAt: receipt.updatedAt
    };
  }

  async listClaims(after: string): Promise<{ claims: RemoteClaim[]; nextCursor: string }> {
    const data = claimCursorResponseSchema.parse(await this.authorizedRequest(`/v1/claims?after=${encodeURIComponent(after)}`, "GET"));
    return { claims: data.claims, nextCursor: data.nextCursor };
  }

  async uploadHandoff(record: HandoffOutboundRecord): Promise<RemoteHandoff> {
    const data = await this.authorizedRequest("/v1/handoffs", "POST", { event: record.event });
    const receipt = handoffIngestReceiptSchema.parse(data);
    return {
      eventId: receipt.eventId,
      workspaceId: this.identity.workspaceId,
      senderReplicaId: this.requireReplicaId(),
      handoff: record.event.payload,
      updatedAt: receipt.updatedAt
    };
  }

  async listHandoffs(after: string): Promise<{ handoffs: RemoteHandoff[]; nextCursor: string }> {
    const data = handoffCursorResponseSchema.parse(await this.authorizedRequest(`/v1/handoffs?after=${encodeURIComponent(after)}`, "GET"));
    return { handoffs: data.handoffs, nextCursor: data.nextCursor };
  }

  async uploadIntent(record: IntentOutboundRecord): Promise<RemoteIntent> {
    const data = await this.authorizedRequest("/v1/intents", "POST", { event: record.event });
    const receipt = intentIngestReceiptSchema.parse(data);
    return {
      eventId: receipt.eventId,
      workspaceId: this.identity.workspaceId,
      senderReplicaId: this.requireReplicaId(),
      intent: record.event.payload,
      updatedAt: receipt.updatedAt
    };
  }

  async listIntents(after: string): Promise<{ intents: RemoteIntent[]; nextCursor: string }> {
    const data = intentCursorResponseSchema.parse(await this.authorizedRequest(`/v1/intents?after=${encodeURIComponent(after)}`, "GET"));
    return { intents: data.intents, nextCursor: data.nextCursor };
  }

  async uploadValidation(record: ValidationOutboundRecord): Promise<RemoteValidation> {
    const data = await this.authorizedRequest("/v1/validations", "POST", { event: record.event });
    const receipt = validationIngestReceiptSchema.parse(data);
    return {
      eventId: receipt.eventId,
      workspaceId: this.identity.workspaceId,
      senderReplicaId: this.requireReplicaId(),
      validation: record.event.payload,
      createdAt: receipt.createdAt
    };
  }

  async listValidations(after: string): Promise<{ validations: RemoteValidation[]; nextCursor: string }> {
    const data = validationCursorResponseSchema.parse(await this.authorizedRequest(`/v1/validations?after=${encodeURIComponent(after)}`, "GET"));
    return { validations: data.validations, nextCursor: data.nextCursor };
  }

  async getAutonomyTier(): Promise<0 | 1 | 2> {
    const data = workspaceAutonomyResponseSchema.parse(await this.authorizedRequest("/v1/workspace/autonomy", "GET"));
    return data.tier;
  }

  async setAutonomyTier(tier: 0 | 1 | 2): Promise<0 | 1 | 2> {
    const data = workspaceAutonomyResponseSchema.parse(await this.authorizedRequest("/v1/workspace/autonomy", "PUT", setWorkspaceAutonomyRequestSchema.parse({ tier })));
    return data.tier;
  }

  // -------------------------------------------------------------------------
  // Workspace key distribution (docs/security.md#end-to-end-encryption)
  // -------------------------------------------------------------------------

  /** This device's keyring, creating the device identity (but no epoch key) on first use. */
  private async deviceKeyring(): Promise<Keyring | undefined> {
    if (!this.keys) return undefined;
    const existing = await this.keys.get();
    if (existing?.workspaceId === this.identity.workspaceId) return existing;
    // A keyring belonging to a different workspace means this checkout was re-joined
    // elsewhere; its epoch keys are useless here, and overwriting them is safe only
    // because they are also still in the OS keychain of whoever holds that workspace.
    const created = createDeviceKeyring(this.identity.workspaceId);
    await this.keys.save(created);
    return created;
  }

  /** The keyring to seal with, or undefined when this install does not encrypt at all. */
  private async sealingKeyring(): Promise<Keyring | undefined> {
    if (!this.keys) return undefined;
    const keyring = await this.deviceKeyring();
    if (keyring && hasEpochKeys(keyring)) return keyring;
    throw new Error(
      "This workspace is end-to-end encrypted and this device has not been granted the key yet. " +
      "Run `crosscode pair` on a device that already has it, or `crosscode key import <recovery code>`."
    );
  }

  /**
   * Brings this device's keyring in line with the workspace: installs any epoch keys
   * granted to it, mints the workspace's very first key when nobody holds one yet, and
   * re-grants the epochs it holds to devices a human has already approved.
   *
   * The one thing it will not do is approve a new device. The recipient list comes from
   * the service, so auto-granting to an unapproved entry would let the service invent a
   * replica with a key of its own and be handed the workspace keyring -- which is exactly
   * the property this whole design exists to deny. Approving is `crosscode pair`, where a
   * human compares a fingerprint.
   */
  async syncWorkspaceKeys(): Promise<{ epochs: number; created: boolean; installed: number; granted: number }> {
    if (!this.keys || !this.identity.replicaId) return { epochs: 0, created: false, installed: 0, granted: 0 };
    let keyring = await this.deviceKeyring();
    if (!keyring) return { epochs: 0, created: false, installed: 0, granted: 0 };
    const due = Date.now() - this.lastKeyPollAt >= CoordinationServiceClient.KEY_POLL_INTERVAL_MS;
    if (hasEpochKeys(keyring) && !due) return { epochs: Object.keys(keyring.epochs).length, created: false, installed: 0, granted: 0 };
    this.lastKeyPollAt = Date.now();

    const replicaId = this.identity.replicaId;
    // Publish this device's public key before asking anything else. ensureReplicaRegistered
    // does it for a checkout registering for the first time, but a replica that already
    // existed -- every one that predates encryption, and every restart into a config that
    // already has an id -- never runs that path, and without a key on file it can neither
    // be granted an epoch nor establish the first one.
    if (!this.deviceKeyRegistered) {
      await this.authorizedRequest(
        `/v1/workspace-keys/device?replicaId=${encodeURIComponent(replicaId)}`, "PUT",
        registerDeviceKeyRequestSchema.parse({ publicKey: keyring.device.publicKey })
      );
      this.deviceKeyRegistered = true;
    }
    const state = workspaceKeyStateResponseSchema.parse(
      await this.authorizedRequest(`/v1/workspace-keys/state?replicaId=${encodeURIComponent(replicaId)}`, "GET")
    );
    this.workspaceEncrypted = state.encrypted;

    let installed = 0;
    for (const grant of state.grants) {
      if (keyring.epochs[String(grant.epoch)] !== undefined) continue;
      const key = unwrapEpochKey({ epoch: grant.epoch, wrapped: grant.wrapped, recipient: keyring.device });
      if (keyIdFor(key) !== grant.keyId) throw new Error(`Workspace key grant for epoch ${grant.epoch} does not match its key id`);
      keyring = withEpochKey(keyring, grant.epoch, key);
      installed += 1;
    }

    if (installed) await this.keys.save(keyring);

    // Minting the first key is safe exactly when nobody holds one: there is no key to
    // wait for, so creating one cannot fork the workspace into two unreadable halves.
    // The service arbitrates that "nobody" -- see establishFirstKey().
    let created = false;
    if (!hasEpochKeys(keyring) && state.keyHolders === 0 && !state.encrypted) {
      const minted = await this.establishFirstKey(keyring, replicaId);
      created = minted !== undefined;
      if (minted) keyring = minted;
    }

    const granted = hasEpochKeys(keyring) && !created ? await this.grantHeldEpochs(keyring, replicaId, { onlyApproved: true }) : 0;
    // A key sync has now run. If the cursor is parked in front of an operation and this
    // did not produce the key for it, list() may stop waiting and declare the gap.
    if (this.blocked) this.blocked = { ...this.blocked, polled: true };
    return { epochs: Object.keys(keyring.epochs).length, created, installed, granted };
  }

  /**
   * Mints epoch 0 and publishes it as a grant to this very device. The self-grant is not
   * a backup -- the wrapped copy only opens with a private key that never leaves this
   * machine -- it is how "this device holds a key" becomes a fact other devices can read
   * without anyone publishing the key itself. Without it, `keyHolders` would stay zero
   * for a one-device workspace and the second device would mint a competing epoch 0.
   *
   * Returns undefined when another device won the race, in which case this one keeps its
   * device identity, holds no epoch key, and waits to be granted one.
   */
  private async establishFirstKey(deviceKeyring: Keyring, replicaId: string): Promise<Keyring | undefined> {
    const minted: Keyring = { ...createKeyring(this.identity.workspaceId), device: deviceKeyring.device };
    const current = currentEpochKey(minted);
    const body = createWorkspaceKeyGrantsRequestSchema.parse({
      grants: [{
        epoch: current.epoch, keyId: current.keyId, recipientReplicaId: replicaId,
        recipientPublicKey: minted.device.publicKey,
        wrapped: wrapEpochKey({ epoch: current.epoch, key: current.key, recipientPublicKey: minted.device.publicKey, sender: minted.device })
      }]
    });
    try {
      await this.authorizedRequest(`/v1/workspace-keys/grants?replicaId=${encodeURIComponent(replicaId)}&first=1`, "POST", body);
    } catch (error) {
      if (!(error instanceof ServiceHttpError) || error.status !== 409) throw error;
      // A 409 here should mean another device established the workspace key between our
      // read and our write, in which case the key we minted was never shared and can just
      // be discarded. Confirm that from the service rather than assuming it: the same
      // status also covers "this device registered a different public key", and silently
      // treating that as a lost race would leave the daemon looping without a key and
      // without ever saying why.
      const state = workspaceKeyStateResponseSchema.parse(
        await this.authorizedRequest(`/v1/workspace-keys/state?replicaId=${encodeURIComponent(replicaId)}`, "GET")
      );
      if (state.keyHolders === 0) throw error;
      return undefined;
    }
    await this.keys!.save(minted);
    return minted;
  }

  /**
   * Wraps every epoch this device holds to the recipients that are missing them.
   * `onlyApproved` is what separates the automatic sweep (existing key holders, who were
   * approved by a human once and must keep working across a rotation) from an explicit
   * approval, which names one replica.
   */
  private async grantHeldEpochs(
    keyring: Keyring, senderReplicaId: string,
    filter: { onlyApproved: true } | { replicaId: string }
  ): Promise<number> {
    const { recipients } = listWorkspaceKeyRecipientsResponseSchema.parse(
      await this.authorizedRequest("/v1/workspace-keys/recipients", "GET")
    );
    const targets = recipients.filter((recipient) => "replicaId" in filter
      ? recipient.replicaId === filter.replicaId
      : recipient.replicaId !== senderReplicaId && recipient.epochs.length > 0);
    const grants = targets.flatMap((recipient) => Object.keys(keyring.epochs)
      .map(Number)
      .filter((epoch) => !recipient.epochs.includes(epoch))
      .map((epoch) => {
        const key = Buffer.from(keyring.epochs[String(epoch)]!, "base64url");
        return {
          epoch, keyId: keyIdFor(key), recipientReplicaId: recipient.replicaId, recipientPublicKey: recipient.publicKey,
          wrapped: wrapEpochKey({ epoch, key, recipientPublicKey: recipient.publicKey, sender: keyring.device })
        };
      }));
    if (!grants.length) return 0;
    const body = createWorkspaceKeyGrantsRequestSchema.parse({ grants });
    const data = await this.authorizedRequest(`/v1/workspace-keys/grants?replicaId=${encodeURIComponent(senderReplicaId)}`, "POST", body);
    return (data as { stored?: number }).stored ?? 0;
  }

  /**
   * The human-approved half of pairing: hand one named device every epoch this one holds.
   * Callers must have shown `fingerprint` to the person at the other machine first -- the
   * service relays public keys and could substitute one, and that comparison is the only
   * thing that detects it.
   */
  async approveKeyRecipient(replicaId: string): Promise<{ granted: number; fingerprint: string }> {
    if (!this.keys) throw new Error("Encryption is disabled for this checkout, so there is no workspace key to grant");
    const keyring = await this.sealingKeyring();
    if (!keyring) throw new Error("This device holds no workspace key to grant");
    const { recipients } = listWorkspaceKeyRecipientsResponseSchema.parse(
      await this.authorizedRequest("/v1/workspace-keys/recipients", "GET")
    );
    const recipient = recipients.find((candidate) => candidate.replicaId === replicaId);
    if (!recipient) throw new Error(`Device ${replicaId} has not registered an encryption key with this workspace`);
    const granted = await this.grantHeldEpochs(keyring, this.requireReplicaId(), { replicaId });
    return { granted, fingerprint: deviceFingerprint(recipient.publicKey) };
  }

  /**
   * Starts a new key epoch and hands it to every already-approved device. Everything
   * sealed from here on is unreadable to anyone who held only the old epochs -- which is
   * what to do after removing a member, and is also all rotation can ever achieve: what
   * they already downloaded stays downloaded.
   */
  async rotateWorkspaceKey(): Promise<{ epoch: number; keyId: string; granted: number }> {
    if (!this.keys) throw new Error("Encryption is disabled for this checkout, so there is no workspace key to rotate");
    const keyring = await this.sealingKeyring();
    if (!keyring) throw new Error("This device holds no workspace key to rotate");
    const rotated = rotateKeyring(keyring);
    await this.keys.save(rotated);
    const current = currentEpochKey(rotated);
    const granted = await this.grantHeldEpochs(rotated, this.requireReplicaId(), { onlyApproved: true });
    return { epoch: current.epoch, keyId: current.keyId, granted };
  }

  /** Whether the service has latched this workspace to ciphertext, as of the last key sync. */
  get encrypted(): boolean {
    return this.workspaceEncrypted;
  }

  private requireReplicaId(): string {
    if (!this.identity.replicaId) throw new Error("Replica is not registered yet; call ensureReplicaRegistered() first");
    return this.identity.replicaId;
  }

  private async authorizedRequest(path: string, method: "GET" | "POST" | "PUT", body?: unknown): Promise<unknown> {
    if (!this.session) {
      return request(this.service.url, path, method, this.workspaceToken, body, true, this.identity.workspaceId);
    }
    try {
      return await request(this.service.url, path, method, this.session.accessToken, body, true, this.identity.workspaceId);
    } catch (error) {
      // A 401 is the one failure worth a second attempt, and only after refreshing:
      // the access token is short-lived and rotating it is exactly what fixes it.
      // Anything else -- including a network failure, which request() has already
      // retried internally -- propagates. Re-issuing it here discarded the original
      // error and quietly turned one timed-out upload into four sends.
      if (!(error instanceof ServiceHttpError) || error.status !== 401) throw error;
      await this.refreshAccessToken();
      return request(this.service.url, path, method, this.session!.accessToken, body, true, this.identity.workspaceId);
    }
  }
}

function isExpiringSoon(expiresAt: string, bufferMs = 30_000): boolean {
  return new Date(expiresAt).getTime() - Date.now() <= bufferMs;
}

function defaultReplicaName(): string {
  return `${hostname()}-${randomUUID().slice(0, 6)}`;
}

class ServiceHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function request(url: string, path: string, method: "GET" | "POST" | "PUT", token?: string, body?: unknown, retryNetwork = true, workspaceId?: string): Promise<unknown> {
  let response: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < (retryNetwork ? 2 : 1); attempt += 1) {
    try {
      response = await fetch(new URL(path, url), {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(workspaceId ? { "x-crosscode-workspace-id": workspaceId } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5_000)
      });
      break;
    } catch (error) { lastError = error; }
  }
  if (!response) throw lastError;
  const envelope = await response.json().catch(() => undefined) as Envelope<unknown> | undefined;
  if (!response.ok || !envelope?.ok) throw new ServiceHttpError(response.status, envelope && !envelope.ok ? envelope.error : `Service request failed with status ${response.status}`);
  return envelope.data;
}
