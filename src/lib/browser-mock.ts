// Use ASM.js build (pure JS, no WASM) to avoid Emscripten WASM loader errors in Vite dev
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — sql.js/dist/sql-asm.js has no dedicated type declarations
import initSqlJs from "sql.js/dist/sql-asm.js";
import type { Database, SqlValue } from "sql.js";
import type { AiProvider } from "@/features/chat/types";
import {
  sendChat,
  fetchModels,
  testConnection,
  sendChatWithTools,
} from "@/lib/browser-ai";
import { lintTextBrowser } from "@/lib/browser-lint";
import type {
  AgentMessagePayload,
  AgentToolDefinition,
} from "@/features/chat/agent/agentTypes";

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'Untitled Project',
    genre TEXT,
    pov TEXT,
    tense TEXT,
    language TEXT NOT NULL DEFAULT 'ja',
    style_guide TEXT,
    ai_instructions TEXT,
    phase_resolution_mode TEXT NOT NULL DEFAULT 'reading' CHECK(phase_resolution_mode IN ('reading', 'story', 'auto')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tree_nodes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
    node_type TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'Untitled',
    synopsis TEXT,
    sort_order TEXT NOT NULL DEFAULT 'a0',
    story_time_order TEXT,
    story_time_label TEXT,
    status TEXT DEFAULT 'outline',
    content TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codex_entries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id TEXT,
    type TEXT NOT NULL DEFAULT 'character',
    name TEXT NOT NULL DEFAULT 'Untitled',
    aliases TEXT,
    excluded_aliases TEXT,
    summary TEXT,
    tags TEXT,
    source_chat_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codex_dismissed_relations (
    entry_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    dismissed_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    PRIMARY KEY (entry_id, dismissed_id)
  );
  CREATE TABLE IF NOT EXISTS snippets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'Untitled',
    content TEXT NOT NULL DEFAULT '',
    tags TEXT,
    scene_id TEXT,
    source_chat_message_id TEXT,
    usage_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id TEXT,
    title TEXT NOT NULL DEFAULT 'New session',
    title_manual INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT 'openrouter/anthropic/claude-sonnet-4.6',
    pinned_codex TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    model TEXT,
    tokens_in INTEGER,
    tokens_out INTEGER,
    duration_ms INTEGER,
    metadata TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS authorship_spans (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    from_pos INTEGER NOT NULL,
    to_pos INTEGER NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('human','ai','unknown')),
    model TEXT,
    timestamp TEXT,
    chat_msg_id TEXT
  );
  CREATE TABLE IF NOT EXISTS codex_tags (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT,
    type_filter TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codex_entry_tags (
    entry_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES codex_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (entry_id, tag_id)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codex_types (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    label TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#888888',
    icon TEXT,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    sort_order REAL NOT NULL DEFAULT 0.0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codex_detail_definitions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type_slug TEXT NOT NULL,
    name TEXT NOT NULL,
    field_type TEXT NOT NULL DEFAULT 'text',
    field_config TEXT,
    sort_order REAL NOT NULL DEFAULT 0.0,
    include_in_context INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codex_detail_values (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    definition_id TEXT NOT NULL REFERENCES codex_detail_definitions(id) ON DELETE CASCADE,
    value TEXT
  );
`;

const GLOBAL_SETTINGS_KEY = "grimodex:global-settings";

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

  // Seed default project + chapter so tree_nodes can reference parent
  const now = new Date().toISOString();
  db.run(
    "INSERT OR IGNORE INTO projects (id, title, language, created_at, updated_at) VALUES ('default-project', '無題のプロジェクト', 'ja', ?, ?)",
    [now, now],
  );
  db.run(
    "INSERT OR IGNORE INTO tree_nodes (id, project_id, node_type, title, sort_order, created_at, updated_at) VALUES ('default-chapter', 'default-project', 'folder', 'Part.1', 'a0', ?, ?)",
    [now, now],
  );

  const AI_SETTINGS_KEY = "grimodex:ai-settings";
  const API_KEY_PREFIX = "grimodex:api-key:";

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
      thinkingEnabled: true,
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
    try {
      localStorage.setItem(API_KEY_PREFIX + provider, key);
    } catch {
      // noop
    }
  }

  function handleGetApiKey(args: Record<string, unknown>): string | null {
    const provider = args.provider as string;
    try {
      return localStorage.getItem(API_KEY_PREFIX + provider) ?? null;
    } catch {
      return null;
    }
  }

  function handleDeleteApiKey(args: Record<string, unknown>): void {
    const provider = args.provider as string;
    try {
      localStorage.removeItem(API_KEY_PREFIX + provider);
    } catch {
      // noop
    }
  }

  async function handleListAiModels(
    args: Record<string, unknown>,
  ): Promise<Array<{ id: string; name: string }>> {
    const settings = handleGetAiSettings();
    const provider = (args.provider ?? settings.provider) as AiProvider;
    const apiKey = handleGetApiKey({ provider })?.toString() ?? "";

    try {
      return await fetchModels(provider, apiKey);
    } catch {
      // Fallback to static list if fetch fails
      return [
        { id: "openrouter/auto", name: "Auto (OpenRouter)" },
        { id: "openai/gpt-4o", name: "GPT-4o" },
        { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ];
    }
  }

  async function handleTestAiConnection(
    args: Record<string, unknown>,
  ): Promise<string> {
    const provider = args.provider as AiProvider;
    const model = args.model as string;
    const apiKey = handleGetApiKey({ provider })?.toString() ?? "";

    if (!apiKey && provider !== "ollama") {
      throw new Error(`APIキーが設定されていません: ${provider}`);
    }

    return testConnection(provider, model, apiKey);
  }

  async function handleSendChatMessage(
    args: Record<string, unknown>,
  ): Promise<string> {
    const settings = handleGetAiSettings();
    const provider = settings.provider as AiProvider;
    const model = settings.model as string;
    const apiKey = handleGetApiKey({ provider })?.toString() ?? "";

    if (!apiKey && provider !== "ollama") {
      return "[browser-mock] AIは未接続です。AI設定からAPIキーを設定してください。";
    }

    const messages = args.messages as Array<{ role: string; content: string }>;
    return sendChat(provider, model, apiKey, messages);
  }

  async function handleSendAgentMessage(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const settings = handleGetAiSettings();
    const provider = settings.provider as AiProvider;
    const model = settings.model as string;
    const apiKey = handleGetApiKey({ provider })?.toString() ?? "";

    if (!apiKey && provider !== "ollama") {
      return {
        blocks: [
          {
            type: "text",
            content:
              "[browser-mock] AIは未接続です。AI設定からAPIキーを設定してください。",
          },
        ],
        stopReason: "end_turn",
      };
    }

    const messages = args.messages as AgentMessagePayload[];
    const tools = args.tools as AgentToolDefinition[];
    return sendChatWithTools(provider, model, apiKey, messages, tools);
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
        return (await handleListAiModels(args)) as T;
      case "test_ai_connection":
        return (await handleTestAiConnection(args)) as T;
      case "send_chat_message":
        return (await handleSendChatMessage(args)) as T;
      case "send_agent_message":
        return (await handleSendAgentMessage(args)) as T;
      case "lint_text":
        return lintTextBrowser(
          args as unknown as Parameters<typeof lintTextBrowser>[0],
        ) as T;
      default:
        throw new Error(`[browser-mock] Unknown Tauri command: ${cmd}`);
    }
  }

  return { invoke };
}
