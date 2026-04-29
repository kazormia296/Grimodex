# Grimodex Editorパネル設計書

## 概要

EditorパネルはGrimodexの中核コンポーネント。TipTapベースのリッチテキストエディタで、小説の執筆・編集を行う。Center Dockに常駐し、Editor Groupモデル（レイアウト設計書で定義済み）により複数シーンのマルチタブ・スプリット編集が可能。

2つの編集モードを持つ:
- **通常モード**: 1タブ=1シーンの単独編集。スプリットビューで2シーンの同時編集も可能
- **リニア編集モード**: プロジェクト内の全シーンを`sortOrder`順に縦に並べ、1つのスクロールビューで通し読み・通し書きが可能

エディタは上から5つの領域で構成される: タブバー、ブレッドクラム、ツールバー、エディタキャンバス、ステータスバー。

---

## エディタの構造

```
┌──────────────────────────────────────────────────────┐
│ A. Tab bar                                            │
│ [*Scene 1: The tower* ×] [Scene 3 ×]    [⊞] [×]     │
├──────────────────────────────────────────────────────┤
│ B. Breadcrumb                                         │
│ Part 1  /  Chapter 1: Awakening  /  The tower         │
├──────────────────────────────────────────────────────┤
│ C. Toolbar                                            │
│ B I U S ﹅ │ H1 H2 H3 │ ≡ 1. " — │ Ruby Link │ [Attr] [Cmt] [Focus] [TW] │ ⋮ │
├──────────────────────────────────────────────────────┤
│ C-4. Synopsis / Summary（Scene・Codexのみ表示）        │
│ › Synopsis  What happens in this scene?...  [✦ Gen] │
├──────────────────────────────────────────────────────┤
│ D. Editor canvas (TipTap)                             │
│                                                       │
│   The tower                                           │
│   ─────────────────────────────────────────────────  │
│   ┃  Elara stood at the base of the Obsidian Tower,  │
│   ┃  her fingers tracing the cold stone...            │
│   │                                                   │
│      She reached for the Soulbind Amulet around her  │
│      neck. It hummed in response to the tower's      │
│      magic, warm against her skin...                  │
│                                                       │
│   ┃ = AI attribution marker (purple left border)     │
│   Codex entity names = colored text (category color)  │
│                                                       │
├──────────────────────────────────────────────────────┤
│ E. Status bar                                         │
│ Draft       AI: 34%  │  1,247 chars  │  Saved  │  History  │
└──────────────────────────────────────────────────────┘
```

---

## A. タブバー

### タブの種類

**プレビュータブ（斜体タイトル）**
- Scenesパネルでシングルクリックしたシーンが表示される
- 1つのEditor Groupにつき最大1つ
- 別のシーンをシングルクリックすると上書きされる
- 内容を編集開始すると固定タブに自動昇格

**固定タブ（通常タイトル）**
- ダブルクリック、Enter、Ctrl+Enterで開いたシーン
- 明示的に閉じるまで残る

**Codex/Snippetタブ**
- CodexエントリまたはSnippetのcontentをエディタの全機能（インラインAI、CodexHighlight、Attribution追跡）で編集できる
- Codexパネルの詳細画面「Open in Editor」ボタン、またはSnippetの展開表示「Open in Editor」ボタンで開く
- タブアイコンで区別: Codexは該当typeのカラードット、Snippetは🗂アイコン
- タブタイトル: Codexは「{エントリ名}」、Snippetは「{Snippet title}」
- エディタ上部にバナー表示: Codexは「Editing Codex entry — changes are saved to {type}: {name}」（typeカラードット付き）、Snippetは「Editing Snippet — changes are saved to Snippets」
- 保存先は既存のCodex/SnippetのDBレコード（contentカラム）
- プレビュータブとして開く動作は無し（常に固定タブ）
- **Chat連携**: Codex/Snippetタブがアクティブの場合、Chatパネルのコンテキスト（Layer 3）にはCodex/Snippetのcontent全文が注入される。ヘッダーの表示は「Codex: {エントリ名}」または「Snippet: {title}」に切り替わる

### タブの表示要素

```
[● Scene 1: The tower  ●  ×]
 ↑                      ↑  ↑
 同期バッジ              未保存  閉じる
 (別Groupで同じ          (変更時は ● )
  シーンが開いている)     (保存済みは × )
```

- **タイトル**: シーン名。Noteの場合は先頭に📝アイコン
- **同期編集バッジ**: 同じシーンが別のEditor Groupでも開かれている場合、タイトル左に小さなドット
- **未保存インジケーター**: 未保存の変更がある場合、×ボタンが●（ドット）に変わる。ホバーで×に戻る
- **プレビュー表示**: プレビュータブはタイトルが斜体

### タブバー右端のアクション

- **リニアモードボタン（`ScrollText`アイコン）**: リニア編集モードのON/OFF。Primary Groupのみ表示。ONの場合はアクティブ背景色（`bg-accent`）で状態表示。詳細は「リニア編集モード」セクション参照
- **スプリットボタン**: アクティブシーンを右に分割（新しいEditor Groupを作成）。リニアモード中は非表示
- **Groupを閉じるボタン**: このEditor Group内の全タブを閉じてGroupを削除（最後のGroupでは非表示）

### タブの操作

- タブをGroup内でドラッグ → 順序変更
- タブを別のGroupのタブバーにドラッグ → そのGroupに移動
- タブをGroupのエッジにドラッグ → 新しいGroupとしてスプリット
- タブをCenter外にドラッグ → フローティングエディタウィンドウ
- 中クリック（ホイールクリック） → タブを閉じる
- ダブルクリック（プレビュータブ）→ 固定タブに昇格

### タブ切り替えショートカット

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Tab` | アクティブグループの次のタブに移動（末尾から先頭へ循環） |
| `Ctrl+Shift+Tab` | アクティブグループの前のタブに移動（先頭から末尾へ循環） |

Split mode時はキーボードフォーカスを持つグループ（`activeGroupIndex`）のタブが対象になる。タブが1枚しかない場合は何もしない。

### タブのコンテキストメニュー

タブを右クリックすると以下のコンテキストメニューが表示される。

| メニュー項目    | 動作                             | 条件             |
| --------- | ------------------------------ | -------------- |
| 閉じる       | このタブを閉じる                       | —              |
| 他を閉じる     | このタブ以外の同一Group内タブをすべて閉じる       | Group内タブ2個以上   |
| 右を閉じる     | このタブより右のタブをすべて閉じる              | 右にタブがある場合      |
| 左を閉じる     | このタブより左のタブをすべて閉じる              | 左にタブがある場合      |
| すべて閉じる    | このGroup内の全タブを閉じる               | —              |
| ───       | セパレーター                         | —              |
| タブを固定する   | プレビュータブを固定タブに昇格                | プレビュータブのみ表示    |
| ───       | セパレーター                         | —              |
| 右に分割      | このタブを新しいEditor Groupとして右にスプリット | —              |
| 下に分割      | このタブを新しいEditor Groupとして下にスプリット | —              |
| ───       | セパレーター                         | —              |
| Scenesで表示 | Scenesパネルで対象ノードをハイライト・スクロール    | Scene/Noteタブのみ |


**未保存タブの閉じる操作:** 「閉じる」「他を閉じる」「右/左を閉じる」「すべて閉じる」で未保存の変更があるタブが対象に含まれる場合、確認ダイアログを表示する。複数タブの場合は「N個のタブに未保存の変更があります。保存しますか？」と表示し、「すべて保存して閉じる / 保存せず閉じる / キャンセル」の3択を提示する。

### タブ状態の永続化

開いているタブの状態はワークスペースDBの app_settings テーブルに永続化され、次回起動時に復元される。

**保存対象:**

| 項目 | 説明 |
|------|------|
| タブ一覧 | 各タブの nodeId とプレビュー/固定の区別 |
| アクティブタブ | プライマリ/セカンダリ各グループのアクティブタブID |
| セカンダリグループ | スプリット時の第2グループのタブ一覧 |
| フォーカスグループ | どちらのグループがキーボードフォーカスを持つか |
| リニアモード | リニア編集モードのON/OFF |

**保存タイミング:** タブ状態の変更のたびに 500ms デバウンスで自動保存。

**復元タイミング:** ツリー読み込み完了後。削除済みシーンを参照するタブは復元時にフィルタアウトされる。

**保存先:** ワークスペースDB `app_settings` テーブル（キー: `editor.tabState`）。タブ状態はプロジェクト固有のため、レイアウト（`global-settings.json`）とは異なりワークスペース内に保存する。

---

## B. ブレッドクラム

### 表示内容

現在のシーンのツリー上の位置パスを表示する。

```
Part 1: 黎明篇  /  Chapter 1: 覚醒  /  塔の麓
```

Partが未使用のプロジェクトでは:

```
Chapter 1: 覚醒  /  塔の麓
```

Noteの場合:

```
資料  /  キャラクター設定  /  エララ設定
```

### インタラクション

各セグメントはクリック可能。クリックするとそのレベルの兄弟ノード一覧をドロップダウンで表示し、選択するとそのシーン/チャプターに移動する。

- **Sceneセグメント（末尾）をクリック** → 同じChapter内のScene一覧を表示
- **Chapterセグメントをクリック** → 同じPart内のChapter一覧を表示
- **Partセグメントをクリック** → プロジェクト内のPart一覧を表示

これにより、Scenesパネルを開かずにツリー内をナビゲートできる。

### 表示/非表示

ブレッドクラムはツールバーのオーバーフローメニューから非表示にできる。狭い画面では省略記号（...）で中間パスを省略。

---

## C. ツールバー

### ボタングループ

ツールバーはセパレーター（`|`）で区切られたグループで構成される。

#### グループ1: インラインフォーマット

| ボタン | 動作 | ショートカット |
|--------|------|-------------|
| **B** | 太字 | `Ctrl+B` |
| *I* | 斜体 | `Ctrl+I` |
| U | 下線 | `Ctrl+U` |
| ~~S~~ | 取り消し線 | `Ctrl+Shift+X` |
| ﹅ | 傍点（圏点） | `Ctrl+.` |

#### グループ2: ブロックフォーマット

| ボタン | 動作 | ショートカット |
|--------|------|-------------|
| H1 | 見出し1 | `Ctrl+1` |
| H2 | 見出し2 | `Ctrl+2` |
| H3 | 見出し3 | `Ctrl+3` |

#### グループ3: リスト・引用

| ボタン | 動作 |
|--------|------|
| ≡ (Bullet) | 箇条書きリスト |
| 1. (Ordered) | 番号付きリスト |
| " (Quote) | ブロック引用 |
| — (Divider) | 水平線 |

#### グループ4: 小説固有

| ボタン | 動作 | ショートカット | 詳細 |
|--------|------|-------------|------|
| Ruby | ルビ付与 | `Ctrl+Shift+R` | テキスト選択中のみ有効。ダイアログでふりがな入力 |
| Link | リンク挿入 | `Ctrl+K` | |
| Scene break | シーン区切り | | ※ オーバーフローに移動してもよい。`* * *` を挿入する専用ブロック |

#### グループ5: ビュートグル（右寄せ）

| ボタン | 動作 | 状態 |
|--------|------|------|
| Aa | フォントサイズ調整 | ポップオーバーで本文フォントサイズを即時変更。値は Settings の `editor.fontSize` に直結し、全タブ・全 Group に即時反映される |
| Attr | Attribution表示トグル | ON: AI帰属マーカー表示、OFF: 非表示 |
| Cmt | コメント表示トグル | ON: コメント付きテキストの波線下線+ホバーポップオーバー表示、OFF: 非表示（コメントデータは保持） |
| Focus | フォーカスモードトグル | ON: 現在の段落以外を半透明化 |
| TW | タイプライターモードトグル | ON: カーソル行を常に垂直中央に固定 |

Attr / Cmt / Focus / TW の 4 つは独立したトグルで、組み合わせ可能。Aa はトグルではなくポップオーバー入口。

#### オーバーフローメニュー（⋮）

| メニュー項目 | ショートカット | 詳細 |
|-------------|-------------|------|
| Find & Replace | `Ctrl+H` | エディタ上部にオーバーレイ表示 |
| Word count goal... | | 目標文字数を設定するダイアログ |
| Vertical preview | | 縦書きプレビューパネルを開く |
| Show breadcrumb | | ブレッドクラムの表示/非表示 |
| Show line numbers | | 行番号の表示/非表示 |

---

## C-4. Synopsis / Summary（概要欄）

ツールバーとエディタキャンバスの間に配置される折りたたみ可能な概要入力欄。
**タブの種類によって表示・ラベルが異なる。**

| タブ種類 | 表示 | ラベル |
|---------|------|--------|
| Scene | 表示する | **Synopsis** |
| Codex | 表示する | **Summary** |
| Snippet | **表示しない** | — |
| Note | 表示しない | — |

### 表示仕様

- ヘッダー行（クリックで折りたたみ/展開）と本文テキストエリアで構成
- **折りたたみ状態**: ヘッダー行のみ表示。シェブロン（›）アイコン + ラベル（"Synopsis" / "Summary"）。内容が入力済みの場合は先頭テキストをイタリック・省略表示
- **展開状態**: テキストエリアを表示（rows=3）。入力可能

### Synopsis（Scene）

- **ラベル**: "Synopsis"
- **データ**: `TreeNodeData.synopsis`（`tree` テーブルの synopsis カラム）
- **自動保存**: 入力から 1,000ms のデバウンス後に `updateSynopsis()` で保存
- **AI生成ボタン（✦ Generate）**:
  - 押下時、シーン本文（`loadSceneContent()`）をもとに `generateSynopsisFromContent()` を呼び出し
  - 既存の Synopsis がある場合は上書き確認ダイアログを表示
  - 本文が空の場合は警告トーストを表示してキャンセル
  - 生成成功時は "Synopsisを生成しました" トースト

### Summary（Codex）

- **ラベル**: "Summary"
- **データ**: `CodexEntry.summary`（`codex_entries` テーブルの summary カラム）
- **自動保存**: 入力から 1,000ms のデバウンス後に保存
- **AI生成ボタン（✦ Generate）**:
  - 押下時、Codexエントリの `content` をもとに Summary を生成
  - 既存の Summary がある場合は上書き確認ダイアログを表示
  - `content` が空の場合は警告トーストを表示してキャンセル
  - 生成成功時は "Summaryを生成しました" トースト

### 実装ファイル

- `src/features/editor/SynopsisHeader.tsx` — 折りたたみヘッダー（Scene限定ガード済み: `nodeType !== "scene"` で null return）
- `src/features/tree/SynopsisArea.tsx` — テキストエリア本体（同様に Scene 限定ガード済み）

---

## D. エディタキャンバス

### D-0. タイトル見出し

エディタキャンバスの最上部（本文の前）に、現在開いているシーン/Codex/Snippetの名前を見出しとして表示する。

#### 表示仕様

- 本文フォントを継承しつつ、フォントサイズは本文の **1.6倍**
- 薄いボーダー（`border-border/40`）で本文と区切る
- 色は `text-content-foreground/60`（本文よりやや薄め）
- タイトルが空文字の場合は非表示

| タブ種類 | 表示テキスト |
|---------|------------|
| Scene / Note | `TreeNode.title` |
| Codex | `CodexEntry.name` |
| Snippet | `Snippet.title` |

#### インライン編集

- **編集開始**: タイトルをクリック、またはフォーカス後 `Enter` / `F2` キー
- **編集中**: インライン `<input>` に切り替わり、`autoFocus` でフォーカス済み。スタイルは表示時と同一（フォントファミリー・サイズを継承、背景透明）
- **保存**: `Enter` またはフォーカスアウト（Blur）で確定。空文字の場合は変更前の名前を維持
- **キャンセル**: `Escape` で変更破棄、編集前の名前に戻る
- **保存先**:
  - Scene / Note → `treeStore.updateNodeTitle(id, title)`
  - Codex → `codexStore.update(id, { name })`
  - Snippet → `snippetStore.update(id, { title })`

---

### TipTap構成

#### ベースキット

**StarterKit**（以下を含む）:
- Nodes: Document, Paragraph, Text, Heading (1-3), BulletList, OrderedList, ListItem, Blockquote, CodeBlock, HardBreak, HorizontalRule
- Marks: Bold, Italic, Strike, Code
- Extensions: History (undo/redo), Gapcursor, Dropcursor

#### 追加の公式拡張

| 拡張 | 用途 |
|------|------|
| Underline | 下線マーク |
| Link | ハイパーリンク |
| Placeholder | 空エディタ時のプレースホルダーテキスト |
| CharacterCount | 文字数・単語数カウント |
| Typography | スマートクォート等の自動変換 |
| Focus | フォーカスクラスの付与（FocusDim Decorationの基盤） |
| Table / TableRow / TableHeader / TableCell | 表組の編集。公式 Table 一式を登録しておき、Markdown インポートやペースト経由の表復元に対応する。Toolbar には露出せず、内部的に挿入・編集できる状態に留める |

#### サードパーティ拡張

| 拡張 | 用途 |
|------|------|
| tiptap-markdown | Markdownインポート/エクスポート（保存時には使用しない） |

#### カスタムノード

**RubyNode（インラインノード）**

```html
<ruby>漢字<rp>(</rp><rt>ふりがな</rt><rp>)</rp></ruby>
```

- TipTap `Node.create()` でインラインノードとして定義
- attrs: `{ text: string, ruby: string }`
- Markdownエクスポート時は `{漢字|ふりがな}` 形式に変換
- ショートカットまたはツールバーボタンでルビ付与ダイアログを表示
- ダイアログ: ベーステキスト（選択テキストから自動入力） + ルビテキスト入力欄

**SceneBreakNode（ブロックノード）**

```html
<div class="scene-break">* * *</div>
```

- シーン内の場面転換を示す区切り
- Markdownエクスポート時は `\n* * *\n` に変換
- ツールバーボタンまたはオーバーフローメニューから挿入
- CSSでセンタリング + 上下マージン

#### カスタムマーク

**AuthorshipMark**

```typescript
Mark.create({
  name: 'authorship',
  addAttributes() {
    return {
      source: { default: 'unknown' },       // 'human' | 'ai' | 'unknown'
      model: { default: null },              // 'claude-sonnet-4.6' etc.
      timestamp: { default: null },          // ISO 8601
      chatMessageId: { default: null },      // 抽出元チャットメッセージへの参照
      traceId: { default: null },            // Agent Trace v0.1.0 の trace ID（AI生成の再現性トラッキング用）
      toolName: { default: null },           // 生成に使用したツール識別子（'chat-insert' / 'inline-ai' / 'snippet' など）
      toolVersion: { default: null },        // ツール側のバージョン（スキーマ変更に備えた互換判定用）
      manualOverride: { default: false },    // ユーザーが AttributionOverrideMenu で手動変更したスパンかどうか
      originalLength: { default: null },     // 付与時点のスパン長。後続編集による縮退度の推定に使用
    }
  },
})
```

`traceId` / `toolName` / `toolVersion` は Agent Trace v0.1.0 連携のための拡張属性で、AI による生成の出処をスパン単位で追跡する目的を持つ。`manualOverride` と `originalLength` は AttributionOverrideMenu によるユーザー上書き、および AiEditedPlugin による human 化の挙動と合わせて帰属の変遷を追える状態を保つ。

付与ルール:
- キーボード入力 → `{ source: 'human' }`
- AIチャットからの「挿入」→ `{ source: 'ai', model, chatMessageId }`（エージェントが既存humanテキストを取得・再構成して提示した場合も、原文とAI生成部分の実態的な帰属の判別がつかないため `ai` とする）
- インラインAIでAccept → `{ source: 'ai', model }`
- SnippetのD&D挿入 → 元Snippetのsourceを継承
- `ai` / `unknown` スパン内にユーザーが文字を挿入 → **挿入テキストのみ human 化**される（AiEditedPlugin の挙動。後述「AiEditedPlugin」参照）。既存スパンはスプリットされつつ元の属性を維持する
- `ai` / `unknown` スパン内のテキストを削除しただけの場合 → 残存部分は元の `source` を維持する
- **アプリ内ペースト** → 元テキストのAuthorshipMarkを継承（後述「クリップボードのAuthorship伝搬」参照）
- **外部ペースト**（AuthorshipMark情報なし）、マイグレーション前のテキスト、AuthorshipMark未付与のテキスト → `{ source: 'unknown' }`

3つのsourceの定義:
- `human`: ユーザーがキーボードで直接入力したテキスト
- `ai`: AIが生成したテキスト（人間が編集しても変わらない）
- `unknown`: 出自が追跡できないテキスト（外部ペースト、既存プロジェクトのインポート、マイグレーション前のデータ等）

**EmphasisDotsMark（傍点・圏点）**

日本語小説で頻出する強調表現。文字の上（横書き）または右（縦書き）にドット（﹅）を付与する。

```typescript
Mark.create({
  name: 'emphasisDots',
  // 属性なし（ON/OFFのみ）
})
```

- CSS `text-emphasis: filled sesame` で描画。縦書きプレビューでも正しく表示される
- ツールバーボタン（﹅）またはショートカット `Ctrl+.` でトグル
- Markdownエクスポート時は `《圏点:テキスト》` 形式に変換（小説投稿サイトの慣例に準拠）
- インポート時は `《圏点:テキスト》` パターンを検出してEmphasisDotsMarkに変換

**CommentMark（インラインコメント）**

執筆中の自分用メモ。テキストの特定範囲に紐づく非表示の注釈。エクスポート時に除外される。

```typescript
Mark.create({
  name: 'comment',
  addAttributes() {
    return {
      text: { default: '' },         // コメント本文
      createdAt: { default: null },  // ISO 8601
    }
  },
})
```

- コメント付きテキストはアンバーの波線下線で表示（`text-decoration: wavy underline`）
- ホバーでコメント内容をポップオーバー表示（編集・削除可能）
- ツールバーには配置しない。コンテキストメニューまたはショートカット `Ctrl+Shift+M` で追加
- コメント追加時: テキスト選択 → `Ctrl+Shift+M` → インラインでコメント入力欄が表示 → Enter で確定
- Markdownエクスポート時にはコメントを除外（クリーンなMarkdown）
- Find & Replaceの検索対象にはならない（コメントは本文ではない）

#### その他のカスタム拡張

本文編集体験を整える補助的な拡張。いずれも StarterKit + 上記カスタムノード／マークの挙動を補強する目的を持つ。

**ParagraphWithEmptyLineSupport**

- StarterKit の Paragraph を置き換える形で読み込み、空段落を `<p></p>` として HTML / ProseMirror JSON 双方に保持する
- Markdown ラウンドトリップ（エクスポート → インポート）で空行が潰れる問題を防ぐためのもので、Markdown シリアライズ時には空段落を改行のみの行として出力する
- 通常の入力フローには影響しない（空 Enter が連続した場合のみ差分が発生する）

**InlineAtomNavigationExtension**

- `Ctrl+Home` / `Ctrl+End` でドキュメント先頭 / 末尾へのジャンプを提供する
- Ruby のような inline-block な atom ノードを跨ぐとき、ProseMirror 既定のカーソル移動が不正な位置に吸着することがあるため、atom ノードを安全にスキップするように再実装する
- 選択範囲を保持した拡張（Shift 併用）は ProseMirror 既定の挙動に任せる

**ToolbarShortcutsExtension**

- StarterKit 既定の `Mod-Shift-s`（Strike）と `Mod-Alt-1` / `Mod-Alt-2` / `Mod-Alt-3`（Heading）に加えて、設計書のショートカット表通り `Mod-Shift-x`（Strike）と `Mod-1` / `Mod-2` / `Mod-3`（Heading 1/2/3）を別名バインドとして登録する
- 既定のバインドは撤去せず、両方のショートカットで同じコマンドが発火する
- Ruby / EmphasisDots / Comment のショートカットは各カスタムマーク側で定義し、本拡張は StarterKit のフォーマット系のみを対象とする

**SlashCommandExtension**

- エディタの **行頭または空行でのみ** `/` を入力するとインライン AI コマンドサジェスト（Slash メニュー）を起動する
- サジェスト候補: `continue` / `describe` / `dialogue` / `summarize` / `brainstorm` / `rewrite` / `translate`
- 行中での `/` 入力や、コードブロック / URL 内では発火しない（フォーマット入力として扱う）
- 選択後は既存のインライン AI パレットへ委譲し、以降の diff 表示 / Accept / Reject フローはインライン AI 側の仕様に従う（「インラインAIコマンド」セクション参照）

#### クリップボードのAuthorship伝搬

アプリ内のテキストコピー時にAuthorshipMarkをクリップボードに保持し、ペースト時に復元する。

**コピー元**: エディタ本文（Scene/Note/Codex/Snippet）、AIチャットメッセージ、Codexミニエディタ、Snippetミニエディタ

**仕組み**:
- コピー時にTipTapのクリップボードシリアライザを拡張し、通常の `text/plain` と `text/html` に加えてカスタムMIMEタイプ `application/x-grimodex-authorship`（マーカーは `data-grimodex-source`）にAuthorshipMarkのJSONを付与する
- ペースト時に `application/x-grimodex-authorship` が存在すればAuthorshipMarkを復元し、存在しなければ `{ source: 'unknown' }` を付与する
- AIチャットメッセージのコピー（「Copy」ボタンまたはテキスト選択コピー）時はメッセージ全体に `{ source: 'ai', model, chatMessageId }` を付与する

**例**: エディタで「人間が書いた文」と「AIが生成した文」を含むテキストをコピーし、別のシーンにペーストした場合、各範囲の `source` がそれぞれ `human` と `ai` として正しく復元される

**ペースト handler の 3 系統分岐**

ペーストイベントの処理は、クリップボード内の情報源に応じて 3 つに分岐する。いずれの系統でも、結果のスパンが `ai` / `unknown` の場合は AiEditedPlugin の対象になるため、プログラム的挿入を示す `programmaticInsert` meta をトランザクションに立てて誤検知を防ぐ。

- **Case 1: Grimodex 固有コピー**（`application/x-grimodex-authorship` / `data-grimodex-source` を含む）
  - 保存された AuthorshipMark をそのまま復元してペーストする
  - `programmaticInsert` meta を立てて AiEditedPlugin が human 化しないようにする
  - `ai` / `unknown` スパンのペースト結果もそのままの `source` で保持される

- **Case 2: ProseMirror 内部コピー**（`data-pm-slice` を含むが Grimodex 固有 MIME を含まない）
  - ProseMirror が既定で提供する slice を `replaceSelection` に直接渡す
  - `programmaticInsert` meta を立てて AiEditedPlugin の誤検知を避ける
  - **注記**: TipTap 本体のペーストバグ回避として用意しているパスで、TipTap upstream PR がマージされた時点で Case 2 の分岐は撤去し、Case 1 / Case 3 の 2 系統に統合する予定

- **Case 3: 外部テキスト**（平文のみ、Grimodex / ProseMirror いずれのマーカーも持たない）
  - プレーンテキストとして挿入し、範囲全体に `{ source: 'unknown' }` を付与する

#### AuthorshipMark のスパン操作ルール

以下はいずれもTipTap/ProseMirrorの組み込み動作であり、カスタム実装は不要。本セクションは動作の明示的な文書化を目的とする。

**挿入（Split）:** 既存のAuthorshipMarkスパン内にテキストを挿入した場合、挿入テキストには入力元に応じた新しいマークが付与される（`inclusive: false` 設定による）。既存スパンは挿入位置で2つに分割され、それぞれ元のマーク属性を維持する。

**マージ（Merge）:** 同一の `source`・`model`・`timestamp` 属性を持つ隣接AuthorshipMarkスパンは、ProseMirrorが自動的にマージする（Mark normalization）。属性が1つでも異なる場合はマージされない。

**削除（Delete）:** スパンの一部を削除した場合、残存部分は元のマーク属性を維持する。スパン全体が削除された場合、マークも消滅する。

Markdownエクスポート時には `tiptap-markdown` を使用し、AuthorshipMarkを除外したクリーンなMarkdownを出力する。

#### AiEditedPlugin（ai / unknown スパンの human 化）

ProseMirror プラグインとして実装され、`ai` または `unknown` スパンの内部にユーザーがキーボード入力でテキストを挿入した場合、**挿入されたテキスト範囲からのみ AuthorshipMark を剥がす**ことで human として扱い直す。既存スパンは挿入位置でスプリットされ、前後の範囲は元の `source` / `model` / `traceId` 等の属性を維持する。

副作用を避けるためのオプトアウト機構として、`programmaticInsert` meta を立てたトランザクションには一切作用しない。以下の挿入経路ではこの meta が立つ:

- クリップボードのペースト復元（Grimodex 固有 MIME の AuthorshipMark 情報を持つペースト）
- Snippet の D&D / 挿入によるスパン復元
- インライン AI / Chat Insert の Accept によるスパン付与
- Undo / Redo の再生（属性復元を阻害しないため）

これにより、AuthorshipMark を積極的に「付け直す」系の動作と「ユーザー入力で human 化する」系の動作を同一プラグインで両立する。

#### AttributionOverrideMenu（手動オーバーライド）

エディタ上で選択範囲を右クリックするとコンテキストメニューに「Attribution を変更」項目が表示され、`human` / `ai` / `unknown` の 3 値に手動で切り替えられる。変更時は:

- 選択範囲に対応するスパンの `source` を書き換え
- `manualOverride: true` を付与
- `timestamp` は変更時刻に更新（`model` 等は変更前の値を保持）

`manualOverride: true` のスパンは Attribution パネルやレポートで「手動上書き」としてマーク表示される想定で、本 Editor パネル側では通常の `source` と同じハイライト色を使う。

#### Pure Decorations（文書構造に影響しない装飾）

**CodexHighlight**
- エディタ本文中のCodexエントリ名を自動検出
- デフォルトスタイル: **文字色をカテゴリカラーに変更**（テキスト自体が色付きになる）
  - Character: パープル (#7F77DD)
  - Location: ティール (#1D9E75)
  - Item: アンバー (#BA7517)
  - Lore: コーラル (#D85A30)
- オプション: Settings > Display > Codex highlight style で「Underline」に切り替え可能。Underline選択時は文字色はそのまま、点線の下線をカテゴリカラーで表示
- ホバーでポップオーバー表示（名前、カテゴリ、要約100文字、「Open in Codex」リンク）。詳細は「Codexハイライトのホバーポップオーバー」セクション参照
- データソース: `useCodexHighlightStore.matchedEntryIds`（Codex Quickパネルと共有）
- **Codexタブ編集時**: 編集中のエントリ自身は除外（`excludeEntryIds`）してマッチングし、Codex Quickを更新する
- **Snippetタブ編集時**: Codex Quickは更新しない（`skipMatchedIds: true`）
- **Split mode時**: フォーカスグループ（`activeGroupIndex`）のエディタのみが Codex Quickを更新する。非フォーカスグループはハイライトは機能するが Codex Quickには影響しない

**AttributionHighlight**
- ツールバーの「Attr」トグルがON時のみ表示
- AuthorshipMarkの `source` に基づいてテキスト範囲全体に背景色ハイライトを適用:
  - `ai`: パープルの薄い背景 (rgba(127, 119, 221, 0.10))
  - `unknown`: アンバーの薄い背景 (rgba(186, 117, 23, 0.10))
  - `human`: ハイライトなし
- 背景色は執筆の邪魔にならない程度に薄く設定。Settings > Display > Attribution highlight opacity で調整可能（5% - 25%、デフォルト10%）
- ホバーで詳細ツールチップ（source, model名, timestamp）

**FocusDim**
- ツールバーの「Focus」トグルがON時のみ表示
- 現在カーソルがあるブロック（段落/見出し/リスト等）以外のブロックに `opacity: 0.3` を適用
- カーソル移動に追従

**LintDecorationPlugin**
- Linter 設計書で定義される Lint ルール違反を、本文中に波線デコレーションで可視化する ProseMirror プラグイン
- 色・波線スタイルは重要度（severity）に応じて切り替わる。ホバー時にルール名・違反内容・修正候補を示すツールチップ / 右サイドの Lint パネルと同期する（詳細な UI は Linter 設計書を参照）
- 本プラグインは **Scene タブかつ Primary Group** でのみ適用される。具体的な適用条件は `groupIndex === 0 && !isCodexMode && !isSnippetMode` を満たすエディタインスタンスに限る。Secondary Group / Codex タブ / Snippet タブ / Note タブでは Lint 下線は描画しない
- 適用対象外のエディタでも Lint 検査自体はバックグラウンドで走る余地を残すが、本 Editor パネルからは視覚フィードバックを提供しない
- ルール定義、severity 分類、修正提案、オートフィックスの仕様は Linter 設計書（`Grimodex_Linter設計書.md`）を正とする

### エディタキャンバスのスタイル

- 本文フォント: システムフォント（日本語環境では游明朝 or Noto Serif JPを推奨）
- フォントサイズ: 16px（Settingsで変更可能: 14px / 16px / 18px / 20px）
- 行間: 1.8（Settingsで変更可能: 1.5 / 1.8 / 2.0 / 2.2）
- 最大幅: 680px（本文領域）。エディタキャンバスの幅が広い場合はセンタリング
- 左右パディング: 40px
- 上パディング: 24px
- 段落字下げ: OFF（Settingsで変更可能: OFF / 1字 / 2字）。ONの場合、各段落の先頭に自動で全角スペース相当のインデントをCSS `text-indent` で付与する。本文データには全角スペースを挿入しない（表示上のみ）。Markdownエクスポート時は設定に関わらず字下げなし（投稿先の書式に委ねる）

### タイプライターモード

- ONの場合、カーソル行を常にエディタキャンバスの垂直中央に固定
- スクロールがカーソル追従になる（キー入力のたびにスクロール位置を調整）
- CSS `scroll-margin-block` または ProseMirror の `scrollIntoView` カスタマイズで実装
- カーソル上方・下方に十分なスクロール余白を確保（最低キャンバス高さの50%）

### Placeholder

エディタが空のとき、プレースホルダーテキストを表示:

- Scene: 「ここに本文を書き始めましょう...」
- Note: 「メモを書き始めましょう...」

### カーソルとテキストアニメーション

執筆体験をリッチにする4つのアニメーション効果。すべてデフォルトONで、Settings > Editor > Animations で個別にOFF可能。

**スムースキャレット**
- カーソル（キャレット）の移動にCSSトランジションを適用し、位置変更時にスムーズにスライドする
- `transition: left 80ms ease-out, top 80ms ease-out` 程度のアニメーション
- ProseMirrorのカーソル要素（`.ProseMirror-cursor`）にCSSトランジションを適用
- 矢印キー、クリック、Home/End等のカーソル移動すべてに適用

**カーソル点滅**
- デフォルトのブラウザキャレット点滅を無効化（`caret-color: transparent`）し、カスタムキャレット要素で置き換え
- `opacity` の `animation` で滑らかな点滅（硬いON/OFFではなくフェードイン/フェードアウト）
- 点滅サイクル: 1秒（表示500ms → フェード消灯500ms）
- 入力中は点滅を一時停止し、常時表示（最後のキー入力から500ms後に点滅再開）

```css
@keyframes cursor-blink {
  0%, 45% { opacity: 1; }
  55%, 100% { opacity: 0; }
}
.custom-cursor {
  animation: cursor-blink 1s ease-in-out infinite;
}
.custom-cursor.typing {
  animation: none;
  opacity: 1;
}
```

**文字のフェードイン（入力時）**
- 新しく入力された文字が `opacity: 0` → `opacity: 1` にフェードインして現れる
- `transition: opacity 120ms ease-out`
- ProseMirror Decorationsで直前に挿入された文字範囲に一時的なクラスを付与し、トランジション完了後にクラスを除去
- 日本語IME確定時にも適用（確定された文字列全体が一括フェードイン）
- ペースト時は適用しない（大量テキストのフェードインは重い）

**文字のフェードアウト（削除時）**
- 削除された文字がDOMから即座に消えるのではなく、`opacity: 1` → `opacity: 0` にフェードアウトしてから消える
- `transition: opacity 80ms ease-in`
- ProseMirrorの `appendTransaction` で削除トランザクションをインターセプトし、削除対象の文字にフェードアウトクラスを付与。トランジション完了後に実際のDOMノード削除を実行
- BackspaceとDeleteの単一文字削除に適用。範囲選択削除やカット（Ctrl+X）には適用しない（大量削除のアニメーションはUXを阻害）

**設定**

Settings > Editor > Animations セクション:

| フィールド | UI要素 | デフォルト |
|-----------|--------|-----------|
| Smooth caret | トグル | ON |
| Cursor blink | トグル | ON |
| Character fade-in | トグル | ON |
| Character fade-out | トグル | ON |

4つをまとめてOFFにする「Disable all animations」トグルも用意。

---

## E. ステータスバー

### 左側

| 表示項目     | 詳細                                                              |
| -------- | --------------------------------------------------------------- |
| ステータスバッジ | シーンのステータス（Outline/Draft/Complete/Revision/Final）。クリックで変更ポップオーバー |

### 右側（統計情報）

| 表示項目 | 詳細 |
|---------|------|
| `AI: {割合}%` | AI帰属割合。Attr表示ON時のみ表示。クリックでAttributionパネルを開く |
| `Beats: {総数} ({生成済}件 generated)` | Placed beat の総数と生成済み件数（Beat 設計書 Phase A）。Beat が0個の場合は非表示。クリックで Beats セクションをスクロール表示 |
| 文字数 | `{文字数} chars`。目標設定時はミニプログレスバーも表示。クリックで詳細統計ポップオーバー（文字数、単語数、原稿用紙枚数、推定読了時間） |
| 保存状態 | `Saved` / `Saving...` / `Unsaved`。Unsavedはアンバー色で警告 |
| History | `Clock` アイコンボタン。クリックでリビジョン履歴モーダルを開く（`Ctrl+Shift+H` と同等） |

### 文字数詳細ポップオーバー

文字数をクリックすると表示:

```
文字数:       1,247
単語数:         892
原稿用紙換算:   3.1枚（400字詰め）
推定読了時間:   約3分
───────────────────
目標: 2,000 chars [設定]
進捗: ████████░░ 62%
```

原稿用紙換算は日本語小説で特に重要な指標。

---

## リニア編集モード

### 概要

プロジェクト内の全シーンを`sortOrder`順に縦に並べ、1つのスクロールビューで連続編集できるモード。小説を通しで読み書きしたいときに使用する。タブバー右端の`ScrollText`アイコンでトグルする。

```
┌──────────────────────────────────────────────────────┐
│ Tab bar                              [📜 Linear] [⋮] │
├──────────────────────────────────────────────────────┤
│ Breadcrumb (activeSceneIdに自動追従)                   │
├──────────────────────────────────────────────────────┤
│ Toolbar (フォーカス中のエディタに連動)                    │
├──────────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────────┐   │
│ │  Scene 1: 塔の麓                                │   │
│ │  ──────────────────────────────────────────────│   │
│ │  エララは黒曜石の塔の前に立ち...                    │   │
│ │                                     1,247 chars│   │
│ ├────────────────────────────────────────────────┤   │
│ │  ── divider ──────────────────────────────────│   │
│ ├────────────────────────────────────────────────┤   │
│ │  Scene 2: 塔の内部                              │   │
│ │  ──────────────────────────────────────────────│   │
│ │  扉を押し開けると、冷気が頬を撫でた...               │   │
│ │                                       893 chars│   │
│ ├────────────────────────────────────────────────┤   │
│ │  ...（全シーンが続く）                             │   │
│ └────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

### 設計方針

- **独立TipTapインスタンスを維持**: 1つの巨大ドキュメントに結合しない。各シーンが独立したTipTapエディタを持ち、保存・Undo・帰属追跡はシーン単位で動作する
- **遅延マウント**: IntersectionObserverでビューポート近傍（上下200%）のシーンだけTipTapを生成。遠方のシーンはplaceholder divで高さを保持し、パフォーマンスを確保する
- **既存カスケードを活用**: `treeStore.setActiveScene(id)` による Chat連携・CodexQuick更新は既存の仕組みがそのまま機能する
- **Toolbarは共有**: フォーカス中のエディタに対して1つのToolbarが動作する（シーン数分のToolbarを並べない）

### モード切替

**リニアモード進入時:**
- スプリットビュー（Secondary Group）が開いている場合は自動で閉じる
- 切替前のアクティブシーンの位置まで自動スクロールする（コンテンツ読み込み完了後にResizeObserverで位置到達を検証）
- タブバーは通常通り表示。タブクリック時は対象シーンにスクロール

**リニアモード解除時:**
- 通常の単独編集モードに戻る。アクティブシーンのタブが表示される

### コンポーネント構成

| コンポーネント | ファイル | 役割 |
|-------------|--------|------|
| `LinearEditorView` | `src/features/editor/LinearEditorView.tsx` | スクロールコンテナ + IntersectionObserver + 共有Toolbar/FindReplace/CodexPopover/EditorContextMenu |
| `LinearSceneBlock` | `src/features/editor/LinearSceneBlock.tsx` | 各シーンの軽量エディタブロック（EditorPaneの簡略版） |
| `linearEditorStore` | `src/features/editor/linearEditorStore.ts` | フォーカス中のエディタ/シーンID/スクロール要求を管理 |

### LinearSceneBlock

EditorPaneからシーン編集に必要なロジックのみを抽出した軽量コンポーネント。

**含む機能:**
- `useEditor` + `getEditorExtensions()` でTipTap初期化
- `loadSceneContent()` / `saveSceneContent()` によるコンテンツ読み書き
- `useAutoSave` による自動保存
- `loadAuthorshipSpans()` / `saveAuthorshipSpans()` による帰属追跡
- `useAttribution()` フック
- `useCodexHighlight()` — アクティブシーンのみCodexQuickを更新（`skipMatchedIds`制御）
- シーンタイトル表示（読み取り専用）
- `ResizeObserver` による高さ測定 → 親に報告

**含まない機能（LinearEditorViewが共有管理または対象外）:**
- Toolbar, SynopsisHeader, FindReplaceBar, StatusBar
- InlineAI palette/toolbar
- CodexPopover, EditorContextMenu, AttributionOverrideMenu
- タブ関連ロジック（openPreview, pinTab等）
- VerticalPreview
- Split-view同期（sceneContentStoreのbroadcast）

### 遅延マウント

2つのIntersectionObserverを使用する。

**マウント判定用Observer:**
- `rootMargin: "200% 0px"` — ビューポートの上下2倍の範囲にあるシーンをマウント
- `isIntersecting` → TipTapエディタを生成、`!isIntersecting` → placeholderに戻す
- 安定したDOM要素（`data-scene-id`付きの外側div）を監視し、mount/unmount切替時にObserverがDOM要素を見失わない設計

**アクティブシーン検出用Observer:**
- `rootMargin: "0px"`, `threshold: [0, 0.5, 1.0]`
- 可視シーンのうち、スクロールコンテナ上端に最も近いシーンを検出
- デバウンス100msで `treeStore.setActiveScene(id)` を呼び出し
- `isScrollDetectionRef`フラグでスクロール検出と外部ナビゲーションを区別し、フィードバックループを防止

### 既存機能の挙動

| 機能 | リニアモードでの挙動 |
|------|---------------------|
| **Breadcrumb** | `activeSceneId` を監視しているので自動追従。変更不要 |
| **Chat連携** | `treeStore.activeSceneId` → `chatStore.activeSceneId` の既存同期で動作 |
| **CodexQuick** | アクティブシーンのエディタのみ `skipMatchedIds: false` で更新 |
| **Find & Replace** | フォーカス中のエディタ単体に対して動作（シーン単位検索） |
| **Split view** | リニアモード中は無効（トグル時にclose済み） |
| **Auto-save** | 各LinearSceneBlockが独自の`useAutoSave`。アンマウント時にflush |
| **タブ** | タブバーは通常通り表示。タブクリック → 対象シーンにスクロール |
| **Scenesパネルクリック** | `treeStore.activeSceneId` 変更 → LinearEditorViewがスクロール |
| **InlineAI** | 非対応（LinearSceneBlockに含まれない） |

### 実装ファイル

| ファイル | 変更内容 |
|---------|---------|
| `tabStore.ts` | `isLinearMode` state + `toggleLinearMode` action + 永続化 |
| `linearEditorStore.ts` | focusedEditor, focusedSceneId, pendingScrollToId を管理 |
| `LinearSceneBlock.tsx` | 各シーンの軽量エディタブロック |
| `LinearEditorView.tsx` | スクロールコンテナ + IntersectionObserver + 共有UI |
| `SceneEditor.tsx` | リニアモード時の条件分岐レンダリング |
| `TabBar.tsx` | トグルボタン追加、リニアモード時にスプリットボタン非表示 |

---

## エディタ内コンテキストメニュー

### テキスト選択時

| メニュー項目 | ショートカット | 詳細 |
|-------------|-------------|------|
| Cut | `Ctrl+X` | |
| Copy | `Ctrl+C` | |
| Paste | `Ctrl+V` | |
| --- | | |
| Set ruby... | | 選択テキストにルビを付与するダイアログ |
| Add comment | `Ctrl+Shift+M` | 選択範囲にインラインコメントを追加 |
| --- | | |
| Add to Codex | | 選択テキストをname としてCodexエントリを即時作成（後述） |
| Save as Snippet | | 選択テキストをSnippetとして即時保存（後述） |
| --- | | |
| Look up in Chat | | 選択テキストをChatパネルに送信して質問 |
| --- | | |
| Mark as ▶ | | 選択範囲のAuthorshipMarkのsourceを手動で上書きする。**Attribution表示（Attrトグル）がONの場合のみ表示**。サブメニューで `Human` / `AI` / `Unknown` を選択。現在のsourceと同じ項目はチェックマーク付きで表示（選択不可ではない） |
| --- | | |
| Select all | `Ctrl+A` | |

### テキスト非選択時

| メニュー項目 | ショートカット | 詳細 |
|-------------|-------------|------|
| Paste | `Ctrl+V` | |
| --- | | |
| Insert scene break | | カーソル位置にSceneBreakNodeを挿入 |
| Insert from Snippet... | | Snippet一覧から選択してカーソル位置に挿入 |
| --- | | |
| Select all | `Ctrl+A` | |

### Codexハイライトのホバーポップオーバー

エディタ本文中のCodexハイライト（カテゴリカラーの文字色）にマウスホバーすると、ポップオーバーを表示する。

```
┌─────────────────────────────────┐
│ Obsidian Tower           location│
│                                 │
│ The tower was erected during    │
│ the Age of Binding, roughly     │
│ 800 years before...             │
│                                 │
│              [Open in Codex →]  │
└─────────────────────────────────┘
```

| 要素 | 詳細 |
|------|------|
| アイコン + エントリ名 + カテゴリ | 左にアイコン（24×24px、未設定時はカテゴリドット）+ name、右にtypeラベル |
| サマリー | summaryフィールドの先頭100文字。未記入の場合はcontentの先頭100文字 |
| 「Open in Codex →」リンク | クリックでCodexパネルの詳細画面を開く。詳細画面で全フィールドの編集が可能 |

ポップオーバーは300msの遅延後に表示し、マウスがポップオーバー外に出ると300msの遅延後に消える（ポップオーバー内にマウスが移動した場合は維持）。

Codexハイライト上での右クリックは通常のテキスト選択時コンテキストメニューをそのまま表示する（特別なメニュー項目は追加しない）。

### 「Add to Codex」の動作（エディタ発）

エディタでテキストを選択し「Add to Codex」を実行すると、ダイアログなしでCodexエントリを即時作成する。

| フィールド | 自動生成値 |
|-----------|----------|
| name | **選択テキスト** |
| type | `character`（デフォルト） |
| summary | 空欄 |
| content | 空欄 |
| tags | 空 |

作成後の動作:
1. トースト通知「Added to Codex: "{name}"」を表示
2. トースト内に「Open」リンクがあり、クリックでCodexパネルの詳細画面を開く
3. 詳細画面でtype、summary、content、tagsを編集できる
4. エディタ本文中で、作成したエントリ名がCodexハイライト（カテゴリカラーの文字色）として即座に反映される

**既存エントリとの重複チェック**:
- 同名のCodexエントリが既に存在する場合、新規作成せずにトースト通知「"{name}" already exists in Codex」を表示
- トースト内の「Open」リンクで既存エントリの詳細画面を開く

### 「Save as Snippet」の動作（エディタ発）

エディタでテキストを選択し「Save as Snippet」を実行すると、ダイアログなしで即時保存する。

| フィールド | 自動生成値 |
|-----------|----------|
| title | 選択テキストの先頭30文字 |
| content | 選択テキスト全文 |
| scene_id | 現在のアクティブシーンのnode ID |
| source_chat_message_id | null（エディタ発のため） |
| tags | 空（後からSnippetsパネルで編集可能） |

保存後にトースト通知「Saved as Snippet: "{タイトル}"」を表示。トースト内に「Edit」リンクがあり、クリックでSnippetsパネルのエントリ編集画面を開く。

---

## Find & Replace

### 表示位置

エディタキャンバスの上部にオーバーレイバーとして表示。VS Codeスタイルの固定バー。

### 機能

| 機能 | ショートカット | 詳細 |
|------|-------------|------|
| 検索 | `Ctrl+F`（エディタフォーカス時） | 現在のシーン内をインクリメンタル検索 |
| 検索+置換 | `Ctrl+H` | 検索バーに置換フィールドを追加 |
| 次へ / 前へ | `Enter` / `Shift+Enter` | マッチ間を移動 |
| 全置換 | | 全マッチを一括置換 |
| 大文字小文字区別 | トグル | |
| 正規表現 | トグル | |
| 閉じる | `Escape` | |

### 全シーン横断検索

`Ctrl+Shift+F` またはコマンドパレットから「Find in all scenes」で、プロジェクト全体を検索するパネルを開く。結果はBottom Dockにリスト表示し、クリックで該当シーン・該当行にジャンプする。

---

## インラインAIコマンド

### 概要

エディタ内で直接AIを呼び出し、生成結果をカーソル位置にストリーミング挿入する機能。Chatパネルに切り替えずに執筆のフロー状態を維持できる。Chatパネルの `/command` が「会話の文脈でのAI支援」であるのに対し、インラインAIは「執筆の文脈でのワンショット生成」。

**Chatパネルとの違い**:

| 項目 | Chatパネルの /command | Editor内インラインAI |
|------|---------------------|-------------------|
| コンテキスト | 会話履歴 + シーン本文 | シーン本文 + カーソル周辺 + 選択テキスト |
| 結果表示 | Chatに表示 → Insert で挿入 | エディタ内にdiff表示 → Accept/Reject |
| 会話履歴 | セッションに残る | 残らない（ワンショット） |
| 用途 | ブレインストーミング、質問、長文生成 | 続き書き、書き直し、短い生成 |

### トリガー方法

2つのトリガーを提供する。

#### A. /コマンド入力（Notion AI式）

エディタ本文中で `/` を入力すると、インラインAIのオートコンプリートポップアップが表示される。

**発火条件**:
- 行頭で `/` を入力した場合
- 空行で `/` を入力した場合
- テキスト選択中に `/` を入力した場合

段落の途中（日本語テキスト内等）での `/` は通常の文字入力として扱い、オートコンプリートは表示しない。

**オートコンプリートポップアップ**:

```
┌─────────────────────────────┐
│ /continue                    │
│   Continue writing from here │
│ /rewrite                     │
│   Rewrite selected text      │
│ /describe                    │
│   Describe a person/place    │
│ /dialogue                    │
│   Write dialogue for...      │
│ /shorten                     │
│   Make text more concise     │
│ /expand                      │
│   Expand and add detail      │
│ /tone                        │
│   Change tone to...          │
│ /translate                   │
│   Translate to...            │
│ /custom                      │
│   Free-form instruction      │
└─────────────────────────────┘
```

- ↑/↓ で選択、`Enter` で確定、`Escape` でキャンセル
- 文字入力でフィルタ（`/con` → `/continue` にマッチ）
- コマンド確定後、引数が必要なもの（`/describe`、`/dialogue`、`/tone`、`/translate`）はインライン入力欄が表示される

**コマンド一覧**:

| コマンド | テキスト選択不要 | 引数 | 動作 |
|---------|----------------|------|------|
| `/continue` | Yes（カーソル位置から） | なし | カーソル位置から続きを生成 |
| `/rewrite` | 選択必須 | なし | 選択テキストを書き直し（置換diff） |
| `/describe` | どちらも可 | 対象名（例: `the tavern`） | 対象の描写を生成 |
| `/dialogue` | どちらも可 | キャラ名（例: `Elara`） | キャラクターの台詞を生成 |
| `/shorten` | 選択必須 | なし | 選択テキストを簡潔に書き直し（置換diff） |
| `/expand` | 選択必須 | なし | 選択テキストを詳細に膨らませて書き直し（置換diff） |
| `/tone` | 選択必須 | トーン名（例: `darker`, `humorous`） | トーンを変えて書き直し（置換diff） |
| `/translate` | 選択必須 | 言語名（例: `English`, `日本語`） | 選択テキストを翻訳（置換diff） |
| `/custom` | どちらも可 | 自由テキスト | 自由な指示で生成 |

#### B. Ctrl+Shift+Space パレット（Cursor式）

`Ctrl+Shift+Space` を押すと、カーソル位置の直下にインラインAIパレットが表示される。`Ctrl+Space` はIME（日本語入力）の変換候補トリガーと競合するため、`Ctrl+Shift+Space` を採用する。

```
┌─────────────────────────────────────┐
│ Inline AI              Ctrl+Shift+Space │
│ ┌─────────────────────────────────┐ │
│ │ Rewrite to be more atmospheric  │ │
│ └─────────────────────────────────┘ │
│                     Sonnet 4.6 [▶] │
└─────────────────────────────────────┘
```

- 自由テキスト入力欄 + 送信ボタン
- テキスト選択中に `Ctrl+Shift+Space` → 選択テキストが暗黙のコンテキストになる
- テキスト非選択で `Ctrl+Shift+Space` → カーソル位置からの生成（`/continue` と同等）
- `Enter` で送信、`Escape` で閉じる
- `/` で始めればコマンドオートコンプリートも使える（A方式との統合）

### 生成コンテキスト

インラインAIがLLMに送るコンテキストは、Chatパネルの5層注入のサブセット:

| レイヤー | 内容 | 含める |
|---------|------|--------|
| Project info | プロジェクト概要、文体ガイド | Yes |
| Chapter summaries | 直近N章の要約 | No（軽量化のため） |
| Current scene | 現在のシーン全文 | Yes |
| Codex entries | 自動検出 + ピン留め | Yes（summaryのみ） |
| Conversation history | チャットセッション | No（ワンショットのため） |

加えて、インラインAI固有のコンテキスト:

- **カーソル位置**: カーソル前後のテキスト（前500文字 + 後200文字程度）をマーキングしてLLMに渡す
- **選択テキスト**: テキスト選択中は選択範囲をマーキング
- **コマンド指示**: 実行するコマンドに応じたシステムプロンプト

### diff表示とAccept/Reject

#### 挿入モード（`/continue`, `/describe`, `/dialogue`）

カーソル位置にテキストが挿入される。挿入中のテキストは緑の背景色で表示。

```
Elara stood at the base of the tower.
[緑背景] The wind cut through her cloak as she craned
[緑背景] her neck to take in the full height of the
[緑背景] Obsidian Tower.█ (streaming...)

[Accept (Tab)] [Reject (Esc)] [Retry]     Sonnet 4.6
```

#### 置換モード（`/rewrite`, `/shorten`, `/expand`, `/tone`, `/translate`）

選択テキストが置換される。元テキストは赤の取り消し線、新テキストは緑の背景色。

```
[赤取消] Elara stood at the base of the tower.
[緑背景] The wind cut through Elara's cloak as she
[緑背景] craned her neck to take in the full height
[緑背景] of the Obsidian Tower.█ (streaming...)

[Accept (Tab)] [Reject (Esc)] [Retry]     Sonnet 4.6
```

#### diff表示の実装

ProseMirror Decorationsで実装。生成中のテキストは一時的なノードとして挿入され、Accept前はドキュメントの正規の内容ではない（Undoスタックには入らない）。

```typescript
// 生成中の状態
interface InlineAIState {
  status: 'idle' | 'streaming' | 'complete';
  mode: 'insert' | 'replace';
  originalRange?: { from: number; to: number };  // replace時の元テキスト範囲
  generatedText: string;                          // ストリーミング中に蓄積
  insertPos: number;                              // 挿入位置
}
```

#### Accept/Rejectツールバー

生成テキストの直下にフローティングツールバーを表示。

| ボタン | ショートカット | 動作 |
|--------|-------------|------|
| Accept | `Tab` | 生成テキストを確定。diff装飾を除去し、通常テキストとしてドキュメントにコミット。AuthorshipMark `{ source: 'ai' }` を付与。Undoで一括取り消し可能 |
| Reject | `Escape` | 生成テキストを破棄。元テキスト（replace時）を復元。何も変更されなかった状態に戻る |
| Retry | なし（ボタンのみ） | 生成テキストを破棄し、同じコマンドで再生成。ストリーミングが別の結果を返す |

ストリーミング中のショートカット:
- `Escape` → ストリーミングを中止し、受信済みテキストで停止。Accept/Rejectが可能な状態に
- ストリーミング中はエディタの他の部分への入力をブロック（フォーカスはdiff領域に固定）

### 複数回の生成（チェイン）

Acceptした直後に再度 `/` や `Ctrl+Shift+Space` を押せば、前の生成結果の続きにさらに生成を重ねられる。ただし各回は独立したUndoステップ。

### インラインAIと他機能の関係

**Chatパネルとの共存**:
- インラインAIはChatの会話履歴に残らない（ワンショット）
- 同じコマンド名（`/continue`、`/rewrite` 等）をChatとEditorで共有するが、実行コンテキストが異なる
- ChatパネルのLayer 4（Codexエントリ）はインラインAIでも参照する（作品の一貫性のため）

**Attribution追跡**:
- インラインAIで生成されAcceptされたテキストには `{ source: 'ai', model }` のAuthorshipMarkが付与される
- Rejectされたテキストは一切の痕跡を残さない

**自動保存**:
- ストリーミング中・diff表示中は自動保存を一時停止
- Accept後に通常の自動保存が再開

### キーボードショートカット

| ショートカット | 動作 |
|-------------|------|
| `/`（行頭/空行） | インラインAIコマンドオートコンプリートを開く |
| `Ctrl+Shift+Space` | インラインAIパレットを開く |
| `Tab`（diff表示中） | Accept |
| `Escape`（diff表示中） | Reject（ストリーミング中は停止） |
| `↑` / `↓`（オートコンプリート中） | コマンド選択 |
| `Enter`（オートコンプリート中） | コマンド確定 |

---

## 文字数目標

### 設定方法

ツールバーのオーバーフローメニュー（⋮）→「Word count goal...」で設定ダイアログを表示。

- シーン単位で目標文字数を入力
- Chapter単位の目標はChapterコンテキストメニューから設定可能

### 表示

- ステータスバーの文字数表示の横にミニプログレスバーを表示
- 達成時: プログレスバーがグリーンに変化
- 超過時: 超過文字数を赤で表示

---

## 縦書きプレビュー

### 概要

エディタ自体は常に横書き。縦書きプレビューは独立したリードオンリーパネルとして別途開く。

### 開き方

- ツールバーのオーバーフローメニュー（⋮）→「Vertical preview」
- コマンドパレット →「Open vertical preview」

### 振る舞い

- Bottom DockまたはRight Dockにパネルとして表示（デフォルト: Right Dock）
- フローティングウィンドウとして開くことも可能
- CSS `writing-mode: vertical-rl` を適用したリードオンリービュー
- エディタの変更にリアルタイム追従
- ルビは縦書きでも正しく表示
- 本体実装としては StarterKit ベースのエディタに `writing-mode: vertical-rl` を適用した薄いビューを想定する（カスタム拡張は最小限で、AuthorshipMark 等の装飾は横書きエディタ側に委ねる）
- **カーソル行ハイライトの同期はこの設計書では規定しない**。リードオンリー側で保持すべき同期状態・ハイライト表現は今後別途定義する余地を残す

---

## 自動保存

### 挙動

- TipTapの `onUpdate` イベントでデバウンス（2秒）付きの保存をトリガー
- 保存中: ステータスバーに「Saving...」を表示
- 保存完了: ステータスバーに「Saved」を表示、タブの未保存インジケーターを解除
- 保存失敗: リトライ（最大3回、指数バックオフ）後、エラー通知をステータスバーに表示

### 保存先

本文コンテンツの保存先はタブの種類によって異なる。

| タブ種類 | 保存先 | 備考 |
|---------|-------|------|
| Scene / Note | `tree_nodes.content` カラム | タブ種別ごとの差異は後述の表を参照 |
| Codex（通常） | `codex_entries.content` カラム | Codex エントリの本文 |
| Codex（Dynamic Phase プレビュー中） | `codex_phase_detail_overrides.contentOverride` カラム | 後述「Codex Dynamic Phases の Phase override」参照 |
| Snippet | `snippets.content` カラム | Snippet の本文 |

### 保存内容

- TipTapのProseMirror JSONをそのまま `JSON.stringify()` してDBのcontentカラムに保存
- ロスレス保存: AuthorshipMark等のカスタムMarkもそのまま保持され、変換コストなし
- `tiptap-markdown` はMarkdownインポート/エクスポート時のみ使用（自動保存には関与しない）
- AuthorshipMarkのデータはSQLiteの `authorship_spans` テーブルに別途永続化
- Codex/Snippetタブの場合は `node_id` の代わりに `codex_entry_id` または `snippet_id` を使用（Codex のフェーズオーバーライドは `codex_phase_detail_overrides` 側で保持）
- 正規スキーマは統合DBスキーマ設計書（`Grimodex_統合DBスキーマ.md`）の `authorship_spans` を参照

### Undo/Redo

- TipTapの組み込みHistory拡張を使用
- Undo/Redoはメモリ内のみ（保存済みのDBレコードには影響しない）
- エディタを閉じるとUndoスタックは消失

#### AuthorshipMark と Undo/Redo の相互作用

AuthorshipMarkはProseMirror/TipTapのMark機構によりドキュメント状態に埋め込まれている。TipTapのHistory拡張（ProseMirrorのhistoryプラグイン）はMarkを含むドキュメント全体をUndoスタックに記録するため、**Undo/Redo時にAuthorshipMarkは自動的に正しく復元される**。追加のAuthorship同期処理は不要。

例:
- AI生成テキストをAccept後にUndo → テキストとともに `{source: 'ai'}` マークも除去される
- Redo → テキストとマークが復元される

### Codex Dynamic Phases の Phase override

Codex タブで Editor を開いている状態で、Codex 側の Dynamic Phase 機能により特定フェーズをプレビュー中の場合、本文の保存先がフェーズ固有のオーバーライドレコードに切り替わる。

- プレビュー中のフェーズがあるとき: 本文は `codex_phase_detail_overrides.contentOverride`（該当 `codex_entry_id` + `phase_id` をキーとするレコード）に保存される
- フェーズ非プレビュー時: 通常どおり `codex_entries.content` に保存される
- 別のフェーズに切り替えると、Editor は当該フェーズ用の `contentOverride` を読み込んで再描画する（= 同じ Codex エントリであってもフェーズごとに異なる本文が表示される）
- フェーズ専用の overrides が存在しない場合はベース `content` をフォールバックとして表示し、編集時に初めて override レコードを生成する運用を想定する
- Phase 一覧の定義・切替 UI・オーバーライドのライフサイクルは Codex パネル設計書側の記載を正とし、本 Editor パネル側は「どこに書き込むか」を切り替える役割に限定する

### sceneContentStore によるスプリット間同期

同じシーンを複数の Editor Group（スプリット）や Codex ミニエディタで同時に開いている場合、片側の編集がもう片側へリアルタイムに反映される。

- 各エディタインスタンスは中央の `sceneContentStore` を購読し、自身の変更をストア経由で他インスタンスにブロードキャストする
- 反映は双方向で、両側での同時入力にも対応する（最後に届いた変更が勝つシンプルな last-writer-wins）
- Codex 詳細画面のミニエディタと Editor パネルの Codex タブも同じストアを共有するため、ミニエディタで編集した内容はフルエディタ側に即時反映され、逆も成り立つ
- ストア経由の差分適用は `programmaticInsert` meta を立てたトランザクションで行い、AiEditedPlugin の誤検知（他 Group の入力を自分の human 入力と誤認する）を避ける
- 保存（自動保存・手動保存）はいずれか 1 インスタンスが担えばよく、重複 IO を避けるため「最後にアクティブだったインスタンス」を primary とするなどの調整を行う

### タブ切替時の状態保存

タブを切り替えるときにフォーカスやスクロールを奪わないよう、シーンごとのエディタ状態を lazy に保存・復元する。

- 切替前タブのカーソル位置（ProseMirror selection）とスクロールオフセットを `savedEditorStateRef` に保存する
- 再表示時は、保存済みの状態があればカーソル位置・スクロールを復元する
- 復元時にエディタにフォーカスを強制しない（ユーザーが別パネルを操作している場合にフォーカスを奪わないため）
- 当該シーンの DOM インスタンスが破棄されている場合でも、次回マウント時に保存状態を適用する

---

## タブ種別ごとの差異

| 項目 | Scene | Note | Codex content | Snippet content |
|------|-------|------|---------------|-----------------|
| TipTapドキュメント | あり | あり | あり | あり |
| ブレッドクラムのパス | Part / Chapter / Scene | Folder / Subfolder / Note | Codex / {type} / {name} | Snippets / {title} |
| タブアイコン | なし | 📝 | typeカラードット | 🗂 |
| エクスポート対象 | Yes | No | No | No |
| Attribution追跡 | Yes | Yes | Yes | Yes |
| Codexハイライト | Yes | Yes | Yes（自エントリ除外） | Yes |
| インラインAI | Yes | Yes | Yes | Yes |
| 文字数目標 | 設定可能 | 不可 | 不可 | 不可 |
| ステータス（Draft等） | あり | なし | なし | なし |
| エディタ上部バナー | なし | 「This note is not included in export」 | 「Editing Codex entry — {type}: {name}」 | 「Editing Snippet」 |
| Chat Layer 3 連携 | シーン全文 | シーン全文（Note自体） | Codex content全文 | Snippet content全文 |
| 保存先 | `tree_nodes.content` カラム | `tree_nodes.content` カラム | `codex_entries.content` カラム（Phase プレビュー中は `codex_phase_detail_overrides.contentOverride`） | `snippets.content` カラム |
| Lint 下線（LintDecorationPlugin） | Primary Group のみ Yes（Secondary Group は No） | No | No | No |

---

## キーボードショートカット（エディタフォーカス時）

レイアウト設計書のショートカット設計原則に準拠。テキスト編集系はTipTapデフォルト、レイアウト操作は `Ctrl+Alt` プレフィックス。

### エディタ固有のショートカット

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+F` | Find（エディタ内検索） |
| `Ctrl+H` | Find & Replace |
| `Ctrl+Shift+F` | Find in all scenes（全シーン横断検索） |
| `Ctrl+.` | 傍点（圏点）のトグル |
| `Ctrl+Shift+M` | 選択範囲にコメントを追加 |
| `Ctrl+S` | 手動保存（自動保存があるが、安心感のため） |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+U` | 太字 / 斜体 / 下線のトグル |
| `Ctrl+Shift+X` | 取り消し線のトグル（ToolbarShortcutsExtension による別名。StarterKit 既定の `Ctrl+Shift+S` も引き続き有効） |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | Heading 1 / 2 / 3（ToolbarShortcutsExtension による別名。StarterKit 既定の `Ctrl+Alt+1/2/3` も引き続き有効） |
| `Ctrl+Home` / `Ctrl+End` | ドキュメント先頭 / 末尾へジャンプ（InlineAtomNavigationExtension。Ruby など atom ノードを安全に跨ぐ） |
| `Ctrl+Enter`（Scenesパネルから） | 新しいEditor Groupにシーンを開く |
| `Ctrl+Shift+Space` | インラインAIパレットを開く |
| `/`（行頭/空行） | インラインAIコマンドオートコンプリート |
| `Tab`（インラインAI diff表示中） | 生成テキストをAccept |
| `Escape`（インラインAI diff表示中） | 生成テキストをReject / ストリーミング停止 |

---

## 他パネルとの連携

### Scenesパネル

- Scenesでシーンをクリック → Editorにタブとして開く（プレビュー/固定はScenes設計書参照）
- Editorのアクティブタブ変更 → Scenesパネルが自動追従（Auto-reveal）
- ブレッドクラムでの移動 → Scenesパネルの選択状態も連動

### Chatパネル

- Chatパネルは「現在のアクティブシーン」に紐づいたコンテキストで動作
- Editorのアクティブタブ変更 → Chatパネルのコンテキストも切り替わる（Chatヘッダーに「Scene: {シーン名}」を表示）
- エディタのコンテキストメニュー「Look up in Chat」→ 選択テキストをChat入力欄に挿入
- ChatのAI応答の「Insert」ボタン → エディタのカーソル位置に挿入（AuthorshipMark: ai）
- **インラインAI** はChatの会話履歴には残らない独立したワンショット生成。同じLLMプロバイダ・モデルを使用し、Codexエントリ（Layer 4）も共有するが、会話セッションとは無関係

### Codexパネル

- エディタ内のCodexハイライトをホバー → ポップオーバーの「Open in Codex」でCodexパネルの詳細画面を開く
- エディタのコンテキストメニュー「Add to Codex」→ 選択テキストをnameとしてエントリ即時作成 → トーストの「Open」でCodexパネルの詳細画面へ
- Codexパネルの「Open in Editor ↗」→ エディタにCodexタブとして開く。ミニエディタと同一DBレコードを参照し、変更は双方向に即時反映

### Snippetsパネル

- SnippetをD&Dでエディタにドロップ → カーソル位置に挿入（AuthorshipMarkは元Snippetのsourceを継承）
- エディタのコンテキストメニュー「Save as Snippet」→ Snippetsパネルに保存
- エディタのコンテキストメニュー「Insert from Snippet...」→ Snippet一覧ポップアップ
- Snippetsパネルの「Open in Editor ↗」→ エディタにSnippetタブとして開く

### Attributionパネル

- ステータスバーの「AI: {割合}%」をクリック → Attributionパネルを開く（Scopeをアクティブシーンに設定）
- Attributionパネルのテーブル行クリック → エディタの該当シーンを開く
- Attributionパネルのサマリーカードクリック → エディタのフィルタモード（特定sourceのテキストのみ強調、他を `opacity: 0.15` で薄く表示）。Attr表示がOFFの場合は自動的にONにする

---

## 既存設計書との整合

### レイアウト設計書

Editor Groupモデル、タブ操作、スプリット、同期編集の仕様はレイアウト設計書の記載を正とする。本設計書はEditor Group内部の「1つのエディタインスタンス」の振る舞いに集中する。

### Scenesパネル設計書

プレビュー/固定タブの定義、シーンの開き方（シングルクリック/ダブルクリック/Ctrl+Enter）はScenesパネル設計書の記載を正とする。

### Linter 設計書

LintDecorationPlugin が参照する Lint ルール定義、severity 分類、オートフィックス、ルールごとの無効化 UI、Lint レポート（CSV / MD / JSON）の仕様は Linter 設計書（`Grimodex_Linter設計書.md`）の記載を正とする。本 Editor パネル設計書は「エディタ本文に波線デコレーションとして可視化する」 表示レイヤの挙動と、Primary Group の Scene タブに限定する適用条件のみを規定する。

### Attributionパネル設計書

AuthorshipMark の拡張属性（`traceId` / `toolName` / `toolVersion` / `manualOverride` / `originalLength`）および AttributionOverrideMenu による手動オーバーライドの扱いは、Attribution パネル設計書 / Agent Trace v0.1.0 仕様の記載を正とする。本 Editor パネル設計書ではスパンの付与・剥離・分割・マージを担う ProseMirror 側の挙動と、エディタ上の UI（右クリックメニュー、AttributionHighlight 描画）のみを規定する。

### Codexパネル設計書

Codex Dynamic Phases のフェーズ定義、フェーズ切替 UI、`codex_phase_detail_overrides` のライフサイクルは Codex パネル設計書 / Codex 設計書の記載を正とする。本 Editor パネル設計書では「Codex タブ編集時、プレビュー中フェーズがあるなら保存先を `codex_phase_detail_overrides.contentOverride` に切り替える」という書き込み側の振る舞いのみを規定する。また Codex ミニエディタとフルエディタ間の双方向同期は `sceneContentStore` 経由で実装する。

---

## Beat システム（Beat 設計書 Phase A 連携）

Beat システムの導入に伴い、Editor キャンバスと上部ヘッダーに以下を追加する。詳細は [Beat システム設計書](./Grimodex_Beatシステム設計書.md)。

### TipTap カスタムノード

- **`sceneBeat`**: 本文中の Placed beat。`group: 'block'`、`content: 'inline*'`。`attrs`: `id` / `placed` / `order` / `collapsed` / `generated` / `generatedRange` / `beatType` / `pov`
- **`unplacedBeats`**: ドキュメント先頭に固定されるコンテナ。`isolating: true`、Editor キャンバスからは描画除外され、Synopsis 隣の Beats セクションでレンダリング
- 既存シーンには `appendTransaction` で空の `unplacedBeats` を自動挿入（マイグレーション）

### Codex メンション拡張の SceneEditor 登録

既存の `ChatMentionExtension`（`src/features/chat/extensions/ChatMentionExtension.ts`）と同等のメンション拡張を SceneEditor の Extensions リストに追加する。`sceneBeat` の `inline*` content 内で `@キャラ名` のオートコンプリートが動作する。Phase B で role 修飾子（`@name:actor` / `@name:target`）を Mention `attrs.role` で表現する。

### Beats セクション（Synopsis 隣）

`SynopsisHeader.tsx` と同じ親 div の兄弟要素として `BeatsHeader.tsx` を新規追加（既存 Synopsis セクションは独立 DOM のため衝突しない）。

- Unplaced beat の一覧表示・追加・編集・並べ替え
- Placed beat の一覧表示（本文位置への参照）
- D&D による Unplaced ↔ Placed の状態遷移
- `+ Beat` ボタン

### Placed beat の本文中表示

- ヘッダーバー: 折りたたみトグル `[▼]/[▶]`、`[⚡Generate]`（未生成時のみ）、`[⋮]` メニュー、`POV: 花子` チップ（シーン POV と異なる場合のみ）
- 折りたたみ時はヘッダーと冒頭文だけ表示
- 左ボーダーで Attribution と区別（Beat: 黄色系、Attribution: 紫系）
- 生成中はストリーミング表示（prose が下に追記されていく）

### `[⋮]` メニュー（Placed beat）

`Regenerate` / `Generate alternative` / `Edit beat` / `Convert to text` / `Unplace` / `Delete beat only` / `Delete beat and prose`

### `/` コマンド

本文中で `/` を押すとコマンドメニューが開き、`Scene beat` / `Continue writing`（= 即時生成つき beat） を選択可能。`Ctrl+Shift+B` ショートカットも提供。

### ツールバー

ツールバーに Beat 挿入ボタンを追加（既存ボタングループの末尾）。ショートカットと同等の動作。

### ステータスバー

「E. ステータスバー」セクションの右側統計情報テーブルに `Beats: {総数} ({生成済}件 generated)` 行が追加される（このセクションの上で追記済み）。

### Focus mode と リニア編集モード

- Focus mode: Beat を非表示にするオプションを追加（Settings 連携）
- リニア編集モード: Settings で「通常表示 / 折りたたみ / 非表示」を切替可能（default は「折りたたみ」）

### Export 時の挙動

Markdown export で `sceneBeat` / `unplacedBeats` ノードは**完全除去**される（読者向け本文に Beat が混入するのを防ぐ）。詳細はエクスポートダイアログ設計書参照。

---

## Synopsis インライン編集の共有コンポーネント化

Synopsis は Editor 上部の C-4 セクション・Scenes パネルの Outline モード・Grid パネルのカードの3箇所でインライン編集される。挙動の不一致を防ぐため、`<InlineSynopsisEditor>`（`src/features/editor/InlineSynopsisEditor.tsx`）を新規作成し、3パネルから共通利用する。

挙動仕様（共有コンポーネントが提供する単一の振る舞い）：

- textarea ベースのインライン編集
- `Enter` で確定（保存）、`Shift+Enter` で改行、`Esc` でキャンセル
- フォーカスを失う（外側クリック）と確定保存
- IME 入力中の `Enter` は確定しない（`compositionend` 後に有効化）
- 保存失敗時はトースト通知し、編集状態を維持

C-4 セクションの既存 textarea 実装は本コンポーネントに置換する（同等機能のため UX 後退なし）。

---

## Grid パネルとの接続

[Grid パネル設計書](./Grimodex_Gridパネル設計書.md) のカードタイトルクリックで Editor が起動する。経路：

- Grid のカードタイトル → 既存のタブモデル（プレビュータブ昇格ロジック）に従って Scene を開く
- Editor 側で Synopsis や本文を変更すると、Grid のカード（`tree_nodes.synopsis` / `tree_nodes.unplaced_beat_preview` 経由）も即座に更新される
