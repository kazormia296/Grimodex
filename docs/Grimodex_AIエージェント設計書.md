# Grimodex AIエージェント設計書

## 概要

LLMのTool Use（Function Calling）を活用し、プロジェクトデータに対する横断的な検索・集約・分析を可能にする機能。通常のChatパネルのコンテキスト注入が「事前に決まったデータを渡す」のに対し、AIエージェントは「LLMが必要に応じて自分でデータを取りに行く」アプローチを取る。

**解決する課題**: 通常のコンテキスト注入では、LLMは注入されたデータからしか回答できない。「エルフのキャラクターをまとめて」「この設定に矛盾はない？」のような横断クエリには、LLMがプロジェクトデータを能動的に検索・フィルタする手段が必要。

**技術基盤**: Vercel AI SDKの `tools` パラメータ。LLMがツール呼び出しを判断し、結果を受け取って回答を生成する。ツールの実行はTauriバックエンド（Rust）で行い、データはローカルSQLiteから取得するためレイテンシは最小限。

---

## 利用形態

### 1. エージェントチャット（スタンドアロン）

Chatパネルのグローバルチャット（🌐ボタン）でプロジェクトスコープに切り替えた状態で、エージェントモードを有効化する。

**有効化**: ChatInput 下段ツール列の **AI オプション ポップオーバー**（🔧 Wrench アイコン）内に **「Agent mode」チェックボックス**を配置（`src/features/chat/components/ChatInput.tsx`）。ONにするとツール定義がシステムプロンプトに追加され、LLMがツールを使えるようになる。Thinking トグルも同じポップオーバー内にあり、両者を一括で切り替えられる。

- エージェントモードON時、コンテキストバーに `[Agent]`（Bot アイコン）ピルを表示
- 探索性が高そうな問いが入力欄に書かれた場合、ChatInput 上に「Agent mode で送る」サジェストチップが現れる（`agentSuggestion.ts` の `shouldSuggestAgentMode`）。応答後に「情報が足りない」系の文言を検出した場合は再試行サジェストも出る（`looksLikeMissingInfo`）
- **Layer 1〜Layer 5 はすべて通常モードと同じ内容で注入される**。Agent モードは「事前注入を捨ててツール任せにする」モードではなく、「事前注入された summary を起点に、必要に応じて深掘りツールを呼べる」拡張モードと位置づける:
	- 自動検出 Codex の summary、Spotlight された Codex の本文・custom details、Spotlight された Snippet、active tab content、storySoFar、conversation summary はすべて事前注入
	- LLM は注入済みの summary で十分なら回答に直接使い、不足する場合のみ `get_codex_entry` で本文・custom details を取りに行く（階層的アクセス）
	- 注入されていないエントリ（自動検出にも Spotlight にも含まれない）は `search_codex` / `list_codex_by_type` / `search_codex_by_tags` で能動的に探索する
- 横断クエリ（「エルフのキャラクターをまとめて」「○○の設定との矛盾は？」）はツール呼び出しで対応する
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
4. ユーザーが確認して「Add」で一括 Spotlight

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

- 選択されたエントリは `chat_session_pinned_codex` に `pin_source: 'manual'` として追加（実装上の table 名は `chat_session_pinned_codex`。`pinSource` には他に `'chat_mention'` がある）
- コンテキストクリエイターは通常のChatセッションのコンテキスト組み立てを支援するだけで、会話履歴には残らない（ワンショット）
- 実装: 内部的に `runAgentLoop` を再利用しつつ、ツールサブセット（`search_codex` / `list_codex_by_type` / `search_codex_by_tags` / `search_snippets`）と `effort: chat` (低 effort)、固定 2,000 トークン予算で実行する（`src/features/chat/contextCreatorApi.ts`）。LLM には最終応答として `[{id, name, type, summary, reason}]` 形式の JSON 配列を返すよう指示する

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

**実行**: `codex_entries`（`content` カラムから本文取得）+ `codex_detail_values` JOIN `codex_detail_definitions` + 子孫エントリ一覧（BFS順、`children_budget` トークン内のsummary）。content全文を含む。

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

#### find_related_entries

起点エントリの name + aliases を、他エントリの name / summary / aliases / tags_cache に対して LIKE-OR 検索する関係探索ツール。「〇〇の所持品は？」「〇〇に関連する場所は？」のような自然言語の関係質問に対し、`search_codex` への複数語クエリ（trigram の限界で空振りしやすい）の代替として用意する。

```typescript
{
  name: "find_related_entries",
  description: "Find entries that reference a given source entry by name or alias.",
  parameters: {
    id: { type: "string", description: "Source entry UUID" },
    type: { type: "string", description: "Optional type filter" }
  }
}
```

**実行**: 起点エントリの name と aliases を集め、`codex_entries` の name / summary / aliases / tags_cache に対して LIKE-OR で per-token 検索。自分自身は除外、type 指定時はそれで絞り込み。最大 20 件。Embedding 不要、既存の SQL infra で完結する。

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

**実行**: `tree_nodes` の `content` カラムから本文を取得。

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

**実行**: `tree_nodes` のFTS5全文検索（`tree_nodes_fts` テーブル）。結果はシーンID、タイトル、マッチ周辺のスニペット（最大10件）。

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

### Foreshadow / Timeline 系

伏線（foreshadow）とストーリー時系列（story-time order）はそれぞれ専用 store・テーブルで管理されており、エージェントから能動的に参照できる。詳細は対応する設計書（`Grimodex_伏線設計書.md` 等）を参照。

#### list_open_foreshadows

未回収の伏線一覧を取得する。

```typescript
{
  name: "list_open_foreshadows",
  description: "List all unresolved foreshadowing items (payoff not confirmed and not abandoned).",
  parameters: {}
}
```

**実行**: `listOpenForeshadowsForContext(projectId)` 経由。`id`, `title`, `intent`, `loadBearing`（critical/supporting/optional/null）, `setupCount`（非 orphan）を返す。loadBearing 優先度 → 更新日時順。注: 優先度の高い小さなスライスはシステムプロンプトの `### 未回収の伏線` セクションに事前注入されている。

#### get_foreshadow_detail

特定の伏線の詳細（setup 一覧、payoff scene、AI rationale 等）を取得する。

```typescript
{
  name: "get_foreshadow_detail",
  description: "Get full detail for a single foreshadow including setups, payoff scene, and notes.",
  parameters: {
    id: { type: "string", description: "Foreshadow UUID" }
  }
}
```

#### get_scene_timeline_neighbors

指定シーンのストーリー時系列上の前後シーン（読み順ではなく作中時系列）を返す。

```typescript
{
  name: "get_scene_timeline_neighbors",
  description: "Get up to 3 preceding and 3 following scenes in story-time order.",
  parameters: {
    sceneId: { type: "string", description: "Scene node id" }
  }
}
```

**実行**: 同 project 内の `storyTimeOrder` 付きシーンを fractional-index 比較で前後 3 件ずつ返す。`storyTimeLabel`（例: 「3年前」）と synopsis を含む。

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
  → chat_session_pinned_codex に追加
```

---

## ツール呼び出しの制約

### 最大呼び出し回数

1メッセージあたりのツール呼び出し上限を **10回** に設定する。無限ループ防止。並列ツール呼び出し（LLMが1レスポンスで複数の `tool_use` を返すケース）では、**各ツール呼び出しを個別に1回としてカウント**する（例: 並列3呼び出し = 3回消費）。トークン予算への影響は並列・逐次で同一であるため、カウント方法も統一する。上限到達時はLLMに「ツール呼び出し上限に達しました。現在の情報で回答してください」とシステムメッセージを挿入。

### トークン予算

ツール実行結果はLLMのコンテキストに蓄積されるため、使用モデルのコンテキスト上限から動的に算出する:

```
ツール結果予算 = モデルコンテキスト上限 × 30%
              （最小 2,000 tokens）
```

この 30% は他 Layer（L1〜L4 + 会話履歴）の消費とは独立した「ツール結果専用バジェット」として扱う。事前注入される L1〜L4 と会話履歴は `buildSystemPrompt` 側の `trimToFit`（L5→L4→L2→L3→L1 の順でトリム）で contextWindow に収まるよう自動調整されるため、両者は競合しない。比率ベースとすることで、8k モデルから 1M モデルまで一貫してスケールする。

例:
| モデル | コンテキスト上限 | ツール結果予算 (30%) |
|--------|----------------|---------------------|
| Ollama llama3 (8k) | 8,000 | **2,400** |
| GPT-4o (128k) | 128,000 | **38,400** |
| Claude Sonnet (200k) | 200,000 | **60,000** |
| Claude Opus (1M) | 1,000,000 | **300,000** |

- 予算超過時は以降のツール呼び出しを拒否し、LLMに「ツール結果のトークン予算に達しました。現在の情報で回答してください」とシステムメッセージを挿入
- 各ツールの返却データを適切にトリムする（content全文は `get_codex_entry` のみ、一覧系は summary + メタデータのみ）
- 予算残量はツール呼び出しの可視化ブロック内に表示（例: 「~18,200 / 60,000 tokens used」）

### 読み取り専用

全ツールは読み取り専用。データの変更・作成・削除は行わない。将来的に書き込みツール（エントリ作成等）を追加する場合は、ユーザー確認ステップを必須とする。

### 既注入エントリへの short-circuit

`get_codex_entry` が、システムプロンプトに既に full body + custom details + aliases ごと注入されているエントリ（= `fullyInjectedIds`、Spotlight された Codex などが対象）に対して呼ばれた場合、`toolExecutors` を経由せずに「既に注入済み」を示すスタブ結果を返す（`src/features/chat/chatStore.ts` の `guardedExecuteTool`）。LLM がプロンプト指示に従わず再 fetch しがちな挙動への保険であり、トークン浪費を防ぐ。

---

## UIの詳細

### エージェントモードトグル

ChatInput 下段ツール列の 🔧 Wrench アイコン（AI オプション ポップオーバー）内に Agent mode / Thinking mode のチェックボックスを並べる:

```
┌─ ChatInput card ──────────────────────────┐
│ [TipTap editor]                            │
│ [🔧][model picker]            [Send ▶]    │
└────────────────────────────────────────────┘
            ↓ 🔧 クリック
   ┌──────────────────────────┐
   │ ☑ Agent mode             │
   │ ☑ Thinking mode          │
   └──────────────────────────┘
```

- OFF（デフォルト）: 通常のコンテキスト注入モード
- ON: ツール定義が `send_agent_message` に渡される。コンテキストバーに `[Agent]`（Bot アイコン）ピル表示
- トグル切替はセッション内で即時反映。`chatStore.agentMode` で管理し、セッション再開時はデフォルト OFF（永続化しない）
- 探索的な問いに対しては、ChatInput 上のサジェストチップ（`shouldSuggestAgentMode` ヒューリスティクス）から **一回限りの Agent mode override** で送信できる（永続トグルは変えない）

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
   - 既に Spotlight 済みのエントリはチェック済み + 「Already spotlighted」ラベル
4. 「Add selected」クリック → 選択エントリを `chat_session_pinned_codex` に `pin_source: 'manual'` で追加
5. 入力欄が閉じ、コンテキストバーのピルが更新される

**キャンセル**: `Escape` または入力欄外クリックで閉じる（選択破棄）。

---

## セッションへの永続化

### エージェントモードの状態

`chat_sessions` テーブルにカラムは追加しない。エージェントモードのON/OFFはUIの一時的な状態として、Zustand storeにのみ保持する。セッションを再度開いた際はデフォルトOFF。

理由: エージェントモードはセッションの特性ではなく、ユーザーの一時的な操作モード。過去のエージェントセッションを開き直した時に自動でONになると、意図しないツール呼び出しが発生するリスクがある。

### ツール呼び出し履歴

`chat_messages.metadata` JSON フィールドに、ツール呼び出し記録（`tool_calls`）と最終応答の thinking ブロック（`thinking_blocks`、signature 込み）を保存する。フィールド名は `agentTypes.ts` の `ToolCallRecord` 型に合わせて camelCase（`resultSummary` / `tokensUsed`）:

```json
{
  "tool_calls": [
    {
      "name": "search_codex",
      "params": { "query": "エルフ" },
      "resultSummary": "3 entries found",
      "tokensUsed": 450
    },
    {
      "name": "get_codex_entry",
      "params": { "id": "elara-id" },
      "resultSummary": "Elara (character)",
      "tokensUsed": 1200
    }
  ],
  "thinking_blocks": [
    { "thinking": "...", "signature": "..." }
  ]
}
```

これにより、Chat Historyで過去のエージェントセッションを開いた際にツール呼び出しと thinking の可視化を再現できる。ツール呼び出しのストリーミング中も `onToolComplete` ごとに同 metadata を更新するため、進行中の表示も保たれる。

---

## エラーハンドリング

| エラー | 対応 |
|--------|------|
| ツール実行失敗（DB接続エラー等） | エラーメッセージをツール結果としてLLMに返す。LLMは代替アプローチを試みるか、エラーを報告する |
| 不正なツールパラメータ | バリデーションエラーをツール結果として返す。LLMがパラメータを修正して再試行 |
| ツール呼び出し上限到達 | システムメッセージ挿入。LLMは既に取得したデータで回答を生成 |
| トークン予算超過 | 以降のツール呼び出しを拒否。LLMは既存データで回答 |
| LLMがツール非対応（Ollamaの一部モデル等） | エージェントモードトグルを無効化（グレーアウト）。ツールチップ「このモデルはAgent modeに対応していません」 |

**ネットワーク不通時:** エージェントモードのLLM呼び出しが失敗した場合、進行中のツール呼び出しチェーンは中断され、エラーメッセージをチャットに表示する。ローカルOllamaモデル使用時はネットワーク不通の影響を受けない。

---

## モデル互換性

Tool Use対応はモデルによって異なる:

| プロバイダ | Tool Use対応 | 備考 |
|-----------|-------------|------|
| OpenRouter | モデル依存 | Claude、GPT-4系は対応。小型モデルは非対応の場合あり |
| Anthropic | Claude 3+全モデル | 完全対応 |
| OpenAI | GPT-4o、GPT-4系 | 完全対応 |
| Ollama | モデル依存 | llama3.1+は一部対応。非対応モデルではエージェントモード無効 |
| AI のべりすと | 非対応 | `resolveModelCapabilities` で `supportsTools: false` 固定（KoboldAI 系 API のため） |
| CLI（Claude Code 等） | 非対応 | subprocess 経由のためツール呼び出し不可。`supportsTools: false` 固定で、Agent mode ON のままでも送信時は通常チャットパス（`sendCliChatStream`）にフォールバックする |

エージェントモードトグルは、現在のセッションモデルがTool Useに対応している場合のみ有効化する。対応状況は `getModelCapabilities` / `resolveModelCapabilities`（`src/features/chat/agent/modelLimits.ts`）の `supportsTools` で判定し、UI 側では ChatInput の `canUseTools` フラグで Agent mode チェックボックスをグレーアウトする。

### 拡張思考・effortとの併用

エージェントモードでは **effort: `high`** を使用する（ツール選択の判断精度が重要なため）。モデルが拡張思考に対応している場合は常に有効化する:

- Opus 4.6 / Sonnet 4.6: `thinking: { type: "adaptive", effort: "high" }` — interleaved thinking が自動有効化され、ツール結果を受け取った後にも思考してから次のツール呼び出しを判断する
- 旧モデル: `thinking: { type: "enabled", budget_tokens: N }` + `effort: "high"` + `interleaved-thinking-2025-05-14` ベータヘッダー

**interleaved thinking のAgent modeへの効果**: ツール呼び出しの間にthinkingが入ることで、中間結果を推論してから次のアクションを決定できる。例: `search_codex` の結果を見て「この情報では不十分」と判断し、`get_codex_entry` で詳細を取得する、という段階的な推論が可能。

エージェントモードではUI上にツール呼び出しと思考が交互に表示される。各thinkingブロックは折りたたみ表示（Chatパネル設計書の仕様に従う）。`display: "summarized"` を使用し、ユーザーがエージェントの推論過程を追跡できるようにする。

詳細はChatパネル設計書「拡張思考（Extended Thinking）とeffortパラメータ」セクションを参照。

---

## Chatパネル設計書との関係

本設計書はChatパネル設計書の拡張として機能する。以下の項目はChatパネル設計書の定義を継承:

- セッションモデル、メッセージ永続化（`chat_sessions`, `chat_messages`）
- ストリーミング表示（Vercel AI SDK `streamText()`）
- AIメッセージのアクションボタン（Insert, Codex, Snippet, Copy）
- エラーハンドリングの基本方針
- Authorship伝搬（`application/x-grimodex-authorship`）

エージェントモード固有の差分のみ本設計書で定義する。
