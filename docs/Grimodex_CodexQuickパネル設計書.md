# Grimodex Codex Quickパネル設計書

> **このパネルは Scene Context パネルへ統合されました（PR#215・2026-06-29）。** Codex Quick は現在 Scene Context パネル内の『Codex セクション』として存在します。パネル全体の設計（パネル登録・配置・ヘッダー・他セクションとの統合）は [[Grimodex_SceneContextパネル設計書]] を参照。

このドキュメントは Codex Quick **セクション固有の挙動**（本文マッチング・表示ルール・ピン留め・split mode）を記録するための深掘り先として残す。独立パネルとしての登録・配置に関する記述は **旧設計（統合前）** であり、現行ではない。

## 概要

Codex Quick は Scene Context パネル内の『Codex セクション』として、**現在エディタでアクティブなコンテンツ**（シーン・Note・Codex エントリの content）に関連する Codex エントリを自動表示する。内容コンポーネントは `CodexQuickSection.tsx`。

> **旧設計（統合前・廃止）**: かつては Scenes パネルとは独立した専用パネル（`CodexQuickPanel.tsx`）として Dockview 上で `codex-quick` パネル ID で登録され、レイアウト解決規則（`src/features/layout/layoutStore.ts` の `PANEL_INSERT_REGISTRY`）でデフォルトは Codex パネルと同じグループ（タブ内）に dock、Codex が無ければ Scenes パネルの下に挿入される構成だった。**現行ではこの独立パネル登録・Dock 配置は廃止**され、Scene Context パネルの 1 セクションへ統合されている。パネル ID `codex-quick` は統合後の Scene Context パネルに引き継がれた（後方互換のレイアウト復元のため）。

```
（旧・独立パネル時のレイアウト。現行は [[Grimodex_SceneContextパネル設計書]] のセクション図を参照）
┌─────────────────────────────────────┐
│ Scenes                          … ⋮ │  ← Scenesパネル（上）
│   ▶ Chapter 1                       │
│     • Scene 1                       │
│     • Scene 2                       │
├─────────────────────────────────────┤
│ Codex Quick                         │  ← 旧・独立パネル（現在はScene Context内のCodexセクション）
│   ● Elara (protagonist)   character │
│   ● The Obsidian Tower     location │
│   ● Soulbind Amulet            item │
└─────────────────────────────────────┘
```

## Codex セクションの表示ルール

Scene Context パネルの Codex セクション内での表示挙動は以下のとおり（統合後も不変）。

- エディタ本文中に出現する Codex エントリ名を自動検出し、一覧表示（`useCodexHighlightStore.matchedEntryIds` を購読）
- 各エントリの左にカテゴリ別カラードット（色は `useCodexHighlightStore.typeColorMap` から動的取得。Character: パープル、Location: ティール、Item: アンバー、Lore: コーラル等は組み込み既定値）
- 各エントリの右にカテゴリラベル（小さいテキスト）
- 手動で「ピン留め」した Codex エントリも表示（自動検出に漏れた場合の補完。自動検出と重複した場合はマッチ側を優先して重複排除）
- セクション上部のツールバーで、ソート順を `category` / `name-asc` / `name-desc` / `updated` / `created` から選択可能（`most-referenced` は参照数データを持たないため除外）。ソート状態は `useCodexStore.sortOrder` を共有し、Codex 管理パネルと同期する

### 「今の真実」バッジと未開示伏線警告（2026-06-18 追記）

- **「今の真実」バッジ**: フェーズ（時系列）を持つエントリは、名前とカテゴリラベルの間に適用中フェーズの `phaseLabel` を `primary` 色のピルで表示する（`useResolvedCodexStates(displayedIds)` → `resolveCodexStatesFor` → `phaseResolver.resolveCodexState`）。アクティブシーン（`useTreeStore.activeSceneId`）と `globalSceneOrder` から「そのシーン時点でのフェーズ」を解決して出すため、執筆位置に追随する read-only 表示。フェーズ未設定のエントリにはバッジは出ない。
- **未開示伏線警告アイコン**: 「今の真実」バッジの隣に、`EyeOff` アイコン（アンバー色）を表示する。アクティブシーン時点でまだ回収されていない `secret` 伏線がそのエントリに紐づく場合のみ出る（`useUnrevealedSecretForeshadows(displayedIds)` → `computeUnrevealedSecretForeshadows`）。`aria-label`／ツールチップは i18n キー `codex.spoiler.unrevealedTooltip`（例: 「このシーン時点で未開示: {{titles}}」）。`abandoned` 伏線・回収済み（`payoffConfirmed`）伏線は警告対象外。伏線取得失敗時はその行の警告を出さない（安全側）。
- **行内の表示順**は左から: カテゴリドット → 名前 → 「今の真実」バッジ → 未開示伏線警告アイコン → カテゴリラベル → ピンボタン（ホバー時／ピン済み時に出現）。

## インタラクション

| 操作 | 動作 |
|------|------|
| エントリをクリック | Codex パネルを表示し（`useLayoutStore.showPanel("codex")`）、`useCodexStore.requestSelectEntry(id)` でそのエントリの詳細を選択 |
| エントリをホバー | ポップオーバーで Codex エントリのプレビューを表示（`CodexQuickPopover` → `CodexEntryPopoverContent` を使用）。行と同じく「今の真実」バッジ（`phaseLabel`）、フェーズ解決後の summary（`resolvedSummary`、未設定時は Base の `summary`）、未開示伏線の警告文（`spoilerNote`）も併せて表示する |
| 行ホバー時に出現するピンアイコン | クリックでピン留め／解除をトグル（`togglePinnedCodex`、ピン済みエントリでは PinOff アイコンを常時表示） |
| [+ Pin Codex entry] | `CodexCommandPalette`（`src/features/codex/components/CodexCommandPalette.tsx`）を開き、検索してエントリを選択するとピン留め |

> **旧設計（統合前・廃止）**: 独立パネル時は `Ctrl+Alt+Q` で Codex Quick パネルの表示トグル＋フォーカス（`src/App.tsx` のグローバルショートカット）を提供していた。統合後のショートカット／フォーカス挙動は Scene Context パネル側で扱う（[[Grimodex_SceneContextパネル設計書]] 参照）。

※ 設計書当初の「ピン留めエントリの右の × 」は実装されておらず、現状は行ホバー時のピン／PinOff アイコンによるトグル UI に置き換えられている。

## データフロー

```
エディタのアクティブコンテンツが変化（シーン切り替え・Codexタブ切り替え・本文編集）
  → 本文テキストを取得
  → Codexエントリ名のマッチング（Rustマッチャー）
  → マッチ結果 + 手動ピン留めを結合
  → Codex セクションを更新
```

このマッチングはエディタ内の Codex ハイライト（Pure Decorations）と同じパイプライン（`useCodexHighlight` → `codexMatchOrchestrator`）を使い、`useCodexHighlightStore.matchedEntryIds` を共有する。

### ピン留めの永続化

手動ピン留めは `pinnedCodexIds`（`useTreeStore`）でメモリ保持し、`src/features/tree/codexQuickPinApi.ts` 経由で SQLite の `codex_quick_pins` テーブル（`src/db/schema.ts`）に永続化される。アプリ起動時に `loadPinnedCodexIds()` が DB から復元する。

### タブ種別ごとの挙動

| タブ種別 | Codex セクションへの反映 | 自己参照の扱い |
|---------|---------------------|---------------|
| シーン / Note | 反映する | — |
| Codexエントリ（content編集） | 反映する | 編集中のエントリ自身は除外 |
| Snippet | 反映しない | — |

### Split mode（2グループ表示時）

エディタが Split mode の場合、**フォーカスされているグループ**（`activeGroupIndex`）のコンテンツのみが Codex セクションを更新する。非アクティブグループは `skipMatchedIds: true` で動作し、視覚デコレーション（ハイライト）は機能するが Codex セクションには影響しない。

グループをクリックしてフォーカスを切り替えると、即座にそのグループのコンテンツで再マッチングが走り Codex セクションが更新される。

## 関連設計書

- [[Grimodex_SceneContextパネル設計書]] — 統合先パネル全体の設計（登録・配置・ヘッダー・他セクション統合）。本書の上位。
- [[Grimodex_Codexパネル設計書]] — Codex エントリ管理本体（ソート順共有・`codex_quick_pins` 参照・フェーズ解決の正本）。
