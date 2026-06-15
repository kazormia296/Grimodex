# Grimodex エクスポートダイアログ設計書

## 概要

エクスポートダイアログは、プロジェクト内のシーンを選択して外部ファイルに書き出すためのフローティングダイアログ。ヘッダーバーのエクスポートボタンからワンアクションで開ける。Scenesパネルのツリー構造を流用し、チェックボックスでエクスポート対象のシーンを選択する。Noteノードは非表示。

> **Settings > Data カテゴリとの関係**: Settings設計書で定義されていた「Export as Markdown」「Export as plain text」等のボタンは、本ダイアログに**置き換える**。Data カテゴリには「エクスポート…」リンクボタンを残し、クリックで本ダイアログを開く。Codex / Attribution レポートのエクスポートは引き続きSettings > Data に残す。

---

## ヘッダーバーへの配置

ヘッダーバーの右側、パネルトグルと設定ボタンの間にエクスポートボタンを追加する。

```
[ワークスペース▾]  Grimodex  ──────  [レイアウト▼] [パネル▼] [↓Export] [⚙]
```

| 要素 | アイコン | ツールチップ | ショートカット |
|------|---------|------------|-------------|
| エクスポートボタン | `FileOutput`（lucide-react） | `エクスポート (Ctrl+Shift+E)` | `Ctrl+Shift+E` |

- クリックでエクスポートダイアログを開閉
- **現状の実装**: アイコン + `app.exportLabel` テキストラベル付きで、ヘッダーバー左側（`HistoryButtons` の右、`flex-1` スペーサーの前）に配置。設定ボタンと統一スタイル。
- **将来拡張**: 他のヘッダーボタンとの統一のため、テキストラベル削除とアイコンのみ化を検討

---

## ダイアログ構造

```
┌───────────────────────────────────────────────────────────────────┐
│ エクスポート                                                  [×] │
├──────────────────────────────────┬────────────────────────────────┤
│                                  │ ── 投稿サイトプリセット ──      │
│ ☑ ▼ 📁 第一部: 旅立ち            │ [カスタム ▼]    [💾 保存…]    │
│   ☑ ▼ 📁 第1章: 始まり           │ （※プリセット選択時のみ注記表示）│
│     ☑ 塔の麓                     │ （※ルビ文字数警告バナーがここ） │
│     ☑ 最初の呪文                  │                                │
│   ☑   幕間                       │  出力形式                      │
│ ☐ ▶ 📁 第二部: 暗転              │  ○ Markdown                   │
│ ☑   エピローグ                    │  ● プレーンテキスト             │
│                                  │  ○ HTML                       │
│                                  │                                │
│                                  │  ── フォルダー見出し ──         │
│                                  │  ☑ フォルダー名を見出しにする    │
│                                  │  見出し記号: [# ▼]             │
│                                  │                                │
│                                  │  ── シーン区切り ──             │
│                                  │  シーン間: [空行 ▼]            │
│                                  │  シーンタイトル: [含めない ▼]    │
│                                  │                                │
│                                  │  ── 特殊表現 ──                │
│                                  │  ルビ: [括弧表記 ▼]            │
│                                  │  傍点: [そのまま ▼]            │
│                                  │  シーンブレイク: [* * * ▼]      │
│                                  │                                │
│                                  │  ── プレビュー ──               │
│                                  │  ┌────────────────────────┐    │
│                                  │  │ # 第一部: 旅立ち        │    │
│                                  │  │ ## 第1章: 始まり        │    │
│                                  │  │                        │    │
│                                  │  │ 　夜明けの光が…         │    │
│                                  │  │                        │    │
│                                  │  │ 　エララは杖を…         │    │
│                                  │  └────────────────────────┘    │
│                                  │                                │
├──────────────────────────────────┴────────────────────────────────┤
│       選択中: 4/7 シーン  約12,340文字    [📋 コピー] [エクスポート] │
└───────────────────────────────────────────────────────────────────┘
```

### レイアウト仕様

| 項目 | 値 |
|------|-----|
| デフォルトサイズ | 1000×780px（現状の実装値。設計初期値は 720×560px） |
| リサイズ | CSS `resize` で可能（最小 560×400px、最大 90vw × 90vh） |
| 左ペイン（ツリー） | 幅50%、最小240px |
| 右ペイン（設定） | 幅50%、最小280px |
| スプリッター | ※ 現状未実装（左右ペインは固定50%。`AnimatedOverlay` のリサイズで全体サイズのみ可変） |

---

## 左ペイン: シーン選択ツリー

Scenesパネルのツリー表示を簡略化して流用する。

### 表示ルール

| ノードタイプ | 表示 | チェックボックス | 詳細 |
|-------------|------|----------------|------|
| Folder | 表示 | **三状態** | 配下にSceneを持つFolderのみ表示。空Folder・Note-onlyのFolderは非表示 |
| Scene | 表示 | **二状態** | チェック = エクスポート対象 |
| Note | **非表示** | — | ツリーから完全に除外 |

### 三状態チェックボックス（Folder）

| 状態 | 表示 | 意味 |
|------|------|------|
| ☑ (checked) | 塗りつぶし | 配下の全Sceneが選択済み |
| ☐ (unchecked) | 空 | 配下の全Sceneが未選択 |
| ☑ (indeterminate) | ハイフン（`−`） | 配下のSceneが部分的に選択 |

Folderのチェックボックスをクリックすると、配下の全Sceneのチェック状態が一括でトグルする（indeterminate → checked → unchecked の順）。

### Scenesパネルとの差分

| 機能 | Scenesパネル | エクスポートツリー |
|------|------------|-----------------|
| チェックボックス | なし | **あり** |
| Note表示 | あり | **なし** |
| ステータスドット | あり | なし |
| 文字数表示 | あり | あり（チェック済みのみカウント） |
| AI帰属バッジ | あり | なし |
| ドラッグ & ドロップ | あり | なし |
| コンテキストメニュー | あり | なし |
| インライン名前変更 | あり | なし |
| フィルター検索 | あり | なし |
| ビューモード切替 | あり | なし |
| フォルダー展開/折りたたみ | あり | あり |

### ツリーヘッダー

```
[☑ 全選択] [全展開/全折りたたみ]
```

- 「全選択」チェックボックス: 全Sceneを一括選択/解除
- 展開/折りたたみトグルボタン

### 初期状態

- ダイアログを開いた時、全Sceneがチェック済み（全選択状態）
- フォルダーの展開/折りたたみ状態はScenesパネルの現在の状態を引き継ぐ

---

## 右ペイン: エクスポート設定

### 出力形式

ラジオボタンで1つを選択。

| 形式 | 拡張子 | 詳細 |
|------|--------|------|
| Markdown | `.md` | TipTapのMarkdownシリアライザを使用。見出し・太字・リンク等を保持 |
| プレーンテキスト | `.txt` | Markdown記法を除去。装飾なしのテキスト |
| HTML | `.html` | 完全なHTML文書として出力。ルビ・傍点をネイティブタグで表現可能 |

デフォルト: **プレーンテキスト**（小説執筆の最終出力として最も汎用的）

---

### フォルダー見出し

エクスポート結果にフォルダー名を見出しとして挿入するかを設定する。

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| フォルダー名を見出しにする | チェックボックス | ON | OFFにするとフォルダー名は出力されない |
| 見出し記号 | ドロップダウン | `■□◇` | 出力形式ごとの見出しスタイル（後述） |
| 見出しフォーマット | `folderHeadingFormat` | `standard` | `standard` = 上記の通り、`pixiv-chapter` = pixiv 小説の `[chapter:タイトル]` 記法（プリセット側で自動設定） |

#### 見出しの深さマッピング

フォルダーのネスト深さに応じて見出しレベルを自動調整する。

| 深さ | Markdown | プレーンテキスト | HTML |
|------|----------|---------------|------|
| ルート直下（深さ0） | `# 第一部` | `■ 第一部` | `<h1>第一部</h1>` |
| 1階層目（深さ1） | `## 第1章` | `□ 第1章` | `<h2>第1章</h2>` |
| 2階層目（深さ2） | `### セクション` | `◇ セクション` | `<h3>セクション</h3>` |
| 3階層以深 | `####` 以降 | `・` 統一 | `<h4>` 以降（`<h6>` で頭打ち） |

見出し記号のドロップダウン選択肢（プレーンテキスト時）:

| 選択肢 | 深さ0 / 深さ1 / 深さ2 |
|--------|----------------------|
| `■□◇` (デフォルト) | `■ Title` / `□ Title` / `◇ Title` |
| `【】` | `【Title】` / `〈Title〉` / `「Title」` |
| `数字のみ` | フォルダータイトルをそのまま出力（記号なし） |

Markdown / HTML 選択時は見出し記号ドロップダウンを非表示にし、標準の見出し構文を使用する。

#### `pixiv-chapter` フォーマット

pixiv プリセット選択時に自動で適用される pixiv 小説専用フォーマット。深さに関係なくすべての階層を `[chapter:タイトル]` で出力する（pixiv 側でネスト見出しを扱えないため）。

| サブオプション | キー | デフォルト | 詳細 |
|---|---|---|---|
| `[newpage]` を章前に挿入 | `pixivChapterNewpage` | OFF | ON のとき各 `[chapter:...]` の直前に `[newpage]\n` を差し込む。pixiv の章間改ページ慣習に対応 |

`folderHeadingFormat === "pixiv-chapter"` は **plaintext** 出力のときのみ有効。Markdown / HTML では `standard` 動作にフォールバック。

---

### シーン区切り

選択されたシーン間に挿入する区切りを設定する。

#### シーン間区切り

連続するシーンの間に挿入するセパレーター。

| フィールド | UI要素 | 選択肢 | デフォルト |
|-----------|--------|--------|-----------|
| シーン間 | ドロップダウン | 下表参照 | 空行 |

| 選択肢 | 出力例 | 詳細 |
|--------|--------|------|
| 空行 | `\n\n` | シーン間に1行の空行を挿入 |
| 空行×2 | `\n\n\n` | シーン間に2行の空行を挿入 |
| `* * *` | `\n\n* * *\n\n` | アスタリスク3つの区切り線 |
| `---` | `\n\n---\n\n` | Markdown水平線（Markdown出力時のみ有効） |
| 罫線 | `\n\n────────\n\n` | 全角罫線 |
| なし | `\n` | 改行のみ（区切りなし） |
| カスタム | テキスト入力欄が出現 | 任意の文字列を指定 |

#### シーンタイトル

各シーンの先頭にシーンタイトルを挿入するか。

| フィールド | UI要素 | 選択肢 | デフォルト |
|-----------|--------|--------|-----------|
| シーンタイトル | ドロップダウン | 下表参照 | 含めない |

| 選択肢 | 出力例（Markdown） | 詳細 |
|--------|-------------------|------|
| 含めない | （タイトル出力なし） | シーン本文のみ |
| 見出しとして | フォルダーの最深+1レベルの見出し | 例: `## 第1章` の下なら `### 塔の麓` |
| 太字として | `**塔の麓**` | Markdownの太字 / HTML `<strong>` / プレーンはそのまま |
| そのまま | `塔の麓` | 装飾なしでタイトル文字列のみ |

---

### 特殊表現

TipTapの独自ノード/マークのエクスポート方法を設定する。

#### ルビ（振り仮名）

実装は `src/features/export/rubyFormats.ts` 参照。各投稿サイト・Wiki エンジン・ゲームエンジン向けの記法を網羅する。

| 選択肢 | id | 出力例 | 詳細 |
|--------|------|--------|------|
| HTML rubyタグ | `html` | `<ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>` | HTML出力時のデフォルト |
| 括弧表記 | `parentheses` | `漢字(かんじ)` | プレーンテキスト出力時のデフォルト |
| 青空文庫形式 | `aozora` | `｜漢字《かんじ》` | 親文字直前の `｜` で範囲を明示 |
| なろう自動判定 | `aozora-auto` | `漢字《かんじ》` | カクヨム・なろうの自動判定形式 |
| なろう括弧 | `narou-parens` | `\|漢字(かんじ)` | 半角バー + 半角括弧 |
| ハッシュアンダースコア | `hash-underscore` | `#漢字__かんじ__#` | 一部投稿サイトの古い記法 |
| `[[rb:]]` 形式 | `rb-bracket` | `[[rb:漢字 > かんじ]]` | pixiv 小説など |
| MediaWiki | `mediawiki` | `{{ruby|漢字|かんじ}}` | MediaWiki テンプレート |
| WikiWiki | `wikiwiki` | `&ruby(かんじ){漢字};` | WikiWiki プラグイン |
| でんでんマークダウン | `denden` | `{漢字|かんじ}` | でんでんコンバーター |
| でんでん文字単位 | `denden-chars` | `{対象|ル|ビ}` | 文字数一致時は1字ずつ分割 |
| Ren'Py | `renpy` | `\r[漢字,かんじ]` | Ren'Py ノベルゲームエンジン |
| ゲームエンジン汎用 | `game-engine` | `[ruby text=ル]対[ruby text=ビ]象` | 文字数一致時は1字ずつ分割 |
| ベースのみ | `base` | `漢字` | ルビを除去し親文字のみを出力 |
| 自動 | `null` | （形式依存） | 出力形式別のデフォルトに従う |

出力形式ごとのデフォルト:

| 出力形式 | ルビのデフォルト |
|----------|---------------|
| Markdown | HTML rubyタグ |
| プレーンテキスト | 括弧表記 |
| HTML | HTML rubyタグ |

#### 傍点（圏点）

実装は `src/features/export/exportEngine.ts` の `renderEmphasisDots`。

| 選択肢 | id | 出力例 | 詳細 |
|--------|------|--------|------|
| HTMLタグ | `html` | `<span class="emphasis-dots">重要</span>` | HTML出力時のデフォルト |
| 青空文庫形式 | `aozora` | `重要［＃「重要」に傍点］` | 青空文庫互換の傍点注記 |
| 二重山括弧 | `double-angle` | `《《重要》》` | カクヨム・アルファポリス等の標準 |
| そのまま | `plain` | `重要` | 傍点記法を除去しテキストのみ出力 |
| なろう傍点（まとめ） | `narou-emphasis-batch` | `\|重要《・・》` | コードポイント長分の中黒をまとめて指定 |
| なろう傍点（1文字ずつ） | `narou-emphasis-per-char` | `\|重《・》\|要《・》` | 1文字ずつ分割。長単語や約物混在時に安全 |
| 自動 | `null` | （形式依存） | 出力形式別のデフォルトに従う |

なろう傍点モード（`narouEmphasisMode`: `batch` / `per-char`）はなろうプリセット選択時の UI トグルと連動する（後述）。

出力形式ごとのデフォルト:

| 出力形式 | 傍点のデフォルト |
|----------|---------------|
| Markdown | 青空文庫形式 |
| プレーンテキスト | 青空文庫形式 |
| HTML | HTMLタグ |

#### シーンブレイク（本文中の区切り）

エディタ本文中の `SceneBreakNode`（`* * *` 表示）の出力形式。シーン**間**区切りとは別のもの。

| 選択肢 | 出力 | 詳細 |
|--------|------|------|
| `* * *` | `* * *` | デフォルト。エディタ表示と同一 |
| `---` | `---` | Markdown水平線 |
| 空行 | `\n` | 空行1行に変換 |
| カスタム | テキスト入力欄が出現 | 任意の文字列を指定 |

---

### 投稿サイトプリセット

右ペイン最上部に配置されるプリセット選択 UI。投稿サイト・汎用フォーマットごとに「出力形式 / 区切り / ルビ / 傍点 / 章見出し」を一括で適用する。実装は `src/features/export/ExportPresetPicker.tsx` と `src/features/export/exportPresets.ts`。

#### ビルトインプリセット一覧

| ID | 表示名 | format | 見出し | ルビ | 傍点 | scene break | 備考 |
|---|---|---|---|---|---|---|---|
| `narou` | 小説家になろう | plaintext | OFF | `aozora` | `narou-emphasis-batch` | `asterisks` | base 10字 / ruby 10字の警告。1文字分割サブオプションあり |
| `kakuyomu` | カクヨム | plaintext | OFF | `aozora-auto` | `double-angle` | `asterisks` | base 20字 / ruby 50字の警告 |
| `alphapolis` | アルファポリス | plaintext | OFF | `aozora` | `double-angle` | `asterisks` | — |
| `pixiv` | pixiv 小説 | plaintext | ON / `pixiv-chapter` | `rb-bracket` | `double-angle` | `custom: [newpage]` | `[newpage]` 章前挿入サブオプションあり |
| `hameln` | ハーメルン | plaintext | OFF | `aozora` | `double-angle` | `asterisks` | — |
| `novelup` | ノベルアップ+ | plaintext | OFF | `aozora` | `double-angle` | `asterisks` | base 50字 / ruby 50字の警告 |
| `novelism` | ノベリズム | plaintext | OFF | `aozora` | `double-angle` | `asterisks` | 「記法変換 ON 時のみ有効」と注記 |
| `aozora` | 青空文庫テキスト | plaintext | OFF | `aozora` | `aozora` | `asterisks` (`blank2` divider) | 青空文庫入稿用 |
| `generic-md` | 汎用 Markdown | markdown | ON | `parentheses` | `plain` | `hr` (`blank2` divider) | Discord / Slack / note 貼付向け |
| `word-html` | Word 貼付 (HTML) | html | ON | `html` | `html` | `hr` | Word / LibreOffice の `<ruby>` 解釈に対応 |
| `web-fiction` | Web 小説（Wattpad 等） | plaintext | OFF | `base` | `plain` | `asterisks` | 英語 web 小説のプレーンテキスト貼付向け。ルビ・傍点を除去。章見出しはサイト側 UI で付ける前提 |
| `ao3` | Archive of Our Own | html | ON | `html` | `plain` | `hr` (`blank2` divider) | AO3 HTML エディタ貼付向け。`word-html` と違い傍点 span を出さない |
| `custom` | カスタム | （現在値） | — | — | — | — | プリセット適用なし。手動変更時に自動でこの ID へフォールバック |

各プリセットには **対象言語メタデータ `region`**（`ja` / `en` / `all`）が付与される。`ja` = 日本の投稿サイト＋青空文庫、`en` = `web-fiction` / `ao3`、`all` = `generic-md` / `word-html`（言語共通）。`region` は選択 UI の optgroup 並べ替え（後述）に使う。

#### 言語別 optgroup 並べ替え

プリセット選択 UI は **プロジェクト言語**（`settingsStore.projectLanguage`、書体・行間等と同じ基準）で optgroup の並びを切り替える。グルーピングは `src/features/export/exportPresetCatalog.ts` の `getPresetGroups(projectLanguage, currentPresetId)` が組み立てる。

| プロジェクト言語 | primary（先頭） | generic（中段） | secondary（末尾） |
|---|---|---|---|
| `ja`（既定） | 日本の投稿サイト 7 種 | `aozora` / `generic-md` / `word-html` | 「英語向けプラットフォーム」= `web-fiction` / `ao3` |
| `en` | 「Built-in」= `web-fiction` / `ao3` | `generic-md` / `word-html` | 「日本語向けプラットフォーム」= 投稿サイト 7 種 ＋ `aozora` |

- `custom` は常にグループ外の先頭、ユーザー定義プリセットは常に末尾。
- HTML `<select>` の optgroup は実際には畳めないため「畳む」=末尾にまとめて表示の意。
- `aozora` は青空文庫という汎用テキスト寄りの性格上、`ja` プロジェクトでは generic 側に置き（既存挙動の維持）、`en` プロジェクトでは日本語プラットフォーム群にまとめる。
- 全ビルトインは常にいずれかのグループに含まれるため、保存済みの `narou` を英語プロジェクトで開いても選択肢から消えない（`currentPresetId` 安全網も併用）。

#### 適用方式

- **完全上書き**: プリセット選択で 7 軸（format / folderHeading / folderHeadingFormat / sceneDivider / sceneTitle / rubyStyle / emphasisDotsStyle / sceneBreakStyle ＋ サブオプション）を一括差し替え
- **保持フィールド**: `includeTrashBin` はプリセットと無関係な「コンテンツ選択」軸として、適用時に現在値を引き継ぐ
- **手動変更で自動 custom フォールバック**: 詳細設定を 1 項目でも触ると `detectExportPreset(settings, hint)` で再検出し、ビルトインと一致しなくなれば `exportPresetId` を `custom` に書き換える
- **重複ビルトインの hint 優先**: `alphapolis` / `hameln` / `novelup` / `novelism` は実サイト仕様上同じ設定値になるため、settings だけからは区別不能。現在の `exportPresetId` を hint として渡す限り、ユーザーの選択が維持される

#### サブオプション

プリセット選択時のみ追加で表示されるトグル:

| プリセット | サブオプション | 設定キー | 詳細 |
|---|---|---|---|
| `narou` | 傍点を1文字ずつ分割 | `narouEmphasisMode` (`batch` / `per-char`) | ON で `emphasisDotsStyle` を `narou-emphasis-per-char` に切替 |
| `pixiv` | 章見出しの前に `[newpage]` を入れる | `pixivChapterNewpage` | ON で `[chapter:...]` の直前に `[newpage]\n` を挿入 |
| `novelism` | （注記表示のみ） | — | 「傍点は記法変換 ON 設定の場合のみ有効」と表示 |

#### サイト別ルビ文字数バリデーション

実装は `src/features/export/exportValidation.ts`。プリセットに `rubyLimit: { baseMax, rubyMax }` が定義されている場合のみ走査する（`custom` は対象外）。

- ProseMirror JSON 内の `ruby` ノードを再帰的に辿り、`base` / `annotation` のコードポイント長を上限と比較
- 違反は `RubyLengthWarning[]` として返し、UI 上部の **警告バナー** に最大 5 件まで表示（超過分は「他 N 件」）
- **警告のみでエクスポートはブロックしない**

| プリセット | baseMax | rubyMax |
|---|---|---|
| narou | 10 | 10 |
| kakuyomu | 20 | 50 |
| novelup | 50 | 50 |

#### カスタムプリセット保存

`Save current settings…` ボタンから現在の設定に名前を付けて保存できる。

| 項目 | 詳細 |
|---|---|
| 保存先キー | `export.userPresets`（JSON 配列を 1 キーに格納） |
| 1件あたりの形状 | `{ id: string; name: string; settings: ExportSettings }` |
| ID 生成 | `crypto.randomUUID()`（フォールバック: `up-${ts}-${rand}`） |
| 名前バリデーション | 1〜40 文字、trim 後の空文字は不可 |
| 保存時の正規化 | 保存される `settings.exportPresetId` は常に `custom` に固定（再選択時にユーザープリセットとして識別するため） |
| 構造比較で再選択検出 | Select の現在値は、構造一致するユーザープリセットがあればそれを表示。なければ `detectExportPreset` の結果 |
| 削除 | ユーザープリセット選択時のみ削除ボタン表示。`window.confirm` で確認後に削除 |

UI 上は optgroup で「ビルトイン」「汎用」「ユーザー定義」を分離する。

---

### ゴミ箱

`includeTrashBin` チェックボックス（デフォルト OFF）。ON にするとゴミ箱内のシーンも export 対象に含める。ゴミ箱パネル設計書 §3.5 「プライバシー / オプトアウト」に対応。設定キーは `export.includeTrashBin`。

> ※ 現状未実装: チェックボックス UI とフラグ永続化までは実装済みだが、`exportEngine` 側でゴミ箱ノードを実際に対象に含める分岐は未配線（ゴミ箱ノード自体が `nodes` から除外されている前提）。

---

### プレビュー

右ペインの下部に、現在の設定で出力した場合のプレビューを表示する。

- 出力結果の先頭 400 文字を表示（実装上は `generateExport(...).slice(0, 400)`）
- フォルダー見出し・シーン区切り・特殊表現の設定がリアルタイムに反映される
- 等幅フォント、読み取り専用
- スクロール可能（最大高さ160px）
- 設定変更時にデバウンス200msで再生成

---

## フッターバー

```
選択中: 4/7 シーン  約12,340文字                [📋 コピー] [エクスポート]
```

| 要素 | 詳細 |
|------|------|
| 選択カウント | `選択中: {checked}/{total} シーン` |
| 文字数概算 | `約{charCount}文字` — 選択中シーンの合計文字数 |
| コピーボタン | セカンダリボタン（`ClipboardCopy` アイコン + 「コピー」ラベル）。クリックでエクスポート内容をクリップボードにコピー。0件選択時はdisabled |
| エクスポートボタン | プライマリボタン。0件選択時はdisabled |

### クリップボードコピーの動作

1. [コピー] クリック
2. 現在の設定（出力形式・特殊表現・区切り等）に基づいてテキストを生成
3. クリップボードにコピー（Clipboard API を使用）
4. コピー成功時: ボタンがチェックマークアイコン（`Check`）+ 「コピー済み」に1.5秒間変化し、元に戻る
5. トースト通知は不要（ボタンの状態変化で十分なフィードバック）

- HTML出力形式を選択中の場合でも、コピーはプレーンテキストとしてクリップボードに書き込む（HTMLタグ含む文字列）
- ファイル保存ダイアログは開かない（コピーのみで完結）

### エクスポート実行フロー

1. [エクスポート] クリック
2. 保存ダイアログを表示してパスを取得し、ファイルへ書き込む
   - デフォルトファイル名: `{プロジェクトタイトル}.{拡張子}`（例: `My Fantasy Novel.txt`）
   - **Tauri 環境**: `@tauri-apps/plugin-dialog` の `save()` で OS ネイティブの保存ダイアログを表示。出力形式に応じた filter（Markdown / Plain Text / HTML）を渡す。確定後 `@tauri-apps/plugin-fs` の `writeTextFile()` でユーザーが選んだフルパスへ書き込む
   - **ブラウザ環境（dev サーバー / vitest）**: 従来通り `Blob` + `<a download>` でデフォルトダウンロードフォルダに保存（フォールバック）
   - 環境判定は `"__TAURI_INTERNALS__" in window`
3. 完了後、トースト通知: `エクスポート完了: {ファイル名またはフルパス}`
4. 保存ダイアログでキャンセル（path = null）された場合はトーストも出さず無音で終了
5. ダイアログは閉じない（連続エクスポート可能）

### 必要な Tauri capability

`src-tauri/capabilities/default.json` に以下が必要:

- `dialog:allow-save`
- `fs:allow-write-text-file`（`scope: $HOME/**`）

書き込み先がホームディレクトリ外（例: `/tmp` 直下、ルート、外付けデバイスを mount していないパス）になる場合は permission denied になり、エラーハンドリング経由で toast.error が出る。スコープ拡張は別途検討事項。

### エラーハンドリング

| エラー | 対応 |
|--------|------|
| 書き込み権限なし (`$HOME/**` 外を選択した場合など) | `toast.error("エクスポートに失敗しました: {message}")` |
| ディスク容量不足 | 同上 |
| 保存ダイアログでキャンセル | 無音で終了。toast を出さない |
| シーン未選択で実行 | ボタンdisabledのため到達しない |

---

## 出力構造

### 出力順序

ツリーの表示順（`sort_order`）に従って上から順にシーンを結合する。フォルダーの階層構造を維持し、折りたたみ状態は無視する（チェック済みの全シーンを出力）。

### 出力テンプレート（プレーンテキスト例）

```
■ 第一部: 旅立ち

□ 第1章: 始まり

　夜明けの光が石畳を照らし、市場には早くも人々の喧騒が満ちていた。
エララは人混みをかき分けながら、師匠に言いつけられた薬草を探していた。

（シーン間区切り）

　古びた塔の前に立つと、アミュレットが微かに震えた。
｜漢字《かんじ》の刻まれた扉は重く……

■ 第二部: 暗転

（略）
```

### 出力構造の詳細

```
[フォルダー見出し（有効時）]
[空行]
[シーンタイトル（有効時）]
[シーン本文]
[シーン間区切り]
[シーンタイトル（有効時）]
[シーン本文]
[シーン間区切り]
[次のフォルダー見出し]
...
```

- 出力内で連続する全てのシーン間に「シーン間区切り」を挿入する
- ただし、2つのシーンの間にフォルダー見出しが挿入される場合は、見出し前後の空行が十分な視覚的区切りとなるため、シーン間区切りを省略する
- 末尾のシーンの後には区切りを挿入しない
- ファイル末尾に改行を1つ付加

### HTML出力時の追加要素

HTML形式を選択した場合、完全なHTML文書として出力する。

```html
<!DOCTYPE html>
<html lang="{プロジェクト言語設定}">
<head>
  <meta charset="UTF-8">
  <title>{プロジェクトタイトル}</title>
  <style>
    body { max-width: 40em; margin: 2em auto; font-family: serif; line-height: 1.8; }
    .emphasis-dots { text-emphasis: sesame; -webkit-text-emphasis: sesame; }
    .scene-break { text-align: center; margin: 2em 0; }
    rt { font-size: 0.5em; }
  </style>
</head>
<body>
  ...
</body>
</html>
```

---

## 設定の永続化

エクスポート設定は `app_settings` テーブルに保存し、次回ダイアログを開いた時に復元する。シーンの選択状態は保存しない（毎回全選択で開始）。

| キー | デフォルト値 | 詳細 |
|------|-------------|------|
| `export.format` | `"plaintext"` | |
| `export.folderHeading` | `true` | |
| `export.folderHeadingStyle` | `"squares"` | |
| `export.folderHeadingFormat` | `"standard"` | `"standard"` / `"pixiv-chapter"` |
| `export.sceneDivider` | `"blank"` | |
| `export.sceneDividerCustom` | `""` | |
| `export.sceneTitle` | `"none"` | |
| `export.rubyStyle` | `null` | 出力形式に応じた自動選択 |
| `export.emphasisDotsStyle` | `null` | 出力形式に応じた自動選択 |
| `export.sceneBreakStyle` | `"asterisks"` | |
| `export.sceneBreakCustom` | `""` | |
| `export.includeTrashBin` | `false` | プリセット切替で上書きされない |
| `export.pixivChapterNewpage` | `false` | pixiv プリセット選択時のみ意味を持つ |
| `export.narouEmphasisMode` | `"batch"` | `"batch"` / `"per-char"`。なろうプリセット選択時のみ意味を持つ |
| `export.exportPresetId` | `"custom"` | 現在選択中のプリセット ID。手動変更で `custom` にフォールバック |
| `export.userPresets` | `""` (= 空配列) | ユーザー定義プリセットを JSON 文字列で格納 |

`rubyStyle` / `emphasisDotsStyle` が `null` の場合、出力形式に応じたデフォルト（前述の表参照）を使用する。ユーザーが明示的に変更した場合のみ値が保存される。

`export.userPresets` は `JSON.stringify([{ id, name, settings }])` の形式で 1 キーに格納する（複数キーへの分割は採らない）。読み出し時は `parseUserPresets()` で安全にパースし、壊れていれば空配列にフォールバックする。

---

## キーボードショートカット

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Shift+E` | エクスポートダイアログを開く/閉じる |
| `Escape` | ダイアログを閉じる |
| `Ctrl+A`（ツリーにフォーカス時） | 全シーンを選択 |
| `Enter` | [エクスポート] ボタン実行 |

---

## 他パネル・設計書との連携

### ← Settings > Data

Settings の Data カテゴリにあった「Export as Markdown」「Export as plain text」ボタンは**本ダイアログに統合**する。Data カテゴリには以下のリンクを残す:

```
エクスポート
  [シーンをエクスポート…]  → エクスポートダイアログを開く
  [Codexをエクスポート]    → 従来通り（Codexエントリの一括エクスポート）
  [帰属レポートをエクスポート] → 従来通り（Attributionレポート）
```

### ← Scenes パネル

- ツリーデータ（ノード階層・タイトル・文字数）を共有
- フォルダーの展開/折りたたみ状態を初期値として引き継ぐ（ダイアログ内での変更はScenesパネルに影響しない）

### → Editor

- シーン本文の取得は `sceneContentStore`（Zustand）から最新のTipTap JSONを取得
- Editorで未保存の変更がある場合でも、storeの最新状態を使用するため常に最新内容がエクスポートされる

### ← ヘッダーバー

- ヘッダーバー設計書の要素一覧にエクスポートボタンを追加（ワークスペースメニューの右）

### ← rubyExport.ts

- 既存の `rubyToHtml()` / `rubyToPlainText()` を利用する
- 青空文庫形式・ベースのみは新規実装

---

## 将来の検討事項

- **EPUB出力**: 電子書籍形式での出力。章構造をEPUBのセクションにマッピング
- **縦書きPDF出力**: 日本語小説の入稿用。外部ライブラリまたはTauri側での生成を要検討
- **Synopsis付きエクスポート**: アウトライン確認用に各シーンのSynopsisをシーン先頭に挿入するオプション
- **一括コマンドパレット対応**: `Ctrl+Shift+P` →「Export all scenes as Markdown」等で設定ダイアログを経由せず即時エクスポート
- **カスタムプリセットのリネーム / 並べ替え**: 現状は追加・削除のみ。リネームと並べ替え UI は未実装
- **Tauri 保存先スコープの拡張**: 現状の `$HOME/**` 制約を緩めるか、書込先プリセット（Documents/Downloads など）を別途用意するか

---

## Beat ブロックの Export 時挙動

[Beat システム設計書](./Grimodex_Beatシステム設計書.md) で導入される本文中の `sceneBeat` ノードは **Markdown export 時に完全除去**、`generatedProseBlock` は **unwrap**（中身の段落だけ残す）。Unplaced beat は本文外の `tree_nodes.unplaced_beats_doc` カラムに保存されるため Export 対象には含まれない（自然に除外される）。残るのは生成された prose と通常の段落のみ。

### 除去される内容

- 本文中の `sceneBeat` ノード本体（生成された prose は `generatedProseBlock` の unwrap によって残る）
- `generatedProseBlock` のラッパーは剥がし、中身の段落のみ残す（AuthorshipMark は export ロジックに従い別途処理）
- Beat 内の角括弧記法（`[slow down]`, `[expand the dialogue]` 等）
- Beat 内の `@codex_name:role` メンション（角括弧記法と同じく執筆プロセスのメタデータ）
- Unplaced beat（`unplaced_beats_doc` カラム）は読み取らない

### 除去する理由

- Beat は執筆プロセスのメタデータであり、読者向けの本文ではない
- 角括弧記法 `[slow down]` などが本文に混入すると意味不明になる
- Novelcrafter 等他ツールへの export 互換性を保つ

### v2 で検討する保持オプション

- **コメント形式で保持**: Beat 内容を Markdown のコメント `<!-- beat: ... -->` として埋め込むオプション。再 import 時の復元手段として
- **Beat 専用エクスポート**: Beat 一覧だけを別ファイルとして出力（プロット文書の生成）

v1 では完全除去のみを実装する。
