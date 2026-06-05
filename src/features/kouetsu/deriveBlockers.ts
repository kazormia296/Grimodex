import type { DerivedLabel } from "@/features/foreshadow/types";
import type { PostEffectSeverity } from "@/features/post-effect/types";

/**
 * Tier A-3: 「ブロッカー / 次にやること」ダッシュボードの導出ロジック (純関数)。
 *
 * 各ドメインパネルが既に計算しているシグナルを 1 つのランク付きビューに集約するだけ。
 * 新規 authored データは不要。配置 (Kouetsu タブ) とは独立にユニットテストできる。
 *
 * 設計判断:
 * - lens 未診断 (lens=null) は stale でも severe でもない別状態として除外する
 *   (「まだ診断していない」を「診断が陳腐化した」と混同しない)。
 * - intent 空シーンは opt-in 機能ゆえ大量になりうるので最下位 (info)。UI 側で畳む。
 * - weak motive / 散乱 decision は基盤不在ゆえ対象外 (motivation モデル無し /
 *   ChatHistory は decision 非キャプチャ)。
 */

export type BlockerSeverity = "critical" | "warning" | "info";

export type BlockerKind =
  | "foreshadow_critical_weak"
  | "foreshadow_orphan_payoff"
  | "foreshadow_needs_strengthening"
  | "foreshadow_abandoned"
  | "diagnostic_severe"
  | "diagnostic_stale"
  | "scene_unplaced_beats"
  | "scene_loose"
  | "scene_intent_empty"
  | "trash_salvageable";

export interface BlockerEntry {
  id: string;
  label: string;
  /** クリック時のナビゲーション先シーン。シーンに紐づかない項目は null。 */
  sceneId: string | null;
}

export interface BlockerGroup {
  kind: BlockerKind;
  severity: BlockerSeverity;
  entries: BlockerEntry[];
}

export interface BlockerSceneSignal {
  id: string;
  title: string;
  intent: string | null;
  /** project root 直下 (chapter folder に属さない) シーンか。 */
  isLoose: boolean;
  /** 未配置 beat preview を持つか。 */
  hasUnplacedBeats: boolean;
  /** lens 診断状態。null = 未診断 (severe/stale のどちらでもない)。 */
  lens: { worst: PostEffectSeverity; stale: boolean } | null;
}

export interface BlockerForeshadowSignal {
  id: string;
  title: string;
  label: DerivedLabel;
}

export interface BlockerTrashSignal {
  id: string;
  label: string;
}

export interface BlockerInput {
  foreshadows: BlockerForeshadowSignal[];
  /** 対象は scene ノードのみ・非アーカイブを呼び出し側で絞ること。 */
  scenes: BlockerSceneSignal[];
  salvageableTrash: BlockerTrashSignal[];
}

const SEVERITY_WEIGHT: Record<BlockerSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/** 同 severity 内の安定表示順。 */
const KIND_ORDER: BlockerKind[] = [
  "foreshadow_critical_weak",
  "diagnostic_severe",
  "foreshadow_orphan_payoff",
  "foreshadow_needs_strengthening",
  "scene_unplaced_beats",
  "scene_loose",
  "diagnostic_stale",
  "foreshadow_abandoned",
  "scene_intent_empty",
  "trash_salvageable",
];

export function deriveBlockers(input: BlockerInput): BlockerGroup[] {
  const groups: BlockerGroup[] = [];

  // ── foreshadow ──────────────────────────────────────────────
  const fsByLabel = (label: DerivedLabel): BlockerEntry[] =>
    input.foreshadows
      .filter((f) => f.label === label)
      .map((f) => ({ id: f.id, label: f.title, sceneId: null }));

  pushGroup(
    groups,
    "foreshadow_critical_weak",
    "critical",
    fsByLabel("critical_weak"),
  );
  pushGroup(
    groups,
    "foreshadow_orphan_payoff",
    "warning",
    fsByLabel("orphan_payoff"),
  );
  pushGroup(
    groups,
    "foreshadow_needs_strengthening",
    "warning",
    fsByLabel("needs_strengthening"),
  );
  pushGroup(groups, "foreshadow_abandoned", "info", fsByLabel("abandoned"));

  // ── lens 診断 (未診断 null は除外) ───────────────────────────
  const severeScenes = input.scenes.filter(
    (s) => s.lens && (s.lens.worst === "error" || s.lens.worst === "warning"),
  );
  const severeSeverity: BlockerSeverity = severeScenes.some(
    (s) => s.lens?.worst === "error",
  )
    ? "critical"
    : "warning";
  pushGroup(
    groups,
    "diagnostic_severe",
    severeSeverity,
    severeScenes.map((s) => sceneEntry(s)),
  );

  pushGroup(
    groups,
    "diagnostic_stale",
    "info",
    input.scenes
      .filter((s) => s.lens?.stale === true)
      .map((s) => sceneEntry(s)),
  );

  // ── 構造の穴 ────────────────────────────────────────────────
  pushGroup(
    groups,
    "scene_unplaced_beats",
    "warning",
    input.scenes.filter((s) => s.hasUnplacedBeats).map((s) => sceneEntry(s)),
  );
  pushGroup(
    groups,
    "scene_loose",
    "warning",
    input.scenes.filter((s) => s.isLoose).map((s) => sceneEntry(s)),
  );
  pushGroup(
    groups,
    "scene_intent_empty",
    "info",
    input.scenes
      .filter((s) => (s.intent ?? "").trim() === "")
      .map((s) => sceneEntry(s)),
  );

  // ── trash 救済候補 ──────────────────────────────────────────
  pushGroup(
    groups,
    "trash_salvageable",
    "info",
    input.salvageableTrash.map((t) => ({
      id: t.id,
      label: t.label,
      sceneId: null,
    })),
  );

  return groups.sort((a, b) => {
    const w = SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity];
    if (w !== 0) return w;
    return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  });
}

/** 全グループの entries 合計。ダッシュボードのバッジ件数。 */
export function totalBlockerCount(groups: BlockerGroup[]): number {
  return groups.reduce((acc, g) => acc + g.entries.length, 0);
}

function sceneEntry(s: BlockerSceneSignal): BlockerEntry {
  return { id: s.id, label: s.title, sceneId: s.id };
}

function pushGroup(
  out: BlockerGroup[],
  kind: BlockerKind,
  severity: BlockerSeverity,
  entries: BlockerEntry[],
): void {
  if (entries.length > 0) out.push({ kind, severity, entries });
}
