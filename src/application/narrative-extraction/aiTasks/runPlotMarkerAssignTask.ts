import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import { PLOT_PHASE_TYPES, type PlotPhaseType } from "@/db/schema";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_PLOT_MARKER_ASSIGN_PATH =
  "narrative_plot_marker_assign" as const;

export interface RunPlotMarkerAssignTaskInput {
  readonly documentRef: string;
  readonly threadNameSuggestion: string;
  /** Already deterministically assigned by markerRoleAssigner.assignMarkerRoles. */
  readonly primaryPhase: PlotPhaseType;
  readonly surface: string;
  readonly projectId?: string | null;
  readonly repairOnFailure?: boolean;
}

/**
 * AI-assisted refinement of a marker already placed by the deterministic
 * `assignMarkerRoles` gate. This task only fills the two fields that gate
 * intentionally leaves empty (secondaryPhase / noteSuggestion); it never
 * proposes or overrides primaryPhase.
 */
export interface PlotMarkerAssignAiResult {
  readonly documentRef: string;
  readonly secondaryPhase: PlotPhaseType | null;
  readonly noteSuggestion: string | null;
}

function buildPrompt(input: RunPlotMarkerAssignTaskInput): string {
  const phaseOptions = PLOT_PHASE_TYPES.join(", ");
  return `あなたは小説のプロットマーカー補助アシスタントです。このマーカーの主段階(primaryPhase)は
既に確定済みです。変更せず、補助情報だけを JSON で返してください。

# threadNameSuggestion
${input.threadNameSuggestion}

# documentRef
${input.documentRef}

# primaryPhase（確定済み・変更不可）
${input.primaryPhase}

# surface（本文抜粋）
${input.surface}

# secondaryPhase の選択肢（無ければ null）
${phaseOptions}

# 出力（JSON のみ）
{"documentRef":"${input.documentRef}","secondaryPhase":null,"noteSuggestion":"短い一言メモ、無ければ null"}`;
}

function parseResult(
  responseText: string,
  input: RunPlotMarkerAssignTaskInput,
): PlotMarkerAssignAiResult | null {
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
  if (row.documentRef !== input.documentRef) return null;

  let secondaryPhase: PlotPhaseType | null = null;
  if (row.secondaryPhase !== null && row.secondaryPhase !== undefined) {
    if (
      typeof row.secondaryPhase !== "string" ||
      !(PLOT_PHASE_TYPES as readonly string[]).includes(row.secondaryPhase)
    ) {
      return null;
    }
    secondaryPhase = row.secondaryPhase as PlotPhaseType;
  }

  let noteSuggestion: string | null = null;
  if (row.noteSuggestion !== null && row.noteSuggestion !== undefined) {
    if (typeof row.noteSuggestion !== "string") return null;
    const trimmed = row.noteSuggestion.trim();
    noteSuggestion = trimmed === "" ? null : trimmed;
  }

  return {
    documentRef: input.documentRef,
    secondaryPhase,
    noteSuggestion,
  };
}

/**
 * Stage AI: narrative_plot_marker_assign.
 * Complements (never overrides) the deterministic marker phase assignment
 * in plot-threads/extraction/markerRoleAssigner.ts.
 */
export async function runPlotMarkerAssignTask(
  input: RunPlotMarkerAssignTaskInput,
): Promise<PlotMarkerAssignAiResult | null> {
  if (blockIfPolicyOff("analysis")) return null;
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(NARRATIVE_PLOT_MARKER_ASSIGN_PATH);
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: buildPrompt(input) }],
    {
      projectId,
      pathId: "narrative_plot_marker_assign",
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
    surface: NARRATIVE_PLOT_MARKER_ASSIGN_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_PLOT_MARKER_ASSIGN_PATH },
  });

  let parsed = parseResult(response.text, input);
  if (parsed === null && input.repairOnFailure !== false) {
    const repaired = await runStructuredRepairTask({
      brokenText: response.text,
      expectedShape: `{"documentRef":"${input.documentRef}","secondaryPhase":null,"noteSuggestion":null}`,
      projectId,
    });
    if (repaired) parsed = parseResult(repaired, input);
  }
  return parsed;
}
