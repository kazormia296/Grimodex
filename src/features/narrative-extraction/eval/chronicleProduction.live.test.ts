/**
 * Billed OpenRouter full-pipeline Chronicle live evaluation.
 *
 * Gate B2 bindings remain supported for archived evidence, while current live
 * provider/model qualification uses the separate QUALITY_EVALUATION_* binding.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEventSynthesisTask } from "@/application/narrative-extraction/aiTasks/runEventSynthesisTask";
import { runObservationExtractionTask } from "@/application/narrative-extraction/aiTasks/runObservationExtractionTask";
import {
  liveApiKey,
  runLiveSingleShot,
  type OpenRouterResponse,
} from "@/features/chat/agent/aiLiveHarness";
import { sha256Digest } from "@/features/narrative-extraction/source/digest";
import { validateNarrativeEvalCase } from "./caseSchema";
import {
  evaluateProductionChronicleArtifacts,
  isCertificationEligible,
  prepareProductionChronicleEvalCase,
  runProductionChroniclePipeline,
} from "./productionChronicleAdapter";
import type { NarrativeEvalCaseV1 } from "./types";

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

async function loadCases(): Promise<NarrativeEvalCaseV1[]> {
  const source = await readFile(
    path.join(repoRoot, "evals/narrative/cases/chronicle-micro-v1.yaml"),
    "utf8",
  );
  const corpus = yaml.load(source) as { cases?: unknown[] };
  const cases = (corpus.cases ?? []).map((candidate) => {
    const result = validateNarrativeEvalCase(candidate);
    if (!result.ok) {
      throw new Error(
        `Invalid live case: ${result.diagnostics
          .map((diagnostic) => diagnostic.code)
          .join(", ")}`,
      );
    }
    return result.value;
  });
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

describeLive("Chronicle production OpenRouter live qualification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(
    "runs observation through proposal planning and writes a credential-free report",
    async () => {
      const cases = await loadCases();
      const attempt = attemptNumber();
      const binding = evaluationBindingFromEnv();
      const fullCertificationRun =
        !process.env.NARRATIVE_EVAL_CASE_ID &&
        !process.env.NARRATIVE_EVAL_LIMIT;
      const diagnosticOnly = attempt === 2 || !fullCertificationRun;
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

      const caseReports = [];
      for (const evalCase of cases) {
        const prepared = await prepareProductionChronicleEvalCase(evalCase);
        const dispatches: Array<{
          promptDigest: string;
          responseDigest: string;
          resolvedModel: string;
          inputTokens: number;
          outputTokens: number;
          runtimeMs: number;
          costUsd: number;
        }> = [];
        const send = async (
          messages: Parameters<
            NonNullable<
              Parameters<typeof runObservationExtractionTask>[0]["send"]
            >
          >[0],
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
          dispatches.push({
            promptDigest: await sha256Digest(prompt),
            responseDigest: await sha256Digest(response.text),
            resolvedModel: raw.response.model,
            inputTokens: response.tokensIn ?? 0,
            outputTokens: response.tokensOut ?? 0,
            runtimeMs: raw.elapsedMs,
            costUsd: raw.response.usage?.cost ?? 0,
          });
          return {
            text: response.text,
            inputTokens: response.tokensIn ?? 0,
            outputTokens: response.tokensOut ?? 0,
          };
        };

        const artifacts = await runProductionChroniclePipeline(prepared, {
          observeWithAi: (input) =>
            runObservationExtractionTask({ ...input, send }),
          synthesizeWithAi: (input) =>
            runEventSynthesisTask({ ...input, send }),
        });
        const evaluation = evaluateProductionChronicleArtifacts(
          prepared,
          artifacts,
        );
        caseReports.push({
          caseId: evalCase.id,
          corpusDigest: prepared.fixture.snapshot.digest,
          fixturePromptDigest: await sha256Digest(prepared.prompt),
          dispatches,
          observationCount: artifacts.observations.length,
          hypothesisCount: artifacts.hypotheses.length,
          proposalCount: artifacts.plannedProposals.length,
          evaluation,
        });
      }

      const eligibilityInput = {
        diagnosticOnly,
        cases: caseReports,
      };
      const certificationEligible =
        fullCertificationRun &&
        !diagnosticOnly &&
        isCertificationEligible(eligibilityInput);
      const parseFailureCount = caseReports.reduce(
        (sum, entry) => sum + entry.evaluation.parseFailureCount,
        0,
      );
      const completedAt = new Date().toISOString();
      const report = {
        schemaVersion: 1,
        runId,
        mode: "chronicle-production-live" as const,
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
        ...(binding.suiteId ? { suiteId: binding.suiteId } : {}),
        ...(binding.commandDigest
          ? { commandDigest: binding.commandDigest }
          : {}),
        ...(binding.freezeId ? { freezeId: binding.freezeId } : {}),
        ...(binding.certificationRunId
          ? { certificationRunId: binding.certificationRunId }
          : {}),
        model: { provider: "openrouter", requestedModel: model, effort },
        caseCount: caseReports.length,
        certificationEligible,
        summary: {
          passed: caseReports.filter((entry) => entry.evaluation.passed).length,
          failed: caseReports.filter((entry) => !entry.evaluation.passed)
            .length,
          parseFailureCount,
        },
        cases: caseReports,
      };
      const reportJson = await writeBoundReport(report);
      await writeFile(
        path.join(artifactRoot, "report.json"),
        reportJson,
        "utf8",
      );
      // Archived Gate B2 evidence still uses the legacy stable path. Local
      // qualification keeps its detailed source report in an ephemeral root.
      const stableRoot = binding.localQualification
        ? null
        : path.join(
            repoRoot,
            ".artifacts",
            "narrative-eval",
            "chronicle-production-live",
          );
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
          ...(stableRoot
            ? { stableReport: path.join(stableRoot, "report.json") }
            : {}),
          certificationEligible,
          summary: report.summary,
        }),
      );
      expect(report.mode).toBe("chronicle-production-live");
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
      expect(parseFailureCount).toBe(0);
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
