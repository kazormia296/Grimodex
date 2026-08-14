export type NarrativePhaseResolutionMode = "reading" | "story" | "auto";

export interface NarrativeDisclosureContext {
  readonly projectId: string;
  readonly currentSceneId: string | null;
  readonly phaseResolutionMode: NarrativePhaseResolutionMode;
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
  readonly phase?: number | null;
  readonly storyTime?: number | null;
  readonly sceneOrder?: number | null;
  readonly viewpointRef?: string | null;
  readonly knowledgeHolderRef?: string | null;
  readonly audienceRef?: "reader" | string | null;
  readonly worldlineRef?: string | null;
  readonly timelineRef?: string | null;
  readonly narrativeLayer?: string | null;
  readonly foreshadow?: {
    readonly secret: boolean;
    readonly revealSceneId?: string | null;
    readonly revealSceneOrder?: number | null;
  };
}

export type NarrativeDisclosureRejection =
  | "project-mismatch"
  | "future-phase"
  | "future-story-time"
  | "future-scene"
  | "secret-before-reveal"
  | "knowledge-holder-mismatch"
  | "reader-knowledge-not-character"
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
  return (
    contextValue !== null &&
    contextValue !== undefined &&
    candidateValue !== null &&
    candidateValue !== undefined &&
    contextValue !== candidateValue
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

  // `auto` inherits the same resolved temporal anchor as the existing ADR 002
  // resolver. C1.5 deliberately does not create a second phase resolver.
  const effectiveMode =
    context.phaseResolutionMode === "auto"
      ? context.temporalAnchor
        ? "story"
        : "reading"
      : context.phaseResolutionMode;

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

  if (candidate.audienceRef === "reader" && context.audienceRef !== "reader") {
    addReason(reasons, "reader-knowledge-not-character");
  }
  if (
    differs(context.knowledgeHolderRef, candidate.knowledgeHolderRef) ||
    (candidate.knowledgeHolderRef === "reader" &&
      context.audienceRef !== "reader")
  ) {
    addReason(reasons, "knowledge-holder-mismatch");
  }
  if (differs(context.viewpointRef, candidate.viewpointRef)) {
    addReason(reasons, "viewpoint-mismatch");
  }
  if (differs(context.worldlineRef, candidate.worldlineRef)) {
    addReason(reasons, "worldline-mismatch");
  }
  if (differs(context.timelineRef, candidate.timelineRef)) {
    addReason(reasons, "timeline-mismatch");
  }
  if (differs(context.narrativeLayer, candidate.narrativeLayer)) {
    addReason(reasons, "narrative-layer-mismatch");
  }

  return { admitted: reasons.length === 0, reasons };
}

export function isNarrativeDisclosureAdmitted(
  context: NarrativeDisclosureContext,
  candidate: NarrativeDisclosureCandidate,
): boolean {
  return evaluateNarrativeDisclosure(context, candidate).admitted;
}
