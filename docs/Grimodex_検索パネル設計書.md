# Grimodex 検索パネル設計書

## 概要

Grimodex の検索は **ヘッダー常駐バー + Dockview パネル + Provider レジストリ** を
組み合わせた **CommandCenter** に統合されている。1 つの入力で字句検索 (FTS5) と
セマンティック検索 (ruri-v3) を並行実行し、結果を 1 つの sections に束ねて
ポップオーバーと専用パネル両方に表示する。

検索結果ダイアログ（旧 `SearchDialog` / `GlobalSearchDialog` /
`SemanticSearchDialog`）は本機能の導入と同時に撤去された。Ctrl+Shift+F は
旧来のダイアログ起動ではなく、**ヘッダーバーへのフォーカス** に挙動を変更している。

### 設計の柱

1. **常駐 + 専用ビュー の二段構え**: ヘッダーバーはどの画面でも 1 クリックで
   到達できるサマリー (各セクション 10 件)。Dockview パネルは横断的な scan
   と hover プレビュー (semantic chunk は前後 ±100 文字) を提供する。
2. **Provider レジストリで複数検索源を 1 入力に集約**: lexical / semantic /
   将来の command を `CommandCenterProvider` インターフェイスで束ね、registry に
   登録するだけで `useCommandCenterSearch` の並行実行ループに乗る。
3. **バーが入力の単一所有 (single owner)**: 検索フックは `CommandCenterBar` の
   1 箇所のみで呼び、パネルは store を購読する。これにより同一クエリで
   provider が二重発火する race を構造的に排除する。
4. **クエリで「除外」も書ける**: `邂逅 -雨` のように `-word` で除外。Lexical /
   Semantic 両方に共通の post-filter を適用する。

### スコープ外（本機能では扱わない）

- **コマンド実行**: `>` プレフィックスで `mode: "command"` には切り替わるが、
  command provider は今は登録していない (placeholder)。将来の拡張点。
- **複数プロジェクト横断検索**: セマンティック検索設計書と同じく単一プロジェクト前提。
- **検索履歴**: 永続化しない (将来検討)。
- **保存済みフィルタ**: フィルタ状態はセッションのみ。

---

## CommandPalette との関係

`features/commandPalette/CommandPalette.tsx` (Ctrl+Shift+P) は別物として併存する。
- CommandPalette: シーンステータス変更などのアプリ内コマンド (現状ハードコード)。
- CommandCenter: 検索 + 将来のコマンド統合。

CommandCenter は `mode: "search" | "command"` を持ち、入力先頭 `>` で command
モードに切替えられる足場まで実装済み。将来的に CommandPalette を CommandCenter の
command provider として吸収できる。

---

## 全体アーキテクチャ

```
[ヘッダー (App.tsx)]                       [Dockview パネル]
CommandCenterBar (常駐 input)              CommandCenterResultsPanel
  │                                          ├─ 入力欄 (バーと同じ store を共有)
  │ useCommandCenterSearch  ⇐ 単一所有       ├─ CommandCenterFilterBar (kebab + responsive)
  │   ↓                                      ├─ Results list
  │   parseCommandInput (mode/text/excludes) │    └─ CommandCenterPreviewPopover (hover)
  │   ↓                                      └─ useResultsPanelStore (mounted, 除外フィルタ)
  │   getProviders(mode)
  │   ↓ (provider ごと debounce + 世代 ID + AbortController)
  │
  ▼
[providers/registry.ts]
  - lexicalSearchProvider (order=1)   → invoke "fts_search"
  - semanticSearchProvider (order=2) → invoke "semantic_search" (+ "semantic_chunk_context" for hover)

  ▼
[commandCenterStore]                       [resultsPanelStore]
  query / parsedQuery / mode / excludes      mounted / excludedSources / excludedTypes /
  descriptionMode                            selectedItemId / hoveredItemId
  sections / selectedIndex / focusRequest
```

入力 → `parseCommandInput` → `useCommandCenterSearch` → registry の provider
を並行実行 → 各 provider が `CommandCenterSection` を返す → store に upsert →
バー (popover) と パネル の両方が同じ sections を購読する。

---

## ファイル構成

```
src/features/commandCenter/
├── CommandCenterBar.tsx              # ヘッダー中央の input + container
├── CommandCenterPopover.tsx          # AnimatedPopover ラッパ (バー直下)
├── CommandCenterResultList.tsx       # sections → DOM (バー用、per-section slice あり)
├── CommandCenterResultItem.tsx       # 1 行 (kind ごと badge/subtitle 切替)
├── CommandCenterResultsPanel.tsx     # Dockview パネル本体 (検索パネル)
├── CommandCenterFilterBar.tsx        # パネル上部の除外フィルタ + kebab 折り畳み
├── CommandCenterPreviewPopover.tsx   # hover プレビュー (Radix Popover)
├── index.ts                          # 公開 API + provider 登録 (side-effect)
├── store/
│   ├── commandCenterStore.ts         # zustand: query/mode/sections/selectedIndex/excludes/descriptionMode
│   └── resultsPanelStore.ts          # zustand: panel 独自フィルタ + 選択/hover + mounted
├── providers/
│   ├── types.ts                      # CommandCenterItem / Section / Provider / ProviderSearchContext
│   ├── registry.ts                   # registerProvider / getProviders(mode)
│   ├── lexicalSearchProvider.ts      # fts_search ラッパ + onSelect
│   └── semanticSearchProvider.ts     # semanticSearch ラッパ + onSelect (descriptionMode 対応)
├── hooks/
│   ├── useCommandCenterSearch.ts     # 単一所有の検索フック (debounce + memo + race対策)
│   ├── useCommandCenterKeyboard.ts   # input の onKeyDown ハンドラ
│   └── useFilteredSections.ts        # パネル用: 除外フィルタを適用した sections
├── lib/
│   ├── constants.ts                  # BAR_VISIBLE_LIMIT_PER_SECTION / PANEL_FETCH_LIMIT
│   ├── parseCommandInput.ts          # `>` prefix / `-word` を分解
│   ├── flattenSections.ts            # sections → flat items (キーボード操作用)
│   ├── filterByExcludes.ts           # `-word` post-filter (case-insensitive substring)
│   └── previewCache.ts               # LRU キャッシュ (100 件, クエリ変更で全クリア)
└── preview/
    ├── lexicalPreview.ts             # SearchResult.excerpt を返す
    └── semanticPreview.ts            # semantic_chunk_context invoke (前後 ±100 文字)
```

Rust 側で新規追加された command:

```
src-tauri/src/commands/semantic.rs    # semantic_chunk_context Tauri command
src-tauri/src/semantic/preview.rs     # slice_context (char_indices 1 パスで切り出し)
```

---

## UI 構造

### ヘッダーバー (常駐)

`src/App.tsx:772` 付近のヘッダー中央に `<CommandCenterBar />` を配置。

```
┌─ ヘッダー全体 (data-tauri-drag-region) ────────────────────────────────┐
│ Logo  Menu  History  Export   ┌─ CommandCenterBar (drag-region=false) ─┐│
│                               │ 🔍 [ 検索… (> でコマンドモード) ]      ││
│                               └────────────────────────────────────────┘│
│                                     LayoutPreset  PanelToggle  Settings  │
└─────────────────────────────────────────────────────────────────────────┘
       ↓ 入力時、open=true && parsedQuery 非空のとき:
       ┌── AnimatedPopover (input 直下) ─────┐
       │ ━ 字句検索 (3) ━                       │
       │  [Scene]  第3章 邂逅                    │
       │  [Codex]  主人公の生い立ち              │
       │  [Snippet] 雨の描写                     │
       │ ━ 意味検索 (loading) ━                 │
       │  …                                       │
       └────────────────────────────────────────┘
```

- 中央スロット (旧 `<div className="flex-1" />`) を入れ替え、`max-w-2xl mx-auto`
  で中央寄せ。ヘッダー全体は `data-tauri-drag-region` だが、バー本体は
  `data-tauri-drag-region="false"` を明示してドラッグ干渉を切る。
- `Search` / `Terminal` アイコンを `mode` に応じて切替 (parseCommandInput が
  `>` を検出すると Terminal に)。
- 表示有無は `selectPopoverOpen(state) = open && parsedQuery.trim() !== ""`。
  Escape / 外側クリックで `open=false` (フォーカスは保持しない方向で簡素化)。
- Ctrl+Shift+F: バーをフォーカス + select。すでに open ならクローズトグル。
  TipTap の `Mod-Shift-f` (foreshadow picker) と衝突するため、グローバル
  ハンドラは `e.defaultPrevented` を尊重する (App.tsx:585-590)。

### 検索パネル (Dockview)

`PanelId = "command-center-results"`、`Ctrl+Alt+K` でトグル。i18n タイトルは
「検索」(en: "Search")。挿入位置は chat / chat-history と同じ right region。

```
┌─ 検索パネル ────────────────────────────────┐
│ 🔍 [ 検索…                            ]      │ ← バーと同じ store を共有
├──────────────────────────────────────────────┤
│ Source: [Scene][Codex][Snippet]    [⋯]      │ ← FilterBar (kebab 折り畳み)
│ Type:   [Lexical][Semantic]                  │
├──────────────────────────────────────────────┤
│ ━━ 字句検索 (12) ━━                            │
│  [Scene]  第3章 邂逅                          │ ← hover で →
│  [Codex]  主人公                              │   ┌─ Preview Popover ─────┐
│  …                                             │   │ Scene title           │
│ ━━ 意味検索 (8) ━━                             │   │ ……前 100 文字… 邂逅は │
│  [0.87]   会話シーンで、彼が…                 │   │ ……後 100 文字……      │
└──────────────────────────────────────────────┘   └────────────────────────┘
```

- 入力欄は `commandCenterStore.query` / `setQuery` を共有 (双方向同期)。
- パネル独自の選択は `resultsPanelStore.selectedItemId` (hover ベース、行に
  `bg-accent/30`)。バーの `selectedIndex` とは独立。
- 行 hover 400ms 後にプレビュー Popover が右に出る (画面右端で左反転)。
  プレビュー内容は `previewCache` に LRU 100 件。クエリ (parsedQuery) 変更で
  全クリア。
- パネルがマウント中 → `useResultsPanelStore.mounted = true` → バーが購読して
  `useCommandCenterSearch` の limit を 50 に上げる。

---

## バーとパネルの責務分担

| 観点 | バー (popover) | パネル |
|---|---|---|
| クエリ入力 | input (常駐) | input (パネル上部) — 同じ store を共有 |
| 表示件数 | 各 section 最大 10 件 (slice) | 全件 (最大 50) |
| 並行実行 | **単一所有** `useCommandCenterSearch` | フック呼び出さない (race 防止) |
| 取得件数決定 | `mounted ? 50 : 10` (バーが mounted を購読) | (バー経由で結果が更新される) |
| キーボード操作 | ↑↓ Enter Esc (selectedIndex) | hover/click 主体 |
| 除外フィルタ | (適用なし — クエリ `-word` のみ反映) | source/type 除外を追加適用 |
| プレビュー | なし | hover 400ms で前後 ±100 文字 |
| 開閉 | Ctrl+Shift+F | Ctrl+Alt+K (toggle) |

### 単一所有の不変条件

`useCommandCenterSearch` は **`CommandCenterBar` でのみ呼ぶ**。専用パネルから
呼ぶと 2 つの hook 実例がそれぞれ `runtimesRef` を持って互いを認識せず、同じ
クエリで provider を二重発火 → store への upsert が race する。

パネル展開時の limit 切替は次の連携で実現:
1. `CommandCenterResultsPanel` が mount 時に `useResultsPanelStore.setMounted(true)`。
2. `CommandCenterBar` は `useResultsPanelStore((s) => s.mounted)` を購読し、
   `useCommandCenterSearch({ limit: mounted ? 50 : 10 })` を渡す。
3. `useCommandCenterSearch` の effect deps に `limit` が含まれ、変更で再評価。
4. メモ化 (後述 superset memo) により無駄な再 fetch は抑制。

---

## データモデル

### `providers/types.ts`

```ts
type ItemKind =
  | "lexical-scene" | "lexical-codex" | "lexical-snippet"
  | "semantic-chunk"
  | "command";

interface CommandCenterItem {
  id: string;                       // `${kind}:${nativeId}` 一意化
  kind: ItemKind;
  title: string;
  subtitle?: string;
  badge?: { label: string; tone: BadgeTone };
  onSelect: () => void;             // 遷移ロジックを Provider が埋める
}

interface CommandCenterSection {
  id: string;                       // "lexical" | "semantic" | "commands"
  title: string;                    // i18n 解決済み
  order: number;                    // 表示順
  items: CommandCenterItem[];
  state?: { kind: "idle" | "loading" | "error"; message?: string };
}

interface ProviderSearchContext {
  query: string;                    // prefix と -word を剥がした positive
  signal: AbortSignal;              // 補助 (Tauri invoke は abort できない)
  limit: number;                    // バー=10 / パネル=50
  mode: "search" | "command";
  generation: number;               // race detection の世代カウンタ
}

interface CommandCenterProvider {
  id: string;
  order: number;
  title: string;
  hideWhenEmpty: boolean;           // 0 件 section を結果配列から除外するか
  supportsMode: (mode) => boolean;
  search: (ctx) => Promise<CommandCenterSection>;
  /** Provider 固有の memo bust factor (例: semantic は descriptionMode) */
  cacheKeyExtras?: () => string;
}
```

### `store/commandCenterStore.ts` (バー所有)

| フィールド | 役割 |
|---|---|
| `open: boolean` | input がアクティブ／popover を開きたい意思。空クエリでは落とさない |
| `mode: "search" \| "command"` | parseCommandInput が書く。命令モードの足場 |
| `query: string` | input の raw 値 (prefix と `-word` 含む) |
| `parsedQuery: string` | prefix と `-word` を剥がした positive。provider に渡す |
| `excludes: string[]` | `-word` で抽出された除外語 |
| `descriptionMode: boolean` | Semantic の dialogue ペナルティ。FilterBar の kebab から切替 |
| `sections: CommandCenterSection[]` | provider の結果。バー/パネル両方が購読 |
| `selectedIndex: number` | flat items index (**バー用** に bar-visible 範囲で clamp) |
| `focusRequest: number` | Ctrl+Shift+F で increment → バーが watch して focus |

派生: `selectPopoverOpen(state) = state.open && state.parsedQuery.trim() !== ""`。
helper: `barVisibleFlat(sections)` は `BAR_VISIBLE_LIMIT_PER_SECTION` で slice
してから `flattenSections` する。`moveSelection` / `executeSelected` / 各
upsert 時の clamp に使う (バーの可視範囲外に selectedIndex が飛ぶのを防ぐ)。

### `store/resultsPanelStore.ts` (パネル所有)

| フィールド | 役割 |
|---|---|
| `mounted: boolean` | バーが limit 切替に使う唯一の入口 |
| `excludedSources: SourceKind[]` | scene/codex/snippet のうち除外する集合 |
| `excludedTypes: SearchTypeKind[]` | lexical/semantic のうち除外する集合 |
| `selectedItemId: string \| null` | パネル独自の選択 (hover ベース) |
| `hoveredItemId: string \| null` | 400ms タイマーで preview popover を開く対象 |

`toggleSource(kind)` / `toggleType(kind)` で配列に有無を toggle。

---

## クエリ言語

### Mode prefix (`>`)

```
"邂逅"     → { mode: "search",  text: "邂逅",  excludes: [] }
">cmd foo" → { mode: "command", text: "cmd foo", excludes: [] }
">"        → { mode: "command", text: "",   excludes: [] }
```

- `>` で始まる入力は command モードに切替。直後の空白は trim される。
- command モードでは `supportsMode("command")` を返す provider のみが動く。
  今は登録 0 件のため UI 上「結果なし」になる。

### 除外 (`-word`)

```
"邂逅 -雨"           → text: "邂逅",   excludes: ["雨"]
"foo -a -b baz -c"   → text: "foo baz", excludes: ["a","b","c"]
"-only"              → text: "",       excludes: ["only"]
">cmd -foo bar"      → text: "cmd bar", mode: "command", excludes: ["foo"]
"foo - bar"          → text: "foo bar", excludes: []     // ハイフン単体は無視
```

- 各トークン (空白区切り) のうち `-` 始まりは除外語として消費される。
  残りが空文字なら静かに破棄。
- 除外は **post-filter** で実装される (`lib/filterByExcludes.ts`)。
  各 item の `title + subtitle` を `toLowerCase()` した文字列が、いずれかの
  除外語 (case-insensitive) を substring 含んでいたら drop。OR 結合。
- メモ化キーには sort 済み excludes を含めて、変更があれば確実に再 fetch する
  (`makeBaseKey` で `\x00` を区切りに連結)。

---

## 検索フック (`hooks/useCommandCenterSearch.ts`)

### 責務

1. `commandCenterStore.query` を購読
2. `parseCommandInput` で `mode` / `parsedQuery` / `excludes` を算出
3. store にそれぞれ書き戻す
4. `getProviders(mode)` から有効 provider を取得
5. provider ごとに **独立 debounce + 世代 ID + AbortController** で並行実行
6. 応答を post-filter (`filterByExcludes`) して `upsertSection`

### Race 対策

| 機構 | 役割 |
|---|---|
| 世代 ID (`generation`) | 応答受信時に最新世代と照合し、古い結果は捨てる (主) |
| AbortController | 補助 (Tauri invoke は abort できないため世代 ID が主) |

### Superset memoization

`runtime.lastBaseKey` + `runtime.lastMaxLimit` の二段で memo:

```
baseKey = `${mode}::${query}::ex=${sortedExcludes}::extras=${provider.cacheKeyExtras?.()}`
```

`runtime.lastBaseKey === baseKey && args.limit <= runtime.lastMaxLimit` なら
**skip**。これにより:

| 操作 | provider 呼出回数 |
|---|---|
| パネル開 (10→50)、type 同じ | 1 回 (50 > 10) |
| パネル閉 (50→10)、type 同じ | 0 回 (10 ≤ 50, skip) |
| パネル開 (50→50) | 0 回 (skip) |
| クエリ変更 | 1 回 (base key 違う) |
| descriptionMode toggle (semantic のみ) | 1 回 semantic のみ (lexical は extras 空で skip) |

`provider.cacheKeyExtras` は **provider 固有の bust factor**。semantic は
`desc=${descriptionMode ? 1 : 0}` を返し、descriptionMode 切替時に semantic
だけ memo が外れる (lexical は no-op で skip される)。

### Debounce

| Provider | debounce |
|---|---|
| lexical | 200ms (旧 GlobalSearchDialog 値を踏襲) |
| semantic | 300ms (embedding 計算が重いため遅らせる) |

---

## 検索パネルのフィルタ

`useFilteredSections` が `commandCenterStore.sections` を購読し、パネル独自の
`excludedSources` / `excludedTypes` を適用して新 sections を返す (`useMemo`)。

```
excludedTypes が "lexical" を含む   → lexical section を除外
excludedTypes が "semantic" を含む  → semantic section を除外

excludedSources が "scene" を含む   → lexical-scene 除外 + semantic section も巻き込み除外
                                       (semantic chunk は scene 由来のため)
excludedSources が "codex" を含む   → lexical-codex のみ除外
excludedSources が "snippet" を含む → lexical-snippet のみ除外

→ filter 後 0 件の lexical section は丸ごと隠す
```

### `descriptionMode`

Semantic の dialogue ペナルティ。kebab メニュー内の「地の文優先」トグル。
ON で `dialogue_ratio > 0.6` のチャンクのスコアが Rust 側で 0.85 倍に減点される。
状態は `commandCenterStore.descriptionMode` に格納し、semantic provider が
`useCommandCenterStore.getState().descriptionMode` を読んで invoke に渡す。
`cacheKeyExtras` 経由で **semantic だけ memo を bust する** (lexical 無影響)。

### FilterBar のレスポンシブ overflow

`features/editor/Toolbar.tsx` と同じ `ResizeObserver` パターン:

- Source / Type ユニットの幅を `useLayoutEffect` で計測
- 親 container 幅 / 右端 (kebab ボタン) 幅から「収まるユニット数」を再計算
- 収まらないユニットは kebab dropdown に同じ UI で展開
- `descriptionMode` トグルは **常時 kebab 内**

---

## プレビュー (`CommandCenterPreviewPopover`)

- 行 `onMouseEnter` で 400ms タイマー、`onMouseLeave` でキャンセル。
- 400ms 経過で `previewCache.get(itemId)` を見る。Hit なら即時表示。
  Miss なら `resolvePreview(item)` で取得 → cache に格納 → 表示。
- Radix Popover (`@/components/ui/popover`) ベース。`side="left"` を first
  choice (パネルが右 region に配置されることが多いため、内側に展開)。
  `avoidCollisions` + `collisionPadding={16}` で衝突時の反転を委ねる。

### Lexical のプレビュー

`SearchResult.excerpt` をそのまま表示。Rust 側の追加 invoke 不要。

### Semantic のプレビュー

`semantic_chunk_context` invoke で前後 ±100 文字を取得し、チャンク本体を
`bg-accent/40` で強調。Rust 側の純ロジックは `src-tauri/src/semantic/preview.rs`
に分離 (`semantic-embedding` feature off でもテスト可能、`char_indices()` を
1 パスで境界バイト取得)。

```rust
fn slice_context(plain_text, char_start, char_end, padding, scene_title)
    -> PreviewContext { before, chunk, after, scene_title }
```

multi-byte (日本語等) 安全。`chars().nth()` を複数回呼ぶより O(n) 1 回で済む。

---

## キーボード / ショートカット

| キー | 場所 | 動作 |
|---|---|---|
| Ctrl+Shift+F | グローバル | バーをフォーカス + select。open ならクローズトグル。`defaultPrevented` を尊重 |
| Ctrl+Alt+K | グローバル | 検索パネル toggle |
| ↑ ↓ | バー input (popover open 中) | selectedIndex を移動 (bar-visible 範囲で clamp)。popover 閉じ中はキャレット移動 |
| Enter | バー input (popover open + 結果あり) | `executeSelected()` |
| Escape | バー input (open 中のみ) | `setOpen(false)` |
| Tab | パネル内 | フィルタバー ↔ リストの移動 (デフォルト) |

### 既存ショートカットとの衝突回避

- TipTap が `Mod-Shift-f` を **foreshadow picker** (選択あり時のみ) に使う
  (`src/features/editor/extensions.ts:135`)。エディタフォーカス + 選択ありの
  ときは TipTap 側が `return true` で preventDefault する。グローバル
  ハンドラ (`App.tsx:585`) は `if (e.defaultPrevented) return;` で二重発火を回避。

---

## i18n キー

`src/locales/{ja,en}.json` の `commandCenter.*`:

| キー | 用途 |
|---|---|
| `placeholderSearch` / `placeholderCommand` | input の placeholder |
| `sectionLexical` / `sectionSemantic` / `sectionCommand` | section header |
| `loading` / `noResults` / `emptyHint` / `untitled` | プレースホルダ |
| `filter.sourceLabel` / `filter.typeLabel` | FilterBar の見出し |
| `filter.scene/codex/snippet/lexical/semantic` | フィルタトグルのラベル |
| `filter.includedHint` / `filter.excludedHint` | トグル title 属性 |
| `filter.descriptionMode` / `filter.descriptionModeHint` | kebab 内トグル |
| `filter.moreOptions` / `filter.on` / `filter.off` | kebab ボタンと ON/OFF |
| `panel.emptyHint` | クエリ空時のメッセージ |

パネルタイトル: `layout.panel.command-center-results` (`"検索"` / `"Search"`)。

---

## 既存資産との関係 (再利用 / 不変条件)

| 既存資産 | 場所 | 再利用ポイント |
|---|---|---|
| `fts_search` invoke | `src-tauri/src/commands/integrity.rs` | lexical provider が呼ぶ |
| `semanticSearch()` | `src/features/semantic-search/api.ts` | semantic provider が呼ぶ |
| `nextSearchResultIndex` | `src/features/semantic-search/searchResultSelection.ts` | キーボード ↑↓ で再利用 |
| `useSemanticNavStore.requestJump` | `src/features/semantic-search/semanticNavStore.ts` | **不変条件**: `setActiveScene` の前に呼ぶ |
| `EditorPane` の `consumeJump` | `src/features/editor/EditorPane.tsx:929-959` | 同一 microtask で読むため上記順序を保つ |
| `AnimatedPopover` | `src/components/ui/animated-popover.tsx` | バー popover の click-outside / Escape を委譲 |

### Semantic ヒット選択時の順序不変条件

```
useSemanticNavStore.getState().requestJump({ sceneId, chunkText });
useTreeStore.getState().setActiveScene(sceneId);     // ← この順序を逆にしない
useLayoutStore.getState().showPanel("editor");
```

`EditorPane` の `switchScene` 経路が同一 microtask で `consumeJump` するため、
`setActiveScene` 前に jump を登録しておく必要がある。順序は `semanticSearchProvider.test.ts`
で実装の不変条件として検証している。

---

## 拡張ポイント

### 1. 新しい検索源を追加する

1. `providers/myProvider.ts` を作成、`CommandCenterProvider` を満たす。
2. `index.ts` で `registerProvider(myProvider)`。
3. 必要なら `cacheKeyExtras` で provider 固有の memo bust factor を返す。

それだけで `useCommandCenterSearch` の並行ループに乗る。UI 変更不要。

### 2. Command Palette を取り込む

`mode === "command"` で `supportsMode("command")` を返す provider を追加し、
既存 `CommandPalette.tsx` の `Command` 定義 (id/label/run) を `CommandCenterItem`
に変換すれば、`>` で同じバー / パネルから実行できる。CommandCenter 側は parser /
icon 切替 / mode フィルタまで実装済み。

### 3. 取得件数の上限を増やす

`lib/constants.ts` の `PANEL_FETCH_LIMIT` を上げるだけ。superset memo が
バーから 10 → 50 への上昇を 1 回だけ fetch して残りはキャッシュする。

### 4. プレビューの padding を変える

`src/features/commandCenter/preview/semanticPreview.ts` の `DEFAULT_PADDING`
(現在 100) を変更。Rust 側の `slice_context` は引数として受け取るため変更不要。

---

## テスト

- ユニット: `lib/`, `providers/`, `store/`, `hooks/` 各 `.test.{ts,tsx}` で
  parser / 除外 / 世代 ID / memo / source-type フィルタ / バー-visible clamp /
  順序不変条件などをカバー。
- Rust: `src-tauri/src/semantic/preview.rs` の `slice_context` を
  multi-byte / clamp / 入れ替わり境界で `#[cfg(test)]` 検証。
- 全体: `pnpm test --run` で 3000+ 件パス。

---

## 撤去・移行済み

- `src/features/search/SearchDialog.tsx` / `GlobalSearchDialog.tsx` /
  `searchModeStore.ts` (本機能で完全置換)。
- `src/features/semantic-search/SemanticSearchDialog.tsx` / `.test.ts`
  (chunk ジャンプ周りの core ロジック (`api.ts` / `semanticNavStore.ts` /
   `findChunkInDoc.ts` / `searchResultSelection.ts`) は残し、本機能から再利用)。
- Ctrl+Shift+F の挙動: ダイアログ起動 → バーフォーカス。
- i18n `layout.panel.command-center-results`: 「検索結果」→「検索」。
