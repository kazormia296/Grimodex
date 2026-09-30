/**
 * Billed OpenRouter migration baseline.
 *
 * Run explicitly with an ephemeral environment credential:
 *   OPENROUTER_API_KEY=... OPENROUTER_MODEL=openai/gpt-5.6-luna \
 *     pnpm eval:narrative:live
 *
 * This exercises the current production legacy Prompt/Parser. It records a
 * baseline only and cannot certify the new Narrative Extraction pipeline.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  liveApiKey,
  runLiveSingleShot,
  type OpenRouterResponse,
} from "@/features/chat/agent/aiLiveHarness";
import { validateNarrativeEvalCase } from "./caseSchema";
import { runLegacyChronicleLiveBaseline } from "./liveRunner";
import type { NarrativeEvalCaseV1 } from "./types";

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

describeLive("Chronicle legacy OpenRouter baseline", () => {
  it(
    "measures isolated Human Gold cases once and writes credential-free replay artifacts",
    async () => {
      const cases = await loadCases();
      const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-5.6-luna";
      const effort = reasoningEffort();
      const runId = `chronicle-legacy-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}`;
      const report = await runLegacyChronicleLiveBaseline(
        cases,
        async (prompt) => {
          let raw:
            | {
                response: OpenRouterResponse;
                elapsedMs: number;
              }
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
          if (!raw) throw new Error("OpenRouter raw exchange was not captured");
          if (!raw.response.model) {
            throw new Error(
              "OpenRouter response omitted resolved model identity",
            );
          }
          if (typeof raw.response.usage?.cost !== "number") {
            throw new Error("OpenRouter response omitted usage cost");
          }
          return {
            rawText: response.text,
            provider: raw.response.provider ?? "openrouter",
            requestedModel: model,
            resolvedModel: raw.response.model,
            reasoningEffort: effort,
            inputTokens: response.tokensIn ?? 0,
            outputTokens: response.tokensOut ?? 0,
            runtimeMs: raw.elapsedMs,
            costUsd: raw.response.usage.cost,
          };
        },
        { runId },
      );

      const artifactRoot = path.join(
        repoRoot,
        ".artifacts",
        "narrative-eval",
        runId,
      );
      const replayRoot = path.join(artifactRoot, "replays");
      await mkdir(replayRoot, { recursive: true });
      await Promise.all(
        report.cases.map((entry) =>
          writeFile(
            path.join(replayRoot, `${entry.caseId}.json`),
            `${JSON.stringify(entry.replay, null, 2)}\n`,
            "utf8",
          ),
        ),
      );
      await writeFile(
        path.join(artifactRoot, "report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8",
      );

      console.info(
        JSON.stringify({
          artifactRoot,
          certificationEligible: report.certificationEligible,
          summary: report.summary,
        }),
      );
      expect(report.summary.measured).toBe(cases.length);
      expect(report.certificationEligible).toBe(false);
    },
    15 * 60 * 1000,
  );
});
