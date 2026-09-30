import type { StateAssertionValue } from "@/features/narrative-extraction/ir/observations/stateAssertion";
import type { StateTrackHypothesis } from "@/features/narrative-extraction/ir/inferences/stateTrack";
import type { StateTransitionHypothesis } from "@/features/narrative-extraction/ir/inferences/stateTransition";
import type {
  StateChangeMagnitude,
  StateEpistemicContext,
} from "@/features/narrative-extraction/ir/inferences/stateSupport";

function valueKey(value: StateAssertionValue | null): string {
  if (!value) return "∅";
  switch (value.kind) {
    case "text":
      return `text:${value.text}`;
    case "enum":
      return `enum:${value.optionRef}`;
    case "entity":
      return `entity:${value.entityLocalId}`;
    case "clear":
      return "clear";
  }
}

function valuesEqual(
  left: StateAssertionValue | null,
  right: StateAssertionValue,
): boolean {
  return valueKey(left) === valueKey(right);
}

function magnitudeForTrack(
  durability: StateTrackHypothesis["payload"]["durability"],
): StateChangeMagnitude {
  if (durability === "major") return "major";
  if (durability === "moderate") return "moderate";
  return "minor";
}

export interface DetectStateTransitionsOptions {
  readonly createId?: () => string;
  readonly epistemic?: StateEpistemicContext;
}

const DEFAULT_EPISTEMIC: StateEpistemicContext = {
  polarity: "affirmed",
  commitment: "story-fact",
  support: "direct",
  narrativeFrame: "primary",
};

/**
 * Detect value changes along each State Track.
 * begins/changes/ends aspects and differing consecutive values become transitions.
 */
export function detectStateTransitions(
  tracks: readonly StateTrackHypothesis[],
  options: DetectStateTransitionsOptions = {},
): readonly StateTransitionHypothesis[] {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const epistemic = options.epistemic ?? DEFAULT_EPISTEMIC;
  const transitions: StateTransitionHypothesis[] = [];

  for (const track of tracks) {
    let previous: StateAssertionValue | null = null;
    for (const point of track.payload.points) {
      const isChangeAspect =
        point.temporalMode !== "timeless" ||
        // holds after a prior value that differs is still a transition
        (previous !== null && !valuesEqual(previous, point.value));

      if (isChangeAspect && !valuesEqual(previous, point.value)) {
        transitions.push({
          transitionId: createId(),
          observationRefs: [point.observationId],
          payload: {
            entityId: track.payload.entityId,
            facetKey: track.payload.facetKey,
            trackId: track.trackId,
            fromValue: previous,
            toValue: point.value,
            magnitude: magnitudeForTrack(track.payload.durability),
            durability: track.payload.durability,
            anchorDocumentRef: point.anchorDocumentRef,
            retrospectiveOnly: point.retrospectiveOnly,
          },
          epistemic: {
            ...epistemic,
            narrativeFrame: point.retrospectiveOnly
              ? "memory"
              : epistemic.narrativeFrame,
          },
        });
      }
      previous = point.value;
    }
  }

  return transitions;
}
