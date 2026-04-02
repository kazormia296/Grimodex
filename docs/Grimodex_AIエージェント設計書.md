# Grimodex AIエージェント設計書

## 概要

LLMのTool Use（Function Calling）を活用し、プロジェクトデータに対する横断的な検索・集約・分析を可能にする機能。通常のChatパネルのコンテキスト注入が「事前に決まったデータを渡す」のに対し、AIエージェントは「LLMが必要に応じて自分でデータを取りに行く」アプローチを取る。

**解決する課題**: 通常のコンテキスト注入では、LLMは注入されたデータからしか回答できない。「エルフのキャラクターをまとめて」「この設定に矛盾はない？」のような横断クエリには、LLMがプロジェクトデータを能動的に検索・フィルタする手段が必要。

**技術基盤**: Vercel AI SDKの `tools` パラメータ。LLMがツール呼び出しを判断し、結果を受け取って回答を生成する。ツールの実行はTauriバックエンド（Rust）で行い、データはローカルSQLite + ファイルシステムから取得するためレイテンシは最小限。

---

## 利用形態

### 1. エージェントチャット（スタンドアロン）

Chatパネルのグローバルチャット（🌐ボタン）でプロジェクトスコープに切り替えた状態で、エージェントモードを有効化する。

**有効化**: Chatパネルのヘッダーに **エージェントトグル**（🔧アイコン）を配置。ONにするとツール定義がシステムプロンプトに追加され、LLMがツールを使えるようになる。

- エージェントモードON時、コンテキストバーに `[Agent mode]` ピルを表示
- Layer 4（Codex/Snippetの自動注入）は**無効化**される（LLMが必要なデータを自分で取得するため、事前注入は不要かつトークンの無駄）
- Layer 1（Project info）、Layer 3（シーンコンテキスト）、Layer 5（会話履歴）は維持
- シーンスコープでもエージェントモードは使用可能（シーンに関する横断質問に有用）

### 2. コンテキストクリエイター（Chatパネル連携）

通常のChatパネル（エージェントモードOFF）のコンテキストバーから呼び出し、AIにコンテキストを組み立てさせる。

**UI**: コンテキストバーの「+」ボタン横に **「✦ AI」ボタン**を配置。クリックするとインラインの入力欄が表示される。

```
コンテキストバー:
[Project] [Scene: 3,200] [Elara] [+] [✦ AI]  ~2,800 tokens
                                       ↓ クリック
┌──────────────────────────────────────────────────┐
│ コンテキストに追加するものを指示...          [▶]   │
└──────────────────────────────────────────────────┘
```

**フロー**:
1. ユーザーが指示を入力（例: 「エルフに関連するキャラクターと場所を追加して」）
2. 軽量LLM + ツール（`search_codex`, `list_codex_by_type` 等）でエントリを検索
3. 結果をピル候補としてプレビュー表示（チェックボックス付き）
4. ユーザーが確認して「Add」で一括ピン留め

```
┌──────────────────────────────────────────────────┐
│ Found 4 entries:                                  │
│ ☑ Elara (character) — エルフの見習い魔術師         │
│ ☑ Lyria (character) — エルフの長老                 │
│ ☑ Silverwood (location) — エルフの森の都           │
│ ☐ Ancient Tower (location) — 人間の魔術塔          │
│                                   [Add selected]  │
└──────────────────────────────────────────────────┘
```

- 選択されたエントリは `pinned_codex` に `source: 'manual'` として追加
- コンテキストクリエイターは通常のChatセッションのコンテキスト組み立てを支援するだけで、会話履歴には残らない（ワンショット）

---

## ツール定義

### Codex系

#### search_codex

Codexエントリを全文検索する。

```typescript
{
  name: "search_codex",
  description: "Search Codex entries by keyword. Searches across name, aliases, summary, and tags.",
  parameters: {
    query: { type: "string", description: "Search keyword" }
  }
}
```

**実行**: `codex_fts` テーブルのFTS5クエリ。結果は `id`, `name`, `type`, `summary` の一覧（最大20件）。content全文は含めない（トークン節約）。

#### list_codex_by_type

指定タイプのCodexエントリ一覧を取得する。

```typescript
{
  name: "list_codex_by_type",
  description: "List all Codex entries of a specific type (e.g., character, location, item, lore).",
  parameters: {
    type: { type: "string", description: "Entry type slug" }
  }
}
```

**実行**: `codex_entries WHERE type = ?`。結果は `id`, `name`, `summary`, `tags_cache` の一覧。

#### get_codex_entry

Codexエントリの全詳細を取得する。

```typescript
{
  name: "get_codex_entry",
  description: "Get full details of a specific Codex entry including content, custom details, and relationships.",
  parameters: {
    id: { type: "string", description: "Codex entry ID" }
  }
}
```

**実行**: `codex_entries` + Markdownファイル読み込み + `codex_detail_values` JOIN `codex_detail_definitions` + 子エントリ一覧。content全文を含む。

#### list_codex_tags

利用可能なタグ一覧を取得する。

```typescript
{
  name: "list_codex_tags",
  description: "List all available Codex tags, optionally filtered by entry type.",
  parameters: {
    type?: { type: "string", description: "Filter tags by compatible entry type" }
  }
}
```

**実行**: `codex_tags` テーブル + `codex_entry_tags` のカウント。

#### search_codex_by_tags

タグでCodexエントリを検索する。

```typescript
{
  name: "search_codex_by_tags",
  description: "Find Codex entries that have specific tags.",
  parameters: {
    tags: { type: "array", items: { type: "string" }, description: "Tag names to filter by (OR logic)" }
  }
}
```

**実行**: `codex_entry_tags` JOIN `codex_tags` WHERE `name IN (?)` → `codex_entries`。

### Scenes系

#### list_chapters

チャプター・シーン構造の一覧を取得する。

```typescript
{
  name: "list_chapters",
  description: "Get the project's chapter and scene structure with titles and statuses.",
  parameters: {}
}
```

**実行**: `tree_nodes WHERE node_type IN ('part', 'chapter', 'scene')` を階層構造で返す。各ノードの `title`, `status`, `node_type` を含む。content全文は含まない。

#### get_scene

特定シーンの本文を取得する。

```typescript
{
  name: "get_scene",
  description: "Get the full text content of a specific scene.",
  parameters: {
    id: { type: "string", description: "Scene node ID" }
  }
}
```

**実行**: `tree_nodes` + Markdownファイル読み込み。

#### search_scenes

シーン本文を全文検索する。

```typescript
{
  name: "search_scenes",
  description: "Search across all scene texts for a keyword or phrase.",
  parameters: {
    query: { type: "string", description: "Search keyword" }
  }
}
```

**実行**: シーンのMarkdownファイルをgrep検索（FTS5はシーン本文には未対応のため、ファイルシステム検索）。結果はシーンID、タイトル、マッチ周辺のスニペット（最大10件）。

### Snippets系

#### search_snippets

Snippetを検索する。

```typescript
{
  name: "search_snippets",
  description: "Search snippets by keyword across title, content, and tags.",
  parameters: {
    query: { type: "string", description: "Search keyword" }
  }
}
```

**実行**: `snippets_fts` テーブルのFTS5クエリ。結果は `id`, `title`, `tags`, contentの先頭200文字（最大10件）。

### Chapter Summaries系

#### get_chapter_summaries

チャプター要約を取得する。

```typescript
{
  name: "get_chapter_summaries",
  description: "Get auto-generated summaries for all chapters.",
  parameters: {}
}
```

**実行**: チャプターノード + 要約データを返す。

---

## ツール実行フロー

### エージェントチャットの場合

```
ユーザー: 「エルフのキャラクターをまとめて」

  → LLM（ツール定義付きシステムプロンプト）
  ← tool_call: list_codex_by_type({ type: "character" })
  → 実行結果: [{name: "Elara", summary: "..."}, {name: "Lyria", ...}, ...]
  ← tool_call: get_codex_entry({ id: "elara-id" })  // 詳細が必要と判断
  → 実行結果: {name: "Elara", content: "...", details: {...}}
  ← tool_call: get_codex_entry({ id: "lyria-id" })
  → 実行結果: {name: "Lyria", content: "...", details: {...}}
  ← 最終回答: 「プロジェクトには以下のエルフキャラクターがいます...」
```

### コンテキストクリエイターの場合

```
ユーザー: 「エルフに関連するキャラクターと場所」

  → 軽量LLM（ツール定義付き、応答形式を「IDリスト」に限定）
  ← tool_call: search_codex({ query: "エルフ" })
  → 実行結果: [{id: "elara-id", name: "Elara", type: "character"}, ...]
  ← tool_call: list_codex_by_type({ type: "location" })
  → 実行結果: [{id: "silverwood-id", name: "Silverwood", ...}, ...]
  ← 最終回答: { suggested_ids: ["elara-id", "lyria-id", "silverwood-id", ...] }

  → UI: チェックボックス付きプレビュー表示
  → ユーザー: 選択して「Add」
  → pinned_codex に追加
```

---

## ツール呼び出しの制約

### 最大呼び出し回数

1メッセージあたりのツール呼び出し上限を **10回** に設定する。無限ループ防止。上限到達時はLLMに「ツール呼び出し上限に達しました。現在の情報で回答してください」とシステムメッセージを挿入。

### トークン予算

ツール実行結果はLLMのコンテキストに蓄積されるため、使用モデルのコンテキスト上限から動的に算出する:

```
ツール結果予算 = モデルコンテキスト上限
              - Layer 1（Project info）
              - Layer 3（シーンコンテキスト、有効時）
              - Layer 5（会話履歴）
              - 応答予約（2,000 tokens）
```

**上限キャップ: 32,000 tokens**（大コンテキストモデルでも無制限にはしない）

例:
| モデル | コンテキスト上限 | 他Layer消費 | ツール結果予算 |
|--------|----------------|------------|--------------|
| Claude Sonnet (200k) | 200,000 | ~28,000 | **32,000**（キャップ） |
| GPT-4o (128k) | 128,000 | ~28,000 | **32,000**（キャップ） |
| Ollama llama3 (8k) | 8,000 | ~4,000 | **2,000** |

- 予算超過時は以降のツール呼び出しを拒否し、LLMに「ツール結果のトークン予算に達しました。現在の情報で回答してください」とシステムメッセージを挿入
- 各ツールの返却データを適切にトリムする（content全文は `get_codex_entry` のみ、一覧系は summary + メタデータのみ）
- 予算残量はツール呼び出しの可視化ブロック内に表示（例: 「~18,200 / 32,000 tokens used」）

### 読み取り専用

全ツールは読み取り専用。データの変更・作成・削除は行わない。将来的に書き込みツール（エントリ作成等）を追加する場合は、ユーザー確認ステップを必須とする。

---

## UIの詳細

### エージェントモードトグル

Chatパネルのヘッダー、グローバルチャットボタン（🌐）の隣に配置:

```
[Chat] [Scene: The tower ▾] [🌐] [🔧]     [Sessions] [+]
                                   ↑
                              Agent mode toggle
```

- OFF（デフォルト）: 通常のコンテキスト注入モード
- ON: ツール定義がシステムプロンプトに追加。コンテキストバーに `[Agent mode]` ピル表示
- トグル切替はセッション内で即時反映。セッションをまたいでは永続化しない

### ツール呼び出しの可視化

エージェントモード時、AIメッセージ内でツール呼び出しを可視化する:

```
AI: エルフのキャラクターを探します。

  🔧 list_codex_by_type({ type: "character" })
  └─ 8 entries found

  🔧 search_codex({ query: "エルフ" })
  └─ 3 entries found

プロジェクトには以下のエルフキャラクターがいます:
1. **Elara** — エルフの見習い魔術師...
2. **Lyria** — エルフの長老...
```

- ツール呼び出しは折りたたみ可能なブロックとして表示
- デフォルトは折りたたみ状態（結果サマリーのみ表示）
- 展開するとツールのパラメータと返却データの全体が見える
- ストリーミング中はツール呼び出しがリアルタイムに表示される

### コンテキストクリエイター

コンテキストバーの「✦ AI」ボタンの詳細動作:

1. クリック → コンテキストバー直下にインライン入力欄がスライドダウン
2. 入力して送信 → 「Searching...」インジケーター表示
3. 結果返却 → チェックボックス付きエントリリスト表示
   - 各エントリ: チェックボックス + name + type バッジ + summary先頭50文字
   - 全選択/全解除ボタン
   - 既にピン留め済みのエントリはチェック済み + 「Already pinned」ラベル
4. 「Add selected」クリック → 選択エントリを `pinned_codex` に `source: 'manual'` で追加
5. 入力欄が閉じ、コンテキストバーのピルが更新される

**キャンセル**: `Escape` または入力欄外クリックで閉じる（選択破棄）。

---

## セッションへの永続化

### エージェントモードの状態

`chat_sessions` テーブルにカラムは追加しない。エージェントモードのON/OFFはUIの一時的な状態として、Zustand storeにのみ保持する。セッションを再度開いた際はデフォルトOFF。

理由: エージェントモードはセッションの特性ではなく、ユーザーの一時的な操作モード。過去のエージェントセッションを開き直した時に自動でONになると、意図しないツール呼び出しが発生するリスクがある。

### ツール呼び出し履歴

`chat_messages.metadata` JSONフィールドにツール呼び出しの記録を保存する:

```json
{
  "tool_calls": [
    {
      "name": "search_codex",
      "params": { "query": "エルフ" },
      "result_summary": "3 entries found",
      "tokens_used": 450
    },
    {
      "name": "get_codex_entry",
      "params": { "id": "elara-id" },
      "result_summary": "Elara (character)",
      "tokens_used": 1200
    }
  ]
}
```

これにより、Chat Historyで過去のエージェントセッションを開いた際にツール呼び出しの可視化を再現できる。

---

## エラーハンドリング

| エラー | 対応 |
|--------|------|
| ツール実行失敗（DB接続エラー等） | エラーメッセージをツール結果としてLLMに返す。LLMは代替アプローチを試みるか、エラーを報告する |
| 不正なツールパラメータ | バリデーションエラーをツール結果として返す。LLMがパラメータを修正して再試行 |
| ツール呼び出し上限到達 | システムメッセージ挿入。LLMは既に取得したデータで回答を生成 |
| トークン予算超過 | 以降のツール呼び出しを拒否。LLMは既存データで回答 |
| LLMがツール非対応（Ollamaの一部モデル等） | エージェントモードトグルを無効化（グレーアウト）。ツールチップ「このモデルはAgent modeに対応していません」 |

---

## モデル互換性

Tool Use対応はモデルによって異なる:

| プロバイダ | Tool Use対応 | 備考 |
|-----------|-------------|------|
| OpenRouter | モデル依存 | Claude、GPT-4系は対応。小型モデルは非対応の場合あり |
| Anthropic | Claude 3+全モデル | 完全対応 |
| OpenAI | GPT-4o、GPT-4系 | 完全対応 |
| Ollama | モデル依存 | llama3.1+は一部対応。非対応モデルではエージェントモード無効 |

エージェントモードトグルは、現在のセッションモデルがTool Useに対応している場合のみ有効化する。対応状況は各プロバイダのSDK（`supportsToolUse` 等）またはSettings内のモデル設定で管理する。

---

## Chatパネル設計書との関係

本設計書はChatパネル設計書の拡張として機能する。以下の項目はChatパネル設計書の定義を継承:

- セッションモデル、メッセージ永続化（`chat_sessions`, `chat_messages`）
- ストリーミング表示（Vercel AI SDK `streamText()`）
- AIメッセージのアクションボタン（Insert, Codex, Snippet, Copy）
- エラーハンドリングの基本方針
- Authorship伝搬（`application/x-grimodex-authorship`）

エージェントモード固有の差分のみ本設計書で定義する。
