import { invoke } from "@/lib/tauri";
import type { CodexEntry } from "./api";

interface QueryResult {
  rows: CodexEntry[];
}

/**
 * Search codex entries using FTS5.
 * - 3+ chars: uses trigram MATCH (fastest, index-backed)
 * - 1-2 chars: falls back to LIKE across name/summary/content/tags
 */
export async function searchCodexEntries(query: string): Promise<CodexEntry[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const charCount = [...trimmed].length; // Unicode-aware length

  if (charCount >= 3) {
    const result = await invoke<QueryResult>("db_execute", {
      sql: `SELECT ce.* FROM codex_entries ce
            JOIN codex_entries_fts fts ON ce.id = fts.rowid
            WHERE codex_entries_fts MATCH ?
            ORDER BY fts.rank`,
      params: [trimmed],
      method: "all",
    });
    return result.rows;
  }

  const likeParam = `%${trimmed}%`;
  const result = await invoke<QueryResult>("db_execute", {
    sql: `SELECT * FROM codex_entries
          WHERE name LIKE ? OR summary LIKE ? OR content LIKE ? OR tags LIKE ?`,
    params: [likeParam, likeParam, likeParam, likeParam],
    method: "all",
  });
  return result.rows;
}
