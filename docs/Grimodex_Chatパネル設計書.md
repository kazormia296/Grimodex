# Grimodex Chatパネル設計書

## 概要

ChatパネルはGrimodexのコア体験を担うAI対話パネル。現在のシーンをコンテキストとしてLLMと会話し、生成テキストをエディタに挿入したり、会話から知識をCodex/Snippetとして抽出・構造化する。BYOK（Bring Your Own Key）方式で複数のAIプロバイダに対応する。

デフォルト位置: Right Dock（表示状態）

設計思想: **AIチャットが執筆体験の中心。チャットから生まれた知識（キャラクター設定、プロット断片、世界観メモ）をCodex/Snippetとして構造化し、再利用する。**

---

## パネル構造

```
┌──────────────────────────────────────┐
│ A. Header                            │
│ Chat    Scene: The tower  [Sessions][+]│
├──────────────────────────────────────┤
│ B. Context bar                       │
│ [Project] [Scene: 1,247] [Elara]     │
│ [Obsidian Tower]       ~3,200 tokens │
├──────────────────────────────────────┤
│ C. Message list                      │
│                                      │
│  ┌─────────────────────────────┐     │
│  │ Describe what Elara feels   │     │
│  │ when she touches the tower  │ ←User│
│  └─────────────────────────────┘     │
│  ┌───────────────────────────────┐   │
│  │ A jolt of recognition surges │   │
│  │ through her fingertips...    │←AI │
│  │ [Insert][Codex][Snippet][⋮]  │   │
│  │ Sonnet 4.6 · 142 tok · 0.8s │   │
│  └───────────────────────────────┘   │
│                                      │
├──────────────────────────────────────┤
│ D. Input area                        │
│ ┌──────────────────────────────────┐ │
│ │ Ask about this scene...          │ │
│ │ [@] [/]          Sonnet 4.6 [▶] │ │
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

---

## A. ヘッダー

### 表示要素

- **パネルタイトル**: 「Chat」
- **シーンインジケーター**: 現在のアクティブシーン名。クリックでシーン選択ドロップダウン（Chatのコンテキストをエディタのアクティブシーンから手動で切り替える場合に使用）
- **🌐 グローバルチャットボタン**: ワンクリックでプロジェクトスコープ（`node_id = NULL`）に切り替え。再度クリックでアクティブシーンに復帰。プロジェクトスコープ時はシーンインジケーターが「Project」に切り替わる
- **🔧 エージェントモードトグル**: Tool Useを有効化し、LLMがプロジェクトデータを能動的に検索・取得できるモードに切り替える。詳細はAIエージェント設計書（`Grimodex_AIエージェント設計書.md`）参照
- **Sessions ボタン**: セッション一覧サイドシートを開く（後述）
- **+ ボタン**: 新しいセッションを作成

### シーン連動

Editorのアクティブタブが変わると、Chatパネルのシーンインジケーターが自動更新される。ただし、会話セッションの自動切り替えは行わない（セッションはシーンに紐づいているため、同じシーンに戻れば前のセッションが復帰する）。

別のシーンに切り替わった場合:
1. そのシーンに既存のセッションがあれば最新セッションを表示
2. なければ空の新規セッション画面を表示

**Codex/Snippetタブの場合**: Editorのアクティブタブがcodex/Snippetタブの場合、ヘッダーのシーンインジケーターは「Codex: {エントリ名}」または「Snippet: {title}」に切り替わる。Layer 3にはCodex/Snippetのcontent全文が注入される。セッションはプロジェクトスコープ（`node_id = NULL`）として扱う

---

## B. コンテキストバー

### 概要

LLMに送信されるコンテキスト情報をユーザーに可視化するバー。ヘッダー直下に表示し、折りたたみ可能。

### 表示するピル

| ピル                | 色            | 内容                                                                                                               |
| ----------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| Project info      | グレー          | プロジェクト概要が注入されていることを示す。クリックで内容をポップオーバー表示                                                                          |
| Scene: {文字数}      | グレー          | 現在のシーン本文がコンテキストに含まれている。文字数を表示                                                                                    |
| {Codexエントリ名}      | Blue/Info    | 自動検出またはピン留めされたCodexエントリ。クリックでポップオーバー（summary、カスタムディテール概要、「Open in Codex →」リンク、**ピン留めされていない場合は「Pin」ボタン**を表示）。×で除外 |
| {Codexエントリ名} auto | Blue/Info（薄） | `context_mode = always` のエントリ。常に表示。×で一時除外可能（セッション内）                                                              |
| {子エントリ名} via {親名} | Blue/Info（薄） | 自動注入された子エントリ。×で個別除外可能                                                                                            |
| {Snippet名}        | Purple       | ピン留めされたSnippet。クリックでSnippet詳細。×で除外                                                                               |
| ~{N} tokens       | グレー（右寄せ）     | システムプロンプトの合計トークン数概算。クリックでプロンプトプレビューモーダルを表示（全文 + レイヤー別トークン内訳）                                                     |

### グループ化表示

Codex + Snippetのピル合計が **6個を超えた場合**、個別ピル表示からグループ化表示に自動的に切り替わる。

**通常表示**（6個以下）:
```
[Project] [Scene: 3,200] [Elara] [Taro] [Lira] [Ancient Tower] [+]  ~2,800 tokens
```

**グループ化表示**（7個以上）:
```
[Project] [Scene: 3,200] [Characters ▾ (5)] [Locations ▾ (2)] [Snippets ▾ (3)] [+]  ~4,200 tokens
```

**グループの構成**:
- Codexエントリは `type`（character / location / item / lore / カスタムtype）でグループ化
- Snippetは独立した「Snippets」グループ
- 各グループピルにはグループ名と件数を表示（例: `Characters (5)`）
- グループピルの色はCodex系はBlue/Info、SnippetsはPurple
- エントリが0件のグループは非表示

**グループの展開/折りたたみ**:
- グループピルの ▾ をクリックで展開。グループピルの直下にそのグループの個別ピルが表示される
- 展開中は ▾ が ▴ に変化
- 個別ピルのクリック（ポップオーバー）や×（除外）は通常表示と同じ動作
- 複数グループを同時に展開可能
- グループ外のピル（Project info、Scene、トークン数）は常に表示

### ピン留め

- コンテキストバー末尾の「+」ボタンで、CodexエントリまたはSnippetを手動ピン留め
- **✦ AI コンテキストクリエイター**: 「+」ボタンの隣に配置。AIがTool Useでプロジェクトデータを検索し、コンテキストに追加すべきエントリを提案する。詳細はAIエージェント設計書（`Grimodex_AIエージェント設計書.md`）の「コンテキストクリエイター」セクション参照
- コマンドパレット風の検索UIでエントリを選択（Codex/Snippetをタブまたはフィルタで切り替え）
- **`context_mode = hidden` のエントリはピン留め候補に表示しない**
- **`context_mode = suppress` のエントリはミュート表示 + ツールチップ（「ピン留めでAIコンテキストに含まれます」）**
- ピン留めしたエントリはセッション内で永続（セッション終了まで有効）
- 自動検出されたCodexエントリも×ボタンで個別除外可能
- **ピルプレビュー内ピン昇格**: 自動検出（未ピン留め）のCodexエントリのピルをクリックしたポップオーバー内に「Pin」ボタンを表示。クリックでピン留めに昇格し、以降content全文が注入される
- **チャット言及による自動ピン留め**: ユーザーのチャットメッセージ内でCodexエントリ名が検出された場合（CodexHighlightまたは@メンション経由）、そのエントリをセッションの `pinned_codex` に自動追加する。シーン本文での言及（summary注入）とは異なり、チャットでの言及はユーザーの明確な意図を示すため、content全文を注入する。自動ピン留めされたエントリはContext Barにピルとして表示され、不要な場合は×で除外可能
- **チャット言及の編集による自動ピン解除**: 送信前にユーザーがメッセージを編集し、Codexエントリ名が入力欄から消えた場合、そのエントリの自動ピン留めを解除する。ただし手動ピン留め（「+」ボタンやピルプレビューのPinボタン経由）されたエントリは編集で解除されない。これを区別するため、`pinned_codex` の各エントリに `source: 'manual' | 'chat_mention'` を保持する
- **Pin with children**: Codexエントリのピン留め時に「子エントリも含める」オプションを提供。選択すると親+全直接子エントリをまとめてピン留めし、それぞれcontent全文が注入される（手動ピンはサブツリートークン予算を無視する）。個別の×ボタンで子エントリ単位の除外も可能

### 折りたたみ

コンテキストバーのヘッダー行をクリックで折りたたみ/展開。折りたたみ時はトークン数のみ表示。

---

## C. メッセージリスト

### メッセージの種類

**ユーザーメッセージ**
- 右寄せのバブル
- テキストのみ（Markdownレンダリングなし）
- ホバーで「Edit」「Delete」ボタン表示

**AIメッセージ**
- 左寄せのバブル（幅広め、最大95%）
- Markdownレンダリング（見出し、太字、斜体、リスト、コードブロック対応）
- ストリーミング中はトークンごとにインクリメンタル表示
- メッセージ下部にアクションボタン群
- メタ情報行: モデル名、トークン数、生成時間

**システムメッセージ**
- 中央寄せのテキスト（薄いスタイル）
- セッション開始、シーンコンテキスト変更、エラー通知に使用

### AIメッセージのアクションボタン

```
[Insert] [Codex] [Snippet] [Copy]          [⋮]
```

| ボタン | 動作 |
|--------|------|
| Insert | メッセージ全文（またはテキスト選択範囲）をEditorのカーソル位置に挿入。AuthorshipMark `{ source: 'ai', model, chatMessageId }` を付与。挿入後、エディタで一時的にハイライト表示（2秒でフェード）。**ホバー時**: Editorのカーソル位置にゴーストテキスト（挿入予定のテキスト、薄い半透明表示）を表示し、挿入位置・内容をプレビュー。マウスアウトでゴーストテキスト消去 |
| Codex | Codexエントリを即時作成（後述） |
| Snippet | メッセージ全文（またはテキスト選択範囲）をSnippetとして保存 |
| Copy | メッセージ全文をクリップボードにコピー。**Authorship伝搬**: `text/plain` と `text/html` に加え、カスタムMIMEタイプ `application/x-grimodex-authorship` にAIメッセージとしてのAuthorship情報（`{ source: 'ai', model, chatMessageId }`）を付与する。ペースト先のTipTapエディタ（本文、Codex、Snippet）でAuthorshipMarkが復元される |
| ⋮ | オーバーフローメニュー: Regenerate / Edit prompt / Delete |

### メッセージ内テキスト選択

AIメッセージ内のテキストを選択すると、選択範囲の近くにフローティングツールバーが表示される:

```
[Insert selection] [Codex] [Snippet] [Copy]
```

これにより、メッセージ全体ではなく一部分だけを挿入・抽出できる。テキスト選択コピー（`Ctrl+C`）時も同様に `application/x-grimodex-authorship` を付与する。

### Codex抽出（即時作成）

「Codex」ボタン押下時、ダイアログを経由せず即座にCodexエントリを作成する。
抽出モードはChatパネルのヘッダーまたは設定でトグル切り替え可能:

**AI抽出モード（デフォルト）:**
- 軽量モデル（haiku等）でメッセージ内容を解析し、以下を自動提案して即時作成:
  - Name: メッセージ内容から抽出
  - Type: character / location / item / lore を自動判定
  - Content: メッセージ全文、またはテキスト選択範囲
  - Tags: 内容から自動生成
- 作成後、トースト通知「Added to Codex: {name}」（クリックでCodexパネルへ遷移）

**通常抽出モード:**
- Content以外のフィールドを空白のまま即時作成:
  - Name: 空白（Codexパネルで後から編集）
  - Type: なし
  - Content: メッセージ全文、またはテキスト選択範囲（未加工）
  - Tags: なし
- 作成後、トースト通知「Added to Codex (unnamed)」（クリックでCodexパネルへ遷移）

**共通:**
- 保存後、元メッセージに「Codex抽出済み」バッジ表示
- `source_chat_message_id` で元メッセージとの紐付けを保持

### Snippet保存

「Snippet」ボタン押下時:

- メッセージ全文（またはテキスト選択範囲）をSnippetとして即時保存
- 保存後にトースト通知「Saved as Snippet」
- Snippetのメタデータ: `{ source_chat_message_id, scene_id }`
- 保存されたSnippetはSnippetsパネルに表示され、エディタへD&D挿入可能

### ストリーミング表示

- Vercel AI SDKの `streamText()` を使用
- トークンごとにインクリメンタル表示（リアルタイムMarkdownレンダリング）
- ストリーミング中はアクションボタンを非表示（完了後に表示）
- ストリーミング中は入力エリアに「Stop」ボタンを表示（クリックでAbort）
- ストリーミング完了後にメタ情報（モデル名、トークン数、生成時間）を表示

### メッセージの編集と再生成

**Edit prompt（ユーザーメッセージ編集）**:
- ユーザーメッセージのホバーで「Edit」ボタン
- クリックするとメッセージが入力エリアに戻り、以降のメッセージ（AIの応答含む）を削除
- 編集して再送信

**Regenerate（AI応答の再生成）**:
- AIメッセージのオーバーフローメニュー → Regenerate
- 同じプロンプトでAIに再リクエスト
- 旧応答は削除して新応答に置き換え

**Regenerate時の抽出済みエンティティの扱い:**
- 旧応答から既に抽出されたCodexエントリおよびSnippetsは**保持する**（独立したエンティティとして存在するため、メッセージ削除の影響を受けない）
- 旧応答の `id` を参照していた `codex_entries.source_chat_message_id` および `snippets.source_chat_message_id` は、メッセージ削除時にFK `ON DELETE SET NULL` によりNULL化される
- 新応答の `metadata.extractedCodex` / `metadata.extractedSnippets` 配列は空の状態で開始する
- UI: 旧応答に表示されていた抽出バッジは新応答には引き継がれない

---

## D. 入力エリア

### 構造

```
┌──────────────────────────────────────┐
│ テキスト入力エリア（複数行対応）       │
│                                      │
│ [/]                  Sonnet 4.6 [▶]  │
└──────────────────────────────────────┘
```

### テキスト入力

- **TipTapミニインスタンス**（Content用TipTapのサブセット）
- 対応記法: 太字、斜体、インラインコード、リスト（見出し・画像は非対応）
- Markdown記法をリアルタイムにリッチテキストとしてレンダリング
- `Enter` で送信、`Shift+Enter` で改行（TipTapのキーマップでハンドル）
- 入力内容に応じて高さが自動伸縮（最大5行まで、それ以降はスクロール）
- プレースホルダー: 「Ask about this scene...」
- **CodexHighlight対応**: エディタ本文と同じCodexHighlight Pure Decorationを適用。入力中にCodexエントリ名がハイライトされ、チャット言及による自動ピン留めの対象が視覚的に確認できる
- **@メンション補完**: `@` 入力でCodexエントリの補完候補をポップアップ表示。選択するとエントリ名が挿入され、自動ピン留めの対象になる。`context_mode = hidden` のエントリは候補に表示しない
- **送信時のテキスト変換**: 送信時にTipTapのHTML→Markdownに変換してLLMに渡す

### 特殊入力

**/ コマンド**:
- `/` を入力するとコマンド一覧を表示

| コマンド | 動作 |
|---------|------|
| `/continue` | 現在のシーンの続きを書くよう指示 |
| `/describe {対象}` | 対象の描写を生成 |
| `/dialogue {キャラ名}` | キャラクターの台詞を生成 |
| `/summarize` | 現在のシーンの要約を生成 |
| `/brainstorm` | プロットのブレインストーミング |
| `/rewrite` | エディタで選択中のテキストの書き直しを依頼 |
| `/translate {lang}` | 選択テキストの翻訳 |

コマンドはシステムプロンプトに追加のインストラクションとして注入される。

### モデル選択

入力エリア右下にモデル名を表示（例: 「Sonnet 4.6」）。クリックでモデル選択ドロップダウン:

- 設定済みのモデル一覧を表示
- 最後に使用したモデルがデフォルト
- モデルの変更はセッション内で即時反映

### 送信ボタン

- テキストが入力されている場合: ▶（Send）ボタンが有効化
- ストリーミング中: ■（Stop）ボタンに変化

---

## セッションモデル

### セッションとシーンの関係

- 1つのシーンに対して複数のセッション（会話スレッド）を作成可能
- セッションはシーンのnode IDに紐づく
- Editorのアクティブシーンが切り替わると、そのシーンの最新セッションを自動表示

### セッション一覧

ヘッダーの「Sessions」ボタンで開くサイドシート:

```
┌────────────────────────────────┐
│ Sessions for: The tower        │
│                                │
│ ● Character deep-dive (active) │
│   Today 14:30 · 8 messages     │
│                                │
│   Tower history & lore         │
│   Yesterday · 12 messages      │
│                                │
│   Initial scene setup          │
│   Mar 28 · 4 messages          │
│                                │
│ [+ New session]                │
└────────────────────────────────┘
```

- 各セッションにはタイムスタンプとメッセージ数を表示
- クリックでセッション切り替え
- 右クリックで「Rename」「Delete」

### セッションタイトルの自動生成

セッション作成直後のタイトルは仮の「New session」。AIの最初の応答がストリーミング完了した時点で、裏で軽量モデルにタイトル生成リクエストを送る。

**生成フロー**:
1. ユーザーが最初のメッセージを送信
2. AIの応答ストリーミングが完了
3. バックグラウンドで軽量モデル（ユーザーの設定モデルとは別、Settingsで設定可能。デフォルト: 同プロバイダの最安モデル）に以下を送信:
   ```
   Summarize this conversation's topic in 3-6 words (same language as input):
   User: {最初のユーザーメッセージ}
   Assistant: {最初のAI応答の先頭200文字}
   ```
4. 生成されたタイトルで `chat_sessions.title` を更新
5. UIに反映（Chatパネルヘッダー、セッション一覧、Chat Historyパネル）

**フォールバック**:
- LLM要約が失敗した場合（API エラー、タイムアウト等）→ 最初のユーザーメッセージの先頭30文字を切り詰めて使用
- Ollamaなどオフライン環境でサマリーモデルが利用不可の場合も同様にフォールバック

**手動リネーム**:
- 自動生成されたタイトルはいつでも手動でリネーム可能
- 手動リネーム後はフラグを立て、自動再生成を抑制する（`chat_sessions.title_manual` = true）

### プロジェクトスコープのセッション

シーンに紐づかない「プロジェクト全体」のセッションも作成可能。ヘッダーのシーンインジケーターを「Project」に切り替えることで、プロジェクト全体の設定相談やプロット議論が可能。

---

## コンテキスト注入

### 階層モデル

LLM APIのシステムプロンプトに以下の5レイヤーを階層的に注入する。

**Layer 1: Project info（常時）**
- プロジェクトタイトル、ジャンル、視点、文体ガイド
- ユーザーがSettingsで設定した「AI指示（グローバル）」
- ~500-2,000 tokens

**Layer 2: storySoFar（スライディングウィンドウ）**
- 現在のアクティブシーンより前の全シーンの `synopsis` を時系列順に結合し、「これまでの物語」としてシステムプロンプトに注入
- Synopsisが未記入のシーンはスキップ（本文フォールバックはしない — トークン爆発防止）
- トークン予算に応じて、古いシーンのSynopsisから順に切り詰め（直近のシーンを優先）
- Synopsisが全て未記入の場合はLayer 2自体を省略
- ~500-4,000 tokens

**Layer 3: Current scene + previous（常時）**
- 現在のアクティブシーンの全文
- 直前シーンの synopsis + 末尾段落（最大3段落）。直前シーンの全文は含めない（トークン効率のため。全文が必要な場合はAgent modeの `get_scene` ツールを使用）
- ~2,000-12,000 tokens

**Layer 4: Codex entries + Snippets**
- **context_mode フィルタ**: 各エントリの `context_mode` により注入可否を判定（Codexパネル設計書「コンテキスト制御モード」セクション参照）
  - `hidden`: 注入リストから完全除外（ピンリストにあっても除外）
  - `always`: 自動検出の有無に関わらず常に注入
  - `mentioned`（デフォルト）: シーン内で検出された場合に注入
  - `suppress`: 自動検出では注入しない。ピン留めされている場合のみ注入
- 注入対象のCodexエントリのsummary + カスタムディテール（`include_in_context = 1`）。**summaryが未記入の場合はcontent全文をフォールバックとして注入する**
- コンテキストバーでピン留めされたCodexエントリの全文 + カスタムディテール
- **チャット言及による自動ピン留め**: ユーザーのチャットメッセージ内でCodexエントリ名が検出された場合、セッションの `pinned_codex` に自動追加し、content全文を注入する（シーン本文の自動検出とは区別）
- コンテキストバーでピン留めされたSnippetの全文
- **子孫エントリの自動注入**: 上記でマッチした親Codexエントリの子孫エントリのsummaryを、サブツリートークン予算（エントリごとに設定、デフォルト800tok）の範囲内でBFS（幅優先）順に自動追加。depth制限はなく、予算が自然な制限として機能する（子のcontext_modeも個別に判定。Codexパネル設計書「コンテキスト注入への影響」セクション参照）
- 予算超過時の優先順: always > mentioned > pinned content > 子孫エントリsummary（最初に切り詰め）
- ~500-6,000 tokens（子エントリ・Snippet・カスタムディテールの注入により上限が上がる可能性）

#### 検討済み・不採用のコンテキスト注入モード

以下のモードを検討したが、いずれもグローバルモードとしては追加しない。

**Strict モード（子エントリのcontent全文注入 + 無制限depth拡張）:**
- 想定: ピン留めした親エントリの子のcontent全文を注入し、depth 2+まで無制限に辿る
- メリット: 子エントリの詳細情報をAIに渡せる。深い階層（例: 太郎 → 能力 → 火魔法）も参照可能
- 不採用理由: トークン消費が予測不能に膨張する（子10個 × 500tok = 5,000tok追加）。depth 2+は指数的に増加。代わりにサブツリートークン予算方式を採用（Codexパネル設計書参照）: 親エントリごとにトークン上限（デフォルト800tok）を設定し、BFS順でsummaryを注入。予算が自然な深さ制限として機能する

**Deep-dive モード（リレーション無関係にContent内の全言及Codexとその子を注入）:**
- 想定: Content本文中で言及されている全Codexエントリ+その子を、明示的リレーションの有無に関係なく注入
- メリット: リレーション未設定でも関連エントリを自動発見できる。探索的質問に強い
- 不採用理由: 言及スキャンは曖昧マッチでノイズが多い（「城」→「城壁」「城下町」等）。コンテキスト爆発のリスクが高い。Codex設計書の「Content言及からのリレーション提案」機能（ユーザーが確定/却下を選択）で代替可能であり、Deep-diveはその設計思想と矛盾する

**代替として採用: 「Pin with children」操作**（ピン留めセクション参照）

**Layer 5: Conversation history**
- 現在のセッションのメッセージ履歴
- **Progressive summarization**: メッセージ数が閾値（8往復）を超え、かつトークン予算に収まらない場合、古いメッセージ群をLLMで要約し「会話要約」として先頭に保持する。直近の会話は原文を維持
- ユーザーが「重要」マーク（⭐）を付けたメッセージは要約対象から除外し、原文を保持する
- 要約生成にはSettingsのサマリー用モデルを使用（Synopsis自動生成と同じモデル）
- フォールバック: 要約生成に失敗した場合は従来のFIFO切り詰めを適用
- ~2,000-8,000 tokens

### トークン予算管理

- 合計トークン数を `js-tiktoken` で計算
- 使用モデルのコンテキスト上限から逆算して各レイヤーの予算を配分
- 予算超過時の優先順位: Layer 1 > Layer 3 > Layer 2 > Layer 4 > Layer 5
- コンテキストバーに合計トークン数を常時表示
- **プロンプトプレビュー**: コンテキストバーのトークン数ピルをクリックすると、実際にLLMに送信されるシステムプロンプト全文をモーダルで表示。レイヤーごとのトークン内訳（L1: 800, L2: 2,100, L3: 8,500, L4: 3,200, L5: 4,800）も可視化する。デバッグやコンテキストチューニングに使用

### コンテキスト構築の関数

```typescript
function buildContext(sceneId: string, session: ChatSession): SystemPrompt {
  const budget = getModelContextLimit(session.model) - reserveForResponse(2000);

  // 優先順位: Layer 1 > Layer 3 > Layer 2 > Layer 4 > Layer 5
  const layer1 = buildProjectInfo();          // 常時含める
  const layer3 = buildSceneContext(sceneId);  // 現在シーン全文 + 前シーンsynopsis&末尾3段落
  const layer2 = buildStorySoFar(sceneId, remainingBudget);  // storySoFar（L5より優先）
  // チャットメッセージ内のCodex言及を検出し、自動ピン留め（source: 'chat_mention'）
  // 入力エリアのCodexHighlight/@メンションから検出済みのIDを取得
  const chatMentionedIds = detectCodexMentions(userMessage);
  // 手動ピン（source: 'manual'）はそのまま維持、chat_mentionは差分更新
  const updatedPins = reconcilePins(session.pinnedCodex, chatMentionedIds);
  const layer4 = buildCodexContext(sceneId, updatedPins);
  // buildCodexContext 内で context_mode フィルタ適用:
  //   hidden → 除外、always → 無条件追加、mentioned → 検出時のみ、
  //   suppress → ピンリスト存在時のみ
  // summaryが未記入の場合はcontent全文をフォールバック注入
  // カスタムディテール（include_in_context=1）も注入対象に含める
  // 子孫エントリはサブツリートークン予算内でBFS順に注入
  const layer5 = buildConversationHistory(session.messages, remainingBudget);
  // Progressive summarization: 8往復超のメッセージは要約化
  // ⭐マーク付きメッセージは要約対象から除外

  return assembleLayers([layer1, layer2, layer3, layer4, layer5]);
}
```

---

## AIプロバイダ設定（BYOK）

### 対応プロバイダ

| プロバイダ | SDK | 特記事項 |
|-----------|-----|---------|
| OpenRouter | Vercel AI SDK `openrouter` | 推奨デフォルト。500+モデルに単一キーでアクセス |
| Anthropic | Vercel AI SDK `anthropic` | Claude直接利用 |
| OpenAI | Vercel AI SDK `openai` | GPT-4o等 |
| Ollama | Vercel AI SDK `ollama` | ローカルモデル。オフライン対応 |

### APIキーの保存

- Tauri keyring（macOS: Keychain、Windows: Credential Manager、Linux: KWallet）で安全に保存
- フロントエンドにはキーを渡さず、Tauri Command経由でRustバックエンドがAPI呼び出しを行う
- 設定画面でキーの追加/削除/テスト接続が可能

### モデル選択

- プロバイダごとに利用可能なモデル一覧を取得（APIまたはハードコード）
- ユーザーがデフォルトモデルを設定
- チャット入力エリアからセッション単位でモデルを切り替え可能

---

## メッセージのコンテキストメニュー

### ユーザーメッセージの右クリック

| メニュー項目 | 動作 |
|-------------|------|
| Edit | メッセージを入力エリアに戻し再編集 |
| Copy | メッセージをクリップボードにコピー。Authorship情報 `{ source: 'human' }` を `application/x-grimodex-authorship` に付与 |
| Delete | このメッセージと以降の応答を削除 |

### AIメッセージの右クリック

| メニュー項目 | 動作 |
|-------------|------|
| Insert to editor | メッセージ全文をエディタに挿入 |
| Add to Codex | Codexエントリを即時作成 |
| Save as Snippet | Snippetとして保存 |
| Copy | クリップボードにコピー。Authorship情報 `{ source: 'ai', model, chatMessageId }` を `application/x-grimodex-authorship` に付与 |
| --- | |
| Regenerate | 同じプロンプトで再生成 |
| Delete | このメッセージを削除 |

### テキスト選択時の右クリック（AIメッセージ内）

通常メニューの先頭に以下が追加:

| メニュー項目 | 動作 |
|-------------|------|
| Insert selection | 選択範囲のみをエディタに挿入 |
| Add selection to Codex | 選択範囲でCodexエントリを即時作成 |
| Save selection as Snippet | 選択範囲をSnippetとして保存 |

---

## DBスキーマ

### テーブル定義

```sql
CREATE TABLE chat_sessions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  node_id     TEXT REFERENCES tree_nodes(id),  -- NULLの場合はプロジェクトスコープ
  title       TEXT NOT NULL DEFAULT 'New session',
  title_manual INTEGER NOT NULL DEFAULT 0,  -- 1の場合、自動タイトル再生成を抑制
  model       TEXT NOT NULL DEFAULT 'openrouter/anthropic/claude-sonnet-4.6',
  pinned_codex TEXT,            -- JSON array of {id, source} objects. source: 'manual' | 'chat_mention'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chat_messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,     -- 'user' | 'assistant' | 'system'
  content     TEXT NOT NULL,
  model       TEXT,              -- assistant メッセージのみ: 使用モデル
  tokens_in   INTEGER,           -- 入力トークン数
  tokens_out  INTEGER,           -- 出力トークン数
  duration_ms INTEGER,           -- 生成時間（ミリ秒）
  metadata    TEXT,              -- JSON: { extractedCodex: [...], extractedSnippets: [...] }
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_sessions_node ON chat_sessions(project_id, node_id);
CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at);
```

### 抽出バッジの管理

メッセージからCodex/Snippetを抽出した場合、`chat_messages.metadata` のJSON内に抽出先IDを記録:

```json
{
  "extractedCodex": ["codex-entry-id-1"],
  "extractedSnippets": ["snippet-id-1", "snippet-id-2"]
}
```

これによりメッセージ上に「Codex抽出済み」「Snippet保存済み」のバッジを表示し、抽出先へのリンクも提供できる。

---

## キーボードショートカット

### Chatパネルにフォーカス時

| ショートカット | 動作 |
|-------------|------|
| `Enter` | メッセージ送信 |
| `Shift+Enter` | 改行 |
| `Escape` | ストリーミング中止 / 入力クリア |
| `↑`（入力欄が空の時） | 直前のユーザーメッセージを入力欄に戻す（編集用） |
| `Ctrl+Alt+C` | Chatパネルへのフォーカス（レイアウト設計書で定義済み） |

---

## 他パネルとの連携

### Editor → Chat

- Editorのアクティブタブ変更 → Chatのシーンコンテキスト更新
- Editorのコンテキストメニュー「Look up in Chat」→ 選択テキストをChat入力欄に挿入
- Editorのコンテキストメニュー「Open in Chat」（Scenesパネル経由）→ そのシーンのセッションを開く
- `/rewrite` コマンド → エディタで選択中のテキストをコンテキストに含めて送信

Note: EditorにはインラインAIコマンド機能がある（`/` またはCtrl+Shift+Space でトリガー）。インラインAIはChatの会話履歴に残らないワンショット生成で、結果はエディタ内にdiff表示される。Chat /コマンドとインラインAIは同じコマンド名を共有するが、実行コンテキストと結果表示方法が異なる。詳細はEditorパネル設計書の「インラインAIコマンド」セクション参照。

### Chat → Editor

- 「Insert」ボタン → エディタのカーソル位置に挿入、AuthorshipMark付与
- 挿入後のハイライトフラッシュ（2秒間、薄いパープル背景でフェードアウト）

### Chat → Codex

- 「Codex」ボタン → Codexエントリを即時作成（AI抽出/通常抽出モードに応じて） → `codex_entries` に保存
- 保存時に `source_chat_message_id` を記録
- Codexパネルの各エントリに「抽出元チャット」へのリンクを表示

### Chat → Snippets

- 「Snippet」ボタン → `snippets` テーブルに保存
- 保存時に `source_chat_message_id` を記録
- Snippetsパネルで一覧表示、エディタへD&D挿入可能

### Codex → Chat（逆方向）

- Codex QuickセクションやCodexパネルからエントリをChatにピン留め

- 自動検出されたCodexエントリのシステムプロンプト注入

---

## エラーハンドリング

### API呼び出しエラー

| エラー種別 | 表示 | 動作 |
|-----------|------|------|
| ネットワークエラー | システムメッセージ「Connection failed」| 自動リトライ（3回、指数バックオフ） |
| 認証エラー (401) | システムメッセージ「Invalid API key」| Settings画面へのリンク表示 |
| レート制限 (429) | システムメッセージ「Rate limited. Retry in {N}s」| 表示されたN秒後に自動リトライ |
| コンテキスト超過 | システムメッセージ「Context too long」| Layer 2/5を自動トリムして再送信 |
| 一般エラー (5xx) | システムメッセージ「Server error」| 手動リトライボタン表示 |

### ストリーミング中断

- ユーザーがStopボタンを押した場合: 受信済みテキストを保持し、不完全な応答として表示。「Stopped」バッジ付き
- ネットワーク断の場合: 受信済みテキストを保持し、「Interrupted — Retry」ボタン表示

### オフライン / ネットワーク不通時のUX

Grimodexはローカルファーストアプリケーションである。

**ネットワーク不通時に動作する機能（全て正常動作）:**
- テキスト編集（Editor）
- Scenes/Codex/Snippetsの閲覧・編集
- リビジョン履歴の閲覧・復元
- ローカルOllamaモデルを使用したAIチャット

**ネットワーク不通時に失敗する機能:**
- クラウドLLMプロバイダ（OpenAI、Anthropic、OpenRouter等）へのAPIコール
- AIチャット、インラインAI、エージェントモード（Ollama以外）

**エラー処理:**
- LLM APIコール失敗 → チャット内にインラインエラーメッセージ + 「Retry」ボタン
- ストリーミング中断 → 受信済み部分を表示し、エラーバナーを付与
- 自動機能（Codexハイライト、ピン検出等）はLLMに依存しないため影響なし

---

## 既存設計書との整合

### レイアウト設計書

Chatパネルはdock/float可能。デフォルト位置はRight Dock。パネルの状態遷移（Closed/Docked/Collapsed/Floating）はレイアウト設計書の記載に従う。

### Editorパネル設計書

「Chat → Editor」の挿入時のAuthorshipMark付与、フローティングツールバー「Look up in Chat」の動作はEditorパネル設計書の記載を正とする。

### Scenesパネル設計書

Codex Quickセクションのデータソース（`sceneCodexMatches`）は、Chatのコンテキスト注入Layer 4と同じZustandストアを共有する。

### Chat Historyパネル設計書

Chatパネルのヘッダーにある「Sessions」サイドシートは**当該シーンのセッション一覧に限定**し、素早いセッション切り替えに使う。プロジェクト全体の横断検索はChat Historyパネルが担う。Chat Historyからセッションをクリックすると、Chatパネルがそのセッションに切り替わる。
