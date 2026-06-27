import type { Editor } from "@tiptap/core";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { getProject } from "@/features/project/api";
import { useCodexStore } from "@/features/codex/codexStore";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
// NOTE: findBeatById must come from "./insertBeatStream" — generateBeatOnce's
// tests mock that module and assert the call goes through the mock.
import { findBeatById } from "./insertBeatStream";
import { extractBeatMentions } from "./extractBeatMentions";
import { extractBeatTextFromNode } from "./listPlacedBeats";
import type { BeatType } from "@/features/editor/SceneBeatNode";

type TreeNode = ReturnType<typeof useTreeStore.getState>["nodes"][number];
type CodexEntries = ReturnType<typeof useCodexStore.getState>["entries"];

/** codexSummaries の合計文字数上限（inline AI の CODEX_SUMMARIES_LIMIT と同水準） */
const CODEX_SUMMARIES_LIMIT = 3000;

export interface BeatGenerationContext {
  beatPos: number;
  instructions: string;
  beatType: BeatType;
  beatModel: string | null;
  /** 送信先プロバイダ override（null = 設定のアクティブプロバイダへ継承）。 */
  beatModelProvider: string | null;
  /** 別プロバイダ送信時の解決済み API 経路（variant）。 */
  beatModelVariant: string | null;
  /** OpenAI 互換で別エンドポイントを選んでいるときの endpoint id。 */
  beatModelEndpointId: string | null;
  projectTitle: string;
  sceneTitle: string;
  sceneTextSoFar: string;
  povName: string | null;
  lang: string;
  /** 検出 codex の `- name: summary` 行（inline AI の codexSummaries と同形式）。 */
  codexSummaries: string;
  /** Scene tree node — useBeatGeneration needs it for the pending-beats section. */
  node: TreeNode | undefined;
  codexEntries: CodexEntries;
}

/**
 * matchedIds の codex を `- name: summary` 行に整形する（合計 3000 字 cap、
 * summary 空のエントリは除外）。inline AI の buildCodexSummaries と同じ規則。
 */
export function buildBeatCodexSummaries(
  matchedIds: readonly string[],
  entries: ReadonlyArray<{ id: string; name: string; summary: string | null }>,
): string {
  if (matchedIds.length === 0) return "";
  const idSet = new Set(matchedIds);
  const lines: string[] = [];
  let total = 0;
  for (const entry of entries) {
    if (!idSet.has(entry.id)) continue;
    const summary = (entry.summary ?? "").trim();
    if (!summary) continue;
    const line = `- ${entry.name}: ${summary}`;
    if (total + line.length + 1 > CODEX_SUMMARIES_LIMIT) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}

export type BuildBeatContextResult =
  | { ok: true; ctx: BeatGenerationContext }
  | { ok: false; reason: "no-beat" | "empty-instructions" };

/**
 * Resolve the shared generation context for a beat: instructions and attrs
 * from the beat node, scene/project titles, POV name, language, and the doc
 * text preceding the beat. Shared by the three generation paths
 * (useBeatGeneration / generateBeatOnce / generateBeatAlternative).
 *
 * Returns a discriminated result instead of throwing so each caller keeps
 * its own failure behavior (silent return vs. error state) — only
 * useBeatGeneration surfaces "empty-instructions" as an error.
 */
export async function buildBeatContextForGeneration(
  editor: Editor,
  beatId: string,
  sceneId: string,
): Promise<BuildBeatContextResult> {
  const beat = findBeatById(editor, beatId);
  if (!beat) return { ok: false, reason: "no-beat" };

  const beatNode = editor.state.doc.nodeAt(beat.beatPos);
  if (!beatNode) return { ok: false, reason: "no-beat" };

  const instructions = extractBeatTextFromNode(beatNode);
  if (instructions.trim().length === 0) {
    return { ok: false, reason: "empty-instructions" };
  }

  const beatType = (beatNode.attrs.beatType ?? "free") as BeatType;
  const beatPov = (beatNode.attrs.pov ?? null) as string | null;
  const beatModel = (beatNode.attrs.model as string | null) ?? null;
  const beatModelProvider =
    (beatNode.attrs.modelProvider as string | null) ?? null;
  const beatModelVariant =
    (beatNode.attrs.modelVariant as string | null) ?? null;
  const beatModelEndpointId =
    (beatNode.attrs.modelEndpointId as string | null) ?? null;

  const node = useTreeStore.getState().nodes.find((n) => n.id === sceneId);
  const projectTitle = useWorkspaceStore.getState().activeWorkspaceName ?? "";
  const sceneTitle = node?.title ?? "";
  const codexEntries = useCodexStore.getState().entries;
  let project;
  try {
    project = await getProject(useTreeStore.getState().projectId);
  } catch {
    // ignore
  }
  const lang = project?.language ?? "ja";

  const povCharId = beatPov ?? node?.povCharacterId ?? null;
  const povName = povCharId
    ? (codexEntries.find((e) => e.id === povCharId)?.name ?? null)
    : null;

  const sceneTextSoFar = editor.state.doc.textBetween(
    0,
    beat.beatPos,
    "\n",
    " ",
  );

  // 検出 codex = シーン本文の自動検出 (inline AI と同じソース) ∪ この beat の
  // @mention（mention は atom で本文検出に乗らないため明示的に拾う）。
  const matchedIds = new Set(useCodexHighlightStore.getState().matchedEntryIds);
  for (const mention of extractBeatMentions(editor.state.doc)) {
    if (mention.beatId === beatId) matchedIds.add(mention.codexId);
  }
  const codexSummaries = buildBeatCodexSummaries(
    [...matchedIds],
    codexEntries ?? [],
  );

  return {
    ok: true,
    ctx: {
      beatPos: beat.beatPos,
      instructions,
      beatType,
      beatModel,
      beatModelProvider,
      beatModelVariant,
      beatModelEndpointId,
      projectTitle,
      sceneTitle,
      sceneTextSoFar,
      povName,
      lang,
      codexSummaries,
      node,
      codexEntries,
    },
  };
}
