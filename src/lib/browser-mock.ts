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
const GLOBAL_SETTINGS_KEY = "noveloom:global-settings";

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
  const apiKeyStore = new Map<string, string>();
  const AI_SETTINGS_KEY = "noveloom:ai-settings";

  function handleGetAiSettings(): Record<string, unknown> {
    try {
      const raw = localStorage.getItem(AI_SETTINGS_KEY);
      if (raw) return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // noop
    }
    return {
      provider: "openrouter",
      model: "",
      ollamaEndpoint: "http://localhost:11434",
    };
  }

  function handleSaveAiSettings(args: Record<string, unknown>): void {
    const settings = args.settings as Record<string, unknown>;
    try {
      localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // noop
    }
  }

  function handleSaveApiKey(args: Record<string, unknown>): void {
    const provider = args.provider as string;
    const key = args.key as string;
    apiKeyStore.set(provider, key);
  }

  function handleGetApiKey(args: Record<string, unknown>): string | null {
    const provider = args.provider as string;
    return apiKeyStore.get(provider) ?? null;
  }

  function handleDeleteApiKey(args: Record<string, unknown>): void {
    const provider = args.provider as string;
    apiKeyStore.delete(provider);
  }

  function handleListAiModels(): Array<{ id: string; name: string }> {
    return [
      { id: "openrouter/auto", name: "Auto (OpenRouter)" },
      { id: "openai/gpt-4o", name: "GPT-4o" },
      { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ];
  }

  function handleTestAiConnection(): string {
    return "Connection OK (browser mock)";
  }

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

  function handleGetGlobalSettings(): Record<string, unknown> {
    try {
      const raw = localStorage.getItem(GLOBAL_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const recent = parsed.recentWorkspaces as unknown[];
        // If stored settings have workspaces, use them as-is
        if (Array.isArray(recent) && recent.length > 0) {
          return parsed;
        }
      }
    } catch {
      // noop
    }
    // Auto-seed a dev workspace so browser preview skips folder selection
    const devWorkspace = "/dev/workspace";
    const devSettings: Record<string, unknown> = {
      recentWorkspaces: [
        { path: devWorkspace, lastOpened: new Date().toISOString() },
      ],
      lastActiveWorkspace: devWorkspace,
      theme: "system",
      showLauncherOnStartup: false,
    };
    try {
      localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(devSettings));
    } catch {
      // noop
    }
    return devSettings;
  }

  function handleSaveGlobalSettings(args: Record<string, unknown>): void {
    const settings = args.settings as Record<string, unknown>;
    try {
      localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // noop
    }
  }

  function handleValidateWorkspacePath(): boolean {
    // In browser mock, always return true for any path
    return true;
  }

  function handleOpenWorkspace(args: Record<string, unknown>): {
    name: string;
    isExisting: boolean;
  } {
    const path = args.path as string;
    const parts = path.replace(/\\/g, "/").split("/");
    const name = parts[parts.length - 1] || path;

    // Update mock global settings
    const settings = handleGetGlobalSettings();
    const recent = (settings.recentWorkspaces ?? []) as Array<{
      path: string;
      lastOpened: string;
    }>;
    const filtered = recent.filter((w: { path: string }) => w.path !== path);
    filtered.unshift({ path, lastOpened: new Date().toISOString() });
    settings.recentWorkspaces = filtered.slice(0, 10);
    settings.lastActiveWorkspace = path;
    try {
      localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // noop
    }

    return { name, isExisting: false };
  }

  async function invoke<T = unknown>(
    cmd: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    switch (cmd) {
      case "get_global_settings":
        return handleGetGlobalSettings() as T;
      case "save_global_settings":
        handleSaveGlobalSettings(args);
        return undefined as T;
      case "validate_workspace_path":
        return handleValidateWorkspacePath() as T;
      case "open_workspace":
        return handleOpenWorkspace(args) as T;
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
      case "content_rename":
        // In browser mock, rename is a no-op (content keyed by sceneId)
        return undefined as T;
      case "get_ai_settings":
        return handleGetAiSettings() as T;
      case "save_ai_settings":
        handleSaveAiSettings(args);
        return undefined as T;
      case "save_api_key":
        handleSaveApiKey(args);
        return undefined as T;
      case "get_api_key":
        return handleGetApiKey(args) as T;
      case "delete_api_key":
        handleDeleteApiKey(args);
        return undefined as T;
      case "list_ai_models":
        return handleListAiModels() as T;
      case "test_ai_connection":
        return handleTestAiConnection() as T;
      default:
        throw new Error(`[browser-mock] Unknown Tauri command: ${cmd}`);
    }
  }

  return { invoke };
}
