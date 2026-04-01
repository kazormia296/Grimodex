# Grimodex - 製品仕様書

> バージョン: 0.1.0 (MVP)
> 最終更新: 2026-03-31

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
| ストレージ | Markdownファイル（信頼できる唯一の情報源） + SQLite（インデックス/キャッシュ/メタデータ） |

### 1.2 対象ユーザー

日本語を使用する個人小説家。主な利用者は開発者本人。

---

## 2. アーキテクチャ原則

### 2.1 ストレージモデル: Markdownファースト

ディスク上のMarkdownファイルが、すべての本文コンテンツの**唯一の信頼できる情報源**である。SQLiteは以下の用途で使用:
- 全文検索インデックス（FTS5 trigram）
- 帰属（authorship）追跡ストア
- Codexのメタデータとリレーション
- チャット履歴
- プロジェクト設定と状態

**設計根拠:** Git親和性、可搬性、ベンダーロックインの回避。ユーザーは任意のテキストエディタでファイルを閲覧・編集可能。

### 2.2 ディレクトリ = 階層構造

プロジェクト構造はファイルシステムに直接マッピングされる:

```
my-novel/
  grimodex.json              # プロジェクトマニフェスト
  .grimodex/
    db.sqlite                # SQLite インデックス/キャッシュ/メタデータ
    chat/                    # チャット履歴（スレッドごとのJSON）
  codex/
    icons/                   # アイコン画像（128×128 WebP）
    characters/
      太郎.md
      花子.md
    locations/
      東京タワー.md
    items/
      聖剣.md
  snippets/                  # SnippetのMarkdownコンテンツ
    台詞案.md
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

- フォルダ = 構造的階層（任意の深さ、Scrivener風）
- リーフノード = Markdownドキュメント（シーン/章）
- リネーム/移動 = ファイルシステム操作（Tauri fs API）
- ソート順: 各フォルダ内の `_order.json` で制御

### 2.3 ドキュメントフォーマット

各原稿ドキュメントは、オプションのYAML frontmatterを持つ標準的なMarkdownファイルである:

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

frontmatterフィールドは高速クエリのためSQLiteにインデックスされる。

### 2.4 コンテンツファイル命名規則

原稿ファイルはハイブリッド命名方式を採用する。ファイル名にソート順・タイトル・IDを埋め込むことで、ファイルシステム上での視認性とプログラムからの一意特定を両立する。

**命名規則:**

```
{chapter_order:02d}-{scene_order:02d}_{sanitized_title}_{short_id}.md
```

| 部位 | 説明 | 例 |
|------|------|----|
| `chapter_order` | 章の並び順（2桁ゼロ埋め） | `01` |
| `scene_order` | シーンの並び順（2桁ゼロ埋め） | `03` |
| `sanitized_title` | サニタイズ済みタイトル | `夜明けの対話` |
| `short_id` | シーンUUIDの先頭8文字 | `a3f1b2c4` |

**実例:**
```
content/
  01-01_プロローグ_a3f1b2c4.md
  01-02_夜明けの対話_b1234567.md
  02-01_旅立ち_cafebabe.md
  02-03_新タイトル_deadbeef.md
```

**タイトルのサニタイズ規則:**
- 最大30文字（Unicode文字境界で切断）
- Windows禁止文字（`/ \ : * ? " < > |`）は `_` に置換
- 空タイトルは `untitled` に置換
- 前後の空白は除去

**ファイルルックアップ:**
- `short_id`（UUID先頭8文字）をキーとして `*_{short_id}.md` パターンで検索
- タイトルや順序が変わってもIDで同一ファイルを特定可能
- リネーム時は旧ファイルを削除し新ファイル名で再作成

**設計根拠:**
- ファイル名のソート順プレフィックスにより、エクスプローラーやGitで自然な順序表示
- `short_id` サフィックスにより、タイトル変更・並び替え後もファイルの同一性を追跡可能
- タイトル埋め込みにより、Grimodex外でもファイル内容を推測可能

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
- `grimodex.db` がルートに存在するディレクトリ → 既存ワークスペース
- 空ディレクトリまたは存在しないパス → 新規ワークスペース作成可能
- 上記以外（`grimodex.db` がないファイルを含むディレクトリ）→ 無効

---

## 3. エディタ（TipTap）

### 3.1 基本要件

- 開いているドキュメント（シーン/章）ごとに1つのTipTapインスタンス
- 標準的なリッチテキスト編集: 太字、斜体、見出し、引用ブロック、水平線
- リアルタイム文字数/単語数カウント
- 自動保存: 最後のキー入力から500msのデバウンスでディスクに書き込み
- セッションごとの完全な履歴によるundo/redo

### 3.2 帰属追跡（Markレベル） — Agent Trace v0.1.0 準拠

> 設計判断の詳細は [ADR-001](adr/001-agent-trace-attribution.md) を参照。

すべてのテキストスパンは、以下の5値のいずれかを持つauthorship Mark属性を保持する:

| 値 | 意味 |
|----|------|
| `human` | ユーザーが入力したテキスト |
| `ai` | AIチャットから挿入されたテキスト（未編集、または軽微な編集のみ） |
| `mixed` | AI由来のテキストをユーザーが大幅に編集したもの |
| `unknown` | 出所不明（外部からのインポート/ペースト時のデフォルト） |
| `snippet` | スニペットから挿入されたテキスト（Grimodex独自拡張） |

**Mark属性（AuthorshipAttributes）:**

| 属性 | 型 | 説明 |
|------|----|------|
| `source` | AuthorshipSource | 上記5値のいずれか |
| `timestamp` | string \| null | マーク付与時刻（ISO 8601） |
| `model` | string \| null | `provider/model` 形式（例: `anthropic/claude-sonnet-4-6`） |
| `chatMessageId` | string \| null | 生成元のチャットメッセージID |
| `traceId` | string \| null | Agent Traceのトレース識別子（UUID） |
| `toolName` | string \| null | ツール名（`grimodex` 固定） |
| `toolVersion` | string \| null | アプリバージョン（例: `0.1.0`） |
| `manualOverride` | boolean | ユーザーによる手動上書きフラグ |
| `originalLength` | number \| null | 挿入時の元テキスト長（mixed→human比率計算用） |

**実装:**

- カスタムTipTap Mark拡張: `authorship`（上記属性を保持）
- デフォルト: マークなしのテキストは暗黙的に `human` として扱う
- チャットからの「エディタに挿入」: `ai` マーク + `model`（`provider/model`形式）+ `toolName`/`toolVersion` + `originalLength` を付与
- ユーザーが `ai` スパン内を編集 → 即座に `mixed` に遷移（閾値なし）
- ユーザーが `mixed` スパン内を編集 → 残存テキスト比率で判定:
  - 現在のノード長 / originalLength ≤ 0.2（元テキストの80%以上を削除）→ `human` に遷移
  - インクリメンタルな編集でも自然に蓄積される
- `manualOverride: true` のマークは自動遷移をスキップ
- 右クリックコンテキストメニューで帰属を手動変更可能（manualOverride が設定される）
- IME入力: `compositionstart`/`compositionend` イベントを追跡。入力中はバッファし、`compositionend` で `human` マークを適用

**永続化:**

帰属データは**SQLiteのみ**に保存（Markdownファイルには含めない）。Markdownファイルはクリーンな標準Markdownのまま維持する。

帰属のSQLiteスキーマ:
```sql
CREATE TABLE authorship_spans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id        TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  offset_start    INTEGER NOT NULL,
  offset_end      INTEGER NOT NULL,
  source          TEXT NOT NULL CHECK(source IN ('human','ai','mixed','unknown','snippet')),
  trace_id        TEXT,
  model           TEXT,
  ai_message_id   TEXT,
  manual_override INTEGER NOT NULL DEFAULT 0,
  content_hash    TEXT,
  tool_name       TEXT,
  tool_version    TEXT,
  created_at      TEXT NOT NULL
);
```

- ドキュメント保存時: 現在のTipTap Markの位置をシリアライズ → `authorship_spans` を全置換更新
- ドキュメント読み込み時: SQLiteからスパンを読み込み → TipTap Markとして適用
- 外部編集時（Grimodex外でファイルが変更された場合）: 帰属データが陳腐化 → 警告を表示し、ドキュメントの帰属データのクリアを提案

**表示:**
- トグル可能なオーバーレイ: humanテキストは通常表示、`ai` / `mixed` / `unknown` / `snippet` はそれぞれ異なる背景色
- 手動上書きされたマークは紫の破線アウトラインで視覚的に区別
- 帰属レポートパネル: 人間 / AI生成 / 混合 / 不明 / スニペット の比率をバーグラフで表示

**エクスポート:**
- Agent Trace v0.1.0 準拠の JSON エクスポート（`.agent-trace.json`）
- MIME type: `application/vnd.agent-trace.record+json`
- 文字レベルのマークを集約したスパン、SHA-256コンテンツハッシュを含む
- Grimodex独自拡張は `dev.grimodex.*` 名前空間

### 3.3 チャットからのテキスト挿入

2つの方式を同時に提供:

1. **コピーボタン** — チャットメッセージのテキストをカスタムデータ型（`application/x-grimodex-ai-text`）でクリップボードにコピー。エディタにペーストすると `ai` マークで検出・記録。
2. **「エディタに挿入」ボタン** — プログラム的にカーソル位置にテキストを挿入し、`ai` マークを付与。

「挿入」クリック時にエディタにカーソルフォーカスがない場合は、ドキュメント末尾に挿入する。

---

## 4. AIチャットパネル

### 4.1 プロバイダー: OpenRouter（MVP）

- MVP段階では単一プロバイダー: OpenRouter API
- BYOK（Bring Your Own Key）: ユーザーが自身のOpenRouter APIキーを提供
- モデル選択: 利用可能なOpenRouterモデルからユーザーが選択
- ストリーミング: Vercel AI SDK `useChat`（ストリーミング有効）
- すべてのAPI呼び出しはRustバックエンド（Tauriコマンド）経由 — CORSの回避とキーのセキュリティ確保

### 4.2 スレッドモデル

```
プロジェクト
├── プロジェクトレベルスレッド（世界観構築、プロット等）
└── ドキュメント（シーン/章）
    ├── スレッド: "プロット相談"
    ├── スレッド: "文体添削"
    └── スレッド: "キャラ深掘り"
```

- 各ドキュメントは **N個のチャットスレッド** を持てる
- プロジェクトレベルスレッドは特定のドキュメントに紐づかない
- スレッド一覧はサイドバーに表示、アクティブスレッドはチャットパネルに表示
- スレッドは `.grimodex/chat/{thread-id}.json` にJSONファイルとして永続化

スレッドスキーマ:
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

### 4.3 コンテキスト注入（自動RAG + 手動ピン留め）

ユーザーがメッセージを送信すると、システムが自動的にコンテキストを構築する:

**自動コンテキスト（常に含まれる）:**
1. 現在のドキュメント内容（スレッドがドキュメントに紐づいている場合）
2. ドキュメントのfrontmatter（あらすじ、視点キャラクター、ステータス）
3. FTS5検索: クエリ = ユーザーのメッセージ → 上位K件の関連Codexエントリとドキュメントスニペット

**手動オーバーライド（ピン留め）:**
- コンテキストバーの「+」ボタンからCodexエントリ、Snippet、またはドキュメントを手動ピン留め
- ピン留めしたエントリはセッション内で永続（セッション終了まで有効）

**コンテキストバジェット管理:**
- 設定可能なトークンバジェット（デフォルト: コンテキストに8000トークン、残りは会話用）
- 優先順位: 手動ピン留め > 現在のドキュメント > FTS結果
- バジェット超過時: FTS結果から先に削減、次に現在のドキュメント（先頭/末尾N段落を残す）
- チャット入力の上に「コンテキスト」展開セクションを表示し、注入された内容を提示

**システムプロンプト:**
- スレッドタイプごとのデフォルトシステムプロンプトテンプレート（設定可能）
- テンプレート変数: `{{document}}`, `{{codex}}`, `{{synopsis}}`, `{{characters}}`

### 4.4 プロンプトテンプレート

ユーザーはプロンプトテンプレートを作成・管理可能:
- 組み込みテンプレート: 「汎用アシスタント」「プロットコンサルタント」「文体エディタ」「キャラクター深掘り」
- カスタムテンプレート（変数展開対応）
- テンプレートの保存先: `grimodex.json` または専用の `templates/` ディレクトリ

---

## 5. Codex（ナレッジベース）

### 5.1 エントリ構造: Key-Value + フリーテキスト

各Codexエントリは、構造化frontmatterを持つMarkdownファイルである:

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

- [2026-03-15 チャットから抽出](grimodex://chat/thread-id/message-id)
```

**設計判断:**
- `Properties` セクション: Markdownリスト形式の任意Key-Valueペア。固定スキーマなし — ユーザーとAIが任意のキーを追加可能。
- `Notes` セクション: 非構造化情報のためのフリーテキスト
- `Source Messages` セクション: 元のチャットメッセージへのバックリンク（出自追跡）
- frontmatterの `relations`: 他のCodexエントリへの明示的な型付きリレーション

### 5.2 カテゴリ

デフォルトカテゴリ（ユーザーがカスタム追加可能）:
- `character` — キャラクター
- `location` — 場所・舞台
- `item` — 物体・アーティファクト
- `concept` — 魔法体系、組織、抽象的概念
- `event` — 歴史的事件、バックストーリー
- `snippet` — テキスト断片、文章の下書き、台詞候補

### 5.3 リレーショングラフ

Codexエントリは明示的な型付きリレーションを持てる:

```typescript
interface CodexRelation {
  sourceId: string;
  targetId: string;
  type: string;       // "sibling", "parent", "possesses", "belongs_to", "enemy_of" 等
  label: string;      // 人間が読める形式: "花子の兄"
  bidirectional: boolean; // trueの場合、逆方向のリレーションを自動作成
}
```

- リレーションはエントリのfrontmatterに保存し、グラフクエリ用にSQLiteにもインデックス
- RAGで使用: Codexエントリがコンテキストに含まれる場合、関連エントリ（1ホップ）が候補に追加される
- MVP UI: エントリごとのリレーション一覧（追加/削除）。グラフ可視化はpost-MVP。

### 5.4 チャットからの抽出

**メッセージレベルの抽出:**
- 各AIレスポンスに「Codexに保存」ボタンを配置
- クリックするとダイアログが開く:
  - AIが提案したカテゴリ、名前、Key-Valueプロパティで事前入力
  - ユーザーが保存前に編集可能
  - ソースメッセージへのバックリンクを自動作成

**AI自動提案:**
- 各AIレスポンス後、Codexに値する内容が含まれているかチェック
- 実装: システムプロンプトに隠し指示を追加し、抽出可能なエンティティを特定フォーマット（例: `[[codex:character:太郎]]`）でタグ付けするようAIに依頼
- 検出時、メッセージに控えめな「Codex候補あり」インジケーターを表示
- ユーザーがクリックしてレビュー・確認/編集した後に保存

**抽出フロー:**
1. AIがコンテンツを含むレスポンスを返す
2. システムが `[[codex:...]]` マーカーを検出（またはユーザーが「Codexに保存」をクリック）
3. ダイアログ表示: 名前、カテゴリ、提案されたKey-Valueプロパティ、フリーテキスト
4. ユーザーが確認 → Codexエントリのmdファイルを作成、バックリンクを保存
5. SQLiteインデックスを更新

---

## 6. データフローと状態管理

### 6.1 状態アーキテクチャ

```
Zustand stores（グローバル）:
├── projectStore      — プロジェクトメタデータ、ファイルツリー
├── editorStore       — アクティブドキュメント、ダーティ状態
├── chatStore         — アクティブスレッド、メッセージ、ストリーミング状態
├── codexStore        — エントリインデックス、検索結果
└── settingsStore     — APIキー、設定、UI状態

Jotai atoms（ローカル）:
├── editorSelection   — 現在の選択範囲/カーソル位置
├── chatInput         — 現在のチャット入力テキスト
├── contextPreview    — 現在のメッセージの解決済みコンテキスト
└── panelLayout       — スプリッター位置、パネル表示状態
```

### 6.2 データフロー図

```
[ファイルシステム (MDファイル)]
       ↕ read/write (Tauri fs)
[Rustバックエンド]
       ↕ Tauriコマンド (IPC)
[Reactフロントエンド]
  ├── TipTapエディタ ←→ editorStore
  ├── チャットパネル  ←→ chatStore
  ├── Codexパネル    ←→ codexStore
  └── ファイルツリー  ←→ projectStore
       ↕ インデックス化
[SQLite (Drizzle経由)]
  ├── FTS5インデックス（ドキュメント内容、Codex内容）
  ├── 帰属スパン
  ├── Codexリレーショングラフ
  └── ドキュメントメタデータキャッシュ
```

### 6.3 主要データフロー

**執筆フロー:**
1. ユーザーがTipTapで入力 → `human` 帰属マークを適用
2. 自動保存（500msデバウンス） → MDをディスクに書き込み + SQLiteの帰属スパンを更新
3. 保存時にSQLite FTSインデックスを更新

**AIチャットフロー:**
1. ユーザーがメッセージを入力
2. フロントエンドがコンテキストを解決: 現在のドキュメント + FTS結果 + ピン留めされたエントリ
3. Tauriコマンド: Rustバックエンド経由でOpenRouterにメッセージを送信
4. レスポンスをフロントエンドにストリーミング
5. レスポンス内の `[[codex:...]]` マーカーをパース
6. レスポンスを「挿入」「Codexに保存」ボタン付きで表示

**Codex抽出フロー:**
1. ユーザーがチャットメッセージの「Codexに保存」をクリック
2. AIが提案した構造でダイアログが開く
3. ユーザーが確認 → `codex/{category}/{name}.md` にMDファイルを書き込み
4. SQLiteインデックスを更新（FTS + リレーション）
5. バックリンクをCodexエントリとチャットメッセージの両方に保存

**エディタ挿入フロー:**
1. ユーザーがチャットメッセージの「エディタに挿入」をクリック
2. カーソル位置に `ai` 帰属マーク付きでテキストを挿入
3. 次回保存時にSQLiteの帰属スパンを更新
4. チャットメッセージに挿入先ドキュメントを記録

---

## 7. SQLiteスキーマ（インデックス/キャッシュ/メタデータ）

```sql
-- ドキュメントメタデータキャッシュ（信頼できる情報源はMDファイル）
CREATE TABLE documents (
  id          TEXT PRIMARY KEY,  -- UUID v7
  path        TEXT NOT NULL UNIQUE, -- プロジェクトルートからの相対パス
  title       TEXT,
  synopsis    TEXT,
  pov         TEXT,
  status      TEXT DEFAULT 'draft',
  word_count  INTEGER DEFAULT 0,
  parent_path TEXT,  -- 階層構造のための親フォルダパス
  sort_order  INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL,
  modified_at TEXT NOT NULL
);

-- ドキュメント内容のFTS5インデックス
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, content, synopsis,
  content=documents,
  tokenize='trigram'
);

-- 帰属追跡（Agent Trace v0.1.0 準拠）
CREATE TABLE authorship_spans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id        TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  offset_start    INTEGER NOT NULL,
  offset_end      INTEGER NOT NULL,
  source          TEXT NOT NULL CHECK(source IN ('human','ai','mixed','unknown','snippet')),
  trace_id        TEXT,
  model           TEXT,
  ai_message_id   TEXT,
  manual_override INTEGER NOT NULL DEFAULT 0,
  content_hash    TEXT,
  tool_name       TEXT,
  tool_version    TEXT,
  created_at      TEXT NOT NULL
);

-- Codexエントリ（信頼できる情報源はMDファイル）
CREATE TABLE codex_entries (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  tags        TEXT,  -- JSON配列
  content     TEXT,  -- FTS用フルテキスト
  created_at  TEXT NOT NULL,
  modified_at TEXT NOT NULL
);

-- Codex用FTS5インデックス
CREATE VIRTUAL TABLE codex_fts USING fts5(
  name, content, tags,
  content=codex_entries,
  tokenize='trigram'
);

-- Codexリレーション
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

-- チャットスレッド
CREATE TABLE chat_threads (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  document_id TEXT REFERENCES documents(id),
  created_at  TEXT NOT NULL,
  modified_at TEXT NOT NULL
);

-- チャットメッセージ（JSONファイルとしても永続化、SQLiteは検索用）
CREATE TABLE chat_messages (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES chat_threads(id),
  role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- チャットメッセージ用FTS
CREATE VIRTUAL TABLE chat_fts USING fts5(
  content,
  content=chat_messages,
  tokenize='trigram'
);

-- Codex抽出の出自追跡
CREATE TABLE codex_extractions (
  id              INTEGER PRIMARY KEY,
  codex_entry_id  TEXT NOT NULL REFERENCES codex_entries(id),
  chat_message_id TEXT NOT NULL REFERENCES chat_messages(id),
  extracted_at    TEXT NOT NULL
);

-- 設定
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

---

## 8. Tauriコマンド API（Rust ↔ JSブリッジ）

### 8.1 プロジェクト管理
```rust
#[tauri::command] fn open_project(path: String) -> Result<ProjectManifest>
#[tauri::command] fn create_project(path: String, name: String) -> Result<ProjectManifest>
#[tauri::command] fn get_file_tree(project_path: String) -> Result<FileTreeNode>
#[tauri::command] fn create_folder(path: String) -> Result<()>
#[tauri::command] fn rename_entry(old_path: String, new_path: String) -> Result<()>
#[tauri::command] fn delete_entry(path: String) -> Result<()>
#[tauri::command] fn reorder_entries(folder_path: String, order: Vec<String>) -> Result<()>
```

### 8.2 ドキュメント操作
```rust
#[tauri::command] fn read_document(path: String) -> Result<DocumentData>
#[tauri::command] fn save_document(path: String, content: String, frontmatter: Value) -> Result<()>
// 帰属スパンはDrizzle ORM経由でCRUD（Tauriコマンド不要）
// see: src/features/attribution/api.ts
```

### 8.3 Codex操作
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

### 8.4 検索
```rust
#[tauri::command] fn search_fts(query: String, scope: SearchScope) -> Result<Vec<SearchResult>>
// SearchScope: All | Documents | Codex | Chat
#[tauri::command] fn build_context(message: String, document_id: Option<String>, mentions: Vec<Mention>) -> Result<ContextPayload>
```

### 8.5 AIチャット
```rust
#[tauri::command] fn list_threads(document_id: Option<String>) -> Result<Vec<ChatThread>>
#[tauri::command] fn create_thread(title: String, document_id: Option<String>) -> Result<ChatThread>
#[tauri::command] fn delete_thread(id: String) -> Result<()>
#[tauri::command] fn send_message(thread_id: String, content: String, context: ContextPayload) -> Result<()>
// ストリーミングはTauriイベント経由（戻り値ではない）
// イベント: "chat:stream-chunk" { threadId, content, done }
```

### 8.6 設定
```rust
#[tauri::command] fn get_settings() -> Result<Settings>
#[tauri::command] fn update_settings(settings: PartialSettings) -> Result<Settings>
```

---

## 9. UIレイアウト

```
┌─────────────────────────────────────────────────────────────────┐
│  メニューバー                                                    │
├──────────┬──────────────────────────────────┬───────────────────┤
│          │                                  │                   │
│  ファイル │       TipTapエディタ              │  AIチャットパネル  │
│  ツリー   │                                  │                   │
│          │  [帰属オーバーレイ切替]             │  [スレッド選択]    │
│  ────    │                                  │  [メッセージ...]   │
│          │                                  │  [コンテキスト表示] │
│  Codex   │                                  │  [入力 + 送信]    │
│  一覧    │                                  │                   │
│          │                                  │  ──────────────── │
│          │                                  │                   │
│          │                                  │  Codex詳細        │
│          │                                  │  （選択時に表示）   │
│          │                                  │                   │
├──────────┴──────────────────────────────────┴───────────────────┤
│  ステータスバー: 文字数 | 帰属比率 | AIモデル | 保存状態          │
└─────────────────────────────────────────────────────────────────┘
```

- リサイズ可能なスプリッター付き3カラムレイアウト
- 左サイドバー: ファイルツリー（上部） + Codex一覧（下部）、折りたたみ可能
- 中央: エディタ、全高表示
- 右サイドバー: チャットパネル（上部） + Codex詳細（下部）、折りたたみ可能
- すべてのパネルはキーボードショートカットで切替可能

---

## 10. エクスポート

### 10.1 MVPエクスポート形式

| 形式 | 説明 |
|------|------|
| Markdown | ネイティブ形式そのもの — `manuscript/` フォルダをコピーするだけ |
| プレーンテキスト | 全ドキュメントを順序通りに結合し、Markdown記法を除去。Web小説投稿サイト（なろう、カクヨム）用 |

### 10.2 エクスポートオプション

- 範囲: プロジェクト全体、選択した章、単一ドキュメント
- 順序: `_order.json` のソート順に従う
- プレーンテキスト: 設定可能なシーン区切り（例: `***`、空行）
- frontmatter: 除去または含める
- 帰属: オプションでAI生成セクションを注釈（透明性のため）

### 10.3 Post-MVP

- DOCXエクスポート（同人誌印刷用）
- EPUBエクスポート
- 縦書きPDFプレビュー

---

## 11. パフォーマンス考慮事項

### 11.1 大規模小説（10万文字以上）

- **エディタ:** ドキュメント（シーン）ごとに1つのTipTapインスタンス。シーンは通常2,000〜10,000文字 — パフォーマンス問題なし。
- **ファイルツリー:** フォルダ内容の遅延読み込み。projectStoreでキャッシュ。
- **FTS5:** trigramトークナイザーは日本語に対応。インデックス更新はインクリメンタル（ドキュメント保存時のみ）。
- **帰属スパン:** document_idでインデックス化。保存時にバッチ更新（キー入力ごとではない）。

### 11.2 大規模Codex（100エントリ以上）

- Codex一覧: 仮想化スクロール（react-windowまたはTanStack Virtual）
- FTS検索: trigramクエリで即時応答
- リレーショングラフ: コンテキスト注入時のホップ深度を2に制限

### 11.3 AIストリーミング

- Tauriイベント経由のストリーミング（HTTPポーリングではない）
- チャット履歴: 直近N件のみ読み込み（デフォルト: 50）、古いメッセージは遅延読み込み
- コンテキストバジェット: ハードキャップにより過大なリクエスト送信を防止

---

## 12. セキュリティ

- APIキーは `tauri-plugin-stronghold` またはOS認証情報マネージャー経由でOSキーチェーンに保存
- すべてのAI API呼び出しはRustバックエンド経由 — キーはフロントエンドに渡さない
- テレメトリーなし、ユーザーが設定したAIプロバイダー以外への外部通信なし
- プロジェクトファイルはローカルのみ

---

## 13. 設定

| 設定項目 | 型 | デフォルト |
|---------|-----|----------|
| `ai.provider` | `"openrouter"` | `"openrouter"` |
| `ai.apiKey` | string（暗号化） | `""` |
| `ai.model` | string | `"anthropic/claude-sonnet-4"` |
| `ai.contextBudget` | number（トークン数） | `8000` |
| `ai.temperature` | number | `0.7` |
| `ai.systemPromptTemplate` | string | （組み込みデフォルト） |
| `editor.autosaveDelay` | number（ミリ秒） | `500` |
| `editor.showAuthorship` | boolean | `true` |
| `editor.authorshipColors.ai` | string | `"#e8f0fe"` |
| `editor.authorshipColors.mixed` | string | `"#fef7e0"` |
| `editor.authorshipColors.unknown` | string | `"#f0f0f0"` |
| `export.sceneSeparator` | string | `"***"` |
| `export.stripFrontmatter` | boolean | `true` |

---

## 14. MVPスコープと境界

### スコープ内（MVP）

- [x] 基本的な書式設定付きTipTapエディタ
- [x] 柔軟なフォルダ階層（ファイルシステムベース）
- [x] SQLite + FTS5 trigramインデックス
- [x] 帰属追跡（Markレベル、SQLite永続化）
- [x] AIチャットパネル（OpenRouter、ストリーミング）
- [x] シーン1:Nスレッド + プロジェクトレベルスレッド
- [x] 自動RAGコンテキスト注入（FTS5） + 手動ピン留め
- [x] Codex: Key-Value + フリーテキストエントリ
- [x] Codex: 明示的な型付きリレーション
- [x] チャットからのCodex抽出（メッセージレベル + AI自動提案）
- [x] チャットからエディタへのテキスト挿入（コピー + 挿入ボタン）
- [x] エクスポート: Markdown + プレーンテキスト
- [x] プロンプトテンプレート（組み込み + カスタム）

### スコープ外（Post-MVP）

- [ ] 埋め込みベースのベクトル検索（RAGアップグレード）
- [ ] 複数AIプロバイダー（直接OpenAI、Anthropic、Ollama）
- [ ] DOCX/EPUBエクスポート
- [ ] 縦書きプレビュー
- [ ] ルビテキスト
- [ ] FTS用日本語形態素解析
- [ ] Codexリレーショングラフ可視化
- [ ] キーストロークリプレイ（Grammarly Authorship風）
- [ ] コラボレーション / マルチユーザー
- [ ] クラウド同期
- [ ] プラグインシステム

---

## 15. 開発フェーズ

### Phase 1: 基盤

- プロジェクトの作成/オープン
- フォルダ階層付きファイルツリー
- 基本的なTipTapエディタ（Markdown読み書き）
- Drizzleスキーマ付きSQLiteセットアップ
- 自動保存

### Phase 2: AIチャット

- 設定UI（APIキー、モデル選択）
- チャットスレッドCRUD
- Rustバックエンド経由のOpenRouter統合
- ストリーミングレスポンス表示
- 基本的なコンテキスト注入（現在のドキュメント）

### Phase 3: Codex

- CodexエントリCRUD（MDファイル + SQLiteインデックス）
- Codexカテゴリとタグ
- ドキュメント・Codex横断のFTS5検索
- ピン留めコンテキスト注入
- 自動RAGコンテキスト構築

### Phase 4: 抽出と統合

- チャットメッセージからの「Codexに保存」
- AI自動Codex候補提案
- 帰属マーク付き「エディタに挿入」
- AI由来ペースト検出付きコピー
- Codexリレーション（追加/削除/クエリ）

### Phase 5: 帰属追跡と仕上げ

- 帰属Mark拡張（TipTap）
- IME入力ハンドリング
- 帰属ビジュアルオーバーレイ
- 帰属スパン永続化（SQLite）
- エクスポート（MD + プレーンテキスト）
- プロンプトテンプレート

### Phase 6: パフォーマンスと品質

- FTS5インデックス最適化
- 大規模Codex用仮想化リスト
- エラーハンドリングとエッジケース
- 相互参照の整合性チェック
- UIの磨き上げとキーボードショートカット
