# Grimodex 検索パネル設計書

## 概要

Grimodex の横断検索は Dockview の `command-center-results` パネルに集約する。
ヘッダー常駐の検索バー、Quick Open、コマンドモード、`Ctrl+Shift+P` の
コマンドパレットは 2026-07-24 に撤去した。

検索パネルでは 1 つの入力から次の検索を並行実行する。

- Lexical: SQLite FTS5 による Scene / Codex / Snippet の全文検索
- Semantic: embedding による Scene chunk の意味検索

検索結果ダイアログ（旧 `SearchDialog` / `GlobalSearchDialog` /
`SemanticSearchDialog`）は使用しない。

## UX

- `Ctrl+Shift+F` で検索パネルを開き、入力欄へフォーカスする。
- `>` に特別な意味はない。通常の検索文字として扱う。
- `-word` は除外語として扱う。例: `邂逅 -雨`
- Source（Scene / Codex / Snippet）と検索種別（Lexical / Semantic）を
  パネル内フィルタで除外できる。
- 結果のホバーでプレビューを表示する。
- Semantic の「地の文優先」は会話文比率の高い chunk を減点する。

検索履歴と保存済みフィルタはスコープ外。検索対象は現在のプロジェクトだけとする。

## 画面構成

```
App.tsx
  Ctrl+Shift+F
    ├─ layoutStore.showPanel("command-center-results")
    └─ resultsPanelStore.requestFocus()

CommandCenterResultsPanel
  ├─ Search input
  ├─ CommandCenterFilterBar
  └─ sections
       ├─ lexicalSearchProvider results
       └─ semanticSearchProvider results
```

ヘッダー中央は検索 UI を持たない。`HeaderBarLayout` の空の center レールは
フレームレスウィンドウのドラッグ領域として使う。

## ファイル構成

```
src/features/commandCenter/
├── CommandCenterResultsPanel.tsx
├── CommandCenterFilterBar.tsx
├── CommandCenterPreviewPopover.tsx
├── CommandCenterResultItem.tsx
├── hooks/
│   ├── useCommandCenterSearch.ts
│   └── useFilteredSections.ts
├── lib/
│   ├── constants.ts
│   ├── filterByExcludes.ts
│   ├── parseCommandInput.ts
│   └── previewCache.ts
├── preview/
│   ├── lexicalPreview.ts
│   └── semanticPreview.ts
├── providers/
│   ├── lexicalSearchProvider.ts
│   ├── semanticSearchProvider.ts
│   ├── registry.ts
│   └── types.ts
└── store/
    ├── commandCenterStore.ts
    └── resultsPanelStore.ts
```

`parseCommandInput` は歴史的なファイル名だが、現在は command mode を扱わず、
検索本文と除外語だけを返す。

## 状態管理

### `usePanelStore`

検索データを所有する。

| 状態 | 用途 |
|---|---|
| `query` | 入力欄の raw 値 |
| `parsedQuery` | `-word` を除いた検索本文 |
| `excludes` | 入力から抽出した除外語 |
| `descriptionMode` | Semantic の地の文優先 |
| `sections` | provider ごとの検索結果 |

`reset()` は検索条件と結果を消すが、利用者設定である `descriptionMode` は維持する。
プロジェクト切替時は `defaultProjectLifecycle` から reset する。

### `useResultsPanelStore`

表示状態を所有する。

- Source / 検索種別の除外
- hover / selected item
- パネル入力への focus request

検索結果そのものは持たない。

## Provider

`providers/registry.ts` は `CommandCenterProvider` を order 順で返す。
surface や search/command mode の分岐は持たない。

各 provider は次を実装する。

- `id`, `order`, `title`
- `hideWhenEmpty`
- `search(context)`
- 必要なら `cacheKeyExtras(extras)`

### Lexical

- 200ms debounce
- `fts_search` を `scope: "all"` で呼ぶ
- Scene / Codex / Snippet をそれぞれの画面へ遷移させる

### Semantic

- 300ms debounce
- 2文字未満では検索しない
- Scene chunk と score を返す
- model 未導入時は Lexical を妨げないよう空 section へ degrade する
- `descriptionMode` を provider 固有 cache key に含める

## 検索実行と race 対策

`useCommandCenterSearch` は入力を parse し、provider ごとに debounce する。

- `AbortController`: 可能な処理を中断する補助
- generation ID: abort できない invoke の古い応答を破棄する主ガード
- provider 単位 memo: query / excludes / provider extras / 最大 limit が同じなら
  再取得しない
- loading / error は section state として保持する

除外語は provider の取得後に `filterByExcludes` で共通適用する。

## 撤去した経路

次のファイルと公開 API は使わない。

- `CommandCenterBar`
- `CommandCenterPopover`
- `CommandCenterResultList`
- `useCommandCenterKeyboard`
- `quickOpenProvider`
- `commandProvider`
- `useBarStore` / `useCommandCenterStore`
- `selectPopoverOpen`

設定、エクスポート、パネル操作はヘッダー上の既存ボタンと各 UI から行う。
常駐バーを再導入せず、将来コマンドパレットが必要になった場合は一時的な
overlay として別途設計する。

## テスト

- `CommandCenterResultsPanel.test.tsx`: 検索専用 UI
- `index.test.ts`: バー API を公開しない
- `useCommandCenterSearch.test.tsx`: debounce / stale response / memo / error
- `commandCenterStore.test.ts`: panel store の最小状態
- provider tests: query、結果 mapping、遷移
- `HeaderBarLayout.browser.test.tsx`: 空の center レールが Electron drag region
