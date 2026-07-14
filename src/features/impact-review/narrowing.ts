/**
 * impact-review stage-a: 変更された Codex に影響を受けうる候補シーンを
 * dense(embeddings) + sparse(FTS 言及) の RRF 融合で 1-2 桁に絞る。
 * 純ロジック部（fusion）と IO 部（orchestration）を分離してテスト可能にする。
 */

import { semanticSearch } from "@/features/semantic-search/api";
import { invoke } from "@/lib/tauri";
import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getCodexSemanticLinkEntryIds } from "@/features/codex/semanticLinks";

interface FtsSceneRow {
  sourceType: string;
  id: string;
  title: string;
  excerpt: string;
}

/** RRF 定数。semanticRecall.ts の RRF_K と揃える。 */
const RRF_K = 60;
const DEFAULT_LIMIT = 30;

export interface SceneCandidate {
  sceneId: string;
  /** 融合 RRF スコア（大きいほど候補上位） */
  score: number;
  /** dense 側で観測した最良 cosine（UI 表示・将来の閾値用、sparse-only は undefined） */
  denseScore?: number;
  matchedBy: Array<"dense" | "sparse" | "semantic">;
}

/** chunk 単位の dense ヒットをシーン単位へ畳み込み、最良スコア降順に並べる。 */
export function denseSceneRanking(
  hits: Array<{ sceneId: string; score: number }>,
): Array<{ sceneId: string; bestScore: number }> {
  const best = new Map<string, number>();
  for (const h of hits) {
    const prev = best.get(h.sceneId);
    if (prev === undefined || h.score > prev) best.set(h.sceneId, h.score);
  }
  return [...best.entries()]
    .map(([sceneId, bestScore]) => ({ sceneId, bestScore }))
    .sort((a, b) => b.bestScore - a.bestScore);
}

function dedupeInOrder(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * dense / sparse のシーン ID ランキング（いずれも best-first・重複可）を RRF 融合する。
 * 閾値は設けず（AI 二段目が判定する）、上位 limit 件を返す。
 */
export function fuseSceneCandidates(
  denseSceneIds: string[],
  sparseSceneIds: string[],
  opts: {
    rrfK?: number;
    limit?: number;
    denseScoreById?: Map<string, number>;
    semanticSceneIds?: string[];
  } = {},
): SceneCandidate[] {
  const k = opts.rrfK ?? RRF_K;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const dense = dedupeInOrder(denseSceneIds);
  const sparse = dedupeInOrder(sparseSceneIds);
  const semantic = dedupeInOrder(opts.semanticSceneIds ?? []);

  const acc = new Map<
    string,
    {
      score: number;
      matchedBy: Set<"dense" | "sparse" | "semantic">;
    }
  >();
  const bump = (
    id: string,
    rank: number,
    arm: "dense" | "sparse" | "semantic",
  ) => {
    const e = acc.get(id) ?? { score: 0, matchedBy: new Set() };
    e.score += 1 / (k + rank);
    e.matchedBy.add(arm);
    acc.set(id, e);
  };
  dense.forEach((id, i) => bump(id, i, "dense"));
  sparse.forEach((id, i) => bump(id, i, "sparse"));
  semantic.forEach((id, i) => bump(id, i, "semantic"));

  const sorted = [...acc.entries()]
    .map(([sceneId, e]) => ({
      sceneId,
      score: e.score,
      denseScore: opts.denseScoreById?.get(sceneId),
      matchedBy: [...e.matchedBy].sort(),
    }))
    .sort((a, b) => {
      const aSemantic = a.matchedBy.includes("semantic");
      const bSemantic = b.matchedBy.includes("semantic");
      if (aSemantic !== bSemantic) return aSemantic ? -1 : 1;
      return b.score - a.score;
    });

  // A span link is an author-confirmed dependency, so it must not disappear
  // behind the heuristic candidate cap. The cap only limits inferred
  // dense/sparse candidates; explicit links may intentionally exceed it.
  const semanticCandidates = sorted.filter((candidate) =>
    candidate.matchedBy.includes("semantic"),
  );
  const inferredCandidates = sorted.filter(
    (candidate) => !candidate.matchedBy.includes("semantic"),
  );
  return [
    ...semanticCandidates,
    ...inferredCandidates.slice(
      0,
      Math.max(0, limit - semanticCandidates.length),
    ),
  ];
}

/**
 * Explicit editor links are confirmed from the project-scoped ProseMirror
 * source of truth. The derived mention cache is intentionally not consulted:
 * its deferred writer may still be pending immediately after a scene save.
 */
async function semanticLinkedSceneIds(
  projectId: string,
  entryId: string,
): Promise<string[]> {
  const rows = await db
    .select({ sceneId: treeNodes.id, content: treeNodes.content })
    .from(treeNodes)
    .where(
      and(eq(treeNodes.projectId, projectId), eq(treeNodes.nodeType, "scene")),
    );
  return rows
    .filter(
      (row) =>
        // Older projection adapters may omit content. They remain project
        // scoped by the query above; current schema always returns a string.
        row.content === undefined ||
        getCodexSemanticLinkEntryIds(row.content).includes(entryId),
    )
    .map((row) => row.sceneId);
}

/**
 * sparse arm: scene 本文 FTS をエントリ名/別名でマッチさせ scene_id を bm25 順で返す。
 * `fts_search` が生クエリを Rust 側 `to_fts_match` で sanitize するので整形しない
 * (二重 quote 化を避ける)。失敗は空配列フォールバック（dense 単独へ退避）。
 */
async function sparseSceneSearch(
  projectId: string,
  terms: string[],
  limit: number,
): Promise<string[]> {
  const query = terms
    .map((t) => t.trim())
    .filter((t) => t !== "")
    .join(" ");
  if (query === "") return [];
  const rows = await invoke<FtsSceneRow[]>("fts_search", {
    projectId,
    query,
    scope: "scenes",
    limit,
  }).catch(() => [] as FtsSceneRow[]);
  return rows.filter((r) => r.sourceType === "scene").map((r) => r.id);
}

export interface NarrowOptions {
  limit?: number;
  /** dense クエリの fetch 数（融合前の母数）。 */
  denseFetch?: number;
}

/**
 * stage-a 本体: 変更テキスト(dense クエリ) と 言及語(sparse) から候補シーンを絞る。
 * @param queryText 変更差分から組み立てた検索テキスト（新値中心）
 * @param mentionTerms エントリ名 + 別名（sparse 言及救済用）
 */
export async function narrowCandidateScenes(
  projectId: string,
  entryId: string,
  queryText: string,
  mentionTerms: string[],
  opts: NarrowOptions = {},
): Promise<SceneCandidate[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const denseFetch = opts.denseFetch ?? Math.max(limit * 2, 40);

  const [denseHits, sparseIds, semanticSceneIds] = await Promise.all([
    queryText.trim() === ""
      ? Promise.resolve([])
      : semanticSearch({ projectId, query: queryText, limit: denseFetch }),
    sparseSceneSearch(projectId, mentionTerms, denseFetch),
    semanticLinkedSceneIds(projectId, entryId),
  ]);

  const denseRanked = denseSceneRanking(
    denseHits.map((h) => ({ sceneId: h.sceneId, score: h.score })),
  );
  const denseScoreById = new Map(
    denseRanked.map((r) => [r.sceneId, r.bestScore]),
  );

  return fuseSceneCandidates(
    denseRanked.map((r) => r.sceneId),
    sparseIds,
    { limit, denseScoreById, semanticSceneIds },
  );
}
