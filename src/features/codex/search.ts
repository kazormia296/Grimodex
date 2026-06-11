import { invoke } from "@/lib/tauri";
import type { CodexEntry } from "./api";

interface QueryResult {
  rows: Record<string, unknown>[];
}

// db_execute の raw 行は DB カラム名 (snake_case) キーで返る。
// drizzle を経由しないため、ここで CodexEntry (camelCase) へ変換する。
function rowToEntry(row: Record<string, unknown>): CodexEntry {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    mapped[camel] = value;
  }
  return mapped as CodexEntry;
}

/**
 * Search codex entries using FTS5.
 * - 3+ chars: uses trigram MATCH (fastest, index-backed)
 * - 1-2 chars: falls back to LIKE across name/summary/tags
 * - projectId を渡すとそのプロジェクトに限定する（FTS インデックスは
 *   全プロジェクト共有のため、UI 系の呼び出しでは必ず渡すこと）
 */
export async function searchCodexEntries(
  query: string,
  projectId?: string,
): Promise<CodexEntry[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const charCount = [...trimmed].length; // Unicode-aware length

  if (charCount >= 3) {
    const scope = projectId ? " AND ce.project_id = ?" : "";
    const result = await invoke<QueryResult>("db_execute", {
      sql: `SELECT ce.* FROM codex_entries ce
            JOIN codex_fts fts ON ce.rowid = fts.rowid
            WHERE codex_fts MATCH ?${scope}
            ORDER BY fts.rank`,
      params: projectId ? [trimmed, projectId] : [trimmed],
      method: "all",
    });
    return result.rows.map(rowToEntry);
  }

  const likeParam = `%${trimmed}%`;
  const scope = projectId ? " AND project_id = ?" : "";
  const result = await invoke<QueryResult>("db_execute", {
    sql: `SELECT * FROM codex_entries
          WHERE (name LIKE ? OR summary LIKE ? OR tags_cache LIKE ?)${scope}`,
    params: projectId
      ? [likeParam, likeParam, likeParam, projectId]
      : [likeParam, likeParam, likeParam],
    method: "all",
  });
  return result.rows.map(rowToEntry);
}
