// Use ASM.js build (pure JS, no WASM) to avoid Emscripten WASM loader errors in Vite dev
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — sql.js/dist/sql-asm.js has no dedicated type declarations
import initSqlJs from "sql.js/dist/sql-asm.js";
import type { Database, SqlValue } from "sql.js";

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY,
    chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    synopsis TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const CONTENT_PREFIX = "noveloom:content:";

export interface BrowserMock {
  invoke: <T = unknown>(
    cmd: string,
    args?: Record<string, unknown>,
  ) => Promise<T>;
}

export async function createBrowserMock(): Promise<BrowserMock> {
  const SQL = await initSqlJs();
  const db: Database = new SQL.Database();
  db.run("PRAGMA foreign_keys = ON;");
  db.run(SCHEMA_DDL);

  // Seed default project + chapter so scenes can reference chapter_id=1
  const now = new Date().toISOString();
  db.run(
    "INSERT OR IGNORE INTO projects (id, title, description, created_at, updated_at) VALUES (1, '無題のプロジェクト', '', ?, ?)",
    [now, now],
  );
  db.run(
    "INSERT OR IGNORE INTO chapters (id, project_id, title, sort_order, created_at, updated_at) VALUES (1, 1, '第1章', 0, ?, ?)",
    [now, now],
  );

  const contentStore = new Map<string, string>();

  function handleDbExecute(args: Record<string, unknown>): {
    rows: Record<string, unknown>[];
  } {
    const sql = args.sql as string;
    const params = args.params as SqlValue[];

    const stmt = db.prepare(sql);
    stmt.bind(params);

    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push(row);
    }
    stmt.free();

    return { rows };
  }

  function handleContentWrite(args: Record<string, unknown>): void {
    const sceneId = args.sceneId as string;
    const markdown = args.markdown as string;
    contentStore.set(sceneId, markdown);
    try {
      localStorage.setItem(CONTENT_PREFIX + sceneId, markdown);
    } catch {
      // localStorage may not be available in test env
    }
  }

  function handleContentRead(args: Record<string, unknown>): string {
    const sceneId = args.sceneId as string;
    const cached = contentStore.get(sceneId);
    if (cached !== undefined) return cached;
    try {
      return localStorage.getItem(CONTENT_PREFIX + sceneId) ?? "";
    } catch {
      return "";
    }
  }

  function handleContentDelete(args: Record<string, unknown>): void {
    const sceneId = args.sceneId as string;
    contentStore.delete(sceneId);
    try {
      localStorage.removeItem(CONTENT_PREFIX + sceneId);
    } catch {
      // noop
    }
  }

  async function invoke<T = unknown>(
    cmd: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    switch (cmd) {
      case "db_execute":
        return handleDbExecute(args) as T;
      case "content_write":
        handleContentWrite(args);
        return undefined as T;
      case "content_read":
        return handleContentRead(args) as T;
      case "content_delete":
        handleContentDelete(args);
        return undefined as T;
      default:
        throw new Error(`[browser-mock] Unknown Tauri command: ${cmd}`);
    }
  }

  return { invoke };
}
