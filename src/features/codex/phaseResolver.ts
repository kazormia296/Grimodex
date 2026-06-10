import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntryPhase, CodexPhaseDetailOverride } from "@/db/schema";
import { cmpKeys } from "@/features/tree/fractionalIndex";

export type PhaseResolutionMode = "reading" | "story" | "auto";

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
    children.sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
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
 * phase_resolution_mode に応じたシーンインデックスを計算する。
 * - reading: DFS順（reading-order）
 * - story / auto: storyTimeOrder順。未設定シーンはreading-order末尾に追加
 */
export function computeSceneTimeIndex(
  nodes: TreeNodeData[],
  mode: PhaseResolutionMode,
): Map<string, number> {
  if (mode === "reading") {
    return computeGlobalSceneOrder(nodes);
  }

  // story / auto: scheduled scenes sorted by storyTimeOrder, then unscheduled in reading-order
  const readingOrder = computeGlobalSceneOrder(nodes);
  const scenes = nodes.filter((n) => n.nodeType === "scene");

  const scheduled = scenes.filter((s) => s.storyTimeOrder !== null);
  const unscheduled = scenes.filter((s) => s.storyTimeOrder === null);

  scheduled.sort((a, b) => cmpKeys(a.storyTimeOrder!, b.storyTimeOrder!));
  unscheduled.sort(
    (a, b) =>
      (readingOrder.get(a.id) ?? Infinity) -
      (readingOrder.get(b.id) ?? Infinity),
  );

  const result = new Map<string, number>();
  let index = 0;
  for (const scene of [...scheduled, ...unscheduled]) {
    result.set(scene.id, index++);
  }
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
  options?: { applyAllPhases?: boolean },
): ResolvedCodexState {
  // Base stateから初期化
  const state: ResolvedCodexState = {
    summary: entry.summary,
    content: entry.content,
    contextMode: entry.contextMode,
    detailValues: new Map(baseDetails),
    appliedPhaseIds: [],
  };

  const applyAllPhases = options?.applyAllPhases === true;

  // currentSceneId=null → Baseのみ返す（applyAllPhases 時は全 valid phase を適用）
  if (currentSceneId === null && !applyAllPhases) {
    return state;
  }

  let currentOrder: number | undefined;
  if (!applyAllPhases) {
    // currentSceneIdがsceneOrderにない（シーン削除済み） → Baseを返す
    currentOrder = sceneOrder.get(currentSceneId!);
    if (currentOrder === undefined) {
      return state;
    }
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

  // currentScene順以下のフェーズを順番に適用（applyAllPhases 時は gating なし）
  for (const phase of validPhases) {
    if (!applyAllPhases) {
      const anchorOrder = sceneOrder.get(phase.anchorNodeId!)!;
      if (anchorOrder > currentOrder!) break;
    }

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

export interface PhaseExposureBreakdown {
  /** AI に露出する Phase 数（always/mentioned が effective） */
  aiVisibleCount: number;
  /** Wiki 限定 Phase 数（suppress/hidden が effective） */
  wikiOnlyCount: number;
  /** Phase 総数 */
  total: number;
  /** Base の contextMode が AI 露出か */
  baseIsAiVisible: boolean;
  /**
   * AI 露出状態における summary 文字数の最大値。
   * Base が AI-visible なら base.summary 長を初期値に、各 AI-visible Phase の
   * resolved summary 長と比較して最大を取る。Wiki-only 状態の値は無視。
   */
  maxAiVisibleSummaryChars: number;
}

function isAiVisibleMode(mode: string): boolean {
  return mode === "always" || mode === "mentioned";
}

/**
 * Phase 群を Base から順に走査し、AI 露出 / Wiki 限定の分解と
 * AI 露出時の summary 文字数の最大値を算出する。
 * Phases は anchor シーン順にソート済みである前提。
 */
export function computePhaseExposureBreakdown(input: {
  baseSummary: string | null;
  baseContextMode: string;
  phases: CodexEntryPhase[];
}): PhaseExposureBreakdown {
  const { baseSummary, baseContextMode, phases } = input;
  let currentMode = baseContextMode;
  let currentSummary = baseSummary ?? "";
  const baseIsAiVisible = isAiVisibleMode(baseContextMode);
  let maxChars = baseIsAiVisible ? currentSummary.length : 0;

  let aiVisible = 0;
  let wikiOnly = 0;
  for (const phase of phases) {
    if (phase.contextModeOverride !== null) {
      currentMode = phase.contextModeOverride;
    }
    if (phase.summaryOverride !== null) {
      currentSummary = phase.summaryOverride;
    }
    if (isAiVisibleMode(currentMode)) {
      aiVisible++;
      if (currentSummary.length > maxChars) maxChars = currentSummary.length;
    } else {
      wikiOnly++;
    }
  }

  return {
    aiVisibleCount: aiVisible,
    wikiOnlyCount: wikiOnly,
    total: phases.length,
    baseIsAiVisible,
    maxAiVisibleSummaryChars: maxChars,
  };
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
