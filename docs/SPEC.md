# NoveLoom - Product Specification

> Version: 0.1.0 (MVP)
> Last updated: 2026-03-30

## 1. Product Overview

NoveLoom is a desktop novel-writing editor inspired by Novelcrafter, built for Japanese fiction authors. It combines a rich text editor with an AI chat panel and a structured knowledge base (Codex), enabling writers to extract and organize knowledge from AI conversations and apply it directly to their manuscripts.

**Core experience:** Chat with AI, extract structured knowledge, write with context-aware assistance.

### 1.1 Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri v2 |
| Frontend | React 19 + TypeScript (strict) |
| Editor | TipTap (ProseMirror) |
| State management | Zustand (global) + Jotai (local) |
| UI components | shadcn/ui |
| AI integration | Vercel AI SDK |
| Database | SQLite (WAL mode) + FTS5 (trigram) |
| ORM | Drizzle ORM |
| Storage | Markdown files (source of truth) + SQLite (index/cache/metadata) |

### 1.2 Target User

Japanese-speaking individual novelists. The primary user is the developer themselves.

---

## 2. Architecture Principles

### 2.1 Storage Model: Markdown-Primary

Markdown files on disk are the **single source of truth** for all prose content. SQLite serves as:
- Full-text search index (FTS5 trigram)
- Authorship tracking store
- Codex metadata and relations
- Chat history
- Project settings and state

**Rationale:** Git-friendly, portable, no vendor lock-in. Users can read/edit files with any text editor.

### 2.2 Directory = Hierarchy

Project structure maps directly to the filesystem:

```
my-novel/
  noveloom.json              # Project manifest
  .noveloom/
    db.sqlite                # SQLite index/cache/metadata
    chat/                    # Chat history (JSON per thread)
  codex/
    characters/
      太郎.md
      花子.md
    locations/
      東京タワー.md
    items/
      聖剣.md
  manuscript/
    第一部/
      第1章/
        シーン1.md
        シーン2.md
      第2章/
        シーン1.md
    第二部/
      ...
```

- Folders = structural hierarchy (arbitrary depth, Scrivener-like)
- Leaf nodes = Markdown documents (scenes/chapters)
- Rename/move = filesystem operations (Tauri fs API)
- Sort order: controlled via `_order.json` in each folder

### 2.3 Document Format

Each manuscript document is a standard Markdown file with optional YAML frontmatter:

```markdown
---
id: "uuid-v7"
title: "夜明けの対話"
synopsis: "太郎と花子が再会する"
pov: "太郎"
status: draft
wordCount: 2340
created: 2026-03-15T10:00:00+09:00
modified: 2026-03-30T14:20:00+09:00
---

本文がここに続く。標準的なMarkdown記法を使用。
```

Frontmatter fields are indexed into SQLite for fast querying.

---

## 3. Editor (TipTap)

### 3.1 Core Requirements

- One TipTap instance per open document (scene/chapter)
- Standard rich-text editing: bold, italic, headings, block quotes, horizontal rules
- Real-time word/character count
- Autosave: debounced write to disk (500ms after last keystroke)
- Undo/redo with full history per session

### 3.2 Authorship Tracking (Mark-level)

Every text span carries an authorship Mark attribute with one of three values:

| Value | Meaning |
|-------|---------|
| `human` | Typed by the user |
| `ai` | Inserted from AI chat (untouched) |
| `ai-edited` | AI-originated text subsequently edited by the user |

**Implementation:**

- Custom TipTap Mark extension: `authorship` with `source` attribute (`human` | `ai` | `ai-edited`)
- Default: all keystrokes produce `human` marks
- "Insert to editor" from chat: inserted text gets `ai` mark
- Paste detection: clipboard paste from chat panel → `ai` mark; external paste → `human` mark (use custom clipboard data type to distinguish)
- When user edits within an `ai` span → transition to `ai-edited`
- IME composition: track `compositionstart`/`compositionend` events; buffer input during composition, apply `human` mark on `compositionend`

**Persistence:**

Authorship data is stored in **SQLite only** (not in Markdown files). The Markdown file remains clean, standard Markdown.

SQLite schema for authorship:
```sql
CREATE TABLE authorship_spans (
  id          INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  offset_start INTEGER NOT NULL,  -- character offset from document start
  offset_end   INTEGER NOT NULL,
  source       TEXT NOT NULL CHECK(source IN ('human', 'ai', 'ai-edited')),
  ai_message_id TEXT,             -- links back to the chat message that generated it
  created_at   TEXT NOT NULL,
  UNIQUE(document_id, offset_start, offset_end)
);
```

- On document save: serialize current TipTap Mark positions → update `authorship_spans`
- On document open: load spans from SQLite → apply as TipTap Marks
- On external edit (file changed on disk without NoveLoom): authorship data becomes stale → show warning, offer to clear authorship for the document

**Visual display:**
- Toggle-able overlay: human text normal, `ai` text with subtle background tint, `ai-edited` with different tint
- Status bar: show authorship ratio (% human / % ai / % ai-edited)

### 3.3 Text Insertion from Chat

Two mechanisms, both available simultaneously:

1. **Copy button** on chat messages → copies to clipboard with custom data type (`application/x-noveloom-ai-text`). When pasted in editor, detected and marked as `ai`.
2. **"Insert to editor" button** on chat messages → inserts at current cursor position programmatically, marked as `ai`.

If the editor has no cursor focus when "Insert" is clicked, insert at the end of the document.

---

## 4. AI Chat Panel

### 4.1 Provider: OpenRouter (MVP)

- Single provider for MVP: OpenRouter API
- BYOK (Bring Your Own Key): user provides their OpenRouter API key
- Model selection: user chooses from available OpenRouter models
- Streaming: Vercel AI SDK `useChat` with streaming enabled
- All API calls from Rust backend (Tauri commands) to avoid CORS and keep keys secure

### 4.2 Thread Model

```
Project
├── Project-level threads (worldbuilding, plotting, etc.)
└── Document (scene/chapter)
    ├── Thread: "プロット相談"
    ├── Thread: "文体添削"
    └── Thread: "キャラ深掘り"
```

- Each document can have **N chat threads**
- Project-level threads are not bound to any document
- Thread list shown in sidebar; active thread in chat panel
- Threads are persisted as JSON files in `.noveloom/chat/{thread-id}.json`

Thread schema:
```json
{
  "id": "uuid-v7",
  "title": "プロット相談",
  "documentId": "uuid-v7 | null",
  "createdAt": "ISO8601",
  "messages": [
    {
      "id": "uuid-v7",
      "role": "user | assistant | system",
      "content": "...",
      "createdAt": "ISO8601",
      "codexExtractions": ["codex-entry-id", ...]
    }
  ]
}
```

### 4.3 Context Injection (Auto RAG + Manual @mention)

When the user sends a message, the system automatically constructs context:

**Automatic context (always included):**
1. Current document content (if thread is bound to a document)
2. Document frontmatter (synopsis, POV character, status)
3. FTS5 search: query = user's message → top-K relevant Codex entries and document snippets

**Manual override via @mention:**
- `@codex:太郎` — inject the Codex entry for 太郎
- `@doc:第1章/シーン2` — inject a specific document's content
- `@codex:*characters` — inject all character Codex entries

**Context budget management:**
- Configurable token budget (default: 8000 tokens for context, rest for conversation)
- Priority order: manual @mentions > current document > FTS results
- If budget exceeded: truncate FTS results first, then current document (keep first/last N paragraphs)
- Show user a "Context" expandable section above the chat input showing what was injected

**System prompt:**
- Default system prompt template per thread type (configurable)
- Prompt template variables: `{{document}}`, `{{codex}}`, `{{synopsis}}`, `{{characters}}`

### 4.4 Prompt Templates

Users can create and manage prompt templates:
- Built-in templates: "General Assistant", "Plot Consultant", "Style Editor", "Character Developer"
- Custom templates with variable interpolation
- Templates stored in `noveloom.json` or a dedicated `templates/` directory

---

## 5. Codex (Knowledge Base)

### 5.1 Entry Structure: Key-Value + Free Text

Each Codex entry is a Markdown file with structured frontmatter:

```markdown
---
id: "uuid-v7"
name: "山田太郎"
category: "character"
tags: ["主人公", "第一部"]
relations:
  - target: "uuid-of-花子"
    type: "sibling"
    label: "花子の兄"
  - target: "uuid-of-聖剣"
    type: "possesses"
    label: "聖剣の所有者"
aliases: ["太郎", "山田"]
created: "ISO8601"
modified: "ISO8601"
---

## Properties

- **年齢:** 25歳
- **外見:** 黒髪、長身
- **性格:** 慎重だが情に厚い
- **目的:** 妹を救出する

## Notes

太郎は第一部の語り手。過去のトラウマにより...

## Source Messages

- [2026-03-15 チャットから抽出](noveloom://chat/thread-id/message-id)
```

**Design decisions:**
- `Properties` section: arbitrary key-value pairs in Markdown list format. No fixed schema — user and AI can add any key.
- `Notes` section: free-form text for unstructured information
- `Source Messages` section: backlinks to originating chat messages (provenance tracking)
- `relations` in frontmatter: explicit typed relations to other Codex entries

### 5.2 Categories

Default categories (user can add custom ones):
- `character` — Characters
- `location` — Places/settings
- `item` — Objects, artifacts
- `concept` — Magic systems, organizations, abstract concepts
- `event` — Historical events, backstory
- `snippet` — Text fragments, prose drafts, dialogue candidates

### 5.3 Relations Graph

Codex entries can have explicit typed relations:

```typescript
interface CodexRelation {
  sourceId: string;
  targetId: string;
  type: string;       // "sibling", "parent", "possesses", "belongs_to", "enemy_of", etc.
  label: string;      // Human-readable: "花子の兄"
  bidirectional: boolean; // If true, auto-create reverse relation
}
```

- Relations stored in entry frontmatter AND indexed in SQLite for graph queries
- Used by RAG: when a Codex entry is included in context, related entries (1-hop) are candidates for inclusion
- MVP UI: simple list of relations per entry with add/remove. Graph visualization is post-MVP.

### 5.4 Extraction from Chat

**Message-level extraction:**
- Each AI response has a "Save to Codex" button
- Clicking opens a dialog:
  - Pre-filled with AI-suggested category, name, key-value properties
  - User can edit before saving
  - Source message backlink is automatically created

**AI auto-suggestion:**
- After each AI response, the system checks if the response contains Codex-worthy content
- Implementation: append a hidden instruction to the system prompt asking the AI to tag extractable entities in its response using a specific format (e.g., `[[codex:character:太郎]]`)
- When detected, show a subtle "Codex candidates found" indicator on the message
- User clicks to review and confirm/edit before saving

**Extraction flow:**
1. AI responds with content
2. System detects `[[codex:...]]` markers (or user clicks "Save to Codex")
3. Dialog shows: Name, Category, suggested Key-Value properties, free text
4. User confirms → Codex entry MD file created, backlink stored
5. SQLite index updated

---

## 6. Data Flow & State Management

### 6.1 State Architecture

```
Zustand stores (global):
├── projectStore      — project metadata, file tree
├── editorStore       — active document, dirty state
├── chatStore         — active thread, messages, streaming state
├── codexStore        — entries index, search results
└── settingsStore     — API keys, preferences, UI state

Jotai atoms (local):
├── editorSelection   — current selection/cursor position
├── chatInput         — current chat input text
├── contextPreview    — resolved context for current message
└── panelLayout       — splitter positions, panel visibility
```

### 6.2 Data Flow Diagram

```
[Filesystem (MD files)]
       ↕ read/write (Tauri fs)
[Rust Backend]
       ↕ Tauri Commands (IPC)
[React Frontend]
  ├── TipTap Editor ←→ editorStore
  ├── Chat Panel    ←→ chatStore
  ├── Codex Panel   ←→ codexStore
  └── File Tree     ←→ projectStore
       ↕ indexed into
[SQLite (via Drizzle)]
  ├── FTS5 index (document content, codex content)
  ├── Authorship spans
  ├── Codex relations graph
  └── Document metadata cache
```

### 6.3 Key Data Flows

**Writing flow:**
1. User types in TipTap → `human` authorship mark applied
2. Autosave (debounced 500ms) → write MD to disk + update authorship spans in SQLite
3. SQLite FTS index updated on save

**AI chat flow:**
1. User types message (optionally with @mentions)
2. Frontend resolves context: current doc + FTS results + @mentioned entries
3. Tauri command: send message to OpenRouter via Rust backend
4. Stream response back to frontend
5. Parse response for `[[codex:...]]` markers
6. Display response with "Insert" and "Save to Codex" buttons

**Codex extraction flow:**
1. User clicks "Save to Codex" on a chat message
2. Dialog opens with AI-suggested structure
3. User confirms → MD file written to `codex/{category}/{name}.md`
4. SQLite index updated (FTS + relations)
5. Backlink stored in both the Codex entry and the chat message

**Insert to editor flow:**
1. User clicks "Insert to editor" on a chat message
2. Text inserted at cursor position with `ai` authorship mark
3. Authorship spans updated in SQLite on next save
4. Chat message records which document received the insertion

---

## 7. SQLite Schema (Index/Cache/Metadata)

```sql
-- Document metadata cache (source of truth is the MD file)
CREATE TABLE documents (
  id          TEXT PRIMARY KEY,  -- UUID v7
  path        TEXT NOT NULL UNIQUE, -- relative path from project root
  title       TEXT,
  synopsis    TEXT,
  pov         TEXT,
  status      TEXT DEFAULT 'draft',
  word_count  INTEGER DEFAULT 0,
  parent_path TEXT,  -- parent folder path for hierarchy
  sort_order  INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL,
  modified_at TEXT NOT NULL
);

-- FTS5 index for document content
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, content, synopsis,
  content=documents,
  tokenize='trigram'
);

-- Authorship tracking
CREATE TABLE authorship_spans (
  id            INTEGER PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id),
  offset_start  INTEGER NOT NULL,
  offset_end    INTEGER NOT NULL,
  source        TEXT NOT NULL CHECK(source IN ('human', 'ai', 'ai-edited')),
  ai_message_id TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_authorship_doc ON authorship_spans(document_id);

-- Codex entries (source of truth is the MD file)
CREATE TABLE codex_entries (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  tags        TEXT,  -- JSON array
  content     TEXT,  -- full text for FTS
  created_at  TEXT NOT NULL,
  modified_at TEXT NOT NULL
);

-- FTS5 index for codex
CREATE VIRTUAL TABLE codex_fts USING fts5(
  name, content, tags,
  content=codex_entries,
  tokenize='trigram'
);

-- Codex relations
CREATE TABLE codex_relations (
  id              INTEGER PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES codex_entries(id),
  target_id       TEXT NOT NULL REFERENCES codex_entries(id),
  relation_type   TEXT NOT NULL,
  label           TEXT,
  bidirectional   INTEGER DEFAULT 0,
  UNIQUE(source_id, target_id, relation_type)
);
CREATE INDEX idx_relations_source ON codex_relations(source_id);
CREATE INDEX idx_relations_target ON codex_relations(target_id);

-- Chat threads
CREATE TABLE chat_threads (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  document_id TEXT REFERENCES documents(id),
  created_at  TEXT NOT NULL,
  modified_at TEXT NOT NULL
);

-- Chat messages (also persisted as JSON files, SQLite for search)
CREATE TABLE chat_messages (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES chat_threads(id),
  role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- FTS for chat messages
CREATE VIRTUAL TABLE chat_fts USING fts5(
  content,
  content=chat_messages,
  tokenize='trigram'
);

-- Codex extraction provenance
CREATE TABLE codex_extractions (
  id              INTEGER PRIMARY KEY,
  codex_entry_id  TEXT NOT NULL REFERENCES codex_entries(id),
  chat_message_id TEXT NOT NULL REFERENCES chat_messages(id),
  extracted_at    TEXT NOT NULL
);

-- Settings
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

---

## 8. Tauri Command API (Rust ↔ JS Bridge)

### 8.1 Project Management
```rust
#[tauri::command] fn open_project(path: String) -> Result<ProjectManifest>
#[tauri::command] fn create_project(path: String, name: String) -> Result<ProjectManifest>
#[tauri::command] fn get_file_tree(project_path: String) -> Result<FileTreeNode>
#[tauri::command] fn create_folder(path: String) -> Result<()>
#[tauri::command] fn rename_entry(old_path: String, new_path: String) -> Result<()>
#[tauri::command] fn delete_entry(path: String) -> Result<()>
#[tauri::command] fn reorder_entries(folder_path: String, order: Vec<String>) -> Result<()>
```

### 8.2 Document Operations
```rust
#[tauri::command] fn read_document(path: String) -> Result<DocumentData>
#[tauri::command] fn save_document(path: String, content: String, frontmatter: Value) -> Result<()>
#[tauri::command] fn get_authorship_spans(document_id: String) -> Result<Vec<AuthorshipSpan>>
#[tauri::command] fn save_authorship_spans(document_id: String, spans: Vec<AuthorshipSpan>) -> Result<()>
```

### 8.3 Codex Operations
```rust
#[tauri::command] fn list_codex_entries(category: Option<String>) -> Result<Vec<CodexEntry>>
#[tauri::command] fn read_codex_entry(id: String) -> Result<CodexEntry>
#[tauri::command] fn create_codex_entry(entry: NewCodexEntry) -> Result<CodexEntry>
#[tauri::command] fn update_codex_entry(id: String, entry: UpdateCodexEntry) -> Result<CodexEntry>
#[tauri::command] fn delete_codex_entry(id: String) -> Result<()>
#[tauri::command] fn add_codex_relation(relation: NewRelation) -> Result<()>
#[tauri::command] fn remove_codex_relation(id: i64) -> Result<()>
#[tauri::command] fn get_related_entries(entry_id: String, depth: u32) -> Result<Vec<CodexEntry>>
```

### 8.4 Search
```rust
#[tauri::command] fn search_fts(query: String, scope: SearchScope) -> Result<Vec<SearchResult>>
// SearchScope: All | Documents | Codex | Chat
#[tauri::command] fn build_context(message: String, document_id: Option<String>, mentions: Vec<Mention>) -> Result<ContextPayload>
```

### 8.5 AI Chat
```rust
#[tauri::command] fn list_threads(document_id: Option<String>) -> Result<Vec<ChatThread>>
#[tauri::command] fn create_thread(title: String, document_id: Option<String>) -> Result<ChatThread>
#[tauri::command] fn delete_thread(id: String) -> Result<()>
#[tauri::command] fn send_message(thread_id: String, content: String, context: ContextPayload) -> Result<()>
// Streaming is handled via Tauri events, not return values
// Event: "chat:stream-chunk" { threadId, content, done }
```

### 8.6 Settings
```rust
#[tauri::command] fn get_settings() -> Result<Settings>
#[tauri::command] fn update_settings(settings: PartialSettings) -> Result<Settings>
```

---

## 9. UI Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  Menu Bar                                                       │
├──────────┬──────────────────────────────────┬───────────────────┤
│          │                                  │                   │
│  File    │       TipTap Editor              │   AI Chat Panel   │
│  Tree    │                                  │                   │
│          │  [authorship overlay toggle]      │  [thread selector]│
│  ────    │                                  │  [messages...]    │
│          │                                  │  [context preview]│
│  Codex   │                                  │  [input + send]   │
│  List    │                                  │                   │
│          │                                  │  ──────────────── │
│          │                                  │                   │
│          │                                  │  Codex Detail     │
│          │                                  │  (when selected)  │
│          │                                  │                   │
├──────────┴──────────────────────────────────┴───────────────────┤
│  Status Bar: word count | authorship ratio | AI model | save    │
└─────────────────────────────────────────────────────────────────┘
```

- Three-column layout with resizable splitters
- Left sidebar: file tree (top) + codex list (bottom), collapsible
- Center: editor, full height
- Right sidebar: chat panel (top) + codex detail (bottom), collapsible
- All panels are toggleable via keyboard shortcuts

---

## 10. Export

### 10.1 MVP Export Formats

| Format | Description |
|--------|-------------|
| Markdown | Already the native format — just copy the `manuscript/` folder |
| Plain text | Concatenate all documents in order, strip Markdown formatting. For web novel submission sites (Narou, Kakuyomu) |

### 10.2 Export Options

- Scope: entire project, selected chapters, single document
- Order: follows `_order.json` sort order
- Plain text: configurable scene separator (e.g., `***`, blank line)
- Frontmatter: strip or include
- Authorship: optionally annotate AI-generated sections (for transparency)

### 10.3 Post-MVP

- DOCX export (for doujinshi printing)
- EPUB export
- Vertical writing PDF preview (縦書きプレビュー)

---

## 11. Performance Considerations

### 11.1 Large Novels (100,000+ characters)

- **Editor:** One TipTap instance per document (scene). Scenes are typically 2,000-10,000 chars — no performance issue.
- **File tree:** Lazy-load folder contents. Cache in projectStore.
- **FTS5:** Trigram tokenizer handles Japanese well. Index updates are incremental (on document save only).
- **Authorship spans:** Indexed by document_id. Batch update on save, not per-keystroke.

### 11.2 Large Codex (100+ entries)

- Codex list: virtualized scrolling (react-window or TanStack Virtual)
- FTS search: instant for trigram queries
- Relations graph: limit hop depth to 2 for context injection

### 11.3 AI Streaming

- Streaming via Tauri events (not HTTP polling)
- Chat history: only load recent N messages (default: 50), lazy-load older ones
- Context budget: hard cap prevents sending oversized requests

---

## 12. Security

- API keys stored in OS keychain via `tauri-plugin-stronghold` or OS credential manager
- All AI API calls go through Rust backend — keys never touch the frontend
- No telemetry, no external connections except user-configured AI provider
- Project files are local-only

---

## 13. Settings

| Setting | Type | Default |
|---------|------|---------|
| `ai.provider` | `"openrouter"` | `"openrouter"` |
| `ai.apiKey` | string (encrypted) | `""` |
| `ai.model` | string | `"anthropic/claude-sonnet-4"` |
| `ai.contextBudget` | number (tokens) | `8000` |
| `ai.temperature` | number | `0.7` |
| `ai.systemPromptTemplate` | string | (built-in default) |
| `editor.autosaveDelay` | number (ms) | `500` |
| `editor.showAuthorship` | boolean | `true` |
| `editor.authorshipColors.ai` | string | `"#e8f0fe"` |
| `editor.authorshipColors.aiEdited` | string | `"#fef7e0"` |
| `export.sceneSeparator` | string | `"***"` |
| `export.stripFrontmatter` | boolean | `true` |

---

## 14. MVP Scope & Boundaries

### In Scope (MVP)

- [x] TipTap editor with basic formatting
- [x] Flexible folder hierarchy (filesystem-based)
- [x] SQLite + FTS5 trigram index
- [x] Authorship tracking (Mark-level, SQLite persistence)
- [x] AI chat panel (OpenRouter, streaming)
- [x] Scene 1:N threads + project-level threads
- [x] Auto RAG context injection (FTS5) + @mention
- [x] Codex: Key-Value + free text entries
- [x] Codex: explicit typed relations
- [x] Codex extraction from chat (message-level + AI auto-suggestion)
- [x] Text insertion from chat to editor (copy + insert button)
- [x] Export: Markdown + plain text
- [x] Prompt templates (built-in + custom)

### Out of Scope (Post-MVP)

- [ ] Embedding-based vector search (RAG upgrade)
- [ ] Multiple AI providers (direct OpenAI, Anthropic, Ollama)
- [ ] DOCX/EPUB export
- [ ] Vertical writing preview (縦書き)
- [ ] Ruby text (ルビ)
- [ ] Japanese morphological analysis for FTS
- [ ] Codex relation graph visualization
- [ ] Keystroke replay (Grammarly Authorship-style)
- [ ] Collaboration / multi-user
- [ ] Cloud sync
- [ ] Plugin system

---

## 15. Development Phases

### Phase 1: Foundation
- Project creation/opening
- File tree with folder hierarchy
- Basic TipTap editor (read/write Markdown)
- SQLite setup with Drizzle schema
- Autosave

### Phase 2: AI Chat
- Settings UI (API key, model selection)
- Chat thread CRUD
- OpenRouter integration via Rust backend
- Streaming response display
- Basic context injection (current document)

### Phase 3: Codex
- Codex entry CRUD (MD files + SQLite index)
- Codex categories and tags
- FTS5 search across documents and codex
- @mention context injection
- Auto RAG context building

### Phase 4: Extraction & Integration
- "Save to Codex" from chat messages
- AI auto-suggestion of Codex candidates
- "Insert to editor" with authorship marking
- Copy with AI paste detection
- Codex relations (add/remove/query)

### Phase 5: Authorship & Polish
- Authorship Mark extension (TipTap)
- IME composition handling
- Authorship visual overlay
- Authorship span persistence (SQLite)
- Export (MD + plain text)
- Prompt templates

### Phase 6: Performance & Quality
- FTS5 index optimization
- Virtualized lists for large codex
- Error handling and edge cases
- Cross-reference integrity checks
- UI polish and keyboard shortcuts
