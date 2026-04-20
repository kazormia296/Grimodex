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
| `tree_nodes` | 通常 | Scenes | Folder/Scene/Note の統一ツリー |
| `codex_types` | 通常 | Codex | Codexエントリタイプ定義（ビルトイン+カスタム） |
| `codex_entries` | 通常 | Codex | 世界設定エントリ |
| `codex_relation_dismissed` | 通常 | Codex | リレーション提案のDismiss記録 |
| `codex_tags` | 通常 | Codex | 構造化タグ定義（タイプ関連付け付き） |
| `codex_entry_tags` | 通常 | Codex | エントリ↔タグの多対多リレーション |
| `codex_detail_definitions` | 通常 | Codex | カスタムディテール定義（タイプごと） |
| `codex_detail_values` | 通常 | Codex | カスタムディテール値（エントリごと） |
| `codex_entry_phases` | 通常 | Codex | Codexエントリの経時的変化（フェーズ） |
| `codex_phase_detail_overrides` | 通常 | Codex | フェーズごとのカスタムディテールオーバーライド |
| `codex_quick_pins` | 通常 | Codex | クイックピン永続化 |
| `snippets` | 通常 | Snippets | 再利用テキスト断片 |
| `snippet_entry_tags` | 通常 | Snippets | Snippet↔タグの多対多リレーション |
| `chat_sessions` | 通常 | Chat | チャットセッション（シーン or プロジェクトスコープ） |
| `chat_messages` | 通常 | Chat | チャットメッセージ |
| `chat_summaries` | 通常 | Chat | プログレッシブ要約 |
| `content_versions` | 通常 | Editor | コンテンツのリビジョン履歴 |
| `project_snapshots` | 通常 | Editor | プロジェクト全体のプロジェクトスナップショット |
| `project_snapshot_entries` | 通常 | Editor | プロジェクトスナップショットとリビジョンの紐付け |
| `authorship_spans` | 通常 | Editor | AI帰属追跡スパン |
| `settings` | 通常 | Settings | Key-Value設定ストア |
| `codex_fts` | FTS5仮想 | Codex | Codexエントリの全文検索 |
| `snippets_fts` | FTS5仮想 | Snippets | Snippetの全文検索 |
| `chat_messages_fts` | FTS5仮想 | Chat History | チャットメッセージの全文検索 |
| `tree_nodes_fts` | FTS5仮想 | Scenes | ツリーノードの全文検索 |

---

## ER図（リレーション概要）

```
projects (1)
 ├──< tree_nodes (*)          project_id
 ├──< codex_types (*)         project_id
 ├──< codex_entries (*)       project_id
 ├──< codex_tags (*)          project_id
 ├──< codex_detail_definitions (*) project_id
 ├──< snippets (*)            project_id
 ├──< chat_sessions (*)       project_id
 ├──< project_snapshots (*)   project_id
 └──< settings (*)            (key prefix で暗黙的に紐づく)

tree_nodes (1)
 ├──< tree_nodes (*)          parent_id (自己参照、ツリー構造)
 ├──< chat_sessions (*)       node_id
 ├──< snippets (*)            scene_id
 ├──< codex_entry_phases (*)  anchor_node_id (nullable)
 └──< authorship_spans (*)    node_id (nullable)

codex_types (1)
 └──< codex_detail_definitions (*) type_slug (論理参照、FKなし)

codex_entries (1)
 ├──< codex_entries (*)       parent_id (自己参照、リレーション)
 ├──< codex_relation_dismissed (*) entry_id, dismissed_id
 ├──< codex_entry_tags (*)    entry_id
 ├──< codex_detail_values (*) entry_id
 ├──< codex_entry_phases (*)  entry_id
 ├──< codex_quick_pins (*)    entry_id
 └──< authorship_spans (*)    codex_entry_id (nullable)

codex_entry_phases (1)
 ├──< codex_phase_detail_overrides (*) phase_id
 └──< authorship_spans (*)    phase_id (nullable)

snippets (1)
 ├──< snippet_entry_tags (*)  snippet_id
 └──< authorship_spans (*)    snippet_id (nullable)

codex_tags (1)
 ├──< codex_entry_tags (*)    tag_id
 └──< snippet_entry_tags (*)  tag_id

codex_detail_definitions (1)
 ├──< codex_detail_values (*) definition_id
 └──< codex_phase_detail_overrides (*) definition_id

codex_detail_values (1)
 └──< authorship_spans (*)    detail_value_id (nullable)

chat_sessions (1)
 ├──< chat_messages (*)       session_id (ON DELETE CASCADE)
 └──< chat_summaries (*)      session_id (ON DELETE CASCADE)

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
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL DEFAULT 'Untitled Project',
  genre                 TEXT,                    -- 'Fantasy'|'Sci-Fi'|'Mystery'|... or custom
  pov                   TEXT,                    -- 'First person'|'Third person limited'|...
  tense                 TEXT,                    -- 'Past tense'|'Present tense'
  language              TEXT DEFAULT 'ja',       -- 作品の執筆言語
  style_guide           TEXT,                    -- 文体ガイド（最大2,000文字）
  ai_instructions       TEXT,                    -- グローバルAI指示（最大4,000文字）
  phase_resolution_mode TEXT NOT NULL DEFAULT 'reading'
    CHECK(phase_resolution_mode IN ('auto', 'reading', 'story')),
                                                 -- Phase解決に使う時間軸。'auto'=story_time_orderがあれば作中時間、なければ読者順 / 'reading'=常に読者順 / 'story'=作中時間（未設定Sceneは直前の値を継承）
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**`phase_resolution_mode` のデフォルト方針**:
- **SQLデフォルト = `'reading'`**: 既存プロジェクトを再オープンした際に従来の挙動（読者順）が保たれるよう、後方互換を優先。マイグレーション適用時はすべての既存プロジェクトがこの値になる。
- **アプリ層デフォルト = `'auto'`**: 新規プロジェクト作成時は `'auto'` を明示的に書き込む。作中時間を設定した瞬間から自動で story-time 解決に切り替わる、最もユーザーの直感に近い挙動。
- **write-order は選択肢に含めない**: 執筆順（`created_at`順）は Phase 解決の軸として意味を持たない（後から書き足したシーンが過去のPhaseを書き換えてしまう）。`'reading'` / `'story'` の二択のみを軸として提供し、`'auto'` はその切り替えポリシー。
- 詳細は [Timeline パネル設計書](./Grimodex_Timelineパネル設計書.md) および [Codex パネル設計書](./Grimodex_Codexパネル設計書.md) の Phase 解決アルゴリズム節を参照。

### tree_nodes

Folder/Scene/Noteの統一ツリー。Fractional Indexing（sort_order REAL）で挿入時の再ソートを回避。

```sql
CREATE TABLE tree_nodes (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id         TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,  -- NULL = Project直下
  node_type         TEXT NOT NULL,        -- 'folder'|'scene'|'note'
  title             TEXT NOT NULL DEFAULT 'Untitled',
  synopsis          TEXT,                  -- Sceneのみ: シーン要約（プレーンテキスト）。storySoFarコンテキスト注入に使用
  sort_order        REAL NOT NULL,        -- Fractional Indexing（reading-order = ツリーDFS順）
  status            TEXT DEFAULT 'outline', -- Sceneのみ: 'outline'|'draft'|'complete'|'revision'|'final'
  content           TEXT NOT NULL DEFAULT '{}',  -- Scene/Note本文（ProseMirror JSON）
  story_time_order  INTEGER,               -- Sceneのみ: 作中時間の順序比較用整数（大小関係のみ意味を持つ）。NULL = 未設定
  story_time_label  TEXT,                   -- Sceneのみ: 表示用ラベル（例: '帝国暦1024年3月', 'Day 3 morning'）。NULL = 未設定
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tree_parent ON tree_nodes(project_id, parent_id, sort_order);
CREATE INDEX idx_tree_story_time ON tree_nodes(project_id, story_time_order)
  WHERE story_time_order IS NOT NULL;
```

Scene/Noteの本文は `content` カラムに直接格納する。

**時間軸カラムの設計意図**:
- `sort_order` は**reading-order（読者順）**を表現する。Fractional Indexing（REAL）で D&D 挿入時の再ソートを回避
- `story_time_order` は**story-time（作中時間）**を表現する。整数で大小比較のみ行う。架空世界の暦・相対時間・SFの年号など柔軟に扱える
- `story_time_label` は表示用で `story_time_order` から独立。同じ order でもラベルだけ自由に変更できるし、label だけ先に決めて order は後で設定する運用も可能
- Folder/Note ノードでは `story_time_order` / `story_time_label` は未使用（Timeline パネルが葉 Scene のみ扱う）
- `write-order（執筆順）`は `created_at` で表現される（専用カラムは不要）
- 詳細は Timeline パネル設計書（`Grimodex_Timelineパネル設計書.md`）と Codex パネル設計書のフェーズシステム節を参照

### codex_types

Codexエントリのタイプ定義。ビルトイン4タイプ（character/location/item/lore）に加え、プロジェクト単位でカスタムタイプを追加可能。プロジェクト作成時にビルトイン4行をシードする。

```sql
CREATE TABLE codex_types (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,            -- 'character', 'faction', 'magic_system' etc.
  label         TEXT NOT NULL,            -- '勢力', '魔法体系' etc.（表示用）
  color         TEXT NOT NULL DEFAULT '#888888',  -- カテゴリドット色（hex）
  palette_index INTEGER,                 -- カラーパレット自動割り当て用インデックス
  icon          TEXT,                     -- lucide icon名（optional）
  is_builtin    INTEGER NOT NULL DEFAULT 0,  -- 1: ビルトイン（削除・slug変更不可）
  sort_order    REAL NOT NULL DEFAULT 0.0,   -- フィルタタブの表示順
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, slug)
);

CREATE INDEX idx_codex_types_project ON codex_types(project_id);
```

ビルトインタイプのシード値:

| slug | label | color | palette_index | sort_order |
|------|-------|-------|---------------|------------|
| `character` | キャラクター | `#534AB7` | 0 | 0.0 |
| `location` | 場所 | `#0F6E56` | 1 | 1.0 |
| `item` | アイテム | `#BA7517` | 2 | 2.0 |
| `lore` | 伝承 | `#993C1D` | 3 | 3.0 |

slug命名規則: `/^[a-z][a-z0-9_]{0,31}$/`。

### codex_entries

世界設定エントリ。content本文は `content` カラムに直接格納。アイコン画像は `icon` TEXTカラムにbase64 data URL形式で格納（128×128px WebP）。

`type` カラムは `codex_types.slug` を参照（論理参照、FKなし）。`context_mode` でAIコンテキスト注入の振る舞いを制御。`tags_cache` はFTS5用の非正規化キャッシュ（正規データは `codex_entry_tags` テーブル）。

```sql
CREATE TABLE codex_entries (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id               TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,   -- リレーション（親エントリ）
  type                    TEXT NOT NULL DEFAULT 'character',   -- codex_types.slug を参照
  name                    TEXT NOT NULL DEFAULT 'Untitled',
  aliases                 TEXT,            -- JSON array: ["エララ", "the apprentice"]
  excluded_aliases        TEXT,            -- JSON array: ["青い", "青の", "青く"]
  summary                 TEXT,            -- 短い要約（1-2文）
  content                 TEXT NOT NULL DEFAULT '{}',  -- 本文（ProseMirror JSON）
  icon                    TEXT,            -- アイコン画像（128×128 WebP、base64 data URL、nullable）
  tags_cache              TEXT,            -- FTS5用非正規化キャッシュ（JSON array）
  context_mode            TEXT NOT NULL DEFAULT 'mentioned'
                            CHECK(context_mode IN ('always', 'mentioned', 'suppress', 'hidden')),
  children_budget         TEXT NOT NULL DEFAULT 'compact'       -- サブツリートークン予算プリセット
                            CHECK(children_budget IN ('none', 'compact', 'standard', 'generous')),
  source_chat_message_id  TEXT REFERENCES chat_messages(id),   -- 抽出元チャット（nullable）
  notes                   TEXT,            -- プライベートメモ（ProseMirror JSON）。AIコンテキストには注入されない
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_codex_project ON codex_entries(project_id, type);
CREATE INDEX idx_codex_name    ON codex_entries(project_id, name);
CREATE INDEX idx_codex_parent  ON codex_entries(parent_id);
```

> **`type` カラムのバリデーション:** `codex_types` テーブルとのFKは設定しない（`codex_types` は複合主キー `(project_id, slug)` であり、`type` カラムは `slug` のみを保持するため）。代わりにDrizzle ORMのカスタムバリデーションでinsert/update時に `(project_id, type)` の組み合わせが `codex_types` に存在することをアプリ層で検証する。

context_mode の動作:

| モード | 動作 | ピン留め |
|--------|------|---------|
| `always` | シーン内の言及有無に関わらず常に注入 | 可（ピン時はcontent全文） |
| `mentioned`（デフォルト） | シーン内で検出された場合に注入 | 可 |
| `suppress` | 自動検出では注入しない。ピン留めで上書き可 | 可（ピンが明示的意思） |
| `hidden` | AIコンテキストに一切含めない | 不可 |

children_budget の動作:
- 親エントリが注入対象になった場合、子孫エントリのsummaryをサブツリートークン予算の範囲内でBFS（幅優先）順に自動注入する
- プリセット値はLayer 4予算に対する比率として定義。モデルのコンテキスト上限に応じて実トークン数が自動スケールする:
  | プリセット | Layer 4比率 | 200kモデル時の実効値 | 1Mモデル時の実効値 |
  |-----------|-----------|-------------------|------------------|
  | `none` | 0% | 0 | 0 |
  | `compact`（デフォルト） | 15% | ~6,000 tok | ~30,000 tok |
  | `standard` | 30% | ~12,000 tok | ~60,000 tok |
  | `generous` | 50% | ~20,000 tok | ~100,000 tok |
- 手動ピン（Pin with children）は予算を無視する
- 詳細はCodexパネル設計書「サブツリートークン予算」セクション参照

### codex_relation_dismissed

Codex Content内の言及からのリレーション提案をDismissした記録。

```sql
CREATE TABLE codex_relation_dismissed (
  entry_id     TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  dismissed_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, dismissed_id)
);
```

### codex_tags

構造化タグ定義。タグごとにオプションで適用可能なCodexタイプを制限できる。

```sql
CREATE TABLE codex_tags (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT,              -- hex e.g. '#ff6b6b'（nullable）
  type_filter TEXT,              -- JSON string[] of allowed type slugs, NULL = 全タイプ
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, name)
);

CREATE INDEX idx_codex_tags_project ON codex_tags(project_id);
```

### codex_entry_tags

エントリ↔タグの多対多リレーション。変更時はアプリ層で `codex_entries.tags_cache` を同期更新すること（FTS5トリガーの発火に必要）。

```sql
CREATE TABLE codex_entry_tags (
  entry_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES codex_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, tag_id)
);

CREATE INDEX idx_codex_entry_tags_tag ON codex_entry_tags(tag_id);
```

### codex_detail_definitions

タイプごとのカスタムフィールド定義。各フィールドはAIコンテキスト注入の有無を個別制御可能。

```sql
CREATE TABLE codex_detail_definitions (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type_slug         TEXT NOT NULL,         -- 適用対象の codex_types.slug
  name              TEXT NOT NULL,         -- フィールド名 e.g. '種族', '所属勢力'
  field_type        TEXT NOT NULL DEFAULT 'text',
                                           -- 'text' | 'dropdown' | 'codex_reference'
  field_config      TEXT,                  -- JSON（field_typeごとに構造が異なる、後述）
  sort_order        REAL NOT NULL DEFAULT 0.0,
  include_in_context INTEGER NOT NULL DEFAULT 0,  -- 1: AIコンテキストに含める
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, type_slug, name)
);

CREATE INDEX idx_codex_detail_defs
  ON codex_detail_definitions(project_id, type_slug, sort_order);
```

field_config のJSON構造:

| field_type | field_config | 例 |
|-----------|-------------|-----|
| `text` | `{}` | `{}` |
| `dropdown` | `{ "options": string[] }` | `{ "options": ["人間", "エルフ", "ドワーフ"] }` |
| `codex_reference` | `{ "allowedTypes": string[] \| null }` | `{ "allowedTypes": ["faction"] }` |

### codex_detail_values

エントリごとのカスタムフィールド値。

```sql
CREATE TABLE codex_detail_values (
  id            TEXT PRIMARY KEY,
  entry_id      TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  definition_id TEXT NOT NULL REFERENCES codex_detail_definitions(id) ON DELETE CASCADE,
  value         TEXT,   -- text: ProseMirror JSON, dropdown: 選択肢文字列, codex_reference: エントリID
  UNIQUE(entry_id, definition_id)
);

CREATE INDEX idx_codex_detail_values_entry ON codex_detail_values(entry_id);
CREATE INDEX idx_codex_detail_values_def   ON codex_detail_values(definition_id);
```

### snippets

再利用可能なテキスト断片。content本文は `content` カラムにProseMirror JSON形式で格納する。タグは `snippet_entry_tags` テーブルで `codex_tags` と共有プールを使用し、`tags_cache` に非正規化キャッシュを保持する。

```sql
CREATE TABLE snippets (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL DEFAULT 'Untitled',
  content                 TEXT NOT NULL DEFAULT '{}',  -- ProseMirror JSON
  tags_cache              TEXT,            -- 非正規化キャッシュ: JSON {name, color}[] from snippet_entry_tags
  scene_id                TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,      -- 作成元シーン（nullable）
  source_chat_message_id  TEXT REFERENCES chat_messages(id),   -- 抽出元チャット（nullable）
  usage_count             INTEGER NOT NULL DEFAULT 0,
  content_source          TEXT,            -- 'human'|'ai' — テキストの帰属ソース
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_snippets_project ON snippets(project_id, created_at DESC);
```

> **`tags` カラムの廃止:** 初期設計ではSnippetのタグを `TEXT` JSON配列で保持していたが、Codexと共通のタグプール（`codex_tags`）を使う要件が発生したため、`snippet_entry_tags` リレーションテーブルに移行。`tags_cache` はFTS5トリガー用の非正規化キャッシュとして残す。

### chat_sessions

チャットセッション。node_id NULLはプロジェクトスコープ。

```sql
CREATE TABLE chat_sessions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  node_id       TEXT REFERENCES tree_nodes(id),   -- NULLの場合はプロジェクトスコープ
  title         TEXT NOT NULL DEFAULT 'New session',
  title_manual  INTEGER NOT NULL DEFAULT 0,        -- 1: 手動リネーム済み、自動再生成を抑制
  model         TEXT NOT NULL DEFAULT 'openrouter/anthropic/claude-sonnet-4.6',
  pinned_codex  TEXT,           -- JSON array of {id, source} objects. source: 'manual' | 'chat_mention'
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_sessions_node ON chat_sessions(project_id, node_id);
```

### chat_messages

チャットメッセージ。セッション削除時にCASCADE削除。

```sql
CREATE TABLE chat_messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content       TEXT NOT NULL,
  model         TEXT,               -- assistantメッセージのみ: 使用モデル名
  tokens_in     INTEGER,            -- 入力トークン数
  tokens_out    INTEGER,            -- 出力トークン数
  duration_ms   INTEGER,            -- 生成時間（ミリ秒）
  metadata      TEXT,               -- JSON: { extractedCodex: [...], extractedSnippets: [...] }
  is_starred    INTEGER NOT NULL DEFAULT 0,   -- 1: ユーザーがスター付け（要約時に保護）
  is_summarized INTEGER NOT NULL DEFAULT 0,   -- 1: プログレッシブ要約済み
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at);
```

### authorship_spans

AI帰属追跡。エディタの自動保存時にTipTap AuthorshipMarkから同期。
対象ドキュメントの種別に応じて `node_id`、`codex_entry_id`、`snippet_id`、`detail_value_id` のいずれか1つのみを設定する。`phase_id` はCodexエントリのフェーズ `contentOverride` 編集時の帰属追跡に使用。

```sql
CREATE TABLE authorship_spans (
  id              TEXT PRIMARY KEY,
  node_id         TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,       -- Scene/Note の場合
  codex_entry_id  TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,     -- Codex content の場合
  snippet_id      TEXT REFERENCES snippets(id) ON DELETE CASCADE,          -- Snippet content の場合
  detail_value_id TEXT REFERENCES codex_detail_values(id) ON DELETE CASCADE, -- Codex カスタムディテール text フィールドの場合
  from_pos        INTEGER NOT NULL,
  to_pos          INTEGER NOT NULL,
  source          TEXT NOT NULL CHECK(source IN ('human', 'ai', 'unknown')),
  model           TEXT,                -- AI生成時のモデル名
  timestamp       TEXT,                -- ISO 8601
  chat_msg_id     TEXT,                -- 抽出元チャットメッセージID（nullable）
  phase_id        TEXT REFERENCES codex_entry_phases(id) ON DELETE CASCADE,  -- フェーズcontentOverride帰属追跡用（nullable）
  -- node_id, codex_entry_id, snippet_id, detail_value_id のいずれか1つのみNOT NULL
  CHECK (
    (CASE WHEN node_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN codex_entry_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN snippet_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN detail_value_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  )
);

CREATE INDEX idx_authorship_node ON authorship_spans(node_id, source);
CREATE INDEX idx_authorship_codex ON authorship_spans(codex_entry_id, source);
CREATE INDEX idx_authorship_snippet ON authorship_spans(snippet_id, source);
CREATE INDEX idx_authorship_detail ON authorship_spans(detail_value_id, source);
```

### codex_quick_pins

Codexエントリのクイックピン永続化。サイドバーに常時表示するエントリを記録する。

```sql
CREATE TABLE codex_quick_pins (
  entry_id TEXT PRIMARY KEY REFERENCES codex_entries(id) ON DELETE CASCADE
);
```

### chat_summaries

プログレッシブ要約。長いチャット会話をコンテキストウィンドウに収めるため、古いメッセージ群を要約して圧縮する。要約済みメッセージは `chat_messages.is_summarized = 1` でマークされる。

```sql
CREATE TABLE chat_summaries (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  summary             TEXT NOT NULL,
  source_message_ids  TEXT NOT NULL,        -- JSON string[]: 要約元メッセージIDの配列
  token_count         INTEGER,             -- 要約テキストの推定トークン数
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_summaries_session ON chat_summaries(session_id, created_at);
```

### snippet_entry_tags

Snippet↔タグの多対多リレーション。Codexと共通の `codex_tags` タグプールを使用する。変更時はアプリ層で `snippets.tags_cache` を同期更新すること（FTS5トリガーの発火に必要）。

```sql
CREATE TABLE snippet_entry_tags (
  snippet_id TEXT NOT NULL REFERENCES snippets(id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES codex_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (snippet_id, tag_id)
);

CREATE INDEX idx_snippet_entry_tags_tag_id ON snippet_entry_tags(tag_id);
```

### codex_entry_phases

Codexエントリの経時的変化（フェーズ）。物語の進行に伴うキャラクターの状態変化や設定の変遷を、ツリーノード（シーン/フォルダ）にアンカーして管理する。`anchor_node_id` 以降のシーンでは、対応するフィールドのオーバーライド値がベースエントリの値に代わって使用される。

```sql
CREATE TABLE codex_entry_phases (
  id                    TEXT PRIMARY KEY,
  entry_id              TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  anchor_node_id        TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,  -- フェーズ発動起点ノード
  label                 TEXT NOT NULL DEFAULT '',      -- フェーズ名（表示用）
  summary_override      TEXT,            -- ベースsummaryのオーバーライド
  content_override      TEXT,            -- ベースcontentのオーバーライド（ProseMirror JSON）
  context_mode_override TEXT,            -- ベースcontext_modeのオーバーライド
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_codex_phases_entry ON codex_entry_phases(entry_id);
CREATE INDEX idx_codex_phases_anchor ON codex_entry_phases(anchor_node_id);
```

### codex_phase_detail_overrides

フェーズごとのカスタムディテール値オーバーライド。ベースの `codex_detail_values` に対して、特定フェーズで異なる値を設定する場合に使用する。

```sql
CREATE TABLE codex_phase_detail_overrides (
  phase_id      TEXT NOT NULL REFERENCES codex_entry_phases(id) ON DELETE CASCADE,
  definition_id TEXT NOT NULL REFERENCES codex_detail_definitions(id) ON DELETE CASCADE,
  value         TEXT,
  PRIMARY KEY (phase_id, definition_id)
);

CREATE INDEX idx_phase_detail_overrides_phase ON codex_phase_detail_overrides(phase_id);
```

> **PKの設計判断:** サロゲートキー `id` は不要。`(phase_id, definition_id)` の複合主キーが自然キーであり、このテーブルを参照する外部キーは存在しない。

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

Codexエントリの検索用。name + aliases + summary + tags_cache を対象。tags_cacheは `codex_entry_tags` の非正規化キャッシュ。

```sql
CREATE VIRTUAL TABLE codex_fts USING fts5(
  name,
  aliases,
  summary,
  tags_cache,
  content=codex_entries,
  content_rowid=rowid,
  tokenize='trigram'
);
```

### snippets_fts

Snippetの検索用。title + content + tags_cache を対象。

```sql
CREATE VIRTUAL TABLE snippets_fts USING fts5(
  title,
  content,
  tags_cache,
  content='snippets',
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

### tree_nodes_fts

ツリーノード（シーン/ノート）の検索用。title + content を対象。

```sql
CREATE VIRTUAL TABLE tree_nodes_fts USING fts5(
  title,
  content,
  content=tree_nodes,
  content_rowid=rowid,
  tokenize='trigram'
);
```

---

## FTS5 同期トリガー

各FTS5仮想テーブルをソーステーブルと自動同期するトリガー。

全てのUPDATEトリガーにはWHENガードを設定し、FTS対象カラムが変更された場合のみFTSインデックスを更新する（`updated_at` のみの更新でFTS再インデックスが走るのを防止）。

### codex_fts トリガー

```sql
CREATE TRIGGER codex_fts_ai AFTER INSERT ON codex_entries BEGIN
  INSERT INTO codex_fts(rowid, name, aliases, summary, tags_cache)
    VALUES (new.rowid, COALESCE(new.name, ''), COALESCE(new.aliases, ''),
            COALESCE(new.summary, ''), COALESCE(new.tags_cache, ''));
END;

CREATE TRIGGER codex_fts_ad AFTER DELETE ON codex_entries BEGIN
  INSERT INTO codex_fts(codex_fts, rowid, name, aliases, summary, tags_cache)
    VALUES ('delete', old.rowid, COALESCE(old.name, ''), COALESCE(old.aliases, ''),
            COALESCE(old.summary, ''), COALESCE(old.tags_cache, ''));
END;

CREATE TRIGGER codex_fts_au AFTER UPDATE ON codex_entries
  WHEN old.name IS NOT new.name OR old.aliases IS NOT new.aliases
    OR old.summary IS NOT new.summary OR old.tags_cache IS NOT new.tags_cache
BEGIN
  INSERT INTO codex_fts(codex_fts, rowid, name, aliases, summary, tags_cache)
    VALUES ('delete', old.rowid, COALESCE(old.name, ''), COALESCE(old.aliases, ''),
            COALESCE(old.summary, ''), COALESCE(old.tags_cache, ''));
  INSERT INTO codex_fts(rowid, name, aliases, summary, tags_cache)
    VALUES (new.rowid, COALESCE(new.name, ''), COALESCE(new.aliases, ''),
            COALESCE(new.summary, ''), COALESCE(new.tags_cache, ''));
END;
```

### snippets_fts トリガー

```sql
CREATE TRIGGER snippets_fts_ai AFTER INSERT ON snippets BEGIN
  INSERT INTO snippets_fts(rowid, title, content, tags_cache)
    VALUES (new.rowid, new.title, new.content, COALESCE(new.tags_cache, ''));
END;

CREATE TRIGGER snippets_fts_ad AFTER DELETE ON snippets BEGIN
  INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags_cache)
    VALUES ('delete', old.rowid, old.title, old.content, COALESCE(old.tags_cache, ''));
END;

CREATE TRIGGER snippets_fts_au AFTER UPDATE ON snippets
  WHEN old.title IS NOT new.title OR old.content IS NOT new.content
    OR old.tags_cache IS NOT new.tags_cache
BEGIN
  INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags_cache)
    VALUES ('delete', old.rowid, old.title, old.content, COALESCE(old.tags_cache, ''));
  INSERT INTO snippets_fts(rowid, title, content, tags_cache)
    VALUES (new.rowid, new.title, new.content, COALESCE(new.tags_cache, ''));
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

CREATE TRIGGER chat_messages_fts_au AFTER UPDATE ON chat_messages
  WHEN old.content IS NOT new.content
BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  INSERT INTO chat_messages_fts(rowid, content)
    VALUES (new.rowid, new.content);
END;
```

### tree_nodes_fts トリガー

```sql
CREATE TRIGGER tree_nodes_fts_ai AFTER INSERT ON tree_nodes BEGIN
  INSERT INTO tree_nodes_fts(rowid, title, content)
    VALUES (new.rowid, COALESCE(new.title, ''), COALESCE(new.content, ''));
END;

CREATE TRIGGER tree_nodes_fts_ad AFTER DELETE ON tree_nodes BEGIN
  INSERT INTO tree_nodes_fts(tree_nodes_fts, rowid, title, content)
    VALUES ('delete', old.rowid, COALESCE(old.title, ''), COALESCE(old.content, ''));
END;

CREATE TRIGGER tree_nodes_fts_au AFTER UPDATE ON tree_nodes
  WHEN old.title IS NOT new.title OR old.content IS NOT new.content
BEGIN
  INSERT INTO tree_nodes_fts(tree_nodes_fts, rowid, title, content)
    VALUES ('delete', old.rowid, COALESCE(old.title, ''), COALESCE(old.content, ''));
  INSERT INTO tree_nodes_fts(rowid, title, content)
    VALUES (new.rowid, COALESCE(new.title, ''), COALESCE(new.content, ''));
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

## content_versions

コンテンツのリビジョン履歴。自動リビジョン（前回から最低間隔経過時、デフォルト5分）と手動リビジョン（`Ctrl+S`）を保存。エンティティごとに保持上限（デフォルト50件）を超えた場合、auto優先で古いものからFIFO削除する。詳細は [`Grimodex_リビジョン履歴設計書.md`](Grimodex_リビジョン履歴設計書.md) を参照。

```sql
CREATE TABLE content_versions (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  entity_type    TEXT NOT NULL CHECK(entity_type IN ('scene', 'note', 'codex_entry', 'snippet')),
  entity_id      TEXT NOT NULL,    -- tree_nodes.id / codex_entries.id / snippets.id
  content        TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  snapshot_type  TEXT NOT NULL DEFAULT 'auto' CHECK(snapshot_type IN ('auto', 'manual')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_type, entity_id, version_number)
);

CREATE INDEX idx_cv_entity ON content_versions(entity_type, entity_id, version_number DESC);
```

### project_snapshots

プロジェクト全体のプロジェクトスナップショット。各エンティティの `content_versions` へのポインタを `project_snapshot_entries` で保持する軽量方式。詳細は [`Grimodex_リビジョン履歴設計書.md`](Grimodex_リビジョン履歴設計書.md) を参照。

```sql
CREATE TABLE project_snapshots (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_project_snapshots ON project_snapshots(project_id, created_at DESC);
```

### project_snapshot_entries

プロジェクトスナップショットと各エンティティのリビジョンの紐付け。参照先の `content_versions` レコードはプルーニングから保護される。

```sql
CREATE TABLE project_snapshot_entries (
  snapshot_id TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
  version_id  TEXT NOT NULL REFERENCES content_versions(id),
  PRIMARY KEY (snapshot_id, version_id)
);
```

---

## ファイルシステム構成

コンテンツは全てDBに格納。ファイルシステムにはバックアップとマイグレーションのみ保存。

```
{project_name}.novel/
├── project.db                          ← SQLiteデータベース（全コンテンツ含む）
├── .grimodex/
│   └── workspace.json                  ← ワークスペースID + 作成日時
├── backups/                            ← 自動バックアップ（ZIP）
│   └── ...
└── migrations/                         ← DBマイグレーションファイル
```

---

## JSON カラム仕様

SQLiteにはネイティブJSON型がないため、TEXT カラムにJSON文字列を保存する。

| テーブル.カラム | JSON構造 | 例 |
|---------------|---------|-----|
| `codex_entries.aliases` | `string[]` | `["エララ", "the apprentice"]` |
| `codex_entries.excluded_aliases` | `string[]` | `["青い", "青の", "青く"]` |
| `codex_entries.tags_cache` | `string[]` | `["protagonist", "mage"]`（FTS5用非正規化キャッシュ） |
| `codex_tags.type_filter` | `string[] \| null` | `["character", "lore"]` または `null`（全タイプ） |
| `codex_detail_definitions.field_config` | `object` | `{"multiline":true}`, `{"options":["人間","エルフ"]}`, `{"allowedTypes":["faction"]}` |
| `snippets.tags_cache` | `{name: string, color: string}[]` | `[{"name":"dialogue","color":"#ff6b6b"}]`（snippet_entry_tagsの非正規化キャッシュ） |
| `chat_sessions.pinned_codex` | `{id: string, source: 'manual' \| 'chat_mention'}[]` | `[{"id":"codex-id-1","source":"manual"},{"id":"codex-id-2","source":"chat_mention"}]` |
| `chat_summaries.source_message_ids` | `string[]` | `["msg-001", "msg-002", "msg-003"]` |
| `chat_messages.metadata` | `object` | `{"extractedCodex":["id1"],"extractedSnippets":["id2"]}` |
| `settings.value` | `any` | `"16"`, `"system"`, `"true"` |

SQLite 3.38+の `json()` / `json_extract()` 関数でクエリ内でのJSON操作が可能。ただしDrizzle ORM経由のアプリケーション層でのパース/シリアライズを基本とする。

---

## マイグレーション方針

- スキーマ定義（DDL）は Rust 側の `src-tauri/src/database.rs` `Database::migrate()` メソッドで一元管理
- TypeScript 側の `src/db/schema.ts` は Drizzle ORM のクエリビルダー用スキーマ定義のみ（DDL生成なし）
- `drizzle-kit` によるマイグレーションファイル生成は使用しない（sqlite-proxy構成のため）
- アプリ起動時（ワークスペースオープン時）に `Database::migrate()` が自動実行される
- FTS5仮想テーブル・トリガー・シードデータは全て `migrate()` 内で定義
- スキーマ変更時は `database.rs` と `schema.ts` と本設計書の3箇所を同期更新すること

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

### 4. authorship_spans のCodex/Snippet対応

Codex/SnippetのcontentがEditorタブとして開けるようになったため、`node_id` を必須からnullableに変更し、`codex_entry_id`、`snippet_id` を追加。CHECK制約で3つのうちいずれか1つのみNOT NULLを保証。Editor設計書のCREATE TABLEは本スキーマへの参照に置き換え済み。

---

## スキーマリセット（2026-04-13）

v1〜v7のインクリメンタルマイグレーションを全て統合し、クリーンな初期スキーマとして再構成。以下の変更を含む:

### 統合された変更

| 元バージョン | 変更内容 |
|------------|---------|
| v1 | `snippets.content_source`、`codex_entries.children_budget`、`codex_entries.notes`、`codex_types.palette_index` の追加 |
| v2 | FTS5 UPDATE トリガーの WHEN ガード追加 |
| v3 | `tree_nodes.node_type` のレガシー値（'part'/'chapter'）を 'folder' に統合 |
| v4 | `codex_quick_pins` テーブル追加 |
| v5 | `chat_messages.is_starred`/`is_summarized`、`chat_summaries` テーブル追加 |
| v6 | `snippet_entry_tags` テーブル、`snippets.tags_cache` 追加 |
| v7 | `codex_entry_phases`、`codex_phase_detail_overrides` テーブル、`authorship_spans.phase_id` 追加 |

### リセット時の追加修正

- `codex_entries.icon`: BLOB → TEXT（base64 data URL形式）に変更
- `snippets.tags`: レガシーカラム削除（`snippet_entry_tags` + `tags_cache` で代替）
- `snippets_fts`: インデックス対象を `tags` → `tags_cache` に変更
- `tree_nodes_fts`: 仮想テーブル+トリガーを設計書に追記
- `codex_phase_detail_overrides`: サロゲートキー `id` 削除、複合PK `(phase_id, definition_id)` に変更
- `authorship_spans.detail_value_id`: 設計書記載だが未実装だったカラムをスキーマに追加（エディタ連携は別タスク）
- 全テーブルの ON DELETE アクション（CASCADE/SET NULL）を明示化

---

## Timelineパネル導入に伴う追加（2026-04-21）

Timelineパネル設計書の策定に伴い、Phase解決で使う時間軸を「読者順」と「作中時間」に分離。既存スキーマに以下を追加。

### 追加カラム / インデックス

| テーブル | カラム | 型 | 用途 |
|---------|-------|----|----|
| `projects` | `phase_resolution_mode` | `TEXT NOT NULL DEFAULT 'reading' CHECK(... IN ('auto','reading','story'))` | Phase解決の軸を決めるプロジェクト単位の設定 |
| `tree_nodes` | `story_time_order` | `INTEGER` | Scene の作中時間順序（比較専用整数、NULL=未設定） |
| `tree_nodes` | `story_time_label` | `TEXT` | Scene の作中時間表示用ラベル（順序とは独立） |
| `tree_nodes` | `idx_tree_story_time` | 部分インデックス | `(project_id, story_time_order) WHERE story_time_order IS NOT NULL` |

### 設計上の不変条件

- **Phase の anchor は `scene_id` のまま**。時間軸の違いは「同じアンカーを異なる順序で並べ替える」ことで表現する。アンカー自体の意味は変えない。
- **write-order（`created_at`順）は Phase 解決に一切使わない**。後から書いたシーンが過去の Phase を書き換える挙動は意図と合わないため、明示的に禁止。
- **`story_time_order` は整数比較のみ**。年月日・暦・相対時刻などはアプリ層が `story_time_label` にマッピング。DBは順序関係のみを保証する。
- **`story_time_order` が NULL のシーン**は、`resolveCodexState` 側で「直前の story_time_order を継承」または「reading-order にフォールバック」する（モードにより挙動が異なる）。詳細は Codex パネル設計書を参照。

### マイグレーション方針

- SQLデフォルト `'reading'` により既存プロジェクトは従来通り読者順で解決される（後方互換）。
- 新規プロジェクト作成時のアプリ層デフォルトは `'auto'` とし、作中時間を入力した瞬間から自動で story-time 解決に切り替わるようにする。
- `story_time_order` / `story_time_label` は NULL 許容で追加するのみ。既存シーンへの一括設定は不要。
