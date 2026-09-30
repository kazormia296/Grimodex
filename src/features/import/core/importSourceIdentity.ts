export interface ImportSourceIdentityHints {
  readonly adapterId?: string;
  readonly adapterVersion?: string;
  readonly originalFormat?: string;
  readonly titleHint?: string;
  readonly languageHint?: string;
}

export interface ImportSourceIdentity {
  /** Stable id for a logical source set (reimport baseline key). */
  readonly sourceSetId: string;
  /** Content fingerprint from the upstream producer when available. */
  readonly fingerprint: string;
  readonly hints: ImportSourceIdentityHints;
}
