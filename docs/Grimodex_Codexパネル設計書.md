# Grimodex Codexパネル設計書

## 概要

Codexパネルはプロジェクトの世界設定データベース。キャラクター、場所、アイテム、伝承の4カテゴリのエントリを管理する。左にエントリ一覧（マスター）、右に詳細編集画面（ディテール）のスプリットビュー。エントリはEditorやChatから作成され、エディタ本文中のCodexハイライトやChatのコンテキスト注入で活用される。

デフォルト位置: Left Dock（非表示）。Scenesとタブ切り替えで共存。

---

## パネル構造

```
┌──────────────────────────────────────────────┐
│ A. Header                                     │
│ Codex                    24 entries    [+]    │
├──────────────────────────────────────────────┤
│ B. Search bar                                 │
│ [🔍 Search codex...                        ] │
├──────────────────────────────────────────────┤
│ C. Filter tabs                                │
│ [All(24)] [Character(8)] [Location(6)]        │
│ [Item(4)] [Lore(6)]                           │
├────────────────────┬─────────────────────────┤
│ D. Entry list      │ E. Detail view           │
│                    │                          │
│ ● Elara         ◄──│ ● Elara       character  │
│   Protagonist...   │                          │
│                    │ Summary:                 │
│ ● Obsidian Tower   │ Protagonist, mage        │
│   Ancient binding..│ apprentice at the Tower. │
│                    │                          │
│ ● Soulbind Amulet  │ Content: (TipTap editor) │
│   Elara's family...│ A young woman who        │
│                    │ discovers her connection  │
│ ● Age of Binding   │ to ancient magic...      │
│   Historical era...│                          │
│                    │ Tags: [protagonist][mage] │
│                    │ Appears in: The tower,... │
│                    │ Source: Chat session...   │
└────────────────────┴─────────────────────────┘
```

パネル幅が狭い場合（例: Left Dock で幅200px程度）は、リスト表示のみに切り替わり、エントリクリックで詳細画面に遷移する（スタックナビゲーション）。十分な幅がある場合はスプリットビューを使用する。閾値: 400px以上でスプリット、未満でスタック。

---

## A. ヘッダー

- **パネルタイトル**: 「Codex」
- **エントリ数**: フィルタ適用後の件数。右寄せ
- **[+] ボタン**: 新規エントリ作成（後述）

---

## B. 検索バー

### 全文検索

- エントリの name、summary、content、tags をFTS5（trigramトークナイザー）でインクリメンタル検索
- 入力開始でデバウンス300msの即時フィルタ
- マッチしたエントリのみリストに表示
- 検索語がname内にマッチした場合は太字ハイライト
- `Escape` でクリア

---

## C. フィルタタブ

カテゴリ別のフィルタタブ。各タブに該当エントリ数を表示。`codex_types` テーブルから `sort_order` 順で動的生成。

ビルトインタブ:

| タブ | カラー | 説明 |
|------|--------|------|
| All | Blue/Info | 全エントリ（デフォルト） |
| Character | パープル (#534AB7) | キャラクター |
| Location | ティール (#0F6E56) | 場所・地名 |
| Item | アンバー (#BA7517) | アイテム・道具 |
| Lore | コーラル (#993C1D) | 伝承・歴史・設定 |

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
| カテゴリドット | カテゴリ色のドット（Character: パープル、Location: ティール、Item: アンバー、Lore: コーラル） |
| エントリ名 | 太字。クリックで詳細画面を表示 |
| サマリープレビュー | summaryフィールドの先頭40文字。未記入の場合はcontentの先頭40文字。未記入の場合はグレーで「No summary」 |

選択中のエントリは左ボーダー + 背景ハイライトで強調。

### ソート順

デフォルトはアルファベット/50音順。ヘッダーのオーバーフローメニューから変更可能:

- Name (A→Z)（デフォルト）
- Name (Z→A)
- Recently updated
- Recently created
- Most referenced（本文中の出現回数順）

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
┌─────────────────────────────────┐
│ [🖼] Elara             character │  ← Header (icon + name + type)
│ Context: [Mentioned ▾]          │  ← Context mode selector
├─────────────────────────────────┤
│ Aliases: [エララ]               │  ← Aliases
│          [the apprentice] [+]   │
│ Excluded: [青い] [青の]         │  ← Excluded aliases
│           [青く] [+]            │
├─────────────────────────────────┤
│ Summary:                        │  ← Summary field
│ Protagonist, mage apprentice    │
│ at the Obsidian Tower.          │
├─────────────────────────────────┤
│ Content:                        │  ← TipTap mini-editor
│ A young woman who discovers     │     (Codex highlight enabled)
│ her connection to ancient magic │
│ through the Soulbind Amulet...  │
│                  ^^^^^^^^^^^    │  ← Codex highlight (clickable)
├─────────────────────────────────┤
│ Details:                        │  ← Custom details (per type)
│ 種族      [人間          ▾] 🤖  │
│ 所属勢力  [● 白銀騎士団  →] 🤖  │
│ 身長      [175cm            ]   │
│ [+ Add field]  [⚙ Manage]      │
├─────────────────────────────────┤
│ Tags: [protagonist] [mage] [+]  │  ← Tags (structured)
├─────────────────────────────────┤
│ Relations:                      │  ← Parent-child relations
│ Parent: (none)                  │
│ Children:                       │
│   ● Soulbind Amulet        item │
│   ● Binding Mark           lore │
│   [+ Add child]                 │
│ Suggested: (from Content)       │
│   ○ Obsidian Tower    [+ Add]   │
│   ○ Age of Binding    [+ Add]   │
├─────────────────────────────────┤
│ Appears in:                     │  ← References
│ The tower, First spell,         │
│ The stranger                    │
├─────────────────────────────────┤
│ Source:                         │  ← Provenance
│ Character deep-dive (chat)      │
└─────────────────────────────────┘
```

### ヘッダー

- アイコン画像 + エントリ名（クリックでインライン編集）+ 右寄せでカテゴリバッジ（クリックでtype変更ドロップダウン）
- カテゴリバッジのドロップダウンは `codex_types` テーブルから動的生成（ビルトイン+カスタム）

### コンテキスト制御モード

ヘッダー直下に「Context:」ドロップダウンを配置。エントリごとにAIコンテキスト注入の振る舞いを制御する。

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

### アイコン画像

- ヘッダー左端に48×48pxのアイコン画像を表示（Notionページヘッダー風）
- クリックで画像選択ダイアログを開き、ローカル画像ファイルを選択
- 画像はDBの `codex_entries.icon` BLOBカラムに格納（リサイズ: 128×128px、WebP変換）
- 未設定時はカテゴリドット（typeに応じた色の●）をフォールバック表示
- リスト画面のサムネイルにも同じアイコンを使用（28×28px）
- ポップオーバー（Editor等）では24×24pxで表示

### Aliases フィールド

- name の直下に「Aliases」入力欄
- Tags と同じUIパターン: ピル型一覧 + [+] ボタンで追加、各ピルに × で削除
- キャラクターの別名、場所の通称、アイテムの略称を登録
- 例: エントリ「Elara」に aliases: `["エララ", "the apprentice"]`
- aliasはCodexマッチング対象に含まれ、本文中で「エララ」が出現した場合も「Elara」エントリとしてハイライトされる
- alias変更時はAho-Corasickオートマトンの再構築がトリガーされる

### Excluded Aliases フィールド（除外パターン）

- Aliases の直下に「Excluded」入力欄。同じピル型UIで追加/削除
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

### Summary フィールド

- 1-2行のプレーンテキスト入力欄
- プレースホルダー: 「Short description...」
- この内容がエディタのCodexハイライト ポップオーバー、Codex Quickセクション、Chatコンテキスト注入の「要約」として使われる
- 自動保存（デバウンス1秒）
- **summaryが未記入の場合のフォールバック**: コンテキスト注入時にsummaryが空の場合、content全文を注入する。これによりsummary未記入でもAIが情報不足にならないが、トークン効率は低下する
- **ガイドラインメッセージ**: summaryが空でcontentがある場合、入力欄の下にインラインヒントを表示: 「Summaryを記入するとAIチャットでのトークン消費を抑えられます」（dismissible、一度閉じたらセッション内で再表示しない）
- **AI自動要約**:
  - summaryが空でcontentがある場合、入力欄内に「✨ Generate summary」ボタンを表示
  - クリックで軽量モデル（haiku等）がcontentを要約し、summaryに自動入力
  - 既にsummaryがある場合はボタン非表示。代わりに右クリックコンテキストメニューの「Regenerate summary」で上書き可能
  - 生成中はスピナー表示、失敗時はトースト通知

### Content フィールド（TipTapミニエディタ）

- TipTapの軽量インスタンス。StarterKitのサブセット（太字、斜体、見出し、リスト、リンク）。入力時のMarkdown記法をリアルタイムにリッチテキストとしてレンダリング
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

### Details セクション（カスタムディテール）

Content フィールドの下に配置。タイプごとに定義されたカスタムフィールドの値を入力するセクション。フィールド定義は `codex_detail_definitions` テーブル、値は `codex_detail_values` テーブルに保存。

#### フィールドタイプ

| field_type | UI | 保存値 |
|-----------|-----|--------|
| `text` | `<input>` または `<textarea>`（`field_config.multiline` で制御） | プレーンテキスト |
| `dropdown` | `<select>`。選択肢は `field_config.options` から生成 | 選択肢文字列 |
| `codex_reference` | 検索UIでCodexエントリを選択。ピル表示（クリックで遷移） | エントリID |

`codex_reference` の `field_config.allowedTypes` で参照可能なタイプを制限可能（NULL = 全タイプ）。

#### AIコンテキスト注入制御

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

#### フィールド管理

- [+ Add field]: 現在のタイプに新しいフィールド定義を追加。クリックでManage fieldsダイアログの新規追加フォームを開く
- [⚙ Manage fields]: タイプのフィールド定義を管理するダイアログを開く（後述）

#### Manage fields ダイアログ

タイプに紐づくカスタムフィールド定義を一括管理するモーダルダイアログ。`codex_detail_definitions` テーブルを操作する。

##### ダイアログ構造

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

##### フィールド一覧

| 要素 | 説明 |
|------|------|
| ⠿ ドラッグハンドル | D&Dで並び替え。`sort_order` を更新 |
| フィールド名 | `name` を表示 |
| タイプラベル | `field_type` を短縮表示（`text`, `dropdown`, `codex_ref`） |
| 🤖 アイコン | `include_in_context = 1` の場合アクティブ表示。クリックでトグル |
| [✎] 編集ボタン | フィールド編集フォームを展開（インラインアコーディオン） |
| [🗑] 削除ボタン | 確認ダイアログ後に定義削除 |

##### フィールド編集フォーム（アコーディオン展開）

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

##### 共通フィールド

全 `field_type` で表示:

| フィールド | UI | バリデーション |
|-----------|-----|---------------|
| Name | テキスト入力 | 必須。同一タイプ内でユニーク（`UNIQUE(project_id, type_slug, name)`） |
| Type | ドロップダウン: `Text` / `Dropdown` / `Codex Reference` | 必須。変更時は後述の注意あり |
| AI context | チェックボックス「Include in AI context」 | `include_in_context` カラムに対応 |

##### field_type 別の追加設定

**Text**:
| 設定 | UI | 対応 |
|------|-----|------|
| Multiline | チェックボックス「Multiple lines」 | `field_config.multiline` |

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

##### field_type の変更

既にエントリに値が存在する場合、`field_type` を変更すると既存値との互換性が問題になる。

| 変更パターン | 振る舞い |
|-------------|---------|
| text → dropdown | 既存のテキスト値はそのまま保持。ドロップダウンの選択肢に含まれない場合は警告表示 |
| text → codex_reference | 既存のテキスト値はクリア（エントリIDではないため）。確認ダイアログ表示 |
| dropdown → text | 既存の選択肢文字列はそのままテキスト値として保持。互換あり |
| dropdown → codex_reference | 既存値はクリア。確認ダイアログ表示 |
| codex_reference → text | 既存のエントリIDはクリア（表示上意味がないため）。確認ダイアログ表示 |
| codex_reference → dropdown | 既存値はクリア。確認ダイアログ表示 |

確認ダイアログ: 「{N}件のエントリの値がクリアされます。続行しますか？」

##### フィールド削除

[🗑] クリックで確認ダイアログを表示:

```
このフィールドを削除しますか？

「種族」を削除すると、このタイプの全エントリ（{N}件）から
このフィールドの値が完全に削除されます。この操作は元に戻せません。

                              [キャンセル]  [削除]
```

削除実行: `codex_detail_definitions` から行削除 → `codex_detail_values` がCASCADE削除。

##### フィールド追加

[+ Add field] クリックで一覧の末尾にフォームが展開:

- Name: 空（カーソルフォーカス）
- Type: `Text`（デフォルト）
- AI context: OFF（デフォルト）
- `sort_order`: 現在の最大値 + 1.0

Save クリックで `codex_detail_definitions` に行追加。同一タイプの全エントリに対して空の `codex_detail_values` 行は作成しない（値が入力された時に初めて行を作成 = lazy insert）。

##### 並び替え

ドラッグハンドル（⠿）でD&D。ドロップ時に `sort_order` を更新（Fractional Indexing: ドロップ先の前後のsort_orderの中間値を計算）。並び順はDetailsセクションでのフィールド表示順、およびAIコンテキスト注入時の表示順に反映。

##### ダイアログのスコープ

- ダイアログのタイトルに対象タイプのlabelを表示（例: 「Manage fields: キャラクター」）
- 表示するフィールドは `WHERE project_id = ? AND type_slug = ?` でフィルタ
- 変更は即時保存（Save ボタン押下時）。Cancel は未保存の編集を破棄
- 他のタイプのフィールドには影響しない

#### エッジケース

- `codex_reference` の参照先が削除された → 「[削除済み]」表示、値をNULLに更新
- エントリのタイプ変更 → 旧タイプのフィールド値は保持（非表示）、新タイプの定義のみ表示。タイプを戻せば値が復活
- 自動保存（デバウンス1秒）

### Tags フィールド（構造化タグ）

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

### Tags 管理画面（Settings内）

プロジェクト設定の「Tags」セクションでタグの一括管理が可能:

| 操作 | 詳細 |
|------|------|
| タグ名編集 | インライン編集。変更は全エントリに即時反映 |
| 色変更 | カラーピッカー。hex値 |
| タイプ関連付け | チェックボックス群（`codex_types` から動的生成）。未選択=全タイプ |
| 削除 | 確認ダイアログ。CASCADE で全エントリから除去 + `tags_cache` 再構築 |

### Relations セクション

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

**Suggested（提案）**:
- Content内で言及されているが、まだリレーションが設定されていないCodexエントリの一覧
- 各候補の右に [+ Add] ボタン。クリックで子リレーションとして確定
- Content変更時に自動更新。Dismissした候補は再表示しない

### References セクション（Appears in）

- このエントリ名が本文中に出現するシーンの一覧を自動表示
- 各シーン名はクリック可能（Editorでそのシーンを開く）
- データソース: Zustandストアの全シーンのCodexマッチ結果を逆引き

### Source セクション（出自情報）

- `source_chat_message_id` がある場合: 「{セッションタイトル} (chat)」のリンクを表示。クリックでChat Historyパネル経由で元のチャットセッションを開く
- Editorの「Add to Codex」から作成された場合: 「Created from editor」表示
- 手動作成の場合: 表示なし

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

### 他パネルからの作成

**Editorの「Add to Codex」**: 選択テキストがnameになり、typeは `character` デフォルト。即時作成後、Codexパネルの詳細画面が開く（Editor設計書参照）。

**Chatの「Codex」ボタン**: ダイアログなしで即時作成。AI抽出モードではtype/name/tags を軽量モデルが自動提案、通常抽出モードではcontent のみで他は空白。`source_chat_message_id` が自動付与される（Chat設計書参照）。

---

## Codexエントリのコンテンツ保存

### 保存先

summaryはSQLiteの `codex_entries.summary` カラムに直接保存。contentもSQLiteの `codex_entries.content` カラムに直接保存。アイコン画像はDBの `codex_entries.icon` BLOBカラムに格納（128×128 WebP）。

```
MyNovel.novel/
└── project.db            ← codex_entries に全データ（content, icon含む）を格納
```

### 自動保存

- summaryフィールド: デバウンス1秒でDBに保存
- contentフィールド: デバウンス2秒でDBに保存
- name/type/tags/aliases/excluded_aliases変更: 即時保存

---

## DBスキーマ

DBスキーマの正規版は統合DBスキーマ設計書（`Grimodex_統合DBスキーマ.md`）を参照。以下は概要のみ記載。

主要テーブル:
- `codex_types`: タイプ定義（ビルトイン4種 + カスタム）
- `codex_entries`: エントリ本体（`context_mode`、`tags_cache` カラム含む）
- `codex_tags` / `codex_entry_tags`: 構造化タグ（多対多）
- `codex_detail_definitions` / `codex_detail_values`: カスタムディテール
- `codex_relation_dismissed`: リレーション提案のDismiss記録
- `codex_fts`: FTS5仮想テーブル（name + aliases + summary + tags_cache）

FTS5テーブルはname + aliases + summary + tags_cacheを検索対象にする。contentもDBに格納されているためFTS5に追加可能だが、MVPではname + aliases + summary + tags_cacheの検索で十分と判断。

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
function isValidBoundary(text: string, start: number, end: number): boolean {
  // マッチ前後の文字を取得
  const charBefore = start > 0 ? text[start - 1] : '';
  const charAfter = end < text.length ? text[end] : '';

  // ルール1: マッチがCJK文字で構成される場合
  //   → 前後が同じ文字種（ひらがな、カタカナ、漢字）でなければOK
  //   例: 「エララが」→ エララ + が（カタカナ→ひらがな境界）→ OK
  //   例: 「エララン」→ エララ + ン（カタカナ→カタカナ）→ NG

  // ルール2: マッチがラテン文字で構成される場合
  //   → 前後がラテン文字/数字でなければOK（英語の\bと同等）

  // ルール3: 混合（漢字+ひらがな等）のパターン
  //   → パターン末尾の文字種と、次の文字の文字種で判定

  return checkCharacterClassBoundary(charBefore, text[start])
      && checkCharacterClassBoundary(text[end - 1], charAfter);
}

function checkCharacterClassBoundary(a: string, b: string): boolean {
  if (!a || !b) return true;  // テキスト端はOK
  const classA = getCharClass(a);
  const classB = getCharClass(b);
  // 同じ文字クラス同士はNG（部分一致の可能性）
  return classA !== classB;
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

境界ルール: **マッチの前後で文字クラスが変わればOK、同じクラスが続いていればNG**。

具体例:
- 「エララが塔に向かった」→ 「エララ」マッチ。後ろは「が」(ひらがな)、パターン末尾は「ラ」(カタカナ)。クラスが違うので → 有効
- 「エラランの冒険」→ 「エララ」マッチ。後ろは「ン」(カタカナ)、パターン末尾は「ラ」(カタカナ)。同じクラスなので → 無効（誤マッチ排除）
- 「黒曜石の塔が見えた」→ 「黒曜石の塔」マッチ。後ろは「が」(ひらがな)、パターン末尾は「塔」(漢字)。クラスが違うので → 有効

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

#### Step 4: Decoration適用（差分更新）

ProseMirrorのDecorationSet に反映する。ここで重要なのは**差分更新**。テキスト変更のたびに全Decorationを再生成するとチラつきが発生するため、前回の結果との差分のみを適用する。

```typescript
interface CodexDecoration {
  from: number;         // ProseMirrorドキュメント内の位置
  to: number;
  entryId: string;
  entryName: string;
  entryType: CodexEntryType;
}

function diffDecorations(
  prev: CodexDecoration[],
  next: CodexDecoration[]
): { added: CodexDecoration[]; removed: CodexDecoration[] } {
  // エントリIDと位置で一致判定
  // 同じエントリが同じ位置にある → 変更なし（維持）
  // 新しく出現した → added
  // 消えた → removed
}
```

差分更新の利点:
- ユーザーがマッチ箇所以外を編集している場合、Decorationが再描画されずチラつかない
- 新しいマッチが出現した箇所だけにアニメーション（フェードイン）を適用できる

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

推奨: MVPではJS実装を使用。パフォーマンスが問題になった場合にRust実装に移行（インターフェースは同じ）。

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

### パフォーマンス

ContentのテキストはSceneの本文（数千〜数万文字）に比べて短い（典型的に500〜2,000文字）。既存のAho-Corasickオートマトンをそのまま使い回せるため、追加のパフォーマンスコストはほぼゼロ。

---

## エントリ間リレーション

### 概要

Codexエントリ間に親子関係（リレーション）を設定できる。キャラクターと所持アイテム、場所とそこに関連する伝承、組織と所属メンバーなどの構造化に使う。

リレーションの主な用途:
1. **ナビゲーション**: 詳細画面で関連エントリに素早く移動
2. **コンテキスト注入**: 親エントリがChatに注入される場合、子エントリのsummaryも自動注入

### リレーションモデル

- 1つのエントリは最大1つの親を持てる（多対1）
- 1つのエントリは0個以上の子を持てる（1対多）
- 循環参照は禁止（A→B→C→Aのようなループ）
- 深さに制限はないが、コンテキスト注入はdepth 1（直接の子）のみ

```
Elara (character)
├── Soulbind Amulet (item)         ← 子
├── Binding Mark (lore)            ← 子
└── Elara's Journal (item)         ← 子
      └── Journal Entry #3 (lore)  ← 孫（depth 2、注入対象外）

Obsidian Tower (location)
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

Chatパネルのコンテキスト注入Layer 4で、親エントリが注入対象になった場合、**直接の子（depth 1）のsummaryも自動注入する**。

```typescript
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

    // depth 1の子エントリのsummaryを追加
    const children = codexStore.getChildren(entryId);
    for (const child of children) {
      if (injectedIds.has(child.id)) continue;
      contextParts.push(formatChildContext(child));  // summaryのみ、contentは含まない
      injectedIds.add(child.id);
    }
  }

  return contextParts.join('\n\n');
}
```

**注入ルール**:

| 注入トリガー | 親エントリ | 子エントリ（depth 1） | 孫エントリ（depth 2+） |
|-------------|-----------|---------------------|---------------------|
| 自動検出（シーン本文にnameが出現） | summary + カスタムディテール（include_in_context=1）。**summaryが未記入の場合はcontent全文をフォールバック** | summary（自動） | 注入しない |
| チャットメッセージ内で言及 | **自動ピン留め**: content全文 + カスタムディテール（include_in_context=1） | summary（自動） | 注入しない |
| ピン留め（手動） | content全文 + カスタムディテール（include_in_context=1） | summary（自動） | 注入しない |

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

子エントリの自動注入で予算を超過する場合の優先順位:
1. `always` エントリのsummary + カスタムディテール（最優先）
2. 本文に直接出現するエントリのsummary + カスタムディテール
3. ピン留めされたエントリのcontent + カスタムディテール
4. 自動注入された子エントリのsummary（最初に切り詰め対象）

Chatパネルのコンテキストバーには、自動注入された子エントリもピルとして表示する。ただし通常のピルとは異なるスタイル（薄い表示 + 「via {親名}」ラベル）で区別し、×で個別除外も可能。`always` エントリは常にピルとして表示（薄いスタイル + 「auto」ラベル）。`hidden` エントリはピンダイアログに表示しない。

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
- [×] でDismiss（非表示にする。`codex_relation_dismissed` テーブルに記録）
- Content変更時に自動再計算

### 自動リレーションを採用しない理由

Content内で言及されたエントリを自動的にリレーションにすると:

1. **コンテキスト爆発**: 「カゾルミア帝国」のContentに20エントリが言及されていたら、帝国が登場するだけで20 x ~200tok = 4,000tokが自動注入される
2. **再帰問題**: 子エントリのContent内にさらに別のエントリが言及されていると、depth制限があっても間接的に大量のエントリが巻き込まれる
3. **意図しない関係**: Content内で「エララは黒曜石の塔とは無関係の村で育った」と書いてあっても、「黒曜石の塔」がマッチして子リレーションになってしまう

提案にとどめることで、ユーザーが「この関係は本当にAIに伝えるべきか」を判断してから確定する動線になる。

### Dismiss永続化

```sql
CREATE TABLE codex_relation_dismissed (
  entry_id     TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  dismissed_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, dismissed_id)
);
```

---

## キーボードショートカット

### Codexパネルにフォーカス時

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Alt+X` | Codexパネルにフォーカス/トグル（レイアウト設計書で定義済み） |
| `Ctrl+F`（パネルフォーカス時） | 検索バーにフォーカス |
| `↑` / `↓` | エントリリスト内のフォーカス移動 |
| `Enter` | 選択エントリの詳細画面を開く / 詳細画面にフォーカス |
| `Escape` | 検索クリア / 詳細画面からリストにフォーカスを戻す |
| `F2` | 選択エントリの名前をインライン編集 |
| `Del` | 選択エントリを削除（確認ダイアログ） |

---

## 他パネルとの連携

### ← Editor

- Editorのコンテキストメニュー「Add to Codex」→ 即時エントリ作成 → Codexパネルの詳細画面が開く
- EditorのCodexハイライトポップオーバー「Open in Codex →」→ Codexパネルで該当エントリの詳細を表示

### ← Scenes（Codex Quick）

- Codex Quickセクションのエントリクリック → Codexパネルで詳細を表示

### ← Chat

- Chatの「Codex」ボタン → エントリ即時作成（`source_chat_message_id` 付き）

### → Editor

- Codexエントリの name 変更 → エディタ本文中のCodexハイライトが即座に更新
- Codexエントリの追加/削除 → `sceneCodexMatches` が再計算され、ハイライトが更新

### → Chat（コンテキスト注入）

- シーン本文で自動検出されたCodexエントリの summary がChatのシステムプロンプト Layer 4 に注入される（summaryが未記入の場合はcontent全文をフォールバック）
- チャットメッセージ内で言及されたCodexエントリは自動的にピン留めされ、content全文が注入される
- 手動ピン留めされたエントリは content 全文が注入される
- 親エントリが注入される場合、depth 1の子エントリのsummaryも自動注入される（「エントリ間リレーション」セクション参照）
- 自動注入された子エントリはコンテキストバーに薄いスタイルのピルで表示される

### → Chat History

- 詳細画面のSourceセクション「{セッションタイトル} (chat)」→ Chat Historyで該当セッションを開く

---

## レスポンシブ動作

### スプリットモード（パネル幅 >= 400px）

左にエントリリスト（幅180px固定）、右に詳細画面（残り幅）。リストと詳細の間はリサイズ可能。

### スタックモード（パネル幅 < 400px）

エントリリストのみ表示。エントリクリックで詳細画面に遷移（リストが隠れる）。詳細画面のヘッダー左に「← Back」ボタンでリストに戻る。

Left Dockのデフォルト幅（200px）ではスタックモードになるため、Codexパネルを開いた直後はリスト表示。エントリを選択すると詳細に遷移し、戻るボタンでリストに復帰する動線が基本になる。スプリットで使いたいユーザーはCodexパネルをRight DockやBottom Dockに移動するか、フローティングで広く開く。

---

## 既存設計書との整合

### レイアウト設計書

Codexパネルのデフォルト位置はLeft Dock（非表示）、Scenesとタブ切り替え。

### Editorパネル設計書

Codexハイライト（Pure Decorations）のホバーポップオーバーから「Open in Codex →」でCodexパネルの詳細画面を開く。「Add to Codex」コンテキストメニューで即時作成後、Codexパネルの詳細画面が開く。

### Chatパネル設計書

Chatの「Codex」ボタンでエントリを即時作成（AI抽出/通常抽出モード切り替え可能）。`source_chat_message_id` でChat→Codexのトレーサビリティ。Chatのコンテキスト注入Layer 4でCodexエントリのsummaryが自動注入される。

### Scenesパネル設計書

Codex QuickセクションはZustandストアの `sceneCodexMatches` を共有。エントリクリックでCodexパネルの詳細を開く。

---

## カスタムタイプ管理

### 概要

ビルトイン4タイプ（Character, Location, Item, Lore）に加え、プロジェクト単位でカスタムタイプを追加可能。Settings内のCodexセクションで管理する。

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
