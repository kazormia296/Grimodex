import { sha256Digest } from "../source/digest";
import {
  evaluateLegacyChronicleResponse,
  prepareLegacyChronicleEvalCase,
  type LegacyChronicleEvaluation,
} from "./legacyChronicleAdapter";
import {
  validateNarrativeEvalReplayArtifact,
  type NarrativeEvalReplayArtifact,
} from "./replay";
import type { NarrativeEvalCaseV1 } from "./types";

export interface NarrativeLiveDispatchResult {
  readonly rawText: string;
  readonly provider: string;
  readonly requestedModel: string;
  readonly resolvedModel: string;
  readonly reasoningEffort: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly runtimeMs: number;
  readonly costUsd: number;
}

export type NarrativeLiveDispatch = (
  prompt: string,
  evalCase: NarrativeEvalCaseV1,
) => Promise<NarrativeLiveDispatchResult>;

export interface LegacyChronicleBaselineCaseReport {
  readonly caseId: string;
  readonly corpusDigest: string;
  readonly promptDigest: string;
  readonly evaluation: LegacyChronicleEvaluation;
  readonly replay: NarrativeEvalReplayArtifact;
}

export interface LegacyChronicleBaselineReport {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly mode: "legacy-chronicle-live-baseline";
  readonly certificationEligible: false;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly summary: {
    readonly total: number;
    readonly measured: number;
    readonly passed: number;
    readonly failed: number;
    readonly criticalViolations: number;
  };
  readonly cases: readonly LegacyChronicleBaselineCaseReport[];
}

export interface LegacyChronicleBaselineOptions {
  readonly runId: string;
  readonly now?: () => string;
}

/**
 * Execute the current production legacy Chronicle prompt/parser as a measured
 * migration baseline. Each case receives exactly one dispatch; transport
 * failure is propagated and never retried here.
 */
export async function runLegacyChronicleLiveBaseline(
  cases: readonly NarrativeEvalCaseV1[],
  dispatch: NarrativeLiveDispatch,
  options: LegacyChronicleBaselineOptions,
): Promise<LegacyChronicleBaselineReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const caseReports: LegacyChronicleBaselineCaseReport[] = [];
  for (const evalCase of cases) {
    const prepared = await prepareLegacyChronicleEvalCase(evalCase);
    const promptDigest = await sha256Digest(prepared.prompt);
    const providerResult = await dispatch(prepared.prompt, evalCase);
    const responseDigest = await sha256Digest(providerResult.rawText);
    const replayCandidate: NarrativeEvalReplayArtifact = {
      schemaVersion: 1,
      replayId: `${options.runId}:${evalCase.id}`,
      caseId: evalCase.id,
      capturedAt: now(),
      corpusDigest: prepared.fixture.snapshot.digest,
      versions: prepared.versions,
      promptDigest,
      response: {
        rawText: providerResult.rawText,
        digest: responseDigest,
      },
      model: {
        provider: providerResult.provider,
        requestedModel: providerResult.requestedModel,
        resolvedModel: providerResult.resolvedModel,
        reasoningEffort: providerResult.reasoningEffort,
      },
      usage: {
        inputTokens: providerResult.inputTokens,
        outputTokens: providerResult.outputTokens,
        runtimeMs: providerResult.runtimeMs,
        costUsd: providerResult.costUsd,
      },
    };
    const validatedReplay = validateNarrativeEvalReplayArtifact(
      replayCandidate,
      {
        caseId: evalCase.id,
        corpusDigest: prepared.fixture.snapshot.digest,
        versions: prepared.versions,
      },
    );
    if (!validatedReplay.ok) {
      throw new Error(
        `Narrative replay validation failed: ${validatedReplay.diagnostics
          .map((diagnostic) => diagnostic.code)
          .join(", ")}`,
      );
    }
    caseReports.push({
      caseId: evalCase.id,
      corpusDigest: prepared.fixture.snapshot.digest,
      promptDigest,
      evaluation: evaluateLegacyChronicleResponse(
        prepared,
        providerResult.rawText,
      ),
      replay: validatedReplay.value,
    });
  }
  const passed = caseReports.filter((entry) => entry.evaluation.passed).length;
  return {
    schemaVersion: 1,
    runId: options.runId,
    mode: "legacy-chronicle-live-baseline",
    certificationEligible: false,
    startedAt,
    finishedAt: now(),
    summary: {
      total: cases.length,
      measured: caseReports.length,
      passed,
      failed: caseReports.length - passed,
      criticalViolations: caseReports.reduce(
        (sum, entry) => sum + entry.evaluation.criticalViolations.length,
        0,
      ),
    },
    cases: caseReports,
  };
}
