import {
  buildObservationExtractionPrompt,
  runObservationExtractionTask,
  type ObservationExtractionSend,
} from "@/application/narrative-extraction/aiTasks/runObservationExtractionTask";
import { normalizeWindowObservations } from "@/features/chronicle/extraction/windowExtractor";
import { planExtractionWindows } from "@/features/chronicle/extraction/windowPlanner";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { buildNarrativeSourceView } from "@/features/narrative-extraction/source/sourceView";
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

export interface PreparedObservationEvalCase {
  readonly evalCase: NarrativeEvalCaseV1;
  readonly fixture: NarrativeEvalFixture;
  readonly prompt: string;
  readonly windows: readonly { sourceRef: string; text: string }[];
  readonly allowedSourceRefs: ReadonlySet<string>;
  /** sourceRef → canonical document text (for exact-substring checks). */
  readonly textBySourceRef: ReadonlyMap<string, string>;
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
): Promise<PreparedObservationEvalCase> {
  const fixture = await buildNarrativeEvalFixture(evalCase);
  const plan = planExtractionWindows(fixture.snapshot);
  const documentByRef = new Map(
    fixture.snapshot.documents.map((document) => [document.ref, document]),
  );
  const windows: { sourceRef: string; text: string }[] = [];
  const textBySourceRef = new Map<string, string>();

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
    windows.push({ sourceRef: window.sourceRef, text: view.text });
    textBySourceRef.set(window.sourceRef, view.text);
  }

  return {
    evalCase,
    fixture,
    prompt: buildObservationExtractionPrompt(windows),
    windows,
    allowedSourceRefs: new Set(windows.map((window) => window.sourceRef)),
    textBySourceRef,
    versions: OBSERVATION_CHRONICLE_EVAL_VERSIONS,
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
      semanticKey: observationSemanticKey(
        observation.payload.predicate,
        index,
      ),
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
            documentId: item.sourceRef,
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
  const observations = await runObservationExtractionTask({
    windows: prepared.windows,
    projectId: `narrative-eval:${prepared.evalCase.id}`,
    repairOnFailure: false,
    send,
  });
  const evaluation = evaluateNormalizedObservations(
    prepared,
    observations,
    "parsed",
    false,
  );
  return { evaluation, observations };
}
