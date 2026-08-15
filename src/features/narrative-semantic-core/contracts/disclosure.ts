import { validateNarrativeScope, type NarrativeScope } from "./scope";
import type {
  ApplicablePhaseResolution,
  PhaseFallbackReason,
} from "@/features/codex/context/resolveApplicablePhases";

export type NarrativePhaseResolutionMode = "reading" | "story" | "auto";
export type NarrativeDisclosureAxis = "reading" | "story";

/** ADR-002 resolves a temporal reference on the axis selected for this turn. */
export type NarrativeTemporalRefResolver = (
  ref: string,
  axis: NarrativeDisclosureAxis,
) => number | null;

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
  /** Story-axis order used for validFromRef/validUntilRef comparisons. */
  readonly currentStoryOrder?: number | null;
  readonly currentSceneOrder?: number | null;
  /** Missing or unresolved refs are deliberately fail-closed. */
  readonly resolveTemporalRef?: NarrativeTemporalRefResolver;
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
  | "disclosure-context-unresolved"
  | "project-mismatch"
  | "unresolved-scope"
  | "invalid-candidate"
  | "invalid-resolution"
  | "future-phase"
  | "future-story-time"
  | "unresolved-valid-from-ref"
  | "unresolved-valid-until-ref"
  | "future-valid-from"
  | "expired-valid-until"
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

function isDisclosureContextComplete(
  value: unknown,
): value is NarrativeDisclosureContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const context = value as Record<string, unknown>;
  const requiredKeys = [
    "projectId",
    "currentSceneId",
    "phaseResolutionMode",
    "phaseResolution",
    "temporalAnchor",
    "viewpointRef",
    "knowledgeHolderRef",
    "audienceRef",
    "allowSecrets",
    "currentPhase",
    "currentStoryTime",
    "currentSceneOrder",
  ];
  if (requiredKeys.some((key) => !Object.hasOwn(context, key))) return false;
  if (
    typeof context.projectId !== "string" ||
    context.projectId.trim().length === 0 ||
    !["reading", "story", "auto"].includes(
      String(context.phaseResolutionMode),
    ) ||
    typeof context.allowSecrets !== "boolean"
  ) {
    return false;
  }
  const resolution = context.phaseResolution;
  if (
    resolution === null ||
    typeof resolution !== "object" ||
    Array.isArray(resolution) ||
    !Object.hasOwn(resolution, "axisUsed") ||
    !Object.hasOwn(resolution, "fallbackReason") ||
    !Object.hasOwn(resolution, "resolver")
  ) {
    return false;
  }
  const nullableString = (candidate: unknown): boolean =>
    candidate === null ||
    (typeof candidate === "string" && candidate.trim().length > 0);
  if (
    !nullableString(context.currentSceneId) ||
    !nullableString(context.temporalAnchor) ||
    !nullableString(context.viewpointRef) ||
    !nullableString(context.knowledgeHolderRef) ||
    !nullableString(context.audienceRef)
  ) {
    return false;
  }
  const nullableOrder = (candidate: unknown): boolean =>
    candidate === null ||
    (typeof candidate === "number" && Number.isSafeInteger(candidate));
  return (
    nullableOrder(context.currentPhase) &&
    nullableOrder(context.currentStoryTime) &&
    nullableOrder(context.currentSceneOrder)
  );
}

function isDisclosureCandidateComplete(
  value: unknown,
): value is NarrativeDisclosureCandidate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.projectId !== "string" ||
    candidate.projectId.trim().length === 0
  ) {
    return false;
  }
  const nullableSafeInteger = (entry: unknown): boolean =>
    entry === null || Number.isSafeInteger(entry);
  for (const key of ["phase", "storyTime", "sceneOrder"]) {
    if (Object.hasOwn(candidate, key) && !nullableSafeInteger(candidate[key])) {
      return false;
    }
  }
  if (!Object.hasOwn(candidate, "foreshadow")) return true;
  const foreshadow = candidate.foreshadow;
  if (
    foreshadow === null ||
    typeof foreshadow !== "object" ||
    Array.isArray(foreshadow) ||
    typeof (foreshadow as Record<string, unknown>).secret !== "boolean"
  ) {
    return false;
  }
  const foreshadowRecord = foreshadow as Record<string, unknown>;
  const nullableString = (entry: unknown): boolean =>
    entry === null ||
    (typeof entry === "string" && entry.trim().length > 0);
  if (
    Object.hasOwn(foreshadowRecord, "revealSceneId") &&
    !nullableString(foreshadowRecord.revealSceneId)
  ) {
    return false;
  }
  if (
    Object.hasOwn(foreshadowRecord, "revealSceneOrder") &&
    !nullableSafeInteger(foreshadowRecord.revealSceneOrder)
  ) {
    return false;
  }
  return true;
}

export function evaluateNarrativeDisclosure(
  context: NarrativeDisclosureContext,
  candidate: NarrativeDisclosureCandidate,
): NarrativeDisclosureDecision {
  if (!isDisclosureContextComplete(context)) {
    return {
      admitted: false,
      reasons: ["disclosure-context-unresolved"],
    };
  }
  if (!isDisclosureCandidateComplete(candidate)) {
    return {
      admitted: false,
      reasons: ["invalid-candidate"],
    };
  }
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

  const effectiveMode: NarrativeDisclosureAxis | null =
    context.phaseResolution.axisUsed === "reading" ||
    context.phaseResolution.axisUsed === "story"
      ? context.phaseResolution.axisUsed
      : null;
  if (
    !isValidPhaseResolution(
      context.phaseResolutionMode,
      context.phaseResolution,
    )
  ) {
    addReason(reasons, "invalid-resolution");
  }

  // A nullable temporal value is an unresolved disclosure boundary, not an
  // unconstrained one. Only require the axis that the candidate actually
  // uses so a reading-order context can still admit candidates without a
  // story-time assertion (and vice versa).
  if (
    candidate.phase !== null &&
    candidate.phase !== undefined &&
    (context.currentPhase === null || context.currentPhase === undefined)
  ) {
    addReason(reasons, "disclosure-context-unresolved");
  }
  if (
    effectiveMode === "story" &&
    candidate.storyTime !== null &&
    candidate.storyTime !== undefined &&
    (context.currentStoryTime === null || context.currentStoryTime === undefined)
  ) {
    addReason(reasons, "disclosure-context-unresolved");
  }
  if (
    effectiveMode === "reading" &&
    candidate.sceneOrder !== null &&
    candidate.sceneOrder !== undefined &&
    (context.currentSceneOrder === null || context.currentSceneOrder === undefined)
  ) {
    addReason(reasons, "disclosure-context-unresolved");
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
    effectiveMode === "story" &&
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

  const currentAxisOrder =
    effectiveMode === "reading"
      ? context.currentSceneOrder
      : effectiveMode === "story"
        ? (context.currentStoryOrder ?? context.currentStoryTime)
        : null;
  const resolveScopeRef = (
    ref: string | undefined,
    rejection: "unresolved-valid-from-ref" | "unresolved-valid-until-ref",
  ): number | null => {
    if (!ref) return null;
    if (!context.resolveTemporalRef) {
      addReason(reasons, rejection);
      return null;
    }
    if (!effectiveMode) {
      addReason(reasons, rejection);
      return null;
    }
    const resolved = (() => {
      try {
        return context.resolveTemporalRef?.(ref, effectiveMode) ?? null;
      } catch {
        return null;
      }
    })();
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) {
      addReason(reasons, rejection);
      return null;
    }
    return resolved;
  };
  const validFromOrder = resolveScopeRef(
    scope.validFromRef,
    "unresolved-valid-from-ref",
  );
  if (
    scope.validFromRef &&
    validFromOrder !== null &&
    (currentAxisOrder === null ||
      currentAxisOrder === undefined ||
      !Number.isSafeInteger(currentAxisOrder))
  ) {
    addReason(reasons, "unresolved-valid-from-ref");
  } else if (
    scope.validFromRef &&
    validFromOrder !== null &&
    currentAxisOrder !== null &&
    currentAxisOrder !== undefined &&
    currentAxisOrder < validFromOrder
  ) {
    addReason(reasons, "future-valid-from");
  }
  const validUntilOrder = resolveScopeRef(
    scope.validUntilRef,
    "unresolved-valid-until-ref",
  );
  if (
    scope.validUntilRef &&
    validUntilOrder !== null &&
    (currentAxisOrder === null ||
      currentAxisOrder === undefined ||
      !Number.isSafeInteger(currentAxisOrder))
  ) {
    addReason(reasons, "unresolved-valid-until-ref");
  } else if (
    scope.validUntilRef &&
    validUntilOrder !== null &&
    currentAxisOrder !== null &&
    currentAxisOrder !== undefined &&
    currentAxisOrder > validUntilOrder
  ) {
    addReason(reasons, "expired-valid-until");
  }

  const foreshadow = candidate.foreshadow;
  if (foreshadow?.secret) {
    const beforeReveal =
      !context.allowSecrets ||
      foreshadow.revealSceneOrder === null ||
      foreshadow.revealSceneOrder === undefined ||
      context.currentSceneOrder === null ||
      context.currentSceneOrder === undefined ||
      foreshadow.revealSceneOrder > context.currentSceneOrder;
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
