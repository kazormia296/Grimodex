import { invoke } from "@/lib/tauri";
import { toFtsMatchQuery } from "@/lib/fts";
import { getCurrentProjectId } from "@/features/project/projectStore";
import type { Snippet } from "./api";

interface QueryResult {
  rows: Snippet[];
}

/**
 * Search snippets using FTS5.
 * - 3+ chars: uses trigram MATCH (fastest, index-backed)
 * - 1-2 chars: falls back to LIKE across title/content/tags
 *
 * snippets_fts はプロジェクト横断のグローバル索引なので、MATCH/LIKE 双方に
 * project_id フィルタを掛けて現在プロジェクトのスニペットだけに限定する
 * (list 系と同じく getCurrentProjectId() でスコープを解決)。
 */
export async function searchSnippets(query: string): Promise<Snippet[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const projectId = getCurrentProjectId();

  // 生クエリを安全な FTS5 MATCH 式へ。3 codepoint 未満のトークンしか無いときは
  // 空になるので LIKE フォールバックへ倒す。
  const matchQuery = toFtsMatchQuery(trimmed);

  if (matchQuery) {
    const result = await invoke<QueryResult>("db_execute", {
      sql: `SELECT s.* FROM snippets s
            JOIN snippets_fts fts ON s.rowid = fts.rowid
            WHERE snippets_fts MATCH ? AND s.project_id = ?
            ORDER BY fts.rank`,
      params: [matchQuery, projectId],
      method: "all",
    });
    return result.rows;
  }

  const likeParam = `%${trimmed}%`;
  const result = await invoke<QueryResult>("db_execute", {
    sql: `SELECT * FROM snippets
          WHERE project_id = ?
            AND (title LIKE ? OR content LIKE ? OR tags_cache LIKE ?)`,
    params: [projectId, likeParam, likeParam, likeParam],
    method: "all",
  });
  return result.rows;
}
