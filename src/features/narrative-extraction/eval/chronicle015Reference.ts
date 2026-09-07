import correctSetupObservation from "../../../../evals/narrative/reference-predictions/chronicle-015-v1/correct/setup-observation.json";
import correctUseObservation from "../../../../evals/narrative/reference-predictions/chronicle-015-v1/correct/use-observation.json";
import correctSynthesis from "../../../../evals/narrative/reference-predictions/chronicle-015-v1/correct/synthesis.json";
import wrongMeaningSetupObservation from "../../../../evals/narrative/reference-predictions/chronicle-015-v1/wrong-meaning/setup-observation.json";
import wrongMeaningUseObservation from "../../../../evals/narrative/reference-predictions/chronicle-015-v1/wrong-meaning/use-observation.json";
import wrongMeaningSynthesis from "../../../../evals/narrative/reference-predictions/chronicle-015-v1/wrong-meaning/synthesis.json";
import invalidDurationSetupObservation from "../../../../evals/narrative/reference-predictions/chronicle-015-v1/invalid-duration/setup-observation.json";
import invalidDurationUseObservation from "../../../../evals/narrative/reference-predictions/chronicle-015-v1/invalid-duration/use-observation.json";
import { runEventSynthesisTask } from "@/application/narrative-extraction/aiTasks/runEventSynthesisTask";
import { runObservationExtractionTask } from "@/application/narrative-extraction/aiTasks/runObservationExtractionTask";
import { rekeyObservationsForWindow } from "@/features/chronicle/extraction/windowExtractor";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import {
  evaluateProductionChronicleArtifacts,
  prepareProductionChronicleEvalCase,
  runProductionChroniclePipeline,
} from "./productionChronicleAdapter";
import type {
  PreparedProductionChronicleEvalCase,
  ProductionChronicleArtifacts,
  ProductionChronicleEvaluation,
} from "./productionChronicleTypes";
import type { NarrativeEvalCaseV1 } from "./types";

export const CHRONICLE_015_CASE_ID =
  "chronicle.micro.sword-recovered-015" as const;
export const CHRONICLE_015_QUOTE =
  "ミナは壁の儀礼剣を引き抜き、捕虜を縛る縄を切った。" as const;

const EXPECTED_WINDOWS = [
  {
    sourceRef: "S0001",
    documentId: "scene-sword-setup-recovered",
    text: "謁見の間の壁には、刃こぼれした儀礼剣が一本掛けられていた。柄には王家の紋章が刻まれ、長いあいだ誰も触れていなかった。",
  },
  {
    sourceRef: "S0002",
    documentId: "scene-sword-use-recovered",
    text: "火の粉が梁へ移り、地下牢の出口が塞がれかけた。ミナは壁の儀礼剣を引き抜き、捕虜を縛る縄を切った。捕虜は煙の薄い階段へ逃れた。",
  },
] as const;

const SOURCE_REF_PLACEHOLDER = "__SOURCE_REF_USE__";
const CLUSTER_REF_PLACEHOLDER = "__CLUSTER_REF__";
const OBSERVATION_REF_PLACEHOLDER = "__OBSERVATION_REF_1__";
const PLACEHOLDER_PATTERN = /^__[A-Z0-9_]+__$/;

export type Chronicle015ReferenceVariant =
  | "correct"
  | "wrong-meaning"
  | "invalid-duration";

export type Chronicle015ObservedResult = "PASS" | "FAIL";
export type Chronicle015IntendedSemanticVerdict =
  | "PASS"
  | "FAIL"
  | "NOT_EVALUATED";
export type Chronicle015SemanticRequirementStatus = "PASS" | "HOLD";

export interface Chronicle015StageTrace {
  readonly observationCalls: number;
  readonly observationSends: number;
  readonly synthesisCalls: number;
  readonly synthesisSends: number;
  readonly observationParseStatuses: readonly ("parsed" | "invalid")[];
  readonly synthesisParseStatuses: readonly ("parsed" | "invalid")[];
  readonly observationWindows: readonly {
    readonly sourceRef: string;
    readonly text: string;
  }[];
  readonly synthesisInputs: readonly {
    readonly clusterRef: string;
    readonly observationRefs: readonly string[];
  }[];
}

export interface Chronicle015ReferenceReport {
  readonly caseId: typeof CHRONICLE_015_CASE_ID;
  readonly variant: Chronicle015ReferenceVariant;
  readonly counts: {
    readonly observations: number;
    readonly unresolvedEvidence: number;
    readonly hypotheses: number;
    readonly proposals: number;
    readonly parseFailures: number;
  };
  /** Persistence is not instrumented by this proposal-planning-only runner. */
  readonly persistenceEvidence: "not-instrumented; proposal-planning-only runner";
  readonly stages: Chronicle015StageTrace;
  readonly observedScorerResult: Chronicle015ObservedResult;
  /** Human-reviewed expected semantic verdict, not model evidence. */
  readonly intendedSemanticVerdict: Chronicle015IntendedSemanticVerdict;
  /** Human-reviewed requirement status, not a legacy scorer result. */
  readonly semanticRequirement: Chronicle015SemanticRequirementStatus;
  readonly semanticNote: string;
}

export interface Chronicle015ReferenceRun {
  readonly variant: Chronicle015ReferenceVariant;
  /** The unchanged Human Gold case used only by the production evaluator. */
  readonly evalCase: NarrativeEvalCaseV1;
  readonly prepared: PreparedProductionChronicleEvalCase;
  readonly artifacts: ProductionChronicleArtifacts;
  readonly evaluation: ProductionChronicleEvaluation;
  readonly trace: Chronicle015StageTrace;
  readonly report: Chronicle015ReferenceReport;
}

export interface Chronicle015SynthesisBindingInput {
  readonly clusterRef: string;
  readonly expectedObservationRefs: readonly string[];
  readonly expectedSourceRef: string;
  readonly observations: readonly RawChronicleEventObservation[];
}

type MutableJsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is MutableJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Chronicle 015 reference binding failed: ${message}`);
}

function requireRecord(value: unknown, path: string): MutableJsonObject {
  if (!isRecord(value)) fail(`${path} must be an object`);
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} must be a string`);
  return value;
}

function cloneJson(value: unknown): MutableJsonObject {
  let cloned: unknown;
  try {
    cloned = JSON.parse(JSON.stringify(value)) as unknown;
  } catch (error) {
    fail(`fixed response is not JSON: ${String(error)}`);
  }
  return requireRecord(cloned, "response");
}

function childPath(path: string, key: string): string {
  return path === "$" ? key : `${path}.${key}`;
}

function arrayPath(path: string, index: number): string {
  return `${path}[${index}]`;
}

function assertNoReservedRawKeys(
  value: unknown,
  path = "$",
  seen = new Set<object>(),
): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoReservedRawKeys(item, arrayPath(path, index), seen),
    );
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === "semanticKey" || key === "proposalGate") {
      fail(
        `raw response contains reserved Gold key at ${childPath(path, key)}`,
      );
    }
    assertNoReservedRawKeys(nested, childPath(path, key), seen);
  }
}

function assertNoPlaceholderLeakage(
  value: unknown,
  allowedPaths: ReadonlySet<string>,
  path = "$",
  seen = new Set<object>(),
): void {
  if (typeof value === "string") {
    if (PLACEHOLDER_PATTERN.test(value) && !allowedPaths.has(path)) {
      fail(`unbound placeholder at ${path}`);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoPlaceholderLeakage(
        item,
        allowedPaths,
        arrayPath(path, index),
        seen,
      ),
    );
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    assertNoPlaceholderLeakage(
      nested,
      allowedPaths,
      childPath(path, key),
      seen,
    );
  }
}

/** Fail-closed check of the exact two Source View windows for case 015. */
export function assertChronicle015PreparedWindows(
  prepared: PreparedProductionChronicleEvalCase,
): void {
  if (prepared.windows.length !== EXPECTED_WINDOWS.length) {
    fail(
      `expected exactly ${EXPECTED_WINDOWS.length} source windows, got ${prepared.windows.length}`,
    );
  }
  if (prepared.sourceViews.length !== EXPECTED_WINDOWS.length) {
    fail(
      `expected exactly ${EXPECTED_WINDOWS.length} source views, got ${prepared.sourceViews.length}`,
    );
  }

  const sourceRefs = new Set<string>();
  for (const [index, expected] of EXPECTED_WINDOWS.entries()) {
    const window = prepared.windows[index];
    if (!window) fail(`missing source window ${index + 1}`);
    if (sourceRefs.has(window.sourceRef)) {
      fail(`duplicate sourceRef ${window.sourceRef}`);
    }
    sourceRefs.add(window.sourceRef);
    if (window.sourceRef !== expected.sourceRef) {
      fail(
        `source window ${index + 1} ref must be ${expected.sourceRef}, got ${window.sourceRef}`,
      );
    }
    if (window.text !== expected.text) {
      fail(`source window ${window.sourceRef} text is not exact`);
    }
    if (
      prepared.documentIdBySourceRef.get(window.sourceRef) !==
      expected.documentId
    ) {
      fail(`sourceRef ${window.sourceRef} is bound to the wrong document`);
    }
    if (prepared.textBySourceRef.get(window.sourceRef) !== expected.text) {
      fail(`textBySourceRef for ${window.sourceRef} is not exact`);
    }
    const sourceView = prepared.sourceViews.find(
      (candidate) => candidate.ref === window.sourceRef,
    );
    if (!sourceView || sourceView.text !== expected.text) {
      fail(`source view ${window.sourceRef} is missing or has different text`);
    }
  }
  if (sourceRefs.size !== EXPECTED_WINDOWS.length) {
    fail("source window refs are not unique");
  }
  if (
    prepared.allowedSourceRefs.size !== EXPECTED_WINDOWS.length ||
    [...prepared.allowedSourceRefs].some((ref) => !sourceRefs.has(ref))
  ) {
    fail("allowed source refs contain a missing or extra ref");
  }
}

/** Bind only the designated sourceRef field in a fixed observation response. */
export function bindChronicle015ObservationResponse(
  raw: unknown,
  sourceRef: string,
): MutableJsonObject {
  if (!/^S\d{4}$/.test(sourceRef))
    fail(`runtime sourceRef is invalid: ${sourceRef}`);
  const response = cloneJson(raw);
  assertNoReservedRawKeys(response);
  assertNoPlaceholderLeakage(
    response,
    new Set(["observations[0].evidence[0].sourceRef"]),
  );
  const observations = requireArray(response.observations, "observations");
  if (observations.length === 0) return response;
  if (observations.length !== 1) {
    fail(
      `observation response must contain one row, got ${observations.length}`,
    );
  }
  const observation = requireRecord(observations[0], "observations[0]");
  if (
    requireString(observation.localId, "observations[0].localId") !== "obs-1"
  ) {
    fail("fixed observation localId must be obs-1");
  }
  const evidence = requireArray(
    observation.evidence,
    "observations[0].evidence",
  );
  if (evidence.length !== 1) {
    fail(
      `fixed observation must contain one evidence row, got ${evidence.length}`,
    );
  }
  const evidenceRow = requireRecord(evidence[0], "observations[0].evidence[0]");
  if (
    requireString(
      evidenceRow.sourceRef,
      "observations[0].evidence[0].sourceRef",
    ) !== SOURCE_REF_PLACEHOLDER
  ) {
    fail("fixed observation sourceRef must use the designated placeholder");
  }
  if (
    requireString(evidenceRow.quote, "observations[0].evidence[0].quote") !==
    CHRONICLE_015_QUOTE
  ) {
    fail("fixed observation quote is not the canonical case 015 quote");
  }
  evidenceRow.sourceRef = sourceRef;
  return response;
}

/** Validate the complete runtime observation set before synthesis binding. */
export function assertChronicle015SynthesisInput(
  input: Chronicle015SynthesisBindingInput,
): string {
  if (!input.clusterRef || PLACEHOLDER_PATTERN.test(input.clusterRef)) {
    fail("synthesis clusterRef is missing or still a placeholder");
  }
  if (input.expectedSourceRef !== EXPECTED_WINDOWS[1].sourceRef) {
    fail(`synthesis sourceRef must be ${EXPECTED_WINDOWS[1].sourceRef}`);
  }
  const actualIds = input.observations.map(
    (observation) => observation.localId,
  );
  if (new Set(actualIds).size !== actualIds.length) {
    fail("synthesis observations contain duplicate localIds");
  }
  if (
    new Set(input.expectedObservationRefs).size !==
    input.expectedObservationRefs.length
  ) {
    fail("expected runtime observation refs contain duplicates");
  }
  if (input.expectedObservationRefs.length !== 1) {
    fail(
      `synthesis must bind one expected runtime observation, got ${input.expectedObservationRefs.length}`,
    );
  }
  if (input.observations.length !== input.expectedObservationRefs.length) {
    fail(
      `synthesis observations contain missing or extra rows: ${input.observations.length}`,
    );
  }
  const expectedRef = input.expectedObservationRefs[0];
  const observation = input.observations[0];
  if (!observation || observation.localId !== expectedRef) {
    fail("synthesis observation ref is unknown or out of order");
  }
  if (!observation.localId || PLACEHOLDER_PATTERN.test(observation.localId)) {
    fail("runtime observation localId is missing or still a placeholder");
  }
  if (observation.evidence.length !== 1) {
    fail(
      `synthesis observation must contain one evidence row, got ${observation.evidence.length}`,
    );
  }
  const evidence = observation.evidence[0];
  if (
    evidence.sourceRef !== input.expectedSourceRef ||
    evidence.quote !== CHRONICLE_015_QUOTE
  ) {
    fail(
      "synthesis observation evidence does not match the expected runtime window",
    );
  }
  return expectedRef;
}

/** Bind only clusterRef and the one known observationRefs slot. */
export function bindChronicle015SynthesisResponse(
  raw: unknown,
  input: Chronicle015SynthesisBindingInput,
): MutableJsonObject {
  const runtimeObservationRef = assertChronicle015SynthesisInput(input);
  const response = cloneJson(raw);
  assertNoReservedRawKeys(response);
  assertNoPlaceholderLeakage(
    response,
    new Set(["clusterRef", "events[0].observationRefs[0]"]),
  );
  if (response.clusterRef !== CLUSTER_REF_PLACEHOLDER) {
    fail("fixed synthesis clusterRef must use the designated placeholder");
  }
  const events = requireArray(response.events, "events");
  if (events.length !== 1)
    fail(`fixed synthesis must contain one event, got ${events.length}`);
  const event = requireRecord(events[0], "events[0]");
  const observationRefs = requireArray(
    event.observationRefs,
    "events[0].observationRefs",
  );
  if (
    observationRefs.length !== 1 ||
    observationRefs[0] !== OBSERVATION_REF_PLACEHOLDER
  ) {
    fail(
      "fixed synthesis must contain exactly the designated observation ref placeholder",
    );
  }
  response.clusterRef = input.clusterRef;
  observationRefs[0] = runtimeObservationRef;
  return response;
}

function fixedObservationResponse(
  variant: Chronicle015ReferenceVariant,
  windowIndex: number,
): unknown {
  if (windowIndex === 0) {
    if (variant === "correct") return correctSetupObservation;
    if (variant === "wrong-meaning") return wrongMeaningSetupObservation;
    return invalidDurationSetupObservation;
  }
  if (variant === "correct") return correctUseObservation;
  if (variant === "wrong-meaning") return wrongMeaningUseObservation;
  return invalidDurationUseObservation;
}

function fixedSynthesisResponse(
  variant: Chronicle015ReferenceVariant,
): unknown {
  if (variant === "correct") return correctSynthesis;
  if (variant === "wrong-meaning") return wrongMeaningSynthesis;
  fail("invalid-duration must not request a synthesis response");
}

function assertEqualJson(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} does not match the fixed response`);
  }
}

function assertObservationArtifactMatchesFixed(
  observation: RawChronicleEventObservation,
  fixedResponse: unknown,
  sourceRef: string,
): void {
  const response = cloneJson(fixedResponse);
  const rows = requireArray(response.observations, "observations");
  const rawObservation = requireRecord(rows[0], "observations[0]");
  const rawEvidence = requireArray(
    rawObservation.evidence,
    "observations[0].evidence",
  );
  const rawEvidenceRow = requireRecord(
    rawEvidence[0],
    "observations[0].evidence[0]",
  );
  assertEqualJson(
    observation.evidence,
    [{ sourceRef, quote: requireString(rawEvidenceRow.quote, "quote") }],
    "observation evidence",
  );
  assertEqualJson(
    observation.assertion,
    rawObservation.assertion,
    "observation assertion",
  );
  const rawPayload = requireRecord(
    rawObservation.payload,
    "observations[0].payload",
  );
  assertEqualJson(
    {
      predicate: observation.payload.predicate,
      actuality: observation.payload.actuality,
      participants: observation.payload.participants,
      temporalExpressions: observation.payload.temporalExpressions,
      durationKind: observation.payload.durationKind,
    },
    {
      predicate: rawPayload.predicate,
      actuality: rawPayload.actuality,
      participants: rawPayload.participants,
      temporalExpressions: rawPayload.temporalExpressions,
      durationKind: rawPayload.durationKind,
    },
    "observation payload",
  );
}

function assertSynthesisArtifactMatchesFixed(
  hypothesis: ProductionChronicleArtifacts["hypotheses"][number],
  fixedResponse: unknown,
  clusterRef: string,
  observationRef: string,
): void {
  const response = cloneJson(fixedResponse);
  const events = requireArray(response.events, "events");
  const event = requireRecord(events[0], "events[0]");
  if (hypothesis.clusterRef !== clusterRef)
    fail("hypothesis clusterRef was not preserved");
  assertEqualJson(
    hypothesis.observationRefs,
    [observationRef],
    "hypothesis observationRefs",
  );
  assertEqualJson(
    hypothesis.titleSuggestion,
    event.titleSuggestion,
    "hypothesis title",
  );
  assertEqualJson(hypothesis.summary, event.summary, "hypothesis summary");
  assertEqualJson(
    hypothesis.actuality,
    event.actuality,
    "hypothesis actuality",
  );
  assertEqualJson(
    hypothesis.significance,
    event.significance,
    "hypothesis significance",
  );
}

function assertReferenceArtifacts(
  variant: Chronicle015ReferenceVariant,
  artifacts: ProductionChronicleArtifacts,
  trace: Chronicle015StageTrace,
  runtimeObservationRefs: readonly string[],
  boundSynthesisResponses: readonly MutableJsonObject[],
): void {
  const invalid = variant === "invalid-duration";
  const expectedObservationCount = invalid ? 0 : 1;
  if (artifacts.observations.length !== expectedObservationCount) {
    fail(`unexpected observation count: ${artifacts.observations.length}`);
  }
  if (artifacts.unresolvedEvidenceCount !== 0)
    fail("evidence unexpectedly remained unresolved");
  if (artifacts.parseFailureCount !== (invalid ? 1 : 0)) {
    fail(`unexpected parse failure count: ${artifacts.parseFailureCount}`);
  }
  if (invalid) {
    if (artifacts.anchors.length !== 0 || artifacts.clusters.length !== 0) {
      fail("invalid-duration unexpectedly produced evidence or a cluster");
    }
    if (
      artifacts.hypotheses.length !== 0 ||
      artifacts.plannedProposals.length !== 0
    ) {
      fail("invalid-duration was treated as a valid empty extraction");
    }
    if (trace.synthesisCalls !== 0 || boundSynthesisResponses.length !== 0) {
      fail("invalid-duration unexpectedly called synthesis");
    }
    return;
  }

  if (
    artifacts.anchors.length !== 1 ||
    artifacts.clusters.length !== 1 ||
    artifacts.hypotheses.length !== 1 ||
    artifacts.plannedProposals.length !== 1
  ) {
    fail(
      "valid fixture did not produce exactly one anchor, cluster, hypothesis, and proposal",
    );
  }
  if (runtimeObservationRefs.length !== 1) {
    fail(
      "valid fixture did not produce exactly one captured runtime observation ref",
    );
  }
  const observation = artifacts.observations[0];
  if (!observation || observation.localId !== runtimeObservationRefs[0]) {
    fail(
      "artifact observation localId does not match the captured production mapping",
    );
  }
  assertObservationArtifactMatchesFixed(
    observation,
    fixedObservationResponse(variant, 1),
    EXPECTED_WINDOWS[1].sourceRef,
  );
  const cluster = artifacts.clusters[0];
  if (
    !cluster ||
    cluster.observationRefs.length !== 1 ||
    cluster.observationRefs[0] !== observation.localId
  ) {
    fail("cluster does not contain exactly the runtime observation");
  }
  const hypothesis = artifacts.hypotheses[0];
  if (!hypothesis || boundSynthesisResponses.length !== 1) {
    fail("synthesis artifact is missing");
  }
  assertSynthesisArtifactMatchesFixed(
    hypothesis,
    boundSynthesisResponses[0],
    cluster.clusterRef,
    observation.localId,
  );
}

function buildReferenceReport(
  variant: Chronicle015ReferenceVariant,
  artifacts: ProductionChronicleArtifacts,
  evaluation: ProductionChronicleEvaluation,
  trace: Chronicle015StageTrace,
): Chronicle015ReferenceReport {
  const intendedSemanticVerdict: Chronicle015IntendedSemanticVerdict =
    variant === "correct"
      ? "PASS"
      : variant === "wrong-meaning"
        ? "FAIL"
        : "NOT_EVALUATED";
  const semanticRequirement: Chronicle015SemanticRequirementStatus =
    variant === "correct" ? "PASS" : "HOLD";
  const semanticNote =
    variant === "wrong-meaning"
      ? "Legacy scorer observes PASS because it aligns by evidence and does not compare predicate/roles; the manually reviewed intended semantic verdict remains FAIL and the requirement is HOLD."
      : variant === "invalid-duration"
        ? "Format failure is not a valid empty extraction; canonical synthesis is not called. The legacy scorer returns FAIL for the empty artifact but does not provide a semantic verdict; the manually reviewed intended verdict and requirement are NOT_EVALUATED/HOLD."
        : "Human-approved semantic intent is PASS; legacy scorer PASS alone does not prove predicate/participant-role semantics. intendedSemanticVerdict and semanticRequirement are manually reviewed expectations, not model evidence.";
  return {
    caseId: CHRONICLE_015_CASE_ID,
    variant,
    counts: {
      observations: artifacts.observations.length,
      unresolvedEvidence: artifacts.unresolvedEvidenceCount,
      hypotheses: artifacts.hypotheses.length,
      proposals: artifacts.plannedProposals.length,
      parseFailures: artifacts.parseFailureCount,
    },
    persistenceEvidence: "not-instrumented; proposal-planning-only runner",
    stages: trace,
    observedScorerResult: evaluation.passed ? "PASS" : "FAIL",
    intendedSemanticVerdict,
    semanticRequirement,
    semanticNote,
  };
}

/** Run one fixed 015 response variant through the canonical production seam. */
export async function runChronicle015ReferenceCase(
  evalCase: NarrativeEvalCaseV1,
  variant: Chronicle015ReferenceVariant,
): Promise<Chronicle015ReferenceRun> {
  if (evalCase.id !== CHRONICLE_015_CASE_ID) {
    fail(`expected Gold case ${CHRONICLE_015_CASE_ID}, got ${evalCase.id}`);
  }
  const prepared = await prepareProductionChronicleEvalCase(evalCase);
  assertChronicle015PreparedWindows(prepared);

  const mutableTrace = {
    observationCalls: 0,
    observationSends: 0,
    synthesisCalls: 0,
    synthesisSends: 0,
    observationParseStatuses: [] as ("parsed" | "invalid")[],
    synthesisParseStatuses: [] as ("parsed" | "invalid")[],
    observationWindows: [] as { sourceRef: string; text: string }[],
    synthesisInputs: [] as { clusterRef: string; observationRefs: string[] }[],
  };
  const runtimeObservationRefs: string[] = [];
  const boundSynthesisResponses: MutableJsonObject[] = [];
  let idIndex = 0;

  const artifacts = await runProductionChroniclePipeline(prepared, {
    createId: () => `chronicle-015-runtime-${++idIndex}`,
    observeWithAi: async (input) => {
      const callIndex = mutableTrace.observationCalls;
      mutableTrace.observationCalls += 1;
      if (callIndex >= EXPECTED_WINDOWS.length) {
        fail("observation stage was called for an extra source window");
      }
      if (input.windows.length !== 1) {
        fail(
          `observation stage must receive one source window, got ${input.windows.length}`,
        );
      }
      const window = input.windows[0];
      if (!window) fail("observation stage received no source window");
      const expectedWindow = EXPECTED_WINDOWS[callIndex];
      if (
        window.sourceRef !== expectedWindow.sourceRef ||
        window.text !== expectedWindow.text
      ) {
        fail(
          `observation stage input ${callIndex + 1} is not the exact prepared window`,
        );
      }
      mutableTrace.observationWindows.push({
        sourceRef: window.sourceRef,
        text: window.text,
      });
      if (input.repairOnFailure !== false) {
        fail("reference runner must disable structured repair");
      }
      const boundResponse = bindChronicle015ObservationResponse(
        fixedObservationResponse(variant, callIndex),
        window.sourceRef,
      );
      const originalOnParseStatus = input.onParseStatus;
      const observations = await runObservationExtractionTask({
        ...input,
        repairOnFailure: false,
        send: async () => {
          mutableTrace.observationSends += 1;
          return {
            text: JSON.stringify(boundResponse),
            inputTokens: 0,
            outputTokens: 0,
          };
        },
        onParseStatus: (status) => {
          mutableTrace.observationParseStatuses.push(status);
          originalOnParseStatus?.(status);
        },
      });
      const runtimeBatch = rekeyObservationsForWindow(
        `eval-window-${String(callIndex + 1).padStart(3, "0")}`,
        observations,
      );
      runtimeObservationRefs.push(
        ...runtimeBatch.map((observation) => observation.localId),
      );
      return observations;
    },
    synthesizeWithAi: async (input) => {
      mutableTrace.synthesisCalls += 1;
      if (variant === "invalid-duration") {
        fail("invalid-duration must not invoke synthesis");
      }
      const observationRefs = input.observations.map(
        (observation) => observation.localId,
      );
      mutableTrace.synthesisInputs.push({
        clusterRef: input.clusterRef,
        observationRefs,
      });
      if (input.repairOnFailure !== false) {
        fail("reference runner must disable structured repair for synthesis");
      }
      const bindingInput: Chronicle015SynthesisBindingInput = {
        clusterRef: input.clusterRef,
        expectedObservationRefs: [...runtimeObservationRefs],
        expectedSourceRef: EXPECTED_WINDOWS[1].sourceRef,
        observations: input.observations,
      };
      const boundResponse = bindChronicle015SynthesisResponse(
        fixedSynthesisResponse(variant),
        bindingInput,
      );
      boundSynthesisResponses.push(boundResponse);
      const originalOnParseStatus = input.onParseStatus;
      return runEventSynthesisTask({
        ...input,
        repairOnFailure: false,
        send: async () => {
          mutableTrace.synthesisSends += 1;
          return {
            text: JSON.stringify(boundResponse),
            inputTokens: 0,
            outputTokens: 0,
          };
        },
        onParseStatus: (status) => {
          mutableTrace.synthesisParseStatuses.push(status);
          originalOnParseStatus?.(status);
        },
      });
    },
  });

  const trace: Chronicle015StageTrace = {
    observationCalls: mutableTrace.observationCalls,
    observationSends: mutableTrace.observationSends,
    synthesisCalls: mutableTrace.synthesisCalls,
    synthesisSends: mutableTrace.synthesisSends,
    observationParseStatuses: [...mutableTrace.observationParseStatuses],
    synthesisParseStatuses: [...mutableTrace.synthesisParseStatuses],
    observationWindows: [...mutableTrace.observationWindows],
    synthesisInputs: mutableTrace.synthesisInputs.map((input) => ({
      clusterRef: input.clusterRef,
      observationRefs: [...input.observationRefs],
    })),
  };
  assertReferenceArtifacts(
    variant,
    artifacts,
    trace,
    runtimeObservationRefs,
    boundSynthesisResponses,
  );
  const evaluation = evaluateProductionChronicleArtifacts(prepared, artifacts);
  if (variant !== "invalid-duration" && !evaluation.passed) {
    fail("valid fixed response unexpectedly failed the current scorer");
  }
  if (variant === "invalid-duration" && evaluation.passed) {
    fail("invalid-duration unexpectedly passed evaluation");
  }
  const report = buildReferenceReport(variant, artifacts, evaluation, trace);
  return { variant, evalCase, prepared, artifacts, evaluation, trace, report };
}
