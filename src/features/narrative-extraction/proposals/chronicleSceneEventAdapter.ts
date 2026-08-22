import {
  canonicalNarrativeScopeV2,
  digestNarrativeScopeV2,
  validateNarrativeScopeV2,
  type NarrativeScopeV2,
} from "@/features/narrative-semantic-core/contracts/scopeV2";
import {
  NARRATIVE_IR_REGISTRY,
  validateNarrativeRevisionEnvelopeV2,
  type NarrativeIrValidationResult,
} from "@/features/narrative-semantic-core/contracts/narrativeIr";
import { validateDependencySelector } from "@/features/narrative-semantic-core/contracts/dependencyRole";
import {
  digestStableJson,
  stableJsonStringify,
} from "@/features/narrative-extraction/source/digest";
import type { Sha256Digest } from "@/features/narrative-extraction/source/types";
import type { ChronicleExistingMatch } from "@/features/chronicle/extraction/existingEventMatcher";
import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type {
  ContextSetEntry,
  DependencySetEntry,
  EvidenceSetEntry,
  NarrativeProjectionBindingV2,
  NarrativeRevisionEnvelopeV2,
  SourceBasis,
} from "@/features/narrative-extraction/reconciler/types";
import {
  assertChronicleStageProvenanceReachability,
  assertChronicleStageC1ClosureCompleteness,
  assertChronicleStageProvenanceBindingV1,
  type ChronicleStageProvenanceBindingV1,
  type ChronicleStageProvenanceClosureV1,
} from "@/features/narrative-extraction/reconciler/stageProvenance";
import { NARRATIVE_STAGE_IDS } from "@/features/narrative-extraction/reconciler/stageExecution";
import {
  CHRONICLE_EVENT_SYNTHESIS_COMPONENT_CONTRACT_ID,
  canonicalizeChronicleContextSet,
  digestChronicleContextSet,
} from "@/features/narrative-extraction/reconciler/chroniclePromptBuilder";
import {
  CHRONICLE_EVENT_PROPOSAL_KIND,
  type ChronicleEventActuality,
  type ChronicleEventSignificance,
  type CreateChronicleEventProposalPayloadV1,
} from "./chronicleEventProposal";

export const CHRONICLE_SCENE_EVENT_ADAPTER_ID =
  NARRATIVE_IR_REGISTRY.adapter.id;
export const CHRONICLE_SCENE_EVENT_ADAPTER_VERSION =
  NARRATIVE_IR_REGISTRY.adapter.version;

export const CHRONICLE_SCENE_EVENT_PROPOSAL_SCHEMA_REF = Object.freeze({
  id: "narrative.chronicle-event.create",
  version: "1",
});

/** The semantic payload deliberately excludes Proposal projection/disclosure fields. */
export const CHRONICLE_SCENE_EVENT_ASSERTION_SCHEMA_REF = Object.freeze({
  id: "narrative.chronicle.scene-event",
  version: "1",
});

type ChronicleAttribution =
  RawChronicleEventObservation["assertion"]["attribution"];
type ChronicleNarrativeFrame =
  RawChronicleEventObservation["assertion"]["narrativeFrame"];

export interface ChronicleSceneEventSemanticPayloadV1 {
  readonly eventId: string;
  readonly summary: string;
  readonly actuality: ChronicleEventActuality;
  readonly significance: ChronicleEventSignificance;
  readonly attribution: ChronicleAttribution;
  readonly narrativeFrame: ChronicleNarrativeFrame;
  readonly observationRefs: readonly string[];
  readonly originalObservationRefs: readonly string[];
  readonly mergedObservationRefs: readonly string[];
  readonly observationSummaries: readonly {
    readonly observationRef: string;
    readonly predicate: string;
    readonly semanticType?: string;
    readonly participants: readonly {
      readonly surface: string;
      readonly role: string;
    }[];
    readonly locationSurface?: string;
    readonly temporalExpressions: readonly string[];
    readonly durationKind: string;
  }[];
  readonly semanticType?: string;
}

export interface ChronicleSceneEventExecutionInput {
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly reconcilerId: string;
  readonly reconcilerVersion: string;
  /** Audited E2 Context Set digest; C1 never derives an independent domain. */
  readonly contextSetDigest: Sha256Digest;
  /** Exact static component contract identity sealed by the E2 execution. */
  readonly componentContractId: string;
  readonly componentContractDigest: Sha256Digest;
  readonly finalRequestDigest: Sha256Digest;
}

export type ChronicleSceneEventRevealBasis =
  | { readonly status: "not-secret" }
  | {
      readonly status: "resolved";
      readonly documentRef: string;
      readonly audienceRef: string;
      readonly readingOrder: ChronicleSceneEventInterval;
      readonly storyTime: ChronicleSceneEventInterval;
    }
  | {
      readonly status: "unresolved";
      readonly documentRef: string;
      readonly audience: ChronicleSceneEventUnresolvedConstraint;
      readonly readingOrder: ChronicleSceneEventUnresolvedConstraint;
    };

export interface ChronicleSceneEventInterval {
  readonly from?: ChronicleSceneEventBoundary;
  readonly until?: ChronicleSceneEventBoundary;
}

export interface ChronicleSceneEventBoundary {
  readonly ref: string;
  readonly inclusive: boolean;
}

export interface ChronicleSceneEventUnresolvedConstraint {
  readonly reason:
    | "not-provided"
    | "ambiguous"
    | "missing-reference"
    | "unsupported-axis"
    | "legacy-axis-unknown";
  readonly constraintId: string;
}

export interface ChronicleSceneEventScopeInput {
  readonly sceneRef: string;
  readonly proposalPayload: CreateChronicleEventProposalPayloadV1;
  readonly revealBasis: ChronicleSceneEventRevealBasis;
}

export interface ChronicleSceneEventAdapterInput {
  readonly execution: ChronicleSceneEventExecutionInput;
  /** Sealed C1 sidecar; the Envelope remains unchanged. */
  readonly stageProvenanceClosure: ChronicleStageProvenanceClosureV1;
  readonly provenanceBinding: ChronicleStageProvenanceBindingV1;
  readonly sceneRef: string;
  readonly proposalPayload: CreateChronicleEventProposalPayloadV1;
  readonly hypothesis: EventHypothesis;
  readonly originalObservations: readonly RawChronicleEventObservation[];
  readonly mergedObservations: readonly RawChronicleEventObservation[];
  readonly originalObservationRefs: readonly string[];
  readonly mergedObservationRefs: readonly string[];
  readonly evidenceAnchors: readonly ResolvedEvidenceAnchor[];
  readonly attribution: ChronicleAttribution;
  readonly narrativeFrame: ChronicleNarrativeFrame;
  readonly actuality: ChronicleEventActuality;
  readonly significance: ChronicleEventSignificance;
  readonly existingEventMatch: ChronicleExistingMatch;
  readonly sourceBasis: SourceBasis;
  readonly contextManifests: readonly ContextSetEntry[];
  readonly dependencyDeclarations: readonly DependencySetEntry[];
  readonly revealBasis: ChronicleSceneEventRevealBasis;
}

export type ChronicleSceneEventRevision =
  NarrativeRevisionEnvelopeV2<ChronicleSceneEventSemanticPayloadV1>;

export interface ChronicleSceneEventAdapterResult {
  readonly envelope: ChronicleSceneEventRevision;
  readonly proposalPayload: CreateChronicleEventProposalPayloadV1;
  readonly proposalPayloadDigest: Sha256Digest;
  readonly scope: NarrativeScopeV2;
  readonly canonicalScopeJson: string;
  readonly existingEventMatch: ChronicleExistingMatch;
  readonly stageProvenanceClosure: ChronicleStageProvenanceClosureV1;
  readonly provenanceBinding: ChronicleStageProvenanceBindingV1;
}

export type ChronicleSceneEventChangeClassification =
  | {
      readonly disposition: "accept";
      readonly changedPaths: readonly string[];
      readonly derivationKind:
        | "projection-only"
        | "scope-override"
        | "assertion-override";
      readonly changedPathClasses: readonly string[];
    }
  | {
      readonly disposition: "reject";
      readonly reason: "unsupported-path";
      readonly changedPaths: readonly string[];
      readonly changedPathClasses: readonly string[];
    };

const PROJECTION_ONLY_PATHS = new Set(["/title", "/note"]);
const SCOPE_AFFECTING_PATHS = new Set([
  "/disclosure/secret",
  "/disclosure/revealDocumentRef",
]);
const VALID_ACTUALITIES = new Set<ChronicleEventActuality>([
  "actual",
  "attempted",
  "prevented",
]);
const VALID_SIGNIFICANCES = new Set<ChronicleEventSignificance>([
  "major",
  "scene-level",
]);
const VALID_ATTRIBUTIONS = new Set<ChronicleAttribution>([
  "narrator",
  "unknown",
]);
const VALID_NARRATIVE_FRAMES = new Set<ChronicleNarrativeFrame>([
  "story-world",
  "flashback",
  "dream",
  "reported",
  "hypothetical",
  "unknown",
]);
const VALID_DURATION_KINDS = new Set([
  "instant",
  "bounded-interval",
  "ongoing-process",
  "unknown",
]);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function assertNonEmpty(
  value: unknown,
  label: string,
): asserts value is string {
  if (!isNonEmptyString(value)) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertDigest(
  value: unknown,
  label: string,
): asserts value is Sha256Digest {
  if (!isDigest(value)) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) throw new TypeError(`${label} has unknown field '${unknown}'`);
}

function assertStringArray(
  value: unknown,
  label: string,
  minItems = 0,
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < minItems ||
    value.some((item) => !isNonEmptyString(item))
  ) {
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }
}

function assertUniqueStringArray(
  value: unknown,
  label: string,
  minItems = 0,
): asserts value is readonly string[] {
  assertStringArray(value, label, minItems);
  if (new Set(value).size !== value.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
}

function assertExactStringSet(
  value: readonly string[],
  expected: ReadonlySet<string>,
  label: string,
): void {
  if (
    new Set(value).size !== value.length ||
    value.length !== expected.size ||
    value.some((item) => !expected.has(item))
  ) {
    throw new TypeError(`${label} must exactly cover its retained provenance`);
  }
}

function assertAttribution(
  value: unknown,
  label: string,
): asserts value is ChronicleAttribution {
  if (
    !isNonEmptyString(value) ||
    (!VALID_ATTRIBUTIONS.has(value as ChronicleAttribution) &&
      (!value.startsWith("character:") || value.length <= "character:".length))
  ) {
    throw new TypeError(`${label} is unsupported`);
  }
}

function assertNarrativeFrame(
  value: unknown,
  label: string,
): asserts value is ChronicleNarrativeFrame {
  if (!VALID_NARRATIVE_FRAMES.has(value as ChronicleNarrativeFrame)) {
    throw new TypeError(`${label} is unsupported`);
  }
}

function assertProposalPayload(
  value: unknown,
): asserts value is CreateChronicleEventProposalPayloadV1 {
  if (!isRecord(value))
    throw new TypeError("Proposal payload must be an object");
  assertExactKeys(
    value,
    [
      "eventId",
      "title",
      "note",
      "actuality",
      "significance",
      "semanticType",
      "evidenceAnchorIds",
      "evidenceDocumentRefs",
      "disclosure",
      "unresolvedMetadata",
    ],
    "Proposal payload",
  );
  assertNonEmpty(value.eventId, "Proposal payload.eventId");
  assertNonEmpty(value.title, "Proposal payload.title");
  if (value.note !== null && typeof value.note !== "string") {
    throw new TypeError("Proposal payload.note must be a string or null");
  }
  if (!VALID_ACTUALITIES.has(value.actuality as ChronicleEventActuality)) {
    throw new TypeError("Proposal payload.actuality is unsupported");
  }
  if (
    !VALID_SIGNIFICANCES.has(value.significance as ChronicleEventSignificance)
  ) {
    throw new TypeError("Proposal payload.significance is unsupported");
  }
  if (value.semanticType !== undefined) {
    assertNonEmpty(value.semanticType, "Proposal payload.semanticType");
  }
  assertStringArray(
    value.evidenceAnchorIds,
    "Proposal payload.evidenceAnchorIds",
    1,
  );
  assertStringArray(
    value.evidenceDocumentRefs,
    "Proposal payload.evidenceDocumentRefs",
    1,
  );
  if (!isRecord(value.disclosure)) {
    throw new TypeError("Proposal payload.disclosure is required");
  }
  assertExactKeys(
    value.disclosure,
    ["secret", "revealDocumentRef"],
    "Proposal payload.disclosure",
  );
  if (typeof value.disclosure.secret !== "boolean") {
    throw new TypeError("Proposal payload.disclosure.secret must be boolean");
  }
  assertNonEmpty(
    value.disclosure.revealDocumentRef,
    "Proposal payload.disclosure.revealDocumentRef",
  );
  if (!isRecord(value.unresolvedMetadata)) {
    throw new TypeError("Proposal payload.unresolvedMetadata is required");
  }
  assertExactKeys(
    value.unresolvedMetadata,
    ["participantSurfaces", "locationSurface", "temporalExpressions"],
    "Proposal payload.unresolvedMetadata",
  );
  assertStringArray(
    value.unresolvedMetadata.participantSurfaces,
    "Proposal payload.unresolvedMetadata.participantSurfaces",
  );
  if (
    value.unresolvedMetadata.locationSurface !== null &&
    !isNonEmptyString(value.unresolvedMetadata.locationSurface)
  ) {
    throw new TypeError(
      "Proposal payload.unresolvedMetadata.locationSurface must be a string or null",
    );
  }
  assertStringArray(
    value.unresolvedMetadata.temporalExpressions,
    "Proposal payload.unresolvedMetadata.temporalExpressions",
  );
}

function assertBoundary(
  value: unknown,
  label: string,
): asserts value is ChronicleSceneEventBoundary {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["ref", "inclusive"], label);
  assertNonEmpty(value.ref, `${label}.ref`);
  if (typeof value.inclusive !== "boolean") {
    throw new TypeError(`${label}.inclusive must be boolean`);
  }
}

function assertInterval(
  value: unknown,
  label: string,
): asserts value is ChronicleSceneEventInterval {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["from", "until"], label);
  if (value.from === undefined && value.until === undefined) {
    throw new TypeError(`${label} must contain a boundary`);
  }
  if (value.from !== undefined) assertBoundary(value.from, `${label}.from`);
  if (value.until !== undefined) assertBoundary(value.until, `${label}.until`);
}

function assertUnresolved(
  value: unknown,
  label: string,
): asserts value is ChronicleSceneEventUnresolvedConstraint {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["reason", "constraintId"], label);
  if (
    ![
      "not-provided",
      "ambiguous",
      "missing-reference",
      "unsupported-axis",
      "legacy-axis-unknown",
    ].includes(value.reason as string)
  ) {
    throw new TypeError(`${label}.reason is unsupported`);
  }
  assertNonEmpty(value.constraintId, `${label}.constraintId`);
}

function assertRevealBasis(
  proposalPayload: CreateChronicleEventProposalPayloadV1,
  revealBasis: ChronicleSceneEventRevealBasis,
): void {
  if (!isRecord(revealBasis)) throw new TypeError("Reveal basis is required");
  if (proposalPayload.disclosure.secret === false) {
    assertExactKeys(revealBasis, ["status"], "Reveal basis");
    if (revealBasis.status !== "not-secret") {
      throw new TypeError(
        "non-secret Proposal requires a not-secret reveal basis",
      );
    }
    return;
  }
  assertNonEmpty(
    proposalPayload.disclosure.revealDocumentRef,
    "Proposal disclosure revealDocumentRef",
  );
  if (revealBasis.status === "resolved") {
    assertExactKeys(
      revealBasis,
      ["status", "documentRef", "audienceRef", "readingOrder", "storyTime"],
      "Reveal basis",
    );
    assertNonEmpty(revealBasis.documentRef, "Reveal basis documentRef");
    if (
      revealBasis.documentRef !== proposalPayload.disclosure.revealDocumentRef
    ) {
      throw new TypeError(
        "Reveal basis documentRef must match Proposal disclosure",
      );
    }
    assertNonEmpty(revealBasis.audienceRef, "Reveal basis audienceRef");
    assertInterval(revealBasis.readingOrder, "Reveal basis readingOrder");
    assertInterval(revealBasis.storyTime, "Reveal basis storyTime");
    return;
  }
  if (revealBasis.status === "unresolved") {
    assertExactKeys(
      revealBasis,
      ["status", "documentRef", "audience", "readingOrder"],
      "Reveal basis",
    );
    assertNonEmpty(revealBasis.documentRef, "Reveal basis documentRef");
    if (
      revealBasis.documentRef !== proposalPayload.disclosure.revealDocumentRef
    ) {
      throw new TypeError(
        "Reveal basis documentRef must match Proposal disclosure",
      );
    }
    assertUnresolved(revealBasis.audience, "Reveal basis audience");
    assertUnresolved(revealBasis.readingOrder, "Reveal basis readingOrder");
    return;
  }
  throw new TypeError("Reveal basis status is unsupported");
}

function createScopeBase(sceneRef: string): NarrativeScopeV2 {
  return {
    schemaVersion: 2,
    registryVersion: "narrative-scope/2",
    timeline: { kind: "any" },
    worldline: { kind: "any" },
    scene: { kind: "exact", ref: sceneRef },
    viewpoint: { kind: "any" },
    knowledgeHolder: { kind: "any" },
    audience: { kind: "any" },
    narrativeLayer: { kind: "any" },
    storyTime: { kind: "any" },
    readingOrder: { kind: "any" },
  };
}

export async function deriveChronicleSceneEventScope(
  input: ChronicleSceneEventScopeInput,
): Promise<{
  readonly scope: NarrativeScopeV2;
  readonly canonicalJson: string;
  readonly digest: Sha256Digest;
}> {
  assertNonEmpty(input.sceneRef, "Scope sceneRef");
  assertProposalPayload(input.proposalPayload);
  assertRevealBasis(input.proposalPayload, input.revealBasis);

  let scope = createScopeBase(input.sceneRef);
  if (input.proposalPayload.disclosure.secret) {
    if (input.revealBasis.status === "resolved") {
      scope = {
        ...scope,
        audience: { kind: "exact", ref: input.revealBasis.audienceRef },
        readingOrder: {
          kind: "interval",
          ...input.revealBasis.readingOrder,
        },
        storyTime: {
          kind: "interval",
          ...input.revealBasis.storyTime,
        },
      };
    } else if (input.revealBasis.status === "unresolved") {
      scope = {
        ...scope,
        audience: { kind: "unresolved", ...input.revealBasis.audience },
        readingOrder: {
          kind: "unresolved",
          ...input.revealBasis.readingOrder,
        },
      };
    }
  }

  const structural = validateNarrativeScopeV2(scope);
  if (!structural.valid) {
    throw new TypeError(
      `Derived Chronicle Scope is invalid: ${structural.reason}`,
    );
  }
  const canonicalJson = canonicalNarrativeScopeV2(scope);
  const digest = await digestNarrativeScopeV2(scope);
  return { scope, canonicalJson, digest };
}

function jsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function collectChangedPaths(
  before: unknown,
  after: unknown,
  prefix = "",
): readonly string[] {
  if (stableJsonStringify(before) === stableJsonStringify(after)) return [];
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((key) =>
      collectChangedPaths(
        before[key],
        after[key],
        `${prefix}/${jsonPointerSegment(key)}`,
      ),
    );
  }
  return [prefix || "/"];
}

export function classifyChronicleSceneEventChanges(
  before: unknown,
  after: unknown,
): ChronicleSceneEventChangeClassification {
  const changedPaths = collectChangedPaths(before, after);
  const changedPathClasses: string[] = [];
  for (const changedPath of changedPaths) {
    const pathClass = PROJECTION_ONLY_PATHS.has(changedPath)
      ? "projection-only"
      : SCOPE_AFFECTING_PATHS.has(changedPath)
        ? "scope-affecting"
        : "unsupported";
    if (!changedPathClasses.includes(pathClass))
      changedPathClasses.push(pathClass);
    if (pathClass === "unsupported") {
      return {
        disposition: "reject",
        reason: "unsupported-path",
        changedPaths,
        changedPathClasses,
      };
    }
  }
  return {
    disposition: "accept",
    changedPaths,
    derivationKind: changedPathClasses.includes("scope-affecting")
      ? "scope-override"
      : "projection-only",
    changedPathClasses,
  };
}

function assertObservationProvenance(
  input: ChronicleSceneEventAdapterInput,
): void {
  if (
    input.originalObservations.length === 0 ||
    input.mergedObservations.length === 0
  ) {
    throw new TypeError(
      "Chronicle Adapter requires original and merged observations",
    );
  }
  assertUniqueStringArray(
    input.originalObservationRefs,
    "originalObservationRefs",
    1,
  );
  assertUniqueStringArray(
    input.mergedObservationRefs,
    "mergedObservationRefs",
    1,
  );
  const originalIds = new Set(
    input.originalObservations.map((item) => item.localId),
  );
  const mergedIds = new Set(
    input.mergedObservations.map((item) => item.localId),
  );
  if (originalIds.size !== input.originalObservations.length) {
    throw new TypeError("original observations must have unique local IDs");
  }
  if (mergedIds.size !== input.mergedObservations.length) {
    throw new TypeError("merged observations must have unique local IDs");
  }
  assertExactStringSet(
    input.originalObservationRefs,
    originalIds,
    "originalObservationRefs",
  );
  assertExactStringSet(
    input.mergedObservationRefs,
    mergedIds,
    "mergedObservationRefs",
  );
  assertUniqueStringArray(
    input.hypothesis.observationRefs,
    "Event Hypothesis observationRefs",
    1,
  );
  assertExactStringSet(
    input.hypothesis.observationRefs,
    mergedIds,
    "Event Hypothesis observationRefs",
  );
  for (const observation of [
    ...input.originalObservations,
    ...input.mergedObservations,
  ]) {
    assertNonEmpty(observation.localId, "observation.localId");
    assertAttribution(
      observation.assertion.attribution,
      "observation.assertion.attribution",
    );
    assertNarrativeFrame(
      observation.assertion.narrativeFrame,
      "observation.assertion.narrativeFrame",
    );
    assertNonEmpty(observation.payload.predicate, "observation predicate");
    if (!Array.isArray(observation.payload.participants)) {
      throw new TypeError("observation participants must be an array");
    }
    for (const participant of observation.payload.participants) {
      if (!isRecord(participant))
        throw new TypeError("observation participant must be an object");
      assertExactKeys(
        participant,
        ["surface", "role"],
        "observation participant",
      );
      assertNonEmpty(participant.surface, "observation participant surface");
      assertNonEmpty(participant.role, "observation participant role");
    }
    if (!Array.isArray(observation.payload.temporalExpressions)) {
      throw new TypeError("observation temporalExpressions must be an array");
    }
    assertStringArray(
      observation.payload.temporalExpressions,
      "observation temporalExpressions",
    );
    if (!VALID_DURATION_KINDS.has(observation.payload.durationKind)) {
      throw new TypeError("observation durationKind is unsupported");
    }
    if (
      !Array.isArray(observation.evidence) ||
      observation.evidence.length === 0
    ) {
      throw new TypeError("each observation requires evidence references");
    }
    for (const evidence of observation.evidence) {
      assertNonEmpty(evidence.sourceRef, "observation evidence sourceRef");
      assertNonEmpty(evidence.quote, "observation evidence quote");
    }
  }

  const originalsById = new Map(
    input.originalObservations.map(
      (observation) => [observation.localId, observation] as const,
    ),
  );
  for (const mergedObservation of input.mergedObservations) {
    const originalObservation = originalsById.get(mergedObservation.localId);
    if (!originalObservation) {
      throw new TypeError(
        `merged observation '${mergedObservation.localId}' is absent from original provenance`,
      );
    }
    if (
      stableJsonStringify(originalObservation) !==
      stableJsonStringify(mergedObservation)
    ) {
      throw new TypeError(
        `merged observation '${mergedObservation.localId}' does not preserve original provenance`,
      );
    }
  }
}

function assertEvidenceProvenance(
  input: ChronicleSceneEventAdapterInput,
): void {
  if (input.evidenceAnchors.length === 0) {
    throw new TypeError("Chronicle Adapter requires resolved Evidence Anchors");
  }
  const anchorsById = new Map<string, ResolvedEvidenceAnchor>();
  const anchorsByEvidence = new Map<
    string,
    Map<string, ResolvedEvidenceAnchor>
  >();
  for (const anchor of input.evidenceAnchors) {
    assertNonEmpty(anchor.id, "Evidence Anchor id");
    assertNonEmpty(anchor.sourceRef, "Evidence Anchor sourceRef");
    assertNonEmpty(anchor.documentRef, "Evidence Anchor documentRef");
    assertNonEmpty(anchor.quote, "Evidence Anchor quote");
    assertDigest(anchor.quoteDigest, "Evidence Anchor quoteDigest");
    if (anchorsById.has(anchor.id))
      throw new TypeError("Evidence Anchor IDs must be unique");
    anchorsById.set(anchor.id, anchor);
    const anchorsByQuote = anchorsByEvidence.get(anchor.sourceRef) ?? new Map();
    if (anchorsByQuote.has(anchor.quote)) {
      throw new TypeError(
        "Evidence Anchor sourceRef/quote pairs must be unique",
      );
    }
    anchorsByQuote.set(anchor.quote, anchor);
    anchorsByEvidence.set(anchor.sourceRef, anchorsByQuote);
  }

  const relevantObservations = [
    ...input.originalObservations,
    ...input.mergedObservations,
  ];
  const referencedAnchors = new Set<string>();
  for (const observation of relevantObservations) {
    for (const evidence of observation.evidence) {
      const anchor = anchorsByEvidence
        .get(evidence.sourceRef)
        ?.get(evidence.quote);
      if (!anchor)
        throw new TypeError(
          "every Observation evidence ref requires a resolved Anchor",
        );
      referencedAnchors.add(anchor.id);
    }
  }
  assertExactStringSet(
    input.proposalPayload.evidenceAnchorIds,
    referencedAnchors,
    "Proposal evidenceAnchorIds",
  );
  const referencedDocuments = new Set<string>();
  for (const anchorId of referencedAnchors) {
    const anchor = anchorsById.get(anchorId);
    if (!anchor) {
      throw new TypeError(
        "Observation provenance requires every resolved Evidence Anchor",
      );
    }
    referencedDocuments.add(anchor.documentRef);
  }
  assertExactStringSet(
    input.proposalPayload.evidenceDocumentRefs,
    referencedDocuments,
    "Proposal evidenceDocumentRefs",
  );
}

function assertMaterialBasis(input: ChronicleSceneEventAdapterInput): void {
  if (input.sourceBasis.length === 0)
    throw new TypeError("Source Basis is required");
  for (const source of input.sourceBasis) {
    assertNonEmpty(source.sourceKind, "Source Basis sourceKind");
    assertNonEmpty(source.sourceKey, "Source Basis sourceKey");
    assertNonEmpty(source.revisionToken, "Source Basis revisionToken");
  }
  if (input.contextManifests.length === 0)
    throw new TypeError("Context manifests are required");
  const contextIds = new Set<string>();
  for (const context of input.contextManifests) {
    assertNonEmpty(context.contextId, "Context manifest contextId");
    assertNonEmpty(context.inputRef, "Context manifest inputRef");
    assertNonEmpty(context.stageId, "Context manifest stageId");
    if (!isRecord(context.selector))
      throw new TypeError("Context manifest selector is required");
    if (contextIds.has(context.contextId))
      throw new TypeError("Context manifest IDs must be unique");
    contextIds.add(context.contextId);
  }
  if (input.dependencyDeclarations.length === 0) {
    throw new TypeError("Dependency declarations are required");
  }
  const dependencyIds = new Set<string>();
  let componentContractDependencyFound = false;
  for (const dependency of input.dependencyDeclarations) {
    assertNonEmpty(
      dependency.dependencyId,
      "Dependency declaration dependencyId",
    );
    assertNonEmpty(dependency.inputRef, "Dependency declaration inputRef");
    assertNonEmpty(dependency.role, "Dependency declaration role");
    const selectorResult = validateDependencySelector(dependency.selector);
    if (!selectorResult.valid) {
      throw new TypeError(
        `Dependency declaration selector is invalid: ${selectorResult.error.code}`,
      );
    }
    if (dependency.role === "component-contract") {
      if (componentContractDependencyFound) {
        throw new TypeError(
          "Only one component-contract dependency is allowed",
        );
      }
      componentContractDependencyFound = true;
      const selector = selectorResult.selector;
      if (
        selector.kind !== "component-contract" ||
        selector.contractId !== input.execution.componentContractId ||
        selector.contractDigest !== input.execution.componentContractDigest
      ) {
        throw new TypeError(
          "component-contract dependency selector must match execution component contract",
        );
      }
      // Static component contracts are not Context Set entries. Keep the
      // declaration's contextIds optional, while still resolving any IDs a
      // caller explicitly supplies.
      assertStringArray(
        dependency.contextIds,
        "Dependency declaration contextIds",
      );
    } else {
      if (selectorResult.selector.kind === "component-contract") {
        throw new TypeError(
          "component-contract selector requires component-contract dependency role",
        );
      }
      assertStringArray(
        dependency.contextIds,
        "Dependency declaration contextIds",
        1,
      );
    }
    if (dependency.contextIds.some((id) => !contextIds.has(id))) {
      throw new TypeError(
        "Dependency declaration contextIds must resolve to Context manifests",
      );
    }
    if (dependencyIds.has(dependency.dependencyId)) {
      throw new TypeError("Dependency declaration IDs must be unique");
    }
    dependencyIds.add(dependency.dependencyId);
  }
  if (!componentContractDependencyFound) {
    throw new TypeError("A component-contract dependency is required");
  }
}

async function assertAdapterInput(
  input: ChronicleSceneEventAdapterInput,
): Promise<void> {
  await assertChronicleStageC1ClosureCompleteness(
    input.stageProvenanceClosure,
    input.execution,
  );
  assertChronicleStageProvenanceBindingV1(input.provenanceBinding);
  await assertChronicleStageProvenanceReachability({
    execution: input.execution,
    closure: input.stageProvenanceClosure,
    provenanceBinding: input.provenanceBinding,
  });
  assertNonEmpty(input.execution.projectId, "Adapter projectId");
  assertNonEmpty(input.execution.runId, "Adapter runId");
  assertNonEmpty(input.execution.taskId, "Adapter taskId");
  assertNonEmpty(input.execution.attemptId, "Adapter attemptId");
  assertNonEmpty(input.execution.reconcilerId, "Adapter reconcilerId");
  assertNonEmpty(
    input.execution.reconcilerVersion,
    "Adapter reconcilerVersion",
  );
  assertDigest(input.execution.contextSetDigest, "Adapter contextSetDigest");
  assertNonEmpty(
    input.execution.componentContractId,
    "Adapter componentContractId",
  );
  if (
    input.execution.componentContractId !==
    CHRONICLE_EVENT_SYNTHESIS_COMPONENT_CONTRACT_ID
  ) {
    throw new TypeError(
      "Adapter componentContractId must match the canonical Event Synthesis component contract",
    );
  }
  assertDigest(
    input.execution.componentContractDigest,
    "Adapter componentContractDigest",
  );
  assertDigest(
    input.execution.finalRequestDigest,
    "Adapter finalRequestDigest",
  );
  assertNonEmpty(input.sceneRef, "Adapter sceneRef");
  assertProposalPayload(input.proposalPayload);
  assertNonEmpty(
    input.hypothesis.hypothesisId,
    "Event Hypothesis hypothesisId",
  );
  assertNonEmpty(input.hypothesis.clusterRef, "Event Hypothesis clusterRef");
  assertNonEmpty(
    input.hypothesis.titleSuggestion,
    "Event Hypothesis titleSuggestion",
  );
  assertNonEmpty(input.hypothesis.summary, "Event Hypothesis summary");
  if (input.hypothesis.titleSuggestion !== input.proposalPayload.title) {
    throw new TypeError("Proposal title must preserve Event Hypothesis title");
  }
  if (
    input.hypothesis.actuality !== input.proposalPayload.actuality ||
    input.hypothesis.significance !== input.proposalPayload.significance ||
    input.actuality !== input.proposalPayload.actuality ||
    input.significance !== input.proposalPayload.significance
  ) {
    throw new TypeError(
      "actuality/significance must preserve the Event Hypothesis and Proposal",
    );
  }
  if (input.hypothesis.semanticType !== input.proposalPayload.semanticType) {
    throw new TypeError(
      "semanticType must preserve the Event Hypothesis and Proposal",
    );
  }
  assertNonEmpty(input.attribution, "Adapter attribution");
  assertNonEmpty(input.narrativeFrame, "Adapter narrativeFrame");
  if (
    !input.mergedObservations.some(
      (observation) =>
        observation.assertion.attribution === input.attribution &&
        observation.assertion.narrativeFrame === input.narrativeFrame,
    )
  ) {
    throw new TypeError(
      "attribution and narrativeFrame must be present in merged Observations",
    );
  }
  if (input.existingEventMatch.status === "already-satisfied") {
    throw new TypeError(
      "already-satisfied Existing Event matches cannot emit an add Proposal",
    );
  }
  if (input.existingEventMatch.status === "probable-duplicate") {
    assertStringArray(
      input.existingEventMatch.candidates,
      "Existing Event match candidates",
      1,
    );
    assertStringArray(
      input.existingEventMatch.reasons,
      "Existing Event match reasons",
      1,
    );
  }
  assertObservationProvenance(input);
  assertEvidenceProvenance(input);
  assertMaterialBasis(input);
  assertRevealBasis(input.proposalPayload, input.revealBasis);
}

function buildEvidenceSet(
  anchors: readonly ResolvedEvidenceAnchor[],
  proposal: CreateChronicleEventProposalPayloadV1,
): readonly EvidenceSetEntry[] {
  const byId = new Map(anchors.map((anchor) => [anchor.id, anchor] as const));
  return proposal.evidenceAnchorIds.map((anchorId) => {
    const anchor = byId.get(anchorId);
    if (!anchor)
      throw new TypeError(`Missing resolved Evidence Anchor '${anchorId}'`);
    return {
      evidenceRef: anchor.id,
      documentRef: anchor.documentRef,
      quote: anchor.quote,
      quoteDigest: anchor.quoteDigest,
      sourceKey: anchor.sourceRef,
    };
  });
}

function buildSemanticPayload(
  input: ChronicleSceneEventAdapterInput,
): ChronicleSceneEventSemanticPayloadV1 {
  return {
    eventId: input.proposalPayload.eventId,
    summary: input.hypothesis.summary,
    actuality: input.actuality,
    significance: input.significance,
    attribution: input.attribution,
    narrativeFrame: input.narrativeFrame,
    observationRefs: [...input.hypothesis.observationRefs],
    originalObservationRefs: [...input.originalObservationRefs],
    mergedObservationRefs: [...input.mergedObservationRefs],
    observationSummaries: input.mergedObservations.map((observation) => ({
      observationRef: observation.localId,
      predicate: observation.payload.predicate,
      ...(observation.payload.semanticType
        ? { semanticType: observation.payload.semanticType }
        : {}),
      participants: observation.payload.participants,
      ...(observation.payload.locationSurface
        ? { locationSurface: observation.payload.locationSurface }
        : {}),
      temporalExpressions: observation.payload.temporalExpressions,
      durationKind: observation.payload.durationKind,
    })),
    ...(input.proposalPayload.semanticType
      ? { semanticType: input.proposalPayload.semanticType }
      : {}),
  };
}

function assertSemanticPayload(
  value: unknown,
): asserts value is ChronicleSceneEventSemanticPayloadV1 {
  if (!isRecord(value))
    throw new TypeError("Assertion payload must be an object");
  assertExactKeys(
    value,
    [
      "eventId",
      "summary",
      "actuality",
      "significance",
      "attribution",
      "narrativeFrame",
      "observationRefs",
      "originalObservationRefs",
      "mergedObservationRefs",
      "observationSummaries",
      "semanticType",
    ],
    "Assertion payload",
  );
  assertNonEmpty(value.eventId, "Assertion payload.eventId");
  assertNonEmpty(value.summary, "Assertion payload.summary");
  if (!VALID_ACTUALITIES.has(value.actuality as ChronicleEventActuality)) {
    throw new TypeError("Assertion payload.actuality is unsupported");
  }
  if (
    !VALID_SIGNIFICANCES.has(value.significance as ChronicleEventSignificance)
  ) {
    throw new TypeError("Assertion payload.significance is unsupported");
  }
  assertAttribution(value.attribution, "Assertion payload.attribution");
  assertNarrativeFrame(
    value.narrativeFrame,
    "Assertion payload.narrativeFrame",
  );
  assertUniqueStringArray(
    value.observationRefs,
    "Assertion payload.observationRefs",
    1,
  );
  assertUniqueStringArray(
    value.originalObservationRefs,
    "Assertion payload.originalObservationRefs",
    1,
  );
  assertUniqueStringArray(
    value.mergedObservationRefs,
    "Assertion payload.mergedObservationRefs",
    1,
  );
  if (
    !Array.isArray(value.observationSummaries) ||
    value.observationSummaries.length === 0
  ) {
    throw new TypeError("Assertion payload.observationSummaries is required");
  }
  for (const summary of value.observationSummaries) {
    if (!isRecord(summary))
      throw new TypeError("Assertion observation summary must be an object");
    assertExactKeys(
      summary,
      [
        "observationRef",
        "predicate",
        "semanticType",
        "participants",
        "locationSurface",
        "temporalExpressions",
        "durationKind",
      ],
      "Assertion observation summary",
    );
    assertNonEmpty(summary.observationRef, "Assertion observationRef");
    assertNonEmpty(summary.predicate, "Assertion predicate");
    if (summary.semanticType !== undefined)
      assertNonEmpty(summary.semanticType, "Assertion semanticType");
    if (!Array.isArray(summary.participants))
      throw new TypeError("Assertion participants must be an array");
    for (const participant of summary.participants) {
      if (!isRecord(participant))
        throw new TypeError("Assertion participant must be an object");
      assertExactKeys(
        participant,
        ["surface", "role"],
        "Assertion participant",
      );
      assertNonEmpty(participant.surface, "Assertion participant surface");
      assertNonEmpty(participant.role, "Assertion participant role");
    }
    if (summary.locationSurface !== undefined)
      assertNonEmpty(summary.locationSurface, "Assertion locationSurface");
    assertStringArray(
      summary.temporalExpressions,
      "Assertion temporalExpressions",
    );
    if (!VALID_DURATION_KINDS.has(summary.durationKind as string))
      throw new TypeError("Assertion durationKind is unsupported");
  }
  if (value.semanticType !== undefined)
    assertNonEmpty(value.semanticType, "Assertion semanticType");
}

function invalidAdapterResult(
  reason: Extract<NarrativeIrValidationResult, { valid: false }>["reason"],
  path: string,
): NarrativeIrValidationResult {
  return { valid: false, reason, path };
}

export function validateChronicleSceneEventV2(
  value: unknown,
): NarrativeIrValidationResult {
  const structural = validateNarrativeRevisionEnvelopeV2(value);
  if (!structural.valid) return structural;
  if (!isRecord(value))
    return invalidAdapterResult("envelope-must-be-object", "envelope");
  const envelope = value as unknown as ChronicleSceneEventRevision;
  if (envelope.assertion.assertionKind !== "scene-event@1") {
    return invalidAdapterResult(
      "unsupported-assertion-kind",
      "assertion.assertionKind",
    );
  }
  if (envelope.changeIntent.changeKind !== "add") {
    return invalidAdapterResult(
      "unsupported-change-kind",
      "changeIntent.changeKind",
    );
  }
  if (Object.hasOwn(envelope.changeIntent, "targetProjectionRef")) {
    return invalidAdapterResult(
      "target-projection-forbidden",
      "changeIntent.targetProjectionRef",
    );
  }
  if (!isRecord(envelope.assertion.payload)) {
    return invalidAdapterResult(
      "invalid-payload-schema-ref",
      "assertion.payload",
    );
  }
  if (
    envelope.assertion.payloadSchemaRef.id !==
      CHRONICLE_SCENE_EVENT_ASSERTION_SCHEMA_REF.id ||
    envelope.assertion.payloadSchemaRef.version !==
      CHRONICLE_SCENE_EVENT_ASSERTION_SCHEMA_REF.version
  ) {
    return invalidAdapterResult(
      "invalid-payload-schema-ref",
      "assertion.payloadSchemaRef",
    );
  }
  try {
    assertSemanticPayload(envelope.assertion.payload);
  } catch {
    return invalidAdapterResult(
      "invalid-payload-schema-ref",
      "assertion.payload",
    );
  }
  if (
    Object.hasOwn(envelope.assertion.payload, "disclosure") ||
    Object.hasOwn(envelope.assertion.payload, "secret") ||
    Object.hasOwn(envelope.assertion.payload, "revealDocumentRef")
  ) {
    return invalidAdapterResult(
      "invalid-payload-schema-ref",
      "assertion.payload",
    );
  }
  if (
    envelope.projectionBinding.proposalKind !== CHRONICLE_EVENT_PROPOSAL_KIND ||
    envelope.projectionBinding.proposalSchemaRef.id !==
      CHRONICLE_SCENE_EVENT_PROPOSAL_SCHEMA_REF.id ||
    envelope.projectionBinding.proposalSchemaRef.version !==
      CHRONICLE_SCENE_EVENT_PROPOSAL_SCHEMA_REF.version ||
    envelope.projectionBinding.adapterContractId !==
      CHRONICLE_SCENE_EVENT_ADAPTER_ID ||
    envelope.projectionBinding.adapterContractVersion !==
      CHRONICLE_SCENE_EVENT_ADAPTER_VERSION
  ) {
    return invalidAdapterResult(
      "invalid-projection-binding",
      "projectionBinding",
    );
  }
  return { valid: true };
}

export function assertChronicleSceneEventV2(
  value: unknown,
): asserts value is ChronicleSceneEventRevision {
  const result = validateChronicleSceneEventV2(value);
  if (!result.valid) {
    throw new TypeError(
      `Invalid Chronicle scene-event@1 V2 Adapter object at ${result.path ?? "envelope"}: ${result.reason}`,
    );
  }
}

export async function buildChronicleSceneEventV2(
  input: ChronicleSceneEventAdapterInput,
): Promise<ChronicleSceneEventAdapterResult> {
  await assertAdapterInput(input);
  const scopeResult = await deriveChronicleSceneEventScope({
    sceneRef: input.sceneRef,
    proposalPayload: input.proposalPayload,
    revealBasis: input.revealBasis,
  });
  const evidenceSet = buildEvidenceSet(
    input.evidenceAnchors,
    input.proposalPayload,
  );
  const canonicalContextSet = canonicalizeChronicleContextSet(
    input.contextManifests,
    NARRATIVE_STAGE_IDS.eventSynthesis,
  );
  const computedContextSetDigest = await digestChronicleContextSet(
    canonicalContextSet,
    NARRATIVE_STAGE_IDS.eventSynthesis,
  );
  if (computedContextSetDigest !== input.execution.contextSetDigest) {
    throw new TypeError(
      "Adapter contextSetDigest does not match the canonical E2 Context Set",
    );
  }
  const producer = {
    kind: "reconciler-proposal" as const,
    id: input.execution.reconcilerId,
    version: input.execution.reconcilerVersion,
  };
  const semanticPayload = buildSemanticPayload(input);
  assertSemanticPayload(semanticPayload);
  const assertionPayloadSchemaRef = {
    ...CHRONICLE_SCENE_EVENT_ASSERTION_SCHEMA_REF,
  };
  const assertionCoreDigest = await digestStableJson({
    assertionKind: "scene-event@1",
    payloadSchemaRef: assertionPayloadSchemaRef,
    typedSemanticPayload: semanticPayload,
    modality: "modality-inference",
    polarity: "affirmative",
    supportClass: "direct-source",
    producer,
  });
  const assertionDigest = await digestStableJson({
    assertionCoreDigest,
    scopeDigest: scopeResult.digest,
  });
  const dependencySetDigest = await digestStableJson(
    input.dependencyDeclarations,
  );
  const contextSetDigest = input.execution.contextSetDigest;
  const materialBasisDigest = await digestStableJson({
    sourceBasis: input.sourceBasis,
    evidenceSet,
    dependencySet: input.dependencyDeclarations,
  });
  const proposalPayloadDigest = await digestStableJson(input.proposalPayload);
  const projectionBinding: NarrativeProjectionBindingV2 = {
    proposalKind: CHRONICLE_EVENT_PROPOSAL_KIND,
    proposalSchemaRef: { ...CHRONICLE_SCENE_EVENT_PROPOSAL_SCHEMA_REF },
    proposalPayloadDigest,
    adapterContractId: CHRONICLE_SCENE_EVENT_ADAPTER_ID,
    adapterContractVersion: CHRONICLE_SCENE_EVENT_ADAPTER_VERSION,
  };
  const envelope: ChronicleSceneEventRevision = {
    schemaVersion: 2,
    assertion: {
      assertionId: null,
      assertionKind: "scene-event@1",
      payloadSchemaRef: assertionPayloadSchemaRef,
      payload: semanticPayload,
      scope: scopeResult.scope,
      modality: "modality-inference",
      polarity: "affirmative",
      supportClass: "direct-source",
      producer,
    },
    assertionDigests: {
      assertionCoreDigest,
      scopeDigest: scopeResult.digest,
      assertionDigest,
    },
    changeIntent: { changeKind: "add" },
    effectiveMaterialBasis: {
      sourceBasis: input.sourceBasis,
      evidenceSet,
      dependencySet: input.dependencyDeclarations,
      dependencySetDigest,
      materialBasisDigest,
    },
    revisionBasis: {
      kind: "interpretation",
      runId: input.execution.runId,
      taskId: input.execution.taskId,
      producer,
      contextSet: canonicalContextSet,
      contextSetDigest,
      componentContractDigest: input.execution.componentContractDigest,
      finalRequestDigest: input.execution.finalRequestDigest,
    },
    projectionBinding,
  };
  assertChronicleSceneEventV2(envelope);
  await assertChronicleStageProvenanceReachability({
    execution: input.execution,
    closure: input.stageProvenanceClosure,
    provenanceBinding: input.provenanceBinding,
    envelope,
  });
  return {
    envelope,
    proposalPayload: input.proposalPayload,
    proposalPayloadDigest,
    scope: scopeResult.scope,
    canonicalScopeJson: scopeResult.canonicalJson,
    existingEventMatch: input.existingEventMatch,
    stageProvenanceClosure: input.stageProvenanceClosure,
    provenanceBinding: input.provenanceBinding,
  };
}

export const adaptChronicleSceneEventToV2 = buildChronicleSceneEventV2;
