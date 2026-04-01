# Grimodex 統合DBスキーマ

## 概要

全設計書に散在するDBスキーマ定義を1つに統合した正規版。実装時はこのドキュメントをSingle Source of Truthとし、個別設計書のSQLは参考として扱う。

データベース: SQLite（WALモード有効）
ORM: Drizzle ORM（sqlite-proxy）
ファイル: `project.db`

---

## テーブル一覧

| テーブル | 種別 | 定義元 | 説明 |
|---------|------|--------|------|
| `projects` | 通常 | Settings | プロジェクトのメタ情報 |
| `tree_nodes` | 通常 | Scenes | Part/Chapter/Scene/Folder/Note の統一ツリー |
| `codex_entries` | 通常 | Codex | 世界設定エントリ（Character/Location/Item/Lore） |
| `codex_relation_dismissed` | 通常 | Codex | リレーション提案のDismiss記録 |
| `snippets` | 通常 | Snippets | 再利用テキスト断片 |
| `chat_sessions` | 通常 | Chat | チャットセッション（シーン or プロジェクトスコープ） |
| `chat_messages` | 通常 | Chat | チャットメッセージ |
| `authorship_spans` | 通常 | Editor | AI帰属追跡スパン |
| `settings` | 通常 | Settings | Key-Value設定ストア |
| `codex_fts` | FTS5仮想 | Codex | Codexエントリの全文検索 |
| `snippets_fts` | FTS5仮想 | Snippets | Snippetの全文検索 |
| `chat_messages_fts` | FTS5仮想 | Chat History | チャットメッセージの全文検索 |

---

## ER図（リレーション概要）

```
projects (1)
 ├──< tree_nodes (*)          project_id
 ├──< codex_entries (*)       project_id
 ├──< snippets (*)            project_id
 ├──< chat_sessions (*)       project_id
 └──< settings (*)            (key prefix で暗黙的に紐づく)

tree_nodes (1)
 ├──< tree_nodes (*)          parent_id (自己参照、ツリー構造)
 ├──< chat_sessions (*)       node_id
 ├──< snippets (*)            scene_id
 └──< authorship_spans (*)    node_id

codex_entries (1)
 ├──< codex_entries (*)       parent_id (自己参照、リレーション)
 └──< codex_relation_dismissed (*) entry_id, dismissed_id

chat_sessions (1)
 └──< chat_messages (*)       session_id (ON DELETE CASCADE)

chat_messages (1)
 ├──< codex_entries (*)       source_chat_message_id
 └──< snippets (*)            source_chat_message_id
```

---

## テーブル定義

### projects

プロジェクトのメタ情報。Chatのコンテキスト注入Layer 1の基礎データ。

```sql
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT 'Untitled Project',
  genre           TEXT,                    -- 'Fantasy'|'Sci-Fi'|'Mystery'|... or custom
  pov             TEXT,                    -- 'First person'|'Third person limited'|...
  tense           TEXT,                    -- 'Past tense'|'Present tense'
  language        TEXT DEFAULT 'ja',       -- 作品の執筆言語
  style_guide     TEXT,                    -- 文体ガイド（最大2,000文字）
  ai_instructions TEXT,                    -- グローバルAI指示（最大4,000文字）
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### tree_nodes

Part/Chapter/Scene/Folder/Noteの統一ツリー。Fractional Indexing（sort_order REAL）で挿入時の再ソートを回避。

```sql
CREATE TABLE tree_nodes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  parent_id   TEXT REFERENCES tree_nodes(id),  -- NULL = Project直下
  node_type   TEXT NOT NULL,        -- 'part'|'chapter'|'scene'|'folder'|'note'
  title       TEXT NOT NULL DEFAULT 'Untitled',
  sort_order  REAL NOT NULL,        -- Fractional Indexing
  status      TEXT DEFAULT 'outline', -- Sceneのみ: 'outline'|'draft'|'complete'|'revision'|'final'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tree_parent ON tree_nodes(project_id, parent_id, sort_order);
```

本文ファイルの保存先: `content/` ディレクトリ。命名規則は Editor 設計書参照。
- Scene: `{pp}-{cc}-{ss}_{sanitized_title}_{short_id}.md`
- Note: `note_{sanitized_title}_{short_id}.md`

### codex_entries

世界設定エントリ。content本文は `codex/{type_prefix}_{sanitized_name}_{short_id}.md` に保存。

```sql
CREATE TABLE codex_entries (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id),
  parent_id               TEXT REFERENCES codex_entries(id),   -- リレーション（親エントリ）
  type                    TEXT NOT NULL DEFAULT 'character',   -- 'character'|'location'|'item'|'lore'
  name                    TEXT NOT NULL DEFAULT 'Untitled',
  aliases                 TEXT,            -- JSON array: ["エララ", "the apprentice"]
  excluded_aliases        TEXT,            -- JSON array: ["青い", "青の", "青く"]
  summary                 TEXT,            -- 短い要約（1-2文）
  tags                    TEXT,            -- JSON array: ["protagonist", "mage"]
  source_chat_message_id  TEXT REFERENCES chat_messages(id),   -- 抽出元チャット（nullable）
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_codex_project ON codex_entries(project_id, type);
CREATE INDEX idx_codex_name    ON codex_entries(project_id, name);
CREATE INDEX idx_codex_parent  ON codex_entries(parent_id);
```

### codex_relation_dismissed

Codex Content内の言及からのリレーション提案をDismissした記録。

```sql
CREATE TABLE codex_relation_dismissed (
  entry_id     TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  dismissed_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, dismissed_id)
);
```

### snippets

再利用可能なテキスト断片。contentは短い（50-500文字が典型）ためSQLiteカラムに直接保存。

```sql
CREATE TABLE snippets (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id),
  title                   TEXT NOT NULL DEFAULT 'Untitled',
  content                 TEXT NOT NULL DEFAULT '',
  tags                    TEXT,            -- JSON array: ["dialogue", "elara"]
  scene_id                TEXT REFERENCES tree_nodes(id),      -- 作成元シーン（nullable）
  source_chat_message_id  TEXT REFERENCES chat_messages(id),   -- 抽出元チャット（nullable）
  usage_count             INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_snippets_project ON snippets(project_id, created_at DESC);
```

### chat_sessions

チャットセッション。node_id NULLはプロジェクトスコープ。

```sql
CREATE TABLE chat_sessions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  node_id      TEXT REFERENCES tree_nodes(id),   -- NULLの場合はプロジェクトスコープ
  title        TEXT NOT NULL DEFAULT 'New session',
  title_manual INTEGER NOT NULL DEFAULT 0,        -- 1: 手動リネーム済み、自動再生成を抑制
  model        TEXT NOT NULL DEFAULT 'openrouter/anthropic/claude-sonnet-4.6',
  pinned_codex TEXT,           -- JSON array of pinned codex entry IDs
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_sessions_node ON chat_sessions(project_id, node_id);
```

### chat_messages

チャットメッセージ。セッション削除時にCASCADE削除。

```sql
CREATE TABLE chat_messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,      -- 'user'|'assistant'|'system'
  content     TEXT NOT NULL,
  model       TEXT,               -- assistantメッセージのみ: 使用モデル名
  tokens_in   INTEGER,            -- 入力トークン数
  tokens_out  INTEGER,            -- 出力トークン数
  duration_ms INTEGER,            -- 生成時間（ミリ秒）
  metadata    TEXT,               -- JSON: { extractedCodex: [...], extractedSnippets: [...] }
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at);
```

### authorship_spans

AI帰属追跡。エディタの自動保存時にTipTap AuthorshipMarkから同期。

```sql
CREATE TABLE authorship_spans (
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL REFERENCES tree_nodes(id),
  from_pos    INTEGER NOT NULL,
  to_pos      INTEGER NOT NULL,
  source      TEXT NOT NULL,       -- 'human'|'ai'|'unknown'
  model       TEXT,                -- AI生成時のモデル名
  timestamp   TEXT,                -- ISO 8601
  chat_msg_id TEXT                 -- 抽出元チャットメッセージID（nullable）
);

CREATE INDEX idx_authorship_node ON authorship_spans(node_id, source);
```

### settings

アプリケーション設定のKey-Valueストア。

```sql
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,       -- ドット区切り: 'editor.fontSize', 'display.theme'
  value TEXT NOT NULL            -- JSON value
);
```

---

## FTS5 仮想テーブル

全てtrigramトークナイザーを使用（日本語対応）。

### codex_fts

Codexエントリの検索用。name + aliases + summary + tags を対象。

```sql
CREATE VIRTUAL TABLE codex_fts USING fts5(
  name,
  aliases,
  summary,
  tags,
  content=codex_entries,
  content_rowid=rowid,
  tokenize='trigram'
);
```

### snippets_fts

Snippetの検索用。title + content + tags を対象。

```sql
CREATE VIRTUAL TABLE snippets_fts USING fts5(
  title,
  content,
  tags,
  content=snippets,
  content_rowid=rowid,
  tokenize='trigram'
);
```

### chat_messages_fts

チャットメッセージの横断検索用。content を対象。

```sql
CREATE VIRTUAL TABLE chat_messages_fts USING fts5(
  content,
  content=chat_messages,
  content_rowid=rowid,
  tokenize='trigram'
);
```

---

## FTS5 同期トリガー

各FTS5仮想テーブルをソーステーブルと自動同期するトリガー。

### codex_fts トリガー

```sql
CREATE TRIGGER codex_fts_ai AFTER INSERT ON codex_entries BEGIN
  INSERT INTO codex_fts(rowid, name, aliases, summary, tags)
    VALUES (new.rowid, new.name, new.aliases, new.summary, new.tags);
END;

CREATE TRIGGER codex_fts_ad AFTER DELETE ON codex_entries BEGIN
  INSERT INTO codex_fts(codex_fts, rowid, name, aliases, summary, tags)
    VALUES ('delete', old.rowid, old.name, old.aliases, old.summary, old.tags);
END;

CREATE TRIGGER codex_fts_au AFTER UPDATE ON codex_entries BEGIN
  INSERT INTO codex_fts(codex_fts, rowid, name, aliases, summary, tags)
    VALUES ('delete', old.rowid, old.name, old.aliases, old.summary, old.tags);
  INSERT INTO codex_fts(rowid, name, aliases, summary, tags)
    VALUES (new.rowid, new.name, new.aliases, new.summary, new.tags);
END;
```

### snippets_fts トリガー

```sql
CREATE TRIGGER snippets_fts_ai AFTER INSERT ON snippets BEGIN
  INSERT INTO snippets_fts(rowid, title, content, tags)
    VALUES (new.rowid, new.title, new.content, new.tags);
END;

CREATE TRIGGER snippets_fts_ad AFTER DELETE ON snippets BEGIN
  INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags)
    VALUES ('delete', old.rowid, old.title, old.content, old.tags);
END;

CREATE TRIGGER snippets_fts_au AFTER UPDATE ON snippets BEGIN
  INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags)
    VALUES ('delete', old.rowid, old.title, old.content, old.tags);
  INSERT INTO snippets_fts(rowid, title, content, tags)
    VALUES (new.rowid, new.title, new.content, new.tags);
END;
```

### chat_messages_fts トリガー

```sql
CREATE TRIGGER chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(rowid, content)
    VALUES (new.rowid, new.content);
END;

CREATE TRIGGER chat_messages_fts_ad AFTER DELETE ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER chat_messages_fts_au AFTER UPDATE ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  INSERT INTO chat_messages_fts(rowid, content)
    VALUES (new.rowid, new.content);
END;
```

---

## データベース初期化

```sql
-- WALモード有効化（接続ごとに1回）
PRAGMA journal_mode = WAL;

-- 外部キー制約有効化（接続ごとに1回）
PRAGMA foreign_keys = ON;
```

---

## ファイルシステム構成

DBの外に保存されるファイル。DBにはファイル名ではなくIDを保持し、ファイル名は動的算出。

```
{project_name}.novel/
├── project.db                          ← SQLiteデータベース
├── content/                            ← Scene/Note本文
│   ├── 01-01-01_塔の麓_a3f8.md
│   ├── 01-01-02_最初の呪文_b7c2.md
│   ├── note_世界観メモ_f9a0.md
│   └── ...
├── codex/                              ← Codexエントリの詳細コンテンツ
│   ├── char_elara_a3f8.md
│   ├── loc_obsidian-tower_b7c2.md
│   ├── item_soulbind-amulet_d4e1.md
│   └── ...
└── backups/                            ← 自動バックアップ（ZIP）
    ├── My_Novel_20260401_143000.zip
    └── ...
```

---

## JSON カラム仕様

SQLiteにはネイティブJSON型がないため、TEXT カラムにJSON文字列を保存する。

| テーブル.カラム | JSON構造 | 例 |
|---------------|---------|-----|
| `codex_entries.aliases` | `string[]` | `["エララ", "the apprentice"]` |
| `codex_entries.excluded_aliases` | `string[]` | `["青い", "青の", "青く"]` |
| `codex_entries.tags` | `string[]` | `["protagonist", "mage"]` |
| `snippets.tags` | `string[]` | `["dialogue", "elara"]` |
| `chat_sessions.pinned_codex` | `string[]` | `["codex-id-1", "codex-id-2"]` |
| `chat_messages.metadata` | `object` | `{"extractedCodex":["id1"],"extractedSnippets":["id2"]}` |
| `settings.value` | `any` | `"16"`, `"system"`, `"true"` |

SQLite 3.38+の `json()` / `json_extract()` 関数でクエリ内でのJSON操作が可能。ただしDrizzle ORM経由のアプリケーション層でのパース/シリアライズを基本とする。

---

## マイグレーション方針

- Drizzle ORMの `drizzle-kit` でマイグレーションファイルを生成・管理
- `migrations/` ディレクトリにSQL形式で保存
- アプリ起動時に未適用のマイグレーションを自動実行
- FTS5仮想テーブルとトリガーはマイグレーション内で作成（Drizzleのスキーマ定義ではFTS5を直接表現できないため、生SQLで記述）

---

## 統合時に発見した不整合と解決

以下の不整合を発見し、本ドキュメントおよび各個別設計書の両方で修正済み。

### 1. codex_entries の定義が設計書間で分散

Codex設計書のCREATE TABLEに `aliases` と `excluded_aliases` が含まれていたが、同じ設計書の後のセクションでALTER TABLEとして再定義。さらに `parent_id` もALTER TABLEで追加されていた。

**解決**: CREATE TABLEに全カラム（`parent_id`、`aliases`、`excluded_aliases` 含む）を統合。Codex設計書のALTER TABLE記述を削除し、「DBスキーマ」セクションへの参照に置き換え。

### 2. FTS5トリガーの命名規則

各設計書で `codex_ai`、`snippets_ai`、`chat_messages_ai` のような短い名前だったが、同じ `_ai` サフィックスが複数テーブルで重複。

**解決**: `{table}_fts_{operation}` 形式に統一（例: `codex_fts_ai`、`snippets_fts_au`、`chat_messages_fts_ad`）。Codex・Snippets・Chat History各設計書のトリガー名を修正済み。

### 3. authorship_spans の参照先

Editor設計書では `chat_msg_id TEXT` と定義されていたが、外部キー制約が未定義で、インデックスも未定義だった。

**解決**: chat_messagesへの外部キー制約は意図的に付けない（chat_messages削除時にattribution統計が壊れるのを防ぐため）。方針をSQLコメントで明文化。`idx_authorship_node` インデックスをEditor設計書のCREATE TABLE直後に追加。Attribution設計書の重複インデックス定義はEditor設計書への参照に置き換え。
