# Grimodex Chat Historyパネル設計書

## 概要

Chat Historyパネルはプロジェクト内の全チャットセッションを横断的に検索・閲覧するためのパネル。Chatパネルが「会話する場所」であるのに対し、Chat Historyパネルは「過去の会話を探す場所」。特定のキャラクター設定を議論したチャット、プロットのブレインストーミング結果、Codex/Snippetの抽出元などを素早く見つけ出す。

デフォルト位置: Right Top（Chatと同グループ、非アクティブタブ）。Chatパネルのタブバーに「履歴」タブとして常駐し、初期状態は非アクティブ。

実装は `src/features/chat/ChatHistoryPanel.tsx`、状態は `src/features/chat/chatHistoryStore.ts`（Zustand）、DB アクセスは `src/features/chat/chatHistoryApi.ts`、セッションカードは `src/features/chat/components/SessionCard.tsx`。

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
- 検索対象: ユーザーメッセージ + AIメッセージの本文（`m.role != 'system'` でシステムプロンプトは除外）
- 入力開始で即時フィルタ（デバウンス300ms）
- マッチしたメッセージを含むセッションのみ表示
- セッションカード内にマッチしたメッセージのスニペット（ハイライト付き）を表示
- 取得件数の上限はクエリ内で `LIMIT 50`。それを超えるヒットは現状切り捨て（ページングは将来拡張）
- ハイライトは FTS5 の `snippet()` 関数が `\x01` / `\x02` のセンチネル文字でマーカ付き文字列を返し、`ChatHistoryPanel` 側の `renderHighlight()` が `<mark>` に変換する

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
- **現状の実装**: ネイティブ `<select>` + `<optgroup>` で **Folder > Scene の 2 階層**だけを並べる（`folder.title` が `<optgroup label>`、Scene は `<option>`）。Folder 階層をネストした「Part > Chapter > Scene」のフル階層表示は未実装
- 親 Folder を持たない Scene は `Uncategorized` グループに入る
- `sceneFilter` を選んでいる場合は `projectScopeOnly` トグルより優先される（`filterAndSortSessions` 仕様）

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
- **現状の実装**: グループヘッダーは Scene 単体のタイトル（`nodeMap[nodeId]?.title`）のみを描画する。`groupSessionsByScene` (`src/features/chat/chatHistoryStore.ts`) は祖先 Folder までさかのぼった「Ch 1: Awakening / The tower」形式のパス連結を行わない。`SessionGroup` 型もフラットな `groupLabel: string` を持つだけ
- グループの順序は `Map` への挿入順（=セッション一覧の元順序）に依存。`nodeId === null` の Project scope グループだけは末尾に押し下げる。「ツリー順」での厳密ソートは未実装
- Scene グループのヘッダーをクリックすると、`treeStore.setActiveScene` と `tabStore.openPinned` を同時に呼んで Editor で開く（`Go to scene` 相当の動作がヘッダー直クリックに割り当てられている）

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
| メッセージプレビュー | 最初のユーザーメッセージの先頭 **100 文字**（`chatHistoryApi.ts` の `firstUserMessage.content.slice(0, 100)`、行数で 1 行クランプ）。設計書旧版の「50文字」は実装と一致しない |
| メッセージ数バッジ | パープルのピル。**`role !== 'system'` のメッセージ数**（システムプロンプトは除外） |
| Codex抽出バッジ | ティールのピル。このセッションから抽出されたCodexエントリ数。0の場合は非表示。クリックでエントリ一覧のポップオーバーを表示 |
| Snippet抽出バッジ | アンバーのピル。このセッションから抽出されたSnippet数。0の場合は非表示。クリックでエントリ一覧のポップオーバーを表示 |
| 抽出ゼロ表示 | Codex / Snippet ともに 0 件のとき「No extractions」薄字を代わりに表示（実装側で追加された UI） |

### セッションカードのインタラクション

| 操作 | 動作 |
|------|------|
| クリック | Chatパネルでそのセッションを開く。Chatパネルが閉じていればデフォルト位置に開く |
| ダブルクリック | Chatパネルでセッションを開き、さらにChatパネルにフォーカスを移す |
| 右クリック | コンテキストメニュー（後述） ※ 現状未実装 |
| ホバー | カードを軽くハイライト |

現在Chatパネルでアクティブなセッションは左ボーダー+背景ハイライトで強調表示。

> **現状の実装**: クリック / ダブルクリックは両方とも `chatStore.selectSession(sessionId)` を呼ぶだけで、フォーカス移動の差分は実装されていない（コメント `// Focus chat panel via store (no direct DOM access needed)` のみ残っている）。`Enter` キーは `role="button"` のキーハンドラから単発で `onClick` を呼ぶ。

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

> ※ 現状未実装。`SessionCard` には `onContextMenu` ハンドラも `ContextMenu` コンポーネントの呼び出しも存在しない。`Go to scene` 相当の動線はグループヘッダーのクリックに分解されている（前述「グルーピング」参照）。Rename / Delete / Export Markdown は将来拡張扱い。

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

> **現状の実装**:
> - `Ctrl+Alt+H` はパネルレジストリ (`src/features/layout/panelRegions.ts`) でグローバル登録済み
> - `Escape` は検索入力フォーカス時のみ `handleSearchChange("")` で検索クリア + 入力 blur
> - `Enter` は `SessionCard` 単体のキーハンドラでカードを開く（リスト全体での選択カーソル概念は未実装）
> - `Ctrl+F`（パネル内検索フォーカス）、`↑` / `↓` でのカード間移動は未実装

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

> **現状の実装**: 抽出元の追跡は JSON メタデータではなく、`codex_entries.source_chat_message_id` / `snippets.source_chat_message_id` の **FK カラム**で行われている（`src/db/schema.ts`、`idx_codex_entries_src_msg` / `idx_snippets_src_msg` のインデックスあり）。`listSessionsWithStats` (`src/features/chat/chatHistoryApi.ts`) はセッション配下の `chat_messages.id` をまとめて引いたあと、この FK で `codexCount` / `snippetCount` を集計する。`listExtractionsBySession` も同じ FK を辿ってバッジクリック時のポップオーバー一覧を返す。FTS5 仮想テーブル `chat_messages_fts` および対応する `_ai` / `_ad` / `_au` トリガは `src-tauri/src/database/migrate.rs` に同等の DDL で実装済み。

---

## 既存設計書との整合

### レイアウト設計書

パネル一覧に Chat History を追加。ヘッダードロップダウンのパネル一覧にも含まれている。

### Chatパネル設計書

Chatパネルのヘッダーにある「Sessions」サイドシートは**当該シーンのセッション一覧**に限定し、横断的な検索はChat Historyパネルに委ねる。両方とも残す（Chatパネル内Sessionsは素早い切り替え用、Chat Historyは横断検索用）。
