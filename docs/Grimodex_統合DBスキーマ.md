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
| `codex_dismissed_relations` | 通常 | Codex | リレーション提案のDismiss記録 |
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
| `chat_session_pinned_codex` | 通常 | Chat | セッションごとのピン留め Codex/Snippet |
| `chat_messages` | 通常 | Chat | チャットメッセージ |
| `chat_summaries` | 通常 | Chat | プログレッシブ要約 |
| `chat_summary_messages` | 通常 | Chat | 要約のソースメッセージ集合 |
| `content_versions` | 通常 | Editor | コンテンツのリビジョン履歴 |
| `project_snapshots` | 通常 | Editor | プロジェクト全体のプロジェクトスナップショット |
| `project_snapshot_entries` | 通常 | Editor | プロジェクトスナップショットとリビジョンの紐付け |
| `authorship_spans` | 通常 | Editor | AI帰属追跡スパン |
| `settings` | 通常 | Settings | Key-Value設定ストア |
| `codex_fts` | FTS5仮想 | Codex | Codexエントリの全文検索 |
| `snippets_fts` | FTS5仮想 | Snippets | Snippetの全文検索 |
| `chat_messages_fts` | FTS5仮想 | Chat History | チャットメッセージの全文検索 |
| `tree_nodes_fts` | FTS5仮想 | Scenes | ツリーノードの全文検索 |
| `map_boards` | 通常 | Map | Mapボード（v1は単一ボード固定） |
| `map_node_positions` | 通常 | Map | ノードのボード上位置情報（Scene/Codex/Note/AIのポリモーフィック参照） |
| `map_edges` | 通常 | Map | ユーザー描画エッジ |
| `map_frames` | 通常 | Map | フレーム（グループ化矩形） |
| `map_ai_nodes` | 通常 | Map | Map専用AIノード |

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
 ├──< authorship_spans (*)    node_id (nullable)
 ├──> codex_entries (?)       pov_character_id (nullable, Phase C-2)
 └──> codex_entries (?)       location_id (nullable, Phase C-2)

codex_types (1)
 └──< codex_detail_definitions (*) type_slug (論理参照、FKなし)

codex_entries (1)
 ├──< codex_entries (*)       parent_id (自己参照、リレーション)
 ├──< codex_dismissed_relations (*) entry_id, dismissed_id
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
 ├──< chat_messages (*)              session_id (ON DELETE CASCADE)
 ├──< chat_summaries (*)             session_id (ON DELETE CASCADE)
 └──< chat_session_pinned_codex (*)  session_id (ON DELETE CASCADE)

chat_summaries (1)
 └──< chat_summary_messages (*) summary_id (ON DELETE CASCADE)

chat_messages (1)
 ├──< codex_entries (*)          source_chat_message_id
 ├──< snippets (*)               source_chat_message_id
 └──< chat_summary_messages (*)  message_id (ON DELETE CASCADE)

map_boards (1)
 ├──< map_node_positions (*)  board_id
 ├──< map_edges (*)           board_id
 ├──< map_frames (*)          board_id
 └──< map_ai_nodes (*)        board_id

map_node_positions (1)
 └──< map_edges (*)           from_position_id / to_position_id

tree_nodes (1)
 └──< map_node_positions (*)  tree_node_id (nullable, scene or note)

codex_entries (1)
 └──< map_node_positions (*)  codex_entry_id (nullable)

map_ai_nodes (1)
 └──< map_node_positions (*)  ai_node_id (nullable)

chat_sessions (1)
 └──< map_ai_nodes (*)        session_id (nullable, ON DELETE SET NULL)
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

Folder/Scene/Noteの統一ツリー。文字列 fractional indexing（`sort_order TEXT`）で挿入時の再ソートを回避。

```sql
CREATE TABLE tree_nodes (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id         TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,    -- NULL = Project直下。フォルダ削除で配下ノードも連鎖削除
  node_type         TEXT NOT NULL CHECK(node_type IN ('folder','scene','note')),
  title             TEXT NOT NULL DEFAULT 'Untitled',
  synopsis          TEXT,                  -- Sceneのみ: シーン要約（プレーンテキスト）。storySoFarコンテキスト注入に使用
  sort_order        TEXT NOT NULL,        -- 文字列 fractional indexing キー（reading-order = ツリーDFS順）
  status            TEXT DEFAULT 'outline' -- Sceneのみ
                      CHECK(status IS NULL OR status IN ('outline','draft','complete','revision','final')),
  content           TEXT NOT NULL DEFAULT '{}',  -- Scene/Note本文（ProseMirror JSON）
  story_time_order  TEXT,                  -- Sceneのみ: 文字列 fractional indexing キー（作中時間順、辞書順比較）。NULL = 未設定
  story_time_label  TEXT,                   -- Sceneのみ: 表示用ラベル（例: '帝国暦1024年3月', 'Day 3 morning'）。NULL = 未設定
  -- 以下2カラムは Map Phase C-2 のマイグレーションで ALTER TABLE ADD COLUMN する
  pov_character_id  TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
                                            -- Sceneのみ: POVキャラクター（codex_entries.type='character'）。型整合性はアプリ層で保証
  location_id       TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
                                            -- Sceneのみ: 主要ロケーション（codex_entries.type='location'）。型整合性はアプリ層で保証
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tree_parent ON tree_nodes(project_id, parent_id, sort_order);
CREATE INDEX idx_tree_story_time ON tree_nodes(project_id, story_time_order)
  WHERE story_time_order IS NOT NULL;
-- 以下2インデックスは Map Phase C-2 のマイグレーションで追加
CREATE INDEX idx_tree_pov ON tree_nodes(project_id, pov_character_id)
  WHERE pov_character_id IS NOT NULL;
CREATE INDEX idx_tree_location ON tree_nodes(project_id, location_id)
  WHERE location_id IS NOT NULL;
```

Scene/Noteの本文は `content` カラムに直接格納する。

**時間軸カラムの設計意図**:
- `sort_order` は**reading-order（読者順）**を表現する。文字列 fractional indexing（npm `fractional-indexing` 互換、base62 ASCII 文字列）で D&D 挿入時の再ソートを回避。SQLite の `COLLATE BINARY`（デフォルト）で辞書順ソートが効く
- `story_time_order` は**story-time（作中時間）**を表現する。`sort_order` と同じ文字列 fractional indexing 方式。order キーは opaque な文字列で UI には露出させず、表示は `story_time_label` が担う
- `story_time_label` は表示用で `story_time_order` から独立。同じ order でもラベルだけ自由に変更できるし、label だけ先に決めて order は後で設定する運用も可能
- Folder/Note ノードでは `story_time_order` / `story_time_label` は未使用（Timeline パネルが葉 Scene のみ扱う）
- `write-order（執筆順）`は `created_at` で表現される（専用カラムは不要）
- `pov_character_id` / `location_id` は Map Phase C-2 で `ALTER TABLE ADD COLUMN` により追加される。SQLite の `codex_entries.type` が `'character'` / `'location'` であることはアプリ層で保証（FK の CHECK 制約は SQLite で cross-table 検証不可のため）
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
  source_chat_message_id  TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,   -- 抽出元チャット（nullable）
  notes                   TEXT,            -- プライベートメモ（ProseMirror JSON）。AIコンテキストには注入されない
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_codex_project ON codex_entries(project_id, type);
CREATE INDEX idx_codex_name    ON codex_entries(project_id, name);
CREATE INDEX idx_codex_parent  ON codex_entries(parent_id);
CREATE INDEX idx_codex_entries_src_msg ON codex_entries(source_chat_message_id)
  WHERE source_chat_message_id IS NOT NULL;
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

### codex_dismissed_relations

Codex Content内の言及からのリレーション提案をDismissした記録。

```sql
CREATE TABLE codex_dismissed_relations (
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
  source_chat_message_id  TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,   -- 抽出元チャット（nullable）
  usage_count             INTEGER NOT NULL DEFAULT 0,
  content_source          TEXT CHECK(content_source IS NULL OR content_source IN ('human','ai')),  -- テキストの帰属ソース
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_snippets_project ON snippets(project_id, created_at DESC);
CREATE INDEX idx_snippets_scene   ON snippets(scene_id) WHERE scene_id IS NOT NULL;
CREATE INDEX idx_snippets_src_msg ON snippets(source_chat_message_id) WHERE source_chat_message_id IS NOT NULL;
```

> **`tags` カラムの廃止:** 初期設計ではSnippetのタグを `TEXT` JSON配列で保持していたが、Codexと共通のタグプール（`codex_tags`）を使う要件が発生したため、`snippet_entry_tags` リレーションテーブルに移行。`tags_cache` はFTS5トリガー用の非正規化キャッシュとして残す。

### chat_sessions

チャットセッション。node_id NULLはプロジェクトスコープ。

```sql
CREATE TABLE chat_sessions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id       TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,   -- NULLの場合はプロジェクトスコープ。シーン削除後もセッション履歴は残す
  title         TEXT NOT NULL DEFAULT 'New session',
  title_manual  INTEGER NOT NULL DEFAULT 0,        -- 1: 手動リネーム済み、自動再生成を抑制
  model         TEXT NOT NULL DEFAULT 'openrouter/anthropic/claude-sonnet-4.6',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_sessions_node ON chat_sessions(project_id, node_id);
```

### chat_session_pinned_codex

セッションごとのピン留めされたCodexエントリ・Snippet。旧 `chat_sessions.pinned_codex` JSON カラムの正規化版で、FK により削除時の整合性を保証。並び順はピン追加時刻（`created_at` ASC）。

```sql
CREATE TABLE chat_session_pinned_codex (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  codex_entry_id TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
  snippet_id     TEXT REFERENCES snippets(id) ON DELETE CASCADE,
  with_children  INTEGER NOT NULL DEFAULT 0,
  pin_source     TEXT NOT NULL DEFAULT 'manual'
                   CHECK(pin_source IN ('manual','chat_mention')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  -- codex_entry_id と snippet_id のいずれか1つのみNOT NULL
  CHECK (
    (CASE WHEN codex_entry_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN snippet_id     IS NOT NULL THEN 1 ELSE 0 END) = 1
  )
);

CREATE INDEX idx_chat_pin_session ON chat_session_pinned_codex(session_id, created_at);
CREATE UNIQUE INDEX uq_chat_pin_codex ON chat_session_pinned_codex(session_id, codex_entry_id)
  WHERE codex_entry_id IS NOT NULL;
CREATE UNIQUE INDEX uq_chat_pin_snippet ON chat_session_pinned_codex(session_id, snippet_id)
  WHERE snippet_id IS NOT NULL;
```

`pin_source`:
- `'manual'` — 「+」ボタン、ピルプレビューのPin等のユーザー明示操作
- `'chat_mention'` — チャット入力欄で @ メンションされて送信された時の自動ピン

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
  -- node_id, codex_entry_id, snippet_id, detail_value_id のいずれか1つのみNOT NULL（所有文書）
  CHECK (
    (CASE WHEN node_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN codex_entry_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN snippet_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN detail_value_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  ),
  -- phase_id（フェーズ contentOverride 編集時）は codex_entry_id とセットで必須
  CHECK (phase_id IS NULL OR codex_entry_id IS NOT NULL)
);

CREATE INDEX idx_authorship_node ON authorship_spans(node_id, source);
CREATE INDEX idx_authorship_codex ON authorship_spans(codex_entry_id, source);
CREATE INDEX idx_authorship_snippet ON authorship_spans(snippet_id, source);
CREATE INDEX idx_authorship_detail ON authorship_spans(detail_value_id);
CREATE INDEX idx_authorship_phase ON authorship_spans(phase_id) WHERE phase_id IS NOT NULL;
```

### codex_quick_pins

Codexエントリのクイックピン永続化。サイドバーに常時表示するエントリを記録する。

```sql
CREATE TABLE codex_quick_pins (
  entry_id   TEXT PRIMARY KEY REFERENCES codex_entries(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_codex_quick_pins_created ON codex_quick_pins(created_at);
```

`created_at` により `listPinnedCodexIds` の並び順がピン追加時刻の昇順で安定化される。

### chat_summaries

プログレッシブ要約。長いチャット会話をコンテキストウィンドウに収めるため、古いメッセージ群を要約して圧縮する。要約済みメッセージは `chat_messages.is_summarized = 1` でマークされる。

```sql
CREATE TABLE chat_summaries (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  summary     TEXT NOT NULL,
  token_count INTEGER,             -- 要約テキストの推定トークン数
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_summaries_session ON chat_summaries(session_id, created_at);
```

### chat_summary_messages

プログレッシブ要約のソースメッセージ集合。旧 `chat_summaries.source_message_ids` JSON 配列の正規化版。FK により `chat_messages` 削除時にリンクも自動削除される。

```sql
CREATE TABLE chat_summary_messages (
  summary_id TEXT NOT NULL REFERENCES chat_summaries(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  PRIMARY KEY (summary_id, message_id)
);

CREATE INDEX idx_chat_summary_messages_msg ON chat_summary_messages(message_id);
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
  context_mode_override TEXT            -- ベースcontext_modeのオーバーライド
                          CHECK(context_mode_override IS NULL OR
                                context_mode_override IN ('always','mentioned','suppress','hidden')),
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
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, name)
);

CREATE INDEX idx_project_snapshots ON project_snapshots(project_id, created_at DESC);
```

### project_snapshot_entries

プロジェクトスナップショットと各エンティティのリビジョンの紐付け。参照先の `content_versions` レコードはプルーニングから保護される。

```sql
CREATE TABLE project_snapshot_entries (
  snapshot_id TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT: プルーニングはスナップショット参照中のバージョンを削除できない
  version_id  TEXT NOT NULL REFERENCES content_versions(id) ON DELETE RESTRICT,
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
| `tree_nodes` | `story_time_order` | `TEXT` | Scene の作中時間順序キー（文字列 fractional indexing、辞書順比較、NULL=未設定） |
| `tree_nodes` | `story_time_label` | `TEXT` | Scene の作中時間表示用ラベル（順序とは独立） |
| `tree_nodes` | `idx_tree_story_time` | 部分インデックス | `(project_id, story_time_order) WHERE story_time_order IS NOT NULL` |

### 設計上の不変条件

- **Phase の anchor は `scene_id` のまま**。時間軸の違いは「同じアンカーを異なる順序で並べ替える」ことで表現する。アンカー自体の意味は変えない。
- **write-order（`created_at`順）は Phase 解決に一切使わない**。後から書いたシーンが過去の Phase を書き換える挙動は意図と合わないため、明示的に禁止。
- **`story_time_order` は文字列辞書順比較のみ**。`sort_order` と同じ文字列 fractional indexing 方式（npm `fractional-indexing` 互換）。年月日・暦・相対時刻などはアプリ層が `story_time_label` にマッピング。DBは順序関係のみを保証する。
- **`sort_order` も `story_time_order` も `tree_nodes` 内では同じ方式**。順序キーは UI に露出させず、ユーザーから見える編集経路は「Scenes/Timeline ビューポート上のドラッグ」と「`story_time_label` などの表示用フィールドの編集」のみとする。
- **`story_time_order` が NULL のシーン**は、`resolveCodexState` 側で「直前の story_time_order を継承」または「reading-order にフォールバック」する（モードにより挙動が異なる）。詳細は Codex パネル設計書を参照。

### マイグレーション方針

- SQLデフォルト `'reading'` により既存プロジェクトは従来通り読者順で解決される（後方互換）。
- 新規プロジェクト作成時のアプリ層デフォルトは `'auto'` とし、作中時間を入力した瞬間から自動で story-time 解決に切り替わるようにする。
- `story_time_order` / `story_time_label` は NULL 許容で追加するのみ。既存シーンへの一括設定は不要。

### `tree_nodes.sort_order` の REAL → TEXT 移行

旧仕様では `sort_order` は REAL（浮動小数点 `(A+B)/2` 方式）だったが、Timeline パネル導入に合わせて文字列 fractional indexing に統一する。既存DBへのマイグレーション手順:

1. `tree_nodes` を `(project_id, parent_id, sort_order)` で取り出して**現在の並び順を確定**させる
2. 各兄弟グループに対して `generateNKeysBetween(null, null, n)` で新しい文字列キーを発番（`["a0","a1",...]`）
3. SQLite は `ALTER TABLE ... ALTER COLUMN` をサポートしないため、**新カラム `sort_order_new TEXT` を追加 → 値書き戻し → 旧 `sort_order` を `DROP` → リネーム** の手順を取る
4. 旧インデックス `idx_tree_parent` を再作成（型変更後）
5. アプリ起動時に一度だけ実行し、完了フラグを `meta` テーブル等で記録

**他テーブルの `sort_order` は据え置き**: `codex_types.sort_order` / `codex_detail_definitions.sort_order` は引き続き REAL 型を使う。これらは中間挿入頻度が低く（管理者が時々並べ替えるだけ）、精度劣化リスクは実害が薄いため、移行コストに見合わない。

---

## 設計レビュー反映（2026-04-24）

未リリース段階の設計レビューで検出された整合性問題を解消。`database.rs` / `schema.ts` / 本設計書を同期。

### ON DELETE アクション明示（整合性系）

| テーブル | カラム | 変更前 | 変更後 | 理由 |
|---------|-------|-------|-------|-----|
| `tree_nodes` | `parent_id` | SET NULL | **CASCADE** | フォルダ削除時に配下シーンが root に浮上する挙動を禁止 |
| `codex_entries` | `source_chat_message_id` | 未指定 | **SET NULL** | FK で履行、従来のトリガーは削除 |
| `snippets` | `source_chat_message_id` | 未指定 | **SET NULL** | 同上 |
| `project_snapshot_entries` | `version_id` | 未指定 | **RESTRICT** | スナップショット参照中のバージョンをプルーニングが削除できないよう明示 |
| `authorship_spans` | `detail_value_id` | 未指定 | **CASCADE** | 他の所有カラムと揃える |

### CHECK 制約追加（値の型安全性）

| テーブル | カラム | 許容値 |
|---------|-------|-------|
| `tree_nodes` | `node_type` | `'folder' \| 'scene' \| 'note'` |
| `tree_nodes` | `status` | `NULL \| 'outline' \| 'draft' \| 'complete' \| 'revision' \| 'final'` |
| `snippets` | `content_source` | `NULL \| 'human' \| 'ai'` |
| `codex_entry_phases` | `context_mode_override` | `NULL \| 'always' \| 'mentioned' \| 'suppress' \| 'hidden'` |

### `authorship_spans` CHECK 修正

- 所有カラム排他 CHECK に `detail_value_id` を追加して **4-way 排他**に統一（従来は 3-way）
- `phase_id` は `codex_entry_id` がセットされているときのみ許容する CHECK を追加

### UNIQUE 制約追加

- `project_snapshots(project_id, name)` — 同名スナップショットを禁止

### インデックス追加（FK 逆引き用）

- `idx_codex_entries_src_msg` on `codex_entries(source_chat_message_id)` ※部分
- `idx_snippets_scene` on `snippets(scene_id)` ※部分
- `idx_snippets_src_msg` on `snippets(source_chat_message_id)` ※部分
- `idx_authorship_phase` on `authorship_spans(phase_id)` ※部分

### トリガー削除

`source_chat_message_id` / `scene_id` の nullify-on-delete を実現していた以下トリガーは、FK の `ON DELETE SET NULL` で代替できるため削除:

- `nullify_codex_source_on_msg_delete`
- `nullify_snippet_source_on_msg_delete`
- `nullify_snippet_scene_on_node_delete`

### 並び順関連（部分対応）

| テーブル | 対応 | 理由 |
|---------|------|------|
| `codex_quick_pins` | `created_at` カラム追加、`listPinnedCodexIds` を昇順 ORDER BY | ピン順序の未定義問題を解決 |
| `codex_entries` | **据え置き** | `parent_id` は構造的ツリーではなく「リレーション」。UI 側で名前/更新日時/カテゴリ等のソートオプションで扱うため、DB 側 `sort_order` は不要 |
| `codex_entry_phases` | **据え置き** | 既に `created_at` で ORDER BY しているため安定 |

### テーブル命名のリネーム

- `codex_relation_dismissed` → `codex_dismissed_relations`（他テーブルの複数形・形容詞＋名詞の命名規則に合わせる）

### JSON カラムの正規化

旧 JSON 埋め込みカラムをリレーションテーブルに分離し、FK による整合性を担保:

| 旧カラム | 新テーブル | 効果 |
|---------|----------|------|
| `chat_sessions.pinned_codex` | `chat_session_pinned_codex` | codex/snippet 削除時にピンも自動削除、重複ピンは UNIQUE で防止 |
| `chat_summaries.source_message_ids` | `chat_summary_messages` | message 削除時にリンクも自動削除、要約→メッセージの逆引きが SQL で可能 |

---

## Mapパネル導入に伴う追加（2026-04-21）

Mapパネル設計書の策定に伴い、以下の5テーブルを追加。詳細は [Mapパネル設計書](./Grimodex_Mapパネル設計書.md) を参照。

### map_boards

プロジェクトごとのMapボード。v1では単一ボード（`title = 'Main'`）を自動作成し、追加は禁止。

```sql
CREATE TABLE map_boards (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'Main',
  sort_order  REAL NOT NULL DEFAULT 0.0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_map_boards_project ON map_boards(project_id);
```

### map_node_positions

ノードのボード上位置情報。ポリモーフィック参照（Scene/Note → `tree_node_id`、Codex → `codex_entry_id`、AI → `ai_node_id`）。

```sql
CREATE TABLE map_node_positions (
  id              TEXT PRIMARY KEY,
  board_id        TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
  node_ref_type   TEXT NOT NULL
                    CHECK(node_ref_type IN ('scene', 'codex', 'note', 'ai')),
  tree_node_id    TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
  codex_entry_id  TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
  ai_node_id      TEXT REFERENCES map_ai_nodes(id) ON DELETE CASCADE,
  x               REAL NOT NULL,
  y               REAL NOT NULL,
  pinned          INTEGER NOT NULL DEFAULT 0,  -- 1 if pinned in gravity modes
  hidden          INTEGER NOT NULL DEFAULT 0,  -- 1 if hidden on this board
  z_index         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  -- 1段目: 3つのFKのうちちょうど1つが non-null
  CHECK (
    (CASE WHEN tree_node_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN codex_entry_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN ai_node_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  ),
  -- 2段目: node_ref_type と non-null FK カラムの対応を保証
  CHECK (
    (node_ref_type IN ('scene', 'note') AND tree_node_id   IS NOT NULL AND codex_entry_id IS NULL     AND ai_node_id IS NULL) OR
    (node_ref_type = 'codex'            AND codex_entry_id IS NOT NULL AND tree_node_id   IS NULL     AND ai_node_id IS NULL) OR
    (node_ref_type = 'ai'               AND ai_node_id     IS NOT NULL AND tree_node_id   IS NULL AND codex_entry_id IS NULL)
  )
);

CREATE INDEX idx_map_pos_board ON map_node_positions(board_id);
CREATE INDEX idx_map_pos_tree  ON map_node_positions(tree_node_id);
CREATE INDEX idx_map_pos_codex ON map_node_positions(codex_entry_id);
-- SQLite の NULL 意味論: NULLを含む複合UNIQUE INDEXでは一意性が保証されないため、タイプ別部分インデックスで分割
CREATE UNIQUE INDEX idx_map_pos_uniq_scene ON map_node_positions(board_id, tree_node_id)
  WHERE tree_node_id IS NOT NULL;
CREATE UNIQUE INDEX idx_map_pos_uniq_codex ON map_node_positions(board_id, codex_entry_id)
  WHERE codex_entry_id IS NOT NULL;
CREATE UNIQUE INDEX idx_map_pos_uniq_ai    ON map_node_positions(board_id, ai_node_id)
  WHERE ai_node_id IS NOT NULL;
```

**設計判断**:
- `node_ref_type` と FK カラムの対応は2段CHECKで検証。ただし `node_ref_type='scene'` のとき `tree_nodes.node_type='scene'`（note行でない）であることは SQL では検証不可のため**アプリ層で担保する**
- UNIQUE制約はタイプ別部分インデックスで実現（SQLite NULL 意味論対応）

### map_edges

ユーザー描画エッジ。参照先は `map_node_positions.id`（ボード跨ぎエッジを禁止）。

```sql
CREATE TABLE map_edges (
  id                  TEXT PRIMARY KEY,
  board_id            TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
  from_position_id    TEXT NOT NULL REFERENCES map_node_positions(id) ON DELETE CASCADE,
  to_position_id      TEXT NOT NULL REFERENCES map_node_positions(id) ON DELETE CASCADE,
  label               TEXT,
  style               TEXT NOT NULL DEFAULT 'solid'
                        CHECK(style IN ('solid', 'dashed', 'dotted')),
  color               TEXT NOT NULL DEFAULT '#000000',
  direction           TEXT NOT NULL DEFAULT 'none'
                        CHECK(direction IN ('none', 'forward', 'bidirectional')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_map_edges_board ON map_edges(board_id);
CREATE INDEX idx_map_edges_from  ON map_edges(from_position_id);
CREATE INDEX idx_map_edges_to    ON map_edges(to_position_id);
```

### map_frames

フレーム（グループ化矩形）。ノードとの親子関係はDBに持たず、位置の重なりで判定。

```sql
CREATE TABLE map_frames (
  id            TEXT PRIMARY KEY,
  board_id      TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT 'Frame',
  x             REAL NOT NULL,
  y             REAL NOT NULL,
  width         REAL NOT NULL,
  height        REAL NOT NULL,
  background    TEXT NOT NULL DEFAULT '#f5f5f5',
  border_color  TEXT NOT NULL DEFAULT '#cccccc',
  z_index       INTEGER NOT NULL DEFAULT -1,  -- デフォルトでノードの下
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_map_frames_board ON map_frames(board_id);
```

### map_ai_nodes

Map専用AIノード。`session_id` は削除時 SET NULL（セッション削除後もノードは残るが、ダブルクリックは無効化される）。

```sql
CREATE TABLE map_ai_nodes (
  id            TEXT PRIMARY KEY,
  board_id      TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
  prompt        TEXT NOT NULL,
  response      TEXT,
  session_id    TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
  model         TEXT,
  token_usage   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_map_ai_board ON map_ai_nodes(board_id);
```

### 初期化・マイグレーション方針

- プロジェクト作成時に `map_boards` へ `title = 'Main'` の行を1行シードする
- v1 では追加ボードの作成を禁止（UIに追加ボタンを出さない）
- v2 で複数ボード対応時に `map_boards` の `sort_order` インデックスと UI を追加
- `global-settings.json` に保存していた `sceneDisplayByMode` / `colorBy` / `corkboardFeel` は v2 で `map_boards` テーブルへ移行予定
