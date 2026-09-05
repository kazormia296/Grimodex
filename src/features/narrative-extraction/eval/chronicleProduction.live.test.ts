/**
 * Billed OpenRouter full-pipeline Chronicle live evaluation.
 *
 * Gate B2 bindings remain supported for archived evidence, while current live
 * provider/model qualification uses the separate QUALITY_EVALUATION_* binding.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEventSynthesisTask } from "@/application/narrative-extraction/aiTasks/runEventSynthesisTask";
import { runObservationExtractionTask } from "@/application/narrative-extraction/aiTasks/runObservationExtractionTask";
import {
  CITATION_ID_OBSERVATION_EVIDENCE_MODE,
  LEGACY_OBSERVATION_EVIDENCE_MODE,
  type ObservationEvidenceMode,
} from "@/application/narrative-extraction/aiTasks/citationIdObservation";
import {
  liveApiKey,
  runLiveSingleShot,
  type OpenRouterResponse,
} from "@/features/chat/agent/aiLiveHarness";
import { sha256Digest } from "@/features/narrative-extraction/source/digest";
import {
  CITATION_ID_PRODUCTION_CHRONICLE_EVAL_VERSIONS,
  PRODUCTION_CHRONICLE_EVAL_VERSIONS,
  evaluateProductionChronicleArtifacts,
  isCertificationEligible,
  prepareProductionChronicleEvalCase,
  runProductionChroniclePipeline,
} from "./productionChronicleAdapter";
import {
  loadNarrativeEvalSuite,
  narrativeEvalSuiteIdFromEnv,
  type LoadedNarrativeEvalSuite,
} from "./narrativeEvalSuite";
import { chronicleProductionStableReportRoot } from "./chronicleProductionReportPaths";
import { buildProductionChronicleCapabilityReport } from "./productionChronicleCapabilities";
import {
  canonicalObservationParseStatus,
  canonicalSynthesisParseStatus,
  diagnoseCitationIdObservationResponse,
  diagnoseObservationResponse,
  diagnoseSynthesisResponse,
  type ChronicleResponseDiagnostic,
} from "./responseDiagnostics";
import {
  diagnosticParityFailure,
  runTaskWithResponseDiagnostics,
  runTaskWithInvocationTracking,
  summarizeProductionLiveCases,
  terminalPipelineFailure,
  type ProductionLiveDiagnosticParityFailure,
  type ProductionLiveInvocation,
  type ProductionLivePipelineFailure,
  writeProductionLiveArtifacts,
} from "./chronicleProductionDiagnostics";
import type { NarrativeEvalCaseV1 } from "./types";
import type { NarrativeEvalVersions } from "./replay";

vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: vi.fn(),
}));
vi.mock("@/features/chat/modelRouting", () => ({
  resolveRoleSendOverride: () => ({
    apiVariant: undefined,
    model: process.env.OPENROUTER_MODEL ?? "openai/gpt-5.6-luna",
    provider: "openrouter",
    endpointId: undefined,
  }),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({ projectId: "narrative-eval-live" }),
  },
}));

const KEY = liveApiKey();
const describeLive = KEY ? describe : describe.skip;
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function reasoningEffort(): "minimal" | "low" | "medium" | "high" {
  const value = process.env.OPENROUTER_REASONING_EFFORT ?? "medium";
  if (!["minimal", "low", "medium", "high"].includes(value)) {
    throw new Error(`Unsupported OPENROUTER_REASONING_EFFORT: ${value}`);
  }
  return value as "minimal" | "low" | "medium" | "high";
}

/** Live runs default to the new protocol; legacy is an explicit comparison. */
function evidenceModeFromEnv(): ObservationEvidenceMode {
  const value =
    process.env.NARRATIVE_EVAL_EVIDENCE_MODE ??
    CITATION_ID_OBSERVATION_EVIDENCE_MODE;
  if (
    value !== CITATION_ID_OBSERVATION_EVIDENCE_MODE &&
    value !== LEGACY_OBSERVATION_EVIDENCE_MODE
  ) {
    throw new Error(`Unsupported NARRATIVE_EVAL_EVIDENCE_MODE: ${value}`);
  }
  return value;
}

function attemptNumber(): 1 | 2 {
  const raw =
    process.env.GATE_B2_ATTEMPT ?? process.env.NARRATIVE_EVAL_ATTEMPT ?? "1";
  if (raw !== "1" && raw !== "2") {
    throw new Error("NARRATIVE_EVAL_ATTEMPT must be 1 or 2");
  }
  return Number(raw) as 1 | 2;
}

function evaluationBindingFromEnv() {
  return {
    candidateCommitSha:
      process.env.QUALITY_EVALUATION_CANDIDATE_COMMIT_SHA ??
      process.env.GATE_B2_CANDIDATE_COMMIT_SHA,
    candidateTreeSha:
      process.env.QUALITY_EVALUATION_CANDIDATE_TREE_SHA ??
      process.env.GATE_B2_CANDIDATE_TREE_SHA,
    suiteId:
      process.env.QUALITY_EVALUATION_SUITE_ID ?? process.env.GATE_B2_SUITE_ID,
    runId: process.env.QUALITY_EVALUATION_RUN_ID ?? process.env.GATE_B2_RUN_ID,
    commandDigest:
      process.env.QUALITY_EVALUATION_COMMAND_DIGEST ??
      process.env.GATE_B2_COMMAND_DIGEST,
    freezeId: process.env.GATE_B2_FREEZE_ID,
    certificationRunId: process.env.GATE_B2_CERTIFICATION_RUN_ID,
    outputPath:
      process.env.QUALITY_EVALUATION_OUTPUT_PATH ??
      process.env.GATE_B2_OUTPUT_PATH,
    localQualification: Boolean(process.env.QUALITY_EVALUATION_RUN_ID),
    artifactRoot: process.env.QUALITY_EVALUATION_ARTIFACT_ROOT,
  };
}

async function writeBoundReport(report: Record<string, unknown>) {
  const binding = evaluationBindingFromEnv();
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  if (binding.outputPath) {
    await mkdir(path.dirname(binding.outputPath), { recursive: true });
    await writeFile(binding.outputPath, reportJson, "utf8");
  }
  return reportJson;
}

async function loadCases(): Promise<LoadedNarrativeEvalSuite> {
  return loadNarrativeEvalSuite({
    repoRoot,
    suiteId: narrativeEvalSuiteIdFromEnv(),
  });
}

function corpusSuiteReport(suite: LoadedNarrativeEvalSuite) {
  return {
    suiteId: suite.suiteId,
    version: suite.version,
    caseFile: suite.caseFile,
    caseSchema: suite.caseSchema,
    caseCount: suite.caseCount,
    diagnosticOnly: suite.diagnosticOnly,
    manifestDigest: suite.manifestDigest,
    caseFileDigest: suite.caseFileDigest,
    caseSchemaDigest: suite.caseSchemaDigest,
  };
}

function selectCases(suite: LoadedNarrativeEvalSuite): NarrativeEvalCaseV1[] {
  const cases = [...suite.cases];
  const requestedCaseId = process.env.NARRATIVE_EVAL_CASE_ID;
  const selected = requestedCaseId
    ? cases.filter((entry) => entry.id === requestedCaseId)
    : cases;
  if (requestedCaseId && selected.length !== 1) {
    throw new Error(`Unknown NARRATIVE_EVAL_CASE_ID: ${requestedCaseId}`);
  }
  const rawLimit = process.env.NARRATIVE_EVAL_LIMIT;
  if (!rawLimit) return selected;
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("NARRATIVE_EVAL_LIMIT must be a positive integer");
  }
  return selected.slice(0, limit);
}

type ChronicleLiveStageId =
  | "narrative_observation_extract"
  | "narrative_event_synthesize";
type ChronicleLiveStopReason = "end_turn" | "tool_use" | "max_tokens";
type ChronicleLiveFinishReason =
  | "completed"
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "cancelled";

const ALLOWED_FINISH_REASONS = new Set<ChronicleLiveFinishReason>([
  "completed",
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "cancelled",
]);

function boundedFinishReason(value: unknown): ChronicleLiveFinishReason | null {
  return typeof value === "string" &&
    ALLOWED_FINISH_REASONS.has(value as ChronicleLiveFinishReason)
    ? (value as ChronicleLiveFinishReason)
    : null;
}

type ChronicleLiveStageDiagnostic = ChronicleResponseDiagnostic & {
  readonly expectedParseStatus: "parsed" | "invalid";
  readonly parseStatus: "parsed" | "invalid";
};

type ProductionLiveDispatch = {
  readonly promptDigest: string;
  readonly responseDigest: string;
  readonly resolvedModel: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly runtimeMs: number;
  readonly costUsd: number;
};

type ProductionLiveCaseReport = {
  readonly caseId: string;
  readonly evidenceMode: ObservationEvidenceMode;
  readonly receiptMode: ObservationEvidenceMode;
  readonly versions: NarrativeEvalVersions;
  readonly corpusDigest: string;
  readonly fixturePromptDigest: string;
  readonly dispatches: readonly ProductionLiveDispatch[];
  readonly observationCount: number;
  readonly hypothesisCount: number;
  readonly proposalCount: number;
  readonly evaluation: ReturnType<typeof evaluateProductionChronicleArtifacts>;
};

type ProductionLiveTerminalFailure =
  | ProductionLivePipelineFailure
  | ProductionLiveDiagnosticParityFailure;

type ProductionLiveTerminalFailureCaseReport = {
  readonly caseId: string;
  readonly evidenceMode: ObservationEvidenceMode;
  readonly receiptMode: ObservationEvidenceMode;
  readonly versions: NarrativeEvalVersions;
  readonly corpusDigest: string;
  readonly fixturePromptDigest: string;
  readonly dispatches: readonly ProductionLiveDispatch[];
  readonly terminalFailure: ProductionLiveTerminalFailure;
};

describeLive("Chronicle production OpenRouter live qualification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(
    "runs observation through proposal planning and writes a credential-free report",
    async () => {
      const suite = await loadCases();
      const cases = selectCases(suite);
      const evidenceMode = evidenceModeFromEnv();
      const attempt = attemptNumber();
      const binding = evaluationBindingFromEnv();
      const fullCertificationRun =
        !process.env.NARRATIVE_EVAL_CASE_ID &&
        !process.env.NARRATIVE_EVAL_LIMIT;
      const diagnosticOnly =
        suite.diagnosticOnly || attempt === 2 || !fullCertificationRun;
      const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-5.6-luna";
      const effort = reasoningEffort();
      const startedAt = new Date().toISOString();
      const runId =
        binding.runId ??
        `chronicle-production-attempt-${attempt}-${startedAt.replace(
          /[:.]/g,
          "-",
        )}`;
      const artifactRoot = binding.artifactRoot
        ? path.join(binding.artifactRoot, runId)
        : path.join(repoRoot, ".artifacts", "narrative-eval", runId);
      await mkdir(artifactRoot, { recursive: true });

      const caseReports: ProductionLiveCaseReport[] = [];
      const failedCaseReports: ProductionLiveTerminalFailureCaseReport[] = [];
      const diagnosticCaseReports: Array<{
        readonly caseId: string;
        readonly evidenceMode: ObservationEvidenceMode;
        readonly receiptMode: ObservationEvidenceMode;
        readonly versions: NarrativeEvalVersions;
        readonly corpusDigest: string;
        readonly fixturePromptDigest: string;
        readonly dispatches: readonly {
          readonly promptDigest: string;
          readonly responseDigest: string;
          readonly stageId: ChronicleLiveStageId;
          readonly invocationIndex: number;
          readonly finishReason: ChronicleLiveFinishReason | null;
          readonly stopReason: ChronicleLiveStopReason;
        }[];
        readonly stageDiagnostics: readonly ChronicleLiveStageDiagnostic[];
        readonly terminalFailure?: ProductionLiveTerminalFailure;
        readonly capability: ReturnType<
          typeof buildProductionChronicleCapabilityReport
        >;
      }> = [];
      for (const evalCase of cases) {
        const prepared = await prepareProductionChronicleEvalCase(evalCase, {
          evidenceMode,
        });
        const dispatches: ProductionLiveDispatch[] = [];
        const diagnosticDispatches: Array<{
          promptDigest: string;
          responseDigest: string;
          stageId: ChronicleLiveStageId;
          invocationIndex: number;
          finishReason: ChronicleLiveFinishReason | null;
          stopReason: ChronicleLiveStopReason;
        }> = [];
        const stageDiagnostics: ChronicleLiveStageDiagnostic[] = [];
        let observationInvocationIndex = 0;
        let synthesisInvocationIndex = 0;
        let rejectedInvocation: ProductionLivePipelineFailure | undefined;
        const sendLive = async (
          messages: Parameters<
            NonNullable<
              Parameters<typeof runObservationExtractionTask>[0]["send"]
            >
          >[0],
          stageId: ChronicleLiveStageId,
          invocationIndex: number,
        ) => {
          const prompt =
            typeof messages[0]?.content === "string" ? messages[0].content : "";
          let raw:
            | { response: OpenRouterResponse; elapsedMs: number }
            | undefined;
          const response = await runLiveSingleShot(prompt, {
            send: {
              apiKey: KEY,
              model,
              reasoning: { effort },
              onRawExchange: (exchange) => {
                raw = {
                  response: exchange.response,
                  elapsedMs: exchange.elapsedMs,
                };
              },
            },
          });
          if (!raw?.response.model) {
            throw new Error("OpenRouter response omitted resolved model");
          }
          const promptDigest = await sha256Digest(prompt);
          const responseDigest = await sha256Digest(response.text);
          dispatches.push({
            promptDigest,
            responseDigest,
            resolvedModel: raw.response.model,
            inputTokens: response.tokensIn ?? 0,
            outputTokens: response.tokensOut ?? 0,
            runtimeMs: raw.elapsedMs,
            costUsd: raw.response.usage?.cost ?? 0,
          });
          diagnosticDispatches.push({
            promptDigest,
            responseDigest,
            stageId,
            invocationIndex,
            finishReason: boundedFinishReason(
              raw.response.choices?.[0]?.finish_reason,
            ),
            stopReason: response.stopReason,
          });
          return response;
        };
        const toTaskResponse = (
          response: Awaited<ReturnType<typeof runLiveSingleShot>>,
        ) => ({
          text: response.text,
          inputTokens: response.tokensIn ?? 0,
          outputTokens: response.tokensOut ?? 0,
        });
        const observeWithDiagnostics = async (
          input: Parameters<typeof runObservationExtractionTask>[0],
        ) => {
          const invocationIndex = observationInvocationIndex++;
          const invocation: ProductionLiveInvocation = {
            stageId: "narrative_observation_extract",
            invocationIndex,
            parseStatus: null,
          };
          let responseText: string | undefined;
          return runTaskWithInvocationTracking(
            invocation,
            () =>
              runTaskWithResponseDiagnostics({
                runTask: () =>
                  runObservationExtractionTask({
                    ...input,
                    onParseStatus: (status) => {
                      invocation.parseStatus = status;
                      input.onParseStatus?.(status);
                    },
                    send: async (messages) => {
                      const response = await sendLive(
                        messages,
                        "narrative_observation_extract",
                        invocationIndex,
                      );
                      responseText = response.text;
                      return toTaskResponse(response);
                    },
                  }),
                getResponseText: () => responseText,
                getParseStatus: () => invocation.parseStatus ?? undefined,
                diagnose: async (text) => {
                  if (
                    input.evidenceMode === CITATION_ID_OBSERVATION_EVIDENCE_MODE
                  ) {
                    const citationBinding = input.evidenceSpanCatalogBinding;
                    if (!citationBinding) {
                      throw new Error(
                        "Citation-ID live observation is missing its exact binding",
                      );
                    }
                    return diagnoseCitationIdObservationResponse(text, {
                      invocationIndex,
                      binding: citationBinding,
                    });
                  }
                  return diagnoseObservationResponse(text, {
                    invocationIndex,
                    allowedSourceRefs: new Set(
                      input.windows.map((window) => window.sourceRef),
                    ),
                  });
                },
                expectedParseStatus: canonicalObservationParseStatus,
                acceptedCount: (diagnostic) => diagnostic.output.acceptedCount,
                resultCount: (result) => result.length,
                onDiagnostic: ({
                  diagnostic,
                  expectedParseStatus,
                  parseStatus: actualParseStatus,
                }) => {
                  stageDiagnostics.push({
                    ...diagnostic,
                    expectedParseStatus,
                    parseStatus: actualParseStatus,
                  });
                },
              }),
            (failedInvocation) => {
              rejectedInvocation = terminalPipelineFailure(failedInvocation);
            },
          );
        };
        const synthesizeWithDiagnostics = async (
          input: Parameters<typeof runEventSynthesisTask>[0],
        ) => {
          const invocationIndex = synthesisInvocationIndex++;
          const invocation: ProductionLiveInvocation = {
            stageId: "narrative_event_synthesize",
            invocationIndex,
            parseStatus: null,
          };
          let responseText: string | undefined;
          return runTaskWithInvocationTracking(
            invocation,
            async () => {
              const hypotheses = await runEventSynthesisTask({
                ...input,
                onParseStatus: (status) => {
                  invocation.parseStatus = status;
                  input.onParseStatus?.(status);
                },
                send: async (messages) => {
                  const response = await sendLive(
                    messages,
                    "narrative_event_synthesize",
                    invocationIndex,
                  );
                  responseText = response.text;
                  return toTaskResponse(response);
                },
              });
              if (responseText !== undefined) {
                const diagnostic = diagnoseSynthesisResponse(responseText, {
                  invocationIndex,
                  clusterRef: input.clusterRef,
                  allowedObservationRefs: new Set(
                    input.observations.map(
                      (observation) => observation.localId,
                    ),
                  ),
                });
                const expectedParseStatus =
                  canonicalSynthesisParseStatus(diagnostic);
                const actualParseStatus = invocation.parseStatus ?? "invalid";
                if (actualParseStatus !== expectedParseStatus) {
                  throw new Error(
                    "Synthesis diagnostic parseStatus disagreed with the canonical task callback",
                  );
                }
                if (diagnostic.output.acceptedCount !== hypotheses.length) {
                  throw new Error(
                    "Synthesis diagnostic output count disagreed with the canonical task result",
                  );
                }
                stageDiagnostics.push({
                  ...diagnostic,
                  expectedParseStatus,
                  parseStatus: actualParseStatus,
                });
              }
              return hypotheses;
            },
            (failedInvocation) => {
              rejectedInvocation = terminalPipelineFailure(failedInvocation);
            },
          );
        };

        const fixturePromptDigest = await sha256Digest(prepared.prompt);
        let artifacts:
          | Awaited<ReturnType<typeof runProductionChroniclePipeline>>
          | undefined;
        let terminalFailure: ProductionLiveTerminalFailure | undefined;
        try {
          artifacts = await runProductionChroniclePipeline(prepared, {
            observeWithAi: observeWithDiagnostics,
            synthesizeWithAi: synthesizeWithDiagnostics,
          });
        } catch {
          terminalFailure = rejectedInvocation ?? terminalPipelineFailure();
        }
        const dispatchKeys = diagnosticDispatches.map(
          (dispatch) => `${dispatch.stageId}:${dispatch.invocationIndex}`,
        );
        const diagnosticKeys = stageDiagnostics.map(
          (diagnostic) => `${diagnostic.stageId}:${diagnostic.invocationIndex}`,
        );
        const parityFailure = diagnosticParityFailure(
          dispatchKeys,
          diagnosticKeys,
        );
        if (parityFailure) terminalFailure = parityFailure;
        const caseReportContext = {
          caseId: evalCase.id,
          evidenceMode: prepared.evidenceMode,
          receiptMode: prepared.evidenceMode,
          versions: prepared.versions,
          corpusDigest: prepared.fixture.snapshot.digest,
          fixturePromptDigest,
        };
        if (terminalFailure) {
          failedCaseReports.push({
            ...caseReportContext,
            dispatches,
            terminalFailure,
          });
        } else {
          if (!artifacts) {
            throw new Error(
              "Chronicle production pipeline completed without artifacts or a terminal failure",
            );
          }
          const evaluation = evaluateProductionChronicleArtifacts(
            prepared,
            artifacts,
          );
          caseReports.push({
            ...caseReportContext,
            dispatches,
            observationCount: artifacts.observations.length,
            hypothesisCount: artifacts.hypotheses.length,
            proposalCount: artifacts.plannedProposals.length,
            evaluation,
          });
        }
        diagnosticCaseReports.push({
          ...caseReportContext,
          dispatches: diagnosticDispatches,
          stageDiagnostics,
          ...(terminalFailure ? { terminalFailure } : {}),
          capability: buildProductionChronicleCapabilityReport([evalCase]),
        });
      }

      const capabilityReport = buildProductionChronicleCapabilityReport(cases);

      const eligibilityInput = {
        diagnosticOnly,
        cases: caseReports,
      };
      const parseFailureCount = diagnosticCaseReports.reduce(
        (sum, entry) =>
          sum +
          entry.stageDiagnostics.filter(
            (diagnostic) => diagnostic.parseStatus === "invalid",
          ).length,
        0,
      );
      const caseSummary = summarizeProductionLiveCases(
        caseReports,
        failedCaseReports,
        parseFailureCount,
        cases.length,
      );
      const certificationEligible =
        fullCertificationRun &&
        !diagnosticOnly &&
        failedCaseReports.length === 0 &&
        isCertificationEligible(eligibilityInput);
      const completedAt = new Date().toISOString();
      const report = {
        schemaVersion: 1,
        runId,
        mode: "chronicle-production-live" as const,
        evidenceMode,
        receiptMode: evidenceMode,
        versions:
          evidenceMode === CITATION_ID_OBSERVATION_EVIDENCE_MODE
            ? CITATION_ID_PRODUCTION_CHRONICLE_EVAL_VERSIONS
            : PRODUCTION_CHRONICLE_EVAL_VERSIONS,
        attempt,
        diagnosticOnly,
        retryPolicy: binding.localQualification
          ? "Live qualification records each invocation as a new immutable local run."
          : "Attempt 1 is normative; Attempt 2 is diagnostic-only and cannot independently flip the overall verdict to PASS.",
        startedAt,
        completedAt,
        finishedAt: completedAt,
        ...(binding.candidateCommitSha
          ? { candidateCommitSha: binding.candidateCommitSha }
          : {}),
        ...(binding.candidateTreeSha
          ? { candidateTreeSha: binding.candidateTreeSha }
          : {}),
        ...(binding.suiteId
          ? {
              suiteId: binding.suiteId,
              qualityEvaluationSuiteId: binding.suiteId,
            }
          : {}),
        ...(binding.commandDigest
          ? { commandDigest: binding.commandDigest }
          : {}),
        ...(binding.freezeId ? { freezeId: binding.freezeId } : {}),
        ...(binding.certificationRunId
          ? { certificationRunId: binding.certificationRunId }
          : {}),
        model: { provider: "openrouter", requestedModel: model, effort },
        corpusSuite: corpusSuiteReport(suite),
        caseCount: caseSummary.caseCount,
        certificationEligible,
        summary: caseSummary.summary,
        cases: caseReports,
        failedCases: failedCaseReports,
      };
      const reportJson = await writeBoundReport(report);
      const diagnosticsReport = {
        schemaVersion: 1,
        mode: "chronicle-production-live-diagnostics" as const,
        evidenceMode,
        receiptMode: evidenceMode,
        runId,
        attempt,
        nonAuthoritative: true,
        diagnosticOnly: true,
        certificationEligible: false,
        startedAt,
        completedAt,
        ...(binding.candidateCommitSha
          ? { candidateCommitSha: binding.candidateCommitSha }
          : {}),
        ...(binding.candidateTreeSha
          ? { candidateTreeSha: binding.candidateTreeSha }
          : {}),
        ...(binding.suiteId
          ? { qualityEvaluationSuiteId: binding.suiteId }
          : {}),
        ...(binding.commandDigest
          ? { commandDigest: binding.commandDigest }
          : {}),
        ...(binding.freezeId ? { freezeId: binding.freezeId } : {}),
        ...(binding.certificationRunId
          ? { certificationRunId: binding.certificationRunId }
          : {}),
        model: { provider: "openrouter", requestedModel: model, effort },
        corpusSuite: corpusSuiteReport(suite),
        caseCount: diagnosticCaseReports.length,
        selectedCaseCapabilityReport: capabilityReport,
        cases: diagnosticCaseReports,
      };
      await writeProductionLiveArtifacts({
        artifactRoot,
        reportJson,
        diagnosticsReport,
      });
      // Archived Gate B2 evidence still uses the legacy stable path. Local
      // qualification and diagnostic suites keep their detailed source report
      // in an ephemeral, run-specific root.
      const stableRoot = chronicleProductionStableReportRoot({
        repoRoot,
        diagnosticOnly,
        localQualification: binding.localQualification,
      });
      if (stableRoot) {
        await mkdir(stableRoot, { recursive: true });
        await writeFile(
          path.join(stableRoot, "report.json"),
          reportJson,
          "utf8",
        );
      }

      console.info(
        JSON.stringify({
          artifactRoot,
          diagnosticsReport: path.join(artifactRoot, "diagnostics.json"),
          ...(stableRoot
            ? { stableReport: path.join(stableRoot, "report.json") }
            : {}),
          certificationEligible,
          summary: report.summary,
        }),
      );
      expect(report.mode).toBe("chronicle-production-live");
      expect(report.caseCount).toBe(cases.length);
      expect(report.failedCases).toEqual(failedCaseReports);
      expect(
        caseReports.every(
          (entry) =>
            entry.corpusDigest.startsWith("sha256:") &&
            entry.fixturePromptDigest.startsWith("sha256:") &&
            entry.dispatches.length > 0 &&
            entry.dispatches.every(
              (dispatch) =>
                dispatch.promptDigest.startsWith("sha256:") &&
                dispatch.responseDigest.startsWith("sha256:"),
            ),
        ),
      ).toBe(true);
      expect(
        diagnosticCaseReports.every(
          (entry) =>
            entry.dispatches.length === entry.stageDiagnostics.length &&
            entry.dispatches.every(
              (dispatch) =>
                dispatch.promptDigest.startsWith("sha256:") &&
                dispatch.responseDigest.startsWith("sha256:") &&
                dispatch.stageId.length > 0 &&
                Number.isSafeInteger(dispatch.invocationIndex) &&
                dispatch.invocationIndex >= 0 &&
                ["end_turn", "tool_use", "max_tokens"].includes(
                  dispatch.stopReason,
                ) &&
                (dispatch.finishReason === null ||
                  ALLOWED_FINISH_REASONS.has(dispatch.finishReason)),
            ) &&
            entry.stageDiagnostics.every(
              (diagnostic) =>
                diagnostic.expectedParseStatus === diagnostic.parseStatus,
            ) &&
            (entry.terminalFailure === undefined ||
              (entry.terminalFailure.kind === "terminal-pipeline-failure" &&
                (entry.terminalFailure.stageId === null ||
                  entry.terminalFailure.stageId.length > 0) &&
                (entry.terminalFailure.invocationIndex === null ||
                  (Number.isSafeInteger(
                    entry.terminalFailure.invocationIndex,
                  ) &&
                    entry.terminalFailure.invocationIndex >= 0)) &&
                (entry.terminalFailure.parseStatus === null ||
                  entry.terminalFailure.parseStatus === "parsed" ||
                  entry.terminalFailure.parseStatus === "invalid")) ||
              (entry.terminalFailure.kind === "diagnostic-parity-failure" &&
                Number.isSafeInteger(entry.terminalFailure.dispatchCount) &&
                entry.terminalFailure.dispatchCount >= 0 &&
                Number.isSafeInteger(entry.terminalFailure.diagnosticCount) &&
                entry.terminalFailure.diagnosticCount >= 0 &&
                Array.isArray(entry.terminalFailure.dispatchKeys) &&
                Array.isArray(entry.terminalFailure.diagnosticKeys) &&
                entry.terminalFailure.dispatchKeys.every(
                  (key) => typeof key === "string" && key.length > 0,
                ) &&
                entry.terminalFailure.diagnosticKeys.every(
                  (key) => typeof key === "string" && key.length > 0,
                ))),
        ),
      ).toBe(true);
      expect(diagnosticsReport).toMatchObject({
        schemaVersion: 1,
        runId,
        nonAuthoritative: true,
        diagnosticOnly: true,
        certificationEligible: false,
        caseCount: cases.length,
      });
      expect(diagnosticCaseReports).toHaveLength(cases.length);
      const diagnosticParseFailureCount = diagnosticCaseReports.reduce(
        (sum, diagnosticCase) => {
          const matchingCaseReports = caseReports.filter(
            (caseReport) => caseReport.caseId === diagnosticCase.caseId,
          );
          const matchingFailedCaseReports = failedCaseReports.filter(
            (failedCaseReport) =>
              failedCaseReport.caseId === diagnosticCase.caseId,
          );
          expect(
            matchingCaseReports.length + matchingFailedCaseReports.length,
          ).toBe(1);
          const invalidDiagnosticCount = diagnosticCase.stageDiagnostics.filter(
            (diagnostic) => diagnostic.parseStatus === "invalid",
          ).length;
          const caseReport = matchingCaseReports[0];
          if (caseReport) {
            expect(invalidDiagnosticCount).toBe(
              caseReport.evaluation.parseFailureCount,
            );
          } else {
            expect(matchingFailedCaseReports[0]?.terminalFailure).toBeDefined();
          }
          return sum + invalidDiagnosticCount;
        },
        0,
      );
      expect(diagnosticParseFailureCount).toBe(parseFailureCount);
      expect(parseFailureCount).toBe(0);
      expect(failedCaseReports).toHaveLength(0);
      if (fullCertificationRun && attempt === 1 && !diagnosticOnly) {
        expect(report.caseCount).toBe(14);
        expect(report.summary.passed).toBe(14);
        expect(report.summary.failed).toBe(0);
        expect(report.certificationEligible).toBe(true);
      } else {
        expect(report.certificationEligible).toBe(false);
      }
    },
    30 * 60 * 1000,
  );
});
