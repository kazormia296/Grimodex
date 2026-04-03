# Grimodex Chat Historyパネル設計書

## 概要

Chat Historyパネルはプロジェクト内の全チャットセッションを横断的に検索・閲覧するためのパネル。Chatパネルが「会話する場所」であるのに対し、Chat Historyパネルは「過去の会話を探す場所」。特定のキャラクター設定を議論したチャット、プロットのブレインストーミング結果、Codex/Snippetの抽出元などを素早く見つけ出す。

デフォルト位置: Right Top（Chatと同グループ、非アクティブタブ）。Chatパネルのタブバーに「履歴」タブとして常駐し、初期状態は非アクティブ。

---

## パネル構造

```
┌──────────────────────────────────────┐
│ A. Header                            │
│ Chat history                24 sessions│
├──────────────────────────────────────┤
│ B. Search bar                        │
│ [🔍 Search messages...             ] │
├──────────────────────────────────────┤
│ C. Filter bar                        │
│ [All scenes ▼] [Has extractions]     │
│ [Project scope]         Sort: Recent │
├──────────────────────────────────────┤
│ D. Session list (grouped)            │
│                                      │
│ Ch 1: Awakening / The tower          │
│ ┌──────────────────────────────────┐ │
│ │ Character deep-dive    Today     │ │
│ │ Describe what Elara feels...     │ │
│ │ [8 msgs] [2 codex] [1 snippet]  │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ Session 1              Mar 28   │ │
│ │ This tower — give me its full...│ │
│ │ [4 msgs] [1 codex]              │ │
│ └──────────────────────────────────┘ │
│                                      │
│ Ch 1: Awakening / First spell        │
│ ┌──────────────────────────────────┐ │
│ │ Magic system brainstorm  Mar 29 │ │
│ │ ...                              │ │
│ └──────────────────────────────────┘ │
│                                      │
│ Project scope                        │
│ ┌──────────────────────────────────┐ │
│ │ Plot outline discussion  Mar 27 │ │
│ │ ...                              │ │
│ └──────────────────────────────────┘ │
│                                      │
└──────────────────────────────────────┘
```

---

## A. ヘッダー

- **パネルタイトル**: 「Chat history」
- **セッション数**: 右寄せで総セッション数を表示（フィルタ適用時はフィルタ後の件数）

---

## B. 検索バー

### 全文検索

- チャットメッセージの全文をインクリメンタル検索（FTS5）
- 検索対象: ユーザーメッセージ + AIメッセージの本文
- 入力開始で即時フィルタ（デバウンス300ms）
- マッチしたメッセージを含むセッションのみ表示
- セッションカード内にマッチしたメッセージのスニペット（ハイライト付き）を表示

### 検索結果の表示

検索中は通常のセッションリストが「検索結果モード」に切り替わる:

```
Search: "Elara magic"          3 results

Ch 1 / The tower > Character deep-dive
  "...Elara's connection to magic stems from..."
  Message 5 of 8 · AI · Today 14:32

Ch 1 / First spell > Magic system brainstorm
  "...How should Elara learn her first spell?..."
  Message 2 of 12 · User · Mar 29 10:15

  "...Elara could discover magic through..."
  Message 3 of 12 · AI · Mar 29 10:15
```

各結果をクリックすると、Chatパネルがそのセッションの該当メッセージまでスクロールして開く。

---

## C. フィルタバー

### フィルタ項目

**シーンフィルタ（ドロップダウン）**:
- All scenes（デフォルト）
- 特定のシーンを選択 → そのシーンのセッションのみ表示
- 選択UIはScenesツリーと同じ階層表示（Part > Chapter > Scene）

**トグルフィルタ（ピル型、クリックでON/OFF）**:

| フィルタ | 動作 |
|---------|------|
| Has extractions | Codex/Snippet抽出が1件以上あるセッションのみ |
| Project scope | シーン非紐づけのプロジェクトスコープセッションのみ |

**ソート順（ドロップダウン）**:

| ソート | 動作 |
|-------|------|
| Recent（デフォルト） | 最終更新日時の降順 |
| Oldest | 最終更新日時の昇順 |
| Most messages | メッセージ数の降順 |
| Most extractions | Codex+Snippet抽出数の降順 |

---

## D. セッションリスト

### グルーピング

セッションはシーン別にグループ化して表示する。グループヘッダーはScenesツリーのパス形式。

```
Ch 1: Awakening / The tower          ← グループヘッダー
  [Session card]
  [Session card]

Ch 1: Awakening / First spell
  [Session card]

Project scope                         ← シーン非紐づけ
  [Session card]
```

- シーンフィルタが適用されている場合はグループヘッダー不要（1グループのみ）
- ソート順はグループ内のセッションに適用。グループ自体の順序はツリー順

### セッションカード

各セッションは以下の情報を持つカード型で表示:

```
┌──────────────────────────────────┐
│ Session title         Timestamp  │
│ First user message preview...    │
│ [N msgs] [N codex] [N snippets]  │
└──────────────────────────────────┘
```

| 要素 | 詳細 |
|------|------|
| セッションタイトル | LLMが最初の会話から自動生成（3-6語の要約）。手動リネームも可能。生成方法の詳細はChatパネル設計書を参照 |
| タイムスタンプ | 最終更新の相対日時（Today / Yesterday / Mar 28 等） |
| メッセージプレビュー | 最初のユーザーメッセージの先頭50文字。テキスト切り詰め |
| メッセージ数バッジ | パープルのピル。総メッセージ数 |
| Codex抽出バッジ | ティールのピル。このセッションから抽出されたCodexエントリ数。0の場合は非表示 |
| Snippet抽出バッジ | アンバーのピル。このセッションから抽出されたSnippet数。0の場合は非表示 |

### セッションカードのインタラクション

| 操作 | 動作 |
|------|------|
| クリック | Chatパネルでそのセッションを開く。Chatパネルが閉じていればデフォルト位置に開く |
| ダブルクリック | Chatパネルでセッションを開き、さらにChatパネルにフォーカスを移す |
| 右クリック | コンテキストメニュー（後述） |
| ホバー | カードを軽くハイライト |

現在Chatパネルでアクティブなセッションは左ボーダー+背景ハイライトで強調表示。

### コンテキストメニュー

| メニュー項目 | 動作 |
|-------------|------|
| Open in Chat | Chatパネルでこのセッションを開く |
| Rename | セッション名をインライン編集。手動リネーム後は自動タイトル再生成を抑制 |
| Go to scene | Scenesパネルで紐づくシーンを選択し、Editorで開く |
| --- | |
| Export as Markdown | セッションの全メッセージをMarkdown形式でエクスポート |
| --- | |
| Delete | 確認ダイアログ後に削除（抽出済みCodex/Snippetは残る） |

---

## Chat Historyパネルと他パネルの連携

### → Chatパネル

- セッションカードをクリック → Chatパネルがそのセッションに切り替わる
- 検索結果のメッセージをクリック → Chatパネルがそのセッションの該当メッセージまでスクロール
- Chatパネルが閉じている場合はデフォルト位置（Right Dock）に開く

### → Scenesパネル / Editor

- セッションカードの「Go to scene」→ Scenesパネルで該当シーンを選択し、Editorで開く
- シーン別グループヘッダーをクリック → 同様にそのシーンをEditorで開く

### → Codex / Snippets

- セッションカードのCodex抽出バッジをクリック → そのセッションから抽出されたCodexエントリ一覧をポップオーバー表示。エントリ名クリックでCodexパネルへ
- Snippet抽出バッジも同様

### ← Codexパネル / Snippetsパネル

- Codexエントリの詳細画面に「抽出元チャット」リンクがある（Chat設計書で定義済み）
- このリンクをクリック → Chat Historyパネルで該当セッションをハイライトし、Chatパネルで開く

---

## キーボードショートカット

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Alt+H` | Chat Historyパネルにフォーカス/トグル |
| `Ctrl+F`（パネルフォーカス時） | 検索バーにフォーカス |
| `↑` / `↓` | セッションカード間の移動 |
| `Enter` | 選択中のセッションをChatパネルで開く |
| `Escape` | 検索クリア |

---

## DBへの影響

新しいテーブルは不要。既存の `chat_sessions` + `chat_messages` テーブルを検索用にインデックス追加:

```sql
-- メッセージ全文検索用のFTS5仮想テーブル
CREATE VIRTUAL TABLE chat_messages_fts USING fts5(
  content,
  content=chat_messages,
  content_rowid=rowid,
  tokenize='trigram'
);

-- 同期トリガー
CREATE TRIGGER chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER chat_messages_fts_ad AFTER DELETE ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER chat_messages_fts_au AFTER UPDATE ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO chat_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

抽出数の集計は `chat_messages.metadata` JSONの `extractedCodex` / `extractedSnippets` 配列の長さをカウント。パフォーマンスが問題になった場合、`chat_sessions` に `codex_count` / `snippet_count` のデノーマライズドカラムを追加。

---

## 既存設計書との整合

### レイアウト設計書

パネル一覧に Chat History を追加。Activity Barのアイコン一覧にも追加が必要。

### Chatパネル設計書

Chatパネルのヘッダーにある「Sessions」サイドシートは**当該シーンのセッション一覧**に限定し、横断的な検索はChat Historyパネルに委ねる。両方とも残す（Chatパネル内Sessionsは素早い切り替え用、Chat Historyは横断検索用）。
