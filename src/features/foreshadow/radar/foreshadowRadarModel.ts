import { getAncestorFolders } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { DerivedLabel, ForeshadowWithLabel } from "../types";

/**
 * 伏線レーダー（回収状況の俯瞰）の純粋なデータモデル。
 *
 * 読書順 (computeGlobalSceneOrder) 上に、各伏線の「最早 Setup → Payoff」を
 * アークとして配置する。未回収 (payoff 未確定) は末尾フロンティアへダングリング。
 * Setup も Payoff も本文に無いものは floating（未配置）として別枠に出す。
 */

/** タイムライン上に配置できる 1 伏線分のアーク。 */
export interface RadarArc {
  foreshadowId: string;
  title: string;
  intent: string | null;
  label: DerivedLabel;
  /** 最早 Setup の読書順位置 (orphan_payoff 等で setup 不在なら null)。 */
  startIndex: number | null;
  /** 最早 Setup のシーン ID (ジャンプ用)。 */
  startSceneId: string | null;
  /** Payoff の読書順位置 (未回収・回収先削除なら null)。 */
  endIndex: number | null;
  /** Payoff のシーン ID (ジャンプ用)。 */
  endSceneId: string | null;
  /** Payoff マークの本文内位置 (ジャンプ時の選択範囲)。 */
  payoffFromPos: number | null;
  payoffToPos: number | null;
  /** 未回収 (payoff 未確定)＝フロンティアへダングリング。 */
  open: boolean;
  /** 回収確定だが回収先シーンが読書順に存在しない（削除等）。 */
  broken: boolean;
  /** アーク高さ / ソート用のスパン (読書順インデックス差、>=0)。 */
  span: number;
}

/** 本文に Setup も Payoff も無い未配置の伏線。 */
export interface RadarFloating {
  foreshadowId: string;
  title: string;
  label: DerivedLabel;
}

/** x 軸の章バンド（読書順で連続する同一トップレベルフォルダ）。 */
export interface RadarChapterBand {
  key: string;
  /** フォルダ名。ルート直下のシーンは null。 */
  label: string | null;
  startIndex: number;
  /** 終端 (inclusive)。 */
  endIndex: number;
}

/** ヘッダーのサマリー集計（abandoned を除いた回収率）。 */
export interface RadarSummary {
  /** 非 abandoned の総数。 */
  total: number;
  paid: number;
  /** planned + seeded（健全な未回収）。 */
  open: number;
  /** critical_weak + needs_strengthening + orphan_payoff（要注意）。 */
  atRisk: number;
  abandoned: number;
  /** paid / total（total 0 のとき 0）。 */
  recoveryRate: number;
}

export interface ForeshadowRadarModel {
  arcs: RadarArc[];
  floating: RadarFloating[];
  bands: RadarChapterBand[];
  summary: RadarSummary;
  /** フロンティア＝最終シーンの読書順インデックス (シーン無しは 0)。 */
  maxIndex: number;
}

const AT_RISK: ReadonlySet<DerivedLabel> = new Set<DerivedLabel>([
  "critical_weak",
  "needs_strengthening",
  "orphan_payoff",
]);

/** 読書順で連続する同一トップレベルフォルダをまとめて章バンドにする。 */
function buildChapterBands(
  nodes: TreeNodeData[],
  sceneOrder: Map<string, number>,
): RadarChapterBand[] {
  const ordered = [...sceneOrder.entries()].sort((a, b) => a[1] - b[1]);
  const bands: RadarChapterBand[] = [];
  for (const [sceneId, idx] of ordered) {
    const ancestors = getAncestorFolders(nodes, sceneId);
    const top = ancestors.length > 0 ? ancestors[ancestors.length - 1] : null;
    const key = top ? top.id : "__root__";
    const label = top ? top.title : null;
    const last = bands[bands.length - 1];
    if (last && last.key === key) {
      last.endIndex = idx;
    } else {
      bands.push({ key, label, startIndex: idx, endIndex: idx });
    }
  }
  return bands;
}

export function buildForeshadowRadarModel(
  items: ForeshadowWithLabel[],
  setupScenesByForeshadowId: Record<string, string[]>,
  sceneOrder: Map<string, number>,
  nodes: TreeNodeData[],
): ForeshadowRadarModel {
  let maxIndex = 0;
  for (const idx of sceneOrder.values()) {
    if (idx > maxIndex) maxIndex = idx;
  }

  const arcs: RadarArc[] = [];
  const floating: RadarFloating[] = [];

  let paid = 0;
  let openCount = 0;
  let atRisk = 0;
  let abandoned = 0;

  for (const f of items) {
    // サマリー集計（配置可否に関わらずラベルで数える）。
    if (f.label === "abandoned") {
      abandoned++;
      continue; // abandoned はタイムラインに出さない。
    }
    if (f.label === "paid") paid++;
    else if (AT_RISK.has(f.label)) atRisk++;
    else openCount++; // planned, seeded

    // 最早 Setup の読書順位置。
    const setupScenes = setupScenesByForeshadowId[f.id] ?? [];
    let startIndex: number | null = null;
    let startSceneId: string | null = null;
    for (const sid of setupScenes) {
      const idx = sceneOrder.get(sid);
      if (idx === undefined) continue;
      if (startIndex === null || idx < startIndex) {
        startIndex = idx;
        startSceneId = sid;
      }
    }

    // Payoff の読書順位置。
    const payoffIdx = f.payoffSceneId
      ? sceneOrder.get(f.payoffSceneId)
      : undefined;
    const hasPayoffPos = payoffIdx !== undefined;
    const isPaid = f.payoffConfirmed;

    const endIndex = isPaid && hasPayoffPos ? payoffIdx : null;
    const endSceneId = isPaid && hasPayoffPos ? f.payoffSceneId : null;
    // 回収確定だが回収先シーンが読書順に無い（削除された）。
    const broken = isPaid && !hasPayoffPos && f.payoffSceneId !== null;
    const open = !isPaid;

    // Setup も Payoff も置けないものは未配置。
    if (startIndex === null && endIndex === null) {
      floating.push({ foreshadowId: f.id, title: f.title, label: f.label });
      continue;
    }

    let span: number;
    if (startIndex !== null && endIndex !== null) {
      span = Math.abs(endIndex - startIndex);
    } else if (startIndex !== null) {
      span = Math.max(0, maxIndex - startIndex); // 未回収ダングリング
    } else {
      span = 0; // orphan_payoff（payoff マーカーのみ）
    }

    arcs.push({
      foreshadowId: f.id,
      title: f.title,
      intent: f.intent,
      label: f.label,
      startIndex,
      startSceneId,
      endIndex,
      endSceneId,
      payoffFromPos: f.payoffFromPos,
      payoffToPos: f.payoffToPos,
      open,
      broken,
      span,
    });
  }

  // 決定的な描画順：開始位置→終了位置→ID。
  arcs.sort((a, b) => {
    const as = a.startIndex ?? a.endIndex ?? maxIndex + 1;
    const bs = b.startIndex ?? b.endIndex ?? maxIndex + 1;
    if (as !== bs) return as - bs;
    const ae = a.endIndex ?? maxIndex + 1;
    const be = b.endIndex ?? maxIndex + 1;
    if (ae !== be) return ae - be;
    return a.foreshadowId < b.foreshadowId ? -1 : 1;
  });

  floating.sort((a, b) => {
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.foreshadowId < b.foreshadowId ? -1 : 1;
  });

  const total = paid + openCount + atRisk;
  const recoveryRate = total > 0 ? paid / total : 0;

  return {
    arcs,
    floating,
    bands: buildChapterBands(nodes, sceneOrder),
    summary: {
      total,
      paid,
      open: openCount,
      atRisk,
      abandoned,
      recoveryRate,
    },
    maxIndex,
  };
}
