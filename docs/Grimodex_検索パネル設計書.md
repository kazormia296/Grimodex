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
   到達できるサマリー (各セクション最大 `BAR_VISIBLE_LIMIT_PER_SECTION`=10 件)。
   Dockview パネルは横断的な scan と hover プレビュー (semantic chunk は前後
   ±100 文字) を提供する。
2. **Provider レジストリで複数検索源を 1 入力に集約**: quickOpen / command /
   lexical / semantic を `CommandCenterProvider` インターフェイスで束ね、registry に
   登録するだけで `useCommandCenterSearch` の並行実行ループに乗る。各 provider は
   `surfaces: ("bar" | "panel")[]` で **どの surface に出すか** を宣言する。
3. **バーとパネルは独立した store / runtime** (Phase A2 で分離): 検索フックは
   `CommandCenterBar` と `CommandCenterResultsPanel` が **各々独立に** 呼ぶ。
   両者は別 store (`useBarStore` / `usePanelStore`) を購読するため、同一文字を
   打っても store が分かれており upsert が衝突しない。バーは surface=`"bar"`、
   パネルは surface=`"panel"` で `getProviders` を絞り込む。
4. **クエリで「除外」も書ける**: `邂逅 -雨` のように `-word` で除外。Lexical /
   Semantic 両方に共通の post-filter を適用する。

### スコープ外（本機能では扱わない）

- **複数プロジェクト横断検索**: セマンティック検索設計書と同じく単一プロジェクト前提。
- **検索履歴**: 永続化しない (将来検討)。
- **保存済みフィルタ**: フィルタ状態はセッションのみ。

> DB スキーマ (FTS5 仮想テーブル・semantic chunk テーブル等) の詳細は
> [`docs/Grimodex_統合DBスキーマ.md`](./Grimodex_統合DBスキーマ.md) を参照。

---

## コマンドパレット (Command Palette) 統合

旧 `features/commandPalette/CommandPalette.tsx` は撤去され、コマンドパレット相当の
機能は CommandCenter の `commandProvider` (バー surface 専用) に統合された。

- **Ctrl+Shift+P**: バーに focus を渡し、入力を `"> "` にセットして command
  モードで起動する (`App.tsx:418-427`)。`commandProvider` が設定起動・エクスポート・
  ツアー再開・各パネル開閉などのアクションを一覧化する (後述「バー専用 Provider」)。
- `mode: "search" | "command"` は `parseCommandInput` が入力先頭 `>` を検出して切替える。
- 名前が似た `features/codex/components/CodexCommandPalette.tsx` は Codex エントリの
  ピッカーで本機能とは無関係。

---

## 全体アーキテクチャ

Phase A2 (`c2652383`) でバーとパネルは **完全に独立** している。両者は同じ
`createSearchStore()` factory から作った別 instance (`useBarStore` /
`usePanelStore`) を持ち、各々が自前で `useCommandCenterSearch` を起動する。

```
[ヘッダー (App.tsx)]                          [Dockview パネル]
CommandCenterBar                              CommandCenterResultsPanel
  │                                             │
  │ useCommandCenterSearch(                      │ useCommandCenterSearch(
  │   useBarStore,                               │   usePanelStore,
  │   { limit: BAR_FETCH_LIMIT=10,               │   { limit: PANEL_FETCH_LIMIT=50,
  │     surface: "bar" })                        │     surface: "panel" })
  │   ↓ parseCommandInput (mode/text/excludes)   │   ↓ (同左)
  │   ↓ getProviders(mode, "bar")                │   ↓ getProviders(mode, "panel")
  │   ↓ (provider ごと debounce + 世代 ID         │   ↓
  │      + AbortController, runtime は store 別)  │
  ▼                                             ▼
[providers/registry.ts]  getProviders(mode, surface) で surfaces により絞り込み
  - quickOpenProvider  (order=1, surfaces=["bar"],          mode=search)
  - lexicalSearchProvider  (order=1, surfaces=["bar","panel"], mode=search)
  - semanticSearchProvider (order=2, surfaces=["bar","panel"], mode=search)
  - commandProvider    (order=3, surfaces=["bar"],          mode=command)

  ▼                                             ▼
[useBarStore]                                 [usePanelStore]
  query/parsedQuery/mode/excludes/             (同じ形。bar とは独立した sections)
  descriptionMode/sections/selectedIndex
[useResultsPanelStore (パネル専用 UI 状態)]
  excludedSources/excludedTypes/selectedItemId/hoveredItemId/focusRequest
```

各 surface の hook が独立に `parseCommandInput` → registry の provider を並行実行
→ 各 provider が `CommandCenterSection` を返す → **自分の store** に upsert する。
バーは search モードで quickOpen+lexical+semantic、command モードで command を、
パネルは lexical+semantic を回す (b4d829ce で lexical/semantic がバーにも追加された)。

`limit` は surface ごとに固定 (`BAR_FETCH_LIMIT`=10 / `PANEL_FETCH_LIMIT`=50)。
パネルの開閉に応じてバーの limit を切替える旧来の `mounted` 連携は撤去済み。

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
├── index.ts                          # 公開 API + 4 provider 登録 (side-effect)
├── store/
│   ├── commandCenterStore.ts         # createSearchStore() factory + useBarStore / usePanelStore / useCommandCenterStore(@deprecated=useBarStore)
│   └── resultsPanelStore.ts          # zustand: panel 独自フィルタ + 選択/hover + focusRequest
├── providers/
│   ├── types.ts                      # CommandCenterItem / Section / Provider(surfaces) / ProviderExtras / ProviderSearchContext / Surface
│   ├── registry.ts                   # registerProvider / getProviders(mode, surface?)
│   ├── lexicalSearchProvider.ts      # fts_search ラッパ + onSelect (surfaces=["bar","panel"])
│   ├── semanticSearchProvider.ts     # semanticSearch ラッパ + onSelect (descriptionMode 対応, surfaces=["bar","panel"])
│   ├── quickOpenProvider.ts          # バー用 Quick Open: Scene/Codex/Snippet 名の in-memory 部分一致 (surfaces=["bar"])
│   └── commandProvider.ts            # バー用 Command: 設定/エクスポート/パネル開閉等のアクション一覧 (surfaces=["bar"], command mode)
├── hooks/
│   ├── useCommandCenterSearch.ts     # 検索フック (store 引数 + debounce + memo + race対策)。bar/panel が各々呼ぶ
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

`src/App.tsx:624` のヘッダー `center` スロットに `<CommandCenterBar />` を配置。

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
- 表示有無は `selectPopoverOpen(state)`: `open && (mode === "command" ||
  parsedQuery.trim() !== "")`。command モード (`> ` 起動) では空クエリでも
  コマンド一覧を出すため parsedQuery を問わない。Escape / 外側クリックで
  `open=false`。
- Ctrl+Shift+P: バーへ focus し `"> "` をセットして command モードで起動
  (`App.tsx:418-427`)。
- Ctrl+Shift+F は **バーではなく検索パネル** を開いてパネル内 input へ focus する
  (後述 [キーボード / ショートカット](#キーボード--ショートカット))。TipTap の
  `Mod-Shift-f` (foreshadow picker) と衝突するため、グローバルハンドラは
  `e.defaultPrevented` を尊重する (`App.tsx:410-416`)。

### 検索パネル (Dockview)

`PanelId = "command-center-results"`、`Ctrl+Shift+F` で開いてパネル内 input に
focus する。i18n タイトルは「検索」(en: "Search")。挿入位置は chat / chat-history
と同じ right region。

> **（2026-06-20 追記 / drift 訂正）** 旧記述「`Ctrl+Alt+K` でトグル」は
> コード上に存在しない。`keybindings.ts` の `getCommands()` には検索パネル用の
> focus/toggle コマンド (`focusSearch` 相当) が登録されておらず、`PANEL_COMMANDS`
> にも乗らないため、他パネルのような `Mod+Alt+*` 系トグルは効かない。検索パネルへの
> 到達は **`Ctrl+Shift+F` のハードコードハンドラ** (`App.tsx:407-416`、`showPanel` で
> 開いて `requestFocus()`) のみ。パネルの shortcut hint も `KEYBOARD_SHORTCUT_MAP`
> (`panelRegions.ts:47`) で `Ctrl+Shift+F` を表示する。`Ctrl+Alt+K` トグルが必要なら
> `getCommands()` に `{ id: "focusSearch", defaultBinding: "Mod+Alt+K",
> panel: "command-center-results" }` を追加 (+ `keys.focusSearch` の ja/en キー) して
> `PANEL_COMMANDS` 経由の汎用 togglePanel ループ (`App.tsx:432-447`) に乗せる必要がある
> (未実装 / known gap)。

```
┌─ 検索パネル ────────────────────────────────┐
│ 🔍 [ 検索…                            ]      │ ← 独立 store (usePanelStore)
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

- 入力欄は `usePanelStore.query` / `setQuery`。バーの `useBarStore` とは
  **別 store** で、クエリ・結果が完全に分離される (バーに打った文字はパネルへ
  伝播しない)。
- パネル独自の選択は `resultsPanelStore.selectedItemId` (hover ベース、行に
  `bg-accent/30`)。バーの `selectedIndex` とは独立。
- 行 hover 400ms 後にプレビュー Popover が右に出る (画面右端で左反転)。
  プレビュー内容は `previewCache` に LRU 100 件。クエリ (parsedQuery) 変更で
  全クリア。
- パネルは自前で `useCommandCenterSearch(usePanelStore, { limit:
  PANEL_FETCH_LIMIT=50, surface: "panel" })` を起動する。バーとは store が別なので
  並行に同じ provider を駆動しても upsert が衝突しない。

---

## バーとパネルの責務分担

| 観点 | バー (popover) | パネル |
|---|---|---|
| store | `useBarStore` | `usePanelStore` (別 instance) |
| クエリ入力 | input (常駐) | input (パネル上部) — 別 store・伝播しない |
| 表示 provider | quickOpen+lexical+semantic (search) / command (command) | lexical+semantic |
| 表示件数 | 各 section 最大 10 件 (`BAR_VISIBLE_LIMIT_PER_SECTION` で slice) | 全件 (最大 `PANEL_FETCH_LIMIT`=50) |
| 並行実行 | 自前で `useCommandCenterSearch(useBarStore, { surface: "bar" })` | 自前で `useCommandCenterSearch(usePanelStore, { surface: "panel" })` |
| 取得件数 | `BAR_FETCH_LIMIT`=10 固定 | `PANEL_FETCH_LIMIT`=50 固定 |
| キーボード操作 | ↑↓ Enter Esc (selectedIndex) | hover/click 主体 |
| 除外フィルタ | (適用なし — クエリ `-word` のみ反映) | source/type 除外を追加適用 |
| プレビュー | なし | hover 400ms で前後 ±100 文字 |
| 開閉 | フォーカス (Ctrl+Shift+P=command モード起動) | Ctrl+Shift+F (開いて focus)。`Ctrl+Alt+K` トグルは未実装 (上記 drift 訂正参照) |

### store / runtime の分離 (Phase A2)

`useCommandCenterSearch` は **store を引数で受け取り**、バーとパネルが各々
独立に呼ぶ。`useBarStore` と `usePanelStore` は同じ `createSearchStore()`
factory から作った別 instance なので、両者が同じ provider を並行に駆動しても
それぞれ自分の store にだけ upsert する → 同一クエリでの race は store 分離で
構造的に防がれる。

各 hook 内の `runtimesRef` (debounce タイマー・世代 ID・superset memo) も
hook 実例ごとに独立しており、surface による provider 絞り込み
(`getProviders(mode, surface)`) と組み合わさって干渉しない。limit は surface
ごとに固定 (`BAR_FETCH_LIMIT` / `PANEL_FETCH_LIMIT`) で、パネル開閉に応じて
バーの limit を切替えていた旧来の `mounted` 連携は撤去された。

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

type Surface = "bar" | "panel";

/** cacheKeyExtras / search に渡す provider extras (store を直接読まずに DI) */
interface ProviderExtras {
  descriptionMode: boolean;         // semantic の dialogue penalty (search モード)
}

interface ProviderSearchContext extends ProviderExtras {
  query: string;                    // prefix と -word を剥がした positive
  signal: AbortSignal;              // 補助 (Tauri invoke は abort できない)
  limit: number;                    // バー=10 / パネル=50
  mode: "search" | "command";
  generation: number;               // race detection の世代カウンタ
}

interface CommandCenterProvider {
  id: string;
  order: number;                    // Lexical=1 / quickOpen=1 / Semantic=2 / Commands=3
  title: string;
  hideWhenEmpty: boolean;           // 0 件 section を結果配列から除外するか
  surfaces: readonly Surface[];     // 出力対象 surface。getProviders(mode, surface) で絞り込む
  supportsMode: (mode) => boolean;
  search: (ctx: ProviderSearchContext) => Promise<CommandCenterSection>;
  /** Provider 固有の memo bust factor (例: semantic は descriptionMode)。extras を DI で受ける */
  cacheKeyExtras?: (extras: ProviderExtras) => string;
}
```

### `store/commandCenterStore.ts` (`createSearchStore()` factory)

検索状態の store は factory で作り、`useBarStore` (バー用) と `usePanelStore`
(パネル用) の 2 つの独立 instance を export する。`useCommandCenterStore` は
`useBarStore` の `@deprecated` エイリアス (旧名互換)。両 instance は同じ形の
state を持つ:

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
| `focusRequest: number` | `requestFocus()` で increment → バーが watch して focus (Ctrl+Shift+P 経由) |

派生: `selectPopoverOpen(state) = state.open && (state.mode === "command" || state.parsedQuery.trim() !== "")`。
helper: `barVisibleFlat(sections)` は `BAR_VISIBLE_LIMIT_PER_SECTION` で slice
してから `flattenSections` する。`moveSelection` / `executeSelected` / 各
upsert 時の clamp に使う (バーの可視範囲外に selectedIndex が飛ぶのを防ぐ)。

### `store/resultsPanelStore.ts` (パネル所有)

| フィールド | 役割 |
|---|---|
| `excludedSources: SourceKind[]` | scene/codex/snippet のうち除外する集合 |
| `excludedTypes: SearchTypeKind[]` | lexical/semantic のうち除外する集合 |
| `selectedItemId: string \| null` | パネル独自の選択 (hover ベース) |
| `hoveredItemId: string \| null` | 400ms タイマーで preview popover を開く対象 |
| `focusRequest: number` | Ctrl+Shift+F で increment → パネル内 input が watch して focus |

`toggleSource(kind)` / `toggleType(kind)` で配列に有無を toggle。検索クエリ・
結果は `usePanelStore` が SSoT で、この store は **panel 専用 UI 状態** のみを持つ
(`mounted` 連携は撤去済み)。

---

## バー専用 Provider (Phase B)

Phase B (`81199c67`) でバー surface 専用の 2 provider を新設した。両者とも
`surfaces: ["bar"]` で、パネル surface には出ない。

### Quick Open (`providers/quickOpenProvider.ts`)

VSCode の Ctrl+P 相当。`id="quickOpen"` / `order=1` / search モード。Scene /
Codex / Snippet の **名前** を **in-memory で部分一致** 検索してジャンプする
(全文検索ではない。全文は panel 側の lexical/semantic が担う)。

- `useTreeStore` (scene) / `useCodexStore` / `useSnippetStore` の現在の
  エントリ名を `toLowerCase()` 部分一致で走査。
- スコア `0=完全一致 / 1=前方一致 / 2=部分一致` でソートし `ctx.limit` で打ち切り。
- badge は `Scene` / `Codex` / `Snippet`。`onSelect` は各 store の選択 API +
  対応パネルを `showPanel` で開く。
- `hideWhenEmpty: true` (ヒット 0 件で section を隠す)。

### Command Provider (`providers/commandProvider.ts`)

VSCode の Ctrl+Shift+P 相当。`id="commands"` / `order=3` / **command モード専用**
(`supportsMode(mode) => mode === "command"`)。Grimodex 内のアクションを一覧化する。

- 固定アクション: 設定起動 (`open-settings` CustomEvent) / エクスポート
  (`open-export-dialog`) / ツアー再開 (`restart-sample-tour`)。
- パネル開閉: `PANEL_COMMANDS` の各 `panelId` を `useLayoutStore.togglePanel`
  で toggle。label は `layout.panel.<panelId>` から i18next で都度解決 (言語切替追従)。
- 空クエリ時は全コマンドを宣言順に、クエリ入力時は label / `keywords` の部分一致を
  スコア (`0=完全 / 1=前方 / 2=部分 / 3=keywords ヒット`) 順で `ctx.limit` まで表示。
- badge は `Cmd` (tone=`command`)。

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
  現在は `commandProvider` (バー surface) が登録済みで、空クエリ時は全コマンドを
  宣言順に、クエリ入力時は label/keywords の部分一致でスコア順に表示する。

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

```ts
useCommandCenterSearch(
  store: SearchStore,                 // useBarStore か usePanelStore
  options?: { limit?: number; surface?: Surface },
): void
```

バーとパネルが **各々この hook を呼ぶ** (`store` 引数で対象を切替える)。
`limit` は surface ごとに固定値を渡す (`BAR_FETCH_LIMIT` / `PANEL_FETCH_LIMIT`)。
`surface` は `getProviders` の絞り込みに使う。

### 責務

1. `store.query` を購読 (引数の store instance)
2. `parseCommandInput` で `mode` / `parsedQuery` / `excludes` を算出
3. 同じ store にそれぞれ書き戻す
4. `getProviders(mode, surface)` から有効 provider を取得
5. provider ごとに **独立 debounce + 世代 ID + AbortController** で並行実行
6. 応答を post-filter (`filterByExcludes`) して **その store** に `upsertSection`

### Race 対策

| 機構 | 役割 |
|---|---|
| 世代 ID (`generation`) | 応答受信時に最新世代と照合し、古い結果は捨てる (主) |
| AbortController | 補助 (Tauri invoke は abort できないため世代 ID が主) |

### Superset memoization

`runtime.lastBaseKey` + `runtime.lastMaxLimit` の二段で memo (runtime は
hook 実例ごと=surface ごとに独立):

```
baseKey = `${mode}::${query}::ex=${sortedExcludes}::extras=${provider.cacheKeyExtras?.(extras)}`
```

`runtime.lastBaseKey === baseKey && args.limit <= runtime.lastMaxLimit` なら
**skip**。limit は今や surface ごとに固定 (バー=10 / パネル=50) なので、同一
surface 内では `lastMaxLimit` は基本一定。`lastMaxLimit` の比較は再レンダ等で
同条件の effect が再走しても無駄な再 fetch を抑える役割に収斂している:

| 操作 (同一 surface 内) | provider 呼出回数 |
|---|---|
| 同じクエリで effect 再走 (limit 同値) | 0 回 (skip) |
| クエリ変更 | 1 回 (base key 違う) |
| descriptionMode toggle (semantic のみ) | 1 回 semantic のみ (lexical は extras 空で skip) |

`provider.cacheKeyExtras` は **provider 固有の bust factor**。`extras`
(`ProviderExtras`) を DI で受け取り、semantic は `desc=${descriptionMode ? 1 : 0}`
を返して descriptionMode 切替時に semantic だけ memo を外す (lexical は no-op で
skip される)。

### Debounce

| Provider | debounce |
|---|---|
| lexical | 200ms (旧 GlobalSearchDialog 値を踏襲) |
| semantic | 300ms (embedding 計算が重いため遅らせる) |

---

## 検索パネルのフィルタ

`useFilteredSections` が `usePanelStore.sections` を購読し、パネル独自の
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
状態は store の `descriptionMode` に格納し、hook が `ProviderExtras` として
DI する (`ctx.descriptionMode` で受け取り invoke に渡す。provider が store を
直接 import しない)。`cacheKeyExtras(extras)` が
`desc=${extras.descriptionMode ? "1" : "0"}` を返すことで **semantic だけ
memo を bust する** (lexical 無影響)。

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
| Ctrl+Shift+F | グローバル | 検索パネルを `showPanel` で開き、`useResultsPanelStore.requestFocus()` でパネル内 input に focus + select。`defaultPrevented` を尊重 (`App.tsx:410-416`) |
| Ctrl+Shift+P | グローバル | バーに focus し、`"> "` をセットして command モードで起動 (`App.tsx:418-427`) |
| ~~Ctrl+Alt+K~~ | — | **未実装 (drift)**: 検索パネル用の focus/toggle コマンドは `keybindings.ts` に登録されていない。検索パネルへの到達は上記 `Ctrl+Shift+F` のみ（2026-06-20 訂正、[検索パネル (Dockview)](#検索パネル-dockview) の追記参照） |
| ↑ ↓ | バー input (popover open 中) | selectedIndex を移動 (bar-visible 範囲で clamp)。popover 閉じ中はキャレット移動 |
| Enter | バー input (popover open + 結果あり) | `executeSelected()` |
| Escape | バー input (open 中のみ) | `setOpen(false)` |
| Tab | パネル内 | フィルタバー ↔ リストの移動 (デフォルト) |

### 既存ショートカットとの衝突回避

- TipTap が `Mod-Shift-f` を **foreshadow picker** (選択あり時のみ) に使う
  (`src/features/editor/extensions.ts:140`)。エディタフォーカス + 選択ありの
  ときは TipTap 側が `return true` で preventDefault する。グローバル
  ハンドラ (`App.tsx:410`) は `if (e.defaultPrevented) return;` で二重発火を回避。

---

## i18n キー

`src/locales/{ja,en}.json` の `commandCenter.*`:

| キー | 用途 |
|---|---|
| `placeholderSearch` / `placeholderCommand` | input の placeholder |
| `sectionLexical` / `sectionSemantic` | lexical/semantic section header |
| `sectionQuickOpen` / `sectionCommands` | quickOpen/command section header |
| `command.openSettings` / `command.export` / `command.restartTour` / `command.togglePanel` | commandProvider のアクション label (`togglePanel` は `{{panel}}` 補間) |
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
2. `surfaces` でバー / パネルどちらに出すか宣言する (`["bar"]` / `["panel"]` /
   両方)。
3. `index.ts` で `registerProvider(myProvider)`。
4. 必要なら `cacheKeyExtras(extras)` で provider 固有の memo bust factor を返す。

それだけで対象 surface の `useCommandCenterSearch` の並行ループに乗る。UI 変更不要。

### 2. コマンドを追加する

`commandProvider.ts` の `buildCommands()` に `CommandDef` (id/label/keywords/run)
を足すか、`PANEL_COMMANDS` にパネルを追加すれば `> ` 起動の command モードに
即座に並ぶ (旧 `CommandPalette.tsx` を取り込む案は実装済み)。

### 3. 取得件数の上限を増やす

`lib/constants.ts` の `PANEL_FETCH_LIMIT` (パネル) / `BAR_FETCH_LIMIT` (バー) を
上げるだけ。limit は surface ごとに固定なので、変更後の値で各 surface が一度
fetch して superset memo がそれ以降の再走を抑える。

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
- `src/features/commandPalette/CommandPalette.tsx` (アプリ内コマンドパレット)。
  コマンドは `commandProvider` に移管し、Ctrl+Shift+P で CommandCenter の
  command モードとして起動する。
- Ctrl+Shift+F の挙動: ダイアログ起動 → **検索パネルを開いてパネル内 input に
  focus** (旧記述「バーフォーカス」は Phase B 以降の挙動に合わせ更新)。
- i18n `layout.panel.command-center-results`: 「検索結果」→「検索」。
