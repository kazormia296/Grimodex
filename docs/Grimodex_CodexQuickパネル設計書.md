# Grimodex Codex Quickパネル設計書

## 概要

Codex QuickはScenesパネルとは独立した専用パネル。デフォルト配置はScenesパネルの下にdock（Left Dock内で垂直分割）。現在Editorでアクティブなシーンに関連するCodexエントリを自動表示する。

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
Editor active scene changed
  → シーンの本文テキストを取得
  → Codexエントリ名のマッチング（FTS5 or 正規表現）
  → マッチ結果 + 手動ピン留めを結合
  → Codex Quickパネルを更新
```

このマッチングはエディタ内のCodexハイライト（Pure Decorations）と同じデータソースを使う。二重計算を避けるため、Zustandストアの `sceneCodexMatches` を共有する。
