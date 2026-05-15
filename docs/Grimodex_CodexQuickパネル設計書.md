# Grimodex Codex Quickパネル設計書

## 概要

Codex QuickはScenesパネルとは独立した専用パネル（`src/features/tree/CodexQuickPanel.tsx`、内容は `CodexQuickSection.tsx`）。**現状の実装**: Dockview 上で `codex-quick` パネルとして登録され、レイアウト解決規則（`src/features/layout/layoutStore.ts` の `PANEL_INSERT_REGISTRY`）によりデフォルトは Codex パネルと同じグループ（タブ内）にdock、Codex が無ければ Scenes パネルの下に挿入される。**現在エディタでアクティブなコンテンツ**（シーン・Note・Codexエントリのcontent）に関連するCodexエントリを自動表示する。

```
┌─────────────────────────────────────┐
│ Scenes                          … ⋮ │  ← Scenesパネル（上）
│   ▶ Chapter 1                       │
│     • Scene 1                       │
│     • Scene 2                       │
├─────────────────────────────────────┤
│ Codex Quick                         │  ← Codex Quickパネル（下・独立）
│   ● Elara (protagonist)   character │
│   ● The Obsidian Tower     location │
│   ● Soulbind Amulet            item │
└─────────────────────────────────────┘
```

## 表示ルール

- エディタ本文中に出現するCodexエントリ名を自動検出し、一覧表示（`useCodexHighlightStore.matchedEntryIds` を購読）
- 各エントリの左にカテゴリ別カラードット（色は `useCodexHighlightStore.typeColorMap` から動的取得。Character: パープル、Location: ティール、Item: アンバー、Lore: コーラル等は組み込み既定値）
- 各エントリの右にカテゴリラベル（小さいテキスト）
- 手動で「ピン留め」したCodexエントリも表示（自動検出に漏れた場合の補完。自動検出と重複した場合はマッチ側を優先して重複排除）
- パネル上部にツールバーがあり、ソート順を `category` / `name-asc` / `name-desc` / `updated` / `created` から選択可能（`most-referenced` は参照数データを持たないため除外）。ソート状態は `useCodexStore.sortOrder` を共有し、Codex 管理パネルと同期する

## インタラクション

| 操作 | 動作 |
|------|------|
| エントリをクリック | Codexパネルを表示し（`useLayoutStore.showPanel("codex")`）、`useCodexStore.requestSelectEntry(id)` でそのエントリの詳細を選択 |
| エントリをホバー | ポップオーバーでCodexエントリのプレビューを表示（`CodexQuickPopover` → `CodexEntryPopoverContent` を使用） |
| 行ホバー時に出現するピンアイコン | クリックでピン留め／解除をトグル（`togglePinnedCodex`、ピン済みエントリでは PinOff アイコンを常時表示） |
| [+ Pin Codex entry] | `CodexCommandPalette`（`src/features/codex/components/CodexCommandPalette.tsx`）を開き、検索してエントリを選択するとピン留め |
| `Ctrl+Alt+Q` | Codex Quickパネルの表示トグル＋フォーカス（`src/App.tsx` のグローバルショートカット、表示後 `requestAnimationFrame` で `panel.api.setActive()` を呼ぶ） |

※ 設計書当初の「ピン留めエントリの右の × 」は実装されておらず、現状は行ホバー時のピン／PinOff アイコンによるトグル UI に置き換えられている。

## データフロー

```
エディタのアクティブコンテンツが変化（シーン切り替え・Codexタブ切り替え・本文編集）
  → 本文テキストを取得
  → Codexエントリ名のマッチング（Rustマッチャー）
  → マッチ結果 + 手動ピン留めを結合
  → Codex Quickパネルを更新
```

このマッチングはエディタ内のCodexハイライト（Pure Decorations）と同じパイプライン（`useCodexHighlight` → `codexMatchOrchestrator`）を使い、`useCodexHighlightStore.matchedEntryIds` を共有する。

### ピン留めの永続化

手動ピン留めは `pinnedCodexIds`（`useTreeStore`）でメモリ保持し、`src/features/tree/codexQuickPinApi.ts` 経由で SQLite の `codex_quick_pins` テーブル（`src/db/schema.ts`）に永続化される。アプリ起動時に `loadPinnedCodexIds()` が DB から復元する。

### タブ種別ごとの挙動

| タブ種別 | Codex Quickへの反映 | 自己参照の扱い |
|---------|---------------------|---------------|
| シーン / Note | 反映する | — |
| Codexエントリ（content編集） | 反映する | 編集中のエントリ自身は除外 |
| Snippet | 反映しない | — |

### Split mode（2グループ表示時）

エディタがSplit modeの場合、**フォーカスされているグループ**（`activeGroupIndex`）のコンテンツのみがCodexQuickを更新する。非アクティブグループは `skipMatchedIds: true` で動作し、視覚デコレーション（ハイライト）は機能するがCodexQuickには影響しない。

グループをクリックしてフォーカスを切り替えると、即座にそのグループのコンテンツで再マッチングが走りCodexQuickが更新される。
