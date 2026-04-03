# Grimodex - 製品仕様書

> バージョン: 0.2.0
> 最終更新: 2026-04-02

## 1. 製品概要

Grimodexは、Novelcrafterに着想を得た、日本語小説作家向けのデスクトップ執筆エディタである。リッチテキストエディタにAIチャットパネルと構造化ナレッジベース（Codex）を組み合わせ、AIとの対話から知識を抽出・整理し、原稿に直接活用できる。

**コア体験:** AIとチャットし、構造化された知識を抽出し、コンテキストを活用した執筆支援を受ける。

### 1.1 技術スタック

| レイヤー | 技術 |
|---------|------|
| デスクトップシェル | Tauri v2 |
| フロントエンド | React 19 + TypeScript (strict) |
| エディタ | TipTap (ProseMirror) |
| 状態管理 | Zustand (グローバル) + Jotai (ローカル) |
| UIコンポーネント | shadcn/ui |
| AI統合 | Vercel AI SDK |
| データベース | SQLite (WALモード) + FTS5 (trigram) |
| ORM | Drizzle ORM |
| ストレージ | SQLite（唯一の信頼できる情報源、ProseMirror JSON保存） + Markdownインポート/エクスポート |

### 1.2 対象ユーザー

日本語を使用する個人小説家。主な利用者は開発者本人。

---

## 2. アーキテクチャ原則

### 2.1 ストレージモデル: SQLiteファースト

すべてのコンテンツ（Scene/Note本文、Codexエントリ、Snippet）は**SQLiteに直接格納**する。SQLiteが唯一の信頼できる情報源である。

- 全文検索インデックス（FTS5 trigram）
- 帰属（authorship）追跡ストア
- Codexのメタデータとリレーション
- チャット履歴
- プロジェクト設定と状態
- **コンテンツ本文**（Scene/Note/Codex/Snippet）
- **コンテンツバージョン履歴**

**設計根拠:** 単一ファイル（project.db）で完結し、ファイル同期・命名規則・I/O管理の複雑さを排除。Markdownとの相互運用はインポート/エクスポート機能で提供する。

### 2.2 ディレクトリ構造

プロジェクトのディレクトリ構造:

```
my-novel/
  project.db                 # SQLite（全データを格納）
  .grimodex/
    workspace.json           # ワークスペースID + 作成日時
  backups/                   # 自動バックアップ（ZIP）
```

- **階層構造は `tree_nodes` テーブル**で管理（Part/Chapter/Scene/Folder/Note）
- Scene/Note/Codex/Snippetの本文は各テーブルの `content` カラムに格納
- **ソート順: fractional indexing**（`sort_order REAL` カラム）で D&D 並び替えに対応

### 2.3 ドキュメントフォーマット

各原稿ドキュメント（Scene/Note）の本文はTipTapのProseMirror JSON形式で `tree_nodes.content` カラムに格納する。メタデータ（タイトル、ステータス等）は同テーブルの他カラムで管理する。ProseMirror JSONで保存することにより、AuthorshipMark等のカスタムMarkを含むドキュメント構造がロスレスで保持され、保存時の変換コストも発生しない。

Codexエントリも同様に、メタデータは `codex_entries` テーブルの各カラム、本文は `codex_entries.content` カラムにProseMirror JSON形式で格納する。

Markdownとの相互変換は `tiptap-markdown` を使用し、インポート/エクスポート時にのみ行う（日常の保存処理では使用しない）。

### 2.4 コンテンツバージョン管理

全コンテンツにリビジョン履歴を提供する。`content_versions` テーブルにリビジョンを保存し、任意の時点の内容をプレビュー・diff表示・復元できる。

> 詳細は [`Grimodex_リビジョン履歴設計書.md`](Grimodex_リビジョン履歴設計書.md) を参照。

**リビジョンポリシー:**
- 自動保存（2秒デバウンス）は毎回実行し content カラムを上書き。リビジョンは作成しない
- 自動リビジョン: 前回リビジョンから最低間隔（デフォルト: 5分）経過時に自動作成
- 手動リビジョン: `Ctrl+S` で間隔を無視して即座に作成
- 保持上限: エンティティごとに設定可能（デフォルト: 50件）、超過時はauto優先でFIFO削除

**インポート/エクスポート:**

Markdownとの相互運用はインポート/エクスポート機能で提供する:
- **エクスポート**: DB内のコンテンツをMarkdownファイルとして出力（Scene/Note/Codex/Snippet）
- **インポート**: Markdownファイルを読み込みDBに格納

### 2.5 ワークスペースメタデータ

ワークスペースの識別情報とアプリケーション全体の設定は、それぞれ別の場所に永続化する。

**ワークスペースメタデータ（`.grimodex/workspace.json`）:**

各ワークスペースのルートにある `.grimodex/` ディレクトリに格納。ワークスペースの一意識別に使用。

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "created_at": "2026-03-31T10:00:00+09:00"
}
```

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `id` | string (UUID) | ワークスペースの一意識別子 |
| `created_at` | string (ISO8601) | 作成日時 |

**グローバル設定（OS AppData `global-settings.json`）:**

OSのアプリケーションデータディレクトリに格納。全ワークスペース共通の設定。

```json
{
  "recentWorkspaces": [
    { "path": "D:\\Novels\\MyNovel", "lastOpened": "2026-03-31T12:00:00Z" }
  ],
  "lastActiveWorkspace": "D:\\Novels\\MyNovel",
  "theme": "system",
  "showLauncherOnStartup": false
}
```

| フィールド | 型 | デフォルト | 説明 |
|-----------|-----|----------|------|
| `recentWorkspaces` | array | `[]` | 最近開いたワークスペース（最大10件、MRU順） |
| `lastActiveWorkspace` | string \| null | `null` | 最後にアクティブだったワークスペースのパス |
| `theme` | string | `"system"` | UIテーマ |
| `showLauncherOnStartup` | boolean | `false` | 起動時にランチャーを表示するか |

**ワークスペースの判定:**
- `project.db` がルートに存在するディレクトリ → 既存ワークスペース
- 空ディレクトリまたは存在しないパス → 新規ワークスペース作成可能
- 上記以外（`project.db` がないファイルを含むディレクトリ）→ 無効

---

## 3. エディタ（TipTap）

### 3.1 基本要件

- 開いているドキュメント（シーン/章）ごとに1つのTipTapインスタンス
- 標準的なリッチテキスト編集: 太字、斜体、見出し、引用ブロック、水平線
- リアルタイム文字数/単語数カウント
- 自動保存: 最後のキー入力から2000msのデバウンスでDBに書き込み（0.5〜10秒の範囲で設定可能）
- セッションごとの完全な履歴によるundo/redo

### 3.2 帰属追跡（文字単位）

> 設計判断の詳細は [ADR-001](adr/001-character-level-authorship.md) を参照。

すべてのテキストスパンは、以下の3値のいずれかを持つauthorship Mark属性を保持する:

| 値 | 意味 |
|----|------|
| `human` | ユーザーが入力したテキスト |
| `ai` | AIチャットから挿入されたテキスト（人間が編集しても `ai` のまま維持） |
| `unknown` | 出所不明（外部ペースト、既存プロジェクトのインポート、マイグレーション前のデータ等） |

**Mark属性（AuthorshipAttributes）:**

| 属性 | 型 | 説明 |
|------|----|------|
| `source` | AuthorshipSource | 上記3値のいずれか（デフォルト: `unknown`） |
| `model` | string \| null | モデル名（例: `claude-sonnet-4.6`）。AIテキストのみ |
| `timestamp` | string \| null | マーク付与時刻（ISO 8601） |
| `chatMessageId` | string \| null | 生成元のチャットメッセージID |

**実装:**

- カスタムTipTap Mark拡張: `authorship`（上記属性を保持）
- デフォルト: マークなしのテキストは `{ source: 'unknown' }` として扱う
- チャットからの「エディタに挿入」: `{ source: 'ai', model, chatMessageId }` を付与
- SnippetのD&D挿入: 元Snippetのsourceを継承
- `ai` マーク付きテキストの編集 → **`ai` のまま変わらない**（人間が手を入れても元のsourceを維持）
- 外部ペースト、AuthorshipMark未付与のテキスト → `{ source: 'unknown' }`

**永続化:**

帰属データは**SQLiteのみ**に保存（コンテンツ本文とは別に管理）。なお、ProseMirror JSON保存によりAuthorshipMarkはドキュメント構造内にも保持されるが、正規データは `authorship_spans` テーブルとする。エクスポート時のMarkdownファイルはクリーンな標準Markdownのまま維持する。

帰属のSQLiteスキーマ（正規版は `Grimodex_統合DBスキーマ.md` を参照）。対象ドキュメントの種別に応じて `node_id`（Scene/Note）、`codex_entry_id`（Codex content）、`snippet_id`（Snippet content）のいずれか1つを設定する。

- ドキュメント保存時: 現在のTipTap Markの位置をシリアライズ → `authorship_spans` を全置換更新
- ドキュメント読み込み時: SQLiteからスパンを読み込み → TipTap Markとして適用

**表示:**
- トグル可能なオーバーレイ: humanテキストは通常表示、`ai` / `unknown` はそれぞれ異なる背景色
- 帰属レポートパネル: Human / AI / Unknown の比率をバーグラフで表示（Attributionパネル設計書参照）

**エクスポート:**
- エクスポート時にはAuthorshipMarkを除外し、クリーンなMarkdownを出力する
- 将来的にAuthorship情報を含むエクスポート形式が必要になった場合は、Grimodex独自のJSON形式を定義する

### 3.3 チャットからのテキスト挿入

2つの方式を同時に提供:

1. **コピーボタン** — チャットメッセージのテキストをカスタムデータ型（`application/x-grimodex-ai-text`）でクリップボードにコピー。エディタにペーストすると `ai` マークで検出・記録。
2. **「エディタに挿入」ボタン** — プログラム的にカーソル位置にテキストを挿入し、`ai` マークを付与。

「挿入」クリック時にエディタにカーソルフォーカスがない場合は、ドキュメント末尾に挿入する。

---

## 4. AIチャットパネル

### 4.1 プロバイダー: BYOK マルチプロバイダー

BYOK（Bring Your Own Key）方式で複数のAIプロバイダーに対応する:

| プロバイダー | SDK | 備考 |
|-------------|-----|------|
| OpenRouter | Vercel AI SDK `openrouter` | 推奨デフォルト。500+モデルに単一キーでアクセス |
| Anthropic | Vercel AI SDK `anthropic` | Claude直接利用 |
| OpenAI | Vercel AI SDK `openai` | GPT-4o等 |
| Ollama | Vercel AI SDK `ollama` | ローカルモデル。オフライン対応 |

- APIキーはTauri keyring（OS認証情報マネージャー）に保存
- モデル選択: 各プロバイダーの利用可能モデルからユーザーが選択
- ストリーミング: Vercel AI SDK（ストリーミング有効）
- 拡張思考（Extended Thinking）: モデルが対応している場合は常に有効化する。Anthropic Claude の `thinking` パラメータ、OpenAI の推論トークン等、プロバイダーごとの拡張思考機能を検出し自動的に利用する。thinking ブロックはAIメッセージ内に折りたたみ式（デフォルト閉じ）で表示し、ユーザーが必要に応じて推論過程を確認できるようにする
- すべてのAPI呼び出しはRustバックエンド（Tauriコマンド）経由 — CORSの回避とキーのセキュリティ確保

### 4.2 セッションモデル

```
プロジェクト
├── プロジェクトスコープセッション（node_id = NULL、世界観構築、プロット等）
└── シーン
    ├── セッション: "プロット相談"
    ├── セッション: "文体添削"
    └── セッション: "キャラ深掘り"
```

- 各シーンは **N個のチャットセッション** を持てる
- プロジェクトスコープセッション（`node_id = NULL`）は特定のシーンに紐づかない
- セッション一覧はChatパネル内のドロワーで管理
- セッションとメッセージはSQLiteに永続化（`chat_sessions` / `chat_messages` テーブル）
- セッション自動タイトル: 軽量モデルで3〜6語のタイトルを自動生成（`title_manual = 0`）。ユーザーが手動でリネームした場合は `title_manual = 1` で自動更新をスキップ

セッションスキーマ（正規版は `Grimodex_統合DBスキーマ.md` を参照）:
```sql
CREATE TABLE chat_sessions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  node_id       TEXT REFERENCES tree_nodes(id),  -- NULL = プロジェクトスコープ
  title         TEXT NOT NULL DEFAULT '',
  title_manual  INTEGER NOT NULL DEFAULT 0,
  model         TEXT,
  pinned_codex  TEXT DEFAULT '[]',  -- JSON配列: [{id, source: 'manual'|'chat_mention'}]
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE chat_messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content     TEXT NOT NULL,
  model       TEXT,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  duration_ms INTEGER,
  metadata    TEXT DEFAULT '{}',  -- JSON: {extractedCodex, extractedSnippets}
  created_at  TEXT NOT NULL
);
```

### 4.3 コンテキスト注入（5レイヤーモデル）

LLM APIのシステムプロンプトに以下の5レイヤーを階層的に注入する:

**Layer 1: Project info（常時）**
- プロジェクトタイトル、ジャンル、視点、文体ガイド、AI指示
- 予算配分: コンテキストの ~2%（最小500tok）

**Layer 2: storySoFar（スライディングウィンドウ）**
- 現在のシーンより前の全シーンの `synopsis` を時系列順に結合し、「これまでの物語」として注入
- Synopsisが未記入のシーンはスキップ（本文フォールバックはしない — トークン爆発防止）
- トークン予算に応じて、古いシーンのSynopsisから順に切り詰め（直近のシーンを優先）
- シーンが Complete/Revision/Final に遷移した時点で未記入なら自動生成を提案（Scenesパネル設計書参照）
- 予算配分: コンテキストの ~10%

**Layer 3: Current scene + previous（常時）**
- 現在のアクティブシーンの全文
- 直前のシーンの synopsis + 末尾段落（最大3段落）
- 予算配分: コンテキストの ~40%

**Layer 4: Codex entries + Snippets**
- `context_mode` フィルタ: 各エントリの `context_mode` により注入可否を判定
  - `always`: 常に注入
  - `mentioned`: 現在のシーン内容にマッチした場合のみ
  - `suppress`: 手動ピン留め時のみ
  - `hidden`: 一切注入しない
- ピン留めされたCodexエントリ/Snippetの全文
- 子エントリの自動注入: マッチした親エントリの子孫エントリのsummaryをサブツリートークン予算の範囲内でBFS順に自動追加
- 予算配分: コンテキストの ~20%

**Layer 5: Conversation history**
- 現在のセッションのメッセージ履歴
- Progressive summarization方式（Chat設計書参照）
- 予算配分: コンテキストの ~20%

**応答予約**: コンテキストの ~5%（最小2,000tok）

**トークンバジェット管理:**
- 合計トークン数を `js-tiktoken` で計算
- **比率ベース配分**: 使用モデルのコンテキスト上限に対する比率で各レイヤーの予算を動的に算出（8kモデルと1Mモデルで同じ比率が適用される）
- 各レイヤーに最小トークン数（floor）を設定し、小コンテキストモデルでも最低限の機能を保証
- 比率はSettings > AI > コンテキスト予算配分でカスタマイズ可能
- 予算超過時の優先順位: Layer 1 > Layer 3 > Layer 2 > Layer 4 > Layer 5
- コンテキストバーに合計トークン数を常時表示

### 4.4 スラッシュコマンド

チャット入力欄で `/` プレフィクスを入力するとコマンド候補が表示される。各コマンドはシステムプロンプトに指示として注入される:

| コマンド | 説明 |
|---------|------|
| `/continue` | 現在のシーンの続きを生成 |
| `/describe {target}` | 指定対象の描写を生成 |
| `/dialogue {char}` | 指定キャラクターの台詞を生成 |
| `/summarize` | 現在のシーンを要約 |
| `/brainstorm` | アイデアを自由に発散 |
| `/rewrite` | 選択範囲を書き直し |
| `/translate {lang}` | 指定言語に翻訳 |

---

## 5. Codex（ナレッジベース）

### 5.1 エントリ構造: SQLiteメタデータ + コンテンツ

各Codexエントリは、SQLiteテーブル（`codex_entries`）にメタデータと本文を格納する:

**SQLiteメタデータ（`codex_entries` テーブル）:**

| カラム | 説明 |
|--------|------|
| `name` | エントリ名（例: 「山田太郎」） |
| `type` | タイプスラグ（`codex_types.slug` を参照） |
| `aliases` | 別名のJSON配列（例: `["太郎", "山田"]`） |
| `excluded_aliases` | 除外パターンのJSON配列（マッチング時に無視） |
| `summary` | 短い概要（コンテキスト注入時の要約として使用） |
| `tags_cache` | タグのキャッシュ（FTS5用） |
| `context_mode` | AIコンテキスト注入の制御（`always`/`mentioned`/`suppress`/`hidden`） |
| `parent_id` | 親エントリID（リレーション表現用の自己参照） |
| `source_chat_message_id` | 抽出元のチャットメッセージID |

**コンテンツ:**

`codex_entries.content` カラムに格納。フリーテキストのノート・詳細情報を記述。

**カスタムディテール（タイプごとの構造化フィールド）:**

`codex_detail_definitions` / `codex_detail_values` テーブルで、タイプごとに任意のカスタムフィールドを定義可能:

| フィールドタイプ | 説明 |
|----------------|------|
| `text` | 自由テキスト |
| `dropdown` | 選択肢リスト（`field_config` JSONで定義） |
| `codex_reference` | 他のCodexエントリへの参照 |

各フィールドには `include_in_context` フラグがあり、AIコンテキスト注入時に含めるかを制御する。

### 5.2 タイプシステム

`codex_types` テーブルでタイプを管理する。ビルトイン4種に加え、ユーザーがカスタムタイプを追加可能:

**ビルトインタイプ:**

| slug | label | 説明 |
|------|-------|------|
| `character` | キャラクター | 登場人物 |
| `location` | 場所 | 場所・舞台 |
| `item` | アイテム | 物体・アーティファクト |
| `lore` | 設定・世界観 | 魔法体系、組織、歴史、抽象的概念 |

各タイプには `color`、`icon`、`sort_order` を設定可能。`is_builtin = 1` のタイプは削除不可。

> **注:** Snippetは独立した `snippets` テーブルで管理する（5.5節参照）。Codexのタイプではない。

### 5.3 リレーション（親子ツリー）

Codexエントリは `parent_id` による自己参照で親子関係を表現する:

- 親エントリの下に子エントリをぶら下げる（例: 「カゾルミア帝国」→「帝国軍」→「第三師団」）
- コンテキスト注入時: 親エントリがマッチした場合、depth 1 の子エントリの summary を自動追加
- `codex_relation_dismissed` テーブル: システムが提案したリレーションをユーザーが却下した記録を保持（同じ提案を繰り返さない）
- MVP UI: エントリごとのリレーション一覧（追加/削除）。グラフ可視化はpost-MVP。

### 5.4 チャットからの抽出

各AIレスポンスに「Codex」ボタンを配置。クリックすると抽出ダイアログが開く。

**2つの抽出モード:**

| モード | 動作 | 用途 |
|--------|------|------|
| AI mode（デフォルト） | 軽量モデルがメッセージ内容からName/Type/Tagsを自動提案 | 素早い抽出 |
| Manual mode | フィールドは空のまま表示、ユーザーが全て入力 | 手動で正確に登録 |

**抽出フロー:**
1. AIがコンテンツを含むレスポンスを返す
2. ユーザーが「Codex」ボタンをクリック
3. ダイアログ表示: 名前、タイプ、タグ、サマリー、コンテンツ（AI modeでは事前入力）
4. ユーザーが確認 → `codex_entries` レコード作成（メタデータ + コンテンツをDBに格納）
5. `source_chat_message_id` で抽出元メッセージへの紐付けを保持

### 5.5 Snippets（テキスト断片）

Snippetは Codex とは独立した `snippets` テーブルで管理する。詳細は Snippetsパネル設計書を参照。

**作成ルート:**
1. Chat → 「Snippet」ボタン（`source_chat_message_id` と `scene_id` を自動セット）
2. Editor → 「Save as Snippet」コンテキストメニュー（`scene_id` をセット）
3. Snippetsパネル → [+] ボタン（手動作成）

**DB スキーマ（正規版は `Grimodex_統合DBスキーマ.md` を参照）:**
```sql
CREATE TABLE snippets (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id),
  title                   TEXT NOT NULL DEFAULT '',
  content                 TEXT NOT NULL DEFAULT '',
  tags                    TEXT DEFAULT '[]',
  scene_id                TEXT REFERENCES tree_nodes(id),
  source_chat_message_id  TEXT REFERENCES chat_messages(id),
  usage_count             INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
```

---

## 6. データフローと状態管理

### 6.1 状態アーキテクチャ

```
Zustand stores（グローバル）:
├── workspaceStore       — ワークスペース管理、グローバル設定、ビュー状態
├── sceneStore           — アクティブシーン、ツリー構造
├── editorStore          — エディタインスタンス、挿入追跡、ハイライト管理
├── chatStore            — セッション管理、メッセージ、ストリーミング状態
├── codexStore           — エントリ管理、検索、フィルタリング
├── snippetStore         — Snippet管理、検索、フィルタリング
├── attributionStore     — 帰属表示トグル
├── codexHighlightStore  — Codexエントリのエディタ内ハイライト状態
├── cursorSettingsStore  — カーソル位置とエディタ設定
└── aiSettingsStore      — AIプロバイダー、モデル、APIキー管理

Jotai atoms（ローカル）:
├── editorSelection   — 現在の選択範囲/カーソル位置
├── chatInput         — 現在のチャット入力テキスト
├── contextPreview    — 現在のメッセージの解決済みコンテキスト
└── panelLayout       — スプリッター位置、パネル表示状態
```

### 6.2 データフロー図

```
[Reactフロントエンド]
  ├── TipTapエディタ ←→ editorStore
  ├── チャットパネル  ←→ chatStore
  ├── Codexパネル    ←→ codexStore
  ├── Snippetパネル  ←→ snippetStore
  └── サイドバー     ←→ sceneStore
       ↕ db_execute (Drizzle proxy)
[SQLite (Drizzle ORM経由)]
  ├── コンテンツ本文（Scene/Note/Codex/Snippet）
  ├── コンテンツバージョン履歴
  ├── FTS5インデックス（Codex / Snippet / チャットメッセージ）
  ├── 帰属スパン
  ├── Codexリレーション + カスタムディテール
  ├── チャットセッション/メッセージ
  └── プロジェクト設定
```

### 6.3 主要データフロー

**執筆フロー:**
1. ユーザーがTipTapで入力 → `human` 帰属マークを適用
2. 自動保存（2000msデバウンス） → SQLiteのコンテンツと帰属スパンを更新

**AIチャットフロー:**
1. ユーザーがメッセージを入力
2. フロントエンドが5レイヤーコンテキストを構築（4.3節参照）
3. Tauriコマンド: Rustバックエンド経由でAIプロバイダーにメッセージを送信
4. レスポンスをフロントエンドにストリーミング
5. レスポンスを「Insert」「Codex」「Snippet」「Copy」ボタン付きで表示

**Codex抽出フロー:**
1. ユーザーがチャットメッセージの「Codex」をクリック
2. 抽出ダイアログが開く（AI mode: 自動提案 / Manual mode: 空欄）
3. ユーザーが確認 → `codex_entries` レコード作成（DBに格納）
4. FTS5インデックスが自動更新（トリガー経由）
5. `source_chat_message_id` で抽出元への紐付けを保持

**エディタ挿入フロー:**
1. ユーザーがチャットメッセージの「Insert」をクリック
2. カーソル位置に `{ source: 'ai', model, chatMessageId }` 帰属マーク付きでテキストを挿入
3. 次回自動保存時にSQLiteの帰属スパンを更新

---

## 7. SQLiteスキーマ

> **正規版は [`Grimodex_統合DBスキーマ.md`](Grimodex_統合DBスキーマ.md) を参照。** 以下は概要のみ。

データベース: SQLite（WALモード有効）、ORM: Drizzle ORM（sqlite-proxy）、ファイル: `project.db`

### テーブル一覧

| テーブル | 種別 | 説明 |
|---------|------|------|
| `projects` | 通常 | プロジェクトのメタ情報（タイトル、ジャンル、POV、文体ガイド等） |
| `tree_nodes` | 通常 | Part/Chapter/Scene/Folder/Note の統一ツリー（fractional indexing） |
| `codex_types` | 通常 | Codexエントリタイプ定義（ビルトイン4種 + カスタム） |
| `codex_entries` | 通常 | 世界設定エントリ（context_mode、aliases、excluded_aliases 含む） |
| `codex_relation_dismissed` | 通常 | リレーション提案のDismiss記録 |
| `codex_tags` | 通常 | 構造化タグ定義（タイプ関連付け付き） |
| `codex_entry_tags` | 通常 | エントリ↔タグの多対多リレーション |
| `codex_detail_definitions` | 通常 | カスタムディテール定義（タイプごと） |
| `codex_detail_values` | 通常 | カスタムディテール値（エントリごと） |
| `snippets` | 通常 | 再利用テキスト断片 |
| `chat_sessions` | 通常 | チャットセッション（シーン or プロジェクトスコープ） |
| `chat_messages` | 通常 | チャットメッセージ（トークン数、メタデータ含む） |
| `authorship_spans` | 通常 | AI帰属追跡スパン（source: human/ai/unknown） |
| `settings` | 通常 | Key-Value設定ストア（ドット記法: `editor.fontSize`） |
| `codex_fts` | FTS5仮想 | Codexエントリの全文検索（name, aliases, summary, tags_cache） |
| `snippets_fts` | FTS5仮想 | Snippetの全文検索（title, content, tags） |
| `chat_messages_fts` | FTS5仮想 | チャットメッセージの全文検索（trigram tokenizer） |

FTS5仮想テーブルはトリガーにより自動同期される。

---

## 8. Tauriコマンド API（Rust ↔ JSブリッジ）

### 8.1 ワークスペース管理
```rust
#[tauri::command] fn validate_workspace_path(path: String) -> Result<WorkspaceValidation>
#[tauri::command] fn open_workspace(path: String) -> Result<()>
#[tauri::command] fn get_global_settings() -> Result<GlobalSettings>
#[tauri::command] fn save_global_settings(settings: GlobalSettings) -> Result<()>
```

### 8.2 データベース操作
```rust
#[tauri::command] fn db_execute(sql: String, params: Vec<Value>) -> Result<DbResult>
// フロントエンドの Drizzle ORM (sqlite-proxy) がこのコマンドを経由してSQLを実行
// 全テーブルの CRUD はフロントエンド API 関数 (src/features/*/api.ts) で実装
```

### 8.3 インポート/エクスポート
```rust
#[tauri::command] fn export_markdown(scope: ExportScope, output_dir: String) -> Result<()>
#[tauri::command] fn import_markdown(paths: Vec<String>) -> Result<ImportResult>
```

### 8.4 AIチャット
```rust
#[tauri::command] async fn send_chat_message(...) -> Result<String>  // ストリーミング応答
#[tauri::command] fn get_ai_settings() -> Result<AiSettings>
#[tauri::command] fn save_ai_settings(settings: AiSettings) -> Result<()>
#[tauri::command] fn save_api_key(provider: String, key: String) -> Result<()>  // OS keyring
#[tauri::command] fn get_api_key(provider: String) -> Result<Option<String>>
#[tauri::command] fn delete_api_key(provider: String) -> Result<()>
#[tauri::command] async fn list_ai_models(provider: String) -> Result<Vec<Model>>
#[tauri::command] async fn test_ai_connection(provider: String) -> Result<bool>
```

### 8.5 メンテナンス
```rust
#[tauri::command] fn fts_optimize() -> Result<()>
#[tauri::command] fn integrity_check() -> Result<IntegrityResult>
#[tauri::command] fn repair_integrity() -> Result<()>
```

> **注:** Codex/Snippet/Tree/Attribution 等のCRUD操作は Tauriコマンドではなく、フロントエンドの Drizzle ORM が `db_execute` を経由してSQLを実行する。各 feature の `api.ts` を参照。

---

## 9. UIレイアウト

> 詳細は [`Grimodex_レイアウトシステム設計書.md`](Grimodex_レイアウトシステム設計書.md) を参照。

VS Code + JetBrains ハイブリッドのDock/Float/Tab/Splitモデルを採用:

```
┌──┬──────────┬──────────────────────────┬──────────────────┐
│  │          │                          │                  │
│ A│ Left     │     Center               │  Right           │
│ c│ Dock     │     (Editor Groups)      │  Dock            │
│ t│          │                          │                  │
│ i│ Scenes   │     TipTap エディタ       │  Chat            │
│ v│ Codex    │     (タブ/分割対応)       │                  │
│ i│ History  │                          │                  │
│ t│          │                          │                  │
│ y│          ├──────────────────────────┤                  │
│  │          │ Bottom Dock              │                  │
│ B│          │ Snippets | Attribution   │                  │
│ a│          │                          │                  │
│ r│          │                          │                  │
└──┴──────────┴──────────────────────────┴──────────────────┘
```

**Dockゾーン:**

| ゾーン | 初期幅/高さ | デフォルトパネル |
|--------|-----------|----------------|
| Left Top | ~18% | Scenes（表示）、Codex（非表示） |
| Left Bottom | Left Topとの比率 | Codex Quick（表示） |
| Center | フレキシブル | Editor Groups |
| Right Top | ~30% | Chat（表示）、Chat History（非表示・非アクティブタブ） |
| Right Bottom | Right Topとの比率 | デフォルト空 |
| Bottom Dock | 非表示 | Snippets（非表示）、Attribution（非表示） |

**パネル状態:** Closed / Docked / Collapsed / Floating
**Settings:** フローティング専用（Dockには配置しない）

**キーボードショートカット（Ctrl+Alt プレフィクス）:**
- `Ctrl+Alt+S`: Scenes、`Ctrl+Alt+Q`: Codex Quick、`Ctrl+Alt+X`: Codex
- `Ctrl+Alt+C`: Chat、`Ctrl+Alt+H`: Chat History
- `Ctrl+Alt+N`: Snippets、`Ctrl+Alt+A`: Attribution
- `Ctrl+Alt+B/R/J`: Left/Right/Bottom Dockトグル
- `Ctrl+Alt+,`: Settings

---

## 10. エクスポート

### 10.1 MVPエクスポート形式

| 形式 | 説明 |
|------|------|
| Markdown | DB内のコンテンツをMarkdownファイルとしてエクスポート |
| プレーンテキスト | 全シーンを順序通りに結合し、Markdown記法を除去。Web小説投稿サイト（なろう、カクヨム）用 |
| Attribution JSON | 帰属情報のエクスポート（Grimodex独自形式、将来実装） |
| Attribution Report | Markdown / CSV — 帰属統計レポート |

### 10.2 エクスポートオプション

- 範囲: プロジェクト全体、選択した章、単一シーン
- 順序: `tree_nodes.sort_order`（fractional indexing）に従う
- プレーンテキスト: 設定可能なシーン区切り（例: `***`、空行）
- 帰属: オプションでAI生成セクションを注釈（透明性のため）

### 10.3 Post-MVP

- DOCXエクスポート（同人誌印刷用）
- EPUBエクスポート
- 縦書きPDFプレビュー

---

## 11. パフォーマンス考慮事項

### 11.1 大規模小説（10万文字以上）

- **エディタ:** シーンごとに1つのTipTapインスタンス。シーンは通常2,000〜10,000文字 — パフォーマンス問題なし。
- **ツリー:** `tree_nodes` テーブルからの読み込み。sceneStoreでキャッシュ。
- **FTS5:** trigramトークナイザーは日本語に対応。インデックス更新はトリガー経由で自動。
- **帰属スパン:** node_idでインデックス化。自動保存時にバッチ更新（キー入力ごとではない）。

### 11.2 大規模Codex（100エントリ以上）

- Codex一覧: TanStack Virtual による仮想化スクロール
- FTS検索: trigramクエリで即時応答
- コンテキスト注入: 親エントリの子はdepth 1のsummaryのみ追加

### 11.3 AIストリーミング

- Tauriコマンド経由の非同期ストリーミング
- チャット履歴: 直近N件のみ読み込み（デフォルト: 50）、古いメッセージは遅延読み込み
- コンテキストバジェット: モデルのコンテキスト上限から逆算して配分

---

## 12. セキュリティ

- APIキーはTauri keyring経由でOS認証情報マネージャーに保存（macOS: Keychain、Windows: Credential Manager、Linux: KWallet）
- すべてのAI API呼び出しはRustバックエンド経由 — キーはフロントエンドに渡さない
- テレメトリーなし、ユーザーが設定したAIプロバイダー以外への外部通信なし
- プロジェクトファイルはローカルのみ

---

## 13. 設定

> 詳細は [`Grimodex_Settingsパネル設計書.md`](Grimodex_Settingsパネル設計書.md) を参照。

設定は `settings` テーブルにドット記法のKey-Valueで保存する。APIキーのみOS keyringに保存。

**主要設定項目:**

| カテゴリ | 設定項目 | 型 | デフォルト |
|---------|---------|-----|----------|
| AI | `ai.defaultChatModel` | string | （プロバイダー依存） |
| AI | `ai.defaultInlineModel` | string | （プロバイダー依存） |
| AI | `ai.sessionTitleModel` | string | （軽量モデル） |
| エディタ | `editor.fontFamily` | string | システムデフォルト |
| エディタ | `editor.fontSize` | number | `16` |
| エディタ | `editor.lineHeight` | number | `1.8` |
| エディタ | `editor.autosaveDelay` | number（秒） | `2` |
| エディタ | `editor.typewriterMode` | boolean | `false` |
| エディタ | `editor.spellCheck` | boolean | `true` |
| 表示 | `display.theme` | string | `"system"` |
| 表示 | `display.uiScale` | number（%） | `100` |
| 表示 | `display.showWordCounts` | boolean | `true` |
| 表示 | `display.showAiBadge` | boolean | `true` |
| 表示 | `display.codexHighlight` | boolean | `true` |
| 表示 | `display.codexHighlightStyle` | string | `"underline"` |
| 表示 | `display.attributionOpacity` | number（%） | `10` |
| エクスポート | `export.sceneSeparator` | string | `"***"` |

---

## 14. MVPスコープと境界

### スコープ内（MVP）

- [x] 基本的な書式設定付きTipTapエディタ
- [x] tree_nodes テーブルによる階層ツリー（Part/Chapter/Scene/Folder/Note）
- [x] SQLite + FTS5 trigramインデックス（Codex/Snippet/Chat）
- [x] 帰属追跡（3値: human/ai/unknown、SQLite永続化）
- [x] AIチャットパネル（マルチプロバイダー: OpenRouter/Anthropic/OpenAI/Ollama）
- [x] シーン1:Nセッション + プロジェクトスコープセッション
- [x] 5レイヤーコンテキスト注入 + 手動ピン留め
- [x] Codex: タイプシステム（ビルトイン4種 + カスタム）+ カスタムディテールフィールド
- [x] Codex: 親子リレーション + context_mode（always/mentioned/suppress/hidden）
- [x] チャットからのCodex/Snippet抽出（AI mode + Manual mode）
- [x] チャットからエディタへのテキスト挿入（コピー + 挿入ボタン）
- [x] Snippets: 独立テーブルでテキスト断片管理
- [x] エクスポート: Markdown + Attribution JSON
- [x] スラッシュコマンド（/continue, /rewrite 等）
- [x] 縦書きプレビュー
- [x] ルビテキスト（RubyNode拡張）

### スコープ外（Post-MVP）

- [ ] 埋め込みベースのベクトル検索（RAGアップグレード）
- [ ] DOCX/EPUBエクスポート
- [ ] FTS用日本語形態素解析
- [ ] Codexリレーショングラフ可視化
- [ ] フローティングウィンドウ（レイアウトシステム）
- [ ] キーストロークリプレイ（Grammarly Authorship風）
- [ ] コラボレーション / マルチユーザー
- [ ] クラウド同期
- [ ] プラグインシステム

---

## 15. 開発フェーズ

> 残りの実装タスクの詳細は [`implementation-workflow.md`](implementation-workflow.md) を参照。

### Phase 1: 基盤 ✅

- ワークスペースの作成/オープン
- tree_nodesテーブルによるシーン管理
- 基本的なTipTapエディタ（ProseMirror JSON読み書き）
- Drizzle ORM + 統合DBスキーマ（14テーブル + FTS5）
- 自動保存（2秒デバウンス）

### Phase 2: AIチャット ✅

- 設定UI（マルチプロバイダー対応: OpenRouter/Anthropic/OpenAI/Ollama）
- チャットセッションCRUD（SQLite永続化）
- Rustバックエンド経由のAIプロバイダー統合
- ストリーミングレスポンス表示
- コンテキスト注入（Project + Scene + Codex + ピン留め）

### Phase 3: Codex ✅

- CodexエントリCRUD（SQLite）
- タイプシステム（ビルトイン4種 + カスタム対応スキーマ）
- FTS5検索（Codex/Snippet/Chat）
- ピン留めコンテキスト注入
- Codexマッチング（Aho-Corasickアルゴリズム）

### Phase 4: 抽出と統合 ✅

- チャットメッセージからのCodex/Snippet抽出
- 帰属マーク付き「エディタに挿入」
- AI由来クリップボード検出付きコピー＆ペースト
- Codex親子リレーション（スキーマ定義済み）
- クロスリファレンス検出

### Phase 5: 帰属追跡と仕上げ ✅

- AuthorshipMark拡張（3値: human/ai/unknown）
- 帰属ビジュアルオーバーレイ
- 帰属スパン永続化（SQLite）
- Attribution JSONエクスポート（Grimodex独自形式）
- 縦書きプレビュー、ルビテキスト

### Phase 6: パフォーマンスと品質（進行中）

- [x] FTS5インデックス最適化（fts_optimize コマンド）
- [x] 大規模Codex用仮想化リスト（TanStack Virtual）
- [x] 整合性チェック（integrity_check / repair_integrity）
- [ ] UIの磨き上げ（レイアウトシステム、各パネル強化）
- [ ] キーボードショートカット
