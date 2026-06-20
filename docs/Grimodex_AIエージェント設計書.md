# Grimodex AIエージェント設計書

## 概要

LLMのTool Use（Function Calling）を活用し、プロジェクトデータに対する横断的な検索・集約・分析を可能にする機能。通常のChatパネルのコンテキスト注入が「事前に決まったデータを渡す」のに対し、AIエージェントは「LLMが必要に応じて自分でデータを取りに行く」アプローチを取る。

**解決する課題**: 通常のコンテキスト注入では、LLMは注入されたデータからしか回答できない。「エルフのキャラクターをまとめて」「この設定に矛盾はない？」のような横断クエリには、LLMがプロジェクトデータを能動的に検索・フィルタする手段が必要。

**技術基盤**: Vercel AI SDKの `tools` パラメータ。LLMがツール呼び出しを判断し、結果を受け取って回答を生成する。ツールの実行はTauriバックエンド（Rust）で行い、データはローカルSQLiteから取得するためレイテンシは最小限。

---

## 利用形態

### 1. エージェントチャット（スタンドアロン）

Chatパネルのグローバルチャット（🌐ボタン）でプロジェクトスコープに切り替えた状態で、エージェントモードを有効化する。

**有効化**: ChatInput 下段ツール列に Agent mode と Thinking mode を**独立した chips として配置**する（`src/features/chat/components/ChatInput.tsx`）。Agent mode は Bot/BotOff アイコン、Thinking mode は Lightbulb/LightbulbOff アイコンを使用し、同じツールバー行に並べられるが、共有ポップオーバーでのグループ化はされていない（両者は同じツールバー行の Model picker・Template picker などの他コントロールと一列に並ぶ）。Agent mode の chip を ON にするとツール定義がシステムプロンプトに追加され、LLMがツールを使えるようになる。

- エージェントモードON時、コンテキストバーに `[Agent]`（Bot アイコン）ピルを表示
- 探索性が高そうな問いが入力欄に書かれた場合、ChatInput 上に「Agent mode で送る」サジェストチップが現れる（`agentSuggestion.ts` の `shouldSuggestAgentMode`）。応答後に「情報が足りない」系の文言を検出した場合は再試行サジェストも出る（`looksLikeMissingInfo`）
- **Layer 1〜Layer 5 はすべて通常モードと同じ内容で注入される**。Agent モードは「事前注入を捨ててツール任せにする」モードではなく、「事前注入された summary を起点に、必要に応じて深掘りツールを呼べる」拡張モードと位置づける:
	- 自動検出 Codex の summary、Spotlight された Codex の本文・custom details、Spotlight された Snippet、active tab content、storySoFar、conversation summary はすべて事前注入
	- 拡張された注入層（`contextBuilder.ts`）: **Note エントリ**（言及／context_mode=always、L4）、**relation-BFS で展開された Codex**（`relationVia` ラベル付き、L4 pri 1）、**ピン留めされた Map Sticky**（L4）、**未回収の伏線**（`### 未回収の伏線` / シーンスコープでは `### このシーンの伏線`、loadBearing 優先度順）も事前注入される
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

### ツール定義のプロンプト位置

Agent モードで公開するツール定義 (`search_codex`, `get_codex_entry`,
`find_related_entries`, `get_scene`, `search_codex_by_tags` 等) は、
プロンプト構築の **L1 直後・L2 より前** に固定配置する。これは OpenAI / Anthropic
両者のプレフィックスキャッシュキーにツール定義が含まれるため、途中で変更すると
全レイヤーのキャッシュが無効化されるため。

設計ルール:

- **セッション開始時に決まったツールセットは途中で増減しない**
- 新ツールが必要になった場合は新セッションへ
- ツール定義の JSON 順序も決定的に (オブジェクトキーソート + tools 配列の名前順)
- ツールスキーマの microversion 変更 (新オプション追加等) もキャッシュを破壊するため、
  セッション開始時にスナップショットを取って固定するか、新セッションへ

## ツール定義

### Codex系

#### search_codex

Codexエントリおよび Note を全文検索する。

```typescript
{
  name: "search_codex",
  description: "Search Codex entries and Notes by keyword across name, aliases, summary, and tags.",
  parameters: {
    query: { type: "string", description: "Search keyword" }
  }
}
```

**実行**: `codex_fts` テーブルのFTS5クエリ（短トークンを含む場合は `name`/`summary`/`tags_cache`/`aliases`/`content` への LIKE-OR フォールバック）。結果は `id`, `name`, `type`, `summary` の一覧（最大20件）。content全文は含めない（トークン節約）。**ハイブリッド検索**: dense（semantic）arm を sparse（FTS/LIKE）と RRF 融合する。後述「Codex ハイブリッド検索（2026-06-18 追記）」を参照。

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

### 書き込み系（AiPolicy ゲート付き）（2026-06-18 追記）

以下の 7 ツールは **読み取り専用ではなく、プロジェクトデータを変更する**。当初は全ツール read-only だったが、AI が自律的に Codex・伏線・Snippet・ツリー構造・本文プロポーザルを書けるよう拡張された。実装は `src/features/agent-writes/`、Tauri backend は `src-tauri/src/commands/agent_writes.rs`。

各ツールは実行前に `blockIfPolicyOff(feature)`（`src/features/ai-policy/policyGuard.ts`）で対応する **AiPolicy トグル**（`AiFeature`: `knowledgeWrite` / `structureWrite` / `bodyWrite`）を確認し、OFF なら例外を投げて何も変更しない（fail-closed）。dispatch 上も `READ_ONLY_EXECUTORS` と `MUTATING_EXECUTORS` を分離し（`toolExecutors.ts`、両者 `Object.freeze`）、`run_research` サブエージェントには `READ_ONLY_EXECUTORS` しか渡さない。

| ツール | 必要 policy | 動作 |
|--------|------------|------|
| `create_codex_entry` | `knowledgeWrite` | Codex エントリを新規作成。`type`/`name` 必須、`summary`/`content`(ProseMirror JSON)/`aliases`/`parentId` 任意。AI 帰属マークを付与。 |
| `update_codex_entry` | `knowledgeWrite` | 既存エントリの提供フィールドのみ更新（楽観ロック `baseVersion`）。 |
| `create_foreshadow` | `knowledgeWrite` | 伏線（plant）を新規作成。`title` 必須、`intent`/`notes`/`loadBearing`(critical/supporting/optional)/`secret` 任意。`secret` は **既定 true**（秘匿 plant は `list_open_foreshadows` と AI コンテキストから除外）。 |
| `update_foreshadow` | `knowledgeWrite` | 伏線の更新。`payoffConfirmed`/`abandoned` のマークも可。 |
| `create_snippet` | `knowledgeWrite` | Snippet を新規作成。`title` 必須、`content`/`sceneId` 任意。 |
| `apply_ai_tree_plan` | `structureWrite`（synopsis 付き op がある場合は `bodyWrite` も） | ツリーの scaffold/reorganize プラン（create/move/rename、最大 200 ops）を適用。新規ノードは `tmp:` プレフィックスの temp ID を使う。 |
| `propose_scene_body` | `bodyWrite` | シーン本文プロポーザル。**即時適用せずステージングし、ユーザーがエディタで accept/reject するまで反映しない**（`proseStagingStore`）。`mode` は `append`（末尾）/ `insert`（開いているシーンのキャレット位置）。file-backed シーンは対象外。 |

```typescript
{
  name: "propose_scene_body",
  description: "Propose plain-text body prose for a scene (staged accept/reject — does not apply until the user accepts in the editor). Requires bodyWrite policy. File-backed scenes are excluded.",
  parameters: {
    sceneId: { type: "string", description: "Target scene UUID" },
    text: { type: "string", description: "Plain-text prose to propose" },
    mode: { type: "string", enum: ["append", "insert"], description: "Optional: append (end of scene) or insert (at caret). Defaults to append." }
  },
  required: ["sceneId", "text"]
}
```

`sceneId` / `text` のみ必須で、`mode` は任意（未指定時は `append`）。実装上は `inputSchema.required` が `["sceneId", "text"]`（`mode` は properties に定義されるが required には含めない）。

書き込みは AI 帰属（`application/x-grimodex-authorship` / `authorshipSpans`）と undo ジャーナル（`globalHistoryStore`）に連動する。DB スキーマ詳細（`prose_staging` 等）は [`Grimodex_統合DBスキーマ.md`](./Grimodex_統合DBスキーマ.md) を参照。

### サブエージェント委譲 / ユーザーへの質問（2026-06-18 追記）

#### run_research

読み取り専用のリサーチ・サブタスクを、**独立したツール呼び出し予算とコンテキストを持つサブエージェント**へ委譲する。子は自前で調査し、生データではなく要約（finalText）だけを tool_result として親に返すため、深い調査を**親の 1 ツール呼び出し**に圧縮できる（`chatStore.ts` の `guardedExecuteTool` が `RESEARCH_SUBAGENT_TOOL` を横取りして `runAgentLoop` を再帰起動）。

```typescript
{
  name: "run_research",
  description: "Delegate a focused, read-only research sub-task to a sub-agent that has its OWN fresh tool-call budget and context. Returns a concise written summary, not raw data.",
  parameters: {
    task: { type: "string", description: "Self-contained research instruction incl. starting ids" }
  }
}
```

- 子に渡すツールは `getResearchSubagentTools()`（`READ_ONLY_TOOL_NAMES` の読み取りサブセット）のみで、**`run_research` 自身を含まない**ため再帰深さは構造的に 1 に固定される（depth=1）。dispatch も `executeReadOnlyTool` 経由で二重ガード。
- 予算分割: 子のトークン予算は親の半分（最低 2,000）、ツール呼び出し上限は `floor(parentMaxToolCalls / 2)`（最低 3）。親 Stop / セッション切替は `shouldAbort` で子へ伝播する。
- 1 ターンあたりのサブエージェント起動上限は `MAX_SUBAGENT_CALLS = 4`（親のデータツール予算とは別枠。各起動は親予算も 1 消費）。子の LLM usage は親メッセージと同じ `traceId` で ai_usage 台帳に記録する。

#### ask_user

ユーザーに 1 つ以上の質問をして、**回答が返るまでループを待機**させる（会話を一時停止し、UI のインライン回答で `_resolveUserQuestion` の Promise が resolve される）。曖昧な指示・分岐する創作判断・重大操作の確認など、エージェント自身で解消できない本物の分岐にのみ使う。

```typescript
{
  name: "ask_user",
  description: "Ask the user one or more questions and WAIT for their answer before continuing.",
  parameters: {
    questions: { type: "array", items: { /* question, header?, kind: single|multi|text, options?, allowFreeText? */ } }
  }
}
```

- `ask_user` はデータ取得予算（`maxToolCalls`）を消費せず**別枠でカウント**する（`DEFAULT_MAX_USER_QUESTIONS = 8`、`agentLoop.ts`）。
- `EXECUTORS` には含めず、`guardedExecuteTool` が UI 往復として横取りする（`run_research` と同様）。

### Codex ハイブリッド検索（2026-06-18 追記）

`search_codex` は sparse（FTS5/LIKE）に加えて dense（semantic embedding）arm を併用し、両者の順位を **Reciprocal Rank Fusion (RRF)** で融合する（`fuseCodexHybrid`、`codexHybridSearch.ts`）。

- dense arm は `codexSemanticSearch`（`limit: 30`）。feature 無効ビルド / 未 index / モデル不在では reject → **sparse 単独へグレースフルに退避**（= 従来挙動）。
- 検索ツールなので、文脈注入で使う precision ゲート（top-1 gate / rescue-floor / 閾値）は **かけない**。dense と sparse の順位を素直に RRF 融合し、上位 20 件を返すだけ（関連性の最終判断は LLM 側）。文脈注入の `selectHybridRecallChunks` とは用途が異なる。
- 同一エントリが両 arm にある場合は RRF が加算されて上位に来る。表示データは dense 優先（name/type/summary が確実）、無ければ sparse 行を使う。
- agent 経路の Codex 作成・更新（`create_codex_entry` / `update_codex_entry`）も `scheduleCodexIndex` で semantic index へ反映される（debounce + Rust 側 hash 再検証で冪等）。

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

### 最大呼び出し回数（model-aware スケーリング）

1メッセージあたりのデータ取得ツール呼び出し上限は **モデルのコンテキスト窓サイズに応じて 10〜25 に段階的にスケールする**（`getAgentToolCallBudget(model)`、`modelLimits.ts`）。上限の真のボトルネックは「回数」そのものではなく会話履歴の累積（毎ターン全 tool_result を再送するフラットループ）であり、窓が大きいモデルほど多段探索を許せるため:

| コンテキスト窓 | データツール上限 |
|----------------|-----------------|
| ≥ 400k | **25** |
| ≥ 200k | **16** |
| ≥ 64k | **12** |
| それ未満（小窓） | **10**（据え置き） |

`chatStore` が `getAgentToolCallBudget(currentModel)` を `runAgentLoop` の `maxToolCalls` に渡す（未指定時のフォールバックは `DEFAULT_MAX_TOOL_CALLS = 10`）。無限ループ防止。並列ツール呼び出し（LLMが1レスポンスで複数の `tool_use` を返すケース）では、**各ツール呼び出しを個別に1回としてカウント**する（例: 並列3呼び出し = 3回消費）。`ask_user` はこの予算を消費せず別枠（前述）。上限到達時はLLMに「ツール呼び出し上限に達しました。現在の情報で回答してください」とシステムメッセージを挿入し、UI には新しい予算でターンを再開できる **「続行」ボタン**（`agentContinuation`）を出す。さらに大規模タスクは `run_research` サブエージェント（独立予算）で実呼び出し回数を伸ばせる。

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
| Claude Sonnet 4.6 (1M) | 1,000,000 | **300,000** |
| Claude Opus 4.6+ (1M) | 1,000,000 | **300,000** |

> 注: 現行の `claude-sonnet-4-6` / `claude-opus-4-6` 以降は 1M context（`modelLimits.ts` の `MODEL_CAPABILITIES`）。200k 系は `claude-haiku-4-5` / `claude-sonnet-4-5` / `claude-opus-4-5` など。

- 予算超過時は以降のツール呼び出しを拒否し、LLMに「ツール結果のトークン予算に達しました。現在の情報で回答してください」とシステムメッセージを挿入
- 各ツールの返却データを適切にトリムする（content全文は `get_codex_entry` のみ、一覧系は summary + メタデータのみ）
- 予算残量はツール呼び出しの可視化ブロック内に表示（例: 「~18,200 / 60,000 tokens used」）

### 読み取りツールと書き込みツールの分離（2026-06-18 追記）

ツールは **読み取り専用ツール**（検索・一覧・取得系。`READ_ONLY_EXECUTORS`）と **書き込みツール**（`MUTATING_EXECUTORS`: `create_codex_entry` / `update_codex_entry` / `create_foreshadow` / `update_foreshadow` / `create_snippet` / `apply_ai_tree_plan` / `propose_scene_body`）に分かれる。当初の「全ツール read-only」設計から、AiPolicy ゲート付きの書き込みツールへ拡張された（前述「書き込み系」参照）。

- 書き込みツールは実行前に `blockIfPolicyOff(feature)` で対応 policy（`knowledgeWrite` / `structureWrite` / `bodyWrite`）を確認し、OFF なら何も変更せず例外を tool_result 化して返す（fail-closed）。
- 本文への書き込みは `propose_scene_body` のみで、**即時適用ではなくステージング**（ユーザーが accept するまで反映しない）。
- `run_research` サブエージェントには読み取りツールしか宣言せず、`executeReadOnlyTool` で dispatch するため、子は書き込み・質問・再帰を構造的に行えない。
- `agentLoop.ts` の `declaredToolNames` ゲートにより、そのターンで宣言されていないツールは（`EXECUTORS` に存在しても）実行されない（security review F-2）。

### 既注入エントリへの short-circuit

`get_codex_entry` が、システムプロンプトに既に full body + custom details + aliases ごと注入されているエントリ（= `fullyInjectedIds`、Spotlight された Codex などが対象）に対して呼ばれた場合、`toolExecutors` を経由せずに「既に注入済み」を示すスタブ結果を返す（`src/features/chat/chatStore.ts` の `guardedExecuteTool`）。LLM がプロンプト指示に従わず再 fetch しがちな挙動への保険であり、トークン浪費を防ぐ。

---

## UIの詳細

### エージェントモードトグル

ChatInput 下段ツール列に Agent mode / Thinking mode を**独立した chips として**並べる（共有ポップオーバーは使わない）。Agent mode は Bot/BotOff アイコン、Thinking mode は Lightbulb/LightbulbOff アイコンを使い、Model picker・Template picker などと同じツールバー行に直接並ぶ:

```
┌─ ChatInput card ─────────────────────────────────────────┐
│ [TipTap editor]                                          │
│ [Bot Agent mode][Lightbulb Thinking mode][model picker]  │
│                                             [Send ▶]     │
└──────────────────────────────────────────────────────────┘
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
| AI のべりすと | 条件付き | legacy モデル: 非対応 (`supportsTools: false`)。v1 モデル（`spiko_ultra` 等、`apiVariant === "v1"`）: 対応 (`supportsTools: true`)。`resolveModelCapabilities` が `apiVariant` で分岐 |
| CLI（Claude Code 等） | 非対応 | subprocess 経由のためツール呼び出し不可。`supportsTools: false` 固定で、Agent mode ON のままでも送信時は通常チャットパス（`sendCliChatStream`）にフォールバックする |

エージェントモードトグルは、現在のセッションモデルがTool Useに対応している場合のみ有効化する。対応状況は `getModelCapabilities` / `resolveModelCapabilities`（`src/features/chat/agent/modelLimits.ts`）の `supportsTools` で判定し、UI 側では ChatInput の `canUseTools` フラグで Agent mode chip を disabled（グレーアウト）にする。

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
