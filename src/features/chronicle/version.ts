import { invoke } from "@/lib/tauri";

interface QueryResult {
  rows: Array<{ version: number }>;
}

/** Read the Event aggregate OCC version, scoped to one project. */
export async function getEventVersion(
  projectId: string,
  eventId: string,
): Promise<number | null> {
  const result = await invoke<QueryResult>("db_execute", {
    sql: "SELECT version FROM events WHERE id = ? AND project_id = ?",
    params: [eventId, projectId],
    method: "all",
  });
  return result.rows[0]?.version ?? null;
}
