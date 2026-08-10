import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import type { ThreadAdvancement } from "@/features/narrative-extraction/ir/inferences/threadDevelopment";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_PLOT_DEVELOPMENT_CLASSIFY_PATH =
  "narrative_plot_development_classify" as const;

const ADVANCEMENTS: readonly ThreadAdvancement[] = [
  "establishes",
  "progresses",
  "complicates",
  "escalates",
  "redirects",
  "reveals",
  "reverses",
  "confronts",
  "resolves",
  "reopens",
];

const MATERIALITIES = ["major", "moderate", "minor"] as const;
const CENTRALITIES = ["primary", "secondary"] as const;

export interface RunPlotDevelopmentClassifyTaskInput {
  readonly developmentId: string;
  readonly documentRef: string;
  readonly threadNameSuggestion: string;
  readonly surface: string;
  readonly projectId?: string | null;
  readonly repairOnFailure?: boolean;
}

export interface PlotDevelopmentClassifyAiResult {
  readonly developmentId: string;
  readonly advancement: ThreadAdvancement;
  readonly materiality: (typeof MATERIALITIES)[number];
  readonly centrality: (typeof CENTRALITIES)[number];
}

function buildPrompt(input: RunPlotDevelopmentClassifyTaskInput): string {
  return `あなたは小説のプロットスレッド進展分類アシスタントです。1 か所の本文抜粋が、
指定スレッドをどう進めたかを JSON で分類してください。背景描写・単なる言及は minor/secondary にしてください。

# threadNameSuggestion
${input.threadNameSuggestion}

# documentRef
${input.documentRef}

# surface（本文抜粋）
${input.surface}

# advancement の選択肢
establishes, progresses, complicates, escalates, redirects, reveals, reverses, confronts, resolves, reopens

# 出力（JSON のみ）
{"developmentId":"${input.developmentId}","advancement":"progresses","materiality":"moderate","centrality":"secondary"}`;
}

function parseResult(
  responseText: string,
  input: RunPlotDevelopmentClassifyTaskInput,
): PlotDevelopmentClassifyAiResult | null {
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
  if (row.developmentId !== input.developmentId) return null;
  const advancement = row.advancement;
  if (
    typeof advancement !== "string" ||
    !ADVANCEMENTS.includes(advancement as ThreadAdvancement)
  ) {
    return null;
  }
  const materiality = row.materiality;
  if (
    typeof materiality !== "string" ||
    !MATERIALITIES.includes(materiality as (typeof MATERIALITIES)[number])
  ) {
    return null;
  }
  const centrality = row.centrality;
  if (
    typeof centrality !== "string" ||
    !CENTRALITIES.includes(centrality as (typeof CENTRALITIES)[number])
  ) {
    return null;
  }
  return {
    developmentId: input.developmentId,
    advancement: advancement as ThreadAdvancement,
    materiality: materiality as (typeof MATERIALITIES)[number],
    centrality: centrality as (typeof CENTRALITIES)[number],
  };
}

/**
 * Stage AI: narrative_plot_development_classify.
 * Classifies one document-anchored development into the fixed
 * ThreadAdvancement / materiality / centrality vocabulary. The deterministic
 * gates in plot-threads/extraction consume this classification; they are not
 * modified by this task.
 */
export async function runPlotDevelopmentClassifyTask(
  input: RunPlotDevelopmentClassifyTaskInput,
): Promise<PlotDevelopmentClassifyAiResult | null> {
  if (blockIfPolicyOff("analysis")) return null;
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(NARRATIVE_PLOT_DEVELOPMENT_CLASSIFY_PATH);
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: buildPrompt(input) }],
    {
      projectId,
      pathId: "narrative_plot_development_classify",
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
    surface: NARRATIVE_PLOT_DEVELOPMENT_CLASSIFY_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_PLOT_DEVELOPMENT_CLASSIFY_PATH },
  });

  let parsed = parseResult(response.text, input);
  if (parsed === null && input.repairOnFailure !== false) {
    const repaired = await runStructuredRepairTask({
      brokenText: response.text,
      expectedShape: `{"developmentId":"${input.developmentId}","advancement":"progresses","materiality":"moderate","centrality":"secondary"}`,
      projectId,
    });
    if (repaired) parsed = parseResult(repaired, input);
  }
  return parsed;
}
