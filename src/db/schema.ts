import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
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
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const treeNodes = sqliteTable("tree_nodes", {
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
  sortOrder: real("sort_order").notNull().default(0.0),
  status: text("status").default("outline"), // 'outline' | 'draft' | 'complete' | 'revision' | 'final'
  content: text("content").notNull().default("{}"), // Scene/Note body (ProseMirror JSON)
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const codexTypes = sqliteTable("codex_types", {
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
});

export const codexEntries = sqliteTable("codex_entries", {
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
});

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

export const codexTags = sqliteTable("codex_tags", {
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
});

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

export const codexDetailDefinitions = sqliteTable("codex_detail_definitions", {
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
});

export const codexDetailValues = sqliteTable("codex_detail_values", {
  id: text("id").primaryKey(),
  entryId: text("entry_id")
    .notNull()
    .references(() => codexEntries.id, { onDelete: "cascade" }),
  definitionId: text("definition_id")
    .notNull()
    .references(() => codexDetailDefinitions.id, { onDelete: "cascade" }),
  value: text("value"),
});

export const snippets = sqliteTable("snippets", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("Untitled"),
  content: text("content").notNull().default("{}"), // ProseMirror JSON
  tags: text("tags"), // JSON string[]
  sceneId: text("scene_id").references(() => treeNodes.id, {
    onDelete: "set null",
  }),
  sourceChatMessageId: text("source_chat_message_id").references(
    () => chatMessages.id,
  ),
  usageCount: integer("usage_count").notNull().default(0),
  contentSource: text("content_source"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const chatSessions = sqliteTable("chat_sessions", {
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
});

export const chatMessages = sqliteTable("chat_messages", {
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
});

export const chatSummaries = sqliteTable("chat_summaries", {
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
});

export const authorshipSpans = sqliteTable("authorship_spans", {
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
  fromPos: integer("from_pos").notNull(),
  toPos: integer("to_pos").notNull(),
  source: text("source").notNull(), // 'human' | 'ai' | 'unknown'
  model: text("model"),
  timestamp: text("timestamp"),
  chatMsgId: text("chat_msg_id"),
  // CHECK: exactly one of nodeId/codexEntryId/snippetId must be non-null (enforced in SQL)
});

export const contentVersions = sqliteTable("content_versions", {
  id: text("id").primaryKey(),
  entityType: text("entity_type").notNull(), // 'scene' | 'note' | 'codex_entry' | 'snippet'
  entityId: text("entity_id").notNull(),
  content: text("content").notNull(),
  versionNumber: integer("version_number").notNull(),
  snapshotType: text("snapshot_type").notNull().default("auto"), // 'auto' | 'manual'
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const projectSnapshots = sqliteTable("project_snapshots", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

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

export const codexQuickPins = sqliteTable("codex_quick_pins", {
  entryId: text("entry_id")
    .primaryKey()
    .references(() => codexEntries.id, { onDelete: "cascade" }),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

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
