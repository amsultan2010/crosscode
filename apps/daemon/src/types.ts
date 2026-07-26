import type { RemoteOperation } from "../../service/src/index.js";

export type StoredOperation = RemoteOperation & {
  status: "local" | "proposed" | "applying" | "accepted" | "rejected" | "conflicted";
  materializationCheckpoint?: string;
};
