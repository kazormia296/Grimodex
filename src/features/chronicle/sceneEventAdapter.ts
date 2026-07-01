import type { EventGranularity, EventPrecision } from "@/db/schema";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { EventRow } from "./api";

/**
 * Scene-Event union: 作中日付を持つシーン(`tree_nodes`)を Chronicle タイムラインの
 * 一級トークンとして描くための擬似 EventRow アダプタ。実 event 行とは `scene:` 接頭辞の
 * id 名前空間で区別する（`realEventId` は `::` でしか分割しないので素通りする）。
 * scene:* id は events テーブルに行を持たないため、delete/update/link 等の DB 書き込み
 * 経路からは呼び出し側でガードする（`isSceneEventId` を使う）。
 */
export const SCENE_EVENT_PREFIX = "scene:";

export function sceneEventId(sceneId: string): string {
  return `${SCENE_EVENT_PREFIX}${sceneId}`;
}

export function isSceneEventId(id: string): boolean {
  return id.startsWith(SCENE_EVENT_PREFIX);
}

/** scene: 接頭辞を剥がして元のシーン id を返す（非 scene id はそのまま返す）。 */
export function sceneIdFromEventId(id: string): string {
  return isSceneEventId(id) ? id.slice(SCENE_EVENT_PREFIX.length) : id;
}

/** 1 シーンノード → 擬似 EventRow。プロパティ対応は union 設計のとおり。 */
export function buildSceneEventRow(n: TreeNodeData): EventRow {
  return {
    id: sceneEventId(n.id),
    projectId: n.projectId,
    title: n.title,
    note: n.synopsis ?? null, // synopsis(プレーン) → note(プレーン)
    detail: null, // リッチ detail はシーンに無い
    ordinal: n.storyTimeOrder ?? "a0",
    primaryCodexId: n.povCharacterId ?? null, // POV → レーン(人物)
    laneGroup: null,
    locationCodexId: n.locationId ?? null,
    startTime: n.chronicleStartTime ?? null,
    endTime: n.chronicleEndTime ?? null,
    startMinute: n.chronicleStartMinute ?? null,
    endMinute: n.chronicleEndMinute ?? null,
    startGranularity: (n.chronicleStartGranularity ??
      "none") as EventGranularity,
    endGranularity: (n.chronicleEndGranularity ?? "none") as EventGranularity,
    precision: (n.chroniclePrecision ?? "exact") as EventPrecision,
    kind: "generic", // シーンは誕生/死亡にならない
    secret: false, // 秘匿は event 専用
    revealSceneId: null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

/**
 * ノード配列から「作中日付を持つ・非アーカイブのシーン」だけを擬似 EventRow 化する。
 * 日付なしシーンはタイムラインに置き場所が無いので除外する。
 */
export function deriveSceneEventRows(nodes: TreeNodeData[]): EventRow[] {
  return nodes
    .filter(
      (n) =>
        n.nodeType === "scene" && n.chronicleStartTime != null && !n.archivedAt,
    )
    .map(buildSceneEventRow);
}
