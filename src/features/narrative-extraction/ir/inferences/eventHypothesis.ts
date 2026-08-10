import type { EventObservationActuality } from "../observations/eventOccurrence";

export type EventHypothesisActuality = Extract<
  EventObservationActuality,
  "actual" | "attempted" | "prevented"
>;

export type EventHypothesisSignificance =
  | "major"
  | "scene-level"
  | "minor"
  | "incidental";

export type EventSynthesisResolution =
  | "single-event"
  | "multiple-events"
  | "reference-to-event"
  | "unresolved";

export interface EventHypothesis {
  readonly hypothesisId: string;
  readonly clusterRef: string;
  readonly observationRefs: readonly string[];
  readonly titleSuggestion: string;
  readonly summary: string;
  readonly actuality: EventHypothesisActuality;
  readonly significance: EventHypothesisSignificance;
  readonly semanticType?: string;
}

export interface RawEventSynthesisResult {
  readonly clusterRef: string;
  readonly resolution: EventSynthesisResolution;
  readonly events: readonly {
    readonly observationRefs: readonly string[];
    readonly titleSuggestion: string;
    readonly summary: string;
    readonly actuality: EventHypothesisActuality;
    readonly significance: EventHypothesisSignificance;
    readonly semanticType?: string;
  }[];
}
