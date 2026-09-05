import {
  buildObservationExtractionPrompt,
  runObservationExtractionTask,
  type ObservationExtractionWindowInput,
  type ObservationExtractionSend,
} from "@/application/narrative-extraction/aiTasks/runObservationExtractionTask";
import {
  buildCitationIdObservationPromptArtifact,
  CITATION_ID_OBSERVATION_EVIDENCE_MODE,
  LEGACY_OBSERVATION_EVIDENCE_MODE,
  materializeCitationIdObservations,
  type ObservationEvidenceMode,
} from "@/application/narrative-extraction/aiTasks/citationIdObservation";
import {
  assertUniqueObservationLocalIds,
  normalizeWindowObservations,
  rekeyObservationsForWindow,
} from "@/features/chronicle/extraction/windowExtractor";
import { planExtractionWindows } from "@/features/chronicle/extraction/windowPlanner";
import {
  assertEvidenceSpanCatalogCoverage,
  bindEvidenceSpanCatalog,
  buildEvidenceSpanCatalog,
  createEvidenceSpanCatalogSelectionResolver,
  type EvidenceSpanCatalog,
  type EvidenceSpanCatalogBinding,
  type EvidenceSpanCatalogWindowInput,
} from "@/features/narrative-extraction/evidence/spanCatalog";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { buildNarrativeSourceView } from "@/features/narrative-extraction/source/sourceView";
import type { NarrativeSourceView } from "@/features/narrative-extraction/source/types";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import {
  buildNarrativeEvalFixture,
  type NarrativeEvalFixture,
} from "./fixtureSnapshot";
import type { NarrativeEvalVersions } from "./replay";
import { scoreNarrativeEvalCase } from "./scorer";
import type {
  NarrativeActualGraph,
  NarrativeCriticalViolation,
  NarrativeEvalCaseScore,
  NarrativeEvalCaseV1,
} from "./types";

export const OBSERVATION_CHRONICLE_EVAL_VERSIONS: NarrativeEvalVersions = {
  prompt: "narrative-observation-extract/1",
  responseSchema: "chronicle-raw-observation/1",
  extractor: "narrative-observation-extract/1",
  parser: "window-observation-normalizer/1",
};

/** Versioned evaluation identity for the code-owned citation-ID protocol. */
export const CITATION_ID_OBSERVATION_CHRONICLE_EVAL_VERSIONS: NarrativeEvalVersions =
  {
    prompt: "narrative-observation-extract/citation-id-v2",
    responseSchema: "chronicle-raw-observation-evidence-refs/2",
    extractor: "narrative-observation-extract/citation-id-v2",
    parser: "citation-id-observation-materializer/2",
  };

/** Short alias used by eval callers that do not include Chronicle in a name. */
export const CITATION_ID_OBSERVATION_EVAL_VERSIONS =
  CITATION_ID_OBSERVATION_CHRONICLE_EVAL_VERSIONS;

export interface PrepareObservationEvalCaseOptions {
  readonly evidenceMode?: ObservationEvidenceMode;
  /** Stable request prefix used to derive each per-window request identity. */
  readonly requestIdentity?: string;
}

export interface PreparedObservationEvalCase {
  readonly evalCase: NarrativeEvalCaseV1;
  readonly fixture: NarrativeEvalFixture;
  readonly prompt: string;
  readonly windows: readonly ObservationExtractionWindowInput[];
  readonly sourceViews: readonly NarrativeSourceView[];
  readonly allowedSourceRefs: ReadonlySet<string>;
  readonly evidenceMode: ObservationEvidenceMode;
  readonly evidenceSpanCatalog?: EvidenceSpanCatalog;
  /** One immutable binding per production request/window. */
  readonly evidenceSpanCatalogBindingsByWindowId?: ReadonlyMap<
    string,
    EvidenceSpanCatalogBinding
  >;
  /** Convenience only when the prepared case has exactly one window. */
  readonly evidenceSpanCatalogBinding?: EvidenceSpanCatalogBinding;
  /** Prompt materialized for each request-bound window in citation-ID mode. */
  readonly promptsByWindowId?: ReadonlyMap<string, string>;
  /** sourceRef → canonical document text (for exact-substring checks). */
  readonly textBySourceRef: ReadonlyMap<string, string>;
  /** Production Source View ref → fixture document id (snapshot sourceKey). */
  readonly documentIdBySourceRef: ReadonlyMap<string, string>;
  readonly versions: NarrativeEvalVersions;
}

export interface ObservationEvaluation extends NarrativeEvalCaseScore {
  readonly parseStatus: "parsed" | "invalid";
  readonly actual: NarrativeActualGraph;
  readonly unknownSourceRefsRejected: boolean;
  readonly evidenceQuotesExact: boolean;
}

function observationSemanticKey(predicate: string, index: number): string {
  const normalized = predicate
    .trim()
    .normalize("NFC")
    .toLocaleLowerCase("und")
    .replace(/\s+/g, "-");
  return `observation:${normalized || "untitled"}:${index}`;
}

/**
 * Build production Source View windows (S0001…) and the production observation
 * prompt over an isolated Gold corpus.
 */
export async function prepareObservationEvalCase(
  evalCase: NarrativeEvalCaseV1,
  options: PrepareObservationEvalCaseOptions = {},
): Promise<PreparedObservationEvalCase> {
  const evidenceMode = options.evidenceMode ?? LEGACY_OBSERVATION_EVIDENCE_MODE;
  const requestIdentityPrefix =
    options.requestIdentity ?? `narrative-eval:${evalCase.id}:observation`;
  const fixture = await buildNarrativeEvalFixture(evalCase);
  const plan = planExtractionWindows(fixture.snapshot);
  const documentByRef = new Map(
    fixture.snapshot.documents.map((document) => [document.ref, document]),
  );
  const windows: ObservationExtractionWindowInput[] = [];
  const windowInputs: EvidenceSpanCatalogWindowInput[] = [];
  const sourceViews: NarrativeSourceView[] = [];
  const textBySourceRef = new Map<string, string>();
  const documentIdBySourceRef = new Map<string, string>();

  for (const window of plan.windows) {
    const document = documentByRef.get(window.documentRef);
    if (!document) continue;
    const starts = [
      ...window.ownedRanges.map((range) => range.start),
      ...window.contextRanges.map((range) => range.start),
    ];
    const ends = [
      ...window.ownedRanges.map((range) => range.end),
      ...window.contextRanges.map((range) => range.end),
    ];
    const start = Math.min(...starts);
    const end = Math.max(...ends);
    const view = await buildNarrativeSourceView({
      ref: window.sourceRef,
      document,
      documentRange: { start, end },
    });
    sourceViews.push(view);
    const extractionWindow: ObservationExtractionWindowInput = {
      windowId: window.windowId,
      sourceRef: window.sourceRef,
      text: view.text,
    };
    windows.push(extractionWindow);
    windowInputs.push({
      windowId: window.windowId,
      documentRef: window.documentRef,
      sourceView: view,
      ownedRanges: window.ownedRanges,
      contextRanges: window.contextRanges,
    });
    textBySourceRef.set(window.sourceRef, view.text);
    documentIdBySourceRef.set(window.sourceRef, document.sourceKey);
  }

  let evidenceSpanCatalog: EvidenceSpanCatalog | undefined;
  let evidenceSpanCatalogBindingsByWindowId:
    | ReadonlyMap<string, EvidenceSpanCatalogBinding>
    | undefined;
  let evidenceSpanCatalogBinding: EvidenceSpanCatalogBinding | undefined;
  let promptsByWindowId: ReadonlyMap<string, string> | undefined;
  let prompt = buildObservationExtractionPrompt(windows);
  let versions = OBSERVATION_CHRONICLE_EVAL_VERSIONS;
  if (evidenceMode === CITATION_ID_OBSERVATION_EVIDENCE_MODE) {
    evidenceSpanCatalog = await buildEvidenceSpanCatalog(fixture.snapshot);
    // Full-corpus coverage is a separate precheck from each request's subset
    // binding. A missing occurrence must never become a successful empty run.
    assertEvidenceSpanCatalogCoverage(evidenceSpanCatalog, windowInputs);
    const bindings = new Map<string, EvidenceSpanCatalogBinding>();
    const prompts = new Map<string, string>();
    for (const windowInput of windowInputs) {
      const binding = await bindEvidenceSpanCatalog(
        fixture.snapshot,
        evidenceSpanCatalog,
        {
          requestIdentity: `${requestIdentityPrefix}:${windowInput.windowId}`,
          windows: [windowInput],
        },
      );
      const extractionWindow = windows.find(
        (window) => window.windowId === windowInput.windowId,
      );
      if (!extractionWindow) {
        throw new Error(
          `Missing extraction window for ${windowInput.windowId}`,
        );
      }
      const artifact = await buildCitationIdObservationPromptArtifact(
        [extractionWindow],
        binding,
      );
      bindings.set(windowInput.windowId, binding);
      const message = artifact.messages[0];
      if (!message) {
        throw new Error(
          `Citation-ID prompt artifact has no user message for ${windowInput.windowId}`,
        );
      }
      prompts.set(windowInput.windowId, message.content);
    }
    evidenceSpanCatalogBindingsByWindowId = bindings;
    if (bindings.size === 1) {
      const onlyBinding = [...bindings.values()][0];
      if (onlyBinding) evidenceSpanCatalogBinding = onlyBinding;
    }
    promptsByWindowId = prompts;
    prompt = prompts.values().next().value ?? prompt;
    versions = CITATION_ID_OBSERVATION_CHRONICLE_EVAL_VERSIONS;
    for (const entry of evidenceSpanCatalog.entries) {
      textBySourceRef.set(entry.sourceRef, entry.quote);
      const document = documentByRef.get(entry.documentRef);
      if (document)
        documentIdBySourceRef.set(entry.sourceRef, document.sourceKey);
    }
  }

  return {
    evalCase,
    fixture,
    prompt,
    windows,
    sourceViews,
    allowedSourceRefs: new Set(
      evidenceMode === CITATION_ID_OBSERVATION_EVIDENCE_MODE &&
        evidenceSpanCatalog
        ? evidenceSpanCatalog.entries.map((entry) => entry.sourceRef)
        : windows.map((window) => window.sourceRef),
    ),
    textBySourceRef,
    documentIdBySourceRef,
    evidenceMode,
    ...(evidenceSpanCatalog ? { evidenceSpanCatalog } : {}),
    ...(evidenceSpanCatalogBindingsByWindowId
      ? { evidenceSpanCatalogBindingsByWindowId }
      : {}),
    ...(evidenceSpanCatalogBinding ? { evidenceSpanCatalogBinding } : {}),
    ...(promptsByWindowId ? { promptsByWindowId } : {}),
    versions,
  };
}

function evaluateNormalizedObservations(
  prepared: PreparedObservationEvalCase,
  observations: readonly RawChronicleEventObservation[],
  parseStatus: "parsed" | "invalid",
  unknownSourceRefsSeen: boolean,
): ObservationEvaluation {
  let evidenceQuotesExact = true;
  for (const observation of observations) {
    for (const evidence of observation.evidence) {
      const haystack = prepared.textBySourceRef.get(evidence.sourceRef) ?? "";
      if (!haystack.includes(evidence.quote)) {
        evidenceQuotesExact = false;
      }
    }
  }

  const actual: NarrativeActualGraph = {
    observations: observations.map((observation, index) => ({
      id: observation.localId || `observation-${index}`,
      semanticKey: observationSemanticKey(observation.payload.predicate, index),
      dimensions: {
        eventDetection: { status: "observed", value: true },
        actuality: {
          status: "observed",
          value: observation.payload.actuality,
        },
        attribution: {
          status: "observed",
          value: observation.assertion.attribution,
        },
        narrativeFrame: {
          status: "observed",
          value: observation.assertion.narrativeFrame,
        },
        evidence: {
          status: "observed",
          value: observation.evidence.map((item) => ({
            documentId:
              prepared.evidenceMode === CITATION_ID_OBSERVATION_EVIDENCE_MODE
                ? (prepared.documentIdBySourceRef.get(item.sourceRef) ??
                  item.sourceRef)
                : item.sourceRef,
            quote: item.quote,
          })),
        },
        clustering: {
          status: "unobservable",
          reason: "observation stage has no cluster identity",
        },
        significance: {
          status: "unobservable",
          reason: "observation stage has no significance field",
        },
        proposalGate: {
          status: "unobservable",
          reason: "observation stage is pre-proposal",
        },
      },
    })),
  };

  const score = scoreNarrativeEvalCase(prepared.evalCase, actual);
  const adapterViolations: NarrativeCriticalViolation[] = [];
  if (parseStatus === "invalid") {
    adapterViolations.push({
      classId: "parse-failure-as-empty",
      message: "Observation parser rejected the response",
    });
  }
  if (!evidenceQuotesExact) {
    adapterViolations.push({
      classId: "unresolved-evidence",
      message:
        "Observation evidence quote is not an exact Source View substring",
    });
  }

  const unknownSourceRefsRejected =
    !unknownSourceRefsSeen ||
    observations.every((observation) =>
      observation.evidence.every((item) =>
        prepared.allowedSourceRefs.has(item.sourceRef),
      ),
    );

  const criticalViolations = [
    ...score.criticalViolations,
    ...adapterViolations,
  ];
  return {
    ...score,
    parseStatus,
    actual,
    unknownSourceRefsRejected,
    evidenceQuotesExact,
    passed:
      parseStatus === "parsed" &&
      evidenceQuotesExact &&
      unknownSourceRefsRejected &&
      criticalViolations.length === 0,
    criticalViolations,
  };
}

/**
 * Score a raw model response with the production observation normalizer.
 */
export function evaluateObservationResponse(
  prepared: PreparedObservationEvalCase,
  rawText: string,
): ObservationEvaluation {
  if (prepared.evidenceMode === CITATION_ID_OBSERVATION_EVIDENCE_MODE) {
    throw new TypeError(
      "Citation-ID responses require evaluateCitationIdObservationResponse",
    );
  }
  const jsonText = extractJsonObject(rawText);
  if (!jsonText) {
    return evaluateNormalizedObservations(prepared, [], "invalid", false);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return evaluateNormalizedObservations(prepared, [], "invalid", false);
  }

  const rawObservations =
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { observations?: unknown }).observations)
      ? (parsed as { observations: unknown[] }).observations
      : [];

  let unknownSourceRefsSeen = false;
  for (const row of rawObservations) {
    if (!row || typeof row !== "object") continue;
    const evidence = (row as { evidence?: unknown }).evidence;
    if (!Array.isArray(evidence)) continue;
    for (const item of evidence) {
      if (!item || typeof item !== "object") continue;
      const sourceRef = (item as { sourceRef?: unknown }).sourceRef;
      if (
        typeof sourceRef === "string" &&
        !prepared.allowedSourceRefs.has(sourceRef)
      ) {
        unknownSourceRefsSeen = true;
      }
    }
  }

  const observations = normalizeWindowObservations(parsed, {
    allowedSourceRefs: prepared.allowedSourceRefs,
  });
  return evaluateNormalizedObservations(
    prepared,
    observations,
    "parsed",
    unknownSourceRefsSeen,
  );
}

function citationBindingForResponse(
  prepared: PreparedObservationEvalCase,
  bindingOrWindowId?: EvidenceSpanCatalogBinding | string,
): EvidenceSpanCatalogBinding {
  if (bindingOrWindowId && typeof bindingOrWindowId !== "string") {
    return bindingOrWindowId;
  }
  if (typeof bindingOrWindowId === "string") {
    const binding =
      prepared.evidenceSpanCatalogBindingsByWindowId?.get(bindingOrWindowId);
    if (binding) return binding;
    throw new TypeError(
      `No citation-ID binding was prepared for window ${bindingOrWindowId}`,
    );
  }
  if (prepared.evidenceSpanCatalogBinding) {
    return prepared.evidenceSpanCatalogBinding;
  }
  throw new TypeError(
    "A citation-ID response with multiple windows requires its exact binding",
  );
}

/**
 * Evaluate one raw v2 response against the exact request/window binding.
 * Invalid IDs reject the complete response; they are never represented as a
 * successful empty observation batch.
 */
export async function evaluateCitationIdObservationResponse(
  prepared: PreparedObservationEvalCase,
  rawText: string,
  bindingOrWindowId?: EvidenceSpanCatalogBinding | string,
): Promise<ObservationEvaluation> {
  if (prepared.evidenceMode !== CITATION_ID_OBSERVATION_EVIDENCE_MODE) {
    throw new TypeError(
      "evaluateCitationIdObservationResponse requires citation-id-v2 mode",
    );
  }
  const binding = citationBindingForResponse(prepared, bindingOrWindowId);
  try {
    const resolver = await createEvidenceSpanCatalogSelectionResolver(binding);
    const materialized = await materializeCitationIdObservations(
      rawText,
      binding,
      undefined,
      resolver,
    );
    return evaluateNormalizedObservations(
      prepared,
      materialized.observations,
      "parsed",
      false,
    );
  } catch {
    return evaluateNormalizedObservations(prepared, [], "invalid", false);
  }
}

/**
 * Call production {@link runObservationExtractionTask} with an injected send
 * (OpenRouter live harness) and score the normalized observations.
 */
export async function runProductionObservationExtraction(
  prepared: PreparedObservationEvalCase,
  send: ObservationExtractionSend,
): Promise<{
  readonly evaluation: ObservationEvaluation;
  readonly observations: readonly RawChronicleEventObservation[];
}> {
  const collected: RawChronicleEventObservation[] = [];
  for (const [index, window] of prepared.windows.entries()) {
    const binding = prepared.evidenceSpanCatalogBindingsByWindowId?.get(
      window.windowId ?? "",
    );
    if (
      prepared.evidenceMode === CITATION_ID_OBSERVATION_EVIDENCE_MODE &&
      !binding
    ) {
      throw new Error(
        `Citation-ID observation window has no exact binding: ${window.windowId ?? "<missing>"}`,
      );
    }
    const observations = await runObservationExtractionTask({
      windows: [window],
      projectId: `narrative-eval:${prepared.evalCase.id}`,
      repairOnFailure: false,
      send,
      evidenceMode: prepared.evidenceMode,
      ...(binding ? { evidenceSpanCatalogBinding: binding } : {}),
    });
    collected.push(
      ...rekeyObservationsForWindow(
        `eval-window-${String(index + 1).padStart(3, "0")}`,
        observations,
      ),
    );
  }
  assertUniqueObservationLocalIds(collected);
  const observations = collected;
  const evaluation = evaluateNormalizedObservations(
    prepared,
    observations,
    "parsed",
    false,
  );
  return { evaluation, observations };
}
