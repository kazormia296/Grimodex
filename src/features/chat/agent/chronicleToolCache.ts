import { listCodexMatchTargets } from "@/features/codex/api";
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import {
  listEvents,
  listSceneEventsForProject,
  type EventRow,
  type SceneEventRow,
} from "@/features/chronicle/api";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { SharedLoader, registerToolTurnReset } from "./toolTurnCache";

/**
 * chronicle 系ツールが 1 ターン内で共有する lazy キャッシュ。
 * read 4 ツール + write 7 ツールの可視性チェック (isEventVisibleForWrite) が
 * それぞれ listEvents / listSceneEventsForProject / listCodexMatchTargets /
 * computeGlobalSceneOrder をフルロードし直していたのを、ターン内 1 回に畳む。
 *
 * 返り値（配列 / Map）は共有インスタンスなので呼び出し側は読み取り専用で扱うこと。
 * write ツールがデータを変更したら invalidateChronicleToolCache() を必ず呼ぶ。
 */

const eventsLoader = new SharedLoader<EventRow[]>((projectId) =>
  listEvents(projectId),
);
const sceneEventsLoader = new SharedLoader<SceneEventRow[]>((projectId) =>
  listSceneEventsForProject(projectId),
);
const codexNamesLoader = new SharedLoader<Map<string, string>>(
  async (projectId) => {
    // id→name の Map しか作らないので match projection (5 列) で十分。
    const entries = await listCodexMatchTargets(projectId);
    return new Map(entries.map((e) => [e.id, e.name] as const));
  },
);

// readingOrder は nodes 配列の参照で key する（treeStore は immutable update
// なので、ツリーが変われば参照も変わり自動的に再計算される）。
let readingOrderSlot: {
  nodes: TreeNodeData[];
  order: Map<string, number>;
} | null = null;

/** プロジェクト全イベント（listEvents）。ターン内共有。 */
export function getSharedEvents(projectId: string): Promise<EventRow[]> {
  return eventsLoader.get(projectId);
}

/** scene↔event 橋の全件（listSceneEventsForProject）。ターン内共有。 */
export function getSharedSceneEvents(
  projectId: string,
): Promise<SceneEventRow[]> {
  return sceneEventsLoader.get(projectId);
}

/** codex entryId → name の Map。ターン内共有。 */
export function getSharedCodexNames(
  projectId: string,
): Promise<Map<string, string>> {
  return codexNamesLoader.get(projectId);
}

/** 読む順 index（computeGlobalSceneOrder）。同一 nodes 参照の間は再計算しない。 */
export function getSharedReadingOrder(
  nodes: TreeNodeData[],
): Map<string, number> {
  if (!readingOrderSlot || readingOrderSlot.nodes !== nodes) {
    readingOrderSlot = { nodes, order: computeGlobalSceneOrder(nodes) };
  }
  return readingOrderSlot.order;
}

/**
 * キャッシュを全破棄する。write 系ツールが chronicle / codex データを変更した
 * 直後に必ず呼ぶこと（過剰 invalidate は再ロードを招くだけで stale を生まない）。
 */
export function invalidateChronicleToolCache(): void {
  eventsLoader.clear();
  sceneEventsLoader.clear();
  codexNamesLoader.clear();
  readingOrderSlot = null;
}

// ターン境界（runAgentLoop のツールバッチ開始）でも必ず破棄する。
registerToolTurnReset(invalidateChronicleToolCache);
