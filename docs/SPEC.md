# Grimodex - 製品仕様書

> バージョン: 0.8.0
> 最終更新: 2026-06-18

## 1. 製品概要

Grimodexは、Novelcrafterに着想を得た、日本語小説作家向けのデスクトップ執筆エディタである。リッチテキストエディタにAIチャットパネルと構造化ナレッジベース（Codex）を組み合わせ、AIとの対話から知識を抽出・整理し、原稿に直接活用できる。

**コア体験:** AIとチャットし、構造化された知識を抽出し、コンテキストを活用した執筆支援を受ける。

### 1.1 技術スタック

| レイヤー      | 技術                                                            |
| --------- | ------------------------------------------------------------- |
| デスクトップシェル | Tauri v2                                                      |
| フロントエンド   | React 19 + TypeScript (strict)                                |
| エディタ      | TipTap (ProseMirror)                                          |
| 状態管理      | Zustand (グローバル) + Jotai (ローカル)                                |
| UIコンポーネント | shadcn/ui                                                     |
| AI統合      | Vercel AI SDK                                                 |
| データベース    | SQLite (WALモード) + FTS5 (trigram)                              |
| ORM       | Drizzle ORM                                                   |
| ストレージ     | SQLite（唯一の信頼できる情報源、ProseMirror JSON保存） + Markdownインポート/エクスポート |

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

### 2.6 外部ファイルマウント（File-backed Scenes）

> **注（2026-06-18 追記）:** DB ネイティブのシーンに加え、外部の Markdown ファイルを
> 実体とするシーン（file-backed scene）をサポートする。`src/features/external-mount/` を参照。

- **URI 形式**: `external-root://<rootId>/<rel-path>`。マウント済みの外部ルート（rootId）
  からの相対パスで実ファイルを指す
- **トラッキング**: `tree_nodes` の `source_uri`（上記 URI）と `source_mtime`（最終同期した
  ファイルの mtime, ISO 8601）で file-backed シーンを管理。DB ネイティブシーンは両方 null
- **同期セマンティクス**: エディタ保存時にデバウンス付きで Markdown をファイルへ書き戻し、
  mtime を更新する。外部からファイルが変更されたかを mtime で検知する
- **競合解決**: エディタに未保存の変更がある状態で外部ファイルが変わった場合、
  「ローカルを保持」か「再読み込み」かを選ばせる（ExternalEditConflictBanner）
- **制限**: file-backed シーンは制限付きの TipTap 拡張（StarterKit ベース。ruby/authorship
  などのカスタム Mark なし）を使い、Markdown のみのフォーマットで扱う。
  管理は externalRootStore / mountManager 経由

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
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
-- ピン留めは chat_session_pinned_codex テーブルに正規化（詳細は統合DBスキーマ参照）

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

### 4.3 コンテキスト注入（6レイヤー + RAG モデル）

> **注（2026-06-18 更新）:** 初期設計の 5 レイヤーモデルは、L0（基本指示）・L6（コマンド指示）・
> RAG（セマンティックリコール）・Focus subject の追加により拡張された。実装は
> `contextBuilder.ts` を参照。

LLM APIのシステムプロンプトに以下のレイヤーを階層的に注入する:

**Layer 0: Base instruction（常時、trim 対象外）**
- システムプロンプトの基本指示、カスタムチャット指示、ボディ書き込み制約
- trim 対象外で常に注入（Agent モード時は agentInstruction を付加）

**Layer 1: Project info（常時）**
- プロジェクトタイトル、ジャンル、視点、文体ガイド、AI指示
- 予算配分: コンテキストの ~2%（最小500tok）

**Layer 2: storySoFar（スライディングウィンドウ）**
- 現在のシーンより前の全シーンの `synopsis` を時系列順に結合し、「これまでの物語」として注入
- Synopsisが未記入のシーンはスキップ（本文フォールバックはしない — トークン爆発防止）
- トークン予算に応じて、古いシーンのSynopsisから順に切り詰め（直近のシーンを優先）
- シーンが Complete/Revision/Final に遷移した時点で未記入なら自動生成を提案（Scenesパネル設計書参照）
- 末尾に「未回収の伏線」リストを追記（Phase 2）
- 予算配分: コンテキストの ~10%

**Layer 3: Current scene + previous（常時）**
- 現在のアクティブシーンの全文
- 直前のシーンの synopsis + 末尾段落（最大3段落）
- 予算配分: コンテキストの ~40%

**Layer 4: Codex entries + Snippets + Notes**
- `context_mode` フィルタ: 各エントリの `context_mode` により注入可否を判定
  - `always`: 常に注入
  - `mentioned`: 現在のシーン内容にマッチした場合のみ
  - `suppress`: 手動ピン留め時のみ
  - `hidden`: 一切注入しない
- ピン留めされたCodexエントリ/Snippetの全文
- 子エントリの自動注入: マッチした親エントリの子孫エントリのsummaryをサブツリートークン予算の範囲内でBFS順に自動追加
- 予算配分: コンテキストの ~20%

**Layer 5: Conversation history（会話要約）**
- 現在のセッションのメッセージ履歴
- Progressive summarization方式（Chat設計書参照）
- 予算配分: コンテキストの ~20%

**Layer 6: Command instruction（一回限り、trim 対象外）**
- スラッシュコマンド（/continue, /rewrite 等）で注入されるワンショット指示
- trim 対象外で常に効く

**RAG層（semantic recall）: 意味検索による過去シーン抜粋**
- クエリ（直近ユーザー発話＋現在シーン本文末尾）毎に変動する投機的文脈
- セッション途中で自動検索により見つかった過去シーン抜粋を注入（11.4 参照）
- 予算超過時は他レイヤーより先に削られる（最初に切るべきレイヤー）

**Focus subject（条件付き、trim 対象外）**
- Codex/Snippet スコープのアンカー（この会話の主題を `<focus_subject>` ブロックで強調）
- L3 スロット直後・L4 前に注入（常時ではなく、当該スコープ時のみ）

**応答予約**: コンテキストの ~5%（最小2,000tok）

**トークンバジェット管理:**
- 合計トークン数を `js-tiktoken` で計算
- **比率ベース配分**: 使用モデルのコンテキスト上限に対する比率で各レイヤーの予算を動的に算出（8kモデルと1Mモデルで同じ比率が適用される）
- 各レイヤーに最小トークン数（floor）を設定し、小コンテキストモデルでも最低限の機能を保証
- 比率はSettings > AI > コンテキスト予算配分でカスタマイズ可能
- **予算超過時の優先順位（削除順）**: RAG → L5 → L4 → L2 → L3 → L1（L0・L6・focusSubject は常に保持）
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

### 4.5 AI 使用ポリシーと権限制御

> **注（2026-06-18 追記）:** 間接プロンプトインジェクション対策（security F-6）として、
> AI 機能をプロジェクト単位でトグル制御する仕組みを導入した。`projects.ai_policy`
> カラム（JSON）に保存する。

**機能トグル:**

| トグル | 制御対象 |
|--------|---------|
| `chat` | AIチャット全般 |
| `bodyWrite` | 本文への書き込み提案（staged） |
| `analysis` | 校閲・伏線・整合性などの分析系 AI |
| `structureWrite` | AI による自律的なツリー scaffold（シーン/章/フォルダの構造書き込み） |
| `knowledgeWrite` | AI による自律的な Codex / 伏線 / Snippet 書き込み |

**プリセット（`preset.ts`）:**

| プリセット | chat | bodyWrite | analysis | structureWrite | knowledgeWrite |
|-----------|:----:|:---------:|:--------:|:--------------:|:--------------:|
| `full` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `assist-off` | ✓ | ✗ | ✓ | ✓ | ✓ |
| `review-only` | ✗ | ✗ | ✓ | ✗ | ✗ |
| `off` | ✗ | ✗ | ✗ | ✗ | ✗ |
| `custom` | （各トグルを個別指定） | | | | |

> `structureWrite` は「本文代筆」ではなく構造の scaffold/再編なので、本文を禁じる
> `assist-off` でも ON、`analysis` のみ／全停止では OFF になる。`knowledgeWrite` は
> `structureWrite` とは別軸。

**既定ポリシー:**

- 新規/import プロジェクトの既定: `custom` プリセットで `structureWrite=false`・
  `knowledgeWrite=false`（インジェクション防御の出口バックストップ）。chat/bodyWrite/
  analysis は有効のまま
- 既存プロジェクトは後方互換の `DEFAULT_AI_POLICY`（parse 時に全 true=full 相当）を据え置き
  （遡及変更しない）

**enforcement:**

- 実アクションの前に `blockIfPolicyOff(feature)`（内部で `isAiFeatureBlockedByPolicy()`）で
  早期 return する（`src/features/ai-policy/policyGuard.ts`）
- 適用点: agent-writes の codex / snippet / tree / foreshadow など自律書き込み経路

**ユーザー再設定パス:** 設定 > AI > 「使用ポリシー」パネルから再有効化できる。

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
- `codex_dismissed_relations` テーブル: システムが提案したリレーションをユーザーが却下した記録を保持（同じ提案を繰り返さない）
- MVP UI: エントリごとのリレーション一覧（追加/削除）。グラフ可視化は v0.8 の Map システムで出荷済み（14.1 参照）。

### 5.4 Codexエントリの抽出

> **注（2026-06-18 更新）:** 抽出は 2 系統に分化した。チャットレスポンスからの手動抽出
> （5.4.1）と、プロジェクト本文からの候補抽出パイプライン（5.4.2、形態素×LLM）。

#### 5.4.1 チャットからの抽出（AIレスポンス起点）

各AIレスポンスに「Codex」ボタンを配置。クリックすると抽出ダイアログが開く。
ダイアログは単一モード（手動）で、サマリー欄にメッセージ本文を事前入力し、
名前・タイプ・タグはユーザーが入力する。

**抽出フロー:**
1. AIがコンテンツを含むレスポンスを返す
2. ユーザーが「Codex」ボタンをクリック
3. ダイアログ表示: 名前（必須）、タイプ、タグ、サマリー（メッセージ本文を事前入力）
4. ユーザーが確認 → `codex_entries` レコード作成（メタデータ + コンテンツをDBに格納）
5. `source_chat_message_id` で抽出元メッセージへの紐付けを保持

#### 5.4.2 候補からの抽出（プロジェクト本文起点・形態素×LLM）

Codex パネルの候補レポート（CodexCandidatesReport）は、まだ Codex に登録されていない
未確定の固有名詞を、形態素解析 × LLM のパイプラインで自動的に発見する。読み取り専用の
発見（自動書き込みなし）で、明示的に受理されるまで候補はレポートに留まる。

**2段階の抽出:**

- **段階1（B1・形態素）**: Rust バックエンドの `extract_codex_candidates` コマンドが
  形態素解析を行い、まだ Codex に無い候補固有名詞を列挙する。各候補は surface（表記）・
  lemma（UniDic 語彙素）・count（出現回数）・firstSceneId（初出シーン）・context（文脈抜粋）を返す。
- **段階2（B2・LLM 判定）**: 任意の判定フェーズで LLM を呼び、候補をタイプ（character/location/
  item/lore）に分類し、既存エントリの別名（alias）かどうかを判定する。analysis ポリシーで
  gate される。

各候補は次のいずれかの状態を取る:
- 受理 → 新しい `codex_entries` を作成、または既存エントリの別名（aliases）に追加
- 却下（dismiss）→ `project_settings`（`codex.candidates.dismissed` キー）に JSON 配列で記録し、再提案しない
- 判定未実行なら保留（pending）

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

### 5.6 内部整合性チェッカー（Codex Integrity Checker）

Codexエントリ間の内部矛盾を検出し、ユーザーに可視化するシステム。エントリ本文との
矛盾（それは consistency post-effect の担当）ではなく、Codex メタデータ自身の食い違いを
検出する。本文や AI 推論を使わず、Codex メタデータ（name, aliases, excluded_aliases,
relations）だけから即座に計算する純関数群で動く。

**検出される3種類の問題:**

| 問題タイプ | 説明 | 例 |
|-----------|------|-----|
| **別名衝突（Alias Collision）** | 同じ別名・エントリ名（正規化後）が複数エントリに属する | 「太郎」が「山田太郎」と「田中太郎」の両者の別名 |
| **自己参照リレーション（Self-Relation）** | エントリが自身を指すリレーションを持つ（from === to） | エントリAがA→Aのリレーションを持つ |
| **重複リレーション（Duplicate Relation）** | 同じ無向ペア + リレーションタイプが複数定義されている | A↔B の「組織に属する」が2件 |

> **注:** リレーションの非対称（A→B はあるが B→A が無い）は、relation type に対称/非対称の
> メタデータが無いため矛盾と判定しない（全 relation が該当してしまい誤検出になる）。

**UI機能:**

- CodexパネルのIntegrityReportセクション: 検出された問題をリスト表示（0件の場合は非表示）
- 各問題の × ボタンで「非表示（dismiss）」化でき、状態は `project_settings` テーブル
  （`codex.integrity.dismissed` キー）に安定キーの JSON 配列で永続化
- 全件非表示時は「再表示」ボタンで復帰可能
- 問題行をクリックして該当エントリを選択

**実装特性:**

- 非表示状態は作業者の「確認済み」マーク。プロジェクトスナップショット（バージョン履歴）には
  含めない（content ではなく workflow state のため）

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
2. フロントエンドが多層コンテキスト（6レイヤー + RAG）を構築（4.3節参照）
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

> **注（2026-06-18 更新）:** v0.2 の MVP は 14 通常テーブル + 3 FTS5 仮想テーブルだったが、
> v0.8 時点では Map・伏線・校閲・Post-Effect・スナップショット等の機能追加により
> `schema.ts` は **62 個の通常テーブル** を宣言している（FTS5 仮想テーブルは別途）。
> 以下は機能ドメイン別の概要。正規版は [`Grimodex_統合DBスキーマ.md`](Grimodex_統合DBスキーマ.md) を参照。

**(1) コアプロジェクト:**

| テーブル | 説明 |
|---------|------|
| `projects` | プロジェクトのメタ情報（タイトル、ジャンル、POV、文体ガイド、outline、target_readers、phase_resolution_mode、ai_policy 等） |
| `tree_nodes` | Part/Chapter/Scene/Folder/Note の統一ツリー（fractional indexing、story-time 順、file-backed 用の source_uri/source_mtime 含む） |

**(2) Codex システム:**

| テーブル | 説明 |
|---------|------|
| `codex_types` | Codexエントリタイプ定義（ビルトイン4種 + カスタム） |
| `codex_entries` | 世界設定エントリ（context_mode、aliases、excluded_aliases 含む） |
| `codex_dismissed_relations` | リレーション提案のDismiss記録 |
| `codex_tags` / `codex_entry_tags` | 構造化タグ定義 + エントリ↔タグ多対多 |
| `codex_detail_definitions` / `codex_detail_values` | カスタムディテール定義（タイプごと）+ 値（エントリごと） |
| `codex_relations` | エントリ間の名前付きリレーション（親子ツリーとは別軸の有向グラフ） |
| `codex_quick_pins` | Codex Quick パネルのピン留め |
| `codex_entry_phases` / `codex_phase_detail_overrides` | フェーズ（時間軸）別のエントリ状態とディテール上書き |

**(3) チャット:**

| テーブル | 説明 |
|---------|------|
| `chat_sessions` | チャットセッション（シーン or プロジェクトスコープ） |
| `chat_messages` | チャットメッセージ（トークン数、メタデータ含む） |
| `chat_message_prompts` | 送信時に確定した実プロンプトのキャプチャ（再構築不能なため別表で保持） |
| `chat_session_pinned_codex` | セッションごとの Codex ピン留め（正規化） |
| `chat_summaries` / `chat_summary_messages` | 会話の Progressive summarization と要約↔メッセージ対応 |

**(4) コンテンツ管理:**

| テーブル | 説明 |
|---------|------|
| `snippets` / `snippet_entry_tags` | 再利用テキスト断片 + タグ |
| `content_versions` | 全コンテンツのリビジョン履歴 |
| `authorship_spans` | AI帰属追跡スパン（source: human/ai/unknown） |
| `prose_staging` | AI本文書き込みの staging（accept/reject 制御） |

**(5) Map / 可視化:** 関係図・因果地図ボードを支える6テーブル。

| テーブル | 説明 |
|---------|------|
| `map_boards` | ボード本体 |
| `map_ai_branches` | AI 生成ブランチ |
| `map_stickies` | 付箋ノード |
| `map_node_positions` | ノード座標 |
| `map_edges` | エッジ（関係線） |
| `map_frames` | フレーム（グループ枠） |

**(6) 校閲 / 品質（Lint）:** 校閲パネルの無視・辞書・操作ログを支える3テーブル。

| テーブル | 説明 |
|---------|------|
| `lint_ignored_diagnostics` | 無視（ignore）された指摘 |
| `lint_term_dictionary` | 用語辞書 |
| `lint_action_log` | 校閲操作ログ |

**(7) 伏線（Foreshadowing）:** 伏線の仕込み・回収を追跡する3テーブル。

| テーブル | 説明 |
|---------|------|
| `foreshadows` | 伏線本体 |
| `foreshadow_setups` | 仕込み（setup）位置 |
| `foreshadow_codex_links` | 伏線↔Codex リンク |

**(8) シーン解析:**

| テーブル | 説明 |
|---------|------|
| `scene_codex_mentions` | シーン内 Codex 言及キャッシュ |
| `scene_beat_pov_cache` | ビート/POV キャッシュ |
| `scene_codex_pins` | シーンごとの Codex ピン留め |
| `scene_lens_data` | シーンのレンズ解析データ（テンション値等） |
| `scene_chunks` | セマンティック検索用チャンク + 埋め込み（11.4 参照） |

**(9) Post-Effect / 注釈:** 校閲・整合性・影響レビュー等の post-effect 実行結果を支える3テーブル。

| テーブル | 説明 |
|---------|------|
| `post_effect_runs` | post-effect 実行記録 |
| `post_effect_annotations` | 注釈（疑似コメント・指摘等） |
| `post_effect_annotation_relations` | 注釈間のリレーション |
| `impact_review_baselines` | 影響レビューのベースライン |

**(10) プロジェクト履歴（スナップショット）:** バージョン履歴を支える6テーブル。

| テーブル | 説明 |
|---------|------|
| `project_snapshots` | スナップショット本体 |
| `project_snapshot_entries` | 含まれるエントリ一覧 |
| `project_snapshot_tree_nodes` | ツリーノードのスナップショット |
| `project_snapshot_codex_entries` | Codex エントリのスナップショット |
| `project_snapshot_snippets` | Snippet のスナップショット |
| `project_snapshot_aux` | 補助スコープ（aux）のスナップショット |

**(11) 設定・メタデータ:**

| テーブル | 説明 |
|---------|------|
| `app_settings` | アプリ全体の Key-Value 設定（ドット記法: `editor.fontSize`） |
| `project_settings` | プロジェクト単位の Key-Value 設定（aiPrompt.custom、codex.integrity.dismissed 等） |

**(12) ラベル・整理:**

| テーブル | 説明 |
|---------|------|
| `labels` / `tree_node_labels` | ラベル定義 + ツリーノード↔ラベル多対多 |
| `trash_items` | 削除済みアイテムのゴミ箱 |

**(13) 追跡・監査・統計:**

| テーブル | 説明 |
|---------|------|
| `change_events` | 全編集の append-only ログ（sha256 チェーン検証可能、タイムラプス用） |
| `state_snapshots` | リプレイ用の状態スナップショット |
| `ai_usage` | AI トークン使用量台帳 |
| `ab_comparisons` | A/B 比較記録 |
| `generation_logs` | 生成ログ |

**(14) 生成・テンプレート:**

| テーブル | 説明 |
|---------|------|
| `prompt_templates` | プロンプトテンプレート |

**FTS5 仮想テーブル（クエリ時専用、トリガーで自動同期）:**

| テーブル | 種別 | 説明 |
|---------|------|------|
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

**キーボードショートカット（Mod+Alt プレフィクス）:**
Mod は macOS では Cmd、Windows/Linux では Ctrl に置き換わります。

**基本パネル:**
- `Mod+Alt+S`: Scenes、`Mod+Alt+Q`: Codex Quick、`Mod+Alt+X`: Codex
- `Mod+Alt+C`: Chat、`Mod+Alt+H`: Chat History
- `Mod+Alt+N`: Snippets、`Mod+Alt+A`: Attribution

**拡張パネル:**
- `Mod+Alt+L`: Timeline、`Mod+Alt+M`: Map、`Mod+Alt+T`: Kouetsu
- `Mod+Alt+F`: Foreshadow、`Mod+Alt+B`: TrashBin
- `Mod+Alt+G`: Grid、`Mod+Alt+R`: Matrix、`Mod+Alt+W`: WritingStats
- `Mod+Alt+P`: RelatedScenes

**グローバル:**
- `Mod+Alt+,`: Settings

注：Dock トグルバインディングは現在実装されていません。

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

### 11.4 セマンティック検索とチャンク戦略

- **本文セマンティック検索（RAG）**: `cl-nagoya/ruri-v3-30m` ONNX モデルを Rust 側で
  推論し、f32 配列埋め込みを L2 正規化して `scene_chunks` テーブルに保存
- **チャンク分割**: 各シーンを意味的に分割し、テキスト位置情報（char_start/char_end）・
  会話文比率（dialogue_ratio）・埋め込み次元（embedding_dim）を記録
- **検索スコアリング**: 日本語は top-1 ゲート 0.85 + 最小スコア（床）0.80 で、無関係シーンの
  誤注入を防止（英語は別校正、しきい値 0.51）
- **コンテキスト注入**: RAG 層として最大 3 チャンクを注入、クエリごとに動的再計算
  （4.3 参照）

### 11.5 変更イベント追跡とスナップショット

- **変更イベントログ**: `change_events` テーブルの append-only ログで全編集を記録
  （sha256 チェーンで「ログ自体が後から改竄されていない」ことを検証可能）
- **状態スナップショット**: `state_snapshots` テーブルで domain/entityId ごとに、
  おおよそ 1000 イベントまたは 1 時間間隔でスナップショットを記録
- **リプレイエンジン**: 最寄りスナップショットへジャンプ → forward イベントを適用して
  任意時点の状態を復元（執筆タイムラプス）

### 11.6 仮想化スクロールと遅延読み込み

- **Codex パネル**: TanStack Virtual（useVirtualizer）で大規模リスト（100+ エントリ）を仮想化
- **チャット履歴**: 直近 N 件のメッセージのみメモリ読み込み、過去メッセージは遅延読み込み
- **リアクティブ遅延**: codexStore / snippetStore の ensureLoaded パターンで段階的ロード

---

## 12. セキュリティ

- APIキーはTauri keyring経由でOS認証情報マネージャーに保存（macOS: Keychain、Windows: Credential Manager、Linux: KWallet）
- すべてのAI API呼び出しはRustバックエンド経由 — キーはフロントエンドに渡さない
- テレメトリーなし、ユーザーが設定したAIプロバイダー以外への外部通信なし
- プロジェクトファイルはローカルのみ

---

## 13. 設定

> 詳細は [`Grimodex_Settingsパネル設計書.md`](Grimodex_Settingsパネル設計書.md) を参照。

設定は `app_settings` テーブルにドット記法のKey-Valueで保存する（プロジェクト跨ぎで共有）。APIキーのみOS keyringに保存。

**主要設定項目:**

| カテゴリ | 設定項目 | 型 | デフォルト |
|---------|---------|-----|----------|
| AI | `ai.inlineModel` | string | （プロバイダー依存） |
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

> **注（2026-06-20 追記）:** チャット用モデルは `ai.defaultChatModel` として `app_settings` には保存しない。現在のチャットモデルはプロバイダーごとに `aiSettingsStore`（AI設定ストア）側で保持する。`app_settings` に保存される AI 関連キーは `ai.inlineModel`（インライン生成用）と `ai.sessionTitleModel`（セッション自動タイトル用の軽量モデル）の2つ。

---

## 14. MVPスコープと境界

### スコープ内（MVP）

- [x] 基本的な書式設定付きTipTapエディタ
- [x] tree_nodes テーブルによる階層ツリー（Part/Chapter/Scene/Folder/Note）
- [x] SQLite + FTS5 trigramインデックス（Codex/Snippet/Chat）
- [x] 帰属追跡（3値: human/ai/unknown、SQLite永続化）
- [x] AIチャットパネル（マルチプロバイダー: OpenRouter/Anthropic/OpenAI/Ollama）
- [x] シーン1:Nセッション + プロジェクトスコープセッション
- [x] 多層コンテキスト注入（6レイヤー + RAG）+ 手動ピン留め
- [x] Codex: タイプシステム（ビルトイン4種 + カスタム）+ カスタムディテールフィールド
- [x] Codex: 親子リレーション + context_mode（always/mentioned/suppress/hidden）
- [x] チャットからのCodex/Snippet抽出（AI mode + Manual mode）
- [x] チャットからエディタへのテキスト挿入（コピー + 挿入ボタン）
- [x] Snippets: 独立テーブルでテキスト断片管理
- [x] エクスポート: Markdown + Attribution JSON
- [x] スラッシュコマンド（/continue, /rewrite 等）
- [x] 縦書きプレビュー
- [x] ルビテキスト（RubyNode拡張）

### スコープ外（当初 Post-MVP 想定 / 一部は v0.8 で出荷済み）

- [x] 埋め込みベースのベクトル検索（RAG）— v0.8 で出荷（11.4 参照、ruri-v3-30m ONNX）
- [ ] DOCX/EPUBエクスポート
- [x] 形態素解析（校閲 Lint・Codex 候補抽出の lemma 照合）— v0.8 で出荷（5.4.2 参照）
- [x] Codexリレーション可視化（関係図・因果地図ボード）— v0.8 で出荷（下記 14.1 Map）
- [ ] フローティングウィンドウ（レイアウトシステム）
- [x] キーストロークリプレイ（執筆タイムラプス）— v0.8 で出荷（11.5 参照、change_events）
- [ ] コラボレーション / マルチユーザー
- [ ] クラウド同期
- [ ] プラグインシステム

### 14.1 v0.8 で追加された主要機能（当初仕様外）

> **注（2026-06-18 追記）:** v0.2 の MVP 出荷後、以下の機能ドメインが追加された。
> 各々が `schema.ts` に対応テーブルを持つ（7章のテーブル一覧を参照）。

| 機能ドメイン | 概要 | 主なテーブル |
|------------|------|------------|
| **Map システム** | 関係図・シーン因果 DAG ボード（付箋/エッジ/フレーム/AI ブランチ） | `map_boards` 他6 |
| **伏線トラッキング** | 伏線の仕込み・回収の追跡、Codex リンク、伏線レーダー | `foreshadows` 他2 |
| **執筆統計・ペースメーカー** | streak / 日次量 / ヒートマップ / 目標文字数 / 完走 ETA | （集計は本文 char_count + change_events） |
| **Post-Effect / 注釈** | 校閲・整合性・影響レビュー等の post-effect 実行と疑似コメント注釈 | `post_effect_runs` 他3 |
| **校閲（Lint）** | 用語辞書・無視管理・操作ログを伴う文章校閲 | `lint_*` 3 |
| **プロジェクトスナップショット** | プロジェクト全体のバージョン履歴 | `project_snapshot_*` 6 |
| **執筆タイムラプス** | append-only 変更イベント + リプレイ（11.5 参照） | `change_events`, `state_snapshots` |
| **関連シーンパネル** | dense+sparse ハイブリッド検索による関連シーン提示 | `scene_chunks`（埋め込み） |
| **ラベル / ゴミ箱** | ツリーノードのラベル付けと削除アイテムの復元 | `labels`, `tree_node_labels`, `trash_items` |
| **AI 使用ポリシー** | プロジェクト単位の AI 権限トグル（4.5 参照） | `projects.ai_policy` |
| **外部ファイルマウント** | 外部 Markdown を実体とする file-backed シーン（2.6 参照） | `tree_nodes.source_uri/source_mtime` |

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
