import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockNarrativeAiTask } from "./narrativeAiTaskGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import type { PlotThreadRelationKind } from "@/features/plot-threads/extraction/threadRelationSynthesis";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_PLOT_RELATION_SYNTHESIZE_PATH =
  "narrative_plot_relation_synthesize" as const;

const RELATION_KINDS: readonly PlotThreadRelationKind[] = [
  "branch",
  "merge",
  "intersection",
  "dependency",
  "causal-handoff",
];

export interface RunPlotRelationSynthesisTaskInput {
  readonly fromThreadRef: string;
  readonly toThreadRef: string;
  readonly atDocumentRef: string;
  readonly fromSummary: string;
  readonly toSummary: string;
  readonly sharedSurface: string;
  readonly projectId?: string | null;
  readonly repairOnFailure?: boolean;
}

/**
 * Proposal only — the deterministic gate in
 * plot-threads/extraction/threadRelationSynthesis.ts (evaluateThreadRelationGate)
 * decides whether this candidate becomes an accepted branch/merge row.
 */
export interface PlotRelationSynthesisAiResult {
  readonly fromThreadRef: string;
  readonly toThreadRef: string;
  readonly kind: PlotThreadRelationKind;
  readonly explanation: string;
}

function buildPrompt(input: RunPlotRelationSynthesisTaskInput): string {
  return `あなたは小説のプロットスレッド関係推論アシスタントです。2 本のスレッドがある箇所で
どう関係するかを JSON で分類してください。共有シーンに両方が登場するだけでは
branch/merge にはなりません（intersection）。

# fromThreadRef
${input.fromThreadRef}: ${input.fromSummary}

# toThreadRef
${input.toThreadRef}: ${input.toSummary}

# atDocumentRef
${input.atDocumentRef}

# sharedSurface（本文抜粋）
${input.sharedSurface}

# kind の選択肢
branch（fromThreadRef からtoThreadRefが独立した新しい核を持って分岐）,
merge（fromThreadRef がtoThreadRefへ合流し独立性を失う）,
intersection（単に同じ場面に同席するだけ）,
dependency（一方が他方の前提条件）,
causal-handoff（一方の結果が他方の引き金になる、報告のみ）

# 出力（JSON のみ）
{"fromThreadRef":"${input.fromThreadRef}","toThreadRef":"${input.toThreadRef}","kind":"intersection","explanation":"..."}`;
}

function parseResult(
  responseText: string,
  input: RunPlotRelationSynthesisTaskInput,
): PlotRelationSynthesisAiResult | null {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const row = parsed as Record<string, unknown>;
  if (row.fromThreadRef !== input.fromThreadRef) return null;
  if (row.toThreadRef !== input.toThreadRef) return null;
  const kind = row.kind;
  if (
    typeof kind !== "string" ||
    !RELATION_KINDS.includes(kind as PlotThreadRelationKind)
  ) {
    return null;
  }
  if (typeof row.explanation !== "string") return null;
  return {
    fromThreadRef: input.fromThreadRef,
    toThreadRef: input.toThreadRef,
    kind: kind as PlotThreadRelationKind,
    explanation: row.explanation.trim(),
  };
}

/**
 * Stage AI: narrative_plot_relation_synthesize.
 * Proposes a relation candidate between two Plot Thread hypotheses; the
 * deterministic evaluateThreadRelationGate (unmodified by this task) is the
 * final admission gate.
 */
export async function runPlotRelationSynthesisTask(
  input: RunPlotRelationSynthesisTaskInput,
): Promise<PlotRelationSynthesisAiResult | null> {
  if (blockNarrativeAiTask()) return null;
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(NARRATIVE_PLOT_RELATION_SYNTHESIZE_PATH);
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: buildPrompt(input) }],
    {
      projectId,
      pathId: "narrative_plot_relation_synthesize",
    },
    undefined,
    undefined,
    ov.apiVariant,
    undefined,
    ov.model,
    ov.provider,
    ov.endpointId,
  );
  void recordAiUsage({
    surface: NARRATIVE_PLOT_RELATION_SYNTHESIZE_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_PLOT_RELATION_SYNTHESIZE_PATH },
  });

  let parsed = parseResult(response.text, input);
  if (parsed === null && input.repairOnFailure !== false) {
    const repaired = await runStructuredRepairTask({
      brokenText: response.text,
      expectedShape: `{"fromThreadRef":"${input.fromThreadRef}","toThreadRef":"${input.toThreadRef}","kind":"intersection","explanation":"..."}`,
      projectId,
    });
    if (repaired) parsed = parseResult(repaired, input);
  }
  return parsed;
}
