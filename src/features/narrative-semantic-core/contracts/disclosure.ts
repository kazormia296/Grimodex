import { validateNarrativeScope, type NarrativeScope } from "./scope";
import type {
  ApplicablePhaseResolution,
  PhaseFallbackReason,
} from "@/features/codex/context/resolveApplicablePhases";

export type NarrativePhaseResolutionMode = "reading" | "story" | "auto";
export type NarrativeDisclosureAxis = "reading" | "story";

export interface NarrativeDisclosurePhaseResolution {
  /** These fields are copied from the existing ADR 002 resolver result. */
  readonly axisUsed: ApplicablePhaseResolution["axisUsed"];
  readonly fallbackReason: PhaseFallbackReason | null;
  readonly resolver: "adr-002";
}

export interface NarrativeDisclosureContext {
  readonly projectId: string;
  readonly currentSceneId: string | null;
  readonly phaseResolutionMode: NarrativePhaseResolutionMode;
  readonly phaseResolution: NarrativeDisclosurePhaseResolution;
  readonly temporalAnchor: string | null;
  readonly viewpointRef: string | null;
  readonly knowledgeHolderRef: string | null;
  readonly audienceRef: "reader" | string | null;
  readonly allowSecrets: boolean;
  readonly currentPhase?: number | null;
  readonly currentStoryTime?: number | null;
  readonly currentSceneOrder?: number | null;
  readonly worldlineRef?: string | null;
  readonly timelineRef?: string | null;
  readonly narrativeLayer?: string | null;
}

export interface NarrativeDisclosureCandidate {
  readonly projectId: string;
  /** Scope is mandatory so an omitted axis can never become global truth. */
  readonly scope: NarrativeScope;
  readonly phase?: number | null;
  readonly storyTime?: number | null;
  readonly sceneOrder?: number | null;
  readonly foreshadow?: {
    readonly secret: boolean;
    readonly revealSceneId?: string | null;
    readonly revealSceneOrder?: number | null;
  };
}

export type NarrativeDisclosureRejection =
  | "project-mismatch"
  | "unresolved-scope"
  | "invalid-resolution"
  | "future-phase"
  | "future-story-time"
  | "future-scene"
  | "secret-before-reveal"
  | "knowledge-holder-mismatch"
  | "reader-knowledge-not-character"
  | "audience-mismatch"
  | "scene-scope-mismatch"
  | "viewpoint-mismatch"
  | "worldline-mismatch"
  | "timeline-mismatch"
  | "narrative-layer-mismatch";

export interface NarrativeDisclosureDecision {
  readonly admitted: boolean;
  readonly reasons: readonly NarrativeDisclosureRejection[];
}

function addReason(
  reasons: NarrativeDisclosureRejection[],
  reason: NarrativeDisclosureRejection,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function differs(
  contextValue: string | null | undefined,
  candidateValue: string | null | undefined,
): boolean {
  // An omitted explicit axis is unconstrained; once a candidate asserts an
  // axis, an unknown or different context must not silently match it.
  if (candidateValue === undefined) return false;
  return (contextValue ?? null) !== candidateValue;
}

function isValidPhaseResolution(
  mode: NarrativePhaseResolutionMode,
  resolution: NarrativeDisclosurePhaseResolution,
): boolean {
  if (resolution.resolver !== "adr-002") return false;
  if (mode === "reading") {
    return (
      resolution.axisUsed === "reading" && resolution.fallbackReason === null
    );
  }
  if (mode === "story") {
    return (
      (resolution.axisUsed === "story" && resolution.fallbackReason === null) ||
      (resolution.axisUsed === "reading" &&
        (resolution.fallbackReason === "story-current-unresolved" ||
          resolution.fallbackReason === "story-anchor-unresolved"))
    );
  }
  return (
    (resolution.axisUsed === "story" && resolution.fallbackReason === null) ||
    (resolution.axisUsed === "reading" &&
      resolution.fallbackReason === "auto-incomplete-story-coverage")
  );
}

export function evaluateNarrativeDisclosure(
  context: NarrativeDisclosureContext,
  candidate: NarrativeDisclosureCandidate,
): NarrativeDisclosureDecision {
  const reasons: NarrativeDisclosureRejection[] = [];
  if (candidate.projectId !== context.projectId) {
    addReason(reasons, "project-mismatch");
  }

  const scopeValidation = validateNarrativeScope(candidate.scope);
  const scope: NarrativeScope = candidate.scope ?? {
    scopeStatus: "unresolved",
  };
  if (!scopeValidation.valid || scope.scopeStatus === "unresolved") {
    addReason(reasons, "unresolved-scope");
  }

  const effectiveMode = context.phaseResolution.axisUsed;
  if (
    !isValidPhaseResolution(
      context.phaseResolutionMode,
      context.phaseResolution,
    )
  ) {
    addReason(reasons, "invalid-resolution");
  }

  if (
    candidate.phase !== null &&
    candidate.phase !== undefined &&
    context.currentPhase !== null &&
    context.currentPhase !== undefined &&
    candidate.phase > context.currentPhase
  ) {
    addReason(reasons, "future-phase");
  }
  if (
    candidate.storyTime !== null &&
    candidate.storyTime !== undefined &&
    context.currentStoryTime !== null &&
    context.currentStoryTime !== undefined &&
    candidate.storyTime > context.currentStoryTime
  ) {
    addReason(reasons, "future-story-time");
  }
  if (
    effectiveMode === "reading" &&
    candidate.sceneOrder !== null &&
    candidate.sceneOrder !== undefined &&
    context.currentSceneOrder !== null &&
    context.currentSceneOrder !== undefined &&
    candidate.sceneOrder > context.currentSceneOrder
  ) {
    addReason(reasons, "future-scene");
  }

  const foreshadow = candidate.foreshadow;
  if (foreshadow?.secret) {
    const beforeReveal =
      !context.allowSecrets ||
      foreshadow.revealSceneOrder === null ||
      foreshadow.revealSceneOrder === undefined ||
      (context.currentSceneOrder !== null &&
        context.currentSceneOrder !== undefined &&
        foreshadow.revealSceneOrder > context.currentSceneOrder);
    if (beforeReveal) addReason(reasons, "secret-before-reveal");
  }

  if (scope.audienceRef === "reader" && context.audienceRef !== "reader") {
    addReason(reasons, "reader-knowledge-not-character");
  }
  if (
    differs(context.knowledgeHolderRef, scope.knowledgeHolderRef) ||
    (scope.knowledgeHolderRef === "reader" && context.audienceRef !== "reader")
  ) {
    addReason(reasons, "knowledge-holder-mismatch");
  }
  if (differs(context.viewpointRef, scope.viewpointRef)) {
    addReason(reasons, "viewpoint-mismatch");
  }
  if (differs(context.worldlineRef, scope.worldlineRef)) {
    addReason(reasons, "worldline-mismatch");
  }
  if (differs(context.timelineRef, scope.timelineRef)) {
    addReason(reasons, "timeline-mismatch");
  }
  if (differs(context.narrativeLayer, scope.narrativeLayer)) {
    addReason(reasons, "narrative-layer-mismatch");
  }
  if (differs(context.currentSceneId, scope.sceneRef)) {
    addReason(reasons, "scene-scope-mismatch");
  }
  if (differs(context.audienceRef, scope.audienceRef)) {
    addReason(reasons, "audience-mismatch");
  }

  return { admitted: reasons.length === 0, reasons };
}

export function isNarrativeDisclosureAdmitted(
  context: NarrativeDisclosureContext,
  candidate: NarrativeDisclosureCandidate,
): boolean {
  return evaluateNarrativeDisclosure(context, candidate).admitted;
}
