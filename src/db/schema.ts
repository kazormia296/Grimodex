import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  primaryKey,
  foreignKey,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { isNotNull } from "drizzle-orm";
import { nowInstantString } from "@/lib/time";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  title: text("title").notNull().default("Untitled Project"),
  genre: text("genre"),
  pov: text("pov"),
  tense: text("tense"),
  language: text("language").notNull().default("ja"),
  styleGuide: text("style_guide"),
  aiInstructions: text("ai_instructions"),
  /** Phase 4: プロジェクト全体の outline (free text)。物語の意図・テーマ・到達点を
   * 著者が手書きするフィールド。L2 へ常時注入される。空欄可。
   * 対称概念として treeNodes.synopsis (folder 用) が chapter outline を担う。 */
  outline: text("outline"),
  /** 想定読者プロフィール (free text)。校閲パネルの疑似コメント「ターゲット読者層」
   * ペルソナの実体として、この層になりきって反応させるために注入される。空欄可
   * (空のときターゲット読者層ペルソナは選択不可)。年齢層・読書傾向・期待など。 */
  targetReaders: text("target_readers"),
  phaseResolutionMode: text("phase_resolution_mode", {
    enum: ["reading", "story", "auto"],
  })
    .notNull()
    .default("auto"),
  /** 新規/import プロジェクトの既定 AI ポリシー。chat/analysis/本文提案(staged)は
   * 有効のまま、AI が自律的に直接 DB へ書き込む 2 軸 (knowledgeWrite=Codex/伏線/
   * Snippet, structureWrite=tree scaffold) だけ既定で OFF にする。間接プロンプト
   * インジェクションで誘発された書き込みの出口バックストップ (security F-6)。
   * ユーザーは設定 > AI 使用ポリシーで再有効化できる。fallback の DEFAULT_AI_POLICY
   * (parse 時, 全 true) とは別物で、そちらは既存プロジェクトを遡及変更しないため据え置き。 */
  aiPolicy: text("ai_policy")
    .notNull()
    .default(
      '{"preset":"custom","toggles":{"chat":true,"bodyWrite":true,"analysis":true,"structureWrite":false,"knowledgeWrite":false}}',
    ),
  createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
});

/**
 * Durable create-request tombstones shared by native SQLite and the browser
 * editor. `tombstoneJson` is intentionally content-free (`{"id":"…"}`).
 */
export const idempotencyRequests = sqliteTable(
  "idempotency_requests",
  {
    domain: text("domain").notNull(),
    requestId: text("request_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    payloadHash: text("payload_hash").notNull(),
    tombstoneJson: text("tombstone_json").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    primaryKey({ columns: [table.domain, table.requestId] }),
    index("idx_idempotency_requests_project_created").on(
      table.projectId,
      table.createdAt,
    ),
  ],
);

export const treeNodes = sqliteTable(
  "tree_nodes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parentId: text("parent_id").references((): any => treeNodes.id, {
      onDelete: "cascade",
    }),
    nodeType: text("node_type").notNull(), // CHECK('folder' | 'scene' | 'note') enforced in SQL
    title: text("title").notNull().default("Untitled"),
    synopsis: text("synopsis"), // Scene only: plain text summary for storySoFar context injection
    intent: text("intent"), // Scene only: author-declared goal for this scene (intent_drift opt-in)
    // reading-order 用の fractional-indexing キー（base62、辞書順比較）
    sortOrder: text("sort_order").notNull().default("a0"),
    // story-time 用の fractional-indexing キー（null の場合は未指定）
    storyTimeOrder: text("story_time_order"),
    storyTimeLabel: text("story_time_label"),

    povCharacterId: text("pov_character_id").references(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (): any => codexEntries.id,
      { onDelete: "set null" },
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    locationId: text("location_id").references((): any => codexEntries.id, {
      onDelete: "set null",
    }),
    // ── Chronicle（作中暦日付）─────────────────────────────────────────
    // Event エンティティと同じ chronicleTime 日付モデルをシーンにも共有する
    // （events とは統合しない）。読む順 (sortOrder) とは独立した作中時間軸。
    // granularity= EVENT_GRANULARITIES / precision= EventPrecision を再利用。
    // アンカー解決・AI 注入・UI は別タスク（このフィールドは永続化のみ）。
    // 暦ライト数値時刻（紀元からの日数）。null=日付未指定。
    chronicleStartTime: integer("chronicle_start_time"),
    // 開始時刻（24h時計の分 0..1439）。null=時刻未指定。
    chronicleStartMinute: integer("chronicle_start_minute"),
    // 開始の粒度（EVENT_GRANULARITIES）。CHECK は付けない（events 列追加と同流儀）。
    chronicleStartGranularity: text("chronicle_start_granularity")
      .notNull()
      .default("none"),
    // interval 終端（紀元からの日数）。null=point（瞬間）。
    chronicleEndTime: integer("chronicle_end_time"),
    chronicleEndMinute: integer("chronicle_end_minute"),
    chronicleEndGranularity: text("chronicle_end_granularity")
      .notNull()
      .default("none"),
    // 日付の確度（EventPrecision = 'exact' | 'approx' | 'unknown'）。
    chroniclePrecision: text("chronicle_precision").notNull().default("exact"),
    status: text("status").default("outline"), // 'outline' | 'draft' | 'complete' | 'revision' | 'final'
    content: text("content").notNull().default("{}"), // Scene/Note body (ProseMirror JSON)
    // Unplaced beats (Beat system Phase A): JSON array of { id, beatType, pov, collapsed, content }.
    // Placed beats live inside `content` as sceneBeat nodes.
    unplacedBeatsDoc: text("unplaced_beats_doc").notNull().default("[]"),
    // Body char count cache; frontend computes via CharacterCount on save.
    charCount: integer("char_count").notNull().default(0),
    // Preview text for Grid display: first 3 unplaced beats × 40 chars, newline-separated.
    unplacedBeatPreview: text("unplaced_beat_preview"),
    // JSON array string of placed-beat preview lines, extracted from `content` on save.
    placedBeatPreview: text("placed_beat_preview"),
    /** File-backed scene location: `external-root://<rootId>/<rel-path>` or null (DB-native). */
    sourceUri: text("source_uri"),
    /** Last synced file mtime (ISO 8601) for file-backed nodes. */
    sourceMtime: text("source_mtime"),
    /** Soft-delete timestamp for archived file-backed nodes. */
    archivedAt: text("archived_at"),
    /** Note-only: AI context injection mode (null for folder/scene). */
    contextMode: text("context_mode"), // 'always' | 'mentioned' | 'suppress' | 'hidden'
    /** Note-only: alternate names for mention detection (JSON array). */
    aliases: text("aliases").notNull().default("[]"),
    /** Note-only: aliases excluded from mention detection (JSON array). */
    excludedAliases: text("excluded_aliases").notNull().default("[]"),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
    // OCC version. The column is created by src-tauri/src/database/migrate.rs
    // (add_column_if_missing on tree_nodes); Drizzle was unaware of it.
    // The AI/agent write path already uses it for optimistic locking; declaring
    // it here lets the human save path do a conditional version check instead
    // of a blind overwrite (multi-window write safety).
    version: integer("version").notNull().default(0),
  },
  (table) => [
    index("idx_tree_parent").on(
      table.projectId,
      table.parentId,
      table.sortOrder,
    ),
    index("idx_tree_story_time").on(table.projectId, table.storyTimeOrder),
  ],
);

export const codexTypes = sqliteTable(
  "codex_types",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    color: text("color").notNull().default("#888888"),
    paletteIndex: integer("palette_index"),
    icon: text("icon"),
    isBuiltin: integer("is_builtin").notNull().default(0),
    sortOrder: real("sort_order").notNull().default(0.0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    uniqueIndex("uq_codex_types_project_slug").on(table.projectId, table.slug),
    index("idx_codex_types_project").on(table.projectId),
  ],
);

export const codexEntries = sqliteTable(
  "codex_entries",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parentId: text("parent_id").references((): any => codexEntries.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull().default("character"), // Composite FK → codex_types(project_id, slug), see foreignKey below
    name: text("name").notNull().default("Untitled"),
    aliases: text("aliases"), // JSON string[]
    excludedAliases: text("excluded_aliases"), // JSON string[]
    // 表記 (name / 各 alias) → 読みの配列。IME 変換辞書注入・ルビ・五十音ソート
    // 用の汎用データ (docs/Grimodex_IME連携設計書.md §3.1)。aliases と同じ流儀の
    // nullable JSON 文字列カラム。値は Record<表記, string[]>。列は
    // migrate.rs の add_column_if_missing で後付けされる (version と同じ経路)。
    readings: text("readings"), // JSON Record<string, string[]>
    summary: text("summary"),
    content: text("content").notNull().default("{}"), // body (ProseMirror JSON)
    icon: text("icon"), // 128×128 WebP icon image as base64 data URL (nullable)
    tagsCache: text("tags_cache"), // FTS5 denormalized cache (JSON `{name: string, color: string | null}[]`; `tagApi.setEntryTags` writes this shape so a list view can render colors without a join)
    contextMode: text("context_mode").notNull().default("mentioned"), // 'always' | 'mentioned' | 'suppress' | 'hidden'
    childrenBudget: text("children_budget").notNull().default("compact"), // 'none' | 'compact' | 'standard' | 'generous'
    sourceChatMessageId: text("source_chat_message_id").references(
      () => chatMessages.id,
      { onDelete: "set null" },
    ),
    notes: text("notes"), // Private notes (ProseMirror JSON) – never injected into AI context
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
    // OCC version. The column is created by src-tauri/src/database/migrate.rs
    // (add_column_if_missing on codex_entries); Drizzle was unaware of it.
    // The AI/agent write path already uses it for optimistic locking; declaring
    // it here lets the human save path do a conditional version check instead
    // of a blind overwrite (multi-window write safety).
    version: integer("version").notNull().default(0),
  },
  (table) => [
    index("idx_codex_project").on(table.projectId, table.type),
    index("idx_codex_name").on(table.projectId, table.name),
    index("idx_codex_parent").on(table.parentId),
    index("idx_codex_entries_src_msg").on(table.sourceChatMessageId),
    foreignKey({
      columns: [table.projectId, table.type],
      foreignColumns: [codexTypes.projectId, codexTypes.slug],
      name: "codex_entries_type_fkey",
    })
      .onUpdate("cascade")
      .onDelete("restrict"),
  ],
);

export const codexDismissedRelations = sqliteTable(
  "codex_dismissed_relations",
  {
    entryId: text("entry_id")
      .notNull()
      .references(() => codexEntries.id, { onDelete: "cascade" }),
    dismissedId: text("dismissed_id")
      .notNull()
      .references(() => codexEntries.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.entryId, table.dismissedId] })],
);

export const codexQuickPins = sqliteTable(
  "codex_quick_pins",
  {
    entryId: text("entry_id")
      .primaryKey()
      .references(() => codexEntries.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [index("idx_codex_quick_pins_created").on(table.createdAt)],
);

export const codexTags = sqliteTable(
  "codex_tags",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    typeFilter: text("type_filter"), // JSON string[] | null
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    uniqueIndex("uq_codex_tags_project_name").on(table.projectId, table.name),
    index("idx_codex_tags_project").on(table.projectId),
  ],
);

export const codexEntryTags = sqliteTable(
  "codex_entry_tags",
  {
    entryId: text("entry_id")
      .notNull()
      .references(() => codexEntries.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => codexTags.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.entryId, table.tagId] })],
);

export const codexDetailDefinitions = sqliteTable(
  "codex_detail_definitions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    typeSlug: text("type_slug").notNull(), // Composite FK → codex_types(project_id, slug), see foreignKey below
    name: text("name").notNull(),
    fieldType: text("field_type").notNull().default("text"), // CHECK('text' | 'dropdown' | 'codex_reference')
    fieldConfig: text("field_config"), // JSON
    sortOrder: real("sort_order").notNull().default(0.0),
    includeInContext: integer("include_in_context").notNull().default(0),
    // OCC version. Added in SCHEMA_VERSION 8 via migrate.rs add_column_if_missing.
    version: integer("version").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    uniqueIndex("uq_codex_detail_defs_project_type_name").on(
      table.projectId,
      table.typeSlug,
      table.name,
    ),
    uniqueIndex("uq_codex_detail_defs_project_id").on(
      table.projectId,
      table.id,
    ),
    index("idx_codex_detail_defs").on(
      table.projectId,
      table.typeSlug,
      table.sortOrder,
    ),
    foreignKey({
      columns: [table.projectId, table.typeSlug],
      foreignColumns: [codexTypes.projectId, codexTypes.slug],
      name: "codex_detail_defs_type_fkey",
    })
      .onUpdate("cascade")
      .onDelete("restrict"),
  ],
);

export const codexDetailSemanticBindings = sqliteTable(
  "codex_detail_semantic_bindings",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    definitionId: text("definition_id").notNull(),
    facetKey: text("facet_key").notNull(),
    projectionKind: text("projection_kind", {
      enum: ["scalar-text", "summary-text", "enum", "entity-reference"],
    }).notNull(),
    temporalPolicy: text("temporal_policy", {
      enum: [
        "base-only",
        "phase-on-durable-change",
        "base-and-phase",
        "derived",
        "manual-only",
      ],
    }).notNull(),
    source: text("source", {
      enum: ["preset", "user", "reviewed-ai"],
    }).notNull(),
    confirmed: integer("confirmed", { mode: "boolean" })
      .notNull()
      .default(false),
    version: integer("version").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.definitionId],
      foreignColumns: [
        codexDetailDefinitions.projectId,
        codexDetailDefinitions.id,
      ],
      name: "codex_detail_semantic_bindings_definition_fkey",
    }).onDelete("cascade"),
    uniqueIndex("uq_codex_detail_semantic_binding_definition_facet").on(
      table.definitionId,
      table.facetKey,
    ),
    index("idx_codex_detail_semantic_bindings_project_facet").on(
      table.projectId,
      table.facetKey,
    ),
  ],
);

export const codexDetailValues = sqliteTable(
  "codex_detail_values",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id")
      .notNull()
      .references(() => codexEntries.id, { onDelete: "cascade" }),
    definitionId: text("definition_id")
      .notNull()
      .references(() => codexDetailDefinitions.id, { onDelete: "cascade" }),
    value: text("value"),
    // OCC version. Added in SCHEMA_VERSION 8 via migrate.rs add_column_if_missing.
    // New inserts start at 1; updates require baseVersion and CAS-bump.
    version: integer("version").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    uniqueIndex("uq_codex_detail_values_entry_def").on(
      table.entryId,
      table.definitionId,
    ),
    index("idx_codex_detail_values_entry").on(table.entryId),
    index("idx_codex_detail_values_def").on(table.definitionId),
  ],
);

export const snippets = sqliteTable(
  "snippets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("Untitled"),
    content: text("content").notNull().default("{}"), // ProseMirror JSON
    tagsCache: text("tags_cache"), // denormalized JSON {name, color}[] from snippet_entry_tags
    contentSource: text("content_source"),
    sceneId: text("scene_id").references(() => treeNodes.id, {
      onDelete: "set null",
    }),
    sourceChatMessageId: text("source_chat_message_id").references(
      () => chatMessages.id,
      { onDelete: "set null" },
    ),
    usageCount: integer("usage_count").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
    // OCC version. The column is created by src-tauri/src/database/migrate.rs
    // (add_column_if_missing on snippets); Drizzle was unaware of it.
    // The AI/agent write path already uses it for optimistic locking; declaring
    // it here lets the human save path do a conditional version check instead
    // of a blind overwrite (multi-window write safety).
    version: integer("version").notNull().default(0),
  },
  (table) => [
    index("idx_snippets_project").on(table.projectId, table.createdAt),
    index("idx_snippets_scene").on(table.sceneId),
    index("idx_snippets_src_msg").on(table.sourceChatMessageId),
  ],
);

export const snippetEntryTags = sqliteTable(
  "snippet_entry_tags",
  {
    snippetId: text("snippet_id")
      .notNull()
      .references(() => snippets.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => codexTags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.snippetId, table.tagId] }),
    index("idx_snippet_entry_tags_tag_id").on(table.tagId),
  ],
);

export const chatSessions = sqliteTable(
  "chat_sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    nodeId: text("node_id").references(() => treeNodes.id, {
      onDelete: "set null",
    }),
    codexAnchorId: text("codex_anchor_id").references(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forward ref breaks circular inference
      (): any => codexEntries.id,
      { onDelete: "set null" },
    ),
    snippetAnchorId: text("snippet_anchor_id").references(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forward ref breaks circular inference
      (): any => snippets.id,
      { onDelete: "set null" },
    ),
    title: text("title").notNull().default("New session"),
    titleManual: integer("title_manual").notNull().default(0),
    model: text("model")
      .notNull()
      .default("openrouter/anthropic/claude-sonnet-4.6"),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_chat_sessions_node").on(table.projectId, table.nodeId),
    index("idx_chat_sessions_codex_anchor").on(
      table.projectId,
      table.codexAnchorId,
    ),
    index("idx_chat_sessions_snippet_anchor").on(
      table.projectId,
      table.snippetAnchorId,
    ),
  ],
);

/** External runtime thread binding (Codex App Server and future runtimes). */
export const chatRuntimeThreads = sqliteTable(
  "chat_runtime_threads",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    runtime: text("runtime").notNull(),
    externalThreadId: text("external_thread_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    historyRevision: text("history_revision"),
    lastTurnId: text("last_turn_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.runtime] }),
    uniqueIndex("uq_chat_runtime_threads_external").on(
      table.runtime,
      table.externalThreadId,
    ),
    index("idx_chat_runtime_threads_project").on(
      table.projectId,
      table.runtime,
    ),
  ],
);

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'user' | 'assistant' | 'system'
    content: text("content").notNull(),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    durationMs: integer("duration_ms"),
    metadata: text("metadata"), // JSON
    isStarred: integer("is_starred").notNull().default(0),
    isSummarized: integer("is_summarized").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_chat_messages_session").on(table.sessionId, table.createdAt),
  ],
);

/**
 * Per-message prompt snapshot: the finalized system prompt (incl. RAG /
 * related_scenes / injected context) actually sent for a chat turn, captured
 * at send time and keyed to the triggering USER message. Lets the user open any
 * past message and see the exact prompt that produced the reply — reconstruction
 * cannot recover it because RAG is nondeterministic and codex/scene state mutates
 * after send. Stored in a side-table (not chat_messages.metadata) so the heavy
 * prompt text stays out of the listMessages full-row load and is fetched lazily
 * only when the preview modal opens. DDL authority lives in
 * src-tauri/src/database/migrate.rs (chat_message_prompts) — keep in lockstep.
 */
export const chatMessagePrompts = sqliteTable("chat_message_prompts", {
  messageId: text("message_id")
    .primaryKey()
    .references(() => chatMessages.id, { onDelete: "cascade" }),
  systemPrompt: text("system_prompt").notNull(),
  // JSON { layers: LayerBreakdown[], provider, contextWindow }; legacy rows are arrays.
  layers: text("layers"),
  totalTokens: integer("total_tokens"),
  model: text("model"),
  createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
});

export const generationLogs = sqliteTable(
  "generation_logs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sceneNodeId: text("scene_node_id").references(() => treeNodes.id, {
      onDelete: "cascade",
    }),
    kind: text("kind", { enum: ["inline-ai", "beat"] }).notNull(),
    commandId: text("command_id"),
    instruction: text("instruction"),
    promptFull: text("prompt_full"),
    model: text("model"),
    traceId: text("trace_id").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_generation_logs_project_trace").on(
      table.projectId,
      table.traceId,
    ),
    index("idx_generation_logs_scene").on(table.sceneNodeId),
    uniqueIndex("uq_generation_logs_trace").on(table.traceId),
  ],
);

/**
 * AI usage ledger (N4): append-only per-generation token/cost record across
 * ALL AI generation surfaces. One row per LLM generation. DDL authority lives
 * in src-tauri/src/database/migrate.rs (ai_usage) — keep in lockstep by hand.
 *
 * tokens/cost are nullable: streaming providers that do not opt into usage and
 * aborted streams deliver no usage, but the row is still recorded so the number
 * of invocations is counted. `surface` is a free-text discriminator (see
 * AiUsageSurface in src/features/ai-usage/recordAiUsage.ts); `costUsd` is the
 * provider-reported cost (OpenRouter) when available, otherwise null and the UI
 * estimates from tokens via modelPricing.
 */
export const aiUsage = sqliteTable(
  "ai_usage",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    surface: text("surface").notNull(),
    sceneNodeId: text("scene_node_id").references(() => treeNodes.id, {
      onDelete: "set null",
    }),
    model: text("model"),
    provider: text("provider"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    costUsd: real("cost_usd"),
    durationMs: integer("duration_ms"),
    traceId: text("trace_id"),
    refId: text("ref_id"),
    metadata: text("metadata"), // JSON
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_ai_usage_project_created").on(table.projectId, table.createdAt),
    index("idx_ai_usage_project_surface").on(table.projectId, table.surface),
  ],
);

/**
 * A/B 比較 (③): 同一プロンプトに対しモデル / プロンプト追記の 2 構成 (A/B) を
 * 走らせた結果と採用判断を記録する履歴。surface は "chat" | "inline" 等。
 * chosen は採用したカラム ("a" | "b")、未採用なら null。
 * src-tauri/src/database/migrate.rs の ab_comparisons とミラー (2 箇所手動同期)。
 */
export const abComparisons = sqliteTable(
  "ab_comparisons",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    surface: text("surface").notNull(),
    prompt: text("prompt").notNull(),
    modelA: text("model_a"),
    modelB: text("model_b"),
    promptVariantA: text("prompt_variant_a"),
    promptVariantB: text("prompt_variant_b"),
    responseA: text("response_a").notNull(),
    responseB: text("response_b").notNull(),
    chosen: text("chosen"), // "a" | "b" | null
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_ab_comparisons_project_created").on(
      table.projectId,
      table.createdAt,
    ),
  ],
);

/**
 * A/B 比較 (③) — N 枠 (スロット) 版。同一プロンプトに対し任意数の構成
 * (provider / model / プロンプト追記) を走らせた結果と採用判断を記録する履歴。
 * `slots` は各枠の構成 + 応答を持つ JSON TEXT 配列 (AbRunSlotRecord[])、
 * `chosen` は採用した枠の slotId (基準枠は "baseline")、未採用なら null。
 * 旧 2 枠版 abComparisons を置き換える (旧テーブルは互換のため残置・新規書き込み無し)。
 * src-tauri/src/database/migrate.rs の ab_comparison_runs とミラー (2 箇所手動同期)。
 */
export const abComparisonRuns = sqliteTable(
  "ab_comparison_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    surface: text("surface").notNull(),
    prompt: text("prompt").notNull(),
    /** JSON TEXT: AbRunSlotRecord[] (slotId / provider / model / promptVariant / ok / response)。 */
    slots: text("slots").notNull(),
    chosen: text("chosen"), // 採用した slotId、未採用なら null
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_ab_comparison_runs_project_created").on(
      table.projectId,
      table.createdAt,
    ),
  ],
);

export const chatSummaries = sqliteTable(
  "chat_summaries",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    tokenCount: integer("token_count"),
    generation: integer("generation").notNull().default(1),
    sourceMsgCount: integer("source_msg_count").notNull().default(0),
    lastMsgId: text("last_msg_id").references(() => chatMessages.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_chat_summaries_session").on(table.sessionId, table.createdAt),
    index("idx_chat_summaries_generation").on(
      table.sessionId,
      table.generation,
    ),
  ],
);

// Source messages referenced by each chat summary. Replaces the former
// chat_summaries.source_message_ids JSON array with a proper FK set so
// deleting a message cannot leave a dangling reference.
export const chatSummaryMessages = sqliteTable(
  "chat_summary_messages",
  {
    summaryId: text("summary_id")
      .notNull()
      .references(() => chatSummaries.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.summaryId, table.messageId] }),
    index("idx_chat_summary_messages_msg").on(table.messageId),
  ],
);

// Pinned codex / snippet entries per chat session. Replaces the former
// chat_sessions.pinned_codex JSON blob with a proper FK table. Exactly one
// of codex_entry_id / snippet_id must be non-null (enforced in SQL).
export const chatSessionPinnedCodex = sqliteTable(
  "chat_session_pinned_codex",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    codexEntryId: text("codex_entry_id").references(() => codexEntries.id, {
      onDelete: "cascade",
    }),
    snippetId: text("snippet_id").references(() => snippets.id, {
      onDelete: "cascade",
    }),
    stickyId: text("sticky_id").references(() => mapStickies.id, {
      onDelete: "cascade",
    }),
    withChildren: integer("with_children").notNull().default(0),
    pinSource: text("pin_source", { enum: ["manual", "chat_mention"] })
      .notNull()
      .default("manual"),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_chat_pin_session").on(table.sessionId, table.createdAt),
    uniqueIndex("uq_chat_pin_codex")
      .on(table.sessionId, table.codexEntryId)
      .where(isNotNull(table.codexEntryId)),
    uniqueIndex("uq_chat_pin_snippet")
      .on(table.sessionId, table.snippetId)
      .where(isNotNull(table.snippetId)),
    uniqueIndex("uq_chat_pin_sticky")
      .on(table.sessionId, table.stickyId)
      .where(isNotNull(table.stickyId)),
  ],
);

export const authorshipSpans = sqliteTable(
  "authorship_spans",
  {
    id: text("id").primaryKey(),
    nodeId: text("node_id").references(() => treeNodes.id, {
      onDelete: "cascade",
    }), // nullable: Scene/Note
    codexEntryId: text("codex_entry_id").references(() => codexEntries.id, {
      onDelete: "cascade",
    }), // nullable: Codex entry
    snippetId: text("snippet_id").references(() => snippets.id, {
      onDelete: "cascade",
    }), // nullable: Snippet
    detailValueId: text("detail_value_id").references(
      () => codexDetailValues.id,
      { onDelete: "cascade" },
    ), // nullable: Detail value
    fromPos: integer("from_pos").notNull(),
    toPos: integer("to_pos").notNull(),
    source: text("source").notNull(), // 'human' | 'ai' | 'unknown'
    model: text("model"),
    timestamp: text("timestamp"),
    chatMsgId: text("chat_msg_id"),
    traceId: text("trace_id"),
    phaseId: text("phase_id").references(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (): any => codexEntryPhases.id,
      { onDelete: "cascade" },
    ),
    stickyId: text("sticky_id").references(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (): any => mapStickies.id,
      { onDelete: "cascade" },
    ), // nullable: Map Sticky
    // SQL CHECK: exactly one of nodeId/codexEntryId/snippetId/detailValueId/stickyId is NOT NULL.
    // phaseId is orthogonal but requires codexEntryId to be set (enforced in SQL).
  },
  (table) => [
    index("idx_authorship_node").on(table.nodeId, table.source),
    index("idx_authorship_codex").on(table.codexEntryId, table.source),
    index("idx_authorship_snippet").on(table.snippetId, table.source),
    index("idx_authorship_detail").on(table.detailValueId),
    index("idx_authorship_phase").on(table.phaseId),
    index("idx_authorship_sticky").on(table.stickyId),
  ],
);

export const contentVersions = sqliteTable(
  "content_versions",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(), // 'scene' | 'note' | 'codex_entry' | 'snippet'
    entityId: text("entity_id").notNull(),
    content: text("content").notNull(),
    versionNumber: integer("version_number").notNull(),
    snapshotType: text("snapshot_type").notNull().default("auto"), // 'auto' | 'manual'
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    uniqueIndex("uq_content_versions_entity_version").on(
      table.entityType,
      table.entityId,
      table.versionNumber,
    ),
    index("idx_cv_entity").on(
      table.entityType,
      table.entityId,
      table.versionNumber,
    ),
  ],
);

export const projectSnapshots = sqliteTable(
  "project_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    uniqueIndex("uq_project_snapshots_project_name").on(
      table.projectId,
      table.name,
    ),
    index("idx_project_snapshots").on(table.projectId, table.createdAt),
  ],
);

export const projectSnapshotEntries = sqliteTable(
  "project_snapshot_entries",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => projectSnapshots.id, { onDelete: "cascade" }),
    // ON DELETE RESTRICT in SQL: pruning cannot remove a version referenced by a snapshot.
    versionId: text("version_id")
      .notNull()
      .references(() => contentVersions.id, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.snapshotId, table.versionId] })],
);

// Structural snapshot: tree_nodes metadata at snapshot time.
// `bodyVersionId` is RESTRICT FK so the referenced content_versions row is
// preserved even after the source tree_node is deleted — this is what makes
// "restore a deleted scene" possible.
export const projectSnapshotTreeNodes = sqliteTable(
  "project_snapshot_tree_nodes",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => projectSnapshots.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    parentId: text("parent_id"),
    nodeType: text("node_type").notNull(),
    title: text("title").notNull(),
    synopsis: text("synopsis"),
    intent: text("intent"),
    sortOrder: text("sort_order").notNull(),
    storyTimeOrder: text("story_time_order"),
    storyTimeLabel: text("story_time_label"),
    povCharacterId: text("pov_character_id"),
    locationId: text("location_id"),
    // Chronicle（作中暦日付）— tree_nodes と同じ型・既定値でミラー。
    chronicleStartTime: integer("chronicle_start_time"),
    chronicleStartMinute: integer("chronicle_start_minute"),
    chronicleStartGranularity: text("chronicle_start_granularity")
      .notNull()
      .default("none"),
    chronicleEndTime: integer("chronicle_end_time"),
    chronicleEndMinute: integer("chronicle_end_minute"),
    chronicleEndGranularity: text("chronicle_end_granularity")
      .notNull()
      .default("none"),
    chroniclePrecision: text("chronicle_precision").notNull().default("exact"),
    status: text("status"),
    bodyVersionId: text("body_version_id").references(
      () => contentVersions.id,
      {
        onDelete: "restrict",
      },
    ),
    unplacedBeatsDoc: text("unplaced_beats_doc").notNull().default("[]"),
    charCount: integer("char_count").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [primaryKey({ columns: [table.snapshotId, table.nodeId] })],
);

export const projectSnapshotCodexEntries = sqliteTable(
  "project_snapshot_codex_entries",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => projectSnapshots.id, { onDelete: "cascade" }),
    entryId: text("entry_id").notNull(),
    type: text("type").notNull(),
    name: text("name").notNull(),
    parentId: text("parent_id"),
    aliases: text("aliases"),
    excludedAliases: text("excluded_aliases"),
    summary: text("summary"),
    icon: text("icon"),
    contextMode: text("context_mode").notNull(),
    childrenBudget: text("children_budget").notNull(),
    notes: text("notes"),
    bodyVersionId: text("body_version_id").references(
      () => contentVersions.id,
      {
        onDelete: "restrict",
      },
    ),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [primaryKey({ columns: [table.snapshotId, table.entryId] })],
);

export const projectSnapshotSnippets = sqliteTable(
  "project_snapshot_snippets",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => projectSnapshots.id, { onDelete: "cascade" }),
    snippetId: text("snippet_id").notNull(),
    title: text("title").notNull(),
    sceneId: text("scene_id"),
    sourceChatMessageId: text("source_chat_message_id"),
    bodyVersionId: text("body_version_id").references(
      () => contentVersions.id,
      {
        onDelete: "restrict",
      },
    ),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [primaryKey({ columns: [table.snapshotId, table.snippetId] })],
);

// Per-snapshot, per-scope JSON blob for ancillary join tables (labels,
// foreshadow setups, map layout, lint settings, etc.). Payload schema lives
// in src/features/revision/projectSnapshotScopes.ts.
export const projectSnapshotAux = sqliteTable(
  "project_snapshot_aux",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => projectSnapshots.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    payloadJson: text("payload_json").notNull(),
  },
  (table) => [primaryKey({ columns: [table.snapshotId, table.scope] })],
);

export const codexEntryPhases = sqliteTable(
  "codex_entry_phases",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id")
      .notNull()
      .references(() => codexEntries.id, { onDelete: "cascade" }),
    anchorNodeId: text("anchor_node_id").references(() => treeNodes.id, {
      onDelete: "set null",
    }),
    label: text("label").notNull().default(""),
    summaryOverride: text("summary_override"),
    contentOverride: text("content_override"),
    contextModeOverride: text("context_mode_override"),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
    /** Optimistic-lock version shared by editor, history, and external writers. */
    version: integer("version").notNull().default(0),
  },
  (table) => [
    index("idx_codex_phases_entry").on(table.entryId),
    index("idx_codex_phases_anchor").on(table.anchorNodeId),
  ],
);

export const codexPhaseDetailOverrides = sqliteTable(
  "codex_phase_detail_overrides",
  {
    phaseId: text("phase_id")
      .notNull()
      .references(() => codexEntryPhases.id, { onDelete: "cascade" }),
    definitionId: text("definition_id")
      .notNull()
      .references(() => codexDetailDefinitions.id, { onDelete: "cascade" }),
    value: text("value"),
  },
  (table) => [
    primaryKey({ columns: [table.phaseId, table.definitionId] }),
    index("idx_phase_detail_overrides_phase").on(table.phaseId),
  ],
);

// App-wide key-value store (shared across projects). All current setting keys
// (editor/display/ai/keys/data/revision/tree/export) live here since they are
// user preferences, not project metadata.
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * Native-owned Narrative Engine runtime authority (Release Gate B Foundation).
 * Renderer generic SQL must not mutate this table — only the typed Native
 * setter (`narrative_runtime_policy_set`) may change it.
 */
export const narrativeRuntimePolicy = sqliteTable("narrative_runtime_policy", {
  singletonId: integer("singleton_id").primaryKey(),
  runtimeMode: text("runtime_mode").notNull().default("review-only"),
  maintenanceEnabled: integer("maintenance_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  genericImportEnabled: integer("generic_import_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  backgroundAiEnabled: integer("background_ai_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  version: integer("version").notNull().default(1),
});

// Project-scoped key-value store. Reserved for future per-project overrides.
export const projectSettings = sqliteTable(
  "project_settings",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.key] })],
);

// Scene–Codex many-to-many pins (explicit user-created links, distinct from
// auto-detected mentions). One row = one Scene has one Codex entry pinned.
export const sceneCodexPins = sqliteTable(
  "scene_codex_pins",
  {
    sceneId: text("scene_id")
      .notNull()
      .references(() => treeNodes.id, { onDelete: "cascade" }),
    entryId: text("entry_id")
      .notNull()
      .references(() => codexEntries.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    primaryKey({ columns: [table.sceneId, table.entryId] }),
    index("idx_scene_codex_pins_scene").on(table.sceneId),
    index("idx_scene_codex_pins_entry").on(table.entryId),
  ],
);

// Map panel tables

export const mapBoards = sqliteTable(
  "map_boards",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("Main"),
    sortOrder: real("sort_order").notNull().default(0.0),
    mode: text("mode", { enum: ["free", "theme"] })
      .notNull()
      .default("free"),
    viewportX: real("viewport_x").notNull().default(0),
    viewportY: real("viewport_y").notNull().default(0),
    viewportZoom: real("viewport_zoom").notNull().default(1.0),
    showConfig: text("show_config").notNull().default("{}"),
    colorBy: text("color_by").notNull().default("none"),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [index("idx_map_boards_project").on(table.projectId)],
);

export const mapAiBranches = sqliteTable(
  "map_ai_branches",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id")
      .notNull()
      .references(() => mapBoards.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    seedNodeIds: text("seed_node_ids").notNull().default("[]"),
    sessionId: text("session_id").references(() => chatSessions.id, {
      onDelete: "set null",
    }),
    model: text("model"),
    tokenUsage: integer("token_usage"),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [index("idx_map_ai_branches_board").on(table.boardId)],
);

export const mapStickies = sqliteTable(
  "map_stickies",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id")
      .notNull()
      .references(() => mapBoards.id, { onDelete: "cascade" }),
    title: text("title"),
    body: text("body").notNull().default('{"type":"doc","content":[]}'),
    previewText: text("preview_text"),
    paletteId: text("palette_id").notNull().default("post-it-playful"),
    colorSlot: integer("color_slot").notNull().default(0),
    aiBranchId: text("ai_branch_id").references(() => mapAiBranches.id, {
      onDelete: "set null",
    }),
    // AI由来 provenance フラグ。aiBranchId は「現在どの branch に属するか」を表し、
    // 採用 (adopt) で null に落ちる。一方こちらは「AI が生成した付箋か」という
    // 出自で、採用後も保持される。onCopy の帰属ラベル (StickyNode) はこちらを見る。
    aiDerived: integer("ai_derived").notNull().default(0),
    sourceChatMessageId: text("source_chat_message_id").references(
      () => chatMessages.id,
      { onDelete: "set null" },
    ),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_map_stickies_board").on(table.boardId),
    index("idx_map_stickies_ai_branch").on(table.aiBranchId),
  ],
);

/**
 * Editor-only visual notes. The body is intentionally outside every content
 * pipeline; `documentKey` is the stable renderer identity while the typed
 * nullable owner columns keep deletes/cascades safe in SQLite.
 */
export const editorStickies = sqliteTable(
  "editor_stickies",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    documentKey: text("document_key").notNull(),
    body: text("body").notNull().default('{"type":"doc","content":[]}'),
    paletteId: text("palette_id").notNull().default("post-it-playful"),
    colorSlot: integer("color_slot").notNull().default(0),
    inlineOffset: real("inline_offset").notNull().default(0),
    blockOffset: real("block_offset").notNull().default(0),
    zIndex: integer("z_index").notNull().default(0),
    version: integer("version").notNull().default(0),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    treeNodeId: text("tree_node_id").references((): any => treeNodes.id, {
      onDelete: "cascade",
    }),

    codexEntryId: text("codex_entry_id").references(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (): any => codexEntries.id,
      { onDelete: "cascade" },
    ),

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    phaseId: text("phase_id").references((): any => codexEntryPhases.id, {
      onDelete: "cascade",
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snippetId: text("snippet_id").references((): any => snippets.id, {
      onDelete: "cascade",
    }),

    chronicleEventId: text("chronicle_event_id").references(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (): any => events.id,
      { onDelete: "cascade" },
    ),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_editor_stickies_project_document").on(
      table.projectId,
      table.documentKey,
    ),
    index("idx_editor_stickies_tree_node").on(table.treeNodeId),
    index("idx_editor_stickies_codex_entry").on(table.codexEntryId),
    index("idx_editor_stickies_phase").on(table.phaseId),
    index("idx_editor_stickies_snippet").on(table.snippetId),
    index("idx_editor_stickies_event").on(table.chronicleEventId),
  ],
);

export const mapNodePositions = sqliteTable(
  "map_node_positions",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id")
      .notNull()
      .references(() => mapBoards.id, { onDelete: "cascade" }),
    nodeRefType: text("node_ref_type", {
      enum: ["scene", "codex", "snippet", "note", "sticky", "ai_branch"],
    }).notNull(),
    treeNodeId: text("tree_node_id").references(() => treeNodes.id, {
      onDelete: "cascade",
    }),
    codexEntryId: text("codex_entry_id").references(() => codexEntries.id, {
      onDelete: "cascade",
    }),
    snippetId: text("snippet_id").references(() => snippets.id, {
      onDelete: "cascade",
    }),
    stickyId: text("sticky_id").references(() => mapStickies.id, {
      onDelete: "cascade",
    }),
    aiBranchId: text("ai_branch_id").references(() => mapAiBranches.id, {
      onDelete: "cascade",
    }),
    x: real("x").notNull(),
    y: real("y").notNull(),
    pinned: integer("pinned").notNull().default(0),
    zIndex: integer("z_index").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [index("idx_map_pos_board").on(table.boardId)],
);

export const mapEdges = sqliteTable(
  "map_edges",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id")
      .notNull()
      .references(() => mapBoards.id, { onDelete: "cascade" }),
    fromPositionId: text("from_position_id")
      .notNull()
      .references(() => mapNodePositions.id, { onDelete: "cascade" }),
    toPositionId: text("to_position_id")
      .notNull()
      .references(() => mapNodePositions.id, { onDelete: "cascade" }),
    forwardLabel: text("forward_label"),
    backwardLabel: text("backward_label"),
    labels: text("labels").notNull().default("[]"),
    style: text("style", { enum: ["solid", "dashed", "dotted"] })
      .notNull()
      .default("solid"),
    color: text("color").notNull().default("#000000"),
    direction: text("direction", {
      enum: ["none", "forward", "bidirectional"],
    })
      .notNull()
      .default("none"),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_map_edges_board").on(table.boardId),
    index("idx_map_edges_from").on(table.fromPositionId),
    index("idx_map_edges_to").on(table.toPositionId),
  ],
);

/** Formal typed relations between Codex entries (Map User edge promotion, manual). */
export const codexRelations = sqliteTable(
  "codex_relations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fromCodexId: text("from_codex_id")
      .notNull()
      .references(() => codexEntries.id, { onDelete: "cascade" }),
    toCodexId: text("to_codex_id")
      .notNull()
      .references(() => codexEntries.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull().default("custom"),
    label: text("label"),
    // CHECK(directionality IN ('directed','symmetric')) は SQL 側。
    directionality: text("directionality").notNull().default("directed"),
    inverseLabel: text("inverse_label"),
    // migrate が既存行を directed semantic key で backfill する。初期 default は空文字。
    semanticKey: text("semantic_key").notNull().default(""),
    version: integer("version").notNull().default(1),
    depthHint: integer("depth_hint"),
    sourceMapEdgeId: text("source_map_edge_id"),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_codex_relations_project").on(table.projectId),
    index("idx_codex_relations_from").on(table.fromCodexId),
    index("idx_codex_relations_to").on(table.toCodexId),
    // non-unique: 既存 duplicate を壊さない。unique 化は後続 PR。
    index("idx_codex_relations_semantic_key").on(table.semanticKey),
  ],
);

/** Plottr 型プロットスレッド = タイムライン上の名前付き横レーン。 */
export const plotThreads = sqliteTable(
  "plot_threads",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull().default(""),
    color: text("color"),
    description: text("description"),
    // レーン縦順の fractional-index（base62、辞書順比較）
    sortOrder: text("sort_order").notNull().default("a0"),
    // 束ねレイアウトの生存スパン明示指定（NULL=最初/最後のマーカーから導出）。
    // シーン削除で onDelete:set null → override 解除（スレッド自体は残る）。
    // src-tauri migrate.rs の plot_threads とミラー。
    startNodeId: text("start_node_id").references(() => treeNodes.id, {
      onDelete: "set null",
    }),
    endNodeId: text("end_node_id").references(() => treeNodes.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
    // OCC generation. SCHEMA_VERSION 11.
    version: integer("version").notNull().default(0),
  },
  (table) => [index("idx_plot_threads_project").on(table.projectId)],
);

/** スレッドが特定シーンで踏む段階マーカー。phase_type の CHECK は SQL 側。 */
export const plotThreadSceneLinks = sqliteTable(
  "plot_thread_scene_links",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => plotThreads.id, { onDelete: "cascade" }),
    nodeId: text("node_id")
      .notNull()
      .references(() => treeNodes.id, { onDelete: "cascade" }),
    // 'introduce' | 'develop' | 'turn' | 'climax' | 'resolve'
    phaseType: text("phase_type").notNull(),
    note: text("note"),
    sortOrder: text("sort_order"),
    // OCC + semantic identity. SCHEMA_VERSION 11.
    // semantic_key = thread_id|node_id|phase_type (dup suffix allowed for legacy)
    semanticKey: text("semantic_key").notNull().default(""),
    version: integer("version").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_plot_thread_links_thread").on(table.threadId),
    index("idx_plot_thread_links_node").on(table.nodeId),
    index("idx_plot_thread_links_semantic_key").on(table.semanticKey),
  ],
);

export type PlotThread = typeof plotThreads.$inferSelect;
export type NewPlotThread = typeof plotThreads.$inferInsert;
export type PlotThreadSceneLink = typeof plotThreadSceneLinks.$inferSelect;
export type NewPlotThreadSceneLink = typeof plotThreadSceneLinks.$inferInsert;

/** マーカー段階の正準 enum と表示順序。 */
export const PLOT_PHASE_TYPES = [
  "introduce",
  "develop",
  "turn",
  "climax",
  "resolve",
] as const;
export type PlotPhaseType = (typeof PLOT_PHASE_TYPES)[number];

/** プロットスレッドの分岐 / 合流エッジ。特定シーン(at_node_id)で from→to の
 *  スレッド間を繋ぐ。kind の CHECK は SQL 側。src-tauri migrate.rs とミラー。 */
export const plotThreadBranches = sqliteTable(
  "plot_thread_branches",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fromThreadId: text("from_thread_id")
      .notNull()
      .references(() => plotThreads.id, { onDelete: "cascade" }),
    toThreadId: text("to_thread_id")
      .notNull()
      .references(() => plotThreads.id, { onDelete: "cascade" }),
    atNodeId: text("at_node_id")
      .notNull()
      .references(() => treeNodes.id, { onDelete: "cascade" }),
    // 'branch' | 'merge'
    kind: text("kind").notNull(),
    // OCC + semantic identity. SCHEMA_VERSION 11.
    // semantic_key = from|to|at_node|kind
    semanticKey: text("semantic_key").notNull().default(""),
    version: integer("version").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_plot_thread_branches_project").on(table.projectId),
    index("idx_plot_thread_branches_from").on(table.fromThreadId),
    index("idx_plot_thread_branches_to").on(table.toThreadId),
    index("idx_plot_thread_branches_semantic_key").on(table.semanticKey),
  ],
);

export type PlotThreadBranch = typeof plotThreadBranches.$inferSelect;
export type NewPlotThreadBranch = typeof plotThreadBranches.$inferInsert;

/** 分岐/合流の種別。 */
export const PLOT_BRANCH_KINDS = ["branch", "merge"] as const;
export type PlotBranchKind = (typeof PLOT_BRANCH_KINDS)[number];

// ───────── Chronicle（作中年表） ─────────
// Scene-anchored ではない独立した「出来事」。point(end_time=null)/interval 両対応。
// reading-order の plot-thread とは別概念（作中時間=fabula 軸）。
// CRUD は plot_thread_branches 同様 db_execute Drizzle 直書き（Rust コマンド無し）。
// src-tauri migrate.rs とミラー。

/** 出来事の時刻 precision の正準 enum。 */
export const EVENT_PRECISIONS = ["exact", "approx", "unknown"] as const;
export type EventPrecision = (typeof EVENT_PRECISIONS)[number];

/** 出来事の種別。birth/death は年齢計算の基準点。 */
export const EVENT_KINDS = ["generic", "birth", "death"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * 出来事の開始/終了時刻の粒度（どこまで判明しているか）。
 * none=時刻未指定 / season=季節のみ / year=年 / month=年月 / day=年月日 / time=年月日＋時分。
 * 確度(precision)＝確からしさとは独立（粒度＝判明範囲）。
 */
export const EVENT_GRANULARITIES = [
  "none",
  "season",
  "year",
  "month",
  "day",
  "time",
] as const;
export type EventGranularity = (typeof EVENT_GRANULARITIES)[number];

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    note: text("note"),
    // 出来事の詳細（リッチテキスト = ProseMirror JSON 文字列）。codexEntries.content と
    // 同 idiom。null/空 = 未入力。プレーン文字列の note とは別物（note は LLM 抽出が使う）。
    detail: text("detail"),
    // 年表 x 軸順の fractional-index（base62・辞書順比較・storyTimeOrder と同 idiom）。
    ordinal: text("ordinal").notNull().default("a0"),
    // ホームレーン（人物 codex）。null=未割当。codex 削除で set null（出来事は残す）。
    primaryCodexId: text("primary_codex_id").references(() => codexEntries.id, {
      onDelete: "set null",
    }),
    // 未割当（primaryCodexId=null）出来事の整理用サブレーン id。null=既定の未割当レーン。
    // codex 未割当のまま複数レーンへ振り分けるためのクライアント定義 id（FK なし）。
    laneGroup: text("lane_group"),
    // 出来事の場所（codex）。2か所同時チェックの基準。null=未指定。
    locationCodexId: text("location_codex_id").references(
      () => codexEntries.id,
      { onDelete: "set null" },
    ),
    // 暦ライト数値時刻（紀元からの日数）。null=ordinal のみ（連続間隔/季節は出ない）。
    startTime: integer("start_time"),
    // interval 終端（紀元からの日数）。null=point。
    endTime: integer("end_time"),
    // 時刻（24h時計の分 0..1439）。null=時刻未指定。startTime/endTime と対。
    startMinute: integer("start_minute"),
    endMinute: integer("end_minute"),
    // 開始/終了の粒度（EVENT_GRANULARITIES・CHECK は SQL 側）。
    startGranularity: text("start_granularity").notNull().default("none"),
    endGranularity: text("end_granularity").notNull().default("none"),
    // 'exact' | 'approx' | 'unknown'（CHECK は SQL 側）。日付の確度。
    precision: text("precision").notNull().default("exact"),
    // 'generic' | 'birth' | 'death'。birth は年齢計算の基準点。
    kind: text("kind").notNull().default("generic"),
    // AI 秘匿（伏線 foreshadows.secret と同 idiom・reveal アンカー方式）。
    // default false=表示。隠すのはオプトイン（年表注入の存在意義＝AI に背景を渡す）。
    secret: integer("secret", { mode: "boolean" }).notNull().default(false),
    // 読む順の開示アンカー（明示上書き専用・null=自動導出 or 恒久秘匿）。シーン削除で
    // set null → effectiveRevealSceneId が自動導出（スタンプ最小シーン）へフォールバック。
    revealSceneId: text("reveal_scene_id").references(() => treeNodes.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
    /** Aggregate optimistic-lock version for the event row and participants. */
    version: integer("version").notNull().default(0),
  },
  (table) => [
    index("idx_events_project").on(table.projectId),
    index("idx_events_ordinal").on(table.projectId, table.ordinal),
  ],
);

/** 出来事に参加する codex エンティティ（多対多）。主参加は events.primaryCodexId。 */
export const eventParticipants = sqliteTable(
  "event_participants",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    codexEntryId: text("codex_entry_id")
      .notNull()
      .references(() => codexEntries.id, { onDelete: "cascade" }),
    role: text("role"),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.codexEntryId] }),
    index("idx_event_participants_codex").on(table.codexEntryId),
  ],
);

/** scene↔event 0..N 橋（0=オフページ）。シーン/出来事いずれ削除でも CASCADE。 */
export const sceneEvents = sqliteTable(
  "scene_events",
  {
    sceneId: text("scene_id")
      .notNull()
      .references(() => treeNodes.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    incarnationToken: text("incarnation_token").notNull().default(""),
  },
  (table) => [
    primaryKey({ columns: [table.sceneId, table.eventId] }),
    index("idx_scene_events_event").on(table.eventId),
  ],
);

/** 1プロジェクト1暦（暦ライト・任意）。未設定=季節チェック無効。 */
export const projectCalendar = sqliteTable("project_calendar", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  daysPerYear: integer("days_per_year").notNull().default(360),
  // JSON: SeasonBoundary[] = [{name, startDayOfYear}]（4季想定）。
  seasonBoundaries: text("season_boundaries").notNull().default("[]"),
  // 暦の開始年ラベル（day番号0 = startYear の最初の月の1日）。
  startYear: integer("start_year").notNull().default(0),
  // JSON: MonthDef[] = [{name, days}]。'[]'=月概念なし（年内通日のみ）。
  months: text("months").notNull().default("[]"),
  // JSON: string[]（曜日名）。'[]'=曜日概念なし。週長=配列長。
  weekdayNames: text("weekday_names").notNull().default("[]"),
  // day番号0に対応する weekdayNames の index。既定0で従来の相対曜日を維持。
  weekdayStartIndex: integer("weekday_start_index").notNull().default(0),
  // JSON: LeapRule。'{"kind":"none"}'=閏年なし（年長一定）。gregorian で 4/100/400。
  leapRule: text("leap_rule").notNull().default('{"kind":"none"}'),
  // 年齢の数え方。'full'=満年齢（既定）/ 'counting'=数え年。
  ageReckoning: text("age_reckoning").notNull().default("full"),
  // JSON: EraDef[] = [{name, startYear}]（元号/年号・年粒度）。'[]'=元号なし。
  eras: text("eras").notNull().default("[]"),
  // JSON: CalendarReform | null（ユリウス→グレゴリオ改暦）。'null'=改暦なし。
  reform: text("reform").notNull().default("null"),
  // JSON: TimeZoneDef | null（時刻表示のTZラベル/オフセット・夏時間）。'null'=なし。
  timezone: text("timezone").notNull().default("null"),
  // 旧暦の節気判定 UTC オフセット分。480=中国農暦(既定) / 540=日本。節気のみ再ビン。
  lunarTzMinutes: integer("lunar_tz_minutes").notNull().default(480),
  // Calendar snapshot / editor OCC generation. Successful writes increment it.
  version: integer("version").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
});

export type ChronicleEvent = typeof events.$inferSelect;
export type NewChronicleEvent = typeof events.$inferInsert;
export type EventParticipant = typeof eventParticipants.$inferSelect;
export type SceneEvent = typeof sceneEvents.$inferSelect;
export type ProjectCalendar = typeof projectCalendar.$inferSelect;

/** 出来事間の因果エッジ（cause→effect）。効果が原因より前なら整合チェックで矛盾。 */
export const eventRelations = sqliteTable(
  "event_relations",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    causeEventId: text("cause_event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    effectEventId: text("effect_event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.causeEventId, table.effectEventId] }),
    index("idx_event_relations_project").on(table.projectId),
    index("idx_event_relations_effect").on(table.effectEventId),
  ],
);

export type EventRelation = typeof eventRelations.$inferSelect;

export const mapFrames = sqliteTable(
  "map_frames",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id")
      .notNull()
      .references(() => mapBoards.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("Frame"),
    x: real("x").notNull(),
    y: real("y").notNull(),
    width: real("width").notNull(),
    height: real("height").notNull(),
    background: text("background").notNull().default("#f5f5f5"),
    borderColor: text("border_color").notNull().default("#cccccc"),
    zIndex: integer("z_index").notNull().default(-1),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [index("idx_map_frames_board").on(table.boardId)],
);

export const lintIgnoredDiagnostics = sqliteTable(
  "lint_ignored_diagnostics",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id").notNull(),
    sceneId: text("scene_id")
      .notNull()
      .references(() => treeNodes.id, { onDelete: "cascade" }),
    textSnippet: text("text_snippet").notNull(),
    contextBefore: text("context_before").notNull(),
    contextAfter: text("context_after").notNull(),
    note: text("note"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_lint_ignored_scene").on(table.sceneId),
    index("idx_lint_ignored_rule").on(table.ruleId),
  ],
);

// Project-scoped term dictionary for `project/term-consistency`.
// variants is JSON-encoded `string[]`; the CRUD layer deduplicates and
// regex-escapes before emitting the wire payload to the Rust engine.
// severity is constrained to 'warning' | 'info' in the app layer; the
// DB enforces no such check so the column stays forward-compatible.
export const lintTermDictionary = sqliteTable(
  "lint_term_dictionary",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    preferred: text("preferred").notNull(),
    variants: text("variants").notNull(),
    severity: text("severity").notNull().default("warning"),
    note: text("note"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_lint_term_dict_preferred").on(table.preferred),
    index("idx_lint_term_dict_sort").on(table.sortOrder),
    index("idx_lint_term_dict_project").on(table.projectId),
  ],
);

// Append-only event log for self-tuning Linter behaviour. Schema is
// added in Phase 1 so Phase 2/3 writers and the eventual statistics tab
// can land without a migration. `sceneId` becomes NULL when a scene is
// deleted so the historical record survives content cleanup.
export const lintActionLog = sqliteTable(
  "lint_action_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ruleId: text("rule_id").notNull(),
    action: text("action", {
      enum: [
        "detected",
        "fixed",
        "ignored_once",
        "ignored_persistent_set",
        "ignored_persistent_unset",
        "disabled_inline",
      ],
    }).notNull(),
    sceneId: text("scene_id").references(() => treeNodes.id, {
      onDelete: "set null",
    }),
    occurredAt: integer("occurred_at").notNull(),
  },
  (table) => [
    index("idx_lint_action_log_rule").on(table.ruleId),
    index("idx_lint_action_log_occurred").on(table.occurredAt),
  ],
);

// --- Foreshadow Register ---

export const foreshadows = sqliteTable(
  "foreshadows",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    intent: text("intent"),
    notes: text("notes"),

    // Payoff anchor (inline, 1:1)
    payoffSceneId: text("payoff_scene_id").references(() => treeNodes.id, {
      onDelete: "set null",
    }),
    payoffFromPos: integer("payoff_from_pos"),
    payoffToPos: integer("payoff_to_pos"),

    // State axes
    payoffConfirmed: integer("payoff_confirmed", { mode: "boolean" })
      .notNull()
      .default(false),
    abandoned: integer("abandoned", { mode: "boolean" })
      .notNull()
      .default(false),
    secret: integer("secret", { mode: "boolean" }).notNull().default(true),

    // Phase 6: load_bearing 軸（critical / supporting / optional / null）
    loadBearing: text("load_bearing"),
    mechanism: text("mechanism"),
    version: integer("version").notNull().default(0),

    // impact-review: リンク先 Codex が変更された時刻。setup の lastEvaluatedAt より
    // 新しければ「Codex 変更により再評価が必要」として stale 判定する（null=未変更）。
    codexLinkDirtyAt: integer("codex_link_dirty_at", { mode: "timestamp_ms" }),

    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("idx_foreshadows_project").on(t.projectId),
    index("idx_foreshadows_payoff_scene").on(t.payoffSceneId),
  ],
);

export const foreshadowSetups = sqliteTable(
  "foreshadow_setups",
  {
    id: text("id").primaryKey(),
    foreshadowId: text("foreshadow_id")
      .notNull()
      .references(() => foreshadows.id, { onDelete: "cascade" }),

    // Anchor
    sceneId: text("scene_id")
      .notNull()
      .references(() => treeNodes.id, { onDelete: "cascade" }),
    fromPos: integer("from_pos").notNull(),
    toPos: integer("to_pos").notNull(),

    // Metadata
    kind: text("kind").notNull(), // 'designated_existing' | 'inserted_new' | 'rewritten'
    role: text("role").notNull().default("unspecified"),
    strength: text("strength"), // 'subtle' | 'moderate' | 'overt' | null
    aiStrength: text("ai_strength"),
    aiReasoning: text("ai_reasoning"),
    attribution: text("attribution").notNull().default("human"),
    aiRationale: text("ai_rationale"),
    lastEvaluatedAt: integer("last_evaluated_at", { mode: "timestamp_ms" }),

    isOrphan: integer("is_orphan", { mode: "boolean" })
      .notNull()
      .default(false),
    evidenceAnchorId: text("evidence_anchor_id"),
    semanticKey: text("semantic_key").notNull().default(""),

    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("idx_fs_setup_fid").on(t.foreshadowId),
    index("idx_fs_setup_scene").on(t.sceneId),
    index("idx_fs_setup_orphan").on(t.isOrphan),
    index("idx_fs_setup_semantic_key").on(t.semanticKey),
    uniqueIndex("uq_fs_setup_semantic_key").on(t.semanticKey),
  ],
);

export const foreshadowPayoffs = sqliteTable(
  "foreshadow_payoffs",
  {
    id: text("id").primaryKey(),
    foreshadowId: text("foreshadow_id")
      .notNull()
      .references(() => foreshadows.id, { onDelete: "cascade" }),
    sceneId: text("scene_id")
      .notNull()
      .references(() => treeNodes.id, { onDelete: "cascade" }),
    fromPos: integer("from_pos"),
    toPos: integer("to_pos"),
    role: text("role").notNull().default("unspecified"),
    confirmed: integer("confirmed", { mode: "boolean" })
      .notNull()
      .default(false),
    isPrimary: integer("is_primary", { mode: "boolean" })
      .notNull()
      .default(false),
    attribution: text("attribution").notNull().default("human"),
    aiRationale: text("ai_rationale"),
    isOrphan: integer("is_orphan", { mode: "boolean" })
      .notNull()
      .default(false),
    evidenceAnchorId: text("evidence_anchor_id"),
    semanticKey: text("semantic_key").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("idx_fs_payoff_fid").on(t.foreshadowId),
    index("idx_fs_payoff_scene").on(t.sceneId),
    index("idx_fs_payoff_semantic_key").on(t.semanticKey),
    uniqueIndex("uq_fs_payoff_semantic_key").on(t.semanticKey),
  ],
);

export const foreshadowSetupPayoffLinks = sqliteTable(
  "foreshadow_setup_payoff_links",
  {
    foreshadowId: text("foreshadow_id")
      .notNull()
      .references(() => foreshadows.id, { onDelete: "cascade" }),
    setupId: text("setup_id")
      .notNull()
      .references(() => foreshadowSetups.id, { onDelete: "cascade" }),
    payoffId: text("payoff_id")
      .notNull()
      .references(() => foreshadowPayoffs.id, { onDelete: "cascade" }),
    bridgeKind: text("bridge_kind").notNull().default("unspecified"),
    explanation: text("explanation"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.foreshadowId, t.setupId, t.payoffId] }),
    index("idx_fs_payoff_link_setup").on(t.setupId),
    index("idx_fs_payoff_link_payoff").on(t.payoffId),
  ],
);

export const foreshadowCodexLinks = sqliteTable(
  "foreshadow_codex_links",
  {
    foreshadowId: text("foreshadow_id")
      .notNull()
      .references(() => foreshadows.id, { onDelete: "cascade" }),
    codexEntryId: text("codex_entry_id")
      .notNull()
      .references(() => codexEntries.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.foreshadowId, t.codexEntryId] }),
    index("idx_fs_codex_codex").on(t.codexEntryId),
  ],
);

/** Beat system (Phase B) — role-aware codex mention cache per scene. */
export const sceneCodexMentions = sqliteTable(
  "scene_codex_mentions",
  {
    sceneId: text("scene_id")
      .notNull()
      .references(() => treeNodes.id, { onDelete: "cascade" }),
    codexEntryId: text("codex_entry_id")
      .notNull()
      .references(() => codexEntries.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    role: text("role").notNull().default("mentioned"),
  },
  (t) => [
    primaryKey({ columns: [t.sceneId, t.codexEntryId, t.source] }),
    index("idx_scm_codex").on(t.codexEntryId),
    index("idx_scm_scene").on(t.sceneId),
  ],
);

export const sceneBeatPovCache = sqliteTable(
  "scene_beat_pov_cache",
  {
    sceneId: text("scene_id")
      .notNull()
      .references(() => treeNodes.id, { onDelete: "cascade" }),
    povCharacterId: text("pov_character_id")
      .notNull()
      .references(() => codexEntries.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.sceneId, t.povCharacterId] }),
    index("idx_scene_beat_pov_scene").on(t.sceneId),
  ],
);

// Label system (project-scoped color tags, M:N with tree_nodes)
export const labels = sqliteTable(
  "labels",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(), // palette slot name (e.g. 'red', 'blue')
    sortOrder: real("sort_order").notNull().default(0.0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    uniqueIndex("uq_labels_project_name").on(table.projectId, table.name),
    index("idx_labels_project").on(table.projectId),
  ],
);

export const treeNodeLabels = sqliteTable(
  "tree_node_labels",
  {
    nodeId: text("node_id")
      .notNull()
      .references(() => treeNodes.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.labelId] }),
    index("idx_tree_node_labels_label").on(table.labelId),
  ],
);

// =========================================================================
// PostEffects: 書き換えずに注釈を重ねる AI パスの実行単位と成果物テーブル群。
// 詳細は docs/Grimodex_PostEffects設計書.md を参照。
// enum カラムの CHECK 制約と FTS5 仮想テーブル / partial UNIQUE は
// Rust 側 migrate.rs に直書きされる（Drizzle では表現できないため）。
// =========================================================================
export const postEffectRuns = sqliteTable(
  "post_effect_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // 'review' | 'pseudo_comment' | 'meta_structure' | 'consistency' | 'intra_scene_consistency'
    effectType: text("effect_type").notNull(),
    // 'scene' | 'folder' | 'project'
    scopeType: text("scope_type").notNull(),
    scopeTargetId: text("scope_target_id").references(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (): any => treeNodes.id,
      { onDelete: "cascade" },
    ),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash"),
    // 'running' | 'completed' | 'failed' | 'cancelled'
    status: text("status").notNull(),
    summary: text("summary"),
    errorMessage: text("error_message"),
    startedAt: text("started_at").notNull().$defaultFn(nowInstantString),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("idx_runs_project_effect").on(
      table.projectId,
      table.effectType,
      table.startedAt,
    ),
  ],
);

export const postEffectAnnotations = sqliteTable(
  "post_effect_annotations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // NULL = 将来的なユーザー手動メモ用の枠（MVP は AI 生成のみ）
    runId: text("run_id").references(() => postEffectRuns.id, {
      onDelete: "set null",
    }),
    // 'scene_range' | 'codex_entry' | 'synopsis' (MVP は scene_range のみ)
    anchorType: text("anchor_type").notNull().default("scene_range"),
    sceneId: text("scene_id").references(() => treeNodes.id, {
      onDelete: "cascade",
    }),
    // NOTE: range_start/range_end の意味論はソースによってブレる:
    // - Rust の consistency runner (post_effect.rs find_text_position) は
    //   正規化済みプレーンテキストへの byte offset を書き込む
    // - JS の saveAnnotationAnchors (syncAnnotations.ts) は PM position を書き込む
    // 表示時は text_snapshot から PM 位置を再解決すること
    // (post-effect/resolveAnnotationRange.ts)。range_* は曖昧マッチ時の近傍ヒントのみ。
    rangeStart: integer("range_start"),
    rangeEnd: integer("range_end"),
    textSnapshot: text("text_snapshot"),
    // 'review' | 'pseudo_comment' | 'consistency_anchor' | 'foreshadow_anchor' | 'theme_anchor'
    category: text("category").notNull(),
    persona: text("persona"),
    // 'info' | 'suggestion' | 'warning' | 'error'
    severity: text("severity"),
    content: text("content").notNull(),
    // 'ai' | 'user' | 'system'
    authorRole: text("author_role").notNull().default("ai"),
    parentId: text("parent_id").references(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (): any => postEffectAnnotations.id,
      { onDelete: "cascade" },
    ),
    // 'open' | 'resolved' | 'dismissed'
    status: text("status").notNull().default("open"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_pea_scene").on(table.projectId, table.sceneId, table.status),
    index("idx_pea_run").on(table.runId),
    index("idx_pea_parent").on(table.parentId),
  ],
);

export const postEffectAnnotationRelations = sqliteTable(
  "post_effect_annotation_relations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => postEffectRuns.id, {
      onDelete: "set null",
    }),
    annotationAId: text("annotation_a_id")
      .notNull()
      .references(() => postEffectAnnotations.id, { onDelete: "cascade" }),
    annotationBId: text("annotation_b_id")
      .notNull()
      .references(() => postEffectAnnotations.id, { onDelete: "cascade" }),
    // 'contradiction' | 'foreshadowing' | 'theme_echo'
    relationType: text("relation_type").notNull(),
    // 'bidirectional' | 'a_to_b' (foreshadowing は a=setup / b=payoff で a_to_b 固定)
    direction: text("direction").notNull().default("bidirectional"),
    description: text("description"),
    // 'open' | 'resolved' | 'dismissed'
    status: text("status").notNull().default("open"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_pear_a").on(table.annotationAId),
    index("idx_pear_b").on(table.annotationBId),
  ],
);

/**
 * impact-review (影響度レビュー) の差分基準。
 * Codex エントリ単位で「前回レビューを実行した時点の状態」を 1 行保持し、
 * 手動トリガ時に現在の状態と diff して「前回チェック以降の変更」を求める。
 * baseline が無い (初回) 場合は全文を変更扱いで広く判定する。
 */
export const impactReviewBaselines = sqliteTable(
  "impact_review_baselines",
  {
    // 1 codex entry につき 1 baseline
    entryId: text("entry_id")
      .primaryKey()
      .references(() => codexEntries.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // 前回 impact-review 実行時点の Codex 状態スナップショット
    // (JSON: { name, aliases, summary, content_plain, details:[{name,value}] })
    snapshotJson: text("snapshot_json").notNull(),
    // snapshot の content hash（差分有無の高速判定用）
    contentHash: text("content_hash").notNull(),
    reviewedAt: text("reviewed_at").notNull().$defaultFn(nowInstantString),
  },
  (t) => [index("idx_impact_baselines_project").on(t.projectId)],
);
export type ImpactReviewBaseline = typeof impactReviewBaselines.$inferSelect;
export type NewImpactReviewBaseline = typeof impactReviewBaselines.$inferInsert;

export const sceneLensData = sqliteTable(
  "scene_lens_data",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => postEffectRuns.id, { onDelete: "cascade" }),
    targetId: text("target_id").references(() => treeNodes.id, {
      onDelete: "cascade",
    }),
    // 'plot_structure' | 'pacing' | 'character_arc' | 'pov'
    lensType: text("lens_type").notNull(),
    metrics: text("metrics").notNull().default("{}"),
    finding: text("finding"),
    // 'info' | 'suggestion' | 'warning' | 'error'
    severity: text("severity").notNull().default("info"),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_lens_run_target").on(table.runId, table.targetId),
    index("idx_lens_target_type").on(table.targetId, table.lensType),
  ],
);

// =========================================================================
// Narrative Extraction: Run / Task / Proposal / Apply persistence.
// Physical DDL is mirrored in migrate.rs (SCHEMA_VERSION 6). Column shapes
// match grimodex-db ensure_test_schema plus Apply／Provenance tables.
// =========================================================================
export const narrativeExtractionRuns = sqliteTable(
  "narrative_extraction_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    surfacePathId: text("surface_path_id").notNull(),
    scopeJson: text("scope_json").notNull(),
    specJson: text("spec_json").notNull(),
    specDigest: text("spec_digest").notNull(),
    snapshotDigest: text("snapshot_digest"),
    catalogDigest: text("catalog_digest"),
    registryDigest: text("registry_digest"),
    status: text("status").notNull(),
    coverageJson: text("coverage_json").notNull().default("{}"),
    outcomeSummaryJson: text("outcome_summary_json"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    version: integer("version").notNull().default(0),
  },
);

export const narrativeExtractionTasks = sqliteTable(
  "narrative_extraction_tasks",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    taskKind: text("task_kind").notNull(),
    status: text("status").notNull(),
    inputJson: text("input_json").notNull().default("{}"),
    outputJson: text("output_json"),
    priority: integer("priority").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    heartbeatAt: text("heartbeat_at"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    version: integer("version").notNull().default(0),
  },
);

export const narrativeExtractionTaskEdges = sqliteTable(
  "narrative_extraction_task_edges",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    fromTaskId: text("from_task_id").notNull(),
    toTaskId: text("to_task_id").notNull(),
    edgeKind: text("edge_kind").notNull().default("depends_on"),
    createdAt: text("created_at").notNull(),
  },
);

export const narrativeExtractionAttempts = sqliteTable(
  "narrative_extraction_attempts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    errorMessage: text("error_message"),
    outputJson: text("output_json"),
  },
);

export const narrativeExtractionArtifacts = sqliteTable(
  "narrative_extraction_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    taskId: text("task_id"),
    attemptId: text("attempt_id"),
    artifactKind: text("artifact_kind").notNull(),
    payloadStorage: text("payload_storage").notNull().default("inline-json"),
    payloadJson: text("payload_json"),
    payloadRef: text("payload_ref"),
    payloadDigest: text("payload_digest"),
    createdAt: text("created_at").notNull(),
  },
);

export const narrativeProposalSets = sqliteTable("narrative_proposal_sets", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  setKind: text("set_kind").notNull(),
  status: text("status").notNull().default("draft"),
  summaryJson: text("summary_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  version: integer("version").notNull().default(0),
});

export const narrativeProposals = sqliteTable("narrative_proposals", {
  id: text("id").primaryKey(),
  proposalSetId: text("proposal_set_id").notNull(),
  proposalKey: text("proposal_key").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("unreviewed"),
  payloadJson: text("payload_json").notNull(),
  currentRevisionId: text("current_revision_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const narrativeProposalRevisions = sqliteTable(
  "narrative_proposal_revisions",
  {
    id: text("id").primaryKey(),
    proposalId: text("proposal_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    payloadJson: text("payload_json").notNull(),
    // SCHEMA_VERSION 15: sealed plan fragment for Prepared Commit.
    planFragmentJson: text("plan_fragment_json"),
    planFragmentDigest: text("plan_fragment_digest"),
    // SCHEMA_VERSION 17: immutable Proposal Revision Envelope binding.
    originKind: text("origin_kind").notNull().default("legacy-unbound"),
    reconciliationEnvelopeJson: text("reconciliation_envelope_json"),
    reconciliationEnvelopeDigest: text("reconciliation_envelope_digest"),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
);

export const narrativeRevisionSourceBasis = sqliteTable(
  "narrative_revision_source_basis",
  {
    revisionId: text("revision_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceKey: text("source_key").notNull(),
    revisionToken: text("revision_token").notNull(),
    observedAt: text("observed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.revisionId, table.ordinal] }),
    uniqueIndex("uq_narrative_revision_source_basis_key").on(
      table.revisionId,
      table.sourceKey,
    ),
  ],
);

export const narrativeProposalDecisions = sqliteTable(
  "narrative_proposal_decisions",
  {
    id: text("id").primaryKey(),
    proposalId: text("proposal_id").notNull(),
    revisionId: text("revision_id").notNull(),
    decision: text("decision").notNull(),
    decisionJson: text("decision_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
);

export const narrativeApplyCommits = sqliteTable("narrative_apply_commits", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  runId: text("run_id"),
  proposalSetId: text("proposal_set_id"),
  requestId: text("request_id").notNull(),
  planDigest: text("plan_digest").notNull(),
  status: text("status").notNull(),
  receiptJson: text("receipt_json"),
  errorMessage: text("error_message"),
  // SCHEMA_VERSION 15: immutable Prepared Commit seal.
  preparedPlanJson: text("prepared_plan_json"),
  preparedPolicyVersion: integer("prepared_policy_version"),
  preparedAt: text("prepared_at"),
  authorityDigest: text("authority_digest"),
  sessionId: text("session_id"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
  version: integer("version").notNull().default(0),
});

export const narrativeApplyOperations = sqliteTable(
  "narrative_apply_operations",
  {
    id: text("id").primaryKey(),
    commitId: text("commit_id").notNull(),
    operationIndex: integer("operation_index").notNull(),
    operationKind: text("operation_kind").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    resultEntityKind: text("result_entity_kind"),
    resultEntityId: text("result_entity_id"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
  },
);

export const narrativeProposalApplications = sqliteTable(
  "narrative_proposal_applications",
  {
    id: text("id").primaryKey(),
    commitId: text("commit_id").notNull(),
    proposalId: text("proposal_id").notNull(),
    revisionId: text("revision_id").notNull(),
    appliedEntityKind: text("applied_entity_kind").notNull(),
    appliedEntityId: text("applied_entity_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
);

export const narrativeCommitJournals = sqliteTable(
  "narrative_commit_journals",
  {
    id: text("id").primaryKey(),
    commitId: text("commit_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    createdAt: text("created_at").notNull(),
  },
);

// =========================================================================
// Import Sessions: durable adapter packages, source identity, and commits.
// Physical DDL is mirrored in migrate.rs (SCHEMA_VERSION 13).
// =========================================================================
export const importSessions = sqliteTable(
  "import_sessions",
  {
    id: text("id").primaryKey(),
    state: text("state").notNull(),
    adapterId: text("adapter_id"),
    adapterVersion: text("adapter_version"),
    targetJson: text("target_json").notNull(),
    sourcePackageDigest: text("source_package_digest"),
    sourcePackageRef: text("source_package_ref"),
    extractionRunIdsJson: text("extraction_run_ids_json")
      .notNull()
      .default("[]"),
    proposalSetIdsJson: text("proposal_set_ids_json").notNull().default("[]"),
    errorMessage: text("error_message"),
    version: integer("version").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_import_sessions_state").on(table.state, table.updatedAt),
  ],
);

export const importSourcePackages = sqliteTable(
  "import_source_packages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => importSessions.id, { onDelete: "cascade" }),
    digest: text("digest").notNull(),
    adapterId: text("adapter_id").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    packageJson: text("package_json").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_import_source_packages_session").on(
      table.sessionId,
      table.createdAt,
    ),
  ],
);

export const importSourceMappings = sqliteTable(
  "import_source_mappings",
  {
    id: text("id").primaryKey(),
    sourceSetId: text("source_set_id").notNull(),
    sourceObjectKey: text("source_object_key").notNull(),
    sourceObjectKind: text("source_object_kind").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    sourceRecordDigest: text("source_record_digest").notNull(),
    targetStateDigest: text("target_state_digest").notNull(),
    adapterId: text("adapter_id").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    firstImportSessionId: text("first_import_session_id").notNull(),
    lastImportSessionId: text("last_import_session_id").notNull(),
    status: text("status").notNull().default("active"),
    version: integer("version").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_import_source_mappings_source").on(
      table.sourceSetId,
      table.sourceObjectKey,
    ),
    index("idx_import_source_mappings_target").on(
      table.targetKind,
      table.targetId,
    ),
  ],
);

export const importSourceBaselines = sqliteTable("import_source_baselines", {
  mappingId: text("mapping_id")
    .primaryKey()
    .references(() => importSourceMappings.id, { onDelete: "cascade" }),
  sourceDigest: text("source_digest").notNull(),
  targetDigest: text("target_digest").notNull(),
  normalizedBodyDigest: text("normalized_body_digest"),
  targetVersion: integer("target_version"),
  adapterVersion: text("adapter_version").notNull(),
  normalizerVersion: text("normalizer_version").notNull(),
  committedAt: text("committed_at").notNull().$defaultFn(nowInstantString),
});

export const importCommits = sqliteTable(
  "import_commits",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    requestId: text("request_id").notNull(),
    planDigest: text("plan_digest").notNull(),
    projectId: text("project_id"),
    status: text("status").notNull(),
    receiptJson: text("receipt_json"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    uniqueIndex("sqlite_autoindex_import_commits_1").on(table.requestId),
    index("idx_import_commits_session").on(table.sessionId, table.createdAt),
  ],
);

export const importEvidenceBindings = sqliteTable(
  "import_evidence_bindings",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    evidenceAnchorId: text("evidence_anchor_id").notNull(),
    sourceDocumentKey: text("source_document_key").notNull(),
    targetSceneId: text("target_scene_id").notNull(),
    sourceDocumentDigest: text("source_document_digest").notNull(),
    committedStorageDigest: text("committed_storage_digest").notNull(),
    projectionStatus: text("projection_status").notNull(),
    committedAt: text("committed_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_import_evidence_bindings_session").on(
      table.sessionId,
      table.targetSceneId,
    ),
  ],
);

// =========================================================================
// Import Captures: portable native inventory, digest registry, and decoder
// outputs. Physical DDL is mirrored in migrate.rs (SCHEMA_VERSION 14).
// =========================================================================
export const importCaptures = sqliteTable(
  "import_captures",
  {
    id: text("id").primaryKey(),
    state: text("state").notNull(),
    sourceKind: text("source_kind").notNull(),
    sealedDigest: text("sealed_digest"),
    budgetJson: text("budget_json").notNull(),
    version: integer("version").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_import_captures_state").on(table.state, table.updatedAt),
  ],
);

export const importCaptureEntries = sqliteTable(
  "import_capture_entries",
  {
    id: text("id").primaryKey(),
    captureId: text("capture_id")
      .notNull()
      .references(() => importCaptures.id, { onDelete: "cascade" }),
    resourceKey: text("resource_key").notNull(),
    parentResourceKey: text("parent_resource_key"),
    relativePath: text("relative_path").notNull(),
    kind: text("kind").notNull(),
    byteLength: integer("byte_length").notNull(),
    extension: text("extension"),
    captureStatus: text("capture_status").notNull(),
    rawDigest: text("raw_digest"),
    blobRef: text("blob_ref"),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_import_capture_entries_capture").on(
      table.captureId,
      table.captureStatus,
      table.relativePath,
    ),
  ],
);

export const importCaptureBlobs = sqliteTable("import_capture_blobs", {
  digest: text("digest").primaryKey(),
  byteLength: integer("byte_length").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
});

export const importDecodedResources = sqliteTable(
  "import_decoded_resources",
  {
    id: text("id").primaryKey(),
    captureId: text("capture_id")
      .notNull()
      .references(() => importCaptures.id, { onDelete: "cascade" }),
    resourceKey: text("resource_key").notNull(),
    decoderId: text("decoder_id").notNull(),
    decoderVersion: text("decoder_version").notNull(),
    kind: text("kind").notNull(),
    digest: text("digest").notNull(),
    decodedJson: text("decoded_json").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_import_decoded_resources_capture").on(
      table.captureId,
      table.resourceKey,
    ),
  ],
);

export const genericExtractionSchemas = sqliteTable(
  "generic_extraction_schemas",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    digest: text("digest").notNull(),
    schemaJson: text("schema_json").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    uniqueIndex("sqlite_autoindex_generic_extraction_schemas_1").on(
      table.id,
      table.revision,
    ),
    index("idx_generic_extraction_schemas_digest").on(table.digest),
  ],
);

/** Temporal Constraint Graph nodes (SCHEMA_VERSION 10). */
export const narrativeTemporalNodes = sqliteTable(
  "narrative_temporal_nodes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    timelineKind: text("timeline_kind", {
      enum: ["primary", "alternate", "embedded-fiction", "hypothetical"],
    })
      .notNull()
      .default("primary"),
    timelineKey: text("timeline_key"),
    subjectKind: text("subject_kind", {
      enum: [
        "scene",
        "event",
        "state-boundary",
        "phase-boundary",
        "named-period",
      ],
    }).notNull(),
    subjectJson: text("subject_json").notNull(),
    semanticKey: text("semantic_key").notNull(),
    shape: text("shape", {
      enum: ["point", "interval", "unknown"],
    })
      .notNull()
      .default("unknown"),
    fingerprint: text("fingerprint").notNull(),
    version: integer("version").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    uniqueIndex("uq_narrative_temporal_nodes_semantic_key").on(
      table.projectId,
      table.semanticKey,
    ),
    index("idx_narrative_temporal_nodes_project").on(table.projectId),
  ],
);

export const narrativeTemporalConstraints = sqliteTable(
  "narrative_temporal_constraints",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: [
        "absolute-window",
        "relative-offset",
        "interval-relation",
        "duration",
        "symbolic",
      ],
    }).notNull(),
    authority: text("authority", {
      enum: [
        "user-metadata",
        "user-confirmed",
        "explicit-story-text",
        "existing-domain-relation",
        "deterministic-derived",
        "model-inferred",
        "projection-derived",
      ],
    }).notNull(),
    strictness: text("strictness", {
      enum: ["hard", "soft"],
    }).notNull(),
    semanticKey: text("semantic_key").notNull(),
    sourceIdsJson: text("source_ids_json").notNull().default("[]"),
    fingerprint: text("fingerprint").notNull(),
    payloadJson: text("payload_json").notNull(),
    version: integer("version").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    uniqueIndex("uq_narrative_temporal_constraints_semantic_key").on(
      table.projectId,
      table.semanticKey,
    ),
    index("idx_narrative_temporal_constraints_project").on(
      table.projectId,
      table.kind,
    ),
  ],
);

export const narrativeTemporalProjections = sqliteTable(
  "narrative_temporal_projections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    targetKind: text("target_kind", {
      enum: ["scene-time", "event-time", "scene-story-order"],
    }).notNull(),
    targetId: text("target_id").notNull(),
    constraintSetDigest: text("constraint_set_digest").notNull(),
    solverVersion: text("solver_version").notNull(),
    calendarDigest: text("calendar_digest"),
    projectedValueDigest: text("projected_value_digest").notNull(),
    targetResultVersion: integer("target_result_version").notNull(),
    applicationId: text("application_id").notNull(),
    status: text("status", {
      enum: ["current", "invalidated", "undone"],
    })
      .notNull()
      .default("current"),
    version: integer("version").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    uniqueIndex("uq_narrative_temporal_projections_target").on(
      table.projectId,
      table.targetKind,
      table.targetId,
    ),
  ],
);

// Trash bin: holds deleted text fragments (Phase 1) and structure items (Phase 4-5).
// payload / preview_meta は素の TEXT で JSON.stringify を保持（aiReasoning と同流儀）。
export const trashItems = sqliteTable(
  "trash_items",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // "text-fragment" | "structure-item"
    subKind: text("sub_kind").notNull(), // "text-fragment" / "scene" / "codex-entry" / ...
    originSceneId: text("origin_scene_id").references(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (): any => treeNodes.id,
      { onDelete: "cascade" },
    ),
    originCodexId: text("origin_codex_id").references(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (): any => codexEntries.id,
      { onDelete: "cascade" },
    ),
    previewText: text("preview_text").notNull(),
    previewMeta: text("preview_meta"), // JSON string
    payload: text("payload").notNull(), // JSON string
    charCount: integer("char_count").notNull(),
    isInteresting: integer("is_interesting").notNull().default(0),
    deletedAt: text("deleted_at").notNull(),
  },
  (table) => [
    index("idx_trash_project_deleted").on(table.projectId, table.deletedAt),
    index("idx_trash_project_kind_deleted").on(
      table.projectId,
      table.kind,
      table.deletedAt,
    ),
  ],
);

// --- Semantic Search (本文セマンティック検索) ---
// 詳細設計: temp/semantic-prose-search-context.md。
// MVP は ruri-v3-30m ONNX を Rust 側で推論し、L2 正規化済み f32 配列を
// `embedding` BLOB に little-endian で詰める。検索は Rust 側で総当たりコサイン。
// マイグレーション規約 (CLAUDE.md): drizzle-kit migration は生成しない。
export const sceneChunks = sqliteTable(
  "scene_chunks",
  {
    id: text("id").primaryKey(),
    sceneId: text("scene_id")
      .notNull()
      .references(() => treeNodes.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    text: text("text").notNull(),
    // Unicode scalar index in the scene's normalized plain text (NOT byte index, NOT UTF-16 code units).
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    // 0.0〜1.0: チャンクに占める会話文の文字数比率。description_mode 減点に使う。
    dialogueRatio: real("dialogue_ratio").notNull().default(0),
    // f32 配列 (little-endian), L2 正規化済み。embedding_dim と長さで整合を取る。
    embedding: blob("embedding", { mode: "buffer" }).notNull(),
    embeddingDim: integer("embedding_dim").notNull(),
    // 例: "cl-nagoya/ruri-v3-30m@<revision>/model_int8.onnx/prefix-v1"。
    modelId: text("model_id").notNull(),
    // ProseMirror JSON / 正規化済み plain text から安定的に算出。非同期 job race 回避用。
    contentHash: text("content_hash").notNull(),
    // 例: "semantic-prose-chunker-v1"。チャンク分割仕様変更で stale 判定。
    chunkerVersion: text("chunker_version").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("idx_scene_chunks_scene").on(t.sceneId),
    index("idx_scene_chunks_model").on(t.modelId),
    uniqueIndex("uq_scene_chunks_scene_index").on(t.sceneId, t.chunkIndex),
  ],
);

// Codex セマンティック索引 (stage 3): 1 エントリ = 1 embedding 行。
// Codex 本文は短いのでチャンク分割せず、PK=entry_id でエントリ1件1ベクトルを担保。
// migrate.rs の codex_chunks をそのまま鏡写しにする (列名/型/制約を一致させること)。
export const codexChunks = sqliteTable(
  "codex_chunks",
  {
    entryId: text("entry_id")
      .primaryKey()
      .references(() => codexEntries.id, { onDelete: "cascade" }),
    entryName: text("entry_name").notNull(),
    entryType: text("entry_type").notNull(),
    text: text("text").notNull(),
    // f32 配列 (little-endian), L2 正規化済み。embedding_dim と長さで整合を取る。
    embedding: blob("embedding", { mode: "buffer" }).notNull(),
    embeddingDim: integer("embedding_dim").notNull(),
    modelId: text("model_id").notNull(),
    contentHash: text("content_hash").notNull(),
    chunkerVersion: text("chunker_version").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("idx_codex_chunks_model").on(t.modelId)],
);

// Read-only renderer mirrors for semantic indexes otherwise owned by Rust.
// Audit export selects every model-input/index-metadata column but deliberately
// omits `embedding`, which the sqlite proxy cannot round-trip faithfully.
export const eventChunks = sqliteTable(
  "event_chunks",
  {
    eventId: text("event_id")
      .primaryKey()
      .references(() => events.id, { onDelete: "cascade" }),
    eventTitle: text("event_title").notNull(),
    eventKind: text("event_kind").notNull(),
    text: text("text").notNull(),
    embedding: blob("embedding", { mode: "buffer" }).notNull(),
    embeddingDim: integer("embedding_dim").notNull(),
    modelId: text("model_id").notNull(),
    contentHash: text("content_hash").notNull(),
    chunkerVersion: text("chunker_version").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_event_chunks_model").on(table.modelId)],
);

export const chatMessageChunks = sqliteTable(
  "chat_message_chunks",
  {
    messageId: text("message_id")
      .primaryKey()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    projectId: text("project_id").notNull(),
    role: text("role").notNull(),
    text: text("text").notNull(),
    insertedToEditor: integer("inserted_to_editor").notNull().default(0),
    extractedCount: integer("extracted_count").notNull().default(0),
    embedding: blob("embedding", { mode: "buffer" }).notNull(),
    embeddingDim: integer("embedding_dim").notNull(),
    modelId: text("model_id").notNull(),
    contentHash: text("content_hash").notNull(),
    chunkerVersion: text("chunker_version").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_chat_message_chunks_project").on(table.projectId),
    index("idx_chat_message_chunks_model").on(table.modelId),
    index("idx_chat_message_chunks_session").on(table.sessionId),
  ],
);

/**
 * 執筆タイムラプス (Timelapse) — append-only change event log.
 *
 * Each event carries an opaque JSON payload (e.g. PM `tr.steps`, store action
 * before/after) plus a sha256 chain that lets replay verify "this log itself
 * was not retroactively forged". See plan §2 (change-events).
 *
 * Notes:
 * - `payload` is text (canonical JSON). The plan calls for msgpack; we stay
 *   on JSON to avoid a new dep until the size/perf data justifies the swap.
 * - `prevHash` / `hash` are sha256 raw bytes (32B each).
 * - `(projectId, sequence)` is monotone within a project; `sessionId` only
 *   distinguishes contiguous runs for replay-snapshotting heuristics.
 */
export const changeEvents = sqliteTable(
  "change_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventUid: text("event_uid"),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sceneId: text("scene_id").references(() => treeNodes.id, {
      onDelete: "set null",
    }),
    domain: text("domain").notNull(), // 'editor'|'codex'|'snippet'|'grid'|'map'|'synopsis'|'intent'|'beat'|'chat'|'layout'|'prose'
    opType: text("op_type").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    payload: text("payload").notNull(),
    sessionId: text("session_id").notNull(),
    sequence: integer("sequence").notNull(),
    timestamp: integer("timestamp").notNull(),
    // sha256 hashes stored as hex TEXT. The drizzle sqlite-proxy cannot
    // round-trip BLOBs (Rust returns a "[blob N bytes]" placeholder on read,
    // and Buffer is undefined in the webview); hex avoids both. The DB column
    // keeps BLOB affinity, which stores TEXT values verbatim.
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [
    index("idx_change_events_project_ts").on(t.projectId, t.timestamp),
    index("idx_change_events_scene_ts").on(t.sceneId, t.timestamp),
    uniqueIndex("uq_change_events_project_seq").on(t.projectId, t.sequence),
    uniqueIndex("uq_change_events_project_uid").on(t.projectId, t.eventUid),
  ],
);

/**
 * Forward-only complete AI-use audit ledger, hash-chained independently for
 * each project and for workspace-scoped executions that have no project yet.
 *
 * Rows are appended exclusively through the typed native/browser audit
 * command. Project/scene/message identifiers are deliberately not foreign
 * keys: deleting or restoring mutable content cannot erase the execution
 * history, and a durable Browser journal can be replayed before its project
 * snapshot exists. Exact legacy requests are not backfilled.
 */
export const aiAuditEvents = sqliteTable(
  "ai_audit_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scopeId: text("scope_id").notNull(),
    projectId: text("project_id"),
    sequence: integer("sequence").notNull(),
    eventId: text("event_id").notNull(),
    executionId: text("execution_id").notNull(),
    operationId: text("operation_id").notNull(),
    parentExecutionId: text("parent_execution_id"),
    pathId: text("path_id").notNull(),
    eventType: text("event_type").notNull(),
    /** Client-observed occurrence time; sequence remains the order authority. */
    timestamp: integer("timestamp").notNull(),
    /** Native/browser ledger clock captured during the durable append. */
    recordedAt: integer("recorded_at").notNull(),
    payload: text("payload").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [
    uniqueIndex("uq_ai_audit_scope_seq").on(t.scopeId, t.sequence),
    uniqueIndex("uq_ai_audit_scope_event").on(t.scopeId, t.eventId),
    index("idx_ai_audit_scope_execution").on(
      t.scopeId,
      t.executionId,
      t.sequence,
    ),
    index("idx_ai_audit_scope_execution_event_type").on(
      t.scopeId,
      t.executionId,
      t.eventType,
    ),
    index("idx_ai_audit_scope_operation").on(
      t.scopeId,
      t.operationId,
      t.sequence,
    ),
    index("idx_ai_audit_scope_timestamp").on(
      t.scopeId,
      t.timestamp,
      t.sequence,
    ),
  ],
);

/**
 * 執筆タイムラプス — periodic state snapshots that anchor replay.
 *
 * The replay engine seeks by jumping to the nearest snapshot then applying
 * forward events. Snapshots are recorded per (projectId, domain, entityId)
 * roughly every 1000 events or 1 hour; see plan §6.
 */
export const stateSnapshots = sqliteTable(
  "state_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    // Sequence anchor: this snapshot represents the state AFTER applying
    // change_events with sequence <= anchorSequence.
    anchorSequence: integer("anchor_sequence").notNull(),
    anchorTimestamp: integer("anchor_timestamp").notNull(),
    /**
     * Serialized snapshot stored as TEXT (the drizzle sqlite-proxy can't
     * round-trip BLOBs). v1 stores plain JSON (`encoding: 'json'`); the column
     * keeps BLOB affinity which holds TEXT verbatim.
     */
    payload: text("payload").notNull(),
    encoding: text("encoding").notNull().default("json"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_state_snap_project_seq").on(t.projectId, t.anchorSequence),
    index("idx_state_snap_domain_seq").on(
      t.projectId,
      t.domain,
      t.anchorSequence,
    ),
  ],
);

/**
 * Read-only renderer mirror of successful tracked mutations. The write path is
 * native and appends a row only in the same successful transaction as the
 * entity mutation and its change event.
 */
export const undoJournal = sqliteTable(
  "undo_journal",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    surface: text("surface").notNull(),
    entityKind: text("entity_kind").notNull(),
    entityId: text("entity_id").notNull(),
    opKind: text("op_kind").notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    baseVersion: integer("base_version").notNull(),
    resultVersion: integer("result_version").notNull(),
    changeEventUid: text("change_event_uid"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_undo_journal_project_entity").on(
      table.projectId,
      table.entityKind,
      table.entityId,
    ),
  ],
);

/** AI prose staging — accept/reject body writes (Phase 5). */
export const proseStaging = sqliteTable(
  "prose_staging",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sceneId: text("scene_id")
      .notNull()
      .references(() => treeNodes.id, { onDelete: "cascade" }),
    proposedContent: text("proposed_content").notNull(),
    baseVersion: integer("base_version").notNull(),
    status: text("status").notNull().default("proposed"),
    sourceSurface: text("source_surface").notNull(),
    sourceSessionId: text("source_session_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_prose_staging_project_scene").on(
      t.projectId,
      t.sceneId,
      t.status,
    ),
  ],
);

// ⑦ AI運用ツール群: プロンプト再利用ライブラリ（per-project）。
// 既存の `snippets`（物語知識の抽出）とは別概念で、ユーザーが保存する
// 再利用可能なプロンプト/指示テンプレート。チャット入力に挿し込んで使う。
// v1 はパラメータ `{{...}}` 置換なしのプレーンテキスト。
export const promptTemplates = sqliteTable(
  "prompt_templates",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("Untitled"),
    content: text("content").notNull().default(""),
    usageCount: integer("usage_count").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(nowInstantString),
    updatedAt: text("updated_at").notNull().$defaultFn(nowInstantString),
  },
  (table) => [
    index("idx_prompt_templates_project").on(table.projectId, table.createdAt),
  ],
);

// Type exports
export type AuthorshipSpan = typeof authorshipSpans.$inferSelect;
export type NewAuthorshipSpan = typeof authorshipSpans.$inferInsert;
export type GenerationLog = typeof generationLogs.$inferSelect;
export type NewGenerationLog = typeof generationLogs.$inferInsert;
export type CodexType = typeof codexTypes.$inferSelect;
export type NewCodexType = typeof codexTypes.$inferInsert;
export type CodexTag = typeof codexTags.$inferSelect;
export type NewCodexTag = typeof codexTags.$inferInsert;
export type CodexDetailDefinition = typeof codexDetailDefinitions.$inferSelect;
export type NewCodexDetailDefinition =
  typeof codexDetailDefinitions.$inferInsert;
export type CodexDetailSemanticBinding =
  typeof codexDetailSemanticBindings.$inferSelect;
export type NewCodexDetailSemanticBinding =
  typeof codexDetailSemanticBindings.$inferInsert;
export type CodexDetailValue = typeof codexDetailValues.$inferSelect;
export type NewCodexDetailValue = typeof codexDetailValues.$inferInsert;
export type CodexContextMode = "always" | "mentioned" | "suppress" | "hidden";
export type ContentVersion = typeof contentVersions.$inferSelect;
export type NewContentVersion = typeof contentVersions.$inferInsert;
export type ProjectSnapshot = typeof projectSnapshots.$inferSelect;
export type NewProjectSnapshot = typeof projectSnapshots.$inferInsert;
export type ProjectSnapshotTreeNode =
  typeof projectSnapshotTreeNodes.$inferSelect;
export type NewProjectSnapshotTreeNode =
  typeof projectSnapshotTreeNodes.$inferInsert;
export type ProjectSnapshotCodexEntry =
  typeof projectSnapshotCodexEntries.$inferSelect;
export type NewProjectSnapshotCodexEntry =
  typeof projectSnapshotCodexEntries.$inferInsert;
export type ProjectSnapshotSnippet =
  typeof projectSnapshotSnippets.$inferSelect;
export type NewProjectSnapshotSnippet =
  typeof projectSnapshotSnippets.$inferInsert;
export type ProjectSnapshotAux = typeof projectSnapshotAux.$inferSelect;
export type NewProjectSnapshotAux = typeof projectSnapshotAux.$inferInsert;
export type PromptTemplate = typeof promptTemplates.$inferSelect;
export type NewPromptTemplate = typeof promptTemplates.$inferInsert;
export type CodexEntryPhase = typeof codexEntryPhases.$inferSelect;
export type NewCodexEntryPhase = typeof codexEntryPhases.$inferInsert;
export type CodexPhaseDetailOverride =
  typeof codexPhaseDetailOverrides.$inferSelect;
export type NewCodexPhaseDetailOverride =
  typeof codexPhaseDetailOverrides.$inferInsert;

export type MapBoard = typeof mapBoards.$inferSelect;
export type NewMapBoard = typeof mapBoards.$inferInsert;
export type MapNodePosition = typeof mapNodePositions.$inferSelect;
export type NewMapNodePosition = typeof mapNodePositions.$inferInsert;
export type MapEdge = typeof mapEdges.$inferSelect;
export type NewMapEdge = typeof mapEdges.$inferInsert;
export type MapFrame = typeof mapFrames.$inferSelect;
export type NewMapFrame = typeof mapFrames.$inferInsert;
export type MapSticky = typeof mapStickies.$inferSelect;
export type NewMapSticky = typeof mapStickies.$inferInsert;
export type EditorStickyRow = typeof editorStickies.$inferSelect;
export type NewEditorStickyRow = typeof editorStickies.$inferInsert;
export type MapAiBranch = typeof mapAiBranches.$inferSelect;
export type NewMapAiBranch = typeof mapAiBranches.$inferInsert;

export type LintIgnoredDiagnostic = typeof lintIgnoredDiagnostics.$inferSelect;
export type NewLintIgnoredDiagnostic =
  typeof lintIgnoredDiagnostics.$inferInsert;

export type LintTermDictionaryRow = typeof lintTermDictionary.$inferSelect;
export type NewLintTermDictionaryRow = typeof lintTermDictionary.$inferInsert;

export type Foreshadow = typeof foreshadows.$inferSelect;
export type NewForeshadow = typeof foreshadows.$inferInsert;
export type ForeshadowSetup = typeof foreshadowSetups.$inferSelect;
export type NewForeshadowSetup = typeof foreshadowSetups.$inferInsert;
export type ForeshadowPayoff = typeof foreshadowPayoffs.$inferSelect;
export type NewForeshadowPayoff = typeof foreshadowPayoffs.$inferInsert;
export type ForeshadowSetupPayoffLink =
  typeof foreshadowSetupPayoffLinks.$inferSelect;
export type NewForeshadowSetupPayoffLink =
  typeof foreshadowSetupPayoffLinks.$inferInsert;
export type ForeshadowCodexLink = typeof foreshadowCodexLinks.$inferSelect;
export type NewForeshadowCodexLink = typeof foreshadowCodexLinks.$inferInsert;

export type SceneCodexMention = typeof sceneCodexMentions.$inferSelect;
export type NewSceneCodexMention = typeof sceneCodexMentions.$inferInsert;

export type SceneBeatPovCache = typeof sceneBeatPovCache.$inferSelect;
export type NewSceneBeatPovCache = typeof sceneBeatPovCache.$inferInsert;

export type Label = typeof labels.$inferSelect;
export type NewLabel = typeof labels.$inferInsert;

export type TrashItem = typeof trashItems.$inferSelect;
export type NewTrashItem = typeof trashItems.$inferInsert;

export type PostEffectRun = typeof postEffectRuns.$inferSelect;
export type NewPostEffectRun = typeof postEffectRuns.$inferInsert;
export type PostEffectAnnotation = typeof postEffectAnnotations.$inferSelect;
export type NewPostEffectAnnotation = typeof postEffectAnnotations.$inferInsert;
export type PostEffectAnnotationRelation =
  typeof postEffectAnnotationRelations.$inferSelect;
export type NewPostEffectAnnotationRelation =
  typeof postEffectAnnotationRelations.$inferInsert;
export type SceneLensData = typeof sceneLensData.$inferSelect;
export type NewSceneLensData = typeof sceneLensData.$inferInsert;

export type NarrativeExtractionRun =
  typeof narrativeExtractionRuns.$inferSelect;
export type NewNarrativeExtractionRun =
  typeof narrativeExtractionRuns.$inferInsert;
export type NarrativeExtractionTask =
  typeof narrativeExtractionTasks.$inferSelect;
export type NewNarrativeExtractionTask =
  typeof narrativeExtractionTasks.$inferInsert;
export type NarrativeExtractionTaskEdge =
  typeof narrativeExtractionTaskEdges.$inferSelect;
export type NewNarrativeExtractionTaskEdge =
  typeof narrativeExtractionTaskEdges.$inferInsert;
export type NarrativeExtractionAttempt =
  typeof narrativeExtractionAttempts.$inferSelect;
export type NewNarrativeExtractionAttempt =
  typeof narrativeExtractionAttempts.$inferInsert;
export type NarrativeExtractionArtifact =
  typeof narrativeExtractionArtifacts.$inferSelect;
export type NewNarrativeExtractionArtifact =
  typeof narrativeExtractionArtifacts.$inferInsert;
export type NarrativeProposalSet = typeof narrativeProposalSets.$inferSelect;
export type NewNarrativeProposalSet = typeof narrativeProposalSets.$inferInsert;
export type NarrativeProposal = typeof narrativeProposals.$inferSelect;
export type NewNarrativeProposal = typeof narrativeProposals.$inferInsert;
export type NarrativeProposalRevision =
  typeof narrativeProposalRevisions.$inferSelect;
export type NewNarrativeProposalRevision =
  typeof narrativeProposalRevisions.$inferInsert;
export type NarrativeProposalDecision =
  typeof narrativeProposalDecisions.$inferSelect;
export type NewNarrativeProposalDecision =
  typeof narrativeProposalDecisions.$inferInsert;
export type NarrativeApplyCommit = typeof narrativeApplyCommits.$inferSelect;
export type NewNarrativeApplyCommit = typeof narrativeApplyCommits.$inferInsert;
export type NarrativeApplyOperation =
  typeof narrativeApplyOperations.$inferSelect;
export type NewNarrativeApplyOperation =
  typeof narrativeApplyOperations.$inferInsert;
export type NarrativeProposalApplication =
  typeof narrativeProposalApplications.$inferSelect;
export type NewNarrativeProposalApplication =
  typeof narrativeProposalApplications.$inferInsert;
export type NarrativeCommitJournal =
  typeof narrativeCommitJournals.$inferSelect;
export type NewNarrativeCommitJournal =
  typeof narrativeCommitJournals.$inferInsert;

export type SceneChunk = typeof sceneChunks.$inferSelect;
export type NewSceneChunk = typeof sceneChunks.$inferInsert;

export type CodexChunk = typeof codexChunks.$inferSelect;
export type NewCodexChunk = typeof codexChunks.$inferInsert;

export type EventChunk = typeof eventChunks.$inferSelect;
export type NewEventChunk = typeof eventChunks.$inferInsert;

export type ChatMessageChunk = typeof chatMessageChunks.$inferSelect;
export type NewChatMessageChunk = typeof chatMessageChunks.$inferInsert;

export type UndoJournal = typeof undoJournal.$inferSelect;
export type NewUndoJournal = typeof undoJournal.$inferInsert;

export type ChangeEvent = typeof changeEvents.$inferSelect;
export type NewChangeEvent = typeof changeEvents.$inferInsert;
export type AiAuditEvent = typeof aiAuditEvents.$inferSelect;
export type NewAiAuditEvent = typeof aiAuditEvents.$inferInsert;
export type StateSnapshot = typeof stateSnapshots.$inferSelect;
export type NewStateSnapshot = typeof stateSnapshots.$inferInsert;

export type AbComparison = typeof abComparisons.$inferSelect;
export type NewAbComparison = typeof abComparisons.$inferInsert;

export type AbComparisonRun = typeof abComparisonRuns.$inferSelect;
export type NewAbComparisonRun = typeof abComparisonRuns.$inferInsert;

export type PostEffectType =
  | "review"
  | "pseudo_comment"
  | "meta_structure"
  | "consistency"
  | "intra_scene_consistency"
  | "typo_detection"
  | "intent_drift"
  | "timeline_consistency"
  | "impact_review";
export type PostEffectScopeType = "scene" | "folder" | "project";
export type PostEffectRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type PostEffectAnchorType = "scene_range" | "codex_entry" | "synopsis";
export type PostEffectCategory =
  | "review"
  | "pseudo_comment"
  | "consistency_anchor"
  | "foreshadow_anchor"
  | "theme_anchor"
  | "typo_anchor"
  | "intent_anchor"
  | "timeline_anchor"
  | "impact_review_anchor";
export type PostEffectSeverity = "info" | "suggestion" | "warning" | "error";
export type PostEffectAuthorRole = "ai" | "user" | "system";
export type PostEffectStatus = "open" | "resolved" | "dismissed";
export type PostEffectRelationType =
  | "contradiction"
  | "foreshadowing"
  | "theme_echo";
export type PostEffectRelationDirection = "bidirectional" | "a_to_b";
export type SceneLensType =
  | "plot_structure"
  | "pacing"
  | "character_arc"
  | "pov";
