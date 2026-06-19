import { estimateTotalCost } from "@/features/chat/modelPricing";
import type { ProvenanceKind, ResolvedPassage } from "./provenance";
import { buildProvenanceBreakdown } from "./provenance";
import type { AiUsageCostRow } from "./aiUsageAnalytics";
import { loadProjectUsageCostRows } from "./aiUsageAnalytics";

/**
 * 出所分析（provenance analytics）の集計層。
 *
 * 既存の出所/帰属レポートを**再構築しない**。入力は既に出荷済みの
 * `provenance.ts`（buildProvenanceBreakdown / resolveProvenanceFromLookups）が
 * 解決した `ResolvedPassage[]` と、ai_usage 行（aiUsageAnalytics.ts が読む）。
 * ここでは純関数のロールアップだけを行う（DB I/O なし）。
 *
 * 提供する3観点:
 *  1. モデル別寄与 — どのモデルが何文字 / 何 passage を本文に寄与したか
 *  2. 生成種別の分布 — chat / inline-ai / beat / orphan-chat / unknown の割合
 *  3. コスト↔出所のクロスリンク（概算） — ai_usage からモデル別 / 種別別の概算コスト
 *
 * コスト紐付けは ai_usage.traceId に FK が無く疎なため、**surface → 種別**の
 * マッピングによるベストエフォート概算（"~"表記）であり、本文 passage と
 * 1対1には対応しない。詳細は rollupCostByKind の注記を参照。
 */

/** モデル不明（model 列が null）の集計用センチネル。attributionStats と同値。 */
export const UNKNOWN_MODEL = "__unknown_model__";

// ── 1. モデル別寄与 ────────────────────────────────────────────────────────
export interface ModelContributionRow {
  model: string;
  /** このモデルが寄与した本文文字数の合計。 */
  chars: number;
  /** このモデルに帰属する passage 数。 */
  passages: number;
}

function passageModel(passage: ResolvedPassage): string {
  return passage.model || passage.provenance.model || UNKNOWN_MODEL;
}

/**
 * passage 群を model 別に集約する。span の model を優先し、無ければ
 * provenance 解決結果の model、それも無ければセンチネル。
 * chars 降順 → model 昇順で安定ソート。
 */
export function rollupModelContribution(
  passages: ResolvedPassage[],
): ModelContributionRow[] {
  const byModel = new Map<string, ModelContributionRow>();
  for (const passage of passages) {
    const model = passageModel(passage);
    const cur = byModel.get(model);
    if (cur) {
      cur.chars += passage.charCount;
      cur.passages += 1;
    } else {
      byModel.set(model, { model, chars: passage.charCount, passages: 1 });
    }
  }
  return [...byModel.values()].sort(
    (a, b) => b.chars - a.chars || a.model.localeCompare(b.model),
  );
}

// ── 2. 生成種別の分布 ──────────────────────────────────────────────────────
export interface KindBucket {
  chars: number;
  passages: number;
}

export interface KindDistribution {
  chat: KindBucket;
  inlineAi: KindBucket;
  beat: KindBucket;
  orphanChat: KindBucket;
  unknownAi: KindBucket;
  totalChars: number;
  totalPassages: number;
}

function emptyBucket(): KindBucket {
  return { chars: 0, passages: 0 };
}

function addBucket(bucket: KindBucket, chars: number): void {
  bucket.chars += chars;
  bucket.passages += 1;
}

/**
 * passage 群を provenance.kind 別に集約する。`ProvenanceBreakdown`（char のみ）の
 * project 横断版に passage 件数と合計を加えたもの。
 */
export function rollupKindDistribution(
  passages: ResolvedPassage[],
): KindDistribution {
  const dist: KindDistribution = {
    chat: emptyBucket(),
    inlineAi: emptyBucket(),
    beat: emptyBucket(),
    orphanChat: emptyBucket(),
    unknownAi: emptyBucket(),
    totalChars: 0,
    totalPassages: 0,
  };
  for (const passage of passages) {
    const c = passage.charCount;
    switch (passage.provenance.kind) {
      case "chat":
        addBucket(dist.chat, c);
        break;
      case "inline-ai":
        addBucket(dist.inlineAi, c);
        break;
      case "beat":
        addBucket(dist.beat, c);
        break;
      case "orphan-chat":
        addBucket(dist.orphanChat, c);
        break;
      case "unknown":
        addBucket(dist.unknownAi, c);
        break;
    }
    dist.totalChars += c;
    dist.totalPassages += 1;
  }
  return dist;
}

// ── 3. コスト↔出所クロスリンク（概算） ────────────────────────────────────
/**
 * ai_usage.surface を本文 passage の出所種別へ寄せる。コスト概算で使う。
 * 本文に直結しない surface（synopsis / session_title / map_branch 等）は null。
 *
 * NOTE: agent surface は chat バケットに合算する（chat と agent はどちらも
 * 会話駆動の本文寄与で、出所 kind は "chat" に解決されるため）。
 */
export function surfaceToProvenanceKind(
  surface: string,
): Exclude<ProvenanceKind, "orphan-chat" | "unknown"> | null {
  switch (surface) {
    case "chat":
    case "agent":
      return "chat";
    case "inline_ai":
      return "inline-ai";
    case "beat":
      return "beat";
    default:
      return null;
  }
}

export interface ModelCostRow {
  model: string;
  costUsd: number;
  /** ai_usage 行（呼び出し）数。 */
  calls: number;
  /** この合計に推定コスト（プロバイダ cost が無い行）が含まれるか。 */
  estimated: boolean;
}

/** 1 行のコストを解決する。プロバイダ実値優先、無ければトークンから推定。 */
function resolveRowCost(row: AiUsageCostRow): {
  cost: number;
  estimated: boolean;
} {
  if (row.costUsd != null) return { cost: row.costUsd, estimated: false };
  const est = estimateTotalCost(
    row.model,
    row.tokensIn ?? 0,
    row.tokensOut ?? 0,
  );
  if (est != null) return { cost: est, estimated: true };
  return { cost: 0, estimated: false };
}

/**
 * ai_usage 行群をモデル別の概算コストに集約する。cost 降順 → model 昇順。
 */
export function rollupCostByModel(rows: AiUsageCostRow[]): ModelCostRow[] {
  const byModel = new Map<string, ModelCostRow>();
  for (const row of rows) {
    const model = row.model || UNKNOWN_MODEL;
    const { cost, estimated } = resolveRowCost(row);
    const cur = byModel.get(model);
    if (cur) {
      cur.costUsd += cost;
      cur.calls += 1;
      cur.estimated = cur.estimated || estimated;
    } else {
      byModel.set(model, { model, costUsd: cost, calls: 1, estimated });
    }
  }
  return [...byModel.values()].sort(
    (a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model),
  );
}

export interface KindCostBucket {
  costUsd: number;
  calls: number;
  estimated: boolean;
}

export interface CostByKind {
  byKind: {
    chat: KindCostBucket;
    inlineAi: KindCostBucket;
    beat: KindCostBucket;
  };
  /** surface が本文出所種別に対応しない行のコスト合計（synopsis 等）。 */
  otherCostUsd: number;
  /** 全 ai_usage 行のコスト合計（other 含む）。 */
  totalCostUsd: number;
  /** 集計に推定コストが混ざっているか。 */
  anyEstimated: boolean;
}

function emptyCostBucket(): KindCostBucket {
  return { costUsd: 0, calls: 0, estimated: false };
}

/**
 * ai_usage 行を surface→出所種別へ寄せた概算コストに集約する。
 *
 * 限界（ベストエフォート）: ai_usage.traceId は FK 無し・疎なので、行を本文
 * passage に 1対1で紐付けることはできない。代わりに surface を出所種別へ
 * 寄せて種別別の概算コストを出す。種別に対応しない surface（synopsis 等）は
 * otherCostUsd にまとめる。UI/エクスポートでは "~$X" のように概算を明示する。
 */
export function rollupCostByKind(rows: AiUsageCostRow[]): CostByKind {
  const byKind = {
    chat: emptyCostBucket(),
    inlineAi: emptyCostBucket(),
    beat: emptyCostBucket(),
  };
  let otherCostUsd = 0;
  let totalCostUsd = 0;
  let anyEstimated = false;

  for (const row of rows) {
    const { cost, estimated } = resolveRowCost(row);
    totalCostUsd += cost;
    if (estimated) anyEstimated = true;

    const kind = surfaceToProvenanceKind(row.surface);
    if (kind === null) {
      otherCostUsd += cost;
      continue;
    }
    const bucket =
      kind === "chat"
        ? byKind.chat
        : kind === "inline-ai"
          ? byKind.inlineAi
          : byKind.beat;
    bucket.costUsd += cost;
    bucket.calls += 1;
    bucket.estimated = bucket.estimated || estimated;
  }

  return { byKind, otherCostUsd, totalCostUsd, anyEstimated };
}

// ── 合成レポート ───────────────────────────────────────────────────────────
export interface ProvenanceAnalyticsReport {
  modelContribution: ModelContributionRow[];
  kindDistribution: KindDistribution;
  costByModel: ModelCostRow[];
  costByKind: CostByKind;
  /** ai_usage 行が1件でもあったか。false の時 UI/エクスポートはコスト欄を隠す。 */
  hasUsageData: boolean;
}

/**
 * 出所分析レポートを合成する純関数。
 * @param passages buildProvenanceBreakdown / resolveProvenance(FromLookups) の出力
 * @param usageRows loadProjectUsageCostRows の出力（ai_usage 行）
 */
export function buildProvenanceAnalytics(
  passages: ResolvedPassage[],
  usageRows: AiUsageCostRow[],
): ProvenanceAnalyticsReport {
  return {
    modelContribution: rollupModelContribution(passages),
    kindDistribution: rollupKindDistribution(passages),
    costByModel: rollupCostByModel(usageRows),
    costByKind: rollupCostByKind(usageRows),
    hasUsageData: usageRows.length > 0,
  };
}

/**
 * プロジェクトの出所分析レポートを DB から組み立てる（I/O + 純関数の合成）。
 *
 * 既存の `buildProvenanceBreakdown`（出荷済）を `includePassageExcerpts` で呼び、
 * 解決済み `ResolvedPassage[]` を得て純関数 rollup に流す（レポート再構築なし）。
 * ai_usage 行は `loadProjectUsageCostRows` で project スコープ読み出し。
 */
export async function loadProvenanceAnalytics(
  projectId: string,
): Promise<ProvenanceAnalyticsReport> {
  const [report, usageRows] = await Promise.all([
    buildProvenanceBreakdown(projectId, { includePassageExcerpts: true }),
    loadProjectUsageCostRows(projectId),
  ]);
  return buildProvenanceAnalytics(report.passages ?? [], usageRows);
}
