import type { loadAuthorshipSpans } from "@/features/attribution/api";
import type { loadForeshadowAnchors } from "@/features/foreshadow/saveAnchors";
import type { listAnnotationsForScene } from "@/features/post-effect/api";

/**
 * シーンロード時の帰属/伏線/疑似コメントの 3 並列リード結果を解決する純関数。
 *
 * 3 件は互いにデータ依存が無い独立リードで `Promise.allSettled` で待つ。
 * allSettled の意図は「1 件の失敗が他のマーク適用を巻き込まない」部分適用維持。
 * ここでは fulfilled なら value、rejected なら欠落値(spans/foreshadow は `[]`、
 * annotations は `null`)へ畳み込み、rejected は呼び出し側でログするための
 * `{ label, reason }` 配列に集約する。dispatch / clamp / store 書き込みは
 * 呼び出し側 (EditorPane) に残す — ここは結果解決と error 収集のみ。
 */

type SpansValue = Awaited<ReturnType<typeof loadAuthorshipSpans>>;
type ForeshadowValue = Awaited<ReturnType<typeof loadForeshadowAnchors>>;
type AnnotationsValue = Awaited<ReturnType<typeof listAnnotationsForScene>>;

export type AnchorLoadErrorLabel =
  | "authorshipSpans"
  | "foreshadowAnchors"
  | "annotations";

export interface AnchorLoadError {
  label: AnchorLoadErrorLabel;
  reason: unknown;
}

export interface ResolvedAnchorLoads {
  spans: SpansValue;
  foreshadowMarks: ForeshadowValue;
  annotations: AnnotationsValue | null;
  errors: AnchorLoadError[];
}

/**
 * マーク range を現在の doc サイズへクランプする純関数。
 *
 * シーンロード時に永続化された anchor の from/to は、本文が縮んだ後だと doc 末尾を
 * 超えうる(stale 適用)。`Math.min(_, docSize)` で両端を丸め、丸めた結果が空/反転
 * (`from >= to`) なら `null` を返して呼び出し側が `addMark` を skip できるようにする。
 * 帰属マークと伏線マークの両ブランチで同一ロジックを共有する。
 */
export function clampMarkRange(
  from: number,
  to: number,
  docSize: number,
): { from: number; to: number } | null {
  const clampedFrom = Math.min(from, docSize);
  const clampedTo = Math.min(to, docSize);
  return clampedFrom < clampedTo ? { from: clampedFrom, to: clampedTo } : null;
}

export function resolveAnchorLoads(
  spansR: PromiseSettledResult<SpansValue>,
  foreshadowR: PromiseSettledResult<ForeshadowValue>,
  annotationR: PromiseSettledResult<AnnotationsValue>,
): ResolvedAnchorLoads {
  const errors: AnchorLoadError[] = [];

  const spans: SpansValue = spansR.status === "fulfilled" ? spansR.value : [];
  if (spansR.status === "rejected") {
    errors.push({ label: "authorshipSpans", reason: spansR.reason });
  }

  const foreshadowMarks: ForeshadowValue =
    foreshadowR.status === "fulfilled" ? foreshadowR.value : [];
  if (foreshadowR.status === "rejected") {
    errors.push({ label: "foreshadowAnchors", reason: foreshadowR.reason });
  }

  const annotations: AnnotationsValue | null =
    annotationR.status === "fulfilled" ? annotationR.value : null;
  if (annotationR.status === "rejected") {
    errors.push({ label: "annotations", reason: annotationR.reason });
  }

  return { spans, foreshadowMarks, annotations, errors };
}
