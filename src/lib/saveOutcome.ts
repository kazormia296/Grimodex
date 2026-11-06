/** Shared result for persistence paths that already emitted user feedback. */
export type VersionedSaveOutcome =
  | { persisted: true; version: number }
  /**
   * `cause` は store が握りつぶした元の error（任意）。呼び出し側が
   * `AlreadyNotifiedSaveError` の cause に渡し、`useAutoSave` が quarantine の
   * 印（WORKSPACE_QUARANTINED）を見分けるのに使う。値は保存・送信しない。
   */
  | { persisted: false; cause?: unknown };

export const SAVE_NOT_PERSISTED: VersionedSaveOutcome = {
  persisted: false,
};

export function persistedVersion(version: number): VersionedSaveOutcome {
  return { persisted: true, version };
}

/** store が元の error を握りつぶすとき、cause として運ぶ失敗の結果。 */
export function notPersistedBecause(cause: unknown): VersionedSaveOutcome {
  return { persisted: false, cause };
}

/** `persisted: false` の結果から cause を取り出す（無ければ undefined）。 */
export function saveOutcomeCause(outcome: VersionedSaveOutcome): unknown {
  return outcome.persisted ? undefined : outcome.cause;
}
