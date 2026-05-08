# Grimodex Chatパネル設計書

## 概要

ChatパネルはGrimodexのコア体験を担うAI対話パネル。現在のシーンをコンテキストとしてLLMと会話し、生成テキストをエディタに挿入したり、会話から知識をCodex/Snippetとして抽出・構造化する。BYOK（Bring Your Own Key）方式で複数のAIプロバイダに対応する。

デフォルト位置: Right Dock（表示状態）

設計思想: **AIチャットが執筆体験の中心。チャットから生まれた知識（キャラクター設定、プロット断片、世界観メモ）をCodex/Snippetとして構造化し、再利用する。**

### 用語対応（UI ↔ 内部名）

| UI 表記 | 旧称（本書内の歴史的記述） | 内部名（DB / コード識別子） |
| ------- | ------------------- | ------------------------- |
| Spotlight / 🔦 | ピン留め / 📌 | `pinned_codex` / `chat_session_pinned_codex` / `pinSource: 'manual' \| 'chat_mention'` / `inputPinnedEntries` 等 |
| Unspotlight | ピン解除 | `unpinCodexEntry` 等 |
| Spotlight 候補 (✨) | （新規） | `spotlightSuggestion.ts` / `computeSpotlightCandidates` |

UI 用語は `feat(chat,codex): ピン留めを Spotlight にリネーム` で全面置換済み。**DB 列名およびコード識別子は `pinned_*` のまま**であり、本書の DB スキーマ章とコードフロー記述では旧来の識別子を保持する。本文中の「ピン留め」は UI 上「Spotlight」と読み替えること。

---

## パネル構造

```
┌──────────────────────────────────────┐
│ A. Header                            │
│ Chat 🌐 Scene:The tower [Sessions][+]│
├──────────────────────────────────────┤
│ B. Context bar                       │
│ [Elara] [taro] [the child]           │
│ [Obsidian Tower] (📌ピン留め) ~3,200 tokens / 8k │
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
│ │ [@] [/] [🛠️]    (Sonnet 4.6) [▶] │ │
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

---

## A. ヘッダー

### 表示要素

- **パネルタイトル**: 「Chat」
- **🌐 グローバルチャットボタン**: ワンクリックでプロジェクトスコープ（`node_id = NULL`）に切り替え。再度クリックでアクティブシーンに復帰。プロジェクトスコープ時はシーンインジケーターが「Project」に切り替わる
- **シーンインジケーター**: 現在のアクティブシーン名。クリックでシーン選択ドロップダウン（Chatのコンテキストをエディタのアクティブシーンから手動で切り替える場合に使用）
  - ドロップダウンはツリー上の **フォルダ単位でグループ化** して表示する。各グループ見出しは親フォルダのタイトル（親無しのシーンは "Uncategorized"）、見出し下にそのフォルダ直下のシーンを列挙する。プロジェクトスコープ（🌐）時は選択されているグループ無し状態で「Project」ラベルが表示される
  - 現在の実装は `ChatPanelHeader.tsx` の `sceneGroups` 構築ロジック（`nodes.filter(nodeType === 'folder')` でフォルダタイトルを参照しつつ scene を `parentId` でグループ化）に対応する
- **Sessions ボタン**: セッション一覧サイドシートを開く（後述）
- **+ ボタン**: 新しいセッションを作成

### シーン連動

チャットセッションはシーンごとに独立している。Editorで別のシーンを開くと、Chatパネルもそのシーンのセッションに自動で切り替わる。

- シーン切替時の動作:
  1. 切替先のシーンに既存セッションがあれば → 最新セッションを表示
  2. なければ → 空の新規セッション画面を表示
- 同じシーンに戻れば、前回のセッションがそのまま復帰する
- シーンインジケーターのクリックで、エディタのアクティブシーンとは異なるシーンを手動選択することもできる

**Codex/Snippetタブの場合（G19 アクティブタブ content 注入）**: Editor のアクティブタブが Codex または Snippet タブの場合、ヘッダーのシーンインジケーターは「Codex: {エントリ名}」または「Snippet: {title}」に切り替わる。このときシステムプロンプトの Layer 3 にはシーン本文の代わりに **そのアクティブタブが指す Codex エントリ／Snippet の content 全文** をそのまま注入する（L3 の予算枠を流用）。L2（storySoFar）は省略。セッションはプロジェクトスコープ（`node_id = NULL`）として扱う。これにより「今編集中の Codex / Snippet について AI と壁打ちする」ユースケースで、シーン本文ではなく編集対象エントリが主コンテキストになる

---

## B. コンテキストバー

### 概要

LLMに送信されるコンテキスト情報をユーザーに可視化するバー。ヘッダー直下に表示し、折りたたみ可能。

### 表示するピル

| ピル | 色 | 内容 |
| --- | --- | --- |
| 📌 {Codexエントリ名} | Blue/Info | ピン留めされたCodexエントリ（content全文を注入）。クリックでポップオーバー（summary、カスタムディテール概要、「Open in Codex →」リンク）。×で除外 |
| {Codexエントリ名} | Blue/Info | 自動検出されたCodexエントリ（summaryのみ注入）。クリックでポップオーバー（上記に加え「📌ピン留め」ボタンを表示。ピン留めでcontent全文に昇格）。×で除外 |
| {Codexエントリ名} | Blue/Info | `context_mode = always` のエントリ（summaryのみ注入）。常に表示。ポップオーバーからピン留めでcontent全文に昇格。×で一時除外可能（セッション内） |
| {子エントリ名} via {親名} | Blue/Info | 自動注入された子エントリ（summaryのみ注入）。×で個別除外可能 |
| {Codexエントリ名} ⏱{N} | Blue/Info | フェーズを持つCodexエントリ。⏱{N}バッジはフェーズ数を表示。シーンスコープ時はアクティブシーン時点の状態が注入される。プロジェクトスコープ時はタイムライン全体が注入される（Codexパネル設計書「フェーズシステム」セクション参照） |
| {Snippet名} | Purple | ピン留めされたSnippet。クリックでSnippet詳細。×で除外 |
| ~{N} tokens | グレー（右寄せ） | システムプロンプトの合計トークン数概算。クリックでプロンプトプレビューモーダルを表示（全文 + レイヤー別トークン内訳） |
| {N}k | グレー（右寄せ） | 選択モデルのコンテキストウィンドウサイズ |

### グループ化表示

Codex + Snippet のピル合計が コンテキストバーの横幅に収まらずオーバーフローした場合、個別ピル表示からグループ化表示に自動的に切り替わる。判定は ResizeObserver で DOM 実幅と各ピルの実寸を測定して行い、実際にはみ出すピル数が 1 個でも発生した時点でグループ化に遷移する。

**フォールバック**: 初回レンダリング時など DOM が未マウントで実寸が測定できない場合は、「ピル合計が 6 個を超えたらグループ化」という閾値ベースの判定を一時的に用いる。マウント完了後は DOM 実幅ベースの判定が上書きする。

**通常表示**（6個以下）:
```
[📌 Elara] [Taro] [Lira] [Ancient Tower] [+]  ~2,800 tokens / 8k
```

**グループ化表示**（7個以上）:
```
[Characters ▾ (5)] [Locations ▾ (2)] [Snippets ▾ (3)] [+]  ~4,200 tokens / 8k
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

### ピン留め

- コンテキストバー末尾の「📌ピン留め」ボタンで、CodexエントリまたはSnippetを手動ピン留め
- **✦ AI コンテキストクリエイター（Context Creator）**: 「+」ボタンの隣に配置。AI が Tool Use でプロジェクトデータを能動的に探索し、現在のシーン／セッションに関連する Codex エントリや Snippet をコンテキスト候補として提案する
  - 利用ツールは `search_codex` / `list_codex_by_type` / `search_codex_by_tags` / `search_snippets` の 4 種に絞った専用サブセット（Agent mode の 10 ツールとは別定義。読み取り・探索寄りのツールのみ）
  - 実行本体は `runContextCreator`。Agent mode と同じループ基盤上で動くが、最終出力は自然言語応答ではなく「提案エントリ ID のリスト」で、ユーザーの確認後に手動ピン留めとして `pinned_codex` に追加される
  - UI は 🛠️ オプションや Settings からの公開を前提に実装基盤のみ用意しており、現時点ではボタンを無効化状態で提示する（公開保留）。Tool Use が出来ないモデルでは非活性マウスカーソル🚫
- ポップオーバーの検索UIでエントリを選択（Codex/Snippetをタブまたはフィルタで切り替え）
- **`context_mode = hidden` のエントリはピン留め候補に表示しない**
- **`context_mode = suppress` のエントリはミュート表示 + ツールチップ（「ピン留めでAIコンテキストに含まれます」）**
- ピン留めしたエントリはセッション内で永続（セッション終了まで有効）
- 自動検出されたCodexエントリも×ボタンで個別除外可能
- **ピルプレビュー内ピン昇格**: 自動検出（未ピン留め）のCodexエントリのピルをクリックしたポップオーバー内に「Spotlight」ボタンを表示。クリックで Spotlight に昇格し、ピルに 🔦 が付き、以降content全文が注入される
- **✨ Spotlight 候補マーク（自動推薦）**: auto エントリ（detected + always）のうち、本文の充実したエントリを最大 N 件まで「✨ Spotlight candidate」として強調表示する。クリック動作は通常の auto ピルと同じで、Spotlight ボタン押下で content 全文注入に昇格する。ユーザーが「どのエントリを Spotlight 化すべきか」の発見を支援する非破壊的なヒント表示
  - 判定ロジックは `spotlightSuggestion.ts` の `isSpotlightCandidate` / `computeSpotlightCandidates`
  - 採用条件: `content` が空 doc（`{}` または `{"type":"doc","content":[]}`）でない、かつ文字数 ≥ `MIN_CONTENT_LEN`（既定 30）
  - 上限: `MAX_CANDIDATES`（既定 3）。先頭から順に候補化し、すでに pinned のエントリは除外
  - グループ化表示時もグループ内ピル展開後に同じ ✨ マークが付与される
- **チャット言及による自動ピン留め**: ユーザーのチャットメッセージ内でCodexエントリ名が検出された場合（CodexHighlightまたは@メンション経由）、そのエントリをセッションの `pinned_codex` に自動追加する。シーン本文での言及（summary注入）とは異なり、チャットでの言及はユーザーの明確な意図を示すため、content全文を注入する。自動ピン留めされたエントリはContext Barにピルとして表示され、不要な場合は×で除外可能
- **チャット言及の編集による自動ピン解除**: 送信前にユーザーがメッセージを編集し、Codexエントリ名が入力欄から消えた場合、そのエントリの自動ピン留めを解除する。ただし手動ピン留め（「+」ボタンやピルプレビューのPinボタン経由）されたエントリは編集で解除されない。これを区別するため、`pinned_codex` の各エントリに `source: 'manual' | 'chat_mention'` を保持する
- **Pin with children**: Codexエントリのピルのコンテキストメニューに「子エントリも含める」オプションを提供。選択すると親+全直接子エントリをまとめてピン留めし、それぞれcontent全文が注入される（手動ピンはサブツリートークン予算を無視する）。個別の×ボタンで子エントリ単位の除外も可能

### 折りたたみ

コンテキストバーのヘッダー行をクリックで折りたたみ/展開。折りたたみ時はトークン数とコンテキストウィンドウサイズのみ表示。

### プロジェクトスコープ時の挙動

🌐ボタンでプロジェクトスコープに切り替えた場合、コンテキストバーは以下のように変化する:

| 要素                         | シーンスコープ  |     プロジェクトスコープ     |
| -------------------------- | :------: | :----------------: |
| 自動検出ピル（シーン本文からの検出）         |   ✅ 表示   |      ❌ すべて非表示      |
| `context_mode = always` ピル |   ✅ 表示   |        ✅ 表示        |
| 📌 手動ピン留めピル                |   ✅ 表示   |        ✅ 表示        |
| チャット言及による自動ピンピル            |   ✅ 表示   |        ✅ 表示        |
| {子エントリ名} via {親名} ピル       |   ✅ 表示   |        ✅ 表示        |
| Snippetピル                  |   ✅ 表示   |        ✅ 表示        |
| フェーズバッジ ⏱{N}               | シーン時点の状態 |      タイムライン全体      |
| トークン数 / コンテキストウィンドウ        |   ✅ 表示   | ✅ 表示（L2/L3省略分だけ減少） |

**理由**: プロジェクトスコープではシーン本文が存在しないため、シーン本文に基づくAho-Corasick自動検出が実行されない。その結果、自動検出由来のピル（`mentioned` モードで検出されたエントリとその子孫エントリ）はすべてコンテキストバーから消える。ユーザーがプロジェクトスコープでCodexエントリを参照したい場合は、手動ピン留め（+ボタン）、チャット内での@メンション/エントリ名言及、または `context_mode = always` の設定を利用する。

**グループ化表示との関係**: 自動検出ピルが消えることでピル総数が6個以下に減った場合、グループ化表示から通常表示に自動的に戻る。

---

## C. メッセージリスト

### メッセージの種類

**ユーザーメッセージ**
- 右寄せのバブル
- Markdownレンダリング有り
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

### Codex抽出

「Codex」ボタン押下時の抽出フローは 2 系統。AIメッセージ下部のアクションボタン「Codex」クリックで **Quick 抽出** が走り、オーバーフローメニュー（⋮）の「Codex (詳細抽出...)」または右クリック「Add to Codex (Detailed)」で **Detailed 抽出** に切り替わる。

**Quick 抽出（デフォルト、ダイアログを経由しない即時作成）:**
- Type: 常に `lore` 固定（AI 判定を行わない）
- Name: 空白（Codex パネルで後から編集）
- Summary: メッセージ全文（またはテキスト選択範囲）をそのまま `summary` に格納
- Content: 空白
- Tags: なし
- 作成後、トースト通知「Added to Codex」（クリックでCodexパネルへ遷移）
- 速度優先。まず素早く退避しておき、整形はCodex側で後回しにするユースケース向け

**Detailed 抽出（`SnippetExtractionDialog` ベース）:**
- AIメッセージ（またはテキスト選択範囲）を入力として、専用ダイアログ `SnippetExtractionDialog` を開く
- ダイアログ内で軽量モデル（haiku等）がメッセージ内容を解析し、以下をプレビュー表示:
  - Name: メッセージ内容から抽出した候補
  - Type: character / location / item / lore / カスタム type の自動判定候補
  - Summary / Content: 要約と本文の分離候補
  - Tags: 内容から自動生成した候補
- ユーザーはダイアログ上で各フィールドを編集してから確定。キャンセルも可能
- 確定後、トースト通知「Added to Codex: {name}」（クリックでCodexパネルへ遷移）
- Snippet 抽出の `SnippetExtractionDialog` と同じ UI 基盤を共有し、出力先（Codex / Snippet）のみスイッチする

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
│ テキスト入力エリア（複数行対応）        　│
│                                      │
│ [@] [/] [🛠️]       (Sonnet 4.6) [▶]  │
└──────────────────────────────────────┘
```

### テキスト入力

- **TipTapミニインスタンス**（Content用TipTapのサブセット）
- 対応記法: 太字、斜体、インラインコード、リスト（見出し・画像は非対応）
- Markdown記法をリアルタイムにリッチテキストとしてレンダリング
- `Enter` で送信、`Shift+Enter` で改行（TipTapのキーマップでハンドル）
- 入力内容に応じて高さが自動伸縮（最大5行まで、それ以降はスクロール）
- プレースホルダー: 「Ask about this scene...」(プロジェクトスコープ時は「Ask about this project...」)
- **CodexHighlight対応**: エディタ本文と同じCodexHighlight Pure Decorationを適用。入力中にCodexエントリ名がハイライトされ、チャット言及による自動ピン留めの対象が視覚的に確認できる
- @ボタン/ /ボタン : 後述の特殊入力のポップオーバー表示
- 🛠️ボタン: AIのオプションをポップオーバーリスト表示。全て対応モデルのみ活性化。対応機能が一つもない場合はこのボタン自体非活性マウスカーソル🚫(コンテキストバーのAIボタンと同じ)。ポップオーバー内の各トグル状態は `ai_settings` テーブルに永続化され、セッション・再起動をまたいで保持される。
	- **🔧 Agent mode トグル（スタンドアロン実行モード）**: Tool Use を有効化し、LLM がプロジェクトデータを能動的に検索・取得できるモードに切り替える。ON にすると送信時に `runAgentLoop` が起動し、LLM のツール呼び出しをループ実行する:
		- **利用可能ツール（10 種）**: `search_codex` / `list_codex_by_type` / `get_codex_entry` / `list_codex_tags` / `search_codex_by_tags` / `list_chapters` / `get_scene` / `search_scenes` / `search_snippets` / `get_chapter_summaries`
		- **呼び出し上限**: 1 ターンあたり最大 10 回のツール呼び出し。これを超えた場合はループ打ち切りで最終応答生成に遷移
		- **トークン予算制御**: ツール結果の累計トークンが予算を超えそうになった時点で追加ツール呼び出しを抑止し、既取得の結果のみで応答を合成する
		- **進捗 UI**: ループの状態（現在何番目のツールを呼んでいるか／累計ツール呼び出し回数／推定残予算）を `AgentProgressBar` コンポーネントでメッセージリスト上部に可視化する
		- 詳細は AI エージェント設計書（`Grimodex_AIエージェント設計書.md`）参照
	- **💡 Thinking トグル（拡張思考）**: AdaptiveThinking または budget_tokens 方式の拡張思考を有効化する。状態は `ai_settings.thinkingEnabled` に永続化される。対応モデルでは adaptive（Opus/Sonnet 4.6）と budget_tokens（旧世代 Opus/Sonnet 4.5 等）の両方式を自動選択し、display は `summarized` を既定、Synopsis 等軽量タスクでは `omitted` を使う。マルチターン会話では thinking ブロックの `signature` を `chat_messages.metadata` に保存し、次ターンに完全なブロックを返送する（後述「拡張思考」セクション参照）。
		- **パラメータ二系統**: Anthropic 直接／adaptive 方式のモデルには `effort`（`low` / `medium` / `high` / `max`）を送る。OpenRouter 系推論モデル（o1、o3、DeepSeek-R1 等）には `reasoningEffort` を送る。Grimodex はモデル能力に応じて送出先を振り分け、ユーザーは同じトグル + effort レベルから操作する
	- **🌐 RAG トグル**: インターネット検索による RAG のプレースホルダー。UI は 🛠️ オプション内に常設するが、現時点では常に disable・非活性で、中身は将来実装枠として予約する
- **送信時のテキスト変換**: 送信時にTipTapのHTML→Markdownに変換してLLMに渡す

### 特殊入力

**@メンション補完**: 
 - `@` 入力でCodexエントリの補完候補をポップオーバーリスト表示。選択するとエントリ名が挿入され、自動ピン留めの対象になる。`context_mode = hidden` のエントリは候補に表示しない
 - **インメモリピン（送信前の仮ピン）**: @ メンションで挿入されたエントリは、メッセージを送信する前からインメモリで一時的にピン留め扱いされる。DB の `chat_session_pinned_codex` テーブルへの書き込みは送信確定時まで行われず、コンテキストバーには「仮ピン」としてピルが即座に表示される。ユーザーが送信前に入力欄から当該メンションを消した場合は仮ピンも解除される（DB に痕跡を残さない）。送信確定時点で入力欄に残っている仮ピンのみが `source: 'chat_mention'` として永続化される

**/ コマンド**:
- `/` を入力するとコマンド一覧を表示

| コマンド                | 動作                                     |
| ------------------- | -------------------------------------- |
| `/continue`         | 現在のシーンの続きを書くよう指示                       |
| `/describe {対象}`    | 対象の描写を生成                               |
| `/dialogue {キャラ名}`  | キャラクターの台詞を生成(キャラ名の位置でキャラクター一覧をポップオーバー) |
| `/summarize`        | 現在のシーンの要約を生成                           |
| `/brainstorm`       | プロットのブレインストーミング                        |
| `/rewrite`          | エディタで選択中のテキストの書き直しを依頼                  |
| `/translate {lang}` | 選択テキストの翻訳                              |

コマンドはシステムプロンプトに追加のインストラクションとして注入される。

### モデル選択

入力エリア右下にモデル名を表示（例: 「Sonnet 4.6」）。クリックでモデル選択ドロップダウン:

- 設定済みのモデル一覧を表示
- 最後に使用したモデルがデフォルト
- モデルの変更はセッション内で即時反映

### 送信ボタン

- テキストが入力されている場合: ▶（Send）ボタンが有効化
- ストリーミング中: ■（Stop）ボタンに変化
- **右クリックでプロンプト全文コピー**: ▶（Send）ボタンを右クリックするとショートカットメニューが開き、`buildPromptForCopy` が構築した完全なシステムプロンプト（Layer 1〜4）＋ 会話履歴（Layer 5）をクリップボードへコピーする。実際に次ターンへ送信される内容と一致し、プロンプトのデバッグ・共有・外部モデルでの再現確認に使用する

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
- LLM 要約が失敗した場合（API エラー、タイムアウト、レート制限、Ollama などオフライン環境でサマリーモデルが利用不可な場合等）→ 最初のユーザー発話の先頭を切り詰めて使用する発話ベースフォールバックを適用
- フォールバック経路で設定されたタイトルは `title_manual=0` のまま保持し、次回条件が整ったタイミングで自動生成をリトライする対象に残す

**手動リネーム**:
- 自動生成またはフォールバックで設定されたタイトルはいつでも手動でリネーム可能
- ユーザーが手動リネームすると `chat_sessions.title_manual` に 1 を立て、以後の自動再生成・フォールバック再上書きを抑制する

### プロジェクトスコープのセッション

シーンに紐づかない「プロジェクト全体」のセッションも作成可能。ヘッダーの🌐ボタンでプロジェクトスコープに切り替えると、シーンインジケーターが「Project」になる。プロジェクト全体の設定相談やプロット議論に使用する。

---

## コンテキスト注入

### スコープ別のレイヤー適用

チャットのスコープによって、注入されるレイヤーが異なる:

| レイヤー | シーンスコープ | プロジェクトスコープ |
|---------|:----------:|:-----------:|
| L1 Project info | ✅ | ✅ |
| L2 storySoFar | ✅ | ❌ |
| L3 Current scene | ✅ | ❌ |
| L4 Codex entries | ✅ (自動検出+ピン留め、フェーズ解決済み) | ✅ (ピン留めのみ、タイムライン注入) |
| L5 Conversation history | ✅ | ✅ |

- プロジェクトスコープではシーンが存在しないため、シーン依存のL2・L3は省略される
- L4はシーン本文からの自動検出ができないため、ピン留めされたエントリのみ注入
- **フェーズ解決**: シーンスコープではアクティブシーン時点のフェーズ解決済み状態（summary/content/カスタムフィールド/context_mode）を注入。プロジェクトスコープではフェーズを持つエントリに対しタイムライン全体（最新状態 + 変遷リスト）を注入（Codexパネル設計書「フェーズシステム」セクション参照）
- L2・L3が省略される分、余剰トークンはL4・L5に再配分される

### 階層モデル

LLM APIのシステムプロンプトに以下の5レイヤーを階層的に注入する。

**Layer 1: Project info（常時）**
- プロジェクトタイトル、ジャンル、視点、文体ガイド
- ユーザーがSettingsで設定した「AI指示（グローバル）」
- 予算配分: コンテキストの ~2%（最小500tok）

**Layer 2: storySoFar（スライディングウィンドウ）**
- 現在のアクティブシーンより前の全シーンの `synopsis` を時系列順に結合し、「これまでの物語」としてシステムプロンプトに注入
- Synopsisが未記入のシーンはスキップ（本文フォールバックはしない — トークン爆発防止）
- トークン予算に応じて、古いシーンのSynopsisから順に切り詰め（直近のシーンを優先）
- Synopsisが全て未記入の場合はLayer 2自体を省略
- 予算配分: コンテキストの ~10%

**Layer 3: Current scene + previous（常時）**
- 現在のアクティブシーンの全文
- 直前シーンの synopsis + 末尾段落（最大3段落）。直前シーンの全文は含めない（トークン効率のため。全文が必要な場合はAgent modeの `get_scene` ツールを使用）
- 予算配分: コンテキストの ~40%

**Layer 4: Codex entries + Snippets**
- **フェーズ解決**: エントリにフェーズ（経時的変化）が設定されている場合、注入されるsummary・content・カスタムディテール・context_modeはすべて**アクティブシーン時点のフェーズ解決後の値**が使用される。プロジェクトスコープ時はタイムライン全体（最新状態 + 変遷リスト）を注入する。詳細はCodexパネル設計書「フェーズシステム（経時的変化）」セクション参照
- **context_mode フィルタ**: 各エントリの**フェーズ解決後の** `context_mode` により注入可否を判定（Codexパネル設計書「コンテキスト制御モード」セクション参照）
  - `hidden`: 注入リストから完全除外（ピンリストにあっても除外）
  - `always`: 自動検出の有無に関わらず常に注入
  - `mentioned`（デフォルト）: シーン内で検出された場合に注入
  - `suppress`: 自動検出では注入しない。ピン留めされている場合のみ注入
- 注入対象のCodexエントリのフェーズ解決後のsummary + カスタムディテール（`include_in_context = 1`）。**summaryが未記入の場合はフェーズ解決後のcontent全文をフォールバックとして注入する**
- コンテキストバーでピン留めされたCodexエントリのフェーズ解決後の全文 + カスタムディテール
- **チャット言及による自動ピン留め**: ユーザーのチャットメッセージ内でCodexエントリ名が検出された場合、セッションの `pinned_codex` に自動追加し、content全文を注入する（シーン本文の自動検出とは区別）
- コンテキストバーでピン留めされたSnippetの全文
- **子孫エントリの自動注入**: 上記でマッチした親Codexエントリの子孫エントリのsummaryを、サブツリートークン予算（エントリごとに設定、デフォルト: Layer 4予算の15%）の範囲内でBFS（幅優先）順に自動追加。depth制限はなく、予算が自然な制限として機能する（子のcontext_modeも個別に判定。Codexパネル設計書「コンテキスト注入への影響」セクション参照）
- 予算超過時の優先順: always > mentioned > pinned content > 子孫エントリsummary（最初に切り詰め）
- 予算配分: コンテキストの ~20%

**Layer 5: Conversation history**
- 現在のセッションのメッセージ履歴
- **Progressive summarization（G17）**: 以下の2段階トリガーで古いメッセージ群をLLMで要約し「会話要約」として先頭に保持する。直近の会話は原文を維持
  - **予防的圧縮**: 4往復を超え、かつLayer 5予算の80%を消費している場合 → 次のターンでオーバーフローしないよう早めに圧縮
  - **緊急圧縮**: Layer 5予算を超過した場合（往復数問わず、最低3往復経過後）→ 即時圧縮でAPIエラーを回避
  - 最低往復数（3往復）未満では圧縮しない（1〜2往復の要約は意味をなさないため）
  - 判定ロジックは `shouldSummarize`、要約実行は `runSummarization` として分離。ターン開始時のコンテキスト構築で `shouldSummarize` が真を返した場合に `runSummarization` が裏で走り、完了後に新しい要約を先頭へ差し込んだ再計算済みコンテキストで LLM 呼び出しを行う
- **⭐ スター機能**: ユーザーは任意のメッセージに「重要」マーク（⭐）を付与できる（`chat_messages.is_starred` に永続化）。スター付きメッセージは `runSummarization` の入力から除外され、原文のまま Layer 5 に保持される。要約対象から明示的に守りたい宣言やキャラクター設定などを固定するために使用する
- **要約の永続化**: 生成された要約は `chat_summaries` 専用テーブルに保存される（スキーマは後述 DB 章参照）。同一セッションで複数世代の要約を保持し、新規要約は直前世代の要約を「既要約済みメッセージ群」として含める形で累積させる。要約に取り込まれたメッセージは `chat_messages.is_summarized = 1` が立ち、次回の `shouldSummarize` 判定から除外される
- 要約生成にはSettingsのサマリー用モデルを使用（Synopsis自動生成と同じモデル）
- フォールバック: 要約生成に失敗した場合は従来のFIFO切り詰めを適用（`is_summarized` は更新しない）
- 予算配分: コンテキストの ~20%

#### 検討済み・不採用のコンテキスト注入モード

以下のモードを検討したが、いずれもグローバルモードとしては追加しない。

**Strict モード（子エントリのcontent全文注入 + 無制限depth拡張）:**
- 想定: ピン留めした親エントリの子のcontent全文を注入し、depth 2+まで無制限に辿る
- メリット: 子エントリの詳細情報をAIに渡せる。深い階層（例: 太郎 → 能力 → 火魔法）も参照可能
- 不採用理由: トークン消費が予測不能に膨張する。depth 2+は指数的に増加。代わりにサブツリートークン予算方式を採用（Codexパネル設計書参照）: 親エントリごとにLayer 4予算に対する比率でトークン上限を設定し、BFS順でsummaryを注入。予算が自然な深さ制限として機能する

**Deep-dive モード（リレーション無関係にContent内の全言及Codexとその子を注入）:**
- 想定: Content本文中で言及されている全Codexエントリ+その子を、明示的リレーションの有無に関係なく注入
- メリット: リレーション未設定でも関連エントリを自動発見できる。探索的質問に強い
- 不採用理由: 言及スキャンは曖昧マッチでノイズが多い（「城」→「城壁」「城下町」等）。コンテキスト爆発のリスクが高い。Codex設計書の「Content言及からのリレーション提案」機能（ユーザーが確定/却下を選択）で代替可能であり、Deep-diveはその設計思想と矛盾する

**代替として採用: 「Pin with children」操作**（ピン留めセクション参照）


**シーンスコープでのレイヤー個別バイパス（L2/L3オフトグル）:**
- 想定: シーンに紐づいたセッションのまま、L2（storySoFar）やL3（シーン本文）の注入を個別にオフにできるトグル
- ユースケース: シーンに関連するCodexの設定を質問したいが、あらすじやシーン本文は不要な場合。トークン節約
- 不採用理由: コンテキストバーの操作がすでに複雑（ピン留め、自動検出ピル、トークン表示）であり、レイヤー制御を加えるとユーザーの認知負荷が高い。プロジェクトスコープ＋Codexピン留めでほぼ同等のことが可能。「シーンのセッション一覧で見つけたい」という整理面の需要は、将来的にセッションのタグ/フィルタ機能で対応する方が適切


#### 将来の検討事項: 意味的類似性検索（Semantic Retrieval）

現在のCodex検出はAho-Corasickによる完全な字句マッチングのみ。「王冠」というエントリがあるシーンで「王の頭上の宝飾」と書いた場合、aliasに登録しない限り検出されない。

意味的類似性検索により、字句マッチの限界を補完できる可能性がある:

- **アプローチ**: ローカル埋め込みモデル（e.g., all-MiniLM-L6-v2）でCodexエントリのembeddingを生成し、シーンテキストとのコサイン類似度で「関連するかもしれないエントリ」を候補提示
- **導入箇所の候補**:
  1. `mentioned` モードに `mentioned_semantic` サブモードを追加し、閾値を超えたエントリも注入対象にする
  2. Agent mode の `search_codex` ツールにembedding検索オプションを追加（最小実装）
  3. Codex QuickセクションやContext Barで「Suggested by similarity」として候補を表示し、ユーザーがピン留めで確定
- **現時点で不採用の理由**: 現在の設計（Aho-Corasick + alias + Agent mode ツール検索）でほとんどのケースはカバーでき、embedding検索は実装コスト（ローカルモデルの管理、ベクトルDB、インデックス更新）に対してリターンが不確実。実際のユーザーフィードバックでalias運用の限界が顕在化した段階で再検討する

### トークン予算管理

- 合計トークン数を `js-tiktoken` で計算
- **比率ベース配分**: 使用モデルのコンテキスト上限に対する比率で各レイヤーの予算を動的に算出。8kモデルでも1Mモデルでも同じ比率が適用される
- 各レイヤーに最小トークン数（floor）を設定し、小コンテキストモデルでも最低限の機能を保証
- **比率はSettings > AI > コンテキスト予算配分でカスタマイズ可能**（Settingsパネル設計書参照）
- 応答予約: コンテキストの ~5%（最小2,000tok）

| レイヤー | 比率 | 最小floor | 8k モデル | 200k モデル | 1M モデル |
|---------|------|-----------|----------|------------|----------|
| L1 Project | ~2% | 500 | 500 | 4,000 | 20,000 |
| L2 storySoFar | ~10% | 500 | 500 | 20,000 | 100,000 |
| L3 Scene | ~40% | 2,000 | 2,400 | 80,000 | 400,000 |
| L4 Codex | ~20% | 500 | 500 | 40,000 | 200,000 |
| L5 History | ~20% | 1,000 | 1,000 | 40,000 | 200,000 |
| 応答予約 | ~5% | 2,000 | 2,000 | 10,000 | 50,000 |

- 比率は目安であり、実際の注入量がレイヤー予算を下回る場合、余剰は下位優先のレイヤーに再配分する
- 予算超過時の優先順位: Layer 1 > Layer 3 > Layer 2 > Layer 4 > Layer 5
- コンテキストバーに合計トークン数を常時表示
- **プロンプトプレビュー**: コンテキストバーのトークン数ピルをクリックすると、実際にLLMに送信されるシステムプロンプト全文をモーダルで表示。レイヤーごとのトークン内訳（配分比率と実使用量）も可視化する。デバッグやコンテキストチューニングに使用

### コンテキスト構築の関数

```typescript
function buildContext(
  sceneId: string | null,  // null = プロジェクトスコープ
  session: ChatSession,
): SystemPrompt {
  const contextLimit = getModelContextLimit(session.model);
  const responseReserve = Math.max(2000, Math.floor(contextLimit * 0.05));
  const budget = contextLimit - responseReserve;

  // 比率ベースで各レイヤーの予算を算出（floor付き）
  // プロジェクトスコープ時はL2/L3の比率を0にし、余剰をL4/L5に再配分
  const allocations = allocateLayerBudgets(budget, {
    layer1: { ratio: 0.02, floor: 500 },
    layer2: { ratio: sceneId ? 0.10 : 0, floor: sceneId ? 500 : 0 },
    layer3: { ratio: sceneId ? 0.40 : 0, floor: sceneId ? 2000 : 0 },
    layer4: { ratio: 0.20, floor: 500 },
    layer5: { ratio: 0.20, floor: 1000 },
  });

  // 優先順位: Layer 1 > Layer 3 > Layer 2 > Layer 4 > Layer 5
  const layer1 = buildProjectInfo(allocations.layer1);

  // L2/L3: シーンスコープ時のみ構築
  const layer2 = sceneId ? buildStorySoFar(sceneId, allocations.layer2) : null;
  const layer3 = sceneId ? buildSceneContext(sceneId, allocations.layer3) : null;

  // チャットメッセージ内のCodex言及を検出し、自動ピン留め（source: 'chat_mention'）
  const chatMentionedIds = detectCodexMentions(userMessage);
  const updatedPins = reconcilePins(session.pinnedCodex, chatMentionedIds);
  // プロジェクトスコープ時: sceneId=null → 自動検出なし、ピン留めのみ
  const layer4 = buildCodexContext(sceneId, updatedPins, allocations.layer4);
  // buildCodexContext 内でフェーズ解決 + context_mode フィルタ適用:
  //   1. 各エントリのフェーズをアクティブシーン時点で解決（resolveCodexState）
  //      → summary, content, detailValues, contextMode がフェーズ適用後の値に
  //   2. プロジェクトスコープ時はタイムライン全体を俯瞰注入（最新状態+変遷リスト）
  //   3. context_mode フィルタ（フェーズ解決後の値で判定）:
  //      hidden → 除外、always → 無条件追加、mentioned → 検出時のみ、
  //      suppress → ピンリスト存在時のみ
  //   4. summaryが未記入の場合はcontent全文をフォールバック注入
  //   5. カスタムディテール（include_in_context=1）も注入対象に含める
  //   6. 子孫エントリはサブツリートークン予算（Layer 4予算の比率）内でBFS順に注入
  //      （各子エントリも個別にフェーズ解決）
  const layer5 = buildConversationHistory(session.messages, allocations.layer5);
  // Progressive summarization: 2段階トリガー
  //   予防的: 4往復超 && Layer5予算80%超 → 早めに圧縮
  //   緊急:   Layer5予算超過 && 最低3往復経過 → 即時圧縮でAPIエラー回避
  // ⭐マーク付きメッセージは要約対象から除外

  return assembleLayers([layer1, layer2, layer3, layer4, layer5]);
}
```

---

## AIプロバイダ設定（BYOK）

### 対応プロバイダ

#### API プロバイダ（HTTP / BYOK）

| プロバイダ | SDK | 特記事項 |
|-----------|-----|---------|
| OpenRouter | Vercel AI SDK `openrouter` | 推奨デフォルト。500+モデルに単一キーでアクセス |
| Anthropic | Vercel AI SDK `anthropic` | Claude直接利用 |
| OpenAI | Vercel AI SDK `openai` | GPT-4o等 |
| Ollama | Vercel AI SDK `ollama` | ローカルモデル。オフライン対応 |
| OpenAI 互換（カスタム） | Vercel AI SDK `openai`（`baseURL` 上書き） | llama.cpp / LM Studio / vLLM / 自前ホストの GPU 推論サーバ等。`baseURL` と任意の `apiKey` を Settings で指定 |
| AI のべりすと | Vercel AI SDK `openai`（`baseURL` 固定） | 日本語小説特化。`https://api.tringpt.com/api` / Bearer 認証。OpenAI 互換チャット API。最大 40k 入力 / 4k 出力（モデル依存）・独自サンプリングパラメータ・拡張思考非対応の特殊扱い（後述） |

##### ローカル LLM / OpenAI 互換接続時の制限

Ollama および OpenAI 互換（カスタム）プロバイダで接続するローカル / セルフホストモデルでは、商用 API と機能差があるため以下のデグレード方針を取る。

- **拡張思考は非対応扱い**: `supportsThinking: false` / `supportsAdaptiveThinking: false` 固定。§拡張思考と effort パラメータ のロジックはスキップされ、`thinking` / `effort` パラメータをリクエストに含めない
- **構造化出力に依存するタスクは明示的に警告**: AI Codex 自動抽出 / Synopsis 自動生成 / セッションタイトル自動生成は JSON Schema 強制を前提とするため、ローカルモデル接続時は Settings 上で「ローカルモデルでは精度が落ちる可能性があります」と注意表示し、デフォルトでは無効化する（ユーザーが明示的にオプトイン可能）
- **コンテキスト上限はユーザー指定**: API から取得できないことが多いため、Settings の「OpenAI 互換」エンドポイント設定にモデルごとの `max_context_tokens` 手動指定欄を設ける。未指定時は保守的に 8k で扱う
- **トークン計上**: API レスポンスの `usage` を信頼する。返さない実装の場合は `tokens_in / tokens_out` を NULL 許容
- **接続テスト**: Settings に「接続テスト」ボタンを設け、`GET <baseURL>/models` で疎通とモデル一覧取得を確認できるようにする

##### AI のべりすと固有の扱い

AI のべりすと（[ai-novel.com](https://ai-novel.com/account_api_help.php)）は OpenAI 互換チャット API を提供するが、商用 API と前提が大きく異なるため独立プロバイダとして扱い、以下の特殊化を行う。

- **配線**: ベース実装は Vercel AI SDK `openai` の `baseURL` 差し替え（`https://api.tringpt.com/api`）。Bearer 認証は keyring に保存
- **モデル一覧と能力**: ハードコード（動的取得は将来検討）。現行主力は 40k 入力でクラウド API と遜色ない予算配分が可能、レガシーは出力上限が小さく特殊扱いが必要

  | モデル | 最大入力 | 最大出力 | 区分 |
  |--|--|--|--|
  | `derrida_03` / `spiko` / `spiko_solid` / `spiko_max` | 40,000 | 4,096 | 現行主力 |
  | `damsel_ray` | 12,288 | 400 | 現行（出力極小） |
  | `supertrin_highpres` / `supertrin_maxpres` / `supertrin` | 9,216 | 400 | レガシー |
  | `damsel` | 2,400 | 400 | レガシー（最古） |

- **コンテキスト窓の扱い**: モデルごとの最大入力を `getModelContextLimit` から返し、§トークン予算管理 の比率配分をそのまま適用する。AI のべりすとは入力上限と出力上限が別管理のため、入力側 floor 合計（応答予約を除く 4,500 tok = L1 500 + L2 500 + L3 2,000 + L4 500 + L5 1,000）を割るモデル（**`damsel` のみ**）に限り、本プロバイダ専用の縮退配分プロファイルを適用:
  - L3 Scene を最優先
  - L1 Project / L2 storySoFar / L4 Codex は**ゼロまで圧縮許容**
  - L5 History は直近 1〜2 ターンのみ
  - Settings に「`damsel` 使用時はプロジェクト指示・Codex がコンテキストに含まれない場合があります」と注意表示
  - supertrin 系（9,216 入力）/ damsel_ray（12,288 入力）/ 現行主力（40,000 入力）は通常配分で問題なし。出力 400 tok 制約は次項のクランプで吸収
- **出力上限のクランプ**: 応答予約は `min(設定比率による配分, model.max_output)` でクランプする。`damsel_ray` / レガシー系は出力 400 tok 上限のため、ストリーミング中の最大応答長 UI もこの値に合わせる
- **レート制限**: 現行モデル 200 req/分、`damsel` のみ 90 req/分。プロバイダ層で 429 検出時は指数バックオフでリトライし、UI に「レート制限到達」を表示
- **拡張思考**: 非対応（`supportsThinking: false` / `supportsAdaptiveThinking: false`）。`thinking` / `effort` パラメータはリクエストに含めない
- **構造化出力依存タスク**: AI Codex 自動抽出 / Synopsis 自動生成 / セッションタイトル自動生成はデフォルト無効化（ユーザーが明示オプトイン可能）。日本語継続生成への特化と引き換え
- **独自サンプリングパラメータ**: OpenAI には存在しない以下のフィールドを Settings の AI のべりすと専用セクションで編集可能にし、リクエストボディに素通しで含める:
  - `top_a`, `tailfree`, `typical_p`, `min_p`, `rep_pen` (1.0〜2.0)
  - `badwords`, `stoptokens`, `logit_bias`
  - 入力エリアのモデルセレクタで AI のべりすとを選んだ時のみ、これらのプリセットを切り替える簡易 UI も検討（プリセット = `バランス` / `創造的` / `保守的` 等）
- **ストリーミング**: API ドキュメントに明記されていないため、実装着手時に実機検証する。非対応の場合は非ストリーム応答として扱い、UI 側でローディング表示で繋ぐ
- **トークン計上**: API レスポンスの `usage` を信頼。返さない場合は `tokens_in / tokens_out` を NULL 許容
- **接続テスト**: Settings に専用の「接続テスト」ボタン（カスタム OpenAI 互換とは別動線）。短文を投げて 200 が返ることを確認

#### CLI プロバイダ（サブスクリプション流用）

API キーを持たないユーザーが、既にローカルにインストール・認証済みの CLI エージェントをチャットバックエンドとして流用するためのレイヤ。**目的は「サブスク（Claude Pro / ChatGPT Plus 等）の流用による API コスト削減」に限定**し、CLI のエージェント機能（ファイル操作、shell 実行、サブエージェント、MCP 接続等）は本パネルからは使わない。

| プロバイダ | 起動コマンド | ストリーム形式 |
|-----------|-------------|--------------|
| Claude Code | `claude -p <prompt> --output-format stream-json --allowed-tools "" --permission-mode plan` | NDJSON |
| OpenAI Codex CLI | `codex exec --json --sandbox read-only <prompt>` | NDJSON |
| OpenCode | `opencode run --print-logs --no-tools <prompt>` | JSON 行 |

**設計原則:**

- **ツール全 Off で起動**: 各 CLI のフラグでファイル R/W・shell・WebSearch を無効化し、実質的に「テキスト応答だけを返す HTTP API」相当の挙動に縛る。プロンプトインジェクションが効いても影響範囲を Anthropic API 直叩きと同等まで下げる
- **Tauri Command 経由の subprocess**: `tauri-plugin-shell` で子プロセス spawn → stdout NDJSON を Rust 側でパース → 既存の `chatProvider` ストリームインターフェースに整形して流す。フロント側のストリーミング UI は API プロバイダと共通
- **認証は CLI 側に委譲**: keyring には何も保存しない。CLI 側で `claude login` / `codex auth` / `opencode auth` 済みであることを前提とし、未認証の場合は Settings 画面で「`<コマンド>` でログインしてください」と案内するのみ
- **モデル選択**: 各 CLI の `--model` フラグ経由。effort / thinking の細粒度制御は CLI が公開している範囲のみ対応（adaptive thinking 連動は API プロバイダ専用）
- **トークン計上**: CLI が `usage` を返す場合（Claude Code stream-json は対応）は `chat_messages.tokens_in / tokens_out` に記録。返さない場合は NULL を許容
- **対象プラットフォーム**: macOS / Linux / WSL を v1 対象とする。Windows ネイティブは各 CLI 側の安定リリース後に追従（PATH 検出・`.cmd` shim・改行コード差異の負債を避ける）

**やらないこと（明示的スコープ外）:**

- CLI のエージェント機能を Chat パネル内で活用すること（ファイル編集を伴う Agent mode、サブエージェント呼び出し、MCP 接続経由の Codex 操作 等）
- これらは別レイヤで扱う:
  - **プロジェクト横断の自然言語操作 / エージェント活用** → MCP サーバー設計書を参照（ユーザーが自分のターミナルで Claude Code を起動し、Grimodex の MCP サーバーに接続する想定）
  - **長時間自律実行（AutoNovel 風の章単位生成）** → 将来検討。Chat パネルではなく専用の「Background Run」型 UI として別途設計する

### APIキーの保存

- Tauri keyring（macOS: Keychain、Windows: Credential Manager、Linux: KWallet）で安全に保存
- フロントエンドにはキーを渡さず、Tauri Command経由でRustバックエンドがAPI呼び出しを行う
- 設定画面でキーの追加/削除/テスト接続が可能

### モデル選択

- プロバイダごとに利用可能なモデル一覧を取得（APIまたはハードコード）
- ユーザーがデフォルトモデルを設定
- チャット入力エリアからセッション単位でモデルを切り替え可能

### 拡張思考（Extended Thinking）とeffortパラメータ

#### effort パラメータ

APIリクエストの `effort` フィールドで、モデルの推論の深さを制御する。テキスト応答だけでなくツール呼び出しや拡張思考を含む**すべてのトークン消費**に影響する行動的シグナル。

| レベル | 用途 | 備考 |
|--------|------|------|
| `low` | Synopsis自動生成、セッションタイトル生成などの軽量タスク | 簡単な問題では思考をスキップする場合あり |
| `medium` | 通常のチャット応答、スラッシュコマンド | コストと品質のバランス |
| `high` | Agent mode、複雑な質問、矛盾チェック | ほぼ必ず深い思考が走る。**APIのデフォルト** |
| `max` | Opus 4.6 限定。最大限の推論が必要な場面 | 他モデルで指定するとエラー |

**対応モデル**: Opus 4.6、Sonnet 4.6、Opus 4.5。それ以外のモデルでは無視される。

**タスクごとのeffortマッピング**:

| タスク | effort | 理由 |
|--------|--------|------|
| Synopsis自動生成 | `low` | 1-3文の要約、複雑な推論不要 |
| セッションタイトル生成 | `low` | 軽量タスク |
| 通常チャット応答 | `medium` | バランス重視 |
| スラッシュコマンド（/continue, /describe等） | `medium` | 創作支援、標準的な推論 |
| Agent mode（ツール呼び出し） | `high` | ツール選択の判断精度が重要 |
| AI Codex抽出 | `low` | 構造化抽出、パターン認識 |

effortはSettingsで上書き可能にはしない（タスクごとに最適値が異なるため、アプリ側で自動選択する方が合理的）。

#### 拡張思考の有効化

モデルが拡張思考に対応している場合は有効化する。**モデル世代によって方式が異なる**:

**Opus 4.6 / Sonnet 4.6（推奨方式: adaptive thinking + effort）:**
```json
{
  "model": "claude-opus-4-6",
  "max_tokens": 16000,
  "thinking": { "type": "adaptive", "effort": "high" }
}
```
- `budget_tokens` による手動指定は**非推奨**（将来のモデルリリースで削除予定）
- adaptive thinking が問題の複雑さに応じて思考するかどうか・どの程度思考するかを自動判断する
- `effort` が思考の積極性を制御: `high`/`max` ではほぼ必ず深く思考、`low`/`medium` では簡単な問題で思考をスキップ
- **interleaved thinking**: adaptive thinking で自動有効化。ツール呼び出しの間にも思考でき、中間結果を推論してから次のアクションを決定する

**Opus 4.5 / Sonnet 4.5 など旧モデル（従来方式: budget_tokens）:**
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 16000,
  "thinking": { "type": "enabled", "budget_tokens": 10000 },
  "effort": "medium"
}
```
- `budget_tokens` で思考トークン上限を手動指定（`max_tokens` 未満であること。応答予約の80%をデフォルトとする）
- `effort` と併用可能: `budget_tokens` が思考トークンの上限、`effort` がそれ以外のトークン消費に影響
- interleaved thinking を使う場合は `interleaved-thinking-2025-05-14` ベータヘッダーが必要。有効時は `budget_tokens` がコンテキストウィンドウ全体まで拡張可能

**その他プロバイダ:**

| プロバイダ | パラメータ | 対応モデル |
|-----------|-----------|-----------|
| OpenAI | reasoning tokens（`o1`, `o3` 系） | o1, o3-mini, o3 等 |
| OpenRouter | モデル依存（上記プロバイダのパススルー） | 各モデルの仕様に従う |
| Ollama | モデル依存（DeepSeek-R1 等） | 対応モデルのみ |

#### Thinking の表示制御（display パラメータ）

Anthropic APIの `display` パラメータで、thinking ブロックの返却形式を制御できる:

| display | 動作 | Grimodexでの用途 |
|---------|------|-----------------|
| `"summarized"`（デフォルト） | 思考過程の要約を返却 | **採用**: ユーザーが推論過程を確認できる |
| `"omitted"` | thinking フィールドを空で返却（`signature` のみ） | 思考表示が不要なタスク（Synopsis生成等）で高速化に使用可能 |

**重要**: Claude 4 モデルでは思考内容は要約されて返される（課金は全思考トークンに対して行われる）。レスポンスに見えるトークン数と課金されるトークン数は一致しない。

Grimodexでの使い分け:
- チャット応答・Agent mode: `display: "summarized"` — ユーザーが推論過程を確認するため
- Synopsis生成・セッションタイトル生成: `display: "omitted"` — UIに思考を表示する必要がなく、TTFT（Time to First Text Token）を短縮

#### Thinking ブロックの署名とマルチターン

APIは thinking ブロックに暗号化された `signature` を付与する。マルチターン会話やツール呼び出しループで thinking ブロックを返す際は、**`signature` を含む完全なブロックを変更せずに返す**必要がある:

```json
{
  "type": "thinking",
  "thinking": "Let me analyze this step by step...",
  "signature": "WaUjzkypQ2mUEVM36O2TxuC06KN8..."
}
```

- `chat_messages.metadata` に thinking ブロック（`signature` 含む）を保存し、次のターンでそのまま送信する
- thinking ブロックの内容を改変するとAPIエラーになる
- ターンの途中でthinkingのON/OFFを切り替えることはできない（ツール呼び出しループは同一ターン扱い）

#### 実装時のモデル分岐

```typescript
type EffortLevel = 'low' | 'medium' | 'high' | 'max';
type DisplayMode = 'summarized' | 'omitted';

function buildThinkingParams(
  model: ModelInfo,
  taskEffort: EffortLevel,
  display: DisplayMode = 'summarized'
) {
  if (model.supportsAdaptiveThinking) {
    // Opus 4.6, Sonnet 4.6: adaptive + effort（interleaved thinking 自動有効化）
    return {
      thinking: { type: 'adaptive', effort: taskEffort, display },
    };
  } else if (model.supportsThinking) {
    // Opus 4.5, Sonnet 4.5 等: budget_tokens + effort
    const budgetTokens = Math.floor(getResponseReserve(model) * 0.8);
    return {
      thinking: { type: 'enabled', budget_tokens: budgetTokens, display },
      effort: taskEffort,  // effort はリクエストボディのトップレベル
    };
  }
  // 拡張思考非対応モデル: effort のみ（対応していれば）
  return model.supportsEffort ? { effort: taskEffort } : {};
}
```

#### ストリーミング

thinking ブロックのストリーミングは以下のイベント順序で配信される:

1. `content_block_start` (type: thinking) — 思考ブロック開始
2. `thinking_delta` イベント群 — 思考内容のインクリメンタル配信（`display: "omitted"` 時はスキップ）
3. `signature_delta` — 暗号化署名の配信
4. `content_block_stop` — 思考ブロック終了
5. `content_block_start` (type: text) — 最終応答のストリーミング開始

**UI表示**:
- thinking 中は「考え中...」インジケータを表示
- `display: "summarized"` 時: thinking ブロック内にリアルタイムで要約テキストを表示
- `display: "omitted"` 時: インジケータのみ表示し、テキスト応答開始後に非表示

#### UI・永続化

- **検出**: モデルメタデータまたはプロバイダ SDK の機能フラグで拡張思考・effort・adaptive対応を判定
- **UI表示**: thinking ブロックはAIメッセージ内に **折りたたみ式（デフォルト閉じ）** で表示する。「💭 Thinking...」ラベルのトグルをクリックで展開し、推論過程を確認可能。提案の意図やエージェントのツール選択理由の把握に活用できる
- **トークン計上**: thinking トークンは `chat_messages.tokens_out` に含めて記録する。**注意**: Claude 4 モデルでは要約された思考が返されるが、課金は全思考トークンに対して行われるため、レスポンスのトークン数と `tokens_out` は一致しない
- **永続化**: thinking ブロックの内容と `signature` を `chat_messages.metadata` に保存する。`signature` はマルチターン会話で必須（APIに返す際に完全なブロックが必要）。セッション再表示時にも折りたたみ表示を再現する
- **interleaved thinking**: Agent modeでツール結果を受け取った後にもthinkingブロックが出現する。各thinkingブロックを個別に折りたたみ表示し、ツール呼び出しの間に挟まる形で表示する

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
| **Add to Map ▸** ⏳未実装 | **メッセージを Map ボードに送る（後述「Map への送出」参照）** |
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
| **Add selection to Map ▸** ⏳未実装 | **選択範囲を Map ボードに送る（As Sticky / As Snippet のみ）** |

### Map への送出

> **🚧 未実装（Phase 未着手）**: 本セクションは設計のみで、現在の `ChatMessageContextMenu.tsx` には `Add to Map ▸` サブメニューが存在しない。`map_stickies.source_chat_message_id` / `map_ai_branches` への書き込みコードも未実装。Map パネル本体の進捗に合わせて段階導入する。

Chat で AI と議論した内容を Map に還元するための動線。**新ノードタイプは追加せず**、既存の Sticky / Snippet / AI Branch / Codex のいずれかに変換する。Map パネル設計書「← Chat（Chat → Map）」と対応。

#### `Add to Map ▸` サブメニュー（メッセージ単位）

```
Add to Map ▸  As Sticky        （短文 1 アイデアを付箋化）
              As Snippet        （応答の塊を再利用テキストとして保存）
              As AI Branch...   （議論の流れ全体を AI Branch ノード化、応答を Sticky 群に分解）
              Extract codex...  （Detailed 抽出フローへ）
```

| 形式 | 変換ルール | authorship |
|------|----------|----------|
| **As Sticky** | メッセージ本文を Sticky body にコピー（ProseMirror JSON）。`map_stickies.source_chat_message_id = メッセージID`、`map_stickies.title` は空 | 元メッセージの authorship を継承（AI 応答なら全範囲 `ai`、ユーザー発言なら `human`） |
| **As Snippet** | `snippets` に新規行作成、content にメッセージ本文をコピー、`source_chat_message_id` 設定 | 既存の Snippet 抽出フローと同じ |
| **As AI Branch** | `map_ai_branches` に新規行作成（prompt = 元の質問テキスト、session_id = 現セッション）。**応答テキストを再度 AI に投げて N 個の Sticky に分解**してから Map に配置（後述「As AI Branch の特殊動作」） | 派生 Sticky は全範囲 `ai` で初期化 |
| **Extract codex...** | 既存の Detailed 抽出ダイアログ（`Add to Codex (Detailed)`）に転送し、抽出後に Map にも Codex ノードとして配置するか確認 | 既存フロー |

すべての形式で、**配置先 Map ボード選択ダイアログ**が事前に出る（複数ボードが存在するため）。

#### `Add selection to Map ▸` サブメニュー（テキスト選択範囲）

選択範囲が短いことを前提に、`As Sticky` と `As Snippet` の 2 形式のみ提供。authorship は選択範囲の span をそのまま転記する。

#### As AI Branch の特殊動作

1. ユーザーが応答メッセージで `As AI Branch...` を選択
2. ダイアログ: 配置先 Map ボード + 分解する Sticky 数（3/5/8）
3. 内部プロンプト: 「この応答からアイデアを N 個に分解して。各アイデアは独立した Sticky 1 個になるように、markdown で出力。」
4. **同じ Chat session_id で再投する**ため、Chat 上にも分解再投メッセージとその応答が記録として残る
5. 分解結果を Map に Sticky として配置、AI Branch ノードは元質問テキストをプロンプトとして保持
6. AI Branch ノードのダブルクリックで Chat に戻ると、元の議論 + 分解再投の両方が見える

これにより「議論の流れ全体（Chat 側）」と「分解されたアイデア群（Map 側）」が両方保存され、相互参照できる。

---

## DBスキーマ

### テーブル定義

```sql
CREATE TABLE chat_sessions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id     TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
                                  -- tree_nodes.id を参照する汎用スキーマ。
                                  -- シーンに限らず Folder/Scene を問わず任意の tree_nodes に紐付け可能。
                                  -- NULL はプロジェクトスコープ。参照先ノードが削除された場合は SET NULL で
                                  -- プロジェクトスコープのセッションへ降格しセッション自体は失わない
  title       TEXT NOT NULL DEFAULT 'New session',
  title_manual INTEGER NOT NULL DEFAULT 0,  -- 1の場合、自動タイトル再生成を抑制
  model       TEXT NOT NULL DEFAULT 'openrouter/anthropic/claude-sonnet-4.6',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ピン留めは正規化されて chat_session_pinned_codex テーブルに分離。
-- 詳細は `Grimodex_統合DBスキーマ.md` を参照。

CREATE TABLE chat_messages (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,     -- 'user' | 'assistant' | 'system'
  content        TEXT NOT NULL,
  model          TEXT,              -- assistant メッセージのみ: 使用モデル
  tokens_in      INTEGER,           -- 入力トークン数
  tokens_out     INTEGER,           -- 出力トークン数
  duration_ms    INTEGER,           -- 生成時間（ミリ秒）
  metadata       TEXT,              -- JSON: { extractedCodex: [...], extractedSnippets: [...],
                                   --         thinkingBlocks: [{thinking, signature}] }
  is_starred     INTEGER NOT NULL DEFAULT 0,  -- ⭐スター付きメッセージ。1 の場合 Progressive Summarization の
                                              -- 要約対象から除外され、原文のまま Layer 5 に保持される
  is_summarized  INTEGER NOT NULL DEFAULT 0,  -- 1 の場合、このメッセージは既に chat_summaries のいずれかに
                                              -- 取り込み済み。次回の shouldSummarize 判定からは除外される
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chat_summaries (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  summary     TEXT NOT NULL,        -- runSummarization が生成した会話要約本文
  token_count INTEGER NOT NULL,     -- 要約本文の推定トークン数（Layer 5 予算計算に使用）
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 要約のソースメッセージ集合は chat_summary_messages テーブルに正規化。
-- 詳細は `Grimodex_統合DBスキーマ.md` を参照。

CREATE INDEX idx_chat_sessions_node ON chat_sessions(project_id, node_id);
CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at);
CREATE INDEX idx_chat_summaries_session ON chat_summaries(session_id, created_at);
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
- 自動検出されたCodexエントリのシステムプロンプト注入（フェーズ解決後の状態を使用）
- シーンスコープ: アクティブシーン時点のフェーズ解決済み状態を注入。フェーズラベルがコンテキストに付記される（例: `## エララ (キャラクター) [反乱参加]`）
- プロジェクトスコープ: フェーズを持つエントリはタイムライン全体（最新状態 + 変遷リスト）を注入

---

## エラーハンドリング

### API呼び出しエラー

API からの例外はまず `classifyError` が次の 5 カテゴリへ分類し、カテゴリに応じて表示と復旧アクションを切り替える:

| カテゴリ (`classifyError`) | 代表的な発生源 | 表示 | 動作・アクションリンク |
|-----------|------|------|------|
| `auth` | 401 Unauthorized、API キー未設定、キー失効 | システムメッセージ「Invalid API key」 | 「Settings を開く」リンク（API キー設定画面へ遷移） |
| `rate_limit` | 429 Too Many Requests | システムメッセージ「Rate limited. Retry in 10s」| **10 秒後に自動再試行**。再試行中も「今すぐ再試行 / キャンセル」リンクを表示 |
| `network` | TCP 切断、DNS 失敗、fetch 例外 | システムメッセージ「Connection failed」 | 自動リトライ（3 回、指数バックオフ）＋「手動で再試行」リンク |
| `context_length` | コンテキスト超過エラー（プロバイダ別メッセージを正規化） | システムメッセージ「Context too long」 | Layer 2/5 を自動トリムして再送信。併せて「プロンプトプレビューを開く」リンク |
| `unknown` | 上記に該当しない 5xx、SDK 例外、パース失敗 | システムメッセージ「Server error」 | 「手動で再試行」リンク ＋ エラー詳細のコピー機能 |

`classifyError` はプロバイダ別の SDK エラーを上記の安定したカテゴリ名に正規化し、UI／テレメトリ／再試行ロジックが一貫して参照できるようにする。

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

### Codexパネル設計書

Codexエントリのフェーズシステム（経時的変化）により、Layer 4のコンテキスト注入ではフェーズ解決後の状態が使用される。シーンスコープではアクティブシーン時点、プロジェクトスコープではタイムライン全体の注入となる。context_modeのフェーズ上書きにも対応。

### Scenesパネル設計書

Codex Quickセクションのデータソース（`sceneCodexMatches`）は、Chatのコンテキスト注入Layer 4と同じZustandストアを共有する。

### Chat Historyパネル設計書

Chatパネルのヘッダーにある「Sessions」サイドシートは**当該シーンのセッション一覧に限定**し、素早いセッション切り替えに使う。プロジェクト全体の横断検索はChat Historyパネルが担う。Chat Historyからセッションをクリックすると、Chatパネルがそのセッションに切り替わる。

---

## Beat システム連携

### Beat 生成のコンテキスト構築

[Beat システム設計書](./Grimodex_Beatシステム設計書.md) の Placed beat 生成は、本 Chat パネル設計書のコンテキスト構築機構（L1〜L5）を**部分流用**する。Chat の通常メッセージ送信とは別のコードパスとして実装する：

| Layer | Chat 通常送信 | Beat 生成 |
|-------|-------------|-----------|
| L1 Project info | ✅ 含む | ✅ 含む |
| L2 storySoFar（前シーンの Synopsis 群） | ✅ 含む | ✅ 含む |
| L3 現シーン本文 | ✅ 含む | ✅ **beat 位置までの内容のみ** |
| L4 Codex（メンション + 自動検出） | ✅ 含む | ✅ 含む |
| L5 チャット履歴 | ✅ 含む | ❌ **含まない** |
| Beat instructions | — | ✅ **末尾追加** |
| Beat POV（`attrs.pov` または継承シーン POV） | — | ✅ **追加（Phase A から）** |
| 後続 beat 予告（Pending beats） | — | ✅ **条件付き追加（Settings、default ON）** |

L1〜L4 の構築ロジックは共通モジュール（既存）から呼び、Beat 専用の追加情報を上から積む形にする。これにより Chat 側の改修とは独立して Beat 生成が動く。

### Beat 生成の出力

- Vercel AI SDK でストリーミング生成
- Beat ノードの直後に空の `generatedProseBlock`（`beatId = sceneBeat.attrs.id`）を挿入し、内部にストリーミング text を流す（Editor の TipTap 操作）
- 各 text node に AuthorshipMark='ai' が自動付与される（既存機構）。`generatedProseBlock` は inline mark の AuthorshipMark と別レイヤーで動作するため干渉しない
- 生成済みかどうかと範囲は `generatedProseBlock` の存在自体が表すため、Beat ノード側のフラグ更新は不要

### Beat の AI 自動 role 推定（Phase C）

Beat 生成完了後、生成された prose を AI が読み、beat 内の各 `@mention` の role（`actor` / `target` / `mentioned`）を推定する機能を Phase C で導入する。実装フローは伏線レジスタ「AI 候補生成」と同型：

- 推定リクエストは Chat 通常送信とは別の専用エンドポイント（コンテキスト軽量、prose 全文 + beat instructions のみ）
- 推定結果は beat ヘッダーにバッジ提案として表示
- ユーザーが accept すると Mention `attrs.role` が更新される

---

## ピン留め追加ポップオーバーの共有化

コンテキストバー末尾の「📌ピン留め」ボタンが開く Codex/Snippet タブ式検索ポップオーバー（本ドキュメントの「コンテキストバー」「手動ピン留め」セクション参照）は、[Grid パネル](./Grimodex_Gridパネル設計書.md) の Scene カード「`+ Codex`」ボタンからも再利用される。両者で同じコンポーネントを使う：

- Chat: 選択 → `chat_session_pinned_codex` に追加
- Grid: 選択 → `scene_codex_pins` に追加

呼び出し側で「保存先」のコールバックを差し替える形で共通化する（コンポーネント自体は検索 UI のみを担い、保存先は知らない）。リファクタリングは Grid パネル Phase A で実施する。
