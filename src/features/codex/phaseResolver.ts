import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntryPhase, CodexPhaseDetailOverride } from "@/db/schema";

export interface ResolvedCodexState {
  summary: string | null;
  content: string;
  contextMode: string;
  detailValues: Map<string, string | null>; // definitionId → value
  appliedPhaseIds: string[]; // 適用されたフェーズのIDリスト（デバッグ用）
}

/**
 * ツリーをDFS走査してシーンノードにグローバル順序インデックスを割り当てる。
 * sortOrder順で子を辿る。フォルダノードはindexを消費しない（シーンのみ）。
 */
export function computeGlobalSceneOrder(
  nodes: TreeNodeData[],
): Map<string, number> {
  const result = new Map<string, number>();
  if (nodes.length === 0) return result;

  // parentId → children[] マップを構築
  const childrenMap = new Map<string | null, TreeNodeData[]>();
  for (const node of nodes) {
    const key = node.parentId;
    if (!childrenMap.has(key)) {
      childrenMap.set(key, []);
    }
    childrenMap.get(key)!.push(node);
  }

  // 各グループをsortOrder順でソート
  for (const children of childrenMap.values()) {
    children.sort((a, b) => a.sortOrder - b.sortOrder);
  }

  let index = 0;

  function dfs(parentId: string | null): void {
    const children = childrenMap.get(parentId);
    if (!children) return;
    for (const node of children) {
      if (node.nodeType === "scene") {
        result.set(node.id, index++);
        // シーンは子を持てないのでDFS不要
      } else if (node.nodeType === "folder") {
        // フォルダはindexを消費しないが再帰する
        dfs(node.id);
      }
      // noteノードはスキップ（インデックス割り当てなし、再帰なし）
    }
  }

  dfs(null);
  return result;
}

/**
 * Base state + フェーズを順番に適用してResolvedCodexStateを計算する。
 */
export function resolveCodexState(
  entry: { summary: string | null; content: string; contextMode: string },
  phases: CodexEntryPhase[],
  phaseDetails: Map<string, CodexPhaseDetailOverride[]>, // phaseId → overrides
  baseDetails: Map<string, string | null>, // definitionId → value
  currentSceneId: string | null,
  sceneOrder: Map<string, number>,
): ResolvedCodexState {
  // Base stateから初期化
  const state: ResolvedCodexState = {
    summary: entry.summary,
    content: entry.content,
    contextMode: entry.contextMode,
    detailValues: new Map(baseDetails),
    appliedPhaseIds: [],
  };

  // currentSceneId=null → Baseのみ返す
  if (currentSceneId === null) {
    return state;
  }

  // currentSceneIdがsceneOrderにない（シーン削除済み） → Baseを返す
  const currentOrder = sceneOrder.get(currentSceneId);
  if (currentOrder === undefined) {
    return state;
  }

  // anchorNodeIdがnullまたはsceneOrderにないフェーズをフィルタリングしてソート
  const validPhases = phases
    .filter((phase) => {
      if (phase.anchorNodeId === null) return false;
      return sceneOrder.has(phase.anchorNodeId);
    })
    .sort((a, b) => {
      const orderA = sceneOrder.get(a.anchorNodeId!)!;
      const orderB = sceneOrder.get(b.anchorNodeId!)!;
      return orderA - orderB;
    });

  // currentScene順以下のフェーズを順番に適用
  for (const phase of validPhases) {
    const anchorOrder = sceneOrder.get(phase.anchorNodeId!)!;
    if (anchorOrder > currentOrder) break;

    // summaryOverrideがnon-null → summaryを上書き
    if (phase.summaryOverride !== null) {
      state.summary = phase.summaryOverride;
    }

    // contentOverrideがnon-null → contentを上書き
    if (phase.contentOverride !== null) {
      state.content = phase.contentOverride;
    }

    // contextModeOverrideがnon-null → contextModeを上書き
    if (phase.contextModeOverride !== null) {
      state.contextMode = phase.contextModeOverride;
    }

    // detailValuesを上書き
    const overrides = phaseDetails.get(phase.id) ?? [];
    for (const override of overrides) {
      if (override.value !== undefined) {
        state.detailValues.set(override.definitionId, override.value);
      }
    }

    state.appliedPhaseIds.push(phase.id);
  }

  return state;
}

/**
 * プロジェクトスコープ用: 「現在の状態 + 変遷リスト」フォーマット
 */
export function formatTimelineContext(
  entry: { name: string; type: string; summary: string | null },
  phases: {
    label: string;
    anchorTitle: string;
    summaryOverride: string | null;
  }[],
  latestResolved: ResolvedCodexState,
): string {
  const lines: string[] = [];

  lines.push(`# ${entry.name} (${entry.type})`);
  lines.push(`現在の状態: ${latestResolved.summary ?? "(未設定)"}`);

  if (phases.length > 0) {
    lines.push("");
    lines.push("## 変遷");
    for (const phase of phases) {
      lines.push(
        `- [${phase.label}] @ ${phase.anchorTitle}: ${phase.summaryOverride ?? "(変更なし)"}`,
      );
    }
  }

  return lines.join("\n");
}
