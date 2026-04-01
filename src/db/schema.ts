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
  nodeType: text("node_type").notNull(), // 'part' | 'chapter' | 'scene' | 'folder' | 'note'
  title: text("title").notNull().default("Untitled"),
  sortOrder: real("sort_order").notNull().default(0.0),
  status: text("status").default("outline"), // 'outline' | 'draft' | 'complete' | 'revision' | 'final'
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
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
  type: text("type").notNull().default("character"), // 'character' | 'location' | 'item' | 'lore'
  name: text("name").notNull().default("Untitled"),
  aliases: text("aliases"), // JSON string[]
  excludedAliases: text("excluded_aliases"), // JSON string[]
  summary: text("summary"),
  tags: text("tags"), // JSON string[]
  sourceChatMessageId: text("source_chat_message_id"),
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

export const snippets = sqliteTable("snippets", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("Untitled"),
  content: text("content").notNull().default(""),
  tags: text("tags"), // JSON string[]
  sceneId: text("scene_id").references(() => treeNodes.id, {
    onDelete: "set null",
  }),
  sourceChatMessageId: text("source_chat_message_id"),
  usageCount: integer("usage_count").notNull().default(0),
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
  nodeId: text("node_id"),
  title: text("title").notNull().default("New session"),
  titleManual: integer("title_manual").notNull().default(0),
  model: text("model")
    .notNull()
    .default("openrouter/anthropic/claude-sonnet-4.6"),
  pinnedCodex: text("pinned_codex"), // JSON string[]
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
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const authorshipSpans = sqliteTable("authorship_spans", {
  id: text("id").primaryKey(),
  nodeId: text("node_id")
    .notNull()
    .references(() => treeNodes.id, { onDelete: "cascade" }),
  fromPos: integer("from_pos").notNull(),
  toPos: integer("to_pos").notNull(),
  source: text("source").notNull(), // 'human' | 'ai' | 'unknown'
  model: text("model"),
  timestamp: text("timestamp"),
  chatMsgId: text("chat_msg_id"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Type exports
export type AuthorshipSpan = typeof authorshipSpans.$inferSelect;
export type NewAuthorshipSpan = typeof authorshipSpans.$inferInsert;
