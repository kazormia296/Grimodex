# Grimodex Snippetsパネル設計書

## 概要

Snippetsパネルは再利用可能なテキスト断片を管理するパネル。AIチャットから生成された台詞案、エディタから切り出した名描写、手動で作成した定型表現などを保存し、D&Dまたはコンテキストメニューでエディタに挿入する。クリップボードとCodexの中間的な存在で、「まだ本文には入れないが捨てたくないテキスト」の一時保管場所。

デフォルト位置: Bottom Dock（非表示）

---

## パネル構造

左右分割ペイン（ResizablePanelGroup）。左にリスト、右に選択スニペットの詳細エディタを表示する。Bottom Dockの横長レイアウトに最適化した設計で、カードをクリックするだけで即座にdetailが切り替わり、複数カードの素早い比較が可能。

```
┌─────────────────────────────┬────────────────────────────────┐
│ A. Header                    │ E. Detail pane                  │
│ Snippets     12 snippets [+] │                                 │
├─────────────────────────────┤ Title: [A jolt of recognition..] │
│ B. Search bar                │                                 │
│ [🔍 Search snippets...     ] │ A jolt of recognition surges    │
├─────────────────────────────┤ through her fingertips — not     │
│ C. Filter bar                │ pain, but a deep resonance...   │
│ [All][From chat][From editor]│                                 │
│ [Manual]       Sort: Recent  │ Tags: [dialogue] [elara] [+]    │
├─────────────────────────────┤                                 │
│ D. Snippet list              │ [AI]                            │
│                              │ Source: Character deep-dive →   │
│ ⠿ A jolt of recogn...    ×  │ Scene: The tower →              │
│   A jolt of recognition...   │ Created: Today 14:32            │
│   [AI]  142 chars  The tower │ Used: 2 times                   │
│                              │                                 │
│ ⠿ The runes pulsed...    ×  │ [Insert at cursor]              │
│   The runes pulsed with...   │                                 │
│   [Human]  118 chars         │                                 │
│                              │                                 │
│ ⠿ Standard tavern...     ×  │                                 │
│   The tavern smelled of...   │                                 │
│   186 chars [tavern][descr.] │                                 │
└─────────────────────────────┴────────────────────────────────┘
```

左ペインのスニペットリストは縦リスト。ペイン幅が十分な場合はカードを2-3カラムのグリッドで表示。

---

## A. ヘッダー

- **パネルタイトル**: 「Snippets」
- **スニペット数**: フィルタ適用後の件数。右寄せ
- **[+] ボタン**: 新規スニペット作成（空のスニペットを作成し、詳細ペインで即時編集）

---

## B. 検索バー

- スニペットの title、tags、content をインクリメンタル検索
- デバウンス300ms
- `Escape` でクリア

### 検索戦略（FTS5 + LIKE フォールバック）

- 3 文字以上のクエリは `snippets_fts` の MATCH（trigram tokenizer）を使用
- 1〜2 文字のクエリは trigram の最小単位を満たせないため、`title` / `content` / `tags_cache` に対する LIKE フォールバック検索を行う
- どちらの経路も同じソート順・フィルタ条件で集計され、UI からは透過的に同一のリストとして見える

---

## C. フィルタバー

### ソースフィルタ（ピル型、排他選択）

| フィルタ | 条件 |
|---------|------|
| All | 全スニペット（デフォルト） |
| From chat | `source_chat_message_id` が非NULL |
| From editor | `source_chat_message_id` がNULL かつ `source_scene_id` が非NULL |
| Manual | `source_chat_message_id` がNULL かつ `source_scene_id` がNULL |

### contentSource カラムとの関係

`content_source` カラムは `"human" | "ai" | null` の3値を取り、「どこから来たテキストか」を示す。

| 値 | 意味 |
|---|---|
| `"ai"` | Chat の AI メッセージから抽出されたテキスト |
| `"human"` | Editor 本文（人間が書いた領域）から抽出されたテキスト |
| `null` | 手動作成（[+] ボタン、クリップボード貼付など原文に帰属情報がない場合） |

ソースフィルタは `content_source` の値と `source_chat_message_id` / `source_scene_id` の有無を組み合わせて判定する。ソースバッジの [AI] / [Human] 表示も `content_source` を参照する。

### タグフィルタ

- 検索バーの下にタグクラウド（使用頻度順、上位10個）を表示するオプション（パネルメニューからON/OFF）
- タグクリックでそのタグを持つスニペットのみ表示

### 構造化タグ（Codex 共通 TagSelector）

Snippet のタグは Codex と同じ構造化タグ基盤の上に載る。UI は Codex と共通の `TagSelector` コンポーネントを使用し、同一プロジェクト内でタグ名の補完・再利用ができる。

- タグ本体は `tags` テーブル（Codex と共有）に格納される
- Snippet とタグの関連は `snippet_entry_tags` 多対多テーブルで管理
- `snippets.tags_cache` は検索・表示を高速化するためのデノーマライズキャッシュ（カンマ区切り文字列）で、真のソース・オブ・トゥルースは `snippet_entry_tags` リレーション
- `tags_cache` は FTS5 のインデックス対象に含まれ、LIKE フォールバック検索でも走査される
- 旧設計の「`tags` カラムにカンマ区切り TEXT / JSON 配列を直接保存する」方式は廃止

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

各スニペットはドラッグ可能なカードとして表示。カード右上には**ホバー時のみ**「Copy」ボタンと「×」ボタンが表示される。Copy ボタンはスニペット本文をクリップボードに書き出す際、Grimodex 固有の MIME タイプ（`application/x-grimodex-attribution` 等）を併用して帰属情報（AuthorshipMark）を他パネルへ伝搬する。

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
| クリック | 右の詳細ペインにスニペットを表示 |
| ドラッグ（→ Editor） | エディタのカーソル位置にスニペット内容を挿入 |
| ダブルクリック | コンテンツ全文をクリップボードにコピー |
| 右クリック | コンテキストメニュー（後述） |
| ホバー | 軽いハイライト + × ボタン表示 |

### E. 詳細ペイン（Detail pane）

リストでカードをクリックすると、右の詳細ペインにフル編集モードで表示される。

```
┌──────────────────────────────────────────────────┐
│ Snippet詳細         [💾][📋][↗][📄][🗑] [Insert] │
├──────────────────────────────────────────────────┤
│ タイトル                                          │
│ [A jolt of recognition surges...]                │  ← 編集可能
│                                                  │
│ 内容                                              │
│ ┌──────────────────────────────────────────────┐ │
│ │ A jolt of recognition surges through         │ │
│ │ her fingertips — not pain, but a deep        │ │  ← TipTapミニエディタ
│ │ resonance, as if the stone remembers         │ │
│ │ her from another lifetime.                   │ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ タグ                                              │
│ [dialogue, elara]                                │  ← 編集可能
│                                                  │
│ [AI]                                             │  ← ソースバッジ
│ 抽出元チャット: Character deep-dive →             │
│ 関連シーン: The tower →                           │
│ 作成日: 2026-04-10 14:32                          │
│ 使用回数: 2                                       │
└──────────────────────────────────────────────────┘
```

#### ツールバーボタン

| ボタン | 詳細 |
|--------|------|
| 保存 (💾) | 即時保存（自動保存のflush）。自動保存（デバウンス2秒）が有効なため通常は不要 |
| コピー (📋) | コンテンツをクリップボードにコピー（Attribution付き） |
| Open in Editor (↗) | エディタパネルにSnippetタブとして開き、インラインAIやChat連携が利用可能 |
| 関連シーン (📄) | `scene_id` がある場合のみ表示。クリックでEditorで開く |
| 削除 (🗑) | 削除確認ダイアログ |
| Insert at cursor | エディタのカーソル位置に挿入。D&Dの代替手段 |

#### フィールド

| フィールド | 詳細 |
|-----------|------|
| Title | 編集可能な入力フィールド |
| Content | TipTapミニエディタ。Markdown記法をリアルタイムにリッチテキストとしてレンダリング（太字、斜体、見出し、リスト、リンク対応）。DBの `snippets.content` カラムに保存。自動保存（デバウンス2秒）。**Attribution追跡あり**（後述） |
| Tags | 構造化タグ。Codex と共通の TagSelector コンポーネントを使用し、候補のサジェストと新規タグ作成に対応 |
| ソースバッジ | [AI]: パープルのピル / [Human]: グレーのピル / バッジなし: 手動作成 |
| Source | `source_chat_message_id` がある場合、セッション名のリンク。クリックでChat Historyパネル経由で元セッションを開く |
| Scene | `scene_id` がある場合、シーン名のリンク。クリックでEditorで開く |
| Created | 作成日時 |
| Used | エディタに挿入された回数（`usage_count`） |

スニペット未選択時は「Snippetを選択してください」のプレースホルダーを表示。

### Attribution追跡

エディタ本文と同じAuthorshipMark体系をSnippet contentに適用する。ミニエディタとエディタタブの両方でAuthorship付与が機能する。

**付与ルール**:
- キーボード入力 → `{ source: 'human' }`
- Chatから「Snippet」ボタンで保存されたcontent → `{ source: 'ai', model, chatMessageId }`
- Editorから「Save as Snippet」で保存されたcontent → 元テキストのAuthorshipMarkを継承
- インラインAI（エディタタブ）でAccept → `{ source: 'ai', model }`
- アプリ内ペースト（エディタ、Chat、他のCodex/Snippet等からコピー）→ 元テキストのAuthorshipMarkを継承（Editorパネル設計書「クリップボードのAuthorship伝搬」参照）
- 外部ペースト（AuthorshipMark情報なし）→ `{ source: 'unknown' }`
- `ai` マーク付きテキストの編集 → `ai` のまま維持

**永続化**: `authorship_spans` テーブルに `snippet_id` を指定して保存（統合DBスキーマ参照）。
ただし現時点の実装範囲では、`SnippetDetailContent` のミニエディタは AuthorshipMark 拡張と `useAttribution` フックを組み込み済みで編集中の帰属表示は機能するが、`authorship_spans.snippet_id` への永続化経路は今後整備予定。永続化が入るまでは、Snippet の帰属はミニエディタ内の ProseMirror マークおよび `content_source` カラムにのみ保持される。

**表示**: AttributionHighlight（背景色ハイライト）はエディタタブ・ミニエディタの両方で表示可能（Attr表示トグル連動）

### snippetDiff による部分帰属計算

Snippet をエディタへ挿入するとき、「AI 由来の Snippet をユーザーが Snippet 詳細ペインで手直ししてから挿入した」というケースで帰属情報を正しく分割する必要がある。

このため挿入時には `computeAttributedSegments` が走り、以下を行う:

1. Snippet の**原文**（`content` に記録された AI 由来のテキスト）と、挿入直前の**現在本文**の diff を取る
2. 変更のないセグメントは元の `source`（多くは `ai`）を維持
3. 変更・追加されたセグメントは `source: human` に上書きする

結果として、AI 由来マークと human マークが段落内で混在した AuthorshipMark 列が生成され、エディタ側の帰属ハイライトにそのまま反映される。

---

## Snippet タブ（エディタで開く）

詳細ペインの「Open in Editor (↗)」ボタンから、Snippet を Editor パネルのタブとして開くことができる。Snippet タブは通常のシーンタブと同じ TipTap フルエディタで、インライン AI・Chat 連携・コマンドパレットなどが利用可能。

- タブの識別子は `contentType: "snippet"` と Snippet ID の組
- 本文の編集内容は通常の自動保存サイクルで `snippets.content` カラムに書き戻される
- Snippetsパネルの詳細ペインとエディタタブのどちらからでも同じ Snippet を編集できる（ストア経由でリアルタイム同期）
- AuthorshipMark・帰属ハイライト・`useAttribution` フックはエディタタブ側でも同様に動作する

---

## スニペットの作成

### 1. Chatパネルから（Chat設計書で定義済み）

Chat からの作成は **Quick 保存** と **Detailed 保存** の2系統を提供する。

#### Quick 保存（即時作成）

- AIメッセージの「Snippet」ボタン → メッセージ全文（またはテキスト選択範囲）を即時保存
- トースト通知「Saved as Snippet」
- `source_chat_message_id` が自動付与
- `source_scene_id` はChatのアクティブシーンが設定される
- `content_source = "ai"`

#### Detailed 保存（SnippetExtractionDialog）

- AI メッセージのコンテキストメニューまたはモディファイヤ付きクリックで **SnippetExtractionDialog** を開く
- ダイアログでは以下をまとめて指定できる:
  - タイトル（デフォルトは選択テキストの先頭から生成）
  - タグ（TagSelector。Codex 共通 UI）
  - `contentSource`（`ai` / `human` / 未設定）
  - 必要に応じて本文のトリミング
- 保存ボタンで Snippet を作成し、Quick 保存と同じく `source_chat_message_id` と `source_scene_id` を付与

#### extractedSnippets の追跡

Chat から Snippet を作成すると（Quick / Detailed いずれでも）、該当する `chat_messages.metadata.extractedSnippets` 配列に新規 Snippet の ID が追加される。Chat パネルはこのリストを参照して「このメッセージからは既に Snippet が抽出されている」ことを示すバッジを表示する。

#### 作成直後の自動選択

Snippet 作成後、Snippetsパネル側では `snippetStore.pendingEntryId` に新規 ID がセットされ、`requestSelectEntry` を介して Snippetsパネルがそのエントリを自動選択・スクロールインする。ユーザーは作成直後のスニペットをそのまま編集できる。

### 2. Editorから（Editor設計書で定義済み）

- コンテキストメニュー「Save as Snippet」→ 選択テキストを即時保存
- トースト通知「Saved as Snippet: "{タイトル}"」。トースト内「Edit」リンクでSnippetsパネルの展開表示へ
- `source_chat_message_id` はNULL
- `scene_id` はEditorのアクティブシーンが設定される

### 3. Snippetsパネルから（手動作成）

- ヘッダーの [+] ボタン → 空のスニペットを作成し、詳細ペインに表示
- 詳細ペインのタイトルフィールドにフォーカスが当たり、即時入力可能
- `source_chat_message_id` と `scene_id` はどちらもNULL

### 4. クリップボードから

- Snippetsパネルにフォーカスがある状態で `Ctrl+V` → クリップボードのテキストからスニペットを作成
- タイトルは先頭30文字を自動生成
- `content_source` は NULL（手動作成扱い）。ただしクリップボードに Grimodex 固有 MIME で AuthorshipMark 情報が含まれる場合はそれを継承する

### 楽観的更新と再フェッチ

Snippet の `create` 呼び出しは楽観的更新で扱う。ストア側は `isLoading` 中であっても新しいエントリを即座にリストへ差し込み、詳細ペインを新規エントリに切り替える。バックグラウンドで `listSnippets` を再実行して結果を正規のソース・オブ・トゥルースで差し替えることで、サーバー側の自動フィールド付与（timestamps 等）とのレースコンディションを吸収する。

---

## エディタへの挿入

### D&D挿入

- スニペットカードをドラッグ開始 → ドラッグプレビュー（スニペットタイトルを表示する小さなフローティングカード）
- ドラッグ開始時に DataTransfer へ2つの MIME をセットする:
  - `application/x-grimodex-snippet`: Snippet ID とシリアライズ済み AuthorshipMark を含む内部形式。Grimodex 内のドロップ先（Editor 等）はこちらを優先的に読む
  - `text/plain`: プレーンテキストフォールバック。外部アプリへのドロップ時に使用される
- EditorのCenter領域にドラッグ → ドロップ位置にカーソルインジケーター表示
- ドロップ → カーソル位置にスニペットのcontentを挿入

挿入時のAuthorship:
- 元 Snippet の AuthorshipMark を継承しつつ `computeAttributedSegments` により部分帰属を再計算（前述「snippetDiff による部分帰属計算」を参照）
- 結果として生成された AuthorshipMark を挿入範囲に付与する
- 参考: 単純化した場合のバッジ単位マッピング
  - スニペットのソースバッジが [AI] → `{ source: 'ai', chatMessageId: snippet.source_chat_message_id }`
  - スニペットのソースバッジが [Human] または手動作成 → `{ source: 'human' }`

挿入後:
- `snippets.usage_count` を +1
- エディタで挿入箇所を**3秒**の一時ハイライト（パープル背景、フェードアウト）を表示

### コンテキストメニュー挿入（Editor設計書で定義済み）

- Editorのコンテキストメニュー「Insert from Snippet...」→ コマンドパレット風の検索UIでスニペットを選択 → カーソル位置に挿入
- 検索UIではタイトルとコンテンツのプレビューを表示
- 選択すると即挿入（D&Dと同じAuthorship処理）

### 詳細ペインの [Insert at cursor] ボタン

- Snippetsパネルの詳細ペインで「Insert at cursor」クリック → Editorのカーソル位置に挿入
- D&Dが不便な場合（パネルとEditorが離れている等）の代替

---

## コンテキストメニュー

スニペットカードの右クリック:

| メニュー項目 | 動作 |
|-------------|------|
| Insert at cursor | エディタのカーソル位置に挿入 |
| Copy content | コンテンツをクリップボードにコピー |
| Edit | 詳細ペインで編集モード |
| --- | |
| Duplicate | スニペットを複製（「{title} (copy)」） |
| Go to source chat | `source_chat_message_id` がある場合のみ表示。Chat Historyで元セッションを開く |
| Go to scene | `scene_id` がある場合のみ表示。Editorでそのシーンを開く |
| **Add to Map ▸** | **サブメニュー: 各 Map ボード名を一覧表示。選択でこの Snippet を Map に Snippet ノードとして配置（手動キュレーション、Map パネル設計書「手動キュレーション」参照）** |
| --- | |
| Delete | 確認ダイアログ後に削除 |

---

## グリッドレイアウト

左ペインのスニペットリスト内で、ペイン幅に応じてカードを複数カラムで表示する。

| 左ペイン幅 | カラム数 | カード幅 |
|-----------|---------|---------|
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
  content                 TEXT NOT NULL DEFAULT '{}',  -- ProseMirror JSON
  tags_cache              TEXT,                               -- 検索・表示用のカンマ区切りデノーマライズキャッシュ
  source_scene_id         TEXT REFERENCES tree_nodes(id),     -- 作成元シーン（nullable）
  source_chat_message_id  TEXT REFERENCES chat_messages(id),  -- 抽出元チャット（nullable）
  content_source          TEXT,                               -- 'ai' | 'human' | NULL（ソース追跡）
  usage_count             INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_snippets_project ON snippets(project_id, created_at DESC);

-- Snippet と Tag の多対多リレーション（Codex と共有の tags テーブルを参照）
CREATE TABLE snippet_entry_tags (
  snippet_id TEXT NOT NULL REFERENCES snippets(id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (snippet_id, tag_id)
);

CREATE INDEX idx_snippet_entry_tags_tag ON snippet_entry_tags(tag_id);

-- 全文検索用FTS5（title、content、tags_cacheを検索対象）
CREATE VIRTUAL TABLE snippets_fts USING fts5(
  title,
  content,
  tags_cache,
  content=snippets,
  content_rowid=rowid,
  tokenize='trigram'
);

-- FTS5同期トリガー
CREATE TRIGGER snippets_fts_ai AFTER INSERT ON snippets BEGIN
  INSERT INTO snippets_fts(rowid, title, content, tags_cache)
    VALUES (new.rowid, new.title, new.content, new.tags_cache);
END;

CREATE TRIGGER snippets_fts_ad AFTER DELETE ON snippets BEGIN
  INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags_cache)
    VALUES ('delete', old.rowid, old.title, old.content, old.tags_cache);
END;

CREATE TRIGGER snippets_fts_au AFTER UPDATE ON snippets BEGIN
  INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags_cache)
    VALUES ('delete', old.rowid, old.title, old.content, old.tags_cache);
  INSERT INTO snippets_fts(rowid, title, content, tags_cache)
    VALUES (new.rowid, new.title, new.content, new.tags_cache);
END;
```

Snippetのcontentは `snippets.content` カラムにProseMirror JSON形式で保存する（TipTapミニエディタで編集されるため、エディタ本文と同じ保存形式を採用）。

**タグの役割分担**:
- タグ本体は Codex と共有の `tags` テーブル、Snippet との関連は `snippet_entry_tags` 多対多テーブルが真のソース・オブ・トゥルース
- `snippets.tags_cache` は FTS5 検索・一覧表示・LIKE フォールバックで使うためのデノーマライズキャッシュ（カンマ区切り文字列）
- タグ編集時には `snippet_entry_tags` を更新したのち `tags_cache` を再計算して書き戻す

**FTS5 の検索対象**: title、content、`tags_cache` を含める。3 文字以上は MATCH、1〜2 文字は LIKE フォールバック（title / content / `tags_cache` を走査）。

`content_source` はスニペットの作成元（ai/human/NULL）を記録し、ソースバッジの表示・ソースフィルタ・Attribution 追跡に使用する。`source_scene_id` は「作成元シーン」、`source_chat_message_id` は「抽出元チャットメッセージ」を指す。

---

## キーボードショートカット

### Snippetsパネルにフォーカス時

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Alt+N` | Snippetsパネルのトグル（表示/非表示）兼、既に開いている場合は新規 Snippet 作成（レイアウト設計書で定義済み） |
| `Ctrl+F`（パネルフォーカス時） | 検索バーにフォーカス |
| `↑` / `↓` | スニペットカード間のフォーカス移動 |
| `Enter` | 選択スニペットを詳細ペインに表示 / 表示中なら選択解除 |
| `Ctrl+Enter` | 選択スニペットをEditorのカーソル位置に挿入 |
| `Ctrl+V` | クリップボードから新規スニペット作成 |
| `Del` | 選択スニペットを削除（確認ダイアログ） |
| `Escape` | 検索クリア / 選択解除 |

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
- 詳細ペインの「Insert at cursor」ボタン

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
| 構造 | name + type + summary + content + aliases + relations | title + content |
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

AIメッセージの「Snippet」ボタン押下時の即時保存フロー、`source_chat_message_id` 記録、`chat_messages.metadata.extractedSnippets` への追加はChat設計書の記載を正とする。Quick 保存 / Detailed 保存（SnippetExtractionDialog）の2系統と、作成直後に `snippetStore.pendingEntryId` → `requestSelectEntry` 経由で Snippetsパネルが新規エントリを自動選択する遷移も Chat → Snippets の連携に含まれる。

### Attribution設計書

AuthorshipMark の付与ルール、クリップボード MIME (`application/x-grimodex-snippet` / Grimodex 固有 Attribution MIME) による帰属伝搬、`computeAttributedSegments` による diff ベースの部分帰属計算は Attribution 設計書の記載を正とする。Snippet 側では特に、挿入時の diff 計算と Copy ボタン・D&D の両経路での帰属伝搬がこれに依存する。

### Editorパネル設計書（Snippet タブ）

Snippet は Editor パネル上で `contentType: "snippet"` のタブとして開かれる。タブ内は通常のシーンタブと同じフルエディタ機能を持ち、編集結果は `snippets.content` に書き戻される。タブ開閉・復元ロジックは Editor パネル設計書のタブシステムに従う。

### Chat Historyパネル設計書

セッションカードのSnippet抽出バッジ（アンバーのピル）。Chat Historyのフィルタ「Has extractions」にSnippet抽出も含まれる。
