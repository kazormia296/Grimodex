/**
 * A consumer's (application/pipeline) bookmark into a project's Narrative
 * Maintenance change feed. Consumers advance the canonical-sequence cursor only
 * after they have durably applied everything up to and including it.
 */
export interface NarrativeChangeCursor {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly consumerId: string;
  readonly acknowledgedThroughCanonicalSequence: number;
  readonly updatedAt: string;
}
