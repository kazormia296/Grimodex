import {
  buildExtractEventsPrompt,
  parseEventProposalsResult,
} from "@/features/chronicle/extractEventsApi";
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

export const LEGACY_CHRONICLE_EVAL_VERSIONS: NarrativeEvalVersions = {
  prompt: "chronicle-extract-legacy/1",
  responseSchema: "chronicle-event-proposal-legacy/1",
  extractor: "chronicle-extract-legacy/1",
  parser: "chronicle-event-proposal-parser/1",
};

export interface PreparedLegacyChronicleEvalCase {
  readonly evalCase: NarrativeEvalCaseV1;
  readonly fixture: NarrativeEvalFixture;
  readonly prompt: string;
  readonly allowedSceneIds: ReadonlySet<string>;
  readonly versions: NarrativeEvalVersions;
}

export interface LegacyChronicleEvaluation extends NarrativeEvalCaseScore {
  readonly parseStatus: "parsed" | "invalid";
  readonly actual: NarrativeActualGraph;
}

function legacySemanticKey(title: string, index: number): string {
  const normalized = title
    .trim()
    .normalize("NFC")
    .toLocaleLowerCase("und")
    .replace(/\s+/g, "-");
  return `legacy-title:${normalized || "untitled"}:${index}`;
}

function unobservable(reason: string) {
  return { status: "unobservable" as const, reason };
}

/** Build the exact production legacy Prompt over an isolated Gold corpus. */
export async function prepareLegacyChronicleEvalCase(
  evalCase: NarrativeEvalCaseV1,
): Promise<PreparedLegacyChronicleEvalCase> {
  const fixture = await buildNarrativeEvalFixture(evalCase);
  const included = new Set(evalCase.coverage.includedDocumentIds);
  const scenes = evalCase.documents
    .filter((document) => included.has(document.id))
    .map((document, orderIndex) => ({
      sceneId: document.id,
      title: document.title,
      bodyText: document.text,
      orderIndex,
    }));
  return {
    evalCase,
    fixture,
    prompt: buildExtractEventsPrompt({ scenes, existingTitles: [] }),
    allowedSceneIds: new Set(scenes.map((scene) => scene.sceneId)),
    versions: LEGACY_CHRONICLE_EVAL_VERSIONS,
  };
}

/**
 * Replay the production legacy parser. Unsupported fields stay explicitly
 * unobservable; the adapter never fills semantic Gold from fixture answers.
 */
export function evaluateLegacyChronicleResponse(
  prepared: PreparedLegacyChronicleEvalCase,
  rawText: string,
): LegacyChronicleEvaluation {
  const parsed = parseEventProposalsResult(
    rawText,
    new Set(prepared.allowedSceneIds),
  );
  const actual: NarrativeActualGraph = {
    observations:
      parsed.status === "parsed"
        ? parsed.proposals.map((proposal, index) => ({
            id: `legacy-event-${index}`,
            semanticKey: legacySemanticKey(proposal.title, index),
            dimensions: {
              eventDetection: { status: "observed", value: true },
              actuality: unobservable("legacy schema has no actuality field"),
              attribution: unobservable(
                "legacy schema has no attribution field",
              ),
              narrativeFrame: unobservable(
                "legacy schema has no narrative-frame field",
              ),
              evidence: unobservable(
                "legacy evidenceSceneIds do not contain an exact quote",
              ),
              clustering: unobservable("legacy schema has no cluster identity"),
              significance: unobservable(
                "legacy schema has no significance field",
              ),
              proposalGate: unobservable(
                "legacy output is not a reviewed Proposal",
              ),
            },
          }))
        : [],
  };
  const score = scoreNarrativeEvalCase(prepared.evalCase, actual);
  const adapterViolations: NarrativeCriticalViolation[] = [];
  if (parsed.status === "invalid") {
    adapterViolations.push({
      classId: "parse-failure-as-empty",
      message: `Legacy parser rejected the response: ${parsed.reason}`,
    });
  } else {
    for (const observation of actual.observations) {
      adapterViolations.push({
        classId: "unresolved-evidence",
        actualObservationId: observation.id,
        message: "Legacy Chronicle output has no exact Evidence quote",
      });
    }
    for (const diagnostic of parsed.diagnostics) {
      if (diagnostic.code === "unknown-scene-reference") {
        adapterViolations.push({
          classId: "unknown-source-ref",
          actualObservationId: `legacy-event-${diagnostic.eventIndex}`,
          message: "Legacy Chronicle output referenced an unknown Scene",
        });
      }
    }
  }
  const criticalViolations = [
    ...score.criticalViolations,
    ...adapterViolations,
  ];
  return {
    ...score,
    parseStatus: parsed.status,
    actual,
    passed: score.passed && criticalViolations.length === 0,
    criticalViolations,
  };
}
