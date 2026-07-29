/** Shared result for persistence paths that already emitted user feedback. */
export type VersionedSaveOutcome =
  | { persisted: true; version: number }
  | { persisted: false };

export const SAVE_NOT_PERSISTED: VersionedSaveOutcome = {
  persisted: false,
};

export function persistedVersion(version: number): VersionedSaveOutcome {
  return { persisted: true, version };
}
