/**
 * Chronicle 抽出の prompt cache（#798）の「品質が変わらないことの確認」。診断（diagnostic only）。
 * certification・既存の baseline・fixture・製品の経路には関わらない。課金あり（Anthropic）。
 *
 * 製品の run*Task（observation → synthesis → proposal planning）をそのまま通し、
 * 製品の `buildChroniclePromptRequest` が組む request を Anthropic の Messages API へ直接送る。
 *   - 分割あり: route を Anthropic に解決させる（system の cache segment + user の残り）
 *   - 分割なし: route を cache 非対応に解決させる（従来どおり 1 つの user message）
 * 差し替えるのは route の解決（resolveChroniclePromptRoute）と transport（sendChatMessageWithThinking）だけ。
 *
 * 実行: `node scripts/quality/chronicle-prompt-cache-diag/run.mjs`（key は run.mjs が取得して env に渡す）。
 * report は `.artifacts/chronicle-prompt-cache-diag/<runId>/` に書く（repo には commit しない）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runEventSynthesisTask } from "@/application/narrative-extraction/aiTasks/runEventSynthesisTask";
import { runObservationExtractionTask } from "@/application/narrative-extraction/aiTasks/runObservationExtractionTask";
import { sha256Digest } from "@/features/narrative-extraction/source/digest";
import {
  evaluateProductionChronicleArtifacts,
  prepareProductionChronicleEvalCase,
  runProductionChroniclePipeline,
} from "@/features/narrative-extraction/eval/productionChronicleAdapter";
import { loadNarrativeEvalSuite } from "@/features/narrative-extraction/eval/narrativeEvalSuite";
import { enumHistograms, graphDigest } from "./graphDigest";
import { lenientAlignmentCounts } from "./lenientAlignment";
import { buildAnthropicBody, sendAnthropicMessages } from "./anthropicPayload";
import {
  compareCase,
  renderMarkdown,
  type DispatchRecord,
  type RunMetrics,
  type RunRecord,
  type Shape,
} from "./comparison";
import {
  DIAG_SELECTION_PLAN,
  DIAG_SELECTION_SEED,
  seededPick,
} from "./selection";

const diag = vi.hoisted(() => ({
  model: process.env.GDX_DIAG_MODEL ?? "claude-sonnet-5-5",
  route: {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    apiVariant: null,
  } as {
    provider: string;
    model: string;
    apiVariant: string | null;
  },
  send: null as null | ((...args: unknown[]) => Promise<unknown>),
}));

vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: () => false,
}));
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: vi.fn(),
}));
vi.mock("@/features/chat/modelRouting", () => ({
  resolveRoleSendOverride: () => ({
    apiVariant: undefined,
    model: diag.model,
    provider: "anthropic",
    endpointId: undefined,
  }),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({ projectId: "chronicle-prompt-cache-diag" }),
  },
}));
// 製品の buildChroniclePromptRequest は本物のまま。route の解決だけを差し替える。
vi.mock(
  "@/application/narrative-extraction/aiTasks/chroniclePromptCache",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/application/narrative-extraction/aiTasks/chroniclePromptCache")
    >()),
    resolveChroniclePromptRoute: async () => diag.route,
  }),
);
// transport だけを差し替える（製品の task が組んだ request を Messages API へ直接送る）。
vi.mock("@/features/chat/chatApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/chat/chatApi")>()),
  sendChatMessageWithThinking: (...args: unknown[]) => diag.send!(...args),
}));

const API_KEY = process.env.ANTHROPIC_API_KEY;
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const RUNS_PER_SHAPE = Number(process.env.GDX_DIAG_RUNS ?? "2");
/** 分割あり／なしを交互に走らせ、時間の偏りを均す。 */
const SCHEDULE: readonly Shape[] = ["split", "unsplit"];

type Selected = { suiteId: string; caseId: string };
type EvalCase = Awaited<
  ReturnType<typeof loadNarrativeEvalSuite>
>["cases"][number];

async function loadSelection(): Promise<{
  selected: Selected[];
  cases: Map<string, EvalCase>;
}> {
  const override = process.env.GDX_DIAG_CASE_IDS?.split(",").filter(Boolean);
  const selected: Selected[] = [];
  const cases = new Map<string, EvalCase>();
  for (const plan of DIAG_SELECTION_PLAN) {
    const suite = await loadNarrativeEvalSuite({
      repoRoot,
      suiteId: plan.suiteId,
    });
    for (const entry of suite.cases) cases.set(entry.id, entry);
    const ids = suite.cases.map((entry) => entry.id);
    const picked = override
      ? ids.filter((id) => override.includes(id))
      : seededPick(ids, plan.count, `${DIAG_SELECTION_SEED}/${plan.suiteId}`);
    for (const caseId of picked)
      selected.push({ suiteId: plan.suiteId, caseId });
  }
  return { selected, cases };
}

const describeLive = API_KEY ? describe : describe.skip;

describeLive("Chronicle prompt cache 診断（分割あり／なし）", () => {
  it(
    "Gold を分割あり／なしの 2 形で同じ model に送り、差の表を書く",
    async () => {
      const startedAt = new Date().toISOString();
      const runId = `chronicle-prompt-cache-diag-${startedAt.replace(/[:.]/gu, "-")}`;
      const outputRoot = path.join(
        process.env.GDX_DIAG_OUTPUT_ROOT ??
          path.join(repoRoot, ".artifacts/chronicle-prompt-cache-diag"),
        runId,
      );
      await mkdir(outputRoot, { recursive: true });
      const { selected, cases } = await loadSelection();
      const runs: RunRecord[] = [];

      for (const { suiteId, caseId } of selected) {
        const evalCase = cases.get(caseId)!;
        for (let run = 1; run <= RUNS_PER_SHAPE; run += 1) {
          for (const shape of SCHEDULE) {
            const dispatches: DispatchRecord[] = [];
            const counters = new Map<string, number>();
            let failedCallCount = 0;
            diag.route =
              shape === "split"
                ? { provider: "anthropic", model: diag.model, apiVariant: null }
                : { provider: "openai", model: diag.model, apiVariant: null };
            diag.send = async (...args: unknown[]) => {
              const messages = args[0] as { role: string; content: string }[];
              const audit = args[1] as { pathId?: string };
              const segments = args[3] as string[] | undefined;
              const stage = audit.pathId ?? "unknown";
              const invocationIndex = counters.get(stage) ?? 0;
              counters.set(stage, invocationIndex + 1);
              const body = buildAnthropicBody({
                model: diag.model,
                messages,
                systemCacheSegments: segments,
              });
              let result: Awaited<ReturnType<typeof sendAnthropicMessages>>;
              try {
                result = await sendAnthropicMessages({
                  apiKey: API_KEY!,
                  body,
                  systemCacheSegments: segments,
                });
              } catch (error) {
                failedCallCount += 1;
                throw error;
              }
              dispatches.push({
                stage,
                invocationIndex,
                roles: messages.map((message) => message.role),
                segmentCount: segments?.length ?? 0,
                responseDigest: await sha256Digest(result.text),
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                cacheReadTokens: result.usage.cacheReadTokens,
                cacheWriteTokens: result.usage.cacheWriteTokens,
                stopReason: result.stopReason,
                attempts: result.attempts,
                elapsedMs: result.elapsedMs,
              });
              return {
                text: result.text,
                thinkingBlocks: [],
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                cacheReadTokens: result.usage.cacheReadTokens,
                cacheWriteTokens: result.usage.cacheWriteTokens,
              };
            };

            const prepared = await prepareProductionChronicleEvalCase(
              evalCase,
              { evidenceMode: "citation-id-v2" },
            );
            const shapeMismatchCount = () =>
              dispatches.filter((dispatch) =>
                shape === "split"
                  ? dispatch.roles.join() !== "system,user" ||
                    dispatch.segmentCount !== 1
                  : dispatch.roles.join() !== "user" ||
                    dispatch.segmentCount !== 0,
              ).length;
            let record: RunRecord;
            try {
              const artifacts = await runProductionChroniclePipeline(prepared, {
                observeWithAi: runObservationExtractionTask,
                synthesizeWithAi: runEventSynthesisTask,
              });
              const evaluation = evaluateProductionChronicleArtifacts(
                prepared,
                artifacts,
              );
              const sum = (
                key: "truePositive" | "falsePositive" | "falseNegative",
              ) =>
                Object.values(evaluation.dimensions).reduce(
                  (total, score) => total + score[key],
                  0,
                );
              const metrics: RunMetrics = {
                observationCount: artifacts.observations.length,
                hypothesisCount: artifacts.hypotheses.length,
                proposalCount: artifacts.plannedProposals.length,
                passed: evaluation.passed ? 1 : 0,
                truePositive: sum("truePositive"),
                falsePositive: sum("falsePositive"),
                falseNegative: sum("falseNegative"),
                criticalViolationCount: evaluation.criticalViolations.length,
                parseFailureCount: artifacts.parseFailureCount,
                ...lenientAlignmentCounts({
                  evalCase,
                  observations: artifacts.observations,
                  hypotheses: artifacts.hypotheses,
                  proposedHypothesisIds: new Set(
                    artifacts.plannedProposals.map(
                      (entry) => entry.hypothesisId,
                    ),
                  ),
                  documentIdBySourceRef: prepared.documentIdBySourceRef,
                }),
              };
              record = {
                caseId,
                suiteId,
                shape,
                run,
                status: "ok",
                failedCallCount,
                shapeMismatchCount: shapeMismatchCount(),
                metrics,
                ...(await (async () => {
                  const result = await graphDigest(
                    evaluation.actual,
                    artifacts.hypotheses,
                  );
                  return {
                    graphDigest: result.digest,
                    graphDigestParts: result.parts,
                    enumHistograms: enumHistograms(evaluation.actual),
                  };
                })()),
                dispatches,
              };
            } catch (error) {
              record = {
                caseId,
                suiteId,
                shape,
                run,
                status: "failed",
                failure: `${(error as Error)?.name ?? "Error"}: ${String(
                  (error as Error)?.message ?? error,
                ).slice(0, 120)}`,
                failedCallCount,
                shapeMismatchCount: shapeMismatchCount(),
                dispatches,
              };
            }
            runs.push(record);
            console.info(
              `[diag] ${caseId} ${shape} run${run} ${record.status} dispatches=${dispatches.length} failedCalls=${failedCallCount}`,
            );
          }
        }
      }

      const comparisons = selected.map(({ suiteId, caseId }) =>
        compareCase(
          caseId,
          suiteId,
          runs.filter((record) => record.caseId === caseId),
        ),
      );
      const completedAt = new Date().toISOString();
      const report = {
        schemaVersion: 1,
        mode: "chronicle-prompt-cache-diagnostic" as const,
        diagnosticOnly: true,
        certificationEligible: false,
        note: "Diagnostic only. Not a certification run; no baseline, fixture or attempt rule is affected. No prompt/response text is recorded.",
        runId,
        model: diag.model,
        startedAt,
        completedAt,
        selection: {
          seed: DIAG_SELECTION_SEED,
          plan: DIAG_SELECTION_PLAN,
          selected,
        },
        runsPerShape: RUNS_PER_SHAPE,
        cases: comparisons,
        runs,
      };
      await writeFile(
        path.join(outputRoot, "report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(outputRoot, "report.md"),
        renderMarkdown(report),
        "utf8",
      );
      console.info(JSON.stringify({ outputRoot }));
      expect(report.diagnosticOnly).toBe(true);
    },
    60 * 60 * 1000,
  );
});
