import { RRF_K } from "../rrfK.js";

/**
 * Agent の search_codex ツール用の dense+sparse ハイブリッド融合 (段階3)。
 *
 * 文脈注入 (selectHybridRecallChunks) とは用途が違う点に注意:
 * search_codex は「LLM に候補リストを返す検索ツール」であり、「迷ったら注入しない」
 * precision ゲート (top-1 gate / rescue-floor / 閾値) は**かけない**。dense と sparse の
 * 順位を Reciprocal Rank Fusion (RRF) で素直に融合し、上位 `limit` 件を返すだけ。
 * 関連性の最終判断は LLM 側が行う。
 *
 * - dense rank = cosine 降順の順位 (codexSemanticSearch は既に score 付きで返す)。
 * - sparse rank = FTS5(bm25)/LIKE が返した行順 (配列 index)。
 * - 同一エントリが両 arm に居れば RRF が加算され上位に来る。エントリ表示データは
 *   dense 優先 (name/type/summary が確実)、dense に無ければ sparse の行を使う。
 * - dense が空/失敗のときは呼び出し側が sparse 単独へ退避する (この関数は呼ばれない)。
 *
 * MP-4b PR-8b：`src/features/chat/agent/codexHybridSearch.ts` から共有 core の読み取り層へ移した
 * （そちらは re-export。本体・順序・数式は変えていない）。
 */
/**
 * One dense hit as the fusion reads it: the shape of the Native `codex_semantic_search` wire (serde
 * camelCase). `src/features/semantic-search/api.ts`'s `CodexSearchHit` is the same shape, so the
 * renderer's array is assignable. `score` is a number here: the core's narrowing turns the `null`
 * that a NaN becomes on the wire into 0, which this function already read it as.
 */
export interface CodexDenseHit {
  entryId: string;
  entryName: string;
  entryType: string;
  summary: string;
  score: number;
}

export interface CodexHybridResult {
  id: string;
  name: string;
  type: string;
  summary: string;
}

export function fuseCodexHybrid(
  denseHits: readonly CodexDenseHit[],
  sparseRows: CodexHybridResult[],
  limit: number,
): CodexHybridResult[] {
  // dense: cosine 降順で順位付け (防御的に再ソート)。最初の出現を採用。
  const denseRank = new Map<string, number>();
  const denseScore = new Map<string, number>();
  const denseData = new Map<string, CodexHybridResult>();
  [...denseHits]
    .sort((a, b) => b.score - a.score)
    .forEach((h, i) => {
      if (denseRank.has(h.entryId)) return;
      denseRank.set(h.entryId, i);
      denseScore.set(h.entryId, h.score);
      denseData.set(h.entryId, {
        id: h.entryId,
        name: h.entryName,
        type: h.entryType,
        summary: h.summary ?? "",
      });
    });

  // sparse: 行順をそのまま順位に。
  const sparseRank = new Map<string, number>();
  const sparseData = new Map<string, CodexHybridResult>();
  sparseRows.forEach((r, i) => {
    if (sparseRank.has(r.id)) return;
    sparseRank.set(r.id, i);
    sparseData.set(r.id, r);
  });

  const ids = new Set<string>([...denseRank.keys(), ...sparseRank.keys()]);
  const fused = [...ids].map((id) => {
    const dRank = denseRank.get(id);
    const sRank = sparseRank.get(id);
    const rrf =
      (dRank !== undefined ? 1 / (RRF_K + dRank) : 0) +
      (sRank !== undefined ? 1 / (RRF_K + sRank) : 0);
    return {
      id,
      rrf,
      score: denseScore.get(id) ?? 0,
      data: denseData.get(id) ?? sparseData.get(id)!,
    };
  });

  fused.sort(
    (a, b) => b.rrf - a.rrf || b.score - a.score || a.id.localeCompare(b.id),
  );
  return fused.slice(0, limit).map((f) => f.data);
}
