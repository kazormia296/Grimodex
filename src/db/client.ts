import { drizzle } from "drizzle-orm/sqlite-proxy";
import { invoke } from "@/lib/tauri";
import * as schema from "./schema";

interface QueryResult {
  rows: Record<string, unknown>[];
}

export const db = drizzle<typeof schema>(
  async (sql, params, method) => {
    const result = await invoke<QueryResult>("db_execute", {
      sql,
      params,
      method,
    });
    return { rows: result.rows.map((row) => Object.values(row)) };
  },
  { schema },
);
