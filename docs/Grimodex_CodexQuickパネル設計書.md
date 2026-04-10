# Grimodex Codex Quickパネル設計書

## 概要

Codex QuickはScenesパネルとは独立した専用パネル。デフォルト配置はScenesパネルの下にdock（Left Dock内で垂直分割）。**現在エディタでアクティブなコンテンツ**（シーン・Note・Codexエントリのcontent）に関連するCodexエントリを自動表示する。

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

- エディタ本文中に出現するCodexエントリ名を自動検出し、一覧表示
- 各エントリの左にカテゴリ別カラードット（Character: パープル、Location: ティール、Item: アンバー、Lore: コーラル）
- 各エントリの右にカテゴリラベル（小さいテキスト）
- 手動で「ピン留め」したCodexエントリも表示（自動検出に漏れた場合の補完）

## インタラクション

| 操作 | 動作 |
|------|------|
| エントリをクリック | Codexパネルでそのエントリの詳細を開く（Codexパネルが閉じていればデフォルト位置に開く） |
| エントリをホバー | ポップオーバーでCodexエントリのプレビュー（名前、カテゴリ、要約の先頭100文字） |
| [+ Pin codex entry] | コマンドパレット風の検索UIでCodexエントリを選択し、ピン留め |
| ピン留めエントリの右の × | ピン留め解除 |
| `Ctrl+Alt+Q` | Codex Quickパネルにフォーカス/トグル |

## データフロー

```
エディタのアクティブコンテンツが変化（シーン切り替え・Codexタブ切り替え・本文編集）
  → 本文テキストを取得
  → Codexエントリ名のマッチング（Rustマッチャー）
  → マッチ結果 + 手動ピン留めを結合
  → Codex Quickパネルを更新
```

このマッチングはエディタ内のCodexハイライト（Pure Decorations）と同じパイプライン（`useCodexHighlight` → `codexMatchOrchestrator`）を使い、`useCodexHighlightStore.matchedEntryIds` を共有する。

### タブ種別ごとの挙動

| タブ種別 | Codex Quickへの反映 | 自己参照の扱い |
|---------|---------------------|---------------|
| シーン / Note | 反映する | — |
| Codexエントリ（content編集） | 反映する | 編集中のエントリ自身は除外 |
| Snippet | 反映しない | — |

### Split mode（2グループ表示時）

エディタがSplit modeの場合、**フォーカスされているグループ**（`activeGroupIndex`）のコンテンツのみがCodexQuickを更新する。非アクティブグループは `skipMatchedIds: true` で動作し、視覚デコレーション（ハイライト）は機能するがCodexQuickには影響しない。

グループをクリックしてフォーカスを切り替えると、即座にそのグループのコンテンツで再マッチングが走りCodexQuickが更新される。
