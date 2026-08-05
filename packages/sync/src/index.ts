export {
  SyncEngine,
  SHADOW_REF,
  BACKUP_REF,
  HOT_WINDOW_MS,
  MAX_DEFERRALS,
  PATCH_THRESHOLD_BYTES,
  type ApplyOutcome,
  type ApplyResult,
  type EngineOptions,
  type EngineStats
} from "./engine.js";
export { ShadowTree } from "./shadow.js";
export { isBinary, mergeFile, makePatch, applyPatch } from "./merge.js";
export { isDenied, isSafeRelativePath } from "./paths.js";
export {
  currentBranch,
  hashBlob,
  inProgressOperation,
  readBlob,
  repositoryRoot,
  trackedPaths,
  writeBlob,
  type GitOperation
} from "./git.js";
