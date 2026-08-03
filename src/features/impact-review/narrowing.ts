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
import {
  DEFAULT_IMPACT_INFERRED_LIMIT,
  denseSceneRanking,
  fuseSceneCandidates,
  type SceneCandidate,
} from "./narrowingCore";

export {
  denseSceneRanking,
  fuseSceneCandidates,
  type SceneCandidate,
} from "./narrowingCore";

interface FtsSceneRow {
  sourceType: string;
  id: string;
  title: string;
  excerpt: string;
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
  const limit = opts.limit ?? DEFAULT_IMPACT_INFERRED_LIMIT;
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
