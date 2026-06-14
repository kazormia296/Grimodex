/**
 * セマンティック検索の評価ハーネス（dev 専用）。
 *
 * query -> 期待シーン(タイトル) のクエリ集を **実機の semantic_search**（実際の
 * Rust int8-ONNX 経路）に流し、Recall@1/@3/MRR・閾値跨ぎ・閾値 sweep・miss/junk を
 * 集計する。コマンドパレットのスコアバッジを 1 件ずつ目視するのに比べ、検索品質の
 * 回帰検知や閾値の妥当性判断が一発でできる。
 *
 * 注意: bulk(--scale medium) は意図的に均質なので distractor として効く。
 * 閾値 0.51 の「校正」自体は en-calibration.jsonl + calibrate-embedding-threshold.py で
 * 行うこと（このサンプルは均質前提でベースラインが膨らむため校正には不適）。
 */

import {
  semanticSearch,
  semanticIndexStatus,
  type SemanticSearchHit,
  type SemanticIndexStatus,
} from "./api";
import { recallParamsForLang } from "@/features/chat/semanticRecall";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { EN_EVAL_SET, JA_EVAL_SET } from "./searchEvalSets";

export interface EvalQuery {
  query: string;
  /** これらのシーンタイトルのいずれかにヒットすれば正解 */
  expect: string[];
}

export interface EvalSet {
  language: string;
  label: string;
  relevant: EvalQuery[];
  /** ドメイン外クエリ。閾値を超えてはならない（偽陽性の検出用） */
  junk: string[];
}

export interface SceneHit {
  sceneId: string;
  sceneTitle: string;
  score: number;
}

export interface RelevantResult {
  query: string;
  expect: string[];
  /** 返ってきた全ヒット中の最高スコア（0 = ヒット無し） */
  topScore: number;
  /** scene 単位で重複排除した順位（1始まり）。limit 内に無ければ null */
  rank: number | null;
  /** 期待シーンのスコア（見つからなければ null） */
  expectedScore: number | null;
  /** 表示用：scene 重複排除済みの上位 */
  scenes: SceneHit[];
}

export interface JunkResult {
  query: string;
  topScore: number;
  topScene: string;
}

export interface EvalReport {
  language: string;
  label: string;
  threshold: number;
  modelId?: string;
  embeddingDim?: number;
  limit: number;
  recallAt1: number;
  recallAt3: number;
  mrr: number;
  relevantCount: number;
  /** expectedScore >= threshold の件数（＝正しいシーンが注入される件数） */
  relevantOverThreshold: number;
  junkCount: number;
  /** topScore >= threshold の junk 件数（＝偽陽性） */
  junkOverThreshold: number;
  /** Youden J を最大化する閾値（relevant の取りこぼしと junk の偽陽性の差） */
  bestThreshold: number;
  results: RelevantResult[];
  junk: JunkResult[];
  misses: RelevantResult[];
  junkFalsePositives: JunkResult[];
}

/** score 降順のヒット列を scene 単位に重複排除（各 scene の最良チャンクを残す）。 */
export function dedupeScenes(hits: SemanticSearchHit[]): SceneHit[] {
  const seen = new Set<string>();
  const out: SceneHit[] = [];
  for (const h of hits) {
    if (seen.has(h.sceneId)) continue;
    seen.add(h.sceneId);
    out.push({ sceneId: h.sceneId, sceneTitle: h.sceneTitle, score: h.score });
  }
  return out;
}

/** 期待タイトルのいずれかに最初に一致した scene の順位とスコア。 */
export function rankOfExpected(
  scenes: SceneHit[],
  expect: string[],
): { rank: number | null; score: number | null } {
  const want = new Set(expect);
  for (let i = 0; i < scenes.length; i++) {
    if (want.has(scenes[i].sceneTitle)) {
      return { rank: i + 1, score: scenes[i].score };
    }
  }
  return { rank: null, score: null };
}

export function computeRecallMrr(results: { rank: number | null }[]): {
  recallAt1: number;
  recallAt3: number;
  mrr: number;
} {
  if (results.length === 0) return { recallAt1: 0, recallAt3: 0, mrr: 0 };
  let r1 = 0;
  let r3 = 0;
  let mrrSum = 0;
  for (const r of results) {
    if (r.rank === 1) r1++;
    if (r.rank !== null && r.rank <= 3) r3++;
    if (r.rank !== null) mrrSum += 1 / r.rank;
  }
  const n = results.length;
  return { recallAt1: r1 / n, recallAt3: r3 / n, mrr: mrrSum / n };
}

/**
 * positives（relevant の期待スコア・t 以上にしたい）と negatives（junk の最高スコア・
 * t 未満にしたい）から Youden J = recall - fp を最大化する閾値を求める。
 */
export function thresholdSweep(
  positives: number[],
  negatives: number[],
): { best: number; j: number } {
  const all = [...positives, ...negatives];
  if (all.length === 0) return { best: 0, j: 0 };
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  let best = lo;
  let bestJ = -Infinity;
  for (let t = lo; t <= hi + 1e-9; t += 0.01) {
    const recall = positives.length
      ? positives.filter((p) => p >= t).length / positives.length
      : 0;
    const fp = negatives.length
      ? negatives.filter((n) => n >= t).length / negatives.length
      : 0;
    const j = recall - fp;
    if (j > bestJ) {
      bestJ = j;
      best = t;
    }
  }
  return { best: Math.round(best * 100) / 100, j: bestJ };
}

/** プロジェクト言語に対応する既定の eval set を選ぶ。 */
export function defaultEvalSet(lang: string): EvalSet {
  return lang.startsWith("en") ? EN_EVAL_SET : JA_EVAL_SET;
}

/**
 * 実機 semantic_search に eval set を流して評価レポートを返す。
 * dev 専用（ProjectCategory の「Run search eval」から呼ぶ）。
 */
export async function runSearchEval(
  opts: {
    projectId?: string;
    evalSet?: EvalSet;
    limit?: number;
    descriptionMode?: boolean;
  } = {},
): Promise<EvalReport> {
  const projectId = opts.projectId ?? getCurrentProjectId();
  const lang =
    typeof document !== "undefined" ? document.documentElement.lang : "";
  const evalSet = opts.evalSet ?? defaultEvalSet(lang);
  const limit = opts.limit ?? 20;
  const threshold = recallParamsForLang().minScore;

  let status: SemanticIndexStatus | undefined;
  try {
    status = await semanticIndexStatus(projectId);
  } catch {
    status = undefined;
  }

  const results: RelevantResult[] = [];
  for (const q of evalSet.relevant) {
    const hits = await semanticSearch({
      projectId,
      query: q.query,
      limit,
      descriptionMode: opts.descriptionMode,
    });
    const scenes = dedupeScenes(hits);
    const { rank, score } = rankOfExpected(scenes, q.expect);
    results.push({
      query: q.query,
      expect: q.expect,
      topScore: hits[0]?.score ?? 0,
      rank,
      expectedScore: score,
      scenes: scenes.slice(0, 5),
    });
  }

  const junk: JunkResult[] = [];
  for (const jq of evalSet.junk) {
    const hits = await semanticSearch({ projectId, query: jq, limit });
    junk.push({
      query: jq,
      topScore: hits[0]?.score ?? 0,
      topScene: hits[0]?.sceneTitle ?? "",
    });
  }

  const { recallAt1, recallAt3, mrr } = computeRecallMrr(results);
  const positives = results.map((r) => r.expectedScore ?? 0);
  const negatives = junk.map((j) => j.topScore);
  const sweep = thresholdSweep(positives, negatives);

  return {
    language: evalSet.language,
    label: evalSet.label,
    threshold,
    modelId: status?.currentModelId,
    embeddingDim: status?.currentEmbeddingDim,
    limit,
    recallAt1,
    recallAt3,
    mrr,
    relevantCount: results.length,
    relevantOverThreshold: positives.filter((p) => p >= threshold).length,
    junkCount: junk.length,
    junkOverThreshold: negatives.filter((n) => n >= threshold).length,
    bestThreshold: sweep.best,
    results,
    junk,
    misses: results.filter((r) => r.rank !== 1),
    junkFalsePositives: junk.filter((j) => j.topScore >= threshold),
  };
}

function truncate(s: string, n = 56): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** レポートを人間可読なテキストへ整形（console.log 用）。 */
export function formatEvalReport(r: EvalReport): string {
  const pct = (x: number) => x.toFixed(2);
  const model = r.modelId ? `, ${r.modelId.split("@")[0]}` : "";
  const lines: string[] = [
    `semantic eval — ${r.label} (${r.language}${model})`,
    `query set: ${r.relevantCount} relevant + ${r.junkCount} junk · limit ${r.limit}`,
    `  Recall@1=${pct(r.recallAt1)}  Recall@3=${pct(r.recallAt3)}  MRR=${r.mrr.toFixed(3)}`,
    `  threshold ${r.threshold}: relevant>=t ${r.relevantOverThreshold}/${r.relevantCount} · junk>=t ${r.junkOverThreshold}/${r.junkCount}`,
    `  best threshold (Youden J): ${r.bestThreshold}`,
  ];
  if (r.misses.length) {
    lines.push("MISSES (rank != 1):");
    for (const m of r.misses) {
      const got = m.scenes[0];
      const topStr = got ? `${got.sceneTitle} ${pct(got.score)}` : "—";
      lines.push(
        `  "${truncate(m.query)}" → expect ${m.expect.join(" / ")} (rank ${m.rank ?? "—"}; top: ${topStr})`,
      );
    }
  }
  if (r.junkFalsePositives.length) {
    lines.push("JUNK over threshold:");
    for (const j of r.junkFalsePositives) {
      lines.push(`  "${truncate(j.query)}" → ${j.topScene} ${pct(j.topScore)}`);
    }
  }
  return lines.join("\n");
}
