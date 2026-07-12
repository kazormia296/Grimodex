import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntryPhase, CodexPhaseDetailOverride } from "@/db/schema";
import {
  buildReadingOrder,
  buildSceneTimeIndex,
  linearizeSceneTimeIndex,
  type PhaseResolutionMode,
  type ResolutionAxis,
  type SceneTimeIndex,
  type TemporalAnchor,
} from "./context/sceneTimeIndex";
import {
  resolveApplicablePhases,
  type PhaseFallbackReason,
} from "./context/resolveApplicablePhases";

export type {
  PhaseResolutionMode,
  ResolutionAxis,
  SceneTimeIndex,
  TemporalAnchor,
};

export interface ResolvedCodexState {
  summary: string | null;
  content: string;
  contextMode: string;
  detailValues: Map<string, string | null>; // definitionId → value
  appliedPhaseIds: string[]; // 適用されたフェーズのIDリスト（デバッグ用）
  activePhaseId: string | null;
  activePhaseLabel: string | null;
  axisUsed: ResolutionAxis | null;
  fallbackReason: PhaseFallbackReason | null;
}

/**
 * ツリーをDFS走査してシーンノードにグローバル順序インデックスを割り当てる。
 * sortOrder順で子を辿る。フォルダノードはindexを消費しない（シーンのみ）。
 */
export function computeGlobalSceneOrder(
  nodes: TreeNodeData[],
): Map<string, number> {
  return buildReadingOrder(nodes);
}

/**
 * phase_resolution_mode に応じたシーンインデックスを計算する。
 * - reading: DFS順（reading-order）
 * - auto: 全 live scene の storyTimeOrder が揃うまで reading、揃えば story
 * - story: inherited story order。冒頭に未解決 scene があれば安全側に reading
 *
 * @deprecated Phase semantics は entry 単位 fallback を必要とするため、この単一
 * Map ではなく SceneTimeIndex + resolveApplicablePhases を使用すること。
 */
export function computeSceneTimeIndex(
  nodes: TreeNodeData[],
  mode: PhaseResolutionMode,
): Map<string, number> {
  return linearizeSceneTimeIndex(buildSceneTimeIndex(nodes), mode);
}

type ResolvableEntry = {
  summary: string | null;
  content: string;
  contextMode: string;
};

export interface LegacyResolveCodexStateOptions {
  applyAllPhases?: boolean;
}

/**
 * Base state + フェーズを順番に適用してResolvedCodexStateを計算する。
 */
export function resolveCodexState(
  entry: ResolvableEntry,
  phases: CodexEntryPhase[],
  phaseDetails: Map<string, CodexPhaseDetailOverride[]>,
  baseDetails: Map<string, string | null>,
  anchor: TemporalAnchor,
  sceneTimeIndex: SceneTimeIndex,
  resolutionMode: PhaseResolutionMode,
): ResolvedCodexState;
/** @deprecated Migrate callers to TemporalAnchor + SceneTimeIndex. */
export function resolveCodexState(
  entry: ResolvableEntry,
  phases: CodexEntryPhase[],
  phaseDetails: Map<string, CodexPhaseDetailOverride[]>,
  baseDetails: Map<string, string | null>,
  currentSceneId: string | null,
  sceneOrder: Map<string, number>,
  options?: LegacyResolveCodexStateOptions,
): ResolvedCodexState;
export function resolveCodexState(
  entry: ResolvableEntry,
  phases: CodexEntryPhase[],
  phaseDetails: Map<string, CodexPhaseDetailOverride[]>, // phaseId → overrides
  baseDetails: Map<string, string | null>, // definitionId → value
  anchorOrSceneId: TemporalAnchor | string | null,
  indexOrOrder: SceneTimeIndex | Map<string, number>,
  modeOrOptions?: PhaseResolutionMode | LegacyResolveCodexStateOptions,
): ResolvedCodexState {
  // Base stateから初期化
  const state: ResolvedCodexState = {
    summary: entry.summary,
    content: entry.content,
    contextMode: entry.contextMode,
    detailValues: new Map(baseDetails),
    appliedPhaseIds: [],
    activePhaseId: null,
    activePhaseLabel: null,
    axisUsed: null,
    fallbackReason: null,
  };

  const applyPhase = (phase: CodexEntryPhase): void => {
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
    state.activePhaseId = phase.id;
    state.activePhaseLabel = phase.label;
  };

  if (!(indexOrOrder instanceof Map)) {
    if (typeof anchorOrSceneId !== "object" || anchorOrSceneId === null) {
      return state;
    }
    const resolution = resolveApplicablePhases({
      phases,
      index: indexOrOrder,
      mode:
        typeof modeOrOptions === "string"
          ? modeOrOptions
          : ("reading" as const),
      anchor: anchorOrSceneId,
    });
    state.axisUsed = resolution.axisUsed;
    state.fallbackReason = resolution.fallbackReason;
    for (const phase of resolution.applicablePhases) applyPhase(phase);
    return state;
  }

  // Legacy compatibility path. A single Map cannot represent entry-level story
  // fallback, so new consumers must use the SceneTimeIndex overload above.
  const sceneOrder = indexOrOrder;
  const currentSceneId =
    typeof anchorOrSceneId === "string" ? anchorOrSceneId : null;
  const options = typeof modeOrOptions === "object" ? modeOrOptions : undefined;
  const applyAllPhases = options?.applyAllPhases === true;

  if (currentSceneId === null && !applyAllPhases) return state;
  const currentOrder = applyAllPhases
    ? undefined
    : sceneOrder.get(currentSceneId as string);
  if (!applyAllPhases && currentOrder === undefined) return state;

  const validPhases = phases
    .filter(
      (phase) =>
        phase.anchorNodeId !== null && sceneOrder.has(phase.anchorNodeId),
    )
    .sort((a, b) => {
      const orderDiff =
        sceneOrder.get(a.anchorNodeId!)! - sceneOrder.get(b.anchorNodeId!)!;
      return (
        orderDiff ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id)
      );
    });

  for (const phase of validPhases) {
    if (
      !applyAllPhases &&
      sceneOrder.get(phase.anchorNodeId!)! > currentOrder!
    ) {
      break;
    }
    applyPhase(phase);
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
  /** project 言語。en 系のとき見出し/プレースホルダを英語化 (lang 省略=ja 不変)。 */
  lang?: string | null,
): string {
  const isEn = lang?.startsWith("en") ?? false;
  const lines: string[] = [];

  lines.push(`# ${entry.name} (${entry.type})`);
  lines.push(
    `${isEn ? "Current state" : "現在の状態"}: ${latestResolved.summary ?? (isEn ? "(unset)" : "(未設定)")}`,
  );

  if (phases.length > 0) {
    lines.push("");
    lines.push(isEn ? "## Changes" : "## 変遷");
    for (const phase of phases) {
      lines.push(
        `- [${phase.label}] @ ${phase.anchorTitle}: ${phase.summaryOverride ?? (isEn ? "(no change)" : "(変更なし)")}`,
      );
    }
  }

  return lines.join("\n");
}
