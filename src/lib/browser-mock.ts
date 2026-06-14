// Use ASM.js build (pure JS, no WASM) to avoid Emscripten WASM loader errors in Vite dev
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — sql.js/dist/sql-asm.js has no dedicated type declarations
import initSqlJs from "sql.js/dist/sql-asm.js";
import type { Database, SqlValue } from "sql.js";
import type { AiProvider, ToolProtocolMode } from "@/features/chat/types";
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
import {
  getScreenshotLanguage,
  isScreenshotStagingActive,
} from "@/screenshot-scenes/screenshotMode";
import { SCREENSHOT_SEED_CONTENT } from "@/screenshot-scenes/screenshotSeedContent";
import {
  bytesToHex,
  computeEventHash,
  GENESIS_HASH,
  hexToBytes,
} from "@/features/timelapse/hashChain";

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
    outline TEXT,
    target_readers TEXT,
    phase_resolution_mode TEXT NOT NULL DEFAULT 'reading' CHECK(phase_resolution_mode IN ('reading', 'story', 'auto')),
    ai_policy TEXT NOT NULL DEFAULT '{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true,"structureWrite":true}}',
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
    intent TEXT,
    sort_order TEXT NOT NULL DEFAULT 'a0',
    story_time_order TEXT,
    story_time_label TEXT,
    pov_character_id TEXT,
    location_id TEXT,
    status TEXT DEFAULT 'outline',
    content TEXT NOT NULL DEFAULT '{}',
    unplaced_beats_doc TEXT NOT NULL DEFAULT '[]',
    char_count INTEGER NOT NULL DEFAULT 0,
    unplaced_beat_preview TEXT,
    placed_beat_preview TEXT,
    source_uri TEXT,
    source_mtime TEXT,
    archived_at TEXT,
    context_mode TEXT,
    aliases TEXT NOT NULL DEFAULT '[]',
    excluded_aliases TEXT NOT NULL DEFAULT '[]',
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
    content TEXT NOT NULL DEFAULT '{}',
    icon TEXT,
    tags_cache TEXT,
    context_mode TEXT NOT NULL DEFAULT 'mentioned',
    children_budget TEXT NOT NULL DEFAULT 'compact',
    tags TEXT,
    source_chat_message_id TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codex_dismissed_relations (
    entry_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    dismissed_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    PRIMARY KEY (entry_id, dismissed_id)
  );
  CREATE TABLE IF NOT EXISTS codex_relations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_codex_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    to_codex_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL DEFAULT 'custom',
    label TEXT,
    depth_hint INTEGER,
    source_map_edge_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS snippets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'Untitled',
    content TEXT NOT NULL DEFAULT '',
    tags_cache TEXT,
    content_source TEXT,
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
    codex_anchor_id TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT 'New session',
    title_manual INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT 'openrouter/anthropic/claude-sonnet-4.6',
    pinned_codex TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_sessions_node
    ON chat_sessions(project_id, node_id);
  CREATE INDEX IF NOT EXISTS idx_chat_sessions_codex_anchor
    ON chat_sessions(project_id, codex_anchor_id);
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
    is_starred INTEGER NOT NULL DEFAULT 0,
    is_summarized INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS generation_logs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scene_node_id TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('inline-ai','beat')),
    command_id TEXT,
    instruction TEXT,
    prompt_full TEXT,
    model TEXT,
    trace_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_session_pinned_codex (
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    codex_entry_id TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
    snippet_id TEXT REFERENCES snippets(id) ON DELETE CASCADE,
    with_children INTEGER NOT NULL DEFAULT 0,
    pin_source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, codex_entry_id, snippet_id)
  );
  CREATE TABLE IF NOT EXISTS chat_summaries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    token_count INTEGER,
    generation INTEGER NOT NULL DEFAULT 1,
    source_msg_count INTEGER NOT NULL DEFAULT 0,
    last_msg_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_summary_messages (
    summary_id TEXT NOT NULL REFERENCES chat_summaries(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    PRIMARY KEY (summary_id, message_id)
  );
  CREATE TABLE IF NOT EXISTS authorship_spans (
    id TEXT PRIMARY KEY,
    node_id TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
    codex_entry_id TEXT,
    snippet_id TEXT,
    detail_value_id TEXT,
    from_pos INTEGER NOT NULL,
    to_pos INTEGER NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('human','ai','unknown')),
    model TEXT,
    timestamp TEXT,
    chat_msg_id TEXT,
    trace_id TEXT,
    phase_id TEXT,
    sticky_id TEXT
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
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_settings (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (project_id, key)
  );
  CREATE TABLE IF NOT EXISTS change_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_uid TEXT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scene_id TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
    domain TEXT NOT NULL,
    op_type TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    payload TEXT NOT NULL,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_change_events_project_ts
    ON change_events(project_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_change_events_scene_ts
    ON change_events(scene_id, timestamp);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_change_events_project_seq
    ON change_events(project_id, sequence);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_change_events_project_uid
    ON change_events(project_id, event_uid);
  CREATE TABLE IF NOT EXISTS codex_types (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    label TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#888888',
    palette_index INTEGER,
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
  CREATE TABLE IF NOT EXISTS labels (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    sort_order REAL NOT NULL DEFAULT 0.0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tree_node_labels (
    node_id TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (node_id, label_id)
  );
  CREATE TABLE IF NOT EXISTS map_boards (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'Main',
    sort_order REAL NOT NULL DEFAULT 0.0,
    mode TEXT NOT NULL DEFAULT 'free',
    viewport_x REAL NOT NULL DEFAULT 0,
    viewport_y REAL NOT NULL DEFAULT 0,
    viewport_zoom REAL NOT NULL DEFAULT 1.0,
    show_config TEXT NOT NULL DEFAULT '{}',
    color_by TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS map_ai_branches (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    seed_node_ids TEXT NOT NULL DEFAULT '[]',
    session_id TEXT,
    model TEXT,
    token_usage INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS map_stickies (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
    title TEXT,
    body TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}',
    preview_text TEXT,
    palette_id TEXT NOT NULL DEFAULT 'post-it-playful',
    color_slot INTEGER NOT NULL DEFAULT 0,
    ai_branch_id TEXT,
    source_chat_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS map_node_positions (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
    node_ref_type TEXT NOT NULL,
    tree_node_id TEXT,
    codex_entry_id TEXT,
    snippet_id TEXT,
    sticky_id TEXT,
    ai_branch_id TEXT,
    x REAL NOT NULL,
    y REAL NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    z_index INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS map_edges (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
    from_position_id TEXT NOT NULL,
    to_position_id TEXT NOT NULL,
    forward_label TEXT,
    backward_label TEXT,
    labels TEXT NOT NULL DEFAULT '[]',
    style TEXT NOT NULL DEFAULT 'solid',
    color TEXT NOT NULL DEFAULT '#000000',
    direction TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS map_frames (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'Frame',
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL,
    height REAL NOT NULL,
    background TEXT NOT NULL DEFAULT '#f5f5f5',
    border_color TEXT NOT NULL DEFAULT '#cccccc',
    z_index INTEGER NOT NULL DEFAULT -1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS foreshadows (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    intent TEXT,
    notes TEXT,
    payoff_scene_id TEXT,
    payoff_from_pos INTEGER,
    payoff_to_pos INTEGER,
    payoff_confirmed INTEGER NOT NULL DEFAULT 0,
    abandoned INTEGER NOT NULL DEFAULT 0,
    secret INTEGER NOT NULL DEFAULT 1,
    load_bearing TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS foreshadow_setups (
    id TEXT PRIMARY KEY,
    foreshadow_id TEXT NOT NULL REFERENCES foreshadows(id) ON DELETE CASCADE,
    scene_id TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    from_pos INTEGER NOT NULL,
    to_pos INTEGER NOT NULL,
    kind TEXT NOT NULL,
    strength TEXT,
    ai_strength TEXT,
    ai_reasoning TEXT,
    attribution TEXT NOT NULL DEFAULT 'human',
    ai_rationale TEXT,
    last_evaluated_at INTEGER,
    is_orphan INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codex_quick_pins (
    entry_id TEXT PRIMARY KEY REFERENCES codex_entries(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lint_term_dictionary (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    preferred TEXT NOT NULL,
    variants TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    note TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scene_codex_mentions (
    scene_id TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    codex_entry_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'mentioned',
    PRIMARY KEY (scene_id, codex_entry_id, source)
  );
  CREATE TABLE IF NOT EXISTS scene_beat_pov_cache (
    scene_id TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    pov_character_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
    PRIMARY KEY (scene_id, pov_character_id)
  );
  CREATE TABLE IF NOT EXISTS content_versions (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('scene','note','codex_entry','snippet')),
    entity_id TEXT NOT NULL,
    content TEXT NOT NULL,
    version_number INTEGER NOT NULL,
    snapshot_type TEXT NOT NULL DEFAULT 'auto' CHECK(snapshot_type IN ('auto','manual')),
    created_at TEXT NOT NULL,
    UNIQUE(entity_type, entity_id, version_number)
  );
  CREATE TABLE IF NOT EXISTS project_snapshots (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(project_id, name)
  );
  CREATE TABLE IF NOT EXISTS project_snapshot_entries (
    snapshot_id TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
    version_id TEXT NOT NULL REFERENCES content_versions(id) ON DELETE RESTRICT,
    PRIMARY KEY (snapshot_id, version_id)
  );
  CREATE TABLE IF NOT EXISTS project_snapshot_tree_nodes (
    snapshot_id        TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
    node_id            TEXT NOT NULL,
    parent_id          TEXT,
    node_type          TEXT NOT NULL,
    title              TEXT NOT NULL,
    synopsis           TEXT,
    intent             TEXT,
    sort_order         TEXT NOT NULL,
    story_time_order   TEXT,
    story_time_label   TEXT,
    pov_character_id   TEXT,
    location_id        TEXT,
    status             TEXT,
    body_version_id    TEXT REFERENCES content_versions(id) ON DELETE RESTRICT,
    unplaced_beats_doc TEXT NOT NULL DEFAULT '[]',
    char_count         INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (snapshot_id, node_id)
  );
  CREATE TABLE IF NOT EXISTS project_snapshot_codex_entries (
    snapshot_id      TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
    entry_id         TEXT NOT NULL,
    type             TEXT NOT NULL,
    name             TEXT NOT NULL,
    parent_id        TEXT,
    aliases          TEXT,
    excluded_aliases TEXT,
    summary          TEXT,
    icon             TEXT,
    context_mode     TEXT NOT NULL,
    children_budget  TEXT NOT NULL,
    notes            TEXT,
    body_version_id  TEXT REFERENCES content_versions(id) ON DELETE RESTRICT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (snapshot_id, entry_id)
  );
  CREATE TABLE IF NOT EXISTS project_snapshot_snippets (
    snapshot_id            TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
    snippet_id             TEXT NOT NULL,
    title                  TEXT NOT NULL,
    scene_id               TEXT,
    source_chat_message_id TEXT,
    body_version_id        TEXT REFERENCES content_versions(id) ON DELETE RESTRICT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (snapshot_id, snippet_id)
  );
  CREATE TABLE IF NOT EXISTS project_snapshot_aux (
    snapshot_id  TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
    scope        TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, scope)
  );
`;

const GLOBAL_SETTINGS_KEY = "grimodex:global-settings";

export interface BrowserMock {
  invoke: <T = unknown>(
    cmd: string,
    args?: Record<string, unknown>,
  ) => Promise<T>;
}

interface TimelapseAppendEvent {
  eventUid: string;
  sceneId: string | null;
  domain: string;
  opType: string;
  entityType: string | null;
  entityId: string | null;
  payload: string;
  timestamp: number;
}

export async function createBrowserMock(): Promise<BrowserMock> {
  const SQL = await initSqlJs();
  const db: Database = new SQL.Database();
  db.run("PRAGMA foreign_keys = ON;");
  db.run(SCHEMA_DDL);

  // Seed default project only — folder/scenes are no longer auto-created
  // so a fresh workspace stays empty (mirrors src-tauri/src/database.rs).
  const now = new Date().toISOString();
  db.run(
    "INSERT OR IGNORE INTO projects (id, title, language, created_at, updated_at) VALUES ('default-project', 'Untitled Project', 'ja', ?, ?)",
    [now, now],
  );

  seedBuiltinCodexTypes(db, now);
  if (isScreenshotStagingActive()) {
    seedScreenshotWorkspace(db, now);
  }

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
      // 撮影ステージでは seedScreenshotWorkspace の chat-scene-1.model と
      // 揃え、チャットパネルが「モデル未設定」表示にならないようにする。
      model: isScreenshotStagingActive()
        ? "openrouter/anthropic/claude-sonnet-4.6"
        : "",
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
    const toolProtocolMode =
      (settings.toolProtocolMode as ToolProtocolMode | undefined) ?? "auto";
    return sendChatWithTools(
      provider,
      model,
      apiKey,
      messages,
      tools,
      toolProtocolMode,
    );
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

  function handleDbExecuteBatch(args: Record<string, unknown>): {
    rows: Record<string, unknown>[];
  } {
    const statements = args.statements as {
      sql: string;
      params: SqlValue[];
      method: string;
    }[];
    db.run("BEGIN");
    let last: Record<string, unknown>[] = [];
    try {
      for (const s of statements) {
        last = handleDbExecute({
          sql: s.sql,
          params: s.params,
          method: s.method,
        }).rows;
      }
      db.run("COMMIT");
    } catch (e) {
      try {
        db.run("ROLLBACK");
      } catch {
        /* noop */
      }
      throw e;
    }
    return { rows: last };
  }

  function queryOne(
    sql: string,
    params: SqlValue[],
  ): Record<string, SqlValue> | null {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  }

  function readTimelapseTail(projectId: string): {
    sequence: number;
    hash: string;
  } {
    const row = queryOne(
      "select sequence, hash from change_events where project_id = ? order by sequence desc limit 1",
      [projectId],
    );
    if (!row) {
      return { sequence: 0, hash: bytesToHex(GENESIS_HASH) };
    }
    return {
      sequence: Number(row.sequence),
      hash: String(row.hash),
    };
  }

  function eventUidExists(projectId: string, eventUid: string): boolean {
    return Boolean(
      queryOne(
        "select 1 as found from change_events where project_id = ? and event_uid = ? limit 1",
        [projectId, eventUid],
      ),
    );
  }

  function liveSceneId(sceneId: string | null): string | null {
    if (!sceneId) return null;
    const row = queryOne(
      "select 1 as found from tree_nodes where id = ? limit 1",
      [sceneId],
    );
    return row ? sceneId : null;
  }

  async function handleTimelapseAppendBatch(
    args: Record<string, unknown>,
  ): Promise<{
    insertedCount: number;
    tailSequence: number;
    tailHash: string;
  }> {
    const projectId = args.projectId as string;
    const sessionId = args.sessionId as string;
    const events = (args.events ?? []) as TimelapseAppendEvent[];

    db.run("BEGIN IMMEDIATE");
    try {
      // Per-event idempotency (mirror of the Rust allocator): a committed-but-
      // rejected flush can be re-sent merged with new events; skip the
      // already-present uids and append only the genuinely-new suffix so the
      // merged-in events are never dropped.
      const firstUid = events[0]?.eventUid;
      const firstPresent = firstUid
        ? eventUidExists(projectId, firstUid)
        : false;

      let { sequence, hash: prevHash } = readTimelapseTail(projectId);
      let insertedCount = 0;
      for (const ev of events) {
        if (firstPresent && eventUidExists(projectId, ev.eventUid)) continue;
        sequence += 1;
        const sceneId = liveSceneId(ev.sceneId);
        const hash = bytesToHex(
          await computeEventHash({
            projectId,
            sceneId,
            domain: ev.domain,
            opType: ev.opType,
            entityType: ev.entityType,
            entityId: ev.entityId,
            payload: ev.payload,
            sessionId,
            sequence,
            timestamp: ev.timestamp,
            prevHash: hexToBytes(prevHash),
          }),
        );
        db.run(
          "insert into change_events (event_uid, project_id, scene_id, domain, op_type, entity_type, entity_id, payload, session_id, sequence, timestamp, prev_hash, hash) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            ev.eventUid,
            projectId,
            sceneId,
            ev.domain,
            ev.opType,
            ev.entityType,
            ev.entityId,
            ev.payload,
            sessionId,
            sequence,
            ev.timestamp,
            prevHash,
            hash,
          ],
        );
        prevHash = hash;
        insertedCount += 1;
      }
      db.run("COMMIT");
      return {
        insertedCount,
        tailSequence: sequence,
        tailHash: prevHash,
      };
    } catch (e) {
      try {
        db.run("ROLLBACK");
      } catch {
        /* noop */
      }
      throw e;
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

  function handleGetMcpConfig(): { command: string; workspace: string } {
    const settings = handleGetGlobalSettings();
    const workspace = settings.lastActiveWorkspace as string | null;
    if (!workspace) {
      throw new Error("No workspace is open");
    }
    // Dev/browser preview has no real binary path; "grimodex" stands in for
    // the installed app executable the native command would resolve.
    return { command: "grimodex", workspace };
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
      case "get_mcp_config":
        return handleGetMcpConfig() as T;
      case "set_window_vibrancy":
        return undefined as T;
      case "db_execute":
        return handleDbExecute(args) as T;
      case "db_execute_batch":
        return handleDbExecuteBatch(args) as T;
      case "timelapse_append_batch":
        return (await handleTimelapseAppendBatch(args)) as T;
      case "get_ai_settings":
        return handleGetAiSettings() as T;
      case "save_ai_settings":
        handleSaveAiSettings(args);
        return undefined as T;
      case "save_api_key":
        handleSaveApiKey(args);
        return undefined as T;
      case "has_api_key":
        // 本物の IPC と同様、キー本体は renderer に渡さず有無のみ返す。
        // (mock 内部の AI 呼び出しは handleGetApiKey で localStorage を直接読む)
        return (handleGetApiKey(args) !== null) as T;
      case "delete_api_key":
        handleDeleteApiKey(args);
        return undefined as T;
      case "list_ai_models":
        return (await handleListAiModels(args)) as T;
      case "test_ai_connection":
        return (await handleTestAiConnection(args)) as T;
      case "send_chat_message":
        return (await handleSendChatMessage(args)) as T;
      case "send_inline_ai_stream":
        // ブラウザモックではストリーミング未対応（Tauri イベントエミッタがないため）。
        // 設計書に合わせ、呼び出しをエラー扱いせずに no-op で完了させ、
        // Rust 側と同様に送信イベントは発火しない状態とする。
        return undefined as T;
      case "abort_inline_ai_stream":
        return undefined as T;
      case "list_post_effect_runs":
        return [] as T;
      case "get_post_effect_run":
        return {
          run: null,
          annotations: getScreenshotAnnotations(now),
          relations: [],
        } as T;
      case "list_annotations_for_scene":
        return {
          annotations: getScreenshotAnnotations(now).filter(
            (annotation) =>
              annotation.sceneId === (args.sceneId ?? args.scene_id),
          ),
          relations: [],
        } as T;
      case "list_annotations_for_project":
        return { annotations: getScreenshotAnnotations(now) } as T;
      case "update_annotation_status":
        return {
          ...getScreenshotAnnotations(now)[0],
          status: args.status ?? "open",
        } as T;
      case "save_post_effect_annotations":
        return undefined as T;
      case "abort_post_effect_run":
        return undefined as T;
      case "trash_bin_list":
        return getScreenshotTrashItems(now) as T;
      case "trash_bin_create":
        return getScreenshotTrashItems(now)[0] as T;
      case "trash_bin_delete":
      case "trash_bin_clear_all":
        return undefined as T;
      case "trash_bin_prune":
        return 0 as T;
      case "send_agent_message":
        return (await handleSendAgentMessage(args)) as T;
      case "lint_text":
        return lintTextBrowser(
          args as unknown as Parameters<typeof lintTextBrowser>[0],
        ) as T;
      case "external_mount_register":
        return { dirs: [], files: [] } as T;
      case "external_mount_unregister":
      case "external_mount_write_file":
        return undefined as T;
      case "external_mount_read_file":
        return "" as T;
      case "external_mount_list":
        return [] as T;
      case "external_mount_scan":
        return { dirs: [], files: [] } as T;
      default:
        throw new Error(`[browser-mock] Unknown Tauri command: ${cmd}`);
    }
  }

  return { invoke };
}

function proseDoc(lines: string[]): string {
  return JSON.stringify({
    type: "doc",
    content: lines.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  });
}

function getScreenshotAnnotations(now: string) {
  if (!isScreenshotStagingActive()) return [];
  const { compassDry, foreignMemory } =
    SCREENSHOT_SEED_CONTENT[getScreenshotLanguage()].annotations;
  return [
    {
      id: "ann-akahimo-wet",
      projectId: "default-project",
      runId: "run-screenshot-kouetsu",
      anchorType: "scene_range",
      sceneId: "scene-1",
      rangeStart: compassDry.rangeStart,
      rangeEnd: compassDry.rangeEnd,
      textSnapshot: compassDry.textSnapshot,
      category: "consistency_anchor",
      persona: compassDry.persona,
      severity: "error",
      content: compassDry.content,
      authorRole: "ai",
      parentId: null,
      status: "open",
      metadata: JSON.stringify({
        codex_ref: {
          entry_id: "codex-akahimo",
          entry_name: compassDry.entryName,
          source_field: "content",
          expected_value: compassDry.expectedValue,
          found_value: compassDry.foundValue,
          found_text: compassDry.foundText,
          found_context: compassDry.foundContext,
          confidence: "high",
          llm_reason: compassDry.llmReason,
          dismiss_key: compassDry.dismissKey,
          detected_by_model: "openrouter/anthropic/claude-sonnet-4.6",
        },
      }),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "ann-akane-memory",
      projectId: "default-project",
      runId: "run-screenshot-kouetsu",
      anchorType: "scene_range",
      sceneId: "scene-1",
      rangeStart: foreignMemory.rangeStart,
      rangeEnd: foreignMemory.rangeEnd,
      textSnapshot: foreignMemory.textSnapshot,
      category: "consistency_anchor",
      persona: compassDry.persona,
      severity: "warning",
      content: foreignMemory.content,
      authorRole: "ai",
      parentId: null,
      status: "open",
      metadata: JSON.stringify({
        confidence: "medium",
        found_text: foreignMemory.foundText,
        found_context: foreignMemory.foundContext,
        llm_reason: foreignMemory.llmReason,
        dismiss_key: foreignMemory.dismissKey,
        detected_by_model: "openrouter/anthropic/claude-sonnet-4.6",
      }),
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function getScreenshotTrashItems(now: string) {
  if (!isScreenshotStagingActive()) return [];
  const { sceneDraft, textFragment } =
    SCREENSHOT_SEED_CONTENT[getScreenshotLanguage()].trash;
  return [
    {
      id: "trash-scene-draft",
      projectId: "default-project",
      kind: "structure-item",
      subKind: "scene",
      originSceneId: "scene-1",
      originCodexId: null,
      previewText: sceneDraft.previewText,
      previewMeta: JSON.stringify({
        nodeType: "scene",
        status: "draft",
        folderHintName: sceneDraft.folderHintName,
      }),
      payload: JSON.stringify({
        originalId: "scene-old-fire-night",
        title: sceneDraft.title,
        body: proseDoc(sceneDraft.body),
        beats: "[]",
        povCharacterId: "codex-akane",
        folderHintId: "chapter-1",
        folderHintName: sceneDraft.folderHintName,
        metadata: {
          synopsis: sceneDraft.synopsis,
          status: "draft",
          nodeType: "scene",
          locationId: "codex-haisha",
          sortOrder: "a9",
          storyTimeOrder: "z1",
          storyTimeLabel: sceneDraft.storyTimeLabel,
        },
        charCount: sceneDraft.charCount,
      }),
      charCount: sceneDraft.charCount,
      isInteresting: true,
      deletedAt: now,
    },
    {
      id: "trash-text-fragment",
      projectId: "default-project",
      kind: "text-fragment",
      subKind: "text-fragment",
      originSceneId: "scene-1",
      originCodexId: null,
      previewText: textFragment.previewText,
      previewMeta: null,
      payload: JSON.stringify({
        text: textFragment.text,
        spans: [
          {
            text: textFragment.text,
            source: "human",
            model: null,
            chatMessageId: null,
            timestamp: now,
          },
        ],
      }),
      charCount: textFragment.charCount,
      isInteresting: false,
      deletedAt: now,
    },
  ];
}

function seedBuiltinCodexTypes(db: Database, now: string): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO codex_types
      (id, project_id, slug, label, color, palette_index, icon, is_builtin, sort_order, created_at)
     VALUES (?, 'default-project', ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  [
    ["type-character", "character", "人物", "#7C9BD1", 0, "user", 0],
    ["type-location", "location", "場所", "#7FB08E", 1, "map-pin", 1],
    ["type-item", "item", "道具", "#D4A35F", 2, "package", 2],
    ["type-lore", "lore", "設定", "#A783C9", 3, "book-open", 3],
  ].forEach(([id, slug, label, color, paletteIndex, icon, sortOrder]) => {
    stmt.run([id, slug, label, color, paletteIndex, icon, sortOrder, now]);
  });
  stmt.free();
}

function seedScreenshotWorkspace(db: Database, now: string): void {
  const lang = getScreenshotLanguage();
  const c = SCREENSHOT_SEED_CONTENT[lang];
  db.run(
    `UPDATE projects
     SET title = ?,
       genre = ?,
       pov = ?,
       tense = ?,
       language = ?,
       style_guide = ?,
       ai_instructions = ?,
       updated_at = ?
     WHERE id = 'default-project'`,
    [
      c.project.title,
      c.project.genre,
      c.project.pov,
      c.project.tense,
      lang,
      c.project.styleGuide,
      c.project.aiInstructions,
      now,
    ],
  );

  const sceneContent = proseDoc(c.scenes.scene1.body);

  const nodes = [
    [
      "chapter-1",
      null,
      "folder",
      c.chapter.title,
      c.chapter.synopsis,
      "a0",
      null,
      null,
      "outline",
      "{}",
      0,
    ],
    [
      "scene-1",
      "chapter-1",
      "scene",
      c.scenes.scene1.title,
      c.scenes.scene1.synopsis,
      "a0",
      "a0",
      c.scenes.scene1.storyTimeLabel,
      "draft",
      sceneContent,
      c.scenes.scene1.charCount,
    ],
    [
      "scene-2",
      "chapter-1",
      "scene",
      c.scenes.scene2.title,
      c.scenes.scene2.synopsis,
      "a1",
      "a1",
      c.scenes.scene2.storyTimeLabel,
      "outline",
      proseDoc(c.scenes.scene2.body),
      c.scenes.scene2.charCount,
    ],
    [
      "scene-3",
      "chapter-1",
      "scene",
      c.scenes.scene3.title,
      c.scenes.scene3.synopsis,
      "a2",
      "a2",
      c.scenes.scene3.storyTimeLabel,
      "outline",
      proseDoc(c.scenes.scene3.body),
      c.scenes.scene3.charCount,
    ],
  ];

  const nodeStmt = db.prepare(
    `INSERT OR IGNORE INTO tree_nodes
      (id, project_id, parent_id, node_type, title, synopsis, sort_order,
       story_time_order, story_time_label, status, content, char_count,
       unplaced_beats_doc, created_at, updated_at)
     VALUES (?, 'default-project', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
  );
  nodes.forEach((row) => nodeStmt.run([...row, now, now]));
  nodeStmt.free();

  const codexRows = [
    [
      "codex-akane",
      "character",
      c.codex.akane.name,
      c.codex.akane.summary,
      JSON.stringify([{ name: c.codex.akane.tagName, color: "#7C9BD1" }]),
    ],
    [
      "codex-otowa",
      "character",
      c.codex.otowa.name,
      c.codex.otowa.summary,
      JSON.stringify([{ name: c.codex.otowa.tagName, color: "#7FB08E" }]),
    ],
    [
      "codex-haisha",
      "location",
      c.codex.haisha.name,
      c.codex.haisha.summary,
      JSON.stringify([{ name: c.codex.haisha.tagName, color: "#7FB08E" }]),
    ],
    [
      "codex-akahimo",
      "item",
      c.codex.akahimo.name,
      c.codex.akahimo.summary,
      JSON.stringify([{ name: c.codex.akahimo.tagName, color: "#9B59B6" }]),
    ],
    [
      "codex-akanawa",
      "lore",
      c.codex.akanawa.name,
      c.codex.akanawa.summary,
      JSON.stringify([{ name: c.codex.akanawa.tagName, color: "#9B59B6" }]),
    ],
  ];
  const codexStmt = db.prepare(
    `INSERT OR IGNORE INTO codex_entries
      (id, project_id, type, name, summary, content, tags_cache, context_mode,
       children_budget, created_at, updated_at)
     VALUES (?, 'default-project', ?, ?, ?, ?, ?, 'mentioned', 'compact', ?, ?)`,
  );
  codexRows.forEach(([id, type, name, summary, tags]) => {
    codexStmt.run([
      id,
      type,
      name,
      summary,
      proseDoc([summary]),
      tags,
      now,
      now,
    ]);
  });
  codexStmt.free();

  db.run(
    `UPDATE tree_nodes SET pov_character_id = ?, location_id = ? WHERE id = 'scene-1'`,
    ["codex-akane", "codex-haisha"],
  );

  const labelRows = [
    ["label-ki", c.labels.ki, "rose", 0],
    ["label-important", c.labels.important, "red", 1],
    ["label-consider", c.labels.consider, "slate", 2],
  ];
  const labelStmt = db.prepare(
    `INSERT OR IGNORE INTO labels
      (id, project_id, name, color, sort_order, created_at)
     VALUES (?, 'default-project', ?, ?, ?, ?)`,
  );
  labelRows.forEach((row) => labelStmt.run([...row, now]));
  labelStmt.free();
  db.run(
    `INSERT OR IGNORE INTO tree_node_labels (node_id, label_id) VALUES
      ('scene-1', 'label-ki'),
      ('scene-1', 'label-important'),
      ('scene-2', 'label-consider')`,
  );

  db.run(
    `INSERT OR IGNORE INTO snippets
      (id, project_id, title, content, tags_cache, content_source, scene_id,
       source_chat_message_id, usage_count, created_at, updated_at)
     VALUES
      ('snippet-akane-restraint', 'default-project', ?, ?, ?,
       'human', 'scene-1', NULL, 2, ?, ?),
      ('snippet-akahimo-reunion', 'default-project', ?, ?, ?,
       'human', 'scene-1', NULL, 1, ?, ?)`,
    [
      c.snippets.restraint.title,
      proseDoc(c.snippets.restraint.body),
      JSON.stringify([
        { name: c.snippets.restraint.tagName, color: "#5B8CDD" },
      ]),
      now,
      now,
      c.snippets.reunion.title,
      proseDoc(c.snippets.reunion.body),
      JSON.stringify([{ name: c.snippets.reunion.tagName, color: "#9B59B6" }]),
      now,
      now,
    ],
  );

  db.run(
    `INSERT OR IGNORE INTO map_boards
      (id, project_id, title, sort_order, mode, viewport_x, viewport_y,
       viewport_zoom, show_config, color_by, created_at, updated_at)
     VALUES ('default-project-main-board', 'default-project', 'Main', 0, 'free',
       0, 0, 0.9, '{}', 'type', ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO map_node_positions
      (id, board_id, node_ref_type, tree_node_id, codex_entry_id, snippet_id,
       sticky_id, ai_branch_id, x, y, pinned, z_index, created_at, updated_at)
     VALUES
      ('map-pos-akane', 'default-project-main-board', 'codex', NULL,
       'codex-akane', NULL, NULL, NULL, 120, 100, 0, 1, ?, ?),
      ('map-pos-haisha', 'default-project-main-board', 'codex', NULL,
       'codex-haisha', NULL, NULL, NULL, 420, 110, 0, 1, ?, ?),
      ('map-pos-akahimo', 'default-project-main-board', 'codex', NULL,
       'codex-akahimo', NULL, NULL, NULL, 260, 330, 0, 1, ?, ?),
      ('map-pos-scene-1', 'default-project-main-board', 'scene',
       'scene-1', NULL, NULL, NULL, NULL, 720, 160, 0, 1, ?, ?),
      ('map-pos-scene-2', 'default-project-main-board', 'scene',
       'scene-2', NULL, NULL, NULL, NULL, 720, 390, 0, 1, ?, ?)`,
    [now, now, now, now, now, now, now, now, now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO map_edges
      (id, board_id, from_position_id, to_position_id, forward_label,
       backward_label, labels, style, color, direction, created_at, updated_at)
     VALUES
      ('map-edge-1', 'default-project-main-board', 'map-pos-akane',
       'map-pos-scene-1', ?, NULL, '[]', 'solid', '#8b7fd4',
       'forward', ?, ?),
      ('map-edge-2', 'default-project-main-board', 'map-pos-scene-1',
       'map-pos-akahimo', ?, NULL, '[]', 'solid', '#d4a35f',
       'forward', ?, ?)`,
    [c.map.edge1Label, now, now, c.map.edge2Label, now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO map_frames
      (id, board_id, title, x, y, width, height, background, border_color, z_index,
       created_at, updated_at)
     VALUES ('map-frame-return', 'default-project-main-board', ?,
       60, 40, 880, 520, '#2b3038', '#64748b', -1, ?, ?)`,
    [c.map.frameTitle, now, now],
  );

  db.run(
    `INSERT OR IGNORE INTO foreshadows
      (id, project_id, title, intent, notes, payoff_scene_id, payoff_from_pos,
       payoff_to_pos, payoff_confirmed, abandoned, secret, load_bearing,
       created_at, updated_at)
     VALUES
      ('fs-akahimo-warmth', 'default-project', ?,
       ?,
       ?, 'scene-2',
       NULL, NULL, 0, 0, 1, 'critical', ?, ?),
      ('fs-haisha-visitor', 'default-project', ?,
       ?,
       ?, NULL,
       NULL, NULL, 0, 0, 1, 'supporting', ?, ?)`,
    [
      c.foreshadows.warmth.title,
      c.foreshadows.warmth.intent,
      c.foreshadows.warmth.notes,
      Date.now(),
      Date.now(),
      c.foreshadows.visitor.title,
      c.foreshadows.visitor.intent,
      c.foreshadows.visitor.notes,
      Date.now(),
      Date.now(),
    ],
  );
  db.run(
    `INSERT OR IGNORE INTO foreshadow_setups
      (id, foreshadow_id, scene_id, from_pos, to_pos, kind, strength,
       ai_strength, ai_reasoning, attribution, ai_rationale,
       last_evaluated_at, is_orphan, created_at, updated_at)
     VALUES
      ('setup-akahimo-warmth', 'fs-akahimo-warmth', 'scene-1', ?, ?,
       'designated_existing', 'moderate', 'moderate',
       ?, 'human',
       NULL, ?, 0, ?, ?),
      ('setup-haisha-lock', 'fs-haisha-visitor', 'scene-1', ?, ?,
       'designated_existing', 'subtle', 'subtle',
       ?, 'human',
       NULL, ?, 0, ?, ?)`,
    [
      c.foreshadows.setupWarmth.fromPos,
      c.foreshadows.setupWarmth.toPos,
      c.foreshadows.setupWarmth.aiReasoning,
      Date.now(),
      Date.now(),
      Date.now(),
      c.foreshadows.setupLock.fromPos,
      c.foreshadows.setupLock.toPos,
      c.foreshadows.setupLock.aiReasoning,
      Date.now(),
      Date.now(),
      Date.now(),
    ],
  );

  db.run(
    `INSERT OR IGNORE INTO chat_sessions
      (id, project_id, node_id, title, title_manual, model, created_at, updated_at)
     VALUES ('chat-scene-1', 'default-project', 'scene-1', ?, 1,
       'openrouter/anthropic/claude-sonnet-4.6', ?, ?)`,
    [c.chat.sessionTitle, now, now],
  );
  const msgStmt = db.prepare(
    `INSERT OR IGNORE INTO chat_messages
      (id, session_id, role, content, model, tokens_in, tokens_out, duration_ms,
       metadata, is_starred, is_summarized, created_at)
     VALUES (?, 'chat-scene-1', ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?)`,
  );
  msgStmt.run([
    "chat-message-user-1",
    "user",
    c.chat.userMsg,
    null,
    null,
    null,
    null,
    0,
    now,
  ]);
  msgStmt.run([
    "chat-message-assistant-1",
    "assistant",
    c.chat.assistantMsg,
    "openrouter/anthropic/claude-sonnet-4.6",
    820,
    118,
    1320,
    1,
    now,
  ]);
  msgStmt.free();

  const pinStmt = db.prepare(
    `INSERT OR IGNORE INTO chat_session_pinned_codex
      (session_id, codex_entry_id, snippet_id, with_children, pin_source, created_at)
     VALUES ('chat-scene-1', ?, NULL, 0, 'manual', ?)`,
  );
  ["codex-akane", "codex-haisha", "codex-akahimo"].forEach((id) =>
    pinStmt.run([id, now]),
  );
  pinStmt.free();

  db.run(
    `INSERT OR REPLACE INTO app_settings (key, value) VALUES
      ('display.glassEffectEnabled', 'false'),
      ('display.reduceMotion', 'true')`,
  );

  db.run(
    `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('editor.tabState', ?)`,
    [
      JSON.stringify({
        tabs: [
          { nodeId: "scene-1", isPreview: false, contentType: "scene" },
          { nodeId: "codex-akahimo", isPreview: false, contentType: "codex" },
        ],
        activeTabId: "scene-1",
        secondaryTabs: [],
        secondaryActiveTabId: null,
        activeGroupIndex: 0,
        secondaryGroupOpen: false,
        splitDirection: "right",
        isLinearMode: false,
      }),
    ],
  );

  db.run(
    `INSERT OR IGNORE INTO codex_quick_pins (entry_id, created_at) VALUES
      ('codex-akahimo', ?),
      ('codex-akane', ?)`,
    [now, now],
  );

  db.run(
    `INSERT OR IGNORE INTO scene_codex_mentions
      (scene_id, codex_entry_id, source, role) VALUES
     ('scene-1', 'codex-akane', 'body', 'mentioned'),
     ('scene-1', 'codex-akahimo', 'body', 'mentioned'),
     ('scene-1', 'codex-haisha', 'body', 'mentioned'),
     ('scene-2', 'codex-akanawa', 'body', 'mentioned')`,
  );

  db.run(
    `INSERT OR IGNORE INTO scene_beat_pov_cache (scene_id, pov_character_id)
     VALUES ('scene-1', 'codex-akane')`,
  );

  db.run(
    `INSERT OR IGNORE INTO authorship_spans
      (id, node_id, codex_entry_id, snippet_id, detail_value_id, from_pos, to_pos, source, model, timestamp, chat_msg_id, phase_id, sticky_id)
     VALUES
      ('shot-auth-s1a', 'scene-1', NULL, NULL, NULL, 0, ?, 'human', NULL, ?, NULL, NULL, NULL),
      ('shot-auth-s1b', 'scene-1', NULL, NULL, NULL, ?, ?, 'ai', 'openrouter/anthropic/claude-sonnet-4.6', ?, NULL, NULL, NULL),
      ('shot-auth-s1c', 'scene-1', NULL, NULL, NULL, ?, ?, 'unknown', NULL, ?, NULL, NULL, NULL),
      ('shot-auth-s2a', 'scene-2', NULL, NULL, NULL, 0, ?, 'human', NULL, ?, NULL, NULL, NULL),
      ('shot-auth-s3a', 'scene-3', NULL, NULL, NULL, 0, ?, 'ai', 'openrouter/anthropic/claude-sonnet-4.6', ?, NULL, NULL, NULL)`,
    [
      c.authorship.scene1.humanTo,
      now,
      c.authorship.scene1.humanTo,
      c.authorship.scene1.aiTo,
      now,
      c.authorship.scene1.aiTo,
      c.authorship.scene1.unknownTo,
      now,
      c.authorship.scene2.humanTo,
      now,
      c.authorship.scene3.aiTo,
      now,
    ],
  );
}
