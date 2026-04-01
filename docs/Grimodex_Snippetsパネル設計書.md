# Grimodex Snippetsパネル設計書

## 概要

Snippetsパネルは再利用可能なテキスト断片を管理するパネル。AIチャットから生成された台詞案、エディタから切り出した名描写、手動で作成した定型表現などを保存し、D&Dまたはコンテキストメニューでエディタに挿入する。クリップボードとCodexの中間的な存在で、「まだ本文には入れないが捨てたくないテキスト」の一時保管場所。

デフォルト位置: Bottom Dock（非表示）

---

## パネル構造

```
┌──────────────────────────────────────────────┐
│ A. Header                                     │
│ Snippets                    12 snippets  [+]  │
├──────────────────────────────────────────────┤
│ B. Search bar                                 │
│ [🔍 Search snippets...                      ] │
├──────────────────────────────────────────────┤
│ C. Filter bar                                 │
│ [All] [From chat] [From editor] [Manual]      │
│                                 Sort: Recent  │
├──────────────────────────────────────────────┤
│ D. Snippet list                               │
│                                               │
│ ⠿ A jolt of recognition surges through...     │
│   A jolt of recognition surges through her    │
│   fingertips — not pain, but a deep...        │
│   [AI]  142 chars  The tower                  │
│                                               │
│ ⠿ The runes pulsed with amber light           │
│   The runes pulsed with amber light, each     │
│   symbol flickering in sequence like a...     │
│   [Human]  118 chars  First spell             │
│                                               │
│ ⠿ Standard tavern description template        │
│   The tavern smelled of woodsmoke and...      │
│   186 chars  [tavern] [description]           │
│                                               │
└──────────────────────────────────────────────┘
```

Bottom Dockに配置されるため横長のレイアウトを想定。スニペットカードは横スクロールではなく縦リスト。パネル幅が十分な場合はカードを2-3カラムのグリッドで表示。

---

## A. ヘッダー

- **パネルタイトル**: 「Snippets」
- **スニペット数**: フィルタ適用後の件数。右寄せ
- **[+] ボタン**: 新規スニペット作成（空のスニペットを作成し、インライン展開で即時編集）

---

## B. 検索バー

- スニペットの title と content をインクリメンタル検索
- タグも検索対象に含む
- デバウンス300ms
- `Escape` でクリア

---

## C. フィルタバー

### ソースフィルタ（ピル型、排他選択）

| フィルタ | 条件 |
|---------|------|
| All | 全スニペット（デフォルト） |
| From chat | `source_chat_message_id` が非NULL |
| From editor | `source_chat_message_id` がNULL かつ `scene_id` が非NULL |
| Manual | `source_chat_message_id` がNULL かつ `scene_id` がNULL |

### タグフィルタ

- 検索バーの下にタグクラウド（使用頻度順、上位10個）を表示するオプション（パネルメニューからON/OFF）
- タグクリックでそのタグを持つスニペットのみ表示

### ソート順

| ソート | 動作 |
|-------|------|
| Recent（デフォルト） | 作成日時の降順 |
| Oldest | 作成日時の昇順 |
| Title (A→Z) | タイトルのアルファベット/50音順 |
| Most used | 挿入回数の降順 |

---

## D. スニペットリスト

### スニペットカード

各スニペットはドラッグ可能なカードとして表示。

```
⠿ Snippet title                              ×
  Content preview text that can span up to
  two lines before being truncated...
  [AI]  142 chars  Scene name  [tag1] [tag2]
```

| 要素 | 詳細 |
|------|------|
| ドラッグハンドル (⠿) | カード左端。ドラッグ開始のグリップ。カード全体もドラッグ可能 |
| タイトル | 太字。先頭30文字、または手動設定のタイトル |
| × ボタン | ホバー時のみ表示。削除（確認ダイアログ） |
| コンテンツプレビュー | 本文の先頭2行（最大80文字）。テキスト切り詰め |
| ソースバッジ | [AI]: パープルのピル（Chatから抽出、source=ai）、[Human]: グレーのピル（Editorから保存、source=human）、バッジなし: 手動作成 |
| 文字数 | コンテンツの文字数 |
| シーン名 | 紐づくシーン名（`scene_id` がある場合）。クリックでそのシーンをEditorで開く |
| タグ | ピル型。クリックでそのタグでフィルタ |

### カードのインタラクション

| 操作 | 動作 |
|------|------|
| クリック | カードをインライン展開して詳細表示（後述） |
| ドラッグ（→ Editor） | エディタのカーソル位置にスニペット内容を挿入 |
| ダブルクリック | コンテンツ全文をクリップボードにコピー |
| 右クリック | コンテキストメニュー（後述） |
| ホバー | 軽いハイライト + × ボタン表示 |

### インライン展開（詳細表示）

スニペットカードをクリックすると、カードが展開してフル編集モードになる。

```
┌──────────────────────────────────────────┐
│ Title: [A jolt of recognition surges...] │  ← 編集可能
├──────────────────────────────────────────┤
│ A jolt of recognition surges through     │
│ her fingertips — not pain, but a deep    │  ← 全文表示、編集可能
│ resonance, as if the stone remembers     │     (テキストエリア)
│ her from another lifetime.               │
├──────────────────────────────────────────┤
│ Tags: [dialogue] [elara] [+]             │  ← 編集可能
├──────────────────────────────────────────┤
│ Source: Character deep-dive (chat) →     │
│ Scene: The tower →                       │
│ Created: Today 14:32                     │
│ Used: 2 times                            │
├──────────────────────────────────────────┤
│         [Insert at cursor] [Collapse]    │
└──────────────────────────────────────────┘
```

| フィールド | 詳細 |
|-----------|------|
| Title | インライン編集。`Enter` で確定、`Escape` でキャンセル |
| Content | TipTapミニエディタ。Markdown記法をリアルタイムにリッチテキストとしてレンダリング（太字、斜体、見出し、リスト、リンク対応）。Markdownファイルとして保存。自動保存（デバウンス2秒） |
| Tags | ピル型。[+] で追加、×で削除。既存タグのオートコンプリート |
| Source | `source_chat_message_id` がある場合、セッション名のリンク。クリックでChat Historyパネル経由で元セッションを開く |
| Scene | `scene_id` がある場合、シーン名のリンク。クリックでEditorで開く |
| Created | 作成日時 |
| Used | エディタに挿入された回数（`usage_count`） |
| [Insert at cursor] | エディタのカーソル位置に挿入。D&Dの代替手段 |
| [Collapse] | 展開を閉じてカード表示に戻る |

展開中は他のカードとの間にスペースが開き、展開カードが視覚的に浮き上がる（背景色変更のみ、シャドウなし）。

---

## スニペットの作成

### 1. Chatパネルから（Chat設計書で定義済み）

- AIメッセージの「Snippet」ボタン → メッセージ全文（またはテキスト選択範囲）を即時保存
- トースト通知「Saved as Snippet」
- `source_chat_message_id` が自動付与
- `scene_id` はChatのアクティブシーンが設定される

### 2. Editorから（Editor設計書で定義済み）

- コンテキストメニュー「Save as Snippet」→ 選択テキストを即時保存
- トースト通知「Saved as Snippet: "{タイトル}"」。トースト内「Edit」リンクでSnippetsパネルの展開表示へ
- `source_chat_message_id` はNULL
- `scene_id` はEditorのアクティブシーンが設定される

### 3. Snippetsパネルから（手動作成）

- ヘッダーの [+] ボタン → 空のスニペットを作成し、リスト先頭にインライン展開で表示
- タイトルフィールドにフォーカスが当たり、即時入力可能
- `source_chat_message_id` と `scene_id` はどちらもNULL

### 4. クリップボードから

- Snippetsパネルにフォーカスがある状態で `Ctrl+V` → クリップボードのテキストからスニペットを作成
- タイトルは先頭30文字を自動生成

---

## エディタへの挿入

### D&D挿入

- スニペットカードをドラッグ開始 → ドラッグプレビュー（スニペットタイトルを表示する小さなフローティングカード）
- EditorのCenter領域にドラッグ → ドロップ位置にカーソルインジケーター表示
- ドロップ → カーソル位置にスニペットのcontentを挿入

挿入時のAuthorship:
- スニペットのソースバッジが [AI] → `{ source: 'ai', chatMessageId: snippet.source_chat_message_id }`
- スニペットのソースバッジが [Human] または手動作成 → `{ source: 'human' }`

挿入後:
- `snippets.usage_count` を +1
- エディタで挿入箇所を一時ハイライト（パープル背景、2秒フェードアウト）

### コンテキストメニュー挿入（Editor設計書で定義済み）

- Editorのコンテキストメニュー「Insert from Snippet...」→ コマンドパレット風の検索UIでスニペットを選択 → カーソル位置に挿入
- 検索UIではタイトルとコンテンツのプレビューを表示
- 選択すると即挿入（D&Dと同じAuthorship処理）

### インライン展開の [Insert at cursor] ボタン

- Snippetsパネルでスニペットを展開中に「Insert at cursor」クリック → Editorのカーソル位置に挿入
- D&Dが不便な場合（パネルとEditorが離れている等）の代替

---

## コンテキストメニュー

スニペットカードの右クリック:

| メニュー項目 | 動作 |
|-------------|------|
| Insert at cursor | エディタのカーソル位置に挿入 |
| Copy content | コンテンツをクリップボードにコピー |
| Edit | インライン展開して編集モード |
| --- | |
| Duplicate | スニペットを複製（「{title} (copy)」） |
| Go to source chat | `source_chat_message_id` がある場合のみ表示。Chat Historyで元セッションを開く |
| Go to scene | `scene_id` がある場合のみ表示。Editorでそのシーンを開く |
| --- | |
| Delete | 確認ダイアログ後に削除 |

---

## グリッドレイアウト

Bottom Dockに配置される場合、横幅が広いのでカードを複数カラムで表示する。

| パネル幅 | カラム数 | カード幅 |
|---------|---------|---------|
| ~400px未満 | 1カラム | 100% |
| 400-700px | 2カラム | 50% |
| 700px以上 | 3カラム | 33% |

Left/Right Dockに移動した場合は幅が狭いため常に1カラム。

---

## DBスキーマ

```sql
CREATE TABLE snippets (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id),
  title                   TEXT NOT NULL DEFAULT 'Untitled',
  content                 TEXT NOT NULL DEFAULT '',
  tags                    TEXT,                               -- JSON array: ["dialogue", "elara"]
  scene_id                TEXT REFERENCES tree_nodes(id),     -- 作成元シーン（nullable）
  source_chat_message_id  TEXT REFERENCES chat_messages(id),  -- 抽出元チャット（nullable）
  usage_count             INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_snippets_project ON snippets(project_id, created_at DESC);

-- 全文検索用FTS5
CREATE VIRTUAL TABLE snippets_fts USING fts5(
  title,
  content,
  tags,
  content=snippets,
  content_rowid=rowid,
  tokenize='trigram'
);

-- FTS5同期トリガー
CREATE TRIGGER snippets_fts_ai AFTER INSERT ON snippets BEGIN
  INSERT INTO snippets_fts(rowid, title, content, tags)
    VALUES (new.rowid, new.title, new.content, new.tags);
END;

CREATE TRIGGER snippets_fts_ad AFTER DELETE ON snippets BEGIN
  INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags)
    VALUES ('delete', old.rowid, old.title, old.content, old.tags);
END;

CREATE TRIGGER snippets_fts_au AFTER UPDATE ON snippets BEGIN
  INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags)
    VALUES ('delete', old.rowid, old.title, old.content, old.tags);
  INSERT INTO snippets_fts(rowid, title, content, tags)
    VALUES (new.rowid, new.title, new.content, new.tags);
END;
```

Snippetのcontentは長文にも対応するため、Codexと同様にMarkdownファイルとして `snippets/` ディレクトリに保存する（`snippets/{sanitized_title}_{short_id}.md`）。SQLiteの `content` カラムにはファイルパスへの参照を保持する。FTS5の検索対象にはファイル内容を含めるか、title + tags のみにするかはMVPではtitle + tagsで十分と判断。

---

## キーボードショートカット

### Snippetsパネルにフォーカス時

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Alt+N` | Snippetsパネルにフォーカス/トグル（レイアウト設計書で定義済み） |
| `Ctrl+F`（パネルフォーカス時） | 検索バーにフォーカス |
| `↑` / `↓` | スニペットカード間のフォーカス移動 |
| `Enter` | 選択スニペットをインライン展開 / 展開中なら折りたたみ |
| `Ctrl+Enter` | 選択スニペットをEditorのカーソル位置に挿入 |
| `Ctrl+V` | クリップボードから新規スニペット作成 |
| `Del` | 選択スニペットを削除（確認ダイアログ） |
| `Escape` | 検索クリア / 展開を閉じる |

---

## 他パネルとの連携

### ← Chat

- Chatの「Snippet」ボタン → スニペット即時作成（`source_chat_message_id` 付き）
- Chat設計書の「Snippet保存」セクション参照

### ← Editor

- Editorのコンテキストメニュー「Save as Snippet」→ 選択テキストからスニペット即時作成
- Editor設計書の「Save as Snippet」セクション参照

### → Editor

- D&D挿入 → AuthorshipMark付与（ソースに応じてai/human）
- コンテキストメニュー「Insert from Snippet...」→ コマンドパレット風検索UIで挿入
- インライン展開の「Insert at cursor」ボタン

### → Chat History

- スニペットのSource行のリンク → Chat Historyパネルで元セッションを開く

### → Scenes / Editor

- スニペットのScene行のリンク → Editorでそのシーンを開く

---

## CodexとSnippetsの使い分け

| 項目 | Codex | Snippets |
|------|-------|----------|
| 用途 | 世界設定の構造化データベース | 再利用可能なテキスト断片の一時保管 |
| 内容の性質 | 設定情報（キャラ、場所、伝承） | 散文テキスト（台詞、描写、文章の断片） |
| 構造 | name + type + summary + content + aliases + relations | title + content（Markdown） |
| エディタとの関係 | 本文中でハイライト表示、ポップオーバー参照 | D&Dで本文に挿入（挿入後はスニペットとの紐付けなし） |
| AI連携 | コンテキスト注入（Layer 4）、マッチング | 直接的な連携なし |
| 典型的なライフサイクル | 長期保持。プロジェクト全体で参照 | 短〜中期。挿入して役目を終えたら削除も |

---

## 既存設計書との整合

### レイアウト設計書

Snippetsパネルのデフォルト位置はBottom Dock（非表示）。`Ctrl+Alt+N` でフォーカス/トグル。

### Editorパネル設計書

「Save as Snippet」の即時保存フロー、「Insert from Snippet...」のコマンドパレット風UI、D&D挿入時のAuthorshipMark付与はEditor設計書の記載を正とする。

### Chatパネル設計書

AIメッセージの「Snippet」ボタン押下時の即時保存フロー、`source_chat_message_id` 記録、`chat_messages.metadata.extractedSnippets` への追加はChat設計書の記載を正とする。

### Chat Historyパネル設計書

セッションカードのSnippet抽出バッジ（アンバーのピル）。Chat Historyのフィルタ「Has extractions」にSnippet抽出も含まれる。
