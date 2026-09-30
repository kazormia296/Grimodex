import { hasLoneSurrogate } from "../source/digest";
import type { NarrativeCorpusDocument, Sha256Digest } from "../source/types";
import type { TemporalTimelineRef } from "./timeline";

export type DocumentRef = NarrativeCorpusDocument["ref"];
export type NarrativeEventId = string;
export type ObservationId = string;
export type InferenceId = string;
export type SemanticFingerprint = Sha256Digest;
export type TemporalNodeId = `tn:${string}`;

export interface DiscoursePosition {
  readonly documentRef: DocumentRef;
  readonly documentOrderIndex: number;
  readonly canonicalOffset: number;
}

export type TemporalNodeSubject =
  | {
      readonly kind: "scene";
      readonly documentRef: DocumentRef;
      /** Distinguishes flashbacks or other embedded periods in one Scene. */
      readonly segmentRef?: string;
    }
  | { readonly kind: "event"; readonly eventId: NarrativeEventId }
  | { readonly kind: "state-boundary"; readonly inferenceId: InferenceId }
  | { readonly kind: "phase-boundary"; readonly inferenceId: InferenceId }
  | { readonly kind: "named-period"; readonly label: string };

export interface TemporalNode {
  readonly id: TemporalNodeId;
  readonly timeline: TemporalTimelineRef;
  readonly subject: TemporalNodeSubject;
  readonly shape: "point" | "interval" | "unknown";
  readonly discoursePositions: readonly DiscoursePosition[];
  readonly fingerprint: SemanticFingerprint;
}

export function isTemporalNodeId(value: unknown): value is TemporalNodeId {
  return (
    typeof value === "string" &&
    value.startsWith("tn:") &&
    value.slice(3).trim().length > 0 &&
    !hasLoneSurrogate(value) &&
    !/\p{Cc}/u.test(value)
  );
}

export function isSemanticFingerprint(
  value: unknown,
): value is SemanticFingerprint {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

export function temporalSubjectKey(subject: TemporalNodeSubject): string {
  switch (subject.kind) {
    case "scene":
      return JSON.stringify([
        subject.kind,
        subject.documentRef,
        subject.segmentRef ?? null,
      ]);
    case "event":
      return JSON.stringify([subject.kind, subject.eventId]);
    case "state-boundary":
    case "phase-boundary":
      return JSON.stringify([subject.kind, subject.inferenceId]);
    case "named-period":
      return JSON.stringify([subject.kind, subject.label]);
  }
}
