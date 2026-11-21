import type { CodexEntryPhase } from "@/db/schema";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { compareInstantValues } from "@/lib/time";
import {
  isAutoStoryReady,
  type PhaseResolutionMode,
  type ResolutionAxis,
  type SceneTimeIndex,
  type TemporalAnchor,
} from "./sceneTimeIndex";

export type PhaseFallbackReason =
  | "auto-incomplete-story-coverage"
  | "story-current-unresolved"
  | "story-anchor-unresolved"
  | "current-scene-missing"
  | "phase-target-missing"
  | "phase-anchor-missing";

export interface ApplicablePhaseResolution {
  /** All valid phases in the same deterministic order used for cutoff. */
  orderedPhases: CodexEntryPhase[];
  applicablePhases: CodexEntryPhase[];
  skippedPhaseIds: string[];
  axisUsed: ResolutionAxis | null;
  fallbackReason: PhaseFallbackReason | null;
}

export interface ResolveApplicablePhasesInput {
  phases: CodexEntryPhase[];
  index: SceneTimeIndex;
  mode: PhaseResolutionMode;
  anchor: TemporalAnchor;
}

export type PhaseOverrideField =
  | "summaryOverride"
  | "contentOverride"
  | "contextModeOverride";

/**
 * Return the Phase that owns the effective value for one cumulative override
 * field. A later applicable Phase with null inherits the previous value.
 */
export function findEffectiveOverridePhase(
  resolution: ApplicablePhaseResolution,
  field: PhaseOverrideField,
): CodexEntryPhase | null {
  return (
    [...resolution.applicablePhases]
      .reverse()
      .find((phase) => phase[field] !== null) ?? null
  );
}

export interface PhaseEditState {
  /** Phase that owns a new edit, even when the displayed value is inherited. */
  targetPhase: CodexEntryPhase | null;
  summary: string | null;
  content: string;
}

/** Resolve inherited display values separately from the active write target. */
export function resolvePhaseEditState(
  resolution: ApplicablePhaseResolution,
  base: { summary: string | null; content: string },
): PhaseEditState {
  return {
    targetPhase: resolution.applicablePhases.at(-1) ?? null,
    summary:
      findEffectiveOverridePhase(resolution, "summaryOverride")
        ?.summaryOverride ?? base.summary,
    content:
      findEffectiveOverridePhase(resolution, "contentOverride")
        ?.contentOverride ?? base.content,
  };
}

interface RankedPhase {
  phase: CodexEntryPhase;
  readingOrder: number;
  storyOrder: string | null;
}

function comparePhaseIdentity(a: CodexEntryPhase, b: CodexEntryPhase): number {
  return (
    compareInstantValues(a.createdAt, b.createdAt) || a.id.localeCompare(b.id)
  );
}

function compareRankedPhases(
  a: RankedPhase,
  b: RankedPhase,
  axis: ResolutionAxis,
): number {
  if (axis === "story") {
    const storyDiff = cmpKeys(a.storyOrder!, b.storyOrder!);
    if (storyDiff !== 0) return storyDiff;
  }
  return (
    a.readingOrder - b.readingOrder || comparePhaseIdentity(a.phase, b.phase)
  );
}

function validRankedPhases(
  phases: CodexEntryPhase[],
  index: SceneTimeIndex,
): { ranked: RankedPhase[]; skippedPhaseIds: string[] } {
  const ranked: RankedPhase[] = [];
  const skippedPhaseIds: string[] = [];
  for (const phase of phases) {
    const sceneId = phase.anchorNodeId;
    const readingOrder =
      sceneId === null ? undefined : index.readingOrder.get(sceneId);
    if (sceneId === null || readingOrder === undefined) {
      skippedPhaseIds.push(phase.id);
      continue;
    }
    ranked.push({
      phase,
      readingOrder,
      storyOrder: index.inheritedStoryOrder.get(sceneId) ?? null,
    });
  }
  return { ranked, skippedPhaseIds };
}

function storyOrderForMode(
  mode: PhaseResolutionMode,
  index: SceneTimeIndex,
): Map<string, string> {
  return mode === "auto" ? index.explicitStoryOrder : index.inheritedStoryOrder;
}

export function resolveApplicablePhases({
  phases,
  index,
  mode,
  anchor,
}: ResolveApplicablePhasesInput): ApplicablePhaseResolution {
  const { ranked, skippedPhaseIds } = validRankedPhases(phases, index);

  if (anchor.kind === "base") {
    return {
      orderedPhases: [],
      applicablePhases: [],
      skippedPhaseIds,
      axisUsed: null,
      fallbackReason: null,
    };
  }

  const targetPhase =
    anchor.kind === "phase"
      ? (phases.find((phase) => phase.id === anchor.phaseId) ?? null)
      : null;
  if (anchor.kind === "phase" && targetPhase === null) {
    return {
      orderedPhases: [],
      applicablePhases: [],
      skippedPhaseIds,
      axisUsed: null,
      fallbackReason: "phase-target-missing",
    };
  }

  const anchorSceneId =
    anchor.kind === "scene"
      ? anchor.sceneId
      : anchor.kind === "phase"
        ? targetPhase!.anchorNodeId
        : null;

  let currentReadingOrder: number | null = null;
  if (anchor.kind === "scene" || anchor.kind === "phase") {
    currentReadingOrder =
      anchorSceneId === null
        ? null
        : (index.readingOrder.get(anchorSceneId) ?? null);
    if (currentReadingOrder === null) {
      return {
        orderedPhases: [],
        applicablePhases: [],
        skippedPhaseIds,
        axisUsed: null,
        fallbackReason:
          anchor.kind === "phase"
            ? "phase-anchor-missing"
            : "current-scene-missing",
      };
    }
  }

  let axisUsed: ResolutionAxis = "reading";
  let fallbackReason: PhaseFallbackReason | null = null;

  if (mode === "auto") {
    if (isAutoStoryReady(index)) {
      axisUsed = "story";
    } else {
      fallbackReason = "auto-incomplete-story-coverage";
    }
  } else if (mode === "story") {
    const currentStoryUnresolved =
      anchorSceneId !== null && !index.inheritedStoryOrder.has(anchorSceneId);
    if (currentStoryUnresolved) {
      fallbackReason = "story-current-unresolved";
    } else if (
      ranked.some(
        ({ phase }) =>
          !index.inheritedStoryOrder.has(phase.anchorNodeId as string),
      )
    ) {
      fallbackReason = "story-anchor-unresolved";
    } else {
      axisUsed = "story";
    }
  }

  const storyOrder = storyOrderForMode(mode, index);
  const rankedOnAxis = ranked.map((item) => ({
    ...item,
    storyOrder:
      axisUsed === "story"
        ? (storyOrder.get(item.phase.anchorNodeId as string) ?? null)
        : null,
  }));

  rankedOnAxis.sort((a, b) => compareRankedPhases(a, b, axisUsed));

  let applicable = rankedOnAxis.filter((item) => {
    if (anchor.kind === "latest") return true;
    if (axisUsed === "reading") {
      return item.readingOrder <= currentReadingOrder!;
    }

    const currentStoryOrder = storyOrder.get(anchorSceneId!);
    if (currentStoryOrder === undefined || item.storyOrder === null)
      return false;
    const storyDiff = cmpKeys(item.storyOrder, currentStoryOrder);
    return (
      storyDiff < 0 ||
      (storyDiff === 0 && item.readingOrder <= currentReadingOrder!)
    );
  });

  // A scene anchor intentionally includes every Phase at that scene. An
  // explicit Phase preview is narrower: it represents the state immediately
  // after that exact Phase. Slice the already deterministic order so a later
  // same-anchor sibling (createdAt, then id) cannot leak into the preview.
  if (anchor.kind === "phase") {
    const cutoffIndex = applicable.findIndex(
      (item) => item.phase.id === anchor.phaseId,
    );
    applicable = cutoffIndex < 0 ? [] : applicable.slice(0, cutoffIndex + 1);
  }

  return {
    orderedPhases: rankedOnAxis.map(({ phase }) => phase),
    applicablePhases: applicable.map(({ phase }) => phase),
    skippedPhaseIds,
    axisUsed,
    fallbackReason,
  };
}
