import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { getPromptCatalog } from "@/prompts/index";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { getProject } from "@/features/project/api";
import { useTreeStore } from "@/features/tree/treeStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { PLOT_PHASE_TYPES, type PlotPhaseType } from "@/db/schema";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";

export interface ProposeThreadsRequest {
  scenes: Array<{
    sceneId: string;
    title: string;
    bodyText: string;
    orderIndex: number;
  }>;
  existingThreads: Array<{ name: string }>;
}

export interface PlotThreadProposalMarker {
  /** evidenceSceneId（LLM 出力）。必ず req.scenes の id のいずれか。 */
  sceneId: string;
  phaseType: PlotPhaseType;
  note?: string;
}

export interface PlotThreadProposal {
  name: string;
  description?: string;
  markers: PlotThreadProposalMarker[];
}

function isPhase(p: unknown): p is PlotPhaseType {
  return (
    typeof p === "string" && (PLOT_PHASE_TYPES as readonly string[]).includes(p)
  );
}

/**
 * LLM 出力の 1 スレッド候補を検証・正規化する。許可された sceneId 集合外の marker や
 * 不正 phase は落とす。markers が空 / name 空のスレッドは null（呼び出し側で除外）。
 */
export function normalizeProposal(
  raw: unknown,
  allowedSceneIds: Set<string>,
): PlotThreadProposal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return null;
  const description =
    typeof o.description === "string" ? o.description.trim() : undefined;
  if (!Array.isArray(o.markers)) return null;

  const markers: PlotThreadProposalMarker[] = [];
  const seen = new Set<string>();
  for (const mRaw of o.markers) {
    if (typeof mRaw !== "object" || mRaw === null) continue;
    const m = mRaw as Record<string, unknown>;
    const sceneId =
      typeof m.evidenceSceneId === "string"
        ? m.evidenceSceneId
        : typeof m.sceneId === "string"
          ? m.sceneId
          : "";
    if (!allowedSceneIds.has(sceneId)) continue; // ハルシネーション id を排除
    if (!isPhase(m.phaseType)) continue;
    const key = `${sceneId}::${m.phaseType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push({
      sceneId,
      phaseType: m.phaseType,
      note: typeof m.note === "string" ? m.note.trim() || undefined : undefined,
    });
  }
  if (markers.length === 0) return null;
  return { name, description: description || undefined, markers };
}

/**
 * PR7 soft-cutover switch (plot-thread-extraction-vertical-slice).
 *
 * Off by default: existing one-shot behavior (this file's LLM call) is
 * unchanged so current tests/production behavior are byte-identical. When
 * turned on, `proposePlotThreads` stops calling the LLM directly and
 * returns no proposals — callers should route users to the new review path
 * (`extraction-ui/PlotThreadExtractionDialog`, wired from
 * `PlotStructureAnalysis`) instead, once that pipeline's scene→IR adapter
 * (feeding signalIndex → seedManifest → narrative_plot_thread_synthesize →
 * proposalPlanner) lands.
 */
export function isNewPlotThreadExtractionPipelinePreferred(): boolean {
  return import.meta.env.VITE_PLOT_THREAD_NEW_EXTRACTION_PIPELINE === "1";
}

/**
 * Phase 4a: 既存本文（章/フォルダ単位のシーン群）を LLM 解析し、命名サブプロット
 * ＋ phaseType マーカーを提案する。foreshadow.auditChapter のイディオムを踏襲。
 *
 * TODO(plot-thread-extraction-vertical-slice PR7): retire this one-shot
 * façade once the new extraction pipeline's scene→IR adapter exists and
 * `isNewPlotThreadExtractionPipelinePreferred()` can default to true.
 */
export async function proposePlotThreads(
  req: ProposeThreadsRequest,
): Promise<PlotThreadProposal[]> {
  if (isNewPlotThreadExtractionPipelinePreferred()) return [];
  if (blockIfPolicyOff("analysis") || blockIfUnlicensed()) return [];

  const nonEmpty = req.scenes.filter((s) => s.bodyText.trim().length > 0);
  if (nonEmpty.length === 0) return [];
  const allowedSceneIds = new Set(nonEmpty.map((s) => s.sceneId));

  let lang = "ja";
  try {
    const project = await getProject(useTreeStore.getState().projectId);
    lang = project?.language ?? "ja";
  } catch {
    // ignore — 既定 ja
  }

  const sceneTexts = nonEmpty
    .map(
      (s) =>
        `--- sceneId=${s.sceneId}, title=${s.title}, order=${s.orderIndex} ---\n${s.bodyText}`,
    )
    .join("\n\n");
  const existingList =
    req.existingThreads.length > 0
      ? req.existingThreads.map((th) => `- ${th.name}`).join("\n")
      : "(なし)";

  const customInstruction = useSettingsStore
    .getState()
    .get("aiPrompt.custom.plotThread", "");

  const prompt = getPromptCatalog(
    lang,
  ).plotThread.buildProposePlotThreadsPrompt({
    existingList,
    sceneTexts,
    customInstruction,
  });

  const ov = resolveRoleSendOverride("plot_thread_propose");
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: prompt }],
    {
      projectId: requireAuditProjectId(useTreeStore.getState().projectId),
      pathId: "plot_thread_propose",
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
    surface: "plot_thread_extract",
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
  });

  const jsonText = extractJsonObject(response.text);
  if (!jsonText) return [];
  try {
    const parsed = JSON.parse(jsonText) as { threads?: unknown };
    if (!Array.isArray(parsed.threads)) return [];
    return parsed.threads
      .map((t) => normalizeProposal(t, allowedSceneIds))
      .filter((p): p is PlotThreadProposal => p !== null);
  } catch {
    return [];
  }
}
