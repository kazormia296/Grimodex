/**
 * Billed OpenRouter observation-path live eval.
 *
 * Run explicitly with an ephemeral environment credential:
 *   OPENROUTER_API_KEY=... OPENROUTER_MODEL=openai/gpt-5.6-luna \
 *     pnpm eval:narrative:observation:live
 *
 * Exercises production `runObservationExtractionTask` prompt/parser.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  liveApiKey,
  runLiveSingleShot,
  type OpenRouterResponse,
} from "@/features/chat/agent/aiLiveHarness";
import { validateNarrativeEvalCase } from "./caseSchema";
import {
  prepareObservationEvalCase,
  runProductionObservationExtraction,
} from "./observationAdapter";
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

describeLive("Chronicle observation OpenRouter live eval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(
    "runs production observation extraction and asserts parse + exact evidence",
    async () => {
      const cases = await loadCases();
      const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-5.6-luna";
      const effort = reasoningEffort();
      const runId = `chronicle-observation-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}`;
      const artifactRoot = path.join(
        repoRoot,
        ".artifacts",
        "narrative-eval",
        runId,
      );
      await mkdir(artifactRoot, { recursive: true });

      const caseReports = [];
      for (const evalCase of cases) {
        const prepared = await prepareObservationEvalCase(evalCase);
        let capturedRaw = "";
        let rawExchange:
          | {
              response: OpenRouterResponse;
              elapsedMs: number;
            }
          | undefined;

        const { evaluation, observations } =
          await runProductionObservationExtraction(
            prepared,
            async (messages) => {
              const prompt =
                typeof messages[0]?.content === "string"
                  ? messages[0].content
                  : prepared.prompt;
              const response = await runLiveSingleShot(prompt, {
                send: {
                  apiKey: KEY,
                  model,
                  reasoning: { effort },
                  onRawExchange: (exchange) => {
                    rawExchange = {
                      response: exchange.response,
                      elapsedMs: exchange.elapsedMs,
                    };
                  },
                },
              });
              capturedRaw = response.text;
              return {
                text: response.text,
                inputTokens: response.tokensIn ?? 0,
                outputTokens: response.tokensOut ?? 0,
              };
            },
          );

        expect(evaluation.parseStatus).toBe("parsed");
        expect(evaluation.unknownSourceRefsRejected).toBe(true);
        for (const observation of observations) {
          for (const evidence of observation.evidence) {
            const haystack =
              prepared.textBySourceRef.get(evidence.sourceRef) ?? "";
            expect(haystack.includes(evidence.quote)).toBe(true);
            expect(prepared.allowedSourceRefs.has(evidence.sourceRef)).toBe(
              true,
            );
          }
        }

        caseReports.push({
          caseId: evalCase.id,
          parseStatus: evaluation.parseStatus,
          observationCount: observations.length,
          evidenceQuotesExact: evaluation.evidenceQuotesExact,
          unknownSourceRefsRejected: evaluation.unknownSourceRefsRejected,
          passed: evaluation.passed,
          criticalViolations: evaluation.criticalViolations,
          usage: rawExchange
            ? {
                inputTokens: rawExchange.response.usage?.prompt_tokens,
                outputTokens: rawExchange.response.usage?.completion_tokens,
                costUsd: rawExchange.response.usage?.cost,
                runtimeMs: rawExchange.elapsedMs,
                resolvedModel: rawExchange.response.model,
              }
            : null,
          rawTextDigestLength: capturedRaw.length,
        });
      }

      await writeFile(
        path.join(artifactRoot, "report.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            runId,
            mode: "chronicle-observation-live",
            certificationEligible: false,
            cases: caseReports,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      console.info(
        JSON.stringify({
          artifactRoot,
          measured: caseReports.length,
          passed: caseReports.filter((entry) => entry.passed).length,
        }),
      );
      expect(caseReports.length).toBe(cases.length);
    },
    15 * 60 * 1000,
  );
});
