import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const chapters = sqliteTable("chapters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const scenes = sqliteTable("scenes", {
  id: text("id").primaryKey(), // UUID — content stored at content/{id}.md
  chapterId: integer("chapter_id")
    .notNull()
    .references(() => chapters.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  synopsis: text("synopsis").notNull().default(""),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const codexEntries = sqliteTable("codex_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(), // 'character' | 'location' | 'item' | 'lore'
  name: text("name").notNull(),
  summary: text("summary").notNull().default(""),
  content: text("content").notNull().default(""),
  tags: text("tags").notNull().default(""),
  sourceChatMessageId: text("source_chat_message_id"),
  source: text("source").notNull().default("human"), // 'ai' | 'human'
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const snippets = sqliteTable("snippets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  content: text("content").notNull().default(""),
  tags: text("tags").notNull().default(""),
  sceneId: text("scene_id"),
  sourceChatMessageId: text("source_chat_message_id"),
  source: text("source").notNull().default("human"), // 'ai' | 'human'
  originalContent: text("original_content"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const chatThreads = sqliteTable("chat_threads", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  sceneId: text("scene_id").references(() => scenes.id, {
    onDelete: "cascade",
  }),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  modifiedAt: text("modified_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id")
    .notNull()
    .references(() => chatThreads.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // 'user' | 'assistant' | 'system'
  content: text("content").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const chatThreadPinnedCodex = sqliteTable("chat_thread_pinned_codex", {
  threadId: text("thread_id")
    .notNull()
    .references(() => chatThreads.id, { onDelete: "cascade" }),
  codexEntryId: integer("codex_entry_id")
    .notNull()
    .references(() => codexEntries.id, { onDelete: "cascade" }),
});

export const authorshipSpans = sqliteTable("authorship_spans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sceneId: text("scene_id")
    .notNull()
    .references(() => scenes.id, { onDelete: "cascade" }),
  offsetStart: integer("offset_start").notNull(),
  offsetEnd: integer("offset_end").notNull(),
  source: text("source").notNull(), // 'human' | 'ai' | 'unknown'
  traceId: text("trace_id"),
  model: text("model"),
  aiMessageId: text("ai_message_id"),
  manualOverride: integer("manual_override").notNull().default(0),
  contentHash: text("content_hash"),
  toolName: text("tool_name"),
  toolVersion: text("tool_version"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export type AuthorshipSpan = typeof authorshipSpans.$inferSelect;
export type NewAuthorshipSpan = typeof authorshipSpans.$inferInsert;
