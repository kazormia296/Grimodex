/**
 * Marks a save failure whose user-facing notification was already emitted by
 * the persistence owner. AutoSave still treats it as a failure, but skips its
 * generic duplicate toast.
 */
export class AlreadyNotifiedSaveError extends Error {
  /**
   * `cause` は store が握りつぶした元の error。quarantine の印
   * （WORKSPACE_QUARANTINED）を `useAutoSave` に届けるために渡す。
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AlreadyNotifiedSaveError";
  }
}

export const INLINE_AI_SAVE_BLOCKED_MESSAGE =
  "Resolve the inline-AI preview before saving this document";
