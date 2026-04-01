# Grimodex Scenesパネル設計書

## 概要

Scenesパネルはプロジェクトの構造を管理するツリービューパネル。本編のPart/Chapter/Scene階層に加え、Scrivener式のFolder/Noteノードで取材メモや設定資料もプロジェクト内に一元管理する。パネル下部にはCodex Quickセクションを内蔵し、現在のシーンに関連するCodexエントリを常時表示する。

デフォルト位置: Left Dock（表示状態）

---

## ツリー階層モデル

### ノードタイプ一覧

| ノードタイプ | 種別 | TipTapドキュメント | 子ノードを持てるか | エクスポート対象 |
|-------------|------|-------------------|-------------------|----------------|
| Project | ルート | なし | Yes | 全体のルート |
| Part | コンテナ | なし | Yes（Chapter, Part） | Yes（見出し） |
| Chapter | コンテナ | なし | Yes（Scene） | Yes（見出し） |
| Scene | リーフ | **あり** | No | Yes（本文） |
| Folder | コンテナ | なし | Yes（Note, Folder） | No |
| Note | リーフ | **あり** | No | No |

### 階層ルール

```
Project（ルート、UIには非表示）
├── Part: 第一部 黎明篇
│   ├── Chapter: 第1章 覚醒
│   │   ├── Scene: 塔の麓
│   │   ├── Scene: 最初の呪文
│   │   └── Scene: 見知らぬ男
│   └── Chapter: 第2章 降下
│       ├── Scene: 地下通路
│       └── Scene: 封印の間
├── Part: 第二部 黄昏篇
│   └── Chapter: 第3章 再会
│       └── Scene: 市場にて
├── Chapter: エピローグ          ← Part に属さない Chapter も可
│   └── Scene: 旅立ち
└── Folder: 資料
    ├── Note: 世界観メモ
    ├── Note: 年表
    └── Folder: キャラクター設定
        ├── Note: エララ設定
        └── Note: 塔の歴史
```

### 階層の制約

- **Scene** は必ず **Chapter** の直下に置く。Part直下やFolder内には置けない。
- **Chapter** は **Part** の直下、または **Project** の直下に置ける。Folder内には置けない。
- **Part** は **Project** の直下にのみ置ける。ネストは不可。
- **Note** は **Folder** の直下にのみ置ける。本編ツリー（Part/Chapter）には置けない。
- **Folder** は **Project** の直下、または別の **Folder** の中に置ける（ネスト可）。
- Part の使用は任意。Chapter を Project 直下に置けば2階層構成（Chapter → Scene）になる。

---

## ノードの表示情報

### Sceneノード

```
[●] Scene title                    [34%] 1,247
 ↑                                  ↑     ↑
 ステータスドット                   AI%   文字数
```

| 要素 | 表示条件 | 詳細 |
|------|---------|------|
| ステータスドット | 常時 | 色でシーン状態を示す（後述） |
| タイトル | 常時 | インライン編集可能（F2 / ダブルクリック遅延） |
| AI帰属バッジ | Settings「帰属表示」ON時のみ | AI生成テキストの割合。ピル型バッジ |
| 文字数 | 常時（パネルメニューでOFF可） | 右寄せ。0の場合はグレーアウト |

アクティブシーン（Editorで開いているシーン）は左ボーダー + 背景ハイライトで強調。

### Chapter / Partノード

```
[▼] ■ Part title                      12,340
[▼] □ Chapter title                    2,340
```

| 要素 | 表示条件 | 詳細 |
|------|---------|------|
| 折りたたみシェブロン | 常時 | ▶（折りたたみ）/ ▼（展開） |
| アイコン | 常時 | Part: 塗りアイコン ■、Chapter: 線アイコン □ で階層を区別 |
| タイトル | 常時 | インライン編集可能 |
| 合計文字数 | 常時 | 配下の全Sceneの文字数合計。右寄せ |

### Folder / Noteノード

```
[▼] 📁 Folder title
     📝 Note title                     832
```

| 要素 | 表示条件 | 詳細 |
|------|---------|------|
| アイコン | 常時 | Teal系の色で本編ツリーと視覚的に区別 |
| タイトル | 常時 | インライン編集可能 |
| 文字数 | Noteのみ | 右寄せ |

Folder/Noteセクションは本編ツリーの下部にセパレーターで区切って表示する。

---

## シーンのステータス

### ステータス定義

| ステータス | ドット色 | 意味 | 典型的な使い方 |
|----------|---------|------|--------------|
| Outline | グレー (#888780) | プロットメモのみ、本文未着手 | アウトライン作成フェーズ |
| Draft | アンバー (#EF9F27) | 執筆中、初稿未完 | 初稿執筆フェーズ |
| Complete | グリーン (#1D9E75) | 初稿完了 | 一通り書き終わった |
| Revision | パープル (#7F77DD) | 推敲・改稿中 | 赤入れ・リライト中 |
| Final | チェックマーク (✓) | 完成稿 | これ以上手を入れない |

### ステータスの変更方法

- ステータスドットをクリック → ポップオーバーで5つの選択肢を表示
- コンテキストメニュー →「Set status」サブメニュー
- コマンドパレット（`Ctrl+Shift+P`）→「Set scene status」

### ステータスの自動遷移（任意、Settingsでon/off）

- 空のシーンにテキストを入力開始 → Outline → Draft に自動遷移
- その他の自動遷移はなし（ユーザーの明示的な操作を尊重）

---

## パネルツールバー

```
┌────────────────────────────────────────┐
│ Scenes                   [+] [⊞] [⋮] │
│ [🔍 Filter...                       ] │
└────────────────────────────────────────┘
```

### ボタン一覧

**[+] 新規作成ボタン**
クリックでドロップダウンメニューを表示:
- New scene — 選択中のChapter内、選択中のノードの下に挿入
- New chapter — 選択中のPart内（またはProject直下）に挿入
- New part — Project直下に挿入
- ---（セパレーター）
- New folder — Project直下に挿入
- New note — 選択中のFolder内に挿入

挿入位置のルール:
- ノード未選択時はツリー末尾に追加
- Scene選択時に「New scene」→ その直下（同じChapter内の次の位置）
- Chapter選択時に「New scene」→ そのChapterの末尾子要素として
- Chapter選択時に「New chapter」→ そのChapterの直下の兄弟として

**[⊞] 展開/折りたたみトグル**
- 全展開 → 全折りたたみ → 全展開 のトグル

**[⋮] パネルメニュー**
- Sort by: Manual (default) / Title (A→Z) / Word count / Status
- Show: Word counts ✓ / AI attribution ✓ / Status dots ✓
- Filter by status: All ✓ / Outline / Draft / Complete / Revision / Final
- ---
- Expand all
- Collapse all
- ---
- Compile project...

### フィルター入力欄

- 入力開始でインクリメンタル検索（タイトルの部分一致）
- マッチしたノードと、ルートまでの祖先パスを表示（非マッチの兄弟は非表示）
- フィルタ中はノードの折りたたみ状態を無視して全マッチを展開表示
- `Esc` でフィルタクリア
- `Ctrl+F`（Scenesパネルにフォーカス時）でフィルタ入力欄にフォーカス

---

## コンテキストメニュー

### Sceneノードの右クリック

| メニュー項目 | ショートカット | 動作 |
|-------------|-------------|------|
| Open in new tab | `Enter` | Editorに固定タブとして開く |
| Open to the side | `Ctrl+Enter` | 新しいEditor Groupにスプリットして開く |
| --- | | |
| Set status | ▶ | サブメニュー: Outline / Draft / Complete / Revision / Final |
| --- | | |
| Rename | `F2` | タイトルをインライン編集モードにする |
| Duplicate | | 同じChapter内に「{title} (copy)」として複製 |
| Move to... | ▶ | サブメニュー: Chapter一覧を表示、選択先に移動 |
| --- | | |
| Add scene below | | 同じChapter内、このシーンの直後に新規Scene |
| Add chapter above | | このシーンの親Chapterの直前に新規Chapter |
| --- | | |
| Copy as Markdown | | シーン本文をMarkdownとしてクリップボードにコピー |
| Open in Chat | | Chatパネルをこのシーンのコンテキストで開く |
| --- | | |
| Delete | `Del` | 確認ダイアログ後に削除 |

### Chapter / Partノードの右クリック

| メニュー項目 | ショートカット | 動作 |
|-------------|-------------|------|
| Rename | `F2` | タイトルをインライン編集モードにする |
| Duplicate with children | | 配下のScene含め全て複製 |
| Move to... | ▶ | Chapterの場合: Part一覧、Partの場合: 順序変更 |
| --- | | |
| Add scene inside | | このコンテナの末尾子要素として新規Scene |
| Add chapter inside | | Partの場合: 末尾にChapter追加 |
| Add part above | | このノードの直前にPart追加 |
| --- | | |
| Expand all children | | 配下を全展開 |
| Collapse all children | | 配下を全折りたたみ |
| --- | | |
| Compile this chapter... | | このChapter/Part以下をMarkdownエクスポート |
| --- | | |
| Delete | `Del` | 確認ダイアログ（配下のScene数を表示）後に削除 |

### Folder / Noteノードの右クリック

| メニュー項目 | 動作 |
|-------------|------|
| Open in new tab | Noteのみ。Editorにタブとして開く |
| Rename | タイトルをインライン編集 |
| Duplicate | 複製 |
| --- | |
| Add note inside | Folderのみ。末尾にNote追加 |
| Add folder inside | Folderのみ。末尾にサブFolder追加 |
| --- | |
| Delete | 確認ダイアログ後に削除 |

### 空エリアの右クリック

| メニュー項目 | 動作 |
|-------------|------|
| New scene | ツリー末尾のChapterの末尾に追加（Chapterがなければ先にChapter作成） |
| New chapter | Project直下（またはPart末尾）に追加 |
| New part | Project直下に追加 |
| New folder | Project直下に追加 |
| --- | |
| Expand all | 全展開 |
| Collapse all | 全折りたたみ |
| --- | |
| Compile project... | プロジェクト全体のエクスポート |

---

## ドラッグ & ドロップ

### ライブラリ

`@dnd-kit/core` + `@dnd-kit/sortable` を使用。

### D&Dルール

| ドラッグ元 | 許可されるドロップ先 | 不可なドロップ先 |
|----------|-------------------|----------------|
| Scene | 同じChapter内（順序変更）、別のChapter内（移動） | Part直下、Folder内、Project直下 |
| Chapter | 同じPart内（順序変更）、別のPart内（移動）、Project直下（Part未使用時） | Folder内、別のChapter内 |
| Part | Project直下（順序変更） | 他のPart内、Folder内 |
| Note | 同じFolder内（順序変更）、別のFolder内（移動） | 本編ツリー（Part/Chapter内） |
| Folder | Project直下（順序変更）、別のFolder内（移動） | 本編ツリー内 |

### ドロップインジケーター

- **ノード間の青い水平線** → 「この位置に挿入」
- **ノード上の背景ハイライト** → 「このコンテナの中に入れる」（コンテナノードの場合のみ）
- **禁止カーソル** → 許可されないドロップ先

### 複数選択D&D

- `Ctrl+Click` で個別追加選択
- `Shift+Click` で範囲選択
- 複数選択したノードをまとめてドラッグ可能
- 制約: 異なるノードタイプ（SceneとChapter等）の混在選択は不可。同一タイプかつ同一親のノードのみ複数選択可能

### Editorへのドラッグ

- ツリーのSceneノードまたはNoteノードをEditorのCenter領域にドラッグ → Editorタブとして開く
- Editor Groupのタブバーにドロップ → そのGroupにタブ追加
- Editor Groupのエッジにドロップ → 新しいGroupとしてスプリット

---

## Editorとの連携

### シーンを開く操作

| 操作 | Editorでの振る舞い | タブの扱い |
|------|-------------------|----------|
| シングルクリック | プレビューモードで開く | タブタイトルが *斜体* 。別ノードをクリックすると上書きされる |
| ダブルクリック | 固定タブとして開く | タブタイトルが通常表示。明示的に閉じるまで残る |
| Enter | 固定タブとして開く | ダブルクリックと同じ |
| Ctrl+Enter | 新しいEditor Groupに開く | 固定タブ。スプリット先にフォーカス移動 |

### プレビューモード

VS Codeの「Preview Editor」と同じ概念。

- ツリーを↑↓キーで素早くブラウズする際に、各シーンの内容をチラ見できる
- プレビュータブは1つのEditor Groupにつき最大1つ
- プレビュー中のタブをダブルクリック、または内容の編集を開始すると、固定タブに昇格する
- 別のシーンをシングルクリックすると、既存のプレビュータブが上書きされる

### NoteをEditorで開く

NoteノードもSceneと同じくTipTapドキュメントを持つため、Editorタブで開ける。Attribution追跡・Codexハイライトも適用される。ただし以下の点が異なる:

- Editorのタブタイトルに「📝」アイコンを付けてSceneと区別
- エクスポート対象外であることを示す薄いバナーをエディタ上部に表示
- 文字数目標・シーンステータスは不可

### アクティブシーンの同期

Editorでアクティブなタブが変わると、Scenesパネルが連動する:

- アクティブシーンのノードが自動的にツリー内で選択状態になる
- 必要に応じて親ノードが自動展開され、アクティブシーンが見える位置にスクロール
- Codex Quickセクションが新しいシーンの関連エントリに更新される
- この自動追従はパネルメニューの「Auto-reveal active scene」でon/off可能

---

## Codex Quickセクション

### 概要

Scenesパネルの下部に折りたたみ可能なセクションとして内蔵。現在Editorでアクティブなシーンに関連するCodexエントリを自動表示する。

```
┌─────────────────────────────────────┐
│ ▼ Scenes tree                       │
│   ...                               │
│                                     │
├─────────────────────────────────────┤
│ ▼ Codex quick                       │
│   ● Elara (protagonist)     character│
│   ● The Obsidian Tower       location│
│   ● Soulbind Amulet             item│
│                                     │
│   [+ Pin codex entry]              │
└─────────────────────────────────────┘
```

### 表示ルール

- エディタ本文中に出現するCodexエントリ名を自動検出し、一覧表示
- 各エントリの左にカテゴリ別カラードット（Character: パープル、Location: ティール、Item: アンバー、Lore: コーラル）
- 各エントリの右にカテゴリラベル（小さいテキスト）
- 手動で「ピン留め」したCodexエントリも表示（自動検出に漏れた場合の補完）

### インタラクション

| 操作 | 動作 |
|------|------|
| エントリをクリック | Codexパネルでそのエントリの詳細を開く（Codexパネルが閉じていればデフォルト位置に開く） |
| エントリをホバー | ポップオーバーでCodexエントリのプレビュー（名前、カテゴリ、要約の先頭100文字） |
| [+ Pin codex entry] | コマンドパレット風の検索UIでCodexエントリを選択し、ピン留め |
| ピン留めエントリの右の × | ピン留め解除 |
| セクションヘッダーの ▶/▼ | セクション自体の折りたたみ/展開 |

### データフロー

```
Editor active scene changed
  → シーンの本文テキストを取得
  → Codexエントリ名のマッチング（FTS5 or 正規表現）
  → マッチ結果 + 手動ピン留めを結合
  → Codex Quickセクションを更新
```

このマッチングはエディタ内のCodexハイライト（Pure Decorations）と同じデータソースを使う。二重計算を避けるため、Zustandストアの `sceneCodexMatches` を共有する。

### 折りたたみ状態の永続化

Codex Quickセクションの折りたたみ状態はレイアウト永続化の一部として保存される。ツリー部分とCodex Quickの間の境界線はリサイズ可能（ドラッグで上下に移動）で、その比率も保存する。

---

## キーボードナビゲーション

Scenesパネルにフォーカスがある時のキーバインド:

| キー | 動作 |
|------|------|
| `↑` / `↓` | 前/次のノードに移動（折りたたまれた子はスキップ） |
| `←` | 展開されたコンテナ → 折りたたむ。リーフまたは折りたたみ済み → 親ノードに移動 |
| `→` | 折りたたまれたコンテナ → 展開する。展開済み → 最初の子ノードに移動 |
| `Enter` | Sceneの場合: 固定タブとして開く。コンテナの場合: 展開/折りたたみトグル |
| `Space` | Sceneの場合: プレビューモードで開く |
| `F2` | 選択中のノードの名前をインライン編集 |
| `Del` / `Backspace` | 選択中のノードを削除（確認ダイアログ） |
| `Ctrl+F` | フィルタ入力欄にフォーカス |
| `Escape` | フィルタ入力欄からフォーカスを外す / フィルタクリア |
| `Ctrl+Enter` | Sceneの場合: 新しいEditor Groupに開く |

---

## DBスキーマへの影響

現行の `projects → chapters → scenes` の3テーブル構成を、汎用ツリー構造に変更する。

### 新スキーマ案

```sql
CREATE TABLE tree_nodes (
  id          TEXT PRIMARY KEY,     -- UUID
  project_id  TEXT NOT NULL REFERENCES projects(id),
  parent_id   TEXT REFERENCES tree_nodes(id), -- NULL = Project直下
  node_type   TEXT NOT NULL,        -- 'part' | 'chapter' | 'scene' | 'folder' | 'note'
  title       TEXT NOT NULL DEFAULT 'Untitled',
  sort_order  REAL NOT NULL,        -- 浮動小数点で挿入時の再ソートを回避
  status      TEXT DEFAULT 'outline', -- Sceneのみ使用: 'outline'|'draft'|'complete'|'revision'|'final'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tree_parent ON tree_nodes(project_id, parent_id, sort_order);
```

### sort_order の戦略

Fractional Indexing（浮動小数点ソート）を採用。

- 初期ノード: 1.0, 2.0, 3.0, ...
- ノードAとBの間に挿入: (A.sort_order + B.sort_order) / 2
- 先頭に挿入: 最小値 - 1.0
- 末尾に挿入: 最大値 + 1.0
- 精度劣化が累積した場合（一定間隔以下になった場合）、兄弟ノードの sort_order を再割り当て

### 本文の保存

Scene と Note のみ本文を持つ。保存先は `content/` ディレクトリ。ファイル命名規則はEditorパネル設計書を参照。

- Scene: `{pp}-{cc}-{ss}_{sanitized_title}_{short_id}.md`（例: `01-03-02_最初の呪文_a3f8.md`）
- Note: `note_{sanitized_title}_{short_id}.md`（例: `note_世界観メモ_f9a0.md`）

タイトル変更・順序変更時はファイル名を自動リネームする。

### 階層制約の検証

DB側ではCHECK制約での階層ルール強制は複雑になるため、アプリケーション層（Zustandストアの操作関数）でバリデーションする。

```typescript
// 挿入時のバリデーション例
function canInsertChild(parent: TreeNode | null, childType: NodeType): boolean {
  if (childType === 'scene') return parent?.node_type === 'chapter';
  if (childType === 'chapter') return parent?.node_type === 'part' || parent === null;
  if (childType === 'part') return parent === null;
  if (childType === 'note') return parent?.node_type === 'folder';
  if (childType === 'folder') return parent === null || parent?.node_type === 'folder';
  return false;
}
```

---

## 既存設計書との整合

### レイアウトシステム設計書の更新箇所

パネル一覧の Scenes の説明を以下に変更:

> Scenes | Left Dock | 表示 | プロジェクトのPart/Chapter/Sceneツリー + Folder/Note + Codex Quickセクション

### 開発ワークフローへの影響

- タスク1.2（チャプター/シーンのカスタムノード）のスコープを拡大: Part, Folder, Note ノードタイプを含める
- タスク2.1（SQLiteスキーマ）を `tree_nodes` テーブルベースに変更
- タスク2.2（D&D並べ替え）にノードタイプ別のドロップ制約ロジックを追加
