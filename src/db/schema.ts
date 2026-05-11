import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  foreignKey,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
  phaseResolutionMode: text("phase_resolution_mode", {
    enum: ["reading", "story", "auto"],
  })
    .notNull()
    .default("auto"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("uq_codex_detail_defs_project_type_name").on(
      table.projectId,
      table.typeSlug,
      table.name,
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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
    title: text("title").notNull().default("New session"),
    titleManual: integer("title_manual").notNull().default(0),
    model: text("model")
      .notNull()
      .default("openrouter/anthropic/claude-sonnet-4.6"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_chat_sessions_node").on(table.projectId, table.nodeId),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_chat_messages_session").on(table.sessionId, table.createdAt),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_chat_summaries_session").on(table.sessionId, table.createdAt),
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
    withChildren: integer("with_children").notNull().default(0),
    pinSource: text("pin_source", { enum: ["manual", "chat_mention"] })
      .notNull()
      .default("manual"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_chat_pin_session").on(table.sessionId, table.createdAt),
    uniqueIndex("uq_chat_pin_codex").on(table.sessionId, table.codexEntryId),
    uniqueIndex("uq_chat_pin_snippet").on(table.sessionId, table.snippetId),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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
    sourceChatMessageId: text("source_chat_message_id").references(
      () => chatMessages.id,
      { onDelete: "set null" },
    ),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_map_stickies_board").on(table.boardId),
    index("idx_map_stickies_ai_branch").on(table.aiBranchId),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_map_edges_board").on(table.boardId),
    index("idx_map_edges_from").on(table.fromPositionId),
    index("idx_map_edges_to").on(table.toPositionId),
  ],
);

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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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

    // Phase 6: load_bearing 軸（critical / supporting / optional / null）
    loadBearing: text("load_bearing"),

    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
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
    strength: text("strength"), // 'subtle' | 'moderate' | 'overt' | null
    aiStrength: text("ai_strength"),
    aiReasoning: text("ai_reasoning"),
    attribution: text("attribution").notNull().default("human"),
    aiRationale: text("ai_rationale"),
    lastEvaluatedAt: integer("last_evaluated_at", { mode: "timestamp" }),

    isOrphan: integer("is_orphan", { mode: "boolean" })
      .notNull()
      .default(false),

    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("idx_fs_setup_fid").on(t.foreshadowId),
    index("idx_fs_setup_scene").on(t.sceneId),
    index("idx_fs_setup_orphan").on(t.isOrphan),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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
    startedAt: text("started_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_pear_a").on(table.annotationAId),
    index("idx_pear_b").on(table.annotationBId),
  ],
);

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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_lens_run_target").on(table.runId, table.targetId),
    index("idx_lens_target_type").on(table.targetId, table.lensType),
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

// Type exports
export type AuthorshipSpan = typeof authorshipSpans.$inferSelect;
export type NewAuthorshipSpan = typeof authorshipSpans.$inferInsert;
export type CodexType = typeof codexTypes.$inferSelect;
export type NewCodexType = typeof codexTypes.$inferInsert;
export type CodexTag = typeof codexTags.$inferSelect;
export type NewCodexTag = typeof codexTags.$inferInsert;
export type CodexDetailDefinition = typeof codexDetailDefinitions.$inferSelect;
export type NewCodexDetailDefinition =
  typeof codexDetailDefinitions.$inferInsert;
export type CodexDetailValue = typeof codexDetailValues.$inferSelect;
export type NewCodexDetailValue = typeof codexDetailValues.$inferInsert;
export type CodexContextMode = "always" | "mentioned" | "suppress" | "hidden";
export type ContentVersion = typeof contentVersions.$inferSelect;
export type NewContentVersion = typeof contentVersions.$inferInsert;
export type ProjectSnapshot = typeof projectSnapshots.$inferSelect;
export type NewProjectSnapshot = typeof projectSnapshots.$inferInsert;
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

export type PostEffectType =
  | "review"
  | "pseudo_comment"
  | "meta_structure"
  | "consistency"
  | "intra_scene_consistency";
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
  | "theme_anchor";
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
