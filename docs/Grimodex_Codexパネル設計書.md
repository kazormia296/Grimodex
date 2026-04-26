# Grimodex Codexパネル設計書

## 概要

Codexパネルはプロジェクトの世界設定データベース。キャラクター、場所、アイテム、伝承の4カテゴリのエントリを管理する。左にエントリ一覧（マスター）、右に詳細編集画面（ディテール）のスプリットビュー。エントリはEditorやChatから作成され、エディタ本文中のCodexハイライトやChatのコンテキスト注入で活用される。各エントリはフェーズシステムにより物語の進行に伴う経時的変化を管理でき、AIコンテキスト注入にはシーンに応じた適切な状態が反映される。

本設計書で「Codex パネル」と呼ぶ実装は `CodexManagementPanel` コンポーネントを指す。歴史的経緯で `CodexPanel.tsx` という旧実装も残っているが、ルーティング/dockview 登録からは参照されておらず、実体として使われていない。

デフォルト位置: Left Dock（非表示）。Scenes パネル近傍に独立した dockview パネルとして配置される（Scenes とタブ共有ではない）。CodexQuick（後述）も Scenes 付近に独立したパネルとして配置され、三者を同じ Dock 内で並べるのが既定のレイアウト。

---

## パネル構造

```
┌──────────────────────────────────────────────┐
│ A. Header          | E. Detail view          │
│ Codex  24entries[+]│ (icon)     👤character  | 
│ [By category ▾]    │                         |
├────────────────────┤         Elara           |
│ B. Search bar      │  tags: MainCharacter [+]|
│ [🔍 Search...]     │_________________________|
├────────────────────| Details  | Relations |        |
│ C. Filter tabs     | Tracking | Mentions  |Research│
│ [All(24)] [Item(8)]|--------------------------│
│ [...]              | Summary:                 │
├────────────────────| Protagonist, mage        |
│ D. Entry list      │ apprentice at the Tower. │
│ ▼ Character (3)    │ Content: (TipTap editor)│
│ ● Elara         ◄──│ A young woman who       │
│   Protagonist...   │ discovers her connection │
│ ● Marcus           │ to ancient magic...     │
│ ▼ Location (1)     │ CustomDetails:...       │
│ ● Obsidian Tower   │                         │
│   Ancient binding..│                         │
│ ▼ Item (1)         │                         │
│ ● Soulbind Amulet  │                         │
│   Elara's family...│                         │
│ ▼ Lore (1)         │                         │
│ ● Age of Binding   │                         │
│   Historical era...│                         │
│                    │                         │
│                    │                         │
└────────────────────┴─────────────────────────┘
```

パネル幅が狭い場合（例: Left Dock で幅200px程度）は、リスト表示のみに切り替わり、エントリクリックで詳細画面に遷移する（スタックナビゲーション）。十分な幅がある場合はスプリットビューを使用する。閾値: 400px以上でスプリット、未満でスタック。

---

## A. ヘッダー

- **パネルタイトル**: 「Codex」
- **エントリ数**: フィルタ適用後の件数。右寄せ
- **ソート順ドロップダウン**: エントリリストの並び順を変更（後述「ソート順」セクション参照）
- **[+] ボタン**: 新規エントリ作成（後述）

---

## B. 検索バー

### 全文検索

- エントリの name、aliases、summary、tags_cache をFTS5（trigramトークナイザー）でインクリメンタル検索
- 1-2文字の短いクエリはFTS5のtrigramトークナイザーでマッチできないため、name/summary/tags_cache に対するLIKEフォールバックで検索
- 入力開始でデバウンス300msの即時フィルタ
- マッチしたエントリのみリストに表示
- 検索語がname内にマッチした場合は太字ハイライト
- `Escape` でクリア

---

## C. フィルタタブ

カテゴリ別のフィルタタブ。各タブに該当エントリ数を表示。`codex_types` テーブルから `sort_order` 順で動的生成。

ビルトインタブ:

| タブ        | 説明           |
| --------- | ------------ |
| All       | 全エントリ（デフォルト） |
| Character | キャラクター       |
| Location  | 場所・地名        |
| Item      | アイテム・道具      |
| Lore      | 伝承           |

各タブのカラーはテーマ連動パレットカラーシステム（`codex_types.palette_index` → CSS変数 `--palette-N`）で決定される。

カスタムタイプ（`codex_types` で `is_builtin = 0`）もタブとして表示される。表示名は `codex_types.label`、カラーは `codex_types.color`。

タブはクリックで排他選択。フィルタタブと検索は組み合わせ可能（例: Character タブ + 検索「Elara」）。

### タグフィルタ

フィルタタブの下にタグフィルタドロップダウンを配置。`codex_tags` テーブルから候補を表示。

- 複数タグ選択可能。**フィルタロジック: OR（いずれか一致）**
- 選択中のタイプタブに該当するタグのみ表示（`codex_tags.type_filter` が NULL または選択タイプを含むタグ）
- タグ選択状態はピルとして表示、×でクリア
- タイプフィルタ + タグフィルタ + 検索は全て組み合わせ可能

---

## D. エントリリスト（マスター）

### エントリカード

各エントリは以下の情報を持つコンパクトなカードで表示:

```
[●] Entry name
    Summary preview text...
```

| 要素 | 詳細 |
|------|------|
| カテゴリドット | カテゴリ色のドット（パレットカラーシステムに準ずる） |
| エントリ名 | 太字。クリックで詳細画面を表示 |
| サマリープレビュー | summaryフィールドの先頭40文字。未記入の場合はcontentの先頭40文字。未記入の場合はグレーで「No summary」 |

選択中のエントリは左ボーダー + 背景ハイライトで強調。

### バーチャルスクロール

エントリリストは `@tanstack/react-virtual` による仮想化リストで描画する。エントリ数が増加してもスクロール性能を維持するため、ビューポート内の要素のみをDOMに描画する。

### ソート順

ヘッダーのソート順ドロップダウンから変更可能:

- **By category（デフォルト）**: タイプ別にアコーディオングループで表示。各グループ内はアルファベット/五十音順。グループの表示順は `codex_types.sort_order` に従う（Character → Location → Item → Lore → カスタムタイプ）。アコーディオンの開閉状態はセッション内で保持
- Name (A→Z)
- Name (Z→A)
- Recently updated
- Recently created
- Most referenced（本文中の出現回数順）

#### By category 表示

```
▼ Character (8)
  ● Elara
  ● Marcus
  ● Thorne
▼ Location (6)
  ● Binding Chamber
  ● Obsidian Tower
▶ Item (4)              ← 折り畳み
▼ Lore (6)
  ● Age of Binding
  ● Soulbind Prophecy
```

- 各グループヘッダーにカテゴリ色のドット + タイプラベル + 件数を表示
- アコーディオンのクリックで開閉。デフォルトは全グループ展開
- フィルタタブでタイプを絞り込んでいる場合、該当タイプのグループのみ表示（アコーディオンなしのフラットリスト）
- 検索時はアコーディオンを解除し、マッチ結果をフラットリストで表示

### コンテキストメニュー

エントリカードの右クリック:

| メニュー項目 | 動作 |
|-------------|------|
| Edit | 詳細画面を表示（スプリット時はフォーカス、スタック時は遷移） |
| Rename | name をインライン編集 |
| Change type | サブメニュー: `codex_types` から動的生成（ビルトイン+カスタム） |
| Duplicate | エントリを複製（「{name} (copy)」） |
| --- | |
| Pin to Chat | 現在のChatセッションにピン留め |
| Find in scenes | 本文中でこのエントリ名が出現するシーンを検索（結果をBottom Dockに表示） |
| --- | |
| Delete | 確認ダイアログ後に削除 |

---

## E. 詳細画面（ディテール）

### 構造

```
┌─────────────────────────────────────────┐
│ [🖼] Elara             👤character      │  ← ヘッダー（タブ外・常時表示）
│ tags: [protagonist] [mage] [+]          │
├─────────────────────────────────────────┤
│ Details│Relations│Timeline│Tracking│Mentions│Research│ ← タブ
├═════════════════════════════════════════┤
│                                         │  ← Details タブ
│ Aliases: [エララ]                       │
│          [the apprentice] [+]           │
├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤
│ Summary:                                │
│ Protagonist, mage apprentice            │
│ at the Obsidian Tower.                  │
├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤
│ Content:                                │  ← TipTap mini-editor
│ A young woman who discovers             │     (Codex highlight enabled)
│ her connection to ancient magic         │
│ through the Soulbind Amulet...          │
│                  ^^^^^^^^^^^            │  ← Codex highlight (clickable)
├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤
│ Details:                                │  ← Custom details (per type)
│ 種族      [人間          ▾] 🤖          │
│ 所属勢力  [● 白銀騎士団  →] 🤖          │
│ 身長      [175cm            ]           │
│ [+ Add field]  [⚙ Manage]              │
└─────────────────────────────────────────┘
```

パネル幅が狭い場合（例: Left Dock で幅200px程度）は、リスト表示のみに切り替わり、エントリクリックで詳細画面に遷移する（スタックナビゲーション）。十分な幅がある場合はスプリットビューを使用する。閾値: 400px以上でスプリット、未満でスタック。

---

### ヘッダー（タブ外・常時表示）

タブの外側に常時表示されるエントリの基本情報。

#### アイコン画像

- ヘッダー左端に48×48pxのアイコン画像を表示（Notionページヘッダー風）
- クリックで画像選択ダイアログを開き、ローカル画像ファイルを選択
- 画像はDBの `codex_entries.icon` TEXTカラムにbase64 WebPデータURL文字列として格納（リサイズ: 128×128px、WebP変換）
- 未設定時はカテゴリドット（typeに応じた色の●）をフォールバック表示
- リスト画面のサムネイルにも同じアイコンを使用（28×28px）
- ポップオーバー（Editor等）では24×24pxで表示

#### エントリ名

- アイコンの右にエントリ名を表示。クリックでインライン編集

#### Type バッジ

- 右寄せでカテゴリバッジ（クリックでtype変更ドロップダウン）
- カテゴリバッジのドロップダウンは `codex_types` テーブルから動的生成（ビルトイン+カスタム）

#### Tags フィールド（構造化タグ）

タグは `codex_tags` テーブルで構造化管理される。エントリとタグの関連は `codex_entry_tags` 多対多テーブルで保持。

- ピル型タグ一覧 + [+] ボタンで追加
- タグは `codex_tags.color` に応じた色付きピルで表示
- タグをクリックすると、同じタグを持つ全エントリをフィルタ表示
- タグの×ボタンで削除（`codex_entry_tags` から行削除 + `tags_cache` 同期更新）
- [+] クリックでインライン入力欄が表示。既存タグのオートコンプリート付き
  - **タイプフィルタ**: 現在のエントリのタイプに該当するタグのみ候補表示（`codex_tags.type_filter` が NULL または現在のタイプを含むタグ）
  - 入力中に一致するタグがなければ、新規タグとして作成可能（`codex_tags` に行追加）
  - 新規タグ作成時の初期設定: `type_filter = NULL`（全タイプ）、`color = NULL`
- タグの色・タイプ関連付けの管理は Settings 内の「Tags」セクションで行う

#### Tags 管理画面（Settings内）

プロジェクト設定の「Tags」セクションでタグの一括管理が可能:

| 操作 | 詳細 |
|------|------|
| タグ名編集 | インライン編集。変更は全エントリに即時反映 |
| 色変更 | カラーピッカー。hex値 |
| タイプ関連付け | チェックボックス群（`codex_types` から動的生成）。未選択=全タイプ |
| 削除 | 確認ダイアログ。CASCADE で全エントリから除去 + `tags_cache` 再構築 |

---

### Details タブ

#### フェーズインジケーター

エントリにフェーズ（経時的変化）が設定されている場合、Detailsタブの最上部にフェーズインジケーターを表示する。フェーズの詳細は「フェーズシステム（経時的変化）」セクション参照。

```
┌─────────────────────────────────────────┐
│ ⏱ Phase: 反乱参加 (Ch.15 Sc.1) [▾]    │  ← フェーズセレクター
│   Base → 追放 → [反乱参加] → 覚醒       │  ← ミニタイムライン
└─────────────────────────────────────────┘
```

- 現在のエディタのアクティブシーンに連動して自動選択（状態解決アルゴリズムに基づく）
- ドロップダウンで手動切り替え可能（**Phase プレビューモード**）
- 「Base」「Phase名 (シーン名)」のリスト表示
- フェーズが0個のエントリでは非表示
- フェーズで上書きされたフィールドは左ボーダー（アクセントカラー）で強調し、Base値を薄い文字でインライン表示
- フィールド右の「×」でそのフィールドの上書きを解除（Baseに戻す）

**Phase プレビューモード**:

Details タブのフェーズセレクターで特定のフェーズを選択すると、状態解決の結果（後述「状態解決アルゴリズム」節参照）として得られる `previewPhaseId + resolvedState` を用いて、**該当フェーズまでを適用した読み取り専用のプレビュー**が Details タブ全体にかかる。Summary / Content / カスタムディテールそれぞれ、そのフェーズまでに適用された override 値を表示する。

- プレビュー中はタブ上部に「Previewing: {フェーズラベル}」バッジを表示
- 各フィールドは通常の編集アフォーダンス（入力欄のフォーカスリング等）を無効化し、読み取り専用になる
- Base 状態に戻す操作（セレクターで「Base」を選ぶ）でプレビューは解除され、現在シーンに応じた自動選択状態に戻る
- プレビューはあくまで表示のみで、DB には書き込まない。編集したい場合は一度 Base に戻すか、フェーズ編集ダイアログを使う

**Content フィールドのフェーズ対応**:

フェーズ適用中にContentフィールドを編集した場合、変更は `codex_entry_phases.content_override` に保存される（Base の `codex_entries.content` には影響しない）。

```
┌─────────────────────────────────────────┐
│ Content:                    [Open in Editor ↗]│
│ ┃ 反乱軍に加わったエララは、かつて      │  ← 左ボーダー（アクセントカラー）
│ ┃ 師匠から教わった魔法を戦場で         │    で override フィールドを示す
│ ┃ 振るうことになった...               │    （他フィールドと共通の表現）
│                                         │
│ [Base contentを表示 ▾]                  │  ← Content下部に折りたたみ配置
└─────────────────────────────────────────┘
```

- フェーズの表示状態は上部フェーズインジケーターに集約し、Content欄内にはフェーズ名を重複表示しない
- override中であることは左ボーダー（アクセントカラー）で示す（Summary等の他フィールドと統一）
- Content下部に「Base contentを表示」折りたたみを配置。展開するとBase content を読み取り専用で参考表示
- Base状態でContentを編集 → 従来通り `codex_entries.content` に保存
- **Open in Editor ↗**: フェーズ適用中は content_override をエディタタブで開く。タブタイトルは「{エントリ名} — {フェーズラベル}」（例: 「Elara — 反乱参加」）。保存先は `codex_entry_phases.content_override`

#### Aliases フィールド

- name の直下に「Aliases」入力欄
- Tags と同じUIパターン: ピル型一覧 + [+] ボタンで追加、各ピルに × で削除
- キャラクターの別名、場所の通称、アイテムの略称を登録
- 例: エントリ「Elara」に aliases: `["エララ", "the apprentice"]`
- aliasはCodexマッチング対象に含まれ、本文中で「エララ」が出現した場合も「Elara」エントリとしてハイライトされる
- alias変更時はAho-Corasickオートマトンの再構築がトリガーされる

#### Summary フィールド

- 1-2行のプレーンテキスト入力欄
- プレースホルダー: 「Short description...」
- この内容がエディタのCodexハイライト ポップオーバー、Codex Quickセクション、Chatコンテキスト注入の「要約」として使われる
- 自動保存（デバウンス2秒）
- **summaryが未記入の場合のフォールバック**: コンテキスト注入時にsummaryが空の場合、content全文を注入する。これによりsummary未記入でもAIが情報不足にならないが、トークン効率は低下する
- **ガイドラインメッセージ**: summaryが空でcontentがある場合、入力欄の下にインラインヒントを表示: 「Summaryを記入するとAIチャットでのトークン消費を抑えられます」（dismissible、一度閉じたらセッション内で再表示しない）
- **AI自動要約**:
  - summaryが空でcontentがある場合、入力欄内に「✨ Generate summary」ボタンを表示
  - クリックで軽量モデル（haiku等）がcontentを要約し、summaryに自動入力
  - 既にsummaryがある場合はボタン非表示。代わりに右クリックコンテキストメニューの「Regenerate summary」で上書き可能
  - 生成中はスピナー表示、失敗時はトースト通知

#### Content フィールド（TipTapミニエディタ）

- TipTapの軽量インスタンス。StarterKitのサブセット（太字、斜体、見出し、リスト、リンク、表）。入力時のMarkdown記法をリアルタイムにリッチテキストとしてレンダリング
- キャラクターの詳細な背景設定、場所の歴史、アイテムの由来など、長文の設定情報を記述
- **Open in Editor**: Content フィールドの右上に「Open in Editor ↗」ボタンを表示。クリックするとエディタパネルにCodexタブとして開き、エディタの全機能（インラインAI、CodexHighlight、Chat連携）で編集できる。Codexパネル内のミニエディタとエディタタブのcontentは同一DBレコード（`codex_entries.content`）を参照しており、一方の変更が他方に即時反映される
- **CodexHighlight対応**: エディタ本文と同じCodexHighlight Pure Decorationを適用。Content内で言及された他のCodexエントリがハイライトされ、ホバーポップオーバーで確認、「Open in Codex →」で遷移可能。自エントリ自身のnameとaliasesはハイライト対象から除外
- Content内で検出されたCodexエントリは「リレーション提案」としてRelationsセクションに表示される（後述）
- エディタ本文と同じくProseMirror JSONで `codex_entries.content` カラムに保存
- 自動保存（デバウンス2秒）
- **Attribution追跡**: エディタ本文と同じAuthorshipMark体系を適用する。Codexパネルのミニエディタとエディタタブの両方でAuthorship付与が機能する
  - キーボード入力 → `{ source: 'human' }`
  - Chatから「Codex」ボタンで抽出されたcontent → `{ source: 'ai', model, chatMessageId }`
  - インラインAI（エディタタブ）でAccept → `{ source: 'ai', model }`
  - AI自動要約でsummaryから展開されたcontent → `{ source: 'ai', model }`
  - アプリ内ペースト（エディタ、Chat、他のCodex/Snippet等からコピー）→ 元テキストのAuthorshipMarkを継承（Editorパネル設計書「クリップボードのAuthorship伝搬」参照）
  - 外部ペースト（AuthorshipMark情報なし）→ `{ source: 'unknown' }`
  - `ai` マーク付きテキストの編集 → `ai` のまま維持（エディタ本文と同じルール）
  - AuthorshipMarkのデータは `authorship_spans` テーブルに `codex_entry_id` を指定して永続化（統合DBスキーマ参照）
  - AttributionHighlight（背景色ハイライト）はエディタタブ・ミニエディタの両方で表示可能（Attr表示トグル連動）

#### Details セクション（カスタムディテール）

Content フィールドの下に配置。タイプごとに定義されたカスタムフィールドの値を入力するセクション。フィールド定義は `codex_detail_definitions` テーブル、値は `codex_detail_values` テーブルに保存。

##### フィールドタイプ

| field_type | UI | 保存値 |
|-----------|-----|--------|
| `text` | TipTapミニエディタ（Contentフィールドと同一構成） | ProseMirror JSON |
| `dropdown` | `<select>`。選択肢は `field_config.options` から生成 | 選択肢文字列 |
| `codex_reference` | 検索UIでCodexエントリを選択。ピル表示（クリックで遷移） | エントリID |

`codex_reference` の `field_config.allowedTypes` で参照可能なタイプを制限可能（NULL = 全タイプ）。

##### text フィールドのTipTapエディタ

`text` フィールドはContentフィールドと同一のTipTapミニエディタを使用する。機能はContentフィールドに準ずる:

- **エディタ構成**: StarterKitのサブセット（太字、斜体、見出し、リスト、リンク、表）。Markdown記法のリアルタイムレンダリング
- **CodexHighlight対応**: Contentフィールドと同じCodexHighlight Pure Decorationを適用。フィールド内で言及された他のCodexエントリがハイライトされ、ホバーポップオーバーで確認、「Open in Codex →」で遷移可能。自エントリ自身のnameとaliasesはハイライト対象から除外
- **Attribution追跡**: Contentフィールドと同じAuthorshipMark体系を適用する
  - キーボード入力 → `{ source: 'human' }`
  - Chatから抽出されたテキスト → `{ source: 'ai', model, chatMessageId }`
  - アプリ内ペースト → 元テキストのAuthorshipMarkを継承
  - 外部ペースト → `{ source: 'unknown' }`
  - `ai` マーク付きテキストの編集 → `ai` のまま維持
  - AuthorshipMarkのデータは `authorship_spans` テーブルに `detail_value_id` を指定して永続化
  - AttributionHighlight（背景色ハイライト）はAttr表示トグル連動
- **保存**: ProseMirror JSONで `codex_detail_values.value` に保存。自動保存（デバウンス2秒）
- **AIコンテキスト注入時**: ProseMirror JSONからプレーンテキストに変換して注入（Contentフィールドのフォールバック注入と同じ方式）

##### AIコンテキスト注入制御

各フィールドの右端に🤖アイコンを表示。`include_in_context = 1` のフィールドはアイコンがアクティブ状態。クリックでトグル。

注入される場合、エントリのsummaryに付加してコンテキストに含まれる:

```
## エララ (キャラクター)
主人公の幼馴染で、塔の見習い魔術師。
- 種族: 人間
- 所属勢力: 白銀騎士団
```

**注入条件チェーンフロー**: `context_mode` がゲート → `include_in_context` がフィールド単位の制御。`context_mode = 'hidden'` のエントリは全カスタムディテールも注入しない。

`codex_reference` フィールドの注入時は参照先エントリのnameを表示（IDではなく）。

##### フィールド管理

- [+ Add field]: 現在のタイプに新しいフィールド定義を追加。クリックでManage fieldsダイアログの新規追加フォームを開く
- [⚙ Manage fields]: タイプのフィールド定義を管理するダイアログを開く（後述）

##### Manage fields ダイアログ

タイプに紐づくカスタムフィールド定義を一括管理するモーダルダイアログ。`codex_detail_definitions` テーブルを操作する。

###### ダイアログ構造

```
┌─────────────────────────────────────────────────────┐
│ Manage fields: キャラクター                    [×]  │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ⠿ 種族              dropdown    🤖  [✎] [🗑]      │
│  ⠿ 所属勢力          codex_ref   🤖  [✎] [🗑]      │
│  ⠿ 身長              text             [✎] [🗑]      │
│  ⠿ 一人称            text        🤖  [✎] [🗑]      │
│                                                     │
│  [+ Add field]                                      │
│                                                     │
├─────────────────────────────────────────────────────┤
│                                        [Close]      │
└─────────────────────────────────────────────────────┘
```

###### フィールド一覧

| 要素 | 説明 |
|------|------|
| ⠿ ドラッグハンドル | D&Dで並び替え。`sort_order` を更新 |
| フィールド名 | `name` を表示 |
| タイプラベル | `field_type` を短縮表示（`text`, `dropdown`, `codex_ref`） |
| 🤖 アイコン | `include_in_context = 1` の場合アクティブ表示。クリックでトグル |
| [✎] 編集ボタン | フィールド編集フォームを展開（インラインアコーディオン） |
| [🗑] 削除ボタン | 確認ダイアログ後に定義削除 |

###### フィールド編集フォーム（アコーディオン展開）

[✎] クリックまたは [+ Add field] クリックで、該当行の下にインラインフォームがアコーディオン展開する。

```
┌─────────────────────────────────────────────────────┐
│  ⠿ 種族              dropdown    🤖  [▼] [🗑]      │
│  ┌───────────────────────────────────────────────┐  │
│  │ Name:        [種族                         ]  │  │
│  │ Type:        [Dropdown               ▾]      │  │
│  │ AI context:  [✓] Include in AI context        │  │
│  │                                               │  │
│  │ Options:                                      │  │
│  │   人間                               [×]      │  │
│  │   エルフ                             [×]      │  │
│  │   ドワーフ                           [×]      │  │
│  │   [+ Add option]                              │  │
│  │                                               │  │
│  │              [Cancel]  [Save]                  │  │
│  └───────────────────────────────────────────────┘  │
│  ⠿ 所属勢力          codex_ref   🤖  [✎] [🗑]      │
└─────────────────────────────────────────────────────┘
```

###### 共通フィールド

全 `field_type` で表示:

| フィールド | UI | バリデーション |
|-----------|-----|---------------|
| Name | テキスト入力 | 必須。同一タイプ内でユニーク（`UNIQUE(project_id, type_slug, name)`） |
| Type | ドロップダウン: `Text` / `Dropdown` / `Codex Reference` | 必須。変更時は後述の注意あり |
| AI context | チェックボックス「Include in AI context」 | `include_in_context` カラムに対応 |

###### field_type 別の追加設定

**Text**:

追加設定なし（TipTapミニエディタが複数行を標準でサポート）。

**Dropdown**:
| 設定 | UI | 対応 |
|------|-----|------|
| Options | タグ入力風リスト。各選択肢に×ボタン + [+ Add option] | `field_config.options` |

- 選択肢は最低1つ必要（空リストで保存不可）
- 選択肢の並び順 = 配列順。D&Dで並び替え可能
- 選択肢を削除しても、既存エントリでその値が選択されている場合は値を保持（ただしドロップダウンには表示されなくなるため、値がグレー表示 + 警告アイコンで「この選択肢は定義から削除されました」ツールチップ）

**Codex Reference**:
| 設定 | UI | 対応 |
|------|-----|------|
| Allowed types | チェックボックス群（`codex_types` から動的生成）。未選択 = 全タイプ | `field_config.allowedTypes` |

- 全タイプにチェックが入っている状態 = `allowedTypes: null`（制限なし）
- 「Select all」/「Clear」のヘルパーリンク

###### field_type の変更

既にエントリに値が存在する場合、`field_type` を変更すると既存値との互換性が問題になる。

| 変更パターン | 振る舞い |
|-------------|---------|
| text → dropdown | 既存のProseMirror JSONはクリア（形式が非互換）。確認ダイアログ表示。関連する `authorship_spans`（`detail_value_id`）も削除 |
| text → codex_reference | 既存のProseMirror JSONはクリア（形式が非互換）。確認ダイアログ表示。関連する `authorship_spans` も削除 |
| dropdown → text | 既存の選択肢文字列をプレーンテキストとしてProseMirror JSONの段落ノードに変換。互換あり |
| dropdown → codex_reference | 既存値はクリア。確認ダイアログ表示 |
| codex_reference → text | 既存のエントリIDはクリア（表示上意味がないため）。確認ダイアログ表示 |
| codex_reference → dropdown | 既存値はクリア。確認ダイアログ表示 |

確認ダイアログ: 「{N}件のエントリの値がクリアされます。続行しますか？」

###### フィールド削除

[🗑] クリックで確認ダイアログを表示:

```
このフィールドを削除しますか？

「種族」を削除すると、このタイプの全エントリ（{N}件）から
このフィールドの値が完全に削除されます。この操作は元に戻せません。

                              [キャンセル]  [削除]
```

削除実行: `codex_detail_definitions` から行削除 → `codex_detail_values` がCASCADE削除。

###### フィールド追加

[+ Add field] クリックで一覧の末尾にフォームが展開:

- Name: 空（カーソルフォーカス）
- Type: `Text`（デフォルト）
- AI context: OFF（デフォルト）
- `sort_order`: 現在の最大値 + 1.0

Save クリックで `codex_detail_definitions` に行追加。同一タイプの全エントリに対して空の `codex_detail_values` 行は作成しない（値が入力された時に初めて行を作成 = lazy insert）。

###### 並び替え

ドラッグハンドル（⠿）でD&D。ドロップ時に `sort_order` を更新（Fractional Indexing: ドロップ先の前後のsort_orderの中間値を計算）。並び順はDetailsセクションでのフィールド表示順、およびAIコンテキスト注入時の表示順に反映。

###### ダイアログのスコープ

- ダイアログのタイトルに対象タイプのlabelを表示（例: 「Manage fields: キャラクター」）
- 表示するフィールドは `WHERE project_id = ? AND type_slug = ?` でフィルタ
- 変更は即時保存（Save ボタン押下時）。Cancel は未保存の編集を破棄
- 他のタイプのフィールドには影響しない

##### エッジケース

- `codex_reference` の参照先が削除された → 「[削除済み]」表示、値をNULLに更新
- エントリのタイプ変更 → 旧タイプのフィールド値は保持（非表示）、新タイプの定義のみ表示。タイプを戻せば値が復活
- 自動保存（デバウンス2秒）

---

### Relations タブ

Codexエントリ間の親子関係を管理するセクション。詳細は「エントリ間リレーション」セクション参照。

**Parent（親エントリ）**:
- 現在のエントリの親。0個または1個
- エントリ名をクリックで親の詳細画面に遷移
- ×で親リレーション解除

**Children（子エントリ）**:
- 現在のエントリの子。0個以上
- 各子エントリはカテゴリドット + 名前 + typeラベルで表示
- クリックで子の詳細画面に遷移
- ×で子リレーション解除
- [+ Add child] でCodexエントリ検索UIを表示し、子を追加

**Context injection（コンテキスト注入設定）— ChildrenBudgetSelector**:
- Children セクション下部に `ChildrenBudgetSelector` コンポーネントとして表示（4 プリセットのセグメント/ドロップダウン UI）
- このエントリが注入対象になった場合に、子孫エントリのsummaryを自動注入するトークン上限を設定
- 予算はLayer 4予算に対する比率で指定。モデルのコンテキスト上限に応じて実トークン数が自動スケールする
- プリセット選択肢（`codex_entries.childrenBudget` カラムに保存）:
  | 選択肢 | Layer 4比率 | 説明 |
  |--------|-----------|------|
  | None (`none`) | 0% | 子孫を注入しない |
  | Few / Compact (`few`、default) | 15% | 子が少ないエントリ向け |
  | Many / Standard (`many`) | 30% | 中規模の子ツリー向け |
  | All / Generous (`all`) | 50% | 大きな組織・派閥向け |
- デフォルト: `few` (15%)
- 子エントリが0個の場合はこのセクションを非表示

**Suggested（提案）**:
- Content内で言及されているが、まだリレーションが設定されていないCodexエントリの一覧
- 検出は `findMentionedEntriesAsync` ユーティリティが担当し、Codex マッチングパイプライン（Rust/JS いずれの Aho-Corasick 経路でも）が検出した mention id 集合から既存リレーション・自エントリ・Dismiss 済みを差し引いた候補を返す
- 各候補の右に [+ Add] ボタン。クリックで子リレーションとして確定
- Content変更時に自動更新。Dismiss した候補は `codex_dismissed_relations` テーブルに永続保存され、以後 `findMentionedEntriesAsync` の結果から恒久的に除外される（ユーザーが明示的に undo するまで再提案されない）

---

### Tracking タブ

#### コンテキスト制御モード（AI Context）

Trackingタブ内に「Context:」ドロップダウンを配置。エントリごとにAIコンテキスト注入の振る舞いを制御する。

| モード | ラベル | 動作 |
|--------|--------|------|
| `always` | Always include | シーン内の言及有無に関わらず常に注入。ピン留め可 |
| `mentioned` | When mentioned（デフォルト） | シーン内で検出された場合に注入。ピン留め可 |
| `suppress` | Manual only | 自動検出では注入しない。ピン留めで上書き可 |
| `hidden` | Exclude from AI | AIコンテキストに一切含めない。ピン留め不可 |

- ドロップダウンの各選択肢にはモードの説明をサブテキストで表示
- `hidden` 選択時はエントリカードにミュートアイコンを表示（リスト画面で視認可能）
- `always` 選択時はエントリカードに常駐アイコンを表示
- エディタハイライトへの影響はなし（全モードでハイライトされる）

#### Excluded Aliases フィールド（除外パターン）

- Trackingタブ内に「Excluded」入力欄。ピル型UIで追加/削除
- エントリのnameやaliasesを含む文字列のうち、誤マッチを引き起こすパターンを登録
- 典型的なユースケース: 一般名詞をキャラクター名に使っている場合（「青」「光」「響」「塔」「森」等）

使用例:
- エントリ名「青」(character) に excluded: `["青い", "青の", "青く", "青が", "青を", "青空", "青年"]`
- 本文「青い空を見上げた」→ 「青い」が除外パターンにマッチ → ハイライトしない
- 本文「青は振り返った」→ 「青は」は除外パターンになし、かつ「青」+「は」は文字クラス境界（漢字→ひらがな）→ ハイライトされる

除外パターンの運用ガイド:
- 名詞+助詞パターン（青い、青の、青く等）を登録するのが基本
- 複合語パターン（青空、青年等）も必要に応じて追加
- 除外パターンが多すぎる場合は、エントリ名自体を変更することも検討（例: 「青」→ フルネーム「青（あお）」にしてaliasesで「青」を残す）
- 除外パターン変更時はAho-Corasickオートマトンの再構築がトリガーされる

---

### Mentions タブ

#### Appears in（References）

このエントリ名が言及されている箇所を一覧表示する。以下のカテゴリに分類:

| カテゴリ | 説明 | 状態 |
|---------|------|------|
| Manuscript | シーン本文（エディタ）内での出現 | 実装済み |
| Codex | 他のCodexエントリのContent内での言及 | 未実装（将来対応） |
| Chats | チャット内での言及 | 未実装（将来対応） |

**Manuscript（実装済み）**:

- このエントリ名が本文中に出現するシーンの一覧を自動表示
- 各シーン名はクリック可能（Editorでそのシーンを開く）
- データソース: Zustandストアの全シーンのCodexマッチ結果を逆引き

**Codex（未実装）**:

- 他のCodexエントリのContentフィールド内でこのエントリ名が言及されている箇所の一覧
- 将来対応予定

**Chats（未実装）**:

- チャット会話内でこのエントリ名が言及されているメッセージの一覧
- 将来対応予定

#### Source（出自情報）

- `source_chat_message_id` がある場合: 「{セッションタイトル} (chat)」のリンクを表示。クリックでChat Historyパネル経由で元のチャットセッションを開く
- Editorの「Add to Codex」から作成された場合: 「Created from editor」表示
- 手動作成の場合: 表示なし

---

### Research タブ

#### Notes フィールド（プライベートノート）

AIコンテキストに含まれないプライベートノート。執筆上のメモ、アイデア、検討事項など、AIに渡す必要のない情報を記録する。

- Contentフィールドと同一構成のTipTapミニエディタ
- StarterKitのサブセット（太字、斜体、見出し、リスト、リンク、表）。入力時のMarkdown記法をリアルタイムにリッチテキストとしてレンダリング
- **AIコンテキスト注入対象外**: context_modeに関わらず、notesフィールドの内容はChatのシステムプロンプトに一切注入されない
- **CodexHighlight対応**: Contentフィールドと同じCodexHighlight Pure Decorationを適用
- **Attribution追跡**: Contentフィールドと同じAuthorshipMark体系を適用する
- 自動保存（デバウンス2秒）
- ProseMirror JSONで `codex_entries.notes` カラムに保存

**DBスキーマ**: `codex_entries` テーブルに `notes TEXT` カラムを追加。Contentカラムと同じProseMirror JSON形式。

---

### Timeline タブ

エントリの経時的変化（フェーズ）を時系列で管理するタブ。フェーズシステムの詳細は「フェーズシステム（経時的変化）」セクション参照。

```
┌─────────────────────────────────────────┐
│Details│Relations│Timeline│Tracking│Mentions│Research│
├═════════════════════════════════════════┤
│                                         │
│ ⏱ Timeline                             │
│                                         │
│ ┃ ● Base state                          │
│ ┃   塔の見習い魔術師                      │
│ ┃   所属: 白銀騎士団                      │
│ ┃                                       │
│ ┃─── Ch.8 Sc.3 ─────────────────────    │
│ ┃                                       │
│ ┃ ● 追放                                │
│ ┃   summary → 「塔を追われた元見習い」     │
│ ┃   content → 📝 (上書きあり)            │
│ ┃   所属 → (なし)                        │
│ ┃   [Edit] [Delete]                     │
│ ┃                                       │
│ ┃─── Ch.15 Sc.1 ────────────────────    │
│ ┃                                       │
│ ┃ ◉ 反乱参加              ← 現在のシーン │
│ ┃   summary → 「反乱軍の魔術師」          │
│ ┃   content → 📝 (上書きあり)            │
│ ┃   所属 → 反乱軍                        │
│ ┃   [Edit] [Delete]                     │
│ ┃                                       │
│ ┃─── Ch.24 Sc.5 ────────────────────    │
│ ┃                                       │
│ ┃ ● 覚醒                                │
│ ┃   summary → 「古代魔法の継承者」         │
│ ┃   [Edit] [Delete]                     │
│ ┃                                       │
│ [+ Add phase]                           │
└─────────────────────────────────────────┘
```

#### タイムライン表示

- 縦のタイムラインUI。上が物語の始まり、下が終わり
- 最上部に「Base state」を表示（Base状態のsummary + 主要カスタムフィールド値）
- 各フェーズ間にアンカーシーンの位置を区切り線で表示（「Ch.{N} Sc.{M}」）
- 現在のエディタアクティブシーンに該当するフェーズは ◉（塗りつぶし丸）で強調。それ以外は ●（通常丸）
- 各フェーズノードには変更されたフィールドのみ表示（差分ビュー）
  - summary上書き: `summary → 「新しい値」`
  - content上書き: `content → 📝 (上書きあり)` （テキスト全文は表示しない）
  - カスタムフィールド上書き: `フィールド名 → 新しい値`
  - context_mode上書き: `context → 新しいモード`
- 各フェーズに [Edit] / [Delete] ボタン

#### [+ Add phase] ボタン

クリックでフェーズ作成ダイアログを表示（「フェーズシステム」セクションの「フェーズ作成/編集ダイアログ」参照）。

#### フェーズが0個の場合

「フェーズなし」メッセージ + 説明テキスト + [+ Add phase] ボタンのみ表示:

```
┌─────────────────────────────────────────┐
│ ⏱ Timeline                             │
│                                         │
│ フェーズが設定されていません。              │
│ フェーズを追加すると、物語の進行に          │
│ 伴うこのエントリの変化を管理できます。       │
│                                         │
│ [+ Add phase]                           │
└─────────────────────────────────────────┘
```

#### [Edit] ボタン

クリックでフェーズ編集ダイアログを表示。作成ダイアログと同一構成で、既存の値がプリフィルされる。

#### [Delete] ボタン

確認ダイアログを表示:

```
このフェーズを削除しますか？

「追放」（Ch.8 Sc.3）を削除すると、このフェーズの
上書き内容がすべて失われます。この操作は元に戻せません。

                              [キャンセル]  [削除]
```

削除実行: `codex_entry_phases` から行削除 → `codex_phase_detail_overrides` がCASCADE削除。関連する `authorship_spans`（`phase_id`）もCASCADE削除。

---

## 新規エントリ作成

### ヘッダーの [+] ボタン

クリックするとリストの先頭に新規エントリが作成され、詳細画面が即座に開く。

初期値:

| フィールド | 初期値 |
|-----------|--------|
| name | 「Untitled」（カーソルが入り即時編集可能） |
| type | `character`（デフォルト） |
| context_mode | `mentioned`（デフォルト） |
| summary | 空 |
| content | 空 |
| tags | 空 |
| custom details | 空（タイプに定義がある場合のみフィールド表示） |
| notes | 空 |

### 他パネルからの作成

**Editorの「Add to Codex」**: 選択テキストがnameになり、typeは `character` デフォルト。即時作成後、Codexパネルの詳細画面が開く（Editor設計書参照）。

**Chatの「Codex」ボタン**: ダイアログなしで即時作成。AI抽出モードではtype/name/tags を軽量モデルが自動提案、通常抽出モードではcontent のみで他は空白。`source_chat_message_id` が自動付与される（Chat設計書参照）。

---

## Codexエントリのコンテンツ保存

### 保存先

summaryはSQLiteの `codex_entries.summary` カラムに直接保存。contentもSQLiteの `codex_entries.content` カラムに直接保存。アイコン画像はDBの `codex_entries.icon` TEXTカラムにbase64 WebPデータURL文字列として格納（128×128 WebP）。

```
MyNovel.novel/
└── project.db            ← codex_entries に全データ（content, icon含む）を格納
```

### 自動保存

- summaryフィールド: デバウンス2秒でDBに保存
- contentフィールド: デバウンス2秒でDBに保存
- notesフィールド: デバウンス2秒でDBに保存
- name/type/tags/aliases/excluded_aliases変更: 即時保存

---

## DBスキーマ

DBスキーマの正規版は統合DBスキーマ設計書（`Grimodex_統合DBスキーマ.md`）を参照。以下は概要のみ記載。

主要テーブル:
- `codex_types`: タイプ定義（ビルトイン4種 + カスタム）。ビルトイン 4 種（character/location/item/lore）はプロジェクト作成時および起動時に `ensureBuiltinTypes` で確実に存在することが保証される
- `codex_entries`: エントリ本体（`context_mode`、`tags_cache`、`notes`、`children_budget` カラム含む）
- `codex_tags` / `codex_entry_tags`: 構造化タグ（多対多）
- `codex_detail_definitions` / `codex_detail_values`: カスタムディテール
- `codex_dismissed_relations`: リレーション提案のDismiss記録
- `codex_entry_phases`: フェーズ（経時的変化。アンカーシーン + フィールド上書き）
- `codex_phase_detail_overrides`: フェーズ内のカスタムフィールド上書き値。エントリ × フェーズ × フィールド（definition）の粒度で個別 override を保持する（Summary / Content / 各カスタムディテールをそれぞれ別レコードで管理）
- `codex_quick_pins`: CodexQuick パネルでの手動ピン留めを永続化するテーブル。自動検出結果とは独立して、ユーザーが明示的に Quick に固定したエントリを保持する。スキーマの詳細は [Codex Quick パネル設計書](./Grimodex_CodexQuickパネル設計書.md) を参照
- `codex_fts`: FTS5仮想テーブル（name + aliases + summary + tags_cache）。Codex マッチングパイプラインや検索バー、CodexCommandPalette の高速検索バックエンドとして利用する

FTS5テーブルはname + aliases + summary + tags_cacheを検索対象にする。contentもDBに格納されているためFTS5に追加可能だが、MVPではname + aliases + summary + tags_cacheの検索で十分と判断。

`authorship_spans` テーブルにフェーズ用カラムを追加:
- `phase_id TEXT REFERENCES codex_entry_phases(id) ON DELETE CASCADE`: フェーズの content_override に対する帰属追跡用。`codex_entry_id` が non-null かつ `phase_id` が non-null の場合はフェーズ content_override のスパン。`codex_entry_id` が non-null かつ `phase_id` が null の場合は Base content のスパン。

### API モジュール分割

Codex 系の Tauri Command 呼び出しは責務別に 5 つのフロントエンド API モジュールに分割する。いずれも Zustand ストアからのみ呼び出し、コンポーネントは直接触らない:

| モジュール | 対象 | 主なコマンド群 |
|-----------|------|--------------|
| `tagApi` | `codex_tags` / `codex_entry_tags` | タグ作成、リネーム、エントリへの付与/解除、`type_filter` 管理 |
| `phaseApi` | `codex_entry_phases` / `codex_phase_detail_overrides` | フェーズ CRUD、アンカー付け替え、フィールド override の上書き/解除 |
| `relationApi` | `codex_entries.parent_id` / `codex_dismissed_relations` | 親子設定、循環検出、Suggested の検出・Dismiss |
| `detailApi` | `codex_detail_definitions` / `codex_detail_values` | カスタムフィールド定義 CRUD、値の読み書き、型変更時の扱い |
| `typeApi` | `codex_types` | ビルトイン保証（`ensureBuiltinTypes`）、カスタムタイプ CRUD、`sort_order` 並び替え |

この分割により、1 パネル内の Tauri 呼び出しが単一の巨大モジュールに集中するのを避け、テスト・モック・変更影響範囲をドメイン単位で閉じ込める。

---

## エディタ本文内のCodexマッチング

### 設計課題

長編小説のCodexは容易に200-500エントリに達する。ファンタジー作品ではキャラクター30-50人、場所20-30箇所、アイテム20-30個、伝承・用語50-100語が珍しくない。加えて日本語テキストでは英語の `\b`（単語境界）が使えず、キャラクター名が本文に空白なしで埋もれる。これらを考慮した4段パイプラインで設計する。

### エイリアス（別名）サポート

1つのCodexエントリに複数の名前（エイリアス）を紐づけられる。

例:
- エントリ「Elara」→ aliases: `["エララ", "the apprentice"]`
- エントリ「Obsidian Tower」→ aliases: `["黒曜石の塔", "the Tower"]`

エイリアスはCodex詳細画面のnameフィールドの下に「Aliases」入力欄として表示。タグ入力と同じUIで追加/削除。エイリアスはマッチング対象に含まれ、マッチした場合は本体エントリに解決される。

DBスキーマ: `codex_entries.aliases` カラム（JSON array）。テーブル定義は「DBスキーマ」セクション参照。

### マッチングパイプライン

```
Step 1: Build automatons   ← Codex変更時のみ（低頻度）
         (match + exclusion)
Step 2: Scan text          ← テキスト変更時（デバウンス1秒）
         (2 passes: match + exclusion)
Step 3: Post-filter        ← Step 2の直後
         3a. Exclusion check
         3b. Boundary check
         3c. Longest match
Step 4: Apply decorations  ← Step 3の直後
```

#### Step 1: Aho-Corasickオートマトンの構築

全Codexエントリのname + aliasesからAho-Corasickオートマトンを構築する。Aho-Corasickは複数パターンの同時検索アルゴリズムで、パターン数に依存しないO(T)の走査時間を保証する。

```typescript
import { AhoCorasick } from 'aho-corasick';  // 例: aho-corasick-node

interface CodexPattern {
  text: string;          // マッチ対象文字列（name or alias）
  entryId: string;       // 対応するCodexエントリID
  isAlias: boolean;      // aliasか本名か
  length: number;        // 文字数（最長一致の解決用）
}

interface ExclusionPattern {
  text: string;          // 除外パターン文字列（例: "青い"）
  entryId: string;       // 対応するCodexエントリID
}

interface CodexAutomatons {
  match: AhoCorasick<CodexPattern>;       // マッチ用
  exclusion: AhoCorasick<ExclusionPattern>; // 除外用
}

function buildAutomatons(entries: CodexEntry[]): CodexAutomatons {
  const matchPatterns: CodexPattern[] = [];
  const exclusionPatterns: ExclusionPattern[] = [];

  for (const entry of entries) {
    // マッチパターン: name + aliases
    matchPatterns.push({
      text: entry.name,
      entryId: entry.id,
      isAlias: false,
      length: entry.name.length,
    });
    for (const alias of entry.aliases ?? []) {
      matchPatterns.push({
        text: alias,
        entryId: entry.id,
        isAlias: true,
        length: alias.length,
      });
    }
    // 除外パターン: excluded_aliases
    for (const excluded of entry.excluded_aliases ?? []) {
      exclusionPatterns.push({
        text: excluded,
        entryId: entry.id,
      });
    }
  }

  return {
    match: new AhoCorasick(matchPatterns),
    exclusion: exclusionPatterns.length > 0
      ? new AhoCorasick(exclusionPatterns)
      : null,  // 除外パターンがなければ構築しない
  };
}
```

構築タイミング:
- Codexエントリの追加/削除/name変更/alias変更/excluded_aliases変更時
- 構築コスト: O(sum of all pattern lengths)。マッチ+除外で合わせても1ms以下

#### Step 2: テキストの走査

マッチ用と除外用の2つのオートマトンに本文テキストを通す。それぞれ1パスでO(T)。

```typescript
interface RawMatch {
  startPos: number;      // テキスト内の開始位置
  endPos: number;        // テキスト内の終了位置
  pattern: CodexPattern; // マッチしたパターン
}

interface ExclusionMatch {
  startPos: number;
  endPos: number;
  pattern: ExclusionPattern;
}

function scanText(automatons: CodexAutomatons, text: string): {
  matches: RawMatch[];
  exclusions: ExclusionMatch[];
} {
  const matches = automatons.match.search(text);      // O(T)
  const exclusions = automatons.exclusion
    ? automatons.exclusion.search(text)                // O(T)
    : [];
  return { matches, exclusions };
}
```

パフォーマンス目安:
- 500マッチパターン + 200除外パターン x 10,000文字: ~0.8ms（2パス合計）
- 除外パターンがなければ1パスのみ: ~0.5ms

#### Step 3: ポストフィルタ

走査結果から誤マッチを除去し、最終的なマッチリストを確定する。3つのフィルタを順に適用。

**3a. 除外パターンチェック**

除外パターンのマッチ結果を使い、誤マッチを排除する。除外パターンのマッチ範囲が、マッチパターンのマッチ範囲を包含している場合、そのマッチを破棄する。

```typescript
function applyExclusions(
  matches: RawMatch[],
  exclusions: ExclusionMatch[]
): RawMatch[] {
  if (exclusions.length === 0) return matches;

  return matches.filter(match => {
    // このマッチと同じエントリIDの除外パターンのみチェック
    const relevantExclusions = exclusions.filter(
      ex => ex.pattern.entryId === match.pattern.entryId
    );
    // 除外マッチがこのマッチ位置を包含していたら除外
    return !relevantExclusions.some(
      ex => ex.startPos <= match.startPos && ex.endPos >= match.endPos
    );
  });
}
```

具体例:
- エントリ「青」、excluded_aliases: `["青い", "青の", "青く"]`
- 本文「青い空を見上げた。青は振り返った。」
- マッチ走査: 「青」が位置0, 位置10でマッチ
- 除外走査: 「青い」が位置0-2でマッチ
- 位置0の「青」は「青い」(位置0-2)に包含される → 除外
- 位置10の「青」は除外パターンに包含されない → 有効
- 結果: 「青は振り返った」の「青」のみハイライト

**3b. CJK境界チェック**

日本語テキストでは単語境界が存在しないため、独自の境界ヒューリスティックを適用する。

```typescript
function isValidBoundary(
  text: string, start: number, end: number, pattern: CodexPattern
): boolean {
  const charBefore = start > 0 ? text[start - 1] : '';
  const charAfter = end < text.length ? text[end] : '';

  return checkCharacterClassBoundary(charBefore, text[start], pattern)
      && checkCharacterClassBoundary(text[end - 1], charAfter, pattern);
}

function checkCharacterClassBoundary(
  a: string, b: string, pattern: CodexPattern
): boolean {
  if (!a || !b) return true;  // テキスト端はOK
  const classA = getCharClass(a);
  const classB = getCharClass(b);
  if (classA !== classB) return true;  // 異なるクラス → OK

  // 同じクラスの場合: 漢字クラスは特別扱い
  // 漢字2文字以上のパターンは漢字-漢字境界を許可する
  // （理由: 漢字は語の境界でも同一クラスが連続する — 佐藤|上等兵、東京|都 等）
  if (classA === 'kanji' && pattern.length >= 2) return true;

  // それ以外（カタカナ-カタカナ、ラテン-ラテン等）→ NG
  return false;
}

type CharClass = 'hiragana' | 'katakana' | 'kanji' | 'latin' | 'digit' | 'other';

function getCharClass(ch: string): CharClass {
  const code = ch.codePointAt(0)!;
  if (code >= 0x3040 && code <= 0x309F) return 'hiragana';
  if (code >= 0x30A0 && code <= 0x30FF) return 'katakana';
  if (code >= 0x4E00 && code <= 0x9FFF) return 'kanji';
  if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) return 'latin';
  if (code >= 0x30 && code <= 0x39) return 'digit';
  return 'other';
}
```

文字クラス分類:
- ひらがな (U+3040-309F)
- カタカナ (U+30A0-30FF)
- 漢字 (U+4E00-9FFF, CJK統合漢字)
- ラテン (A-Z, a-z)
- 数字 (0-9)
- その他（句読点、記号等）

境界ルール:

| 文字クラス | 同一クラス連続時の判定 | 理由 |
|-----------|---------------------|------|
| カタカナ-カタカナ | NG（境界なし扱い） | 「エララン」→ 同一語の可能性が高い |
| ラテン-ラテン | NG（境界なし扱い） | 英語の `\b` と同等 |
| ひらがな-ひらがな | NG（境界なし扱い） | 助詞連続など、語境界が曖昧 |
| **漢字-漢字（パターン2文字以上）** | **OK（境界あり扱い）** | 漢字は語の境界でも同一クラスが連続する（佐藤\|上等兵） |
| 漢字-漢字（パターン1文字） | NG（境界なし扱い） | 1文字漢字名（「青」「光」等）は誤マッチリスクが高いため厳格チェック。excluded_aliasesとの併用前提 |
| 異なるクラス同士 | OK | 常に境界とみなす |

具体例:
- 「エララが塔に向かった」→ 「エララ」マッチ。後ろは「が」(ひらがな) ≠ 「ラ」(カタカナ) → **有効**
- 「エラランの冒険」→ 「エララ」マッチ。後ろは「ン」(カタカナ) = 「ラ」(カタカナ) → **無効**（誤マッチ排除）
- 「黒曜石の塔が見えた」→ 「黒曜石の塔」マッチ。後ろは「が」(ひらがな) ≠ 「塔」(漢字) → **有効**
- 「佐藤上等兵は敬礼した」→ 「佐藤」マッチ(2文字)。後ろは「上」(漢字) = 「藤」(漢字)、**漢字2文字以上なので免除** → **有効**
- 「佐藤先生に報告した」→ 「佐藤」マッチ(2文字)。後ろは「先」(漢字)、**漢字2文字以上なので免除** → **有効**
- 「青い空を見上げた」→ 「青」マッチ(1文字)。除外パターン「青い」に包含 → **Step 3aで除外済み**
- 「青空が広がった」→ 「青」マッチ(1文字)。後ろは「空」(漢字) = 「青」(漢字)、1文字なので厳格チェック → **無効**（excluded_aliasesで「青空」を登録するか、境界チェックが防止）

**3c. 最長一致（Overlap解決）**

同じ位置範囲で複数のマッチが重なった場合、最も長いマッチを優先し、短い方を破棄する。

```typescript
function resolveOverlaps(matches: RawMatch[]): RawMatch[] {
  // 開始位置でソート、同じ開始位置なら長い方を優先
  matches.sort((a, b) => a.startPos - b.startPos || b.pattern.length - a.pattern.length);

  const result: RawMatch[] = [];
  let lastEnd = -1;
  for (const match of matches) {
    if (match.startPos >= lastEnd) {
      result.push(match);
      lastEnd = match.endPos;
    }
    // else: 前のマッチに包含されている → 破棄
  }
  return result;
}
```

例: 「Obsidian Tower」と「Tower」の両方がCodexにある場合、「Obsidian Tower」が先にマッチして「Tower」は破棄される。

#### Step 4: Decoration適用（ハイブリッド更新）

ProseMirrorのDecorationSet に反映する。ここで重要なのは**不要な再構築の回避**。ProseMirrorプラグインの `apply` メソッドで、ドキュメント変更の有無に応じてハイブリッド戦略を取る。

```typescript
// ProseMirror Plugin の apply メソッド
apply(tr, oldDecos, _oldState, newState) {
  // ドキュメント変更なし（選択、フォーマット等）→ 差分マッピングのみ
  if (!tr.docChanged && tr.getMeta("codexHighlightUpdate") !== true) {
    return oldDecos.map(tr.mapping, tr.doc);
  }

  // ドキュメント変更あり → 全再構築
  const matches = runCodexMatcher(newState.doc.textContent);
  const decos = mapMatchesToDecorations(newState.doc, matches);
  return DecorationSet.create(newState.doc, decos);
}
```

ハイブリッド更新の利点:
- ドキュメント非変更時（選択移動、フォーマット変更等）は `DecorationSet.map()` による軽量な位置マッピングのみで済む
- ドキュメント変更時のみマッチングパイプライン（Step 1-3）を再実行
- `codexHighlightUpdate` メタフラグにより、Codexエントリの変更時に明示的な再構築をトリガー可能

### Zustandストアの設計

```typescript
interface CodexMatchStore {
  // Aho-Corasickオートマトン（Codex変更時のみ再構築）
  automatons: CodexAutomatons | null;

  // scene_id → マッチ結果の配列
  sceneCodexMatches: Record<string, CodexDecoration[]>;

  // オートマトン再構築（Codex変更時に呼ぶ）
  rebuildAutomatons(): void;

  // テキスト変更時のマッチング再計算
  recomputeMatches(sceneId: string, doc: ProseMirrorNode): void;
}
```

### 再計算タイミング

| トリガー | 再構築対象 | タイミング |
|---------|-----------|-----------|
| Codexエントリの追加/削除/name変更/alias変更/excluded_aliases変更 | オートマトン再構築 → 全オープンシーンの再スキャン | 即時 |
| エディタ本文の変更 | アクティブシーンの再スキャン | デバウンス1秒 |
| アクティブシーンの切り替え | 新シーンのスキャン（キャッシュがあればスキップ） | 即時 |

### ライブラリ選定

JavaScriptで利用可能なAho-Corasick実装:

| ライブラリ | サイズ | Unicode対応 | 備考 |
|-----------|--------|-----------|------|
| `aho-corasick` (npm) | ~5KB | 部分的 | 軽量だがCJKサロゲートペアに注意 |
| `@nicolo-ribaudo/aho-corasick` | ~3KB | Yes | Babel開発者作、Unicode-safe |
| Rust実装 (Tauri Command経由) | 0KB (JS側) | Yes | `aho-corasick` crate。最高速だがIPC往復コストあり |

フロントエンドには **JS 実装と Rust 実装の 2 系統を併存** させる。

- `codexMatcher.ts`: JS 側 Aho-Corasick 実装。ビルド直後や小規模プロジェクトでの即応、テスト容易性、プラットフォーム非依存性のため常に利用可能
- `rustMatcher.ts`: Tauri Command 経由で Rust 側 `aho-corasick` crate を呼び出す高速実装。長編・多エントリ環境で JS 実装より桁違いに速く、FTS5 仮想テーブル `codex_fts` と組み合わせて全文検索／マッチングを一括で処理する

どちらを使うかはストア側で切り替え可能にし、どちらの経路でも同一のマッチ結果インターフェース（`CodexDecoration[]`）を返すことでパイプライン後段（Step 3・Step 4）を共通化する。FTS5 `codex_fts` はマッチング結果の裏付けや、検索バー・CodexCommandPalette での候補絞り込みに併用する。

### パフォーマンス見積もり

| シナリオ | マッチ数 | 除外数 | テキスト長 | 走査(2パス) | ポストフィルタ | 合計 |
|---------|---------|--------|-----------|------------|-------------|------|
| 短編 | 30 | 10 | 3,000字 | ~0.15ms | ~0.05ms | ~0.2ms |
| 中編 | 150 | 50 | 8,000字 | ~0.4ms | ~0.1ms | ~0.6ms |
| 長編 | 500 | 150 | 10,000字 | ~0.7ms | ~0.2ms | ~1ms |
| 超長編 | 1,000 | 300 | 15,000字 | ~1.0ms | ~0.3ms | ~1.5ms |

いずれもデバウンス1秒の間隔で実行されるため、UIスレッドへの影響は無視できる。オートマトン構築はマッチ+除外合わせても1ms以下。

---

## Codex Content内のCodexハイライト

### 概要

Codex詳細画面のContentフィールド（TipTapミニエディタ）にもCodexHighlight Pure Decorationを適用する。Codexエントリ同士がContent内で相互参照できるようになり、設定情報のネットワークを自然にナビゲートできる。

### 動作

- Contentフィールドに入力されたテキストに対し、エディタ本文と同じAho-Corasickパイプラインでマッチングを実行
- マッチしたCodexエントリ名をカテゴリカラーの文字色で表示（デフォルト）。Settingsで下線スタイルにも変更可能
- ホバーでポップオーバー（name、type、summary先頭100文字、「Open in Codex →」リンク）
- 「Open in Codex →」クリックで該当エントリの詳細画面に遷移

### 自エントリの除外

表示中のエントリ自身のname + aliasesはマッチング対象から除外する。「エララ」のContent内で「エララ」がハイライトされても無意味なため。

```typescript
function getExcludedPatterns(currentEntryId: string): string[] {
  const entry = codexStore.getEntry(currentEntryId);
  return [entry.name, ...(entry.aliases ?? [])];
}
```

### Editor / Chat からの逆引き制約

Codex マッチング結果は Editor と Chat の両方に供給されるが、以下の制約を守る:

- **自エントリ除外ルール**: Codex パネル内で特定エントリの Content や text カスタムディテールを編集している間、**そのエントリ自身のハイライト**は出さない（前節「自エントリの除外」）。Content に自分の名前が書かれていても、執筆中の自己参照として無視する。
- **Split mode の非アクティブグループ除外**: Editor が複数シーンを Split 表示しているとき、Codex ハイライトや Chat 送信時のコンテキスト検出は**アクティブグループのシーン**に対してのみ適用する。非アクティブ側の本文変更でハイライトや Chat 注入が誤爆しないよう、マッチング対象を明示的にフィルタする。
- **Chat 入力欄は CodexQuick 検出に影響させない**: Chat パネルの入力欄で下書き中のテキストは、本文シーンと同じ Aho-Corasick 走査を通っても **CodexQuick セクションの自動検出に寄与させない**。具体的には、CodexQuick 側マッチャを呼ぶ際に Chat 入力欄由来のマッチ id 集合を `skipMatchedIds` として渡し、Quick の表示対象から除外する。Chat 側のコンテキスト注入には通常どおり利用する。

### パフォーマンス

ContentのテキストはSceneの本文（数千〜数万文字）に比べて短い（典型的に500〜2,000文字）。既存のAho-Corasickオートマトンをそのまま使い回せるため、追加のパフォーマンスコストはほぼゼロ。

---

## エントリ間リレーション

### 概要

Codexエントリ間に親子関係（リレーション）を設定できる。キャラクターと所持アイテム、場所とそこに関連する伝承、組織と所属メンバーなどの構造化に使う。

リレーションの主な用途:
1. **ナビゲーション**: 詳細画面で関連エントリに素早く移動
2. **コンテキスト注入**: 親エントリがChatに注入される場合、子孫エントリのsummaryをサブツリートークン予算内でBFS順に自動注入

### リレーションモデル

- 1つのエントリは最大1つの親を持てる（多対1）
- 1つのエントリは0個以上の子を持てる（1対多）
- 循環参照は禁止（A→B→C→Aのようなループ）
- 深さに制限はない。コンテキスト注入はサブツリートークン予算（Layer 4予算に対する比率、デフォルト: compact 15%）で制御され、BFS順で注入する

```
Elara (character)                       children_budget: compact (15%)
├── Soulbind Amulet (item)         ← 子（BFS depth 1、優先注入）
├── Binding Mark (lore)            ← 子（BFS depth 1、優先注入）
└── Elara's Journal (item)         ← 子（BFS depth 1、優先注入）
      └── Journal Entry #3 (lore)  ← 孫（BFS depth 2、予算が残っていれば注入）

Obsidian Tower (location)               children_budget: compact (15%)
├── Binding Chamber (location)     ← 子
└── Warding Stones (item)          ← 子
```

### DBスキーマ

隣接リストモデル（`codex_entries.parent_id`）。テーブル定義は「DBスキーマ」セクション参照。

循環参照防止はアプリケーション層でバリデーション:

```typescript
function canSetParent(entryId: string, newParentId: string): boolean {
  // newParentIdからルートまで辿り、entryIdが現れたら循環
  let current = newParentId;
  while (current) {
    if (current === entryId) return false;  // 循環検出
    current = codexStore.getEntry(current)?.parent_id;
  }
  return true;
}
```

### リレーションの設定方法

**詳細画面から**:
- Relations セクション → [+ Add child] → Codexエントリ検索UI（コマンドパレット風）→ 選択で子として追加
- Parent行の [Set parent] → 同様の検索UIで親を設定

**エントリリストからD&D**:
- エントリカードを別のエントリカードの上にドロップ → ドロップ先の子として追加
- 視覚的フィードバック: ドロップ先がハイライト、インデント表示

**リレーション提案から**:
- Suggestedセクションの [+ Add] → 即座に子リレーションとして確定

### コンテキスト注入への影響

Chatパネルのコンテキスト注入Layer 4で、親エントリが注入対象になった場合、**子孫エントリのsummaryをサブツリートークン予算の範囲内でBFS（幅優先）順に自動注入する**。

#### サブツリートークン予算

深さ（depth）ではなく、**親エントリごとのトークン予算**で子孫注入を制御する。これにより「子が少なく深い構造」と「子が多く浅い構造」の両方に一貫して対応できる。

- 各エントリの `children_budget` カラムで、**Layer 4予算に対する比率**（プリセット）を指定
- 実行時にモデルのコンテキスト上限からLayer 4予算を算出し、比率を掛けて実トークン数を決定
- BFS順（depth 1 → depth 2 → ...）で注入するため、直接の子が優先される
- 予算到達で打ち切り。depth制限は設けない（予算が自然な制限として機能する）
- 手動ピン（「Pin with children」操作）は予算を無視する（ユーザーの明示的意図）

**比率のモデル別実効値の例**（Compact 15%の場合）:

| モデル | コンテキスト | Layer 4予算(~20%) | Compact実効値 |
|--------|------------|-------------------|-------------|
| Ollama llama3 (8k) | 8,000 | 1,600 | 240 tok (~1件) |
| GPT-4o (128k) | 128,000 | 25,600 | 3,840 tok (~19件) |
| Claude Sonnet (200k) | 200,000 | 40,000 | 6,000 tok (~30件) |
| Claude Opus (1M) | 1,000,000 | 200,000 | 30,000 tok (~150件) |

```typescript
function resolveChildrenBudget(entry: CodexEntry, layer4Budget: number): number {
  // children_budget はプリセット名を格納。Layer 4予算に対する比率で実トークン数を算出
  const ratios: Record<string, number> = {
    none: 0, compact: 0.15, standard: 0.30, generous: 0.50
  };
  return Math.floor(layer4Budget * (ratios[entry.children_budget] ?? 0.15));
}

function injectDescendants(parentId: string, budget: number): DescendantContext[] {
  const results: DescendantContext[] = [];
  let remaining = budget;
  const visited = new Set<string>();
  const queue = codexStore.getChildren(parentId);  // depth 1 を先頭に

  while (queue.length > 0 && remaining > 0) {
    const child = queue.shift()!;
    if (visited.has(child.id)) continue;
    visited.add(child.id);

    // 子エントリも個別にcontext_modeを判定（親のモードは伝播しない）
    if (child.context_mode === 'hidden') continue;
    if (child.context_mode === 'suppress' && !isPinned(child.id)) continue;

    const tokens = estimateTokens(child.summary || child.content);
    if (tokens > remaining) break;  // 予算不足で打ち切り

    results.push({ entry: child, tokens, depth: getDepthFrom(parentId, child.id) });
    remaining -= tokens;

    // depth 2+ の子を末尾に追加（BFS: 幅優先で深掘り）
    queue.push(...codexStore.getChildren(child.id));
  }

  return results;
}

function buildCodexContext(matchedEntryIds: string[]): string {
  const contextParts: string[] = [];
  const injectedIds = new Set<string>();

  for (const entryId of matchedEntryIds) {
    const entry = codexStore.getEntry(entryId);
    if (injectedIds.has(entryId)) continue;

    // 親エントリのsummary（またはpin時はcontent全文）
    // summaryが未記入の場合はcontent全文をフォールバック
    contextParts.push(formatEntryContext(entry));
    injectedIds.add(entryId);

    // 子孫エントリをサブツリートークン予算内でBFS注入
    const childBudget = resolveChildrenBudget(entry, layer4Budget);
    const descendants = injectDescendants(entryId, childBudget);
    for (const desc of descendants) {
      if (injectedIds.has(desc.entry.id)) continue;
      contextParts.push(formatChildContext(desc.entry));  // summaryのみ
      injectedIds.add(desc.entry.id);
    }
  }

  return contextParts.join('\n\n');
}
```

**フェーズ解決との統合**: エントリにフェーズが設定されている場合、注入されるsummary・content・カスタムディテール・context_modeはすべて**フェーズ解決後の値**が使用される。詳細は「フェーズシステム（経時的変化）」セクションの「AIコンテキスト注入への統合」参照。

**注入ルール**:

| 注入トリガー | 親エントリ | 子孫エントリ（自動注入） |
|-------------|-----------|----------------------|
| 自動検出（シーン本文にnameが出現） | フェーズ解決後のsummary + カスタムディテール（include_in_context=1）。**summaryが未記入の場合はフェーズ解決後のcontent全文をフォールバック** | フェーズ解決後のsummaryをBFS順に `children_budget`（デフォルト: compact = Layer 4の15%）まで注入 |
| チャットメッセージ内で言及 | **自動ピン留め**: フェーズ解決後のcontent全文 + カスタムディテール（include_in_context=1） | フェーズ解決後のsummaryをBFS順に `children_budget` まで注入 |
| ピン留め（手動） | フェーズ解決後のcontent全文 + カスタムディテール（include_in_context=1） | フェーズ解決後のsummaryをBFS順に `children_budget` まで注入 |
| Pin with children（手動） | content全文 + カスタムディテール | **予算無視**: 直接子のcontent全文を注入（個別除外可能） |

**context_mode による制御**:

注入の前段として、各エントリの `context_mode` を判定する:

```
1. hidden → 注入リストから除外（ピンリストにあっても除外）
2. always → 自動検出の有無に関わらず注入リストに追加
3. mentioned → 現行ロジック（自動検出時のみ）
4. suppress → 自動検出結果から除外。ピンリストに存在する場合のみ注入
5. 子エントリも個別にcontext_modeを判定（親のモードは伝播しない）
```

**カスタムディテールの注入**: `include_in_context = 1` のフィールドの値をsummaryに付加してコンテキストに含める。`codex_reference` フィールドは参照先エントリのnameに解決して表示。

**codex_reference 循環参照防止:**

`codex_reference` フィールドを通じた参照チェーン（A→B→C→...）は深度3を上限とする。コンテキスト注入時に訪問済みエントリIDの `Set` を管理し、以下のルールを適用する:

- 深度 > 3 または既訪問IDに到達した場合 → そのエントリの注入をスキップ
- 循環が検出された場合（A→B→A等）→ 2回目の訪問をスキップ

これにより、A.ref→B、B.ref→A のような相互参照でも無限ループが発生しない。

**トークン予算の制御**:

Layer 4全体のトークン予算を超過する場合の優先順位:
1. `always` エントリのsummary + カスタムディテール（最優先）
2. 本文に直接出現するエントリのsummary + カスタムディテール
3. ピン留めされたエントリのcontent + カスタムディテール
4. 自動注入された子孫エントリのsummary（最初に切り詰め対象）

サブツリートークン予算はエントリ単位の制御であり、Layer 4全体の予算とは独立して適用される。Layer 4全体の予算超過時には、まず優先順位4（子孫エントリ）から切り詰める。

Chatパネルのコンテキストバーには、自動注入された子孫エントリもピルとして表示する。ただし通常のピルとは異なるスタイル（薄い表示 + 「via {親名}」ラベル）で区別し、×で個別除外も可能。`always` エントリは常にピルとして表示（薄いスタイル + 「auto」ラベル）。`hidden` エントリはピンダイアログに表示しない。

---

## Content言及からのリレーション提案

### 概要

Content内のCodexハイライトで検出されたエントリを、リレーションの「候補」として提案する。ただし、**自動的にリレーションを形成しない**。ユーザーが確認して手動で追加する。

### 提案ロジック

```typescript
function getSuggestedRelations(entryId: string): CodexEntry[] {
  const entry = codexStore.getEntry(entryId);
  const contentText = getContentText(entryId);

  // Content内でマッチしたCodexエントリ
  const mentionedIds = matchCodexInText(contentText, [entryId]);  // 自身を除外

  // 既にリレーション済み（parent/children）のエントリを除外
  const existingRelationIds = new Set([
    entry.parent_id,
    ...codexStore.getChildren(entryId).map(c => c.id),
  ].filter(Boolean));

  // Dismissされた候補を除外
  const dismissedIds = getDismissedSuggestions(entryId);

  return mentionedIds
    .filter(id => !existingRelationIds.has(id) && !dismissedIds.has(id))
    .map(id => codexStore.getEntry(id));
}
```

### UI

Relationsセクションの下部に「Suggested」サブセクションとして表示:

```
Suggested: (from Content)
  ○ Obsidian Tower       location  [+ Add] [×]
  ○ Age of Binding       lore      [+ Add] [×]
```

- ○（白丸）で確定済みリレーション（●）と視覚的に区別
- [+ Add] で子リレーションとして確定
- [×] でDismiss（非表示にする。`codex_dismissed_relations` テーブルに記録）
- Content変更時に自動再計算

### 自動リレーションを採用しない理由

Content内で言及されたエントリを自動的にリレーションにすると:

1. **コンテキスト爆発**: 「カゾルミア帝国」のContentに20エントリが言及されていたら、帝国が登場するだけで大量のエントリが自動注入される（サブツリートークン予算でリレーション経由の注入は制御されるが、Content言及は別経路であり制御外）
2. **再帰問題**: 子エントリのContent内にさらに別のエントリが言及されていると、間接的に大量のエントリが巻き込まれる
3. **意図しない関係**: Content内で「エララは黒曜石の塔とは無関係の村で育った」と書いてあっても、「黒曜石の塔」がマッチして子リレーションになってしまう

提案にとどめることで、ユーザーが「この関係は本当にAIに伝えるべきか」を判断してから確定する動線になる。

### Dismiss永続化

```sql
CREATE TABLE codex_dismissed_relations (
  entry_id     TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  dismissed_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, dismissed_id)
);
```

---

## フェーズシステム（経時的変化）

### 概要

小説では物語の進行に伴いキャラクターの所属や能力、場所の状態、アイテムの所有者などが変化する。フェーズシステムは、Codexエントリの状態が物語のどの時点でどう変わるかを構造化して管理し、AIコンテキスト注入にシーン適切な状態を反映する機能。

フェーズがないエントリは現行と完全に同じ動作であり、既存のコードに影響しない（後方互換）。

### コアコンセプト

**フェーズ（Phase）**は「物語上のある時点からの状態変化」を表す。各フェーズはアンカーシーン（変化が発生するシーン）に紐づき、変化するフィールドの上書き値を持つ。

```
Elara (character)
├── Base state: 「塔の見習い魔術師」所属=白銀騎士団
├── Phase 1 [Ch.8 Sc.3 "追放"]: summary→「塔を追われた元見習い」所属=なし
├── Phase 2 [Ch.15 Sc.1 "反乱参加"]: summary→「反乱軍の魔術師」所属=反乱軍
└── Phase 3 [Ch.24 Sc.5 "覚醒"]: summary→「古代魔法の継承者」
```

あるシーンでのエントリの有効状態は、そのシーン以前の全フェーズを順に適用した結果:

```
シーン5を執筆中  → Base state（Phase 1 はCh.8以降なので未適用）
シーン10を執筆中 → Base + Phase 1 適用
シーン20を執筆中 → Base + Phase 1 + Phase 2 適用
シーン30を執筆中 → Base + Phase 1 + Phase 2 + Phase 3 適用
```

### 上書き対象フィールド

| フィールド | 上書き対象 | 理由 |
|-----------|----------|------|
| summary | **対象** | 最頻変化。AIコンテキストへの影響大 |
| content | **対象** | 詳細な背景設定の変化。ProseMirror JSON |
| カスタムフィールド | **対象** | 所属/称号/能力などの構造化データ |
| context_mode | **対象** | 「Ch.20以降は隠しキャラをAIに見せる」等 |
| name / aliases | **対象外** | 変更するとマッチングが崩壊する。aliasで対応可能 |
| tags | **対象外** | メタ管理用であり物語内変化ではない |
| notes | **対象外** | プライベートメモは時系列管理不要 |

### DBスキーマ

DBスキーマの正規版は [統合DBスキーマ設計書](./Grimodex_統合DBスキーマ.md) を参照。Phase 関連テーブルと関連カラムの要点のみ記載。

主要テーブル / カラム:
- `codex_entry_phases`: Phase本体。`anchor_node_id` (Scene)、`label`、`summary_override` / `content_override` / `context_mode_override`。
- `codex_phase_detail_overrides`: Phase 内のフィールド単位 override。複合 PK `(phase_id, definition_id)`。**粒度はエントリ × フェーズ × フィールドで、Summary / Content / 各カスタムディテールをそれぞれ独立に override できる**（ある Phase で Summary だけ上書きする、別 Phase では Content とカスタムフィールド A だけ上書きする、といった構成が可能）。未上書きフィールドは直前の Phase もしくは Base の値を継承する。
- `tree_nodes.story_time_order` (TEXT NULL): Sceneの作中時間順序キー。`sort_order` と同じ **文字列 fractional indexing**（npm `fractional-indexing` 互換）で、SQLite の `COLLATE BINARY` による辞書順比較のみを使う。数値としての意味は持たない。
- `tree_nodes.story_time_label` (TEXT NULL): Sceneの作中時間表示用ラベル。
- `projects.phase_resolution_mode` (TEXT): `'auto' | 'reading' | 'story'`。SQLデフォルト `'reading'`、新規プロジェクトのアプリ層デフォルトは `'auto'`。
- `authorship_spans.phase_id`: Phaseの content_override への帰属追跡用。

上書きセマンティクス:
- `summary_override`: NULL = 変更なし（前のフェーズ/Baseを継承）。空文字 = summaryを空にクリア。
- `content_override`: NULL = 変更なし。ProseMirror JSON形式。
- `context_mode_override`: NULL = 変更なし。値は `always` / `mentioned` / `suppress` / `hidden`。
- `anchor_node_id`: `ON DELETE SET NULL` — アンカーシーン削除時はNULLになり、Phaseは無効化（UIで警告表示）。

**Phase と時間軸の関係（設計不変条件）**:
- **Phase の anchor は常に Scene**。「作中時間」への切り替えは、アンカーを書き換えるのではなく、同じアンカーを異なる軸で並べ替えることで行う。
- **Phase 解決で使う時間軸は 2 つのみ**: 読者順（`tree_nodes.sort_order` の DFS 展開）、作中時間（`tree_nodes.story_time_order`）。
- **write-order（`created_at` 順）は Phase 解決に使わない**。後から書いたシーンが過去の Phase を書き換えてしまうため意図と合わず、UI 選択肢にも出さない。
- Phase・Scene・Beat・時間軸の関係の全体像は [Timeline パネル設計書](./Grimodex_Timelineパネル設計書.md) を参照。

### シーン順序の解決（タイムライン計算）

Phase 解決には「シーン A がシーン B より前か」を判定するグローバル順序が必要だが、`tree_nodes` はツリー構造（Folder/Scene の再帰ツリー）であり、かつ 2 本の時間軸（読者順 / 作中時間）を持つ。どちらの軸で並べるかは `projects.phase_resolution_mode` が決める。

#### 2 つの時間軸

| 軸 | ソースカラム | 特性 |
|----|------------|------|
| 読者順 (reading-order) | `tree_nodes.sort_order` を DFS 展開したグローバル順を Index 構築時に連番 `number` に投影 | 全 Scene に常に値が存在（欠損なし） |
| 作中時間 (story-time) | `tree_nodes.story_time_order`（文字列 fractional indexing キー、辞書順比較） | NULL 許容。未設定 Scene は「時間軸未宣言」 |

write-order（`created_at` 順）は**意図的に除外**する（Phase と時間軸の関係、前節参照）。

#### `getSceneTime(sceneId, mode)`

各 Scene を「軸 + 値」の組に写像する関数。値は同じ軸同士でのみ比較する（数値そのものではなく、軸付きの値として扱う）。

```typescript
type TimeAxis = 'reading' | 'story';
type ResolutionMode = 'auto' | 'reading' | 'story';

// 読者順は Index 構築時に連番化した number、story-time は fractional-indexing の文字列キーを使う。
// 軸ごとに値の型が異なるため、判別可能ユニオンにする。比較は `compareSceneTime` 経由で行う。
type SceneTime =
  | { axis: 'reading'; value: number }
  | { axis: 'story'; value: string };

interface SceneTimeIndex {
  readingOrder: Map<string, number>;       // 全 Scene に存在（DFS 展開時の連番）
  storyTimeOrder: Map<string, string>;     // story_time_order が設定されている Scene のみ
  storyTimeInherited: Map<string, string>; // story モード時、未設定 Scene に直前の story-time を継承した表
}

function getSceneTime(
  sceneId: string,
  mode: ResolutionMode,
  index: SceneTimeIndex,
): SceneTime | null {
  switch (mode) {
    case 'reading': {
      const v = index.readingOrder.get(sceneId);
      return v === undefined ? null : { axis: 'reading', value: v };
    }
    case 'story': {
      // 未設定 Scene は直前の story_time_order を継承（inherited テーブル参照）
      const v = index.storyTimeInherited.get(sceneId);
      return v === undefined ? null : { axis: 'story', value: v };
    }
    case 'auto': {
      // 自 Scene に story_time_order があれば story 軸、なければ reading 軸にフォールバック
      const s = index.storyTimeOrder.get(sceneId);
      if (s !== undefined) return { axis: 'story', value: s };
      const r = index.readingOrder.get(sceneId);
      return r === undefined ? null : { axis: 'reading', value: r };
    }
  }
}

// 同一軸の SceneTime 同士の比較。軸が異なる値を渡した場合は呼び出し側のバグ。
function compareSceneTime(a: SceneTime, b: SceneTime): number {
  if (a.axis !== b.axis) {
    throw new Error('compareSceneTime: axis mismatch');
  }
  if (a.axis === 'reading') {
    return a.value - (b.value as number);
  }
  // story 軸: 文字列 fractional indexing キーの辞書順比較
  const av = a.value;
  const bv = b.value as string;
  return av < bv ? -1 : av > bv ? 1 : 0;
}
```

#### `SceneTimeIndex` の構築

```typescript
function buildSceneTimeIndex(nodes: TreeNode[]): SceneTimeIndex {
  const readingOrder = new Map<string, number>();
  const storyTimeOrder = new Map<string, string>();
  const storyTimeInherited = new Map<string, string>();

  // 1. 読者順: ツリーDFS。sort_order も文字列 fractional indexing キーなので辞書順で比較する。
  let i = 0;
  const dfs = (parentId: string | null) => {
    const children = nodes
      .filter(n => n.parentId === parentId)
      .sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : 0));
    for (const child of children) {
      if (child.nodeType === 'scene') {
        readingOrder.set(child.id, i++);
        if (child.storyTimeOrder !== null) {
          storyTimeOrder.set(child.id, child.storyTimeOrder);
        }
      }
      dfs(child.id);
    }
  };
  dfs(null);

  // 2. 読者順に走査しつつ、直前の story_time_order を継承して inherited テーブルを作る
  let lastStory: string | null = null;
  const sortedByReading = [...readingOrder.entries()].sort((a, b) => a[1] - b[1]);
  for (const [sceneId] of sortedByReading) {
    const explicit = storyTimeOrder.get(sceneId);
    if (explicit !== undefined) {
      lastStory = explicit;
    }
    if (lastStory !== null) {
      storyTimeInherited.set(sceneId, lastStory);
    }
    // lastStory がまだ null（作品冒頭の未設定シーン）は inherited に入れない → story モードで解決不可と扱う
  }

  return { readingOrder, storyTimeOrder, storyTimeInherited };
}
```

#### 軸不一致時のフォールバック（all-or-nothing）

Phase アンカーシーンと currentScene で**軸が食い違う**ことがある（例: `mode=story` だがアンカーシーンに `story_time_order` が未設定で、かつ作品冒頭で継承元もない）。story-time の値（文字列 fractional indexing キー）と reading-order の値（DFS 連番 number）は別の値空間にあり、型も異なるため混在ソートが意味を持たない。そのため**エントリ単位の all-or-nothing フォールバック**を採用する:

- エントリ内の全 Phase のアンカーが currentScene と同じ軸で引けるなら、その軸で解決する
- 1 つでも軸不一致があれば、そのエントリの **全 Phase を reading-order にフォールバック**して解決する（story-time 値と reading-order 値を混ぜない）
- reading-order すら引けない Phase（anchor 削除済み）は単にスキップする

これにより「story モード時でも、story_time_order が未設定のシーンをまたぐ Phase があれば、そのエントリは読者順に沿って解決される」という安全側の挙動になる。フォールバックの粒度は **Phase 単位ではなくエントリ単位**である点に注意。

**キャッシュ戦略**: `SceneTimeIndex` はツリー構造変更時（ノード追加/削除/移動）または `story_time_order` 変更時に再計算。Zustand ストアに保持。`phase_resolution_mode` の変更は Index 自体の再計算を伴わない（どの Map を引くかが変わるだけ）。

### 状態解決アルゴリズム

#### フェーズ解決パイプライン（2 段構成）

フェーズ解決は `phaseResolver` モジュール内で 2 段のパイプラインとして実装される:

1. **`phaseResolver.computeSceneTimeIndex(nodes)`**: ツリー構造と `tree_nodes.story_time_order` から `SceneTimeIndex`（`readingOrder` / `storyTimeOrder` / `storyTimeInherited`）を構築する。ツリー変更・`story_time_order` 変更のときだけ再計算し、Zustand ストアにキャッシュする。
2. **`resolveCodexState(entry, phases, phaseDetails, baseDetails, currentSceneId, sceneTimeIndex, resolutionMode)`**: 構築済み Index と現在シーンから `ResolvedCodexState`（summary / content / contextMode / detailValues + activePhaseId / label）を返す。`projects.phase_resolution_mode`（`reading` / `story` / `auto`）を尊重して軸を選択し、必要なら all-or-nothing で reading-order にフォールバックする。

呼び出し元:

- **Editor**: エディタ本文中の CodexHighlight ポップオーバーや Chat 連携時に、アクティブシーンに応じた解決結果を使う
- **Chat（シーンスコープ / プロジェクトスコープ）**: Layer 4 のコンテキスト注入でフェーズ解決後の summary / content を使う
- **Codex パネル Details タブ**: フェーズインジケーターの自動選択および Phase プレビューモードで `resolvedState` を参照
- **Timeline パネル**: 各エントリの Phase 軌跡表示と、アクティブシーンでの activePhase 強調

`resolveCodexState` は override された詳細値（summary / content / カスタムディテール）を個別に取得できるため、UI 側では「Base と何が違うか」をフィールド単位で表示できる（Details タブのフェーズインジケーターに利用）。

```typescript
interface ResolvedCodexState {
  summary: string;
  content: string | null;
  contextMode: ContextMode;
  detailValues: Map<string, string>;  // definitionId → value
  activePhaseId: string | null;       // 適用中のフェーズID（UI表示用）
  activePhaseLabel: string | null;
}

function resolveCodexState(
  entry: CodexEntry,
  phases: CodexEntryPhase[],
  phaseDetails: Map<string, PhaseDetailOverride[]>,  // phaseId → overrides
  baseDetails: Map<string, string>,                   // definitionId → value
  currentSceneId: string | null,
  sceneTimeIndex: SceneTimeIndex,
  resolutionMode: ResolutionMode,                     // projects.phase_resolution_mode
): ResolvedCodexState {
  // 1. Base state
  const state: ResolvedCodexState = {
    summary: entry.summary ?? '',
    content: entry.content,
    contextMode: entry.contextMode,
    detailValues: new Map(baseDetails),
    activePhaseId: null,
    activePhaseLabel: null,
  };

  if (!currentSceneId) return state;

  // 2. 現在シーンの時間軸上の位置を決定
  const currentTime = getSceneTime(currentSceneId, resolutionMode, sceneTimeIndex);
  if (currentTime === null) return state;

  // 3. 各フェーズのアンカーシーンも同じモードで引き、「現在シーンと軸が揃うか」を判定する。
  //    一つでも軸不一致があれば、このエントリは **エントリ単位で reading-order にフォールバック** して
  //    全フェーズをまとめて reading-order で解決する（all-or-nothing フォールバック）。
  //    これは story-time 値（文字列）と reading-order 値（数値）が別の値空間のため、混在ソートが意味を持たないため。
  const anchorTimes = phases.map(p => ({
    phase: p,
    time: getSceneTime(p.anchorNodeId, resolutionMode, sceneTimeIndex),
  }));
  const hasAxisMismatch = anchorTimes.some(
    x => x.time === null || x.time.axis !== currentTime.axis,
  );

  // 4. 比較に使う SceneTime を軸を揃えて作る。story 軸は文字列キー、reading 軸は数値。
  let currentCompareTime: SceneTime;
  const phaseCompareTimes: { phase: CodexEntryPhase; time: SceneTime }[] = [];
  if (hasAxisMismatch) {
    // エントリ単位で reading-order フォールバック
    const cR = sceneTimeIndex.readingOrder.get(currentSceneId);
    if (cR === undefined) return state;
    currentCompareTime = { axis: 'reading', value: cR };
    for (const { phase } of anchorTimes) {
      const v = sceneTimeIndex.readingOrder.get(phase.anchorNodeId);
      if (v !== undefined) phaseCompareTimes.push({ phase, time: { axis: 'reading', value: v } });
      // reading-order も引けないフェーズは anchor 削除済みのためスキップ
    }
  } else {
    currentCompareTime = currentTime;
    for (const { phase, time } of anchorTimes) {
      if (time !== null) phaseCompareTimes.push({ phase, time });
    }
  }

  // 5. 適用可能フェーズ（アンカー位置 ≤ 現在位置）をその軸の順序でソート。
  //    比較は `compareSceneTime`（reading 軸は数値、story 軸は文字列 fractional indexing キーの辞書順）。
  //    tie-break は「アンカーシーンの reading-order → created_at」の順。
  //    これによりパラレルストーリー等で同じ story_time_order を持つ異なるシーンの
  //    Phase 同士でも決定的な順序になる。
  const applicablePhases = phaseCompareTimes
    .filter(x => compareSceneTime(x.time, currentCompareTime) <= 0)
    .sort((a, b) => {
      const diff = compareSceneTime(a.time, b.time);
      if (diff !== 0) return diff;
      const ra = sceneTimeIndex.readingOrder.get(a.phase.anchorNodeId) ?? 0;
      const rb = sceneTimeIndex.readingOrder.get(b.phase.anchorNodeId) ?? 0;
      if (ra !== rb) return ra - rb;
      return a.phase.createdAt.localeCompare(b.phase.createdAt);
    })
    .map(x => x.phase);

  // 6. フェーズを順に適用（上書きがあるフィールドのみ）
  for (const phase of applicablePhases) {
    if (phase.summaryOverride !== null) {
      state.summary = phase.summaryOverride;
    }
    if (phase.contentOverride !== null) {
      state.content = phase.contentOverride;
    }
    if (phase.contextModeOverride !== null) {
      state.contextMode = phase.contextModeOverride;
    }
    const overrides = phaseDetails.get(phase.id) ?? [];
    for (const ov of overrides) {
      state.detailValues.set(ov.definitionId, ov.value);
    }
    state.activePhaseId = phase.id;
    state.activePhaseLabel = phase.label;
  }

  return state;
}
```

**軸切り替え・不一致時の挙動まとめ**:

| ケース | 挙動 |
|-------|------|
| `mode = 'reading'` | 常に `sort_order` の DFS 展開で比較。`story_time_order` は参照しない |
| `mode = 'story'`、全 Scene に story_time_order が設定済み | 作中時間で比較。パラレルストーリー等で同値の Scene は reading-order がタイブレイクに入る（同値 Scene 間で Phase 順序がぶれないよう、tie-break は `anchor_scene` の reading-order → `created_at` の順） |
| `mode = 'story'`、一部 Scene が未設定 | 未設定 Scene は直前の `story_time_order` を継承（冒頭の未設定連続領域のみ `storyTimeInherited` に入らない）。Phase のどれか 1 つでも軸不一致（null or reading）になれば、**そのエントリの全 Phase を reading-order で解決**（all-or-nothing フォールバック） |
| `mode = 'auto'` | Scene 単位で軸を決める（自 Scene の `story_time_order` が設定済みなら story、なければ reading）。エントリ内で軸が混在する場合は **エントリ単位で reading-order に all-or-nothing フォールバック**（story-time 値と reading-order 値を混ぜない） |
| フラッシュバック Phase | `story_time_order` を過去値で設定すれば、作中時間上は過去に適用される。読者が該当シーンを読むまでは UI 上 Inactive 表示（Timeline パネル側で表現） |

### Content上書きの仕様

#### 保存

- フェーズ適用中にContentフィールドを編集 → `codex_entry_phases.content_override` に保存
- Base状態でContentを編集 → 従来通り `codex_entries.content` に保存
- 自動保存（デバウンス2秒、既存のContent保存と同一動線）

#### content_override の初期値

- フェーズ作成時に「Contentを上書き」チェックを入れた場合、前のフェーズの content_override（またはBase content）をコピーして初期値とする。ゼロから書き直すより、既存を編集するほうが自然なため
- チェックを入れなかった場合: `content_override = NULL`（前のフェーズ/Baseを継承）

#### Open in Editor ↗

- フェーズ適用中は content_override をエディタタブで開く
- エディタタブのタイトル: 「{エントリ名} — {フェーズラベル}」（例: 「Elara — 反乱参加」）
- 保存先は `codex_entry_phases.content_override`（BaseのcontentではなくフェーズのDBレコード）
- Codexパネル内のミニエディタとエディタタブのcontent_overrideは同一レコードを参照しており、一方の変更が他方に即時反映される

#### CodexHighlight

フェーズ適用中のcontent_overrideに対しても既存のAho-Corasickパイプラインがそのまま動作する。自エントリ除外ルールも同様。追加実装は不要。

#### Attribution追跡

`authorship_spans` テーブルの `phase_id` カラムでフェーズ別の帰属追跡を実現する:

| codex_entry_id | phase_id | 対象 |
|----------------|----------|------|
| non-null | null | Base contentのスパン |
| non-null | non-null | フェーズ content_override のスパン |

- フェーズ削除時は `phase_id` が CASCADE 削除され、関連するスパンも自動削除
- Attribution追跡の動作（AiEditedPlugin、AuthorshipMark体系）はBase contentと同一

#### AIコンテキスト注入でのcontent

既存ルール「summaryが空ならcontent全文をフォールバック」はフェーズ解決後の値に適用される:

- フェーズ解決後のsummaryが空 → フェーズ解決後のcontentでフォールバック
- フェーズがcontent_overrideを持つ場合はそのcontentが使われる

### フェーズ作成/編集ダイアログ

```
┌─────────────────────────────────────────────────┐
│ Add Phase                                  [×]  │
├─────────────────────────────────────────────────┤
│                                                 │
│ Label:        [追放後                       ]   │
│ Anchor scene: [Ch.8 Sc.3 "追放される日"   ▾]   │
│               ⏱ story-time: 帝国暦1024年3月     │
│               📖 reading-order: #47             │
│                                                 │
│ ─── Override fields ───                         │
│                                                 │
│ [✓] Summary                                     │
│     [塔を追われた元見習い              ]         │
│                                                 │
│ [✓] Content                                     │
│     初期値: 前フェーズの内容をコピー             │
│     (保存後にContent editorで編集可能)           │
│                                                 │
│ [✓] 所属勢力                                     │
│     [(空欄)                          ▾]         │
│                                                 │
│ [ ] 種族                                         │
│ [ ] 身長                                         │
│                                                 │
│ [ ] Context mode                                │
│                                                 │
│ Resolution: auto（作中時間で解決）              │
│                                                 │
│                         [Cancel]  [Save]        │
└─────────────────────────────────────────────────┘
```

| 要素 | 説明 |
|------|------|
| Label | フェーズのラベル（例: 「追放後」「覚醒後」）。必須 |
| Anchor scene | フェーズの開始シーン。ツリーセレクターで選択（Folder > ... > Scene の階層表示）。必須 |
| Story-time / Reading-order 行 | Anchor scene を選ぶと、そのシーンの `story_time_label`（設定されていれば）と読者順インデックスを表示。作中時間が未設定の場合は「⏱ story-time: —（未設定）」と明示し、story モード時は「→ reading-order で解決されます」と注記 |
| Resolution 行 | プロジェクトの `phase_resolution_mode` と、その軸で現在どう解決されるかを表示（読み取り専用、プロジェクト設定へのリンク付き） |
| Override fields | チェックボックスで上書き対象フィールドを選択。チェックなし = 前のフェーズ/Baseから継承 |

- Summary: テキスト入力欄（チェック時に表示）
- Content: チェック時に前フェーズ/Baseのcontentをコピーして初期化。ダイアログ内ではインライン編集せず、保存後にDetailsタブのContent editorで編集
- カスタムフィールド: `codex_detail_definitions` から現在のタイプのフィールドを動的生成。フィールドタイプに応じたUI（text/dropdown/codex_reference）
- Context mode: ドロップダウン（always/mentioned/suppress/hidden）

**バリデーション**:
- Label は必須
- Anchor scene は必須
- 同一エントリ内で同じアンカーシーンのフェーズは複数作成可能（同一シーンで複数の変化を記録する場合。UI上では作成順で並ぶ）
- 少なくとも1つのフィールドが上書き対象として選択されていること

**編集時**: 既存の値がプリフィルされる。Override fields のチェックを外すと、そのフィールドの上書きが解除される（NULL に戻る）。Content の上書きチェックを外す場合、content_override が破棄される旨の確認ダイアログを表示。

### AIコンテキスト注入への統合

#### シーンスコープChat

シーンスコープのChat（`isGlobalChat = false`）では、アクティブシーンに基づいてフェーズ解決済みの状態をコンテキストに注入する。

注入フローの変更点:

```
既存: entry.summary → formatEntryContext(entry) → コンテキスト文字列
新規: resolveCodexState(entry, phases, currentSceneId) → resolved.summary → formatEntryContext(entry, resolved) → コンテキスト文字列
```

- `formatEntryContext` はフェーズ解決済みの summary、content、detailValues、contextMode を使用
- context_mode の判定もフェーズ解決後の値で行う（例: `context_mode_override = 'always'` のフェーズが適用されると、そのシーン以降は常に注入）
- フェーズラベルをコンテキストに付記してAIにキャラクターの現在状態を明示:

```
## エララ (キャラクター) [反乱参加]
反乱軍の魔術師
- 所属勢力: 反乱軍
- 種族: 人間
```

- 子孫エントリの自動注入（BFS、サブツリートークン予算）も各子エントリのフェーズを個別に解決して注入

#### プロジェクトスコープChat

プロジェクトスコープのChat（`isGlobalChat = true`、`nodeId = NULL`）では、特定のシーン位置がないため、**タイムライン全体を俯瞰した注入**を行う。

フェーズ解決の分岐:

| Chatスコープ | currentSceneId | フェーズ解決方針 |
|-------------|----------------|----------------|
| シーンスコープ | アクティブシーンID | そのシーン時点の状態を解決 |
| プロジェクトスコープ | null | タイムライン全体を俯瞰 |

**フェーズがあるエントリの注入フォーマット**:

```
## エララ (キャラクター)
最新: 古代魔法の継承者（所属: ―）

変遷:
- 初期: 塔の見習い魔術師（所属: 白銀騎士団）
- Ch.8 Sc.3「追放」以降: 塔を追われた元見習い（所属: なし）
- Ch.15 Sc.1「反乱参加」以降: 反乱軍の魔術師（所属: 反乱軍）
- Ch.24 Sc.5「覚醒」以降: 古代魔法の継承者
```

**フェーズがないエントリ**: 従来通り summary（または content フォールバック）のみを注入。変遷セクションは表示しない。

**トークン予算への影響**:

タイムライン注入は単一状態より長くなるため、予算制御が必要:

| フェーズ数 | 概算トークン増分（1エントリあたり） |
|-----------|-------------------------------|
| 0 | 0（従来通り） |
| 1-3 | +50〜150 tok |
| 4-10 | +150〜400 tok |

予算超過時の縮退:
- Layer 4予算の範囲内で、シーンスコープと同じ優先順位ルールを適用
- 予算超過時はフェーズの少ないエントリから変遷セクションを省略（最新状態のみに縮退）
- `context_mode` はフェーズ解決後の**最新状態**の値で判定

**プロジェクトスコープChatのコンテキストバー表示**:

```
┌────────────────────────────────────────────────────┐
│ 🌐 Project scope                                   │
│ Codex: [エララ ⏱3] [マーカス] [黒曜石の塔 ⏱1] ... │
│         ↑ フェーズ数バッジ                           │
└────────────────────────────────────────────────────┘
```

- フェーズを持つエントリのピルに `⏱N`（フェーズ数）バッジを表示
- ピルホバーで「タイムライン全体が注入されます」のツールチップ

### エディタハイライト連携

CodexHighlightのポップオーバーもフェーズ解決済み状態を表示:

```
┌─────────────────────────┐
│ 👤 Elara                │
│ ⏱ 反乱参加              │  ← フェーズラベル表示（フェーズ適用中のみ）
│ 反乱軍の魔術師           │  ← フェーズ適用後のsummary
│ [Open in Codex →]       │
└─────────────────────────┘
```

フェーズが適用されていない場合（Base状態）は、フェーズラベル行を表示しない（現行と同じ）。

### 再計算タイミング

| トリガー | 再計算対象 |
|---------|-----------|
| フェーズの追加/削除/編集 | 該当エントリのフェーズ解決済み状態を再計算 → コンテキスト再構築、ポップオーバー更新 |
| アクティブシーンの切り替え | 全エントリのフェーズ解決済み状態を再計算（キャッシュ活用で高速化） |
| ツリー構造の変更（シーン移動/追加/削除） | `SceneTimeIndex`（`readingOrder` および `storyTimeInherited`）を再計算 → 全エントリのフェーズ解決を再実行 |
| `tree_nodes.story_time_order` の変更 | `SceneTimeIndex.storyTimeOrder` と `storyTimeInherited` を再計算（`readingOrder` は不変） → 全エントリのフェーズ解決を再実行（`mode ≠ 'reading'` の場合のみ実質影響あり） |
| `projects.phase_resolution_mode` の変更 | `SceneTimeIndex` 自体は不変。どの Map を引くかが変わるのみ。全エントリのフェーズ解決のみ再実行 |
| フェーズのアンカーシーン変更 | Index 再計算は不要。該当エントリのフェーズ解決のみ |

### エッジケース

#### アンカーシーンの削除

`ON DELETE SET NULL` で処理。`anchor_node_id` が NULL になったフェーズは:
- Timeline UIで「⚠ シーン削除済み」と警告表示
- 状態解決時はスキップ（適用されない）
- ユーザーに [Edit] から再アンカーを促す

#### シーン順序の変更（D&D移動）

シーンの並び替えでグローバル順序が変わると、フェーズの適用順も変わる可能性がある:
- グローバル順序マップを再計算
- 影響を受けるCodexエントリの状態を再解決
- 大きな順序変更でフェーズの適用順が変わった場合はトースト通知:「Codexフェーズの適用順が変わった可能性があります」

#### エントリのタイプ変更

エントリのタイプを変更した場合、フェーズ内のカスタムフィールド上書きは既存の `codex_detail_values` と同じルールに従う:
- 旧タイプのフィールド上書き値は保持（非表示）
- 新タイプの定義のみ表示。タイプを戻せば値が復活

#### 複数フェーズが同一シーンにアンカー

同一エントリ内で複数のフェーズが同じシーンにアンカーされている場合、時間軸上の位置が完全一致するため tie-break のみで順序が決まる。アンカーが同一なら reading-order も一致するので、最終的に `created_at` の昇順で適用される。UI の Timeline タブでは同一シーンのフェーズが連続して表示される。

#### 異なるシーンが同じ story_time_order を持つ（パラレル・同時刻）

パラレルストーリーや同時進行のシーンでは、複数 Scene が同じ `story_time_order` を持つことがあり、それらにアンカーされた Phase は時間軸上で同値となる。この場合はアンカーシーンの reading-order（＝読者が先に読む側）を優先してソートする。作者が読者視点での前後を意図していなければ両シーンに別の `story_time_order` を振れば良い。

#### フラッシュバック Phase

`story_time_order` を過去値で設定した Scene にアンカーされた Phase は、作中時間上は過去に適用される。`mode = 'story'` または `'auto'` では、読者がそのシーンを読むより前のシーン時点でも状態が遡及的に適用される。読者順を重視する章では `mode = 'reading'` に切り替えるか、プロジェクト単位で `'reading'` を維持する運用とする。

### パフォーマンス

- フェーズ数は1エントリあたり典型的に0〜10程度
- 状態解決はO(P)（P=フェーズ数）で十分高速
- グローバル順序計算はO(N)（N=ノード数）でツリー変更時のみ実行
- 全エントリの一括再解決: O(E × P_avg)（E=エントリ数、P_avg=平均フェーズ数）。500エントリ × 5フェーズ = 2500回の比較で1ms以下

### 将来拡張

| 拡張 | 概要 | 優先度 |
|------|------|--------|
| tags上書き | フェーズごとにタグ変更 | 低 |
| フェーズ間diff表示 | 2つのフェーズの差分をハイライト表示 | 中 |
| AIフェーズ提案 | チャットの会話からフェーズを自動提案 | 中 |
| フェーズテンプレート | 「戦争開始」で複数エントリの一括フェーズ作成 | 低 |

> 全エントリの全フェーズを横断表示するタイムラインビューは、Codex パネル側ではなく **Timeline パネル**で提供する。詳細は [Timeline パネル設計書](./Grimodex_Timelineパネル設計書.md) を参照。

---

## キーボードショートカット

### Codexパネルにフォーカス時

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Alt+X` | Codexパネルにフォーカス/トグル（レイアウト設計書で定義済み） |
| `Ctrl+Alt+Q` | CodexQuick パネルにフォーカス/トグル（独立 dockview パネル、Scenes 近傍に配置） |
| `Ctrl+K` | `CodexCommandPalette` を開く。全エントリを高速検索し、選択してエンターで `requestSelectEntry` による Codex 遷移、または付随アクション（Pin to Chat / Find in scenes 等）を実行できるコマンドパレット UI |
| `Ctrl+F`（パネルフォーカス時） | 検索バーにフォーカス |
| `↑` / `↓` | エントリリスト内のフォーカス移動 |
| `Enter` | 選択エントリの詳細画面を開く / 詳細画面にフォーカス |
| `Escape` | 検索クリア / 詳細画面からリストにフォーカスを戻す / CodexCommandPalette を閉じる |
| `F2` | 選択エントリの名前をインライン編集 |
| `Del` | 選択エントリを削除（確認ダイアログ） |

`CodexCommandPalette` は `codex_fts` による全文検索と `rustMatcher` / `codexMatcher` のスコアリングを組み合わせ、大量エントリでも即応する。コマンドパレット内で選択したエントリへの遷移は、他パネルからの遷移と同様に `requestSelectEntry` を経由する。

---

## 他パネルとの連携

### Codex 遷移 API（`requestSelectEntry`）

他パネルから Codex パネルに遷移して特定エントリを選択する動線は、`codexStore.requestSelectEntry(entryId)`（内部的には `codexStore.pendingEntryId` のセット）を経由する統一 API で扱う。フローは次のとおり:

1. 呼び出し側（CodexQuick / Chat のメンション / Editor のハイライトポップオーバー / Mentions タブのシーンリンクなど）が `requestSelectEntry(entryId)` を呼ぶ
2. 必要に応じて dockview 側で Codex パネルを開く / 前面化する
3. `CodexManagementPanel` がマウント or 前面化すると effect で `pendingEntryId` を拾い、該当エントリを選択 → 詳細画面に遷移し、エントリリスト内で仮想スクロールを該当行にスクロールさせる
4. 処理後 `pendingEntryId` はクリアされる

この仕組みにより、呼び出し側は「Codex パネルが現在マウントされているかどうか」を気にせず遷移要求を発行できる。

### ← Editor

- Editorのコンテキストメニュー「Add to Codex」→ 即時エントリ作成 → `requestSelectEntry` で Codexパネルの詳細画面が開く
- EditorのCodexハイライトポップオーバー「Open in Codex →」→ `requestSelectEntry` 経由で該当エントリの詳細を表示

### ← Scenes（Codex Quick）

- CodexQuick は Scenes 配下のセクションではなく、**独立した dockview パネル**として Scenes パネル近傍に配置される。`Ctrl+Alt+Q` でトグル表示/フォーカスが可能（キーボードショートカット節参照）
- CodexQuick の各エントリ行では、名前ドット、type ラベル、summary プレビューを含む **エントリホバーポップオーバー**（`CodexEntryPopoverContent` コンポーネント）を表示する。ホバー遅延や配置規約は TooltipProvider の共通設定に従う
- CodexQuick セクションのエントリクリック → `requestSelectEntry` 経由で Codex パネルに遷移し、詳細を表示
- CodexQuick の並び順・ピン留めは `codex_quick_pins` テーブルに永続化されており、セッションをまたいで保持される

### ← Chat

- Chatの「Codex」ボタン → エントリ即時作成（`source_chat_message_id` 付き）→ `requestSelectEntry` で詳細画面を開く
- Chat メッセージ内で Codex エントリがハイライトされた部分をクリック → `requestSelectEntry` で Codex パネルに遷移

### → Editor

- Codexエントリの name 変更 → エディタ本文中のCodexハイライトが即座に更新
- Codexエントリの追加/削除 → `sceneCodexMatches` が再計算され、ハイライトが更新

### → Chat（コンテキスト注入）

**シーンスコープChat**（`isGlobalChat = false`）:
- シーン本文で自動検出されたCodexエントリの**フェーズ解決後の** summary がChatのシステムプロンプト Layer 4 に注入される（summaryが未記入の場合はフェーズ解決後のcontent全文をフォールバック）
- チャットメッセージ内で言及されたCodexエントリは自動的にピン留めされ、フェーズ解決後のcontent全文が注入される
- 手動ピン留めされたエントリはフェーズ解決後の content 全文が注入される
- 親エントリが注入される場合、子孫エントリのフェーズ解決後のsummaryがサブツリートークン予算の範囲内でBFS順に自動注入される（「エントリ間リレーション」セクション参照）
- 自動注入された子エントリはコンテキストバーに薄いスタイルのピルで表示される
- フェーズが適用されているエントリは、コンテキストにフェーズラベルが付記される（例: `## エララ (キャラクター) [反乱参加]`）

**プロジェクトスコープChat**（`isGlobalChat = true`、`nodeId = NULL`）:
- 特定のシーン位置がないため、フェーズを持つエントリは**タイムライン全体を俯瞰した注入**を行う（最新状態 + 変遷リスト）
- フェーズがないエントリは従来通り summary のみを注入
- コンテキストバーでフェーズを持つエントリのピルに `⏱N`（フェーズ数）バッジを表示
- 詳細は「フェーズシステム（経時的変化）」セクションの「プロジェクトスコープChat」参照

### → Chat History

- 詳細画面のSourceセクション「{セッションタイトル} (chat)」→ Chat Historyで該当セッションを開く

---

## レスポンシブ動作

### スプリットモード（パネル幅 >= 400px）

左にエントリリスト（幅180px固定）、右に詳細画面（残り幅）。リストと詳細の間はリサイズ可能。

### スタックモード（パネル幅 < 400px）

エントリリストのみ表示。エントリクリックで詳細画面に遷移（リストが隠れる）。詳細画面のヘッダー左に「← Back」ボタンでリストに戻る。

Left Dockのデフォルト幅（200px）ではスタックモードになるため、Codexパネルを開いた直後はリスト表示。エントリを選択すると詳細に遷移し、戻るボタンでリストに復帰する動線が基本になる。スプリットで使いたいユーザーはCodexパネルをRight DockやBottom Dockに移動するか、フローティングで広く開く。

### レイアウト切り替えの実装

`CodexManagementPanel` は以下でモードを決定する:

- **初期判定**: 親から渡される `initialStackMode` プロパティ（呼び出し側がその時点のパネル幅から事前に決めた値）を初回レンダリングに反映する。これによりマウント直後にスプリット → スタックの一瞬のチラつきが発生しない
- **動的追従**: マウント後は `ResizeObserver` でパネルコンテナの幅を監視し、幅が 400px を越境した瞬間にスタック ⇔ スプリットを切り替える。ドラッグリサイズや dockview の移動に追従する

スタックへ遷移した際は、現在選択中のエントリがあれば詳細ビューを残し「← Back」でリスト復帰、なければリスト表示を維持する。

---

## 既存設計書との整合

### レイアウト設計書

Codexパネルのデフォルト位置はLeft Dock（非表示）、Scenesとタブ切り替え。

### Editorパネル設計書

Codexハイライト（Pure Decorations）のホバーポップオーバーから「Open in Codex →」でCodexパネルの詳細画面を開く。「Add to Codex」コンテキストメニューで即時作成後、Codexパネルの詳細画面が開く。

### Chatパネル設計書

Chatの「Codex」ボタンでエントリを即時作成（AI抽出/通常抽出モード切り替え可能）。`source_chat_message_id` でChat→Codexのトレーサビリティ。Chatのコンテキスト注入Layer 4でCodexエントリのフェーズ解決後のsummaryが自動注入される。プロジェクトスコープChat（`nodeId = NULL`）ではタイムライン全体を俯瞰した注入を行う（「フェーズシステム」セクション参照）。

### Scenesパネル設計書

Codex QuickセクションはZustandストアの `sceneCodexMatches` を共有。エントリクリックでCodexパネルの詳細を開く。

---

## カスタムタイプ管理

### 概要

タイプは `codex_types` テーブルで管理され、追加・編集・削除が可能。ビルトイン 4 タイプ（`character` / `location` / `item` / `lore`）に加え、プロジェクト単位でカスタムタイプを追加できる。

ビルトイン 4 種はプロジェクト作成時および Codex パネル初期化時に `ensureBuiltinTypes` が呼ばれ、欠損していれば既定値で復元される。これにより誤削除・スキーマ移行後も必ず 4 種が存在することが保証される。

管理 UI は 2 箇所から開ける:

- **Settings > Codex カテゴリ**: プロジェクト全体の Codex 設定と並んでタイプ管理 UI が表示される
- **フィルタタブの管理 UI**: Codex パネル C. フィルタタブ領域のコンテキストメニューや末尾の「Manage types…」エントリから、フィルタタブと同じ場所でタイプ管理を開ける

いずれも同じ編集ダイアログ（`typeApi` 経由）を開く。

### Settings内のUI

```
Codex Types
────────────────────────────────────────────
● キャラクター (character)  char  🔒 ビルトイン
● 場所 (location)           loc   🔒 ビルトイン
● アイテム (item)           item  🔒 ビルトイン
● 伝承 (lore)               lore  🔒 ビルトイン
────────────────────────────────────────────
● 勢力 (faction)            fact  [✎] [×]
● 魔法体系 (magic_system)   magi  [✎] [×]
────────────────────────────────────────────
[+ Add type]
```

### カスタムタイプの作成

[+ Add type] クリックでダイアログ表示:

| フィールド | 説明 | バリデーション |
|-----------|------|---------------|
| Label | 表示名（日本語OK） | 必須、最大32文字 |
| Slug | 内部識別子 | `/^[a-z][a-z0-9_]{0,31}$/`、プロジェクト内ユニーク |
| Color | カテゴリドット色 | hex値、カラーピッカー |
| Icon | Lucideアイコン名 | optional |

### 制約

- ビルトインタイプ: 削除不可、slug変更不可。label・color・icon・sort_orderは変更可
- カスタムタイプ削除: 該当タイプのエントリが存在する場合は削除不可（エラー表示 + エントリ数表示）
- カスタムタイプ削除時の連鎖処理:
  - `codex_tags.type_filter` から該当slugを除去
  - `codex_detail_definitions` の該当type_slugの定義を削除（CASCADE で値も削除）
- プロジェクト間のタイプ共有なし（各プロジェクト独立）
- sort_order はD&Dで並び替え可能。フィルタタブの表示順に反映

---

## 将来対応: シーン単位Codexタグ（未実装）

### 概要

シーンにCodexエントリを手動でタグ付けする機能。文字列マッチによる自動検出を補完し、テキスト中にname/aliasが出現しないCodexエントリとシーンの関連性を明示する。

Synopsisが「何が起こるか」を記述するのに対し、Codexタグは「誰/何が関与するか」を宣言する。

### ユースケース

- 代名詞のみで語られるシーンで、関与するキャラクターを明示
- テーマ・モチーフとしてシーンに関連するLoreエントリを紐づけ
- 伏線が張られている箇所に、回収先のCodexエントリを関連付け
- `context_mode: mentioned` のエントリを、name出現なしでもAIコンテキストに注入

### 自動検出との区別

| 種別 | ソース | 表示 |
|------|--------|------|
| 自動検出 | Aho-Corasickによるname/aliasマッチ | 現行のCodex Quick表示 |
| 手動タグ | ユーザーが明示的に付与 | 手動タグであることが視認できるスタイル |

手動タグは自動検出とは独立して管理され、テキスト編集の影響を受けない。

### AIコンテキスト注入への影響

手動タグ付けされたCodexエントリは、自動検出と同様にChatのLayer 4注入候補となる。`context_mode` の設定は引き続き尊重される（`hidden` のエントリは手動タグがあっても注入しない）。

### Mentionsタブへの反映

Mentionsタブの「Manuscript」セクションに、手動タグ由来の関連を自動検出由来と区別して表示する。

---

## 将来対応: スパン単位セマンティックリンク（未実装）

### 概要

エディタ本文中の任意のテキスト範囲に、Codexエントリへの意味的リンクを手動で付与する機能。文字列マッチ（name/alias一致）とは独立した、作者の意図の明示的エンコーディング。

### 文字列マッチとの違い

文字列マッチは「テキスト表層に名前が出現しているか」を検出する。セマンティックリンクは「作者がこのテキスト範囲をこのCodexエントリに関連づけたい」という意図を記録する。両者は独立して共存する。

### ユースケース

- **叙述トリック・信頼できない語り手**: テキスト上の「彼」が実は別人を指すケースで、AIに真の対応関係を教える
- **二つ名・称号の文脈依存**: 「銀の魔女」が文脈によって別人を指す場合（Aliasにすると常に片方にマッチする）
- **メタファー・象徴**: 「鎖」が自由の束縛を意味する箇所と、物理的な鎖の箇所を区別
- **回想シーン**: 地の文と回想で同じ代名詞が別人を指す

いずれも共通点は**「Aliasでは表現できない文脈依存の参照」**であること。

### 設計上の考慮事項

- TipTap Markとして実装する場合、テキスト編集時のMark維持・分割の挙動を慎重に設計する必要がある
- 視覚的表現: CodexHighlight（自動検出）との区別が必要。スタイルの差別化方針は要検討
- AIコンテキスト注入: セマンティックリンクが付与された範囲とCodexエントリの対応をどの粒度でAIに伝えるか要検討
- **漏洩リスク**: 叙述トリックの真実をAIに教えた場合、AIの生成テキストにネタバレが混入する危険がある。注入時の注意書きや、セマンティックリンク専用の `context_mode` が必要になる可能性がある
