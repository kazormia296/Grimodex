import type { PlotPhaseType } from "@/db/schema";
import type { NarrativeEntityId } from "./codexEntityHypothesis";
import type { StateAssertionValue } from "../observations/stateAssertion";
import type {
  DocumentRef,
  InferenceId,
  ObservationId,
} from "../../temporal/nodes";
import type { ThreadAdvancement } from "./threadDevelopment";

export type PlotThreadId = `plot-thread:${string}`;

export interface GoalPursuitThreadCore {
  readonly kind: "goal-pursuit";
  readonly owners: readonly NarrativeEntityId[];
  readonly proposition: string;
  readonly targetEntityIds: readonly NarrativeEntityId[];
  readonly successCondition: string | null;
  readonly failureCondition: string | null;
}

export interface ConflictThreadCore {
  readonly kind: "conflict";
  readonly sides: readonly {
    readonly entityIds: readonly NarrativeEntityId[];
    readonly position: string;
  }[];
  readonly contestedProposition: string;
  readonly stakes: string | null;
}

export interface OpenQuestionThreadCore {
  readonly kind: "open-question";
  readonly question: string;
  readonly relatedEntityIds: readonly NarrativeEntityId[];
  readonly answerCondition: string | null;
}

export interface RelationshipArcThreadCore {
  readonly kind: "relationship-arc";
  readonly participants: readonly [
    NarrativeEntityId,
    NarrativeEntityId,
    ...NarrativeEntityId[],
  ];
  readonly dimension:
    | "trust"
    | "affection"
    | "rivalry"
    | "loyalty"
    | "dependence"
    | "authority"
    | "other";
  readonly initialState: string | null;
  readonly transformationQuestion: string;
}

export interface CharacterArcThreadCore {
  readonly kind: "character-arc";
  readonly entityId: NarrativeEntityId;
  readonly transformationAxis: string;
  readonly initialState: StateAssertionValue | null;
  readonly possibleTerminalState: StateAssertionValue | null;
}

export interface ProcessThreadCore {
  readonly kind: "process";
  readonly subject: string;
  readonly processType:
    | "war"
    | "investigation"
    | "conspiracy"
    | "political-change"
    | "journey"
    | "construction"
    | "collapse"
    | "other";
  readonly expectedEndpoint: string | null;
}

export interface CompositeThreadCore {
  readonly kind: "composite";
  readonly components: readonly Exclude<PlotThreadCore, CompositeThreadCore>[];
  readonly unifyingConcern: string;
}

export type PlotThreadCore =
  | GoalPursuitThreadCore
  | ConflictThreadCore
  | OpenQuestionThreadCore
  | RelationshipArcThreadCore
  | CharacterArcThreadCore
  | ProcessThreadCore
  | CompositeThreadCore;

export type PlotThreadExistingResolution =
  | { readonly status: "none" }
  | {
      readonly status: "resolved";
      readonly ref: `PT${string}`;
      readonly method:
        | "application-provenance"
        | "core-and-marker-overlap"
        | "user-confirmed";
    }
  | {
      readonly status: "ambiguous";
      readonly candidates: readonly {
        readonly ref: `PT${string}`;
        readonly score: number;
        readonly reasons: readonly string[];
      }[];
    };

export interface PlotThreadMarkerCandidate {
  readonly documentRef: DocumentRef;
  readonly developmentInferenceIds: readonly [InferenceId, ...InferenceId[]];
  readonly primaryPhase: PlotPhaseType;
  readonly secondaryPhase: PlotPhaseType | null;
  readonly noteSuggestion: string | null;
  readonly roleSupport: readonly {
    readonly reason:
      | "first-reader-establishment"
      | "incremental-progress"
      | "new-obstacle"
      | "stakes-escalation"
      | "goal-redirection"
      | "decisive-revelation"
      | "decisive-confrontation"
      | "stable-closure";
    readonly sourceIds: readonly (ObservationId | InferenceId)[];
  }[];
  readonly evidenceAnchorIds: readonly [string, ...string[]];
}

export interface PlotThreadHypothesisPayload {
  readonly threadId: PlotThreadId;
  readonly core: PlotThreadCore;
  readonly nameSuggestion: string;
  readonly descriptionSuggestion: string;
  readonly prominence: "primary" | "supporting" | "minor";
  readonly participantEntityIds: readonly NarrativeEntityId[];
  readonly developmentInferenceIds: readonly [InferenceId, ...InferenceId[]];
  readonly markerCandidates: readonly PlotThreadMarkerCandidate[];
  readonly lifecycle:
    | "open"
    | "resolved"
    | "reopened"
    | "scope-incomplete"
    | "unknown";
  readonly coverage: "complete" | "partial";
  readonly existingResolution: PlotThreadExistingResolution;
  readonly scopeEntry:
    | "introduced-in-scope"
    | "preexisting-before-scope"
    | "unknown";
}

export type { ThreadAdvancement };
