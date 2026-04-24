import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
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
      onDelete: "set null",
    }),
    nodeType: text("node_type").notNull(), // 'folder' | 'scene' | 'note'
    title: text("title").notNull().default("Untitled"),
    synopsis: text("synopsis"), // Scene only: plain text summary for storySoFar context injection
    // reading-order 用の fractional-indexing キー（base62、辞書順比較）
    sortOrder: text("sort_order").notNull().default("a0"),
    // story-time 用の fractional-indexing キー（null の場合は未指定）
    storyTimeOrder: text("story_time_order"),
    storyTimeLabel: text("story_time_label"),

    povCharacterId: text("pov_character_id").references(
      (): any => codexEntries.id,
      { onDelete: "set null" },
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    locationId: text("location_id").references((): any => codexEntries.id, {
      onDelete: "set null",
    }),
    status: text("status").default("outline"), // 'outline' | 'draft' | 'complete' | 'revision' | 'final'
    content: text("content").notNull().default("{}"), // Scene/Note body (ProseMirror JSON)
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
    type: text("type").notNull().default("character"), // FK (project_id, type) → codex_types(project_id, slug) validated at app layer
    name: text("name").notNull().default("Untitled"),
    aliases: text("aliases"), // JSON string[]
    excludedAliases: text("excluded_aliases"), // JSON string[]
    summary: text("summary"),
    content: text("content").notNull().default("{}"), // body (ProseMirror JSON)
    icon: text("icon"), // 128×128 WebP icon image as base64 data URL (nullable)
    tagsCache: text("tags_cache"), // FTS5 denormalized cache (JSON string[])
    contextMode: text("context_mode").notNull().default("mentioned"), // 'always' | 'mentioned' | 'suppress' | 'hidden'
    childrenBudget: text("children_budget").notNull().default("compact"), // 'none' | 'compact' | 'standard' | 'generous'
    sourceChatMessageId: text("source_chat_message_id").references(
      () => chatMessages.id,
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
  ],
);

export const codexRelationDismissed = sqliteTable(
  "codex_relation_dismissed",
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

export const codexQuickPins = sqliteTable("codex_quick_pins", {
  entryId: text("entry_id")
    .primaryKey()
    .references(() => codexEntries.id, { onDelete: "cascade" }),
});

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
    typeSlug: text("type_slug").notNull(), // logical ref to codex_types.slug
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
    pinnedCodex: text("pinned_codex"), // JSON {id, source}[]
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
    sourceMessageIds: text("source_message_ids").notNull(), // JSON string[]
    tokenCount: integer("token_count"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_chat_summaries_session").on(table.sessionId, table.createdAt),
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
    // CHECK: exactly one of nodeId/codexEntryId/snippetId must be non-null (enforced in SQL)
    // detailValueId is an optional orthogonal FK (not part of ownership CHECK)
  },
  (table) => [
    index("idx_authorship_node").on(table.nodeId, table.source),
    index("idx_authorship_codex").on(table.codexEntryId, table.source),
    index("idx_authorship_snippet").on(table.snippetId, table.source),
    index("idx_authorship_detail").on(table.detailValueId),
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
    index("idx_project_snapshots").on(table.projectId, table.createdAt),
  ],
);

export const projectSnapshotEntries = sqliteTable(
  "project_snapshot_entries",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => projectSnapshots.id, { onDelete: "cascade" }),
    versionId: text("version_id")
      .notNull()
      .references(() => contentVersions.id),
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

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

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
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index("idx_map_boards_project").on(table.projectId)],
);

export const mapAiNodes = sqliteTable(
  "map_ai_nodes",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id")
      .notNull()
      .references(() => mapBoards.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    response: text("response"),
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
  (table) => [index("idx_map_ai_board").on(table.boardId)],
);

export const mapNodePositions = sqliteTable(
  "map_node_positions",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id")
      .notNull()
      .references(() => mapBoards.id, { onDelete: "cascade" }),
    nodeRefType: text("node_ref_type", {
      enum: ["scene", "codex", "note", "ai"],
    }).notNull(),
    treeNodeId: text("tree_node_id").references(() => treeNodes.id, {
      onDelete: "cascade",
    }),
    codexEntryId: text("codex_entry_id").references(() => codexEntries.id, {
      onDelete: "cascade",
    }),
    aiNodeId: text("ai_node_id").references(() => mapAiNodes.id, {
      onDelete: "cascade",
    }),
    x: real("x").notNull(),
    y: real("y").notNull(),
    pinned: integer("pinned").notNull().default(0),
    hidden: integer("hidden").notNull().default(0),
    zIndex: integer("z_index").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_map_pos_board").on(table.boardId),
    index("idx_map_pos_tree").on(table.treeNodeId),
    index("idx_map_pos_codex").on(table.codexEntryId),
  ],
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
    label: text("label"),
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
export type MapAiNode = typeof mapAiNodes.$inferSelect;
export type NewMapAiNode = typeof mapAiNodes.$inferInsert;

export type LintIgnoredDiagnostic = typeof lintIgnoredDiagnostics.$inferSelect;
export type NewLintIgnoredDiagnostic =
  typeof lintIgnoredDiagnostics.$inferInsert;

export type LintTermDictionaryRow = typeof lintTermDictionary.$inferSelect;
export type NewLintTermDictionaryRow = typeof lintTermDictionary.$inferInsert;
