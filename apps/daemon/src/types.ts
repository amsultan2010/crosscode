import type { ChangeTransaction } from "@crosscode/protocol";

/**
 * An operation as the daemon holds it locally.
 *
 * `sequence` is the daemon's own monotonic position, not the wire protocol's
 * `serverSequence`: it is 0 for work captured locally and not yet acknowledged, and takes
 * the service's value once it has been. `CoordinationServiceClient` translates between
 * this and `@crosscode/protocol`'s `RemoteOperation` at the network edge.
 *
 * Declared here rather than imported from apps/service: the daemon does not depend on the
 * service package (it talks to it over HTTP), and importing the service's in-memory test
 * double's types across an app boundary made the dependency direction a lie.
 */
export type LocalOperation = {
  id: string;
  workspaceId: string;
  senderReplicaId: string;
  transaction: ChangeTransaction;
  sequence: number;
  createdAt: string;
};
