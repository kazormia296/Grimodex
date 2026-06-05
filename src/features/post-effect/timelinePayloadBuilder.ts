/**
 * timelinePayloadBuilder.ts
 * timeline_consistency (物語内時系列の整合性) の multi (folder/project) ペイロード。
 *
 * クロスシーン整合性は run_multi_task のシーン fan-out で扱う: story-time 配置済シーンを
 * 昇順に並べ、各シーン本文を per-scene チェックにかけつつ、確立済タイムラインの**要約**
 * (title / story_time_label / 概要) を system_prompt に注入する (appendTimelineGuidance)。
 * 「全シーン本文を 1 度に渡す holistic な因果レビュー」ではなく
 * 「各シーンを確立済タイムラインに照らす」検査である点に注意。
 */

import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { prosemirrorToText } from "@/lib/prosemirror";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { computeInputHash, normalizeText } from "./canonicalize";
import { kouetsuScopeSuffix, timelineScopeSuffix } from "./customInstruction";

export const TIMELINE_CONSISTENCY_PROMPT_VERSION = "timeline_consistency_v1.0";

/** タイムライン要約 1 エントリの本文抜粋の最大文字数 (system_prompt 肥大化を防ぐ)。 */
export const TIMELINE_ENTRY_EXCERPT_MAX = 100;

export interface TimelineMultiSceneEntry {
  scene_id: string;
  codex_payload_json: string;
  scene_text: string;
}

export interface TimelinePayloadResult {
  /** run 対象 (story-time 配置済) シーン群・昇順。 */
  scenes: TimelineMultiSceneEntry[];
  /** system_prompt に注入する story-time 昇順の要約文脈。 */
  timelineContext: string;
  inputHash: string;
}

async function getScenePlainText(sceneId: string): Promise<string> {
  const rows = await db
    .select({ content: treeNodes.content })
    .from(treeNodes)
    .where(eq(treeNodes.id, sceneId));
  if (!rows[0]) return "";
  return prosemirrorToText(rows[0].content ?? "{}");
}

/** scope 内の story-time 配置済シーンを昇順で返す。未配置 (null/空) は除外。 */
export function getPlacedScenesForScope(
  nodes: TreeNodeData[],
  scopeType: "folder" | "project",
  scopeTargetId: string | null,
): TreeNodeData[] {
  const inScope: TreeNodeData[] = [];
  if (scopeType === "project") {
    for (const n of nodes) if (n.nodeType === "scene") inScope.push(n);
  } else {
    const walk = (parentId: string) => {
      for (const n of nodes) {
        if (n.parentId !== parentId) continue;
        if (n.nodeType === "scene") inScope.push(n);
        else if (n.nodeType === "folder") walk(n.id);
      }
    };
    if (scopeTargetId) walk(scopeTargetId);
  }
  return inScope
    .filter((n) => n.storyTimeOrder != null && n.storyTimeOrder.trim() !== "")
    .sort((a, b) => cmpKeys(a.storyTimeOrder ?? "", b.storyTimeOrder ?? ""));
}

function excerpt(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/** story-time 昇順シーンから system_prompt 用の要約文脈を組む (synopsis 優先・本文抜粋 fallback)。 */
export function buildTimelineContext(
  placed: Array<
    Pick<TreeNodeData, "title" | "synopsis" | "storyTimeLabel"> & {
      bodyExcerptSource: string;
    }
  >,
): string {
  return placed
    .map((node, i) => {
      const idx = i + 1;
      const label = node.storyTimeLabel?.trim() || `T${idx}`;
      const summary =
        node.synopsis?.trim() ||
        excerpt(node.bodyExcerptSource, TIMELINE_ENTRY_EXCERPT_MAX) ||
        "(本文なし)";
      return `${idx}. [${label}] ${node.title} — ${summary}`;
    })
    .join("\n");
}

export async function buildTimelinePayload(
  scopeType: "folder" | "project",
  scopeTargetId: string | null,
  model: string,
  customInstruction: string = "",
): Promise<TimelinePayloadResult> {
  const { nodes } = useTreeStore.getState();
  const placed = getPlacedScenesForScope(nodes, scopeType, scopeTargetId);

  const scenes: TimelineMultiSceneEntry[] = [];
  const contextInput: Array<
    Pick<TreeNodeData, "title" | "synopsis" | "storyTimeLabel"> & {
      bodyExcerptSource: string;
    }
  > = [];
  for (const node of placed) {
    const sceneText = await getScenePlainText(node.id);
    scenes.push({
      scene_id: node.id,
      codex_payload_json: "[]",
      scene_text: sceneText,
    });
    contextInput.push({
      title: node.title,
      synopsis: node.synopsis,
      storyTimeLabel: node.storyTimeLabel,
      bodyExcerptSource: sceneText,
    });
  }

  const timelineContext = buildTimelineContext(contextInput);

  const inputHash = await computeInputHash({
    promptVersion: TIMELINE_CONSISTENCY_PROMPT_VERSION,
    model,
    effectType: "timeline_consistency",
    scene: scenes.map((s) => normalizeText(s.scene_text)).join("|"),
    scope: `${scopeType}:${scopeTargetId ?? "all"}${kouetsuScopeSuffix(
      customInstruction,
    )}${timelineScopeSuffix(timelineContext)}`,
  });

  return { scenes, timelineContext, inputHash };
}
