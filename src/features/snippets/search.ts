import { invoke } from "@/lib/tauri";
import type { Snippet } from "./api";

interface QueryResult {
  rows: Snippet[];
}

/**
 * Search snippets using FTS5.
 * - 3+ chars: uses trigram MATCH (fastest, index-backed)
 * - 1-2 chars: falls back to LIKE across title/content/tags
 */
export async function searchSnippets(query: string): Promise<Snippet[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const charCount = [...trimmed].length; // Unicode-aware length

  if (charCount >= 3) {
    const result = await invoke<QueryResult>("db_execute", {
      sql: `SELECT s.* FROM snippets s
            JOIN snippets_fts fts ON s.id = fts.rowid
            WHERE snippets_fts MATCH ?
            ORDER BY fts.rank`,
      params: [trimmed],
      method: "all",
    });
    return result.rows;
  }

  const likeParam = `%${trimmed}%`;
  const result = await invoke<QueryResult>("db_execute", {
    sql: `SELECT * FROM snippets
          WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?`,
    params: [likeParam, likeParam, likeParam],
    method: "all",
  });
  return result.rows;
}
