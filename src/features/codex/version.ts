import { invoke } from "@/lib/tauri";

interface QueryResult {
  rows: Array<{ version: number }>;
}

/** Read optimistic-lock version for a codex entry (column added by migration). */
export async function getCodexEntryVersion(
  projectId: string,
  entryId: string,
): Promise<number> {
  const result = await invoke<QueryResult>("db_execute", {
    sql: "SELECT COALESCE(version, 0) AS version FROM codex_entries WHERE id = ? AND project_id = ?",
    params: [entryId, projectId],
    method: "all",
  });
  return result.rows[0]?.version ?? 0;
}
