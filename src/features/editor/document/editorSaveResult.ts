/** Result of one editor persistence attempt. */
export interface EditorSaveAttemptResult {
  /** The durable write committed. */
  persisted: boolean;
  /** The saved generation was still current when the write completed. */
  committed: boolean;
}

/**
 * Recovery drafts are safe to discard only after the write committed for the
 * generation that initiated it. A later edit keeps the draft recoverable even
 * though the earlier document version reached durable storage.
 */
export function shouldClearRetainedEditorRecoveryDraft(
  result: EditorSaveAttemptResult,
): boolean {
  return result.persisted && result.committed;
}
