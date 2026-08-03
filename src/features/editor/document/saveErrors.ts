/**
 * Marks a save failure whose user-facing notification was already emitted by
 * the persistence owner. AutoSave still treats it as a failure, but skips its
 * generic duplicate toast.
 */
export class AlreadyNotifiedSaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlreadyNotifiedSaveError";
  }
}

export const INLINE_AI_SAVE_BLOCKED_MESSAGE =
  "Resolve the inline-AI preview before saving this document";
