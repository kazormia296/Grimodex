# Grimodex Settingsパネル設計書

## 概要

Settingsパネルはプロジェクト設定、AI設定、エディタ設定、キーバインド設定などを管理するフローティングダイアログ。他のパネルのようにdockすることはできず、常にフローティングウィンドウとして開く。VS CodeのSettings UI（左にカテゴリナビゲーション、右に設定項目）を参考にしたレイアウト。

デフォルト位置: Float（非表示）。`Ctrl+Alt+,` で開閉。

---

## パネル構造

```
┌─────────────────────────────────────────────────────┐
│ Settings                                        [×] │
├──────────┬──────────────────────────────────────────┤
│          │                                          │
│ ▸ Project│  Project                                 │
│   AI     │                                          │
│   Editor │  Title:  [My Fantasy Novel          ]    │
│   Display│  Genre:  [Fantasy             ▼]         │
│   Keys   │  POV:    [Third person limited ▼]        │
│   Data   │                                          │
│   Codex  │                                          │
│   Linter │                                          │
│   About  │                                          │
│          │  Style guide:                            │
│          │  ┌──────────────────────────────────┐    │
│          │  │ Write in literary Japanese.      │    │
│          │  │ Prefer short sentences. Avoid... │    │
│          │  └──────────────────────────────────┘    │
│          │                                          │
│          │  AI instructions (global):               │
│          │  ┌──────────────────────────────────┐    │
│          │  │ You are a writing assistant for  │    │
│          │  │ a dark fantasy novel...          │    │
│          │  └──────────────────────────────────┘    │
│          │                                          │
└──────────┴──────────────────────────────────────────┘
```

左サイドバー（幅120px固定）にカテゴリナビゲーション、右メインエリアに設定項目。ダイアログのデフォルトサイズは 640×480px、リサイズ可能。

---

## カテゴリ一覧

| カテゴリ | 内容 |
|---------|------|
| Project | プロジェクトのメタ情報、文体ガイド、AI指示、Phase解決モード、ネーミングルール |
| AI | APIキー管理、プロバイダ設定、モデル選択、モデルホワイトリスト、拡張思考、コンテキスト予算配分 |
| Editor | フォント、行間、タイプライターモード、単語・行頭禁則、インラインAI等 |
| Display | テーマ、UI言語、UIスケール、reduceMotion、Attribution表示、Codexハイライト |
| Keys | キーボードショートカットのカスタマイズ |
| Data | バックアップ、リビジョン、エクスポート詳細設定、プロジェクトの保存場所 |
| Codex | ビルトイン／ユーザー定義 Codex タイプの管理とパレット色割り当て |
| Linter | Phase 1 / Phase 2 ルールの ON/OFF と重要度、スニペット単位の無視リスト管理 |
| About | アプリバージョン、GitHub リンク、Welcome Tour 再表示、THIRD_PARTY_LICENSES 一覧 |

---

## Project カテゴリ

プロジェクトのメタ情報とAIへの指示を設定する。これらの値はChatのコンテキスト注入Layer 1（Project info）として全てのAI呼び出しに含まれる。

### フィールド

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| Title | テキスト入力 | 「Untitled Project」 | プロジェクト名。タイトルバーに表示 |
| Genre | ドロップダウン | 未選択 | Fantasy / Sci-Fi / Mystery / Romance / Horror / Literary / Historical / Other + カスタム入力 |
| POV | ドロップダウン | 未選択 | First person / Third person limited / Third person omniscient / Second person |
| Tense | ドロップダウン | 未選択 | Past tense / Present tense |
| Language | ドロップダウン | 日本語 | 作品の執筆言語。AIへの指示言語にも影響 |
| Phase resolution mode | セグメント | reading | Codex Phase（登場時期）の解決モード。`reading`: 読者視点での初出順。`story`: 物語内時系列順。キー: `phaseResolutionMode` |

### Style guide（文体ガイド）

- 複数行テキストエリア（最大2,000文字）
- プレースホルダー: 「文体の特徴、避けるべき表現、好む語彙など...」
- 例: 「文語調で書く。一人称は『我』。会話文は方言を使う。擬音語は控えめに。」
- この内容はLayer 1に含まれ、AIの文体を制御する

### AI instructions（グローバルAI指示）

- 複数行テキストエリア（最大4,000文字）
- プレースホルダー: 「AIへの追加指示...」
- Style guideとの違い: Style guideは「文体」に特化、AI instructionsは「AIの振る舞い全般」を制御
- 例: 「登場人物の名前を勝手に変えないこと。プロット上の重大な変更は提案のみで、勝手に実行しない。日本語で応答すること。」
- この内容もLayer 1に含まれる

### ネーミングルール

Scenesパネルでの新規ノード作成時の自動命名を設定する。

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| フォルダー命名 | ドロップダウン | 自動（Part / Chapter / フォルダー） | `auto`: 階層深さで自動判別。`none`: 常に「フォルダー」 |
| シーン命名プレフィックス | テキスト入力 | `シーン`（i18next フォールバック） | 空にするとタイトルなしで作成。例: `シーン` → `シーン 1`, `シーン 2`。未設定時は `uiLanguage` に追従（ja=`シーン` / en=`Scene` / zh=`场景` / ko=`장면`） |
| ノート命名プレフィックス | テキスト入力 | `ノート`（i18next フォールバック） | 空にするとタイトルなしで作成。未設定時は `uiLanguage` に追従 |
| 採番スコープ | ドロップダウン | プロジェクト全体（一意） | `project`: プロジェクト全体で連番。`folder`: フォルダー内でのみ連番 |

設定キー（`app_settings` テーブル）:

| キー | デフォルト値 |
|------|-------------|
| `tree.folderNaming` | `"auto"` |
| `tree.sceneNaming` | `"シーン"` |
| `tree.noteNaming` | `"ノート"` |
| `tree.numberingScope` | `"project"` |

### DBスキーマ

```sql
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT 'Untitled Project',
  genre           TEXT,
  pov             TEXT,
  tense           TEXT,
  language        TEXT DEFAULT 'ja',
  style_guide     TEXT,
  ai_instructions TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## AI カテゴリ

BYOKのAPIキー管理とモデル設定。Chatパネル設計書で定義されたBYOK仕様をUIに落とし込む。

### プロバイダ設定

プロバイダごとにカード形式で表示。各カードにAPIキー入力とテスト接続ボタン。

```
┌──────────────────────────────────────┐
│ OpenRouter (recommended)             │
│ API Key: [sk-or-••••••••••••]  [Eye] │
│ Status: ● Connected                  │
│                        [Test] [Remove]│
├──────────────────────────────────────┤
│ Anthropic                            │
│ API Key: [sk-ant-••••••••••]   [Eye] │
│ Status: ● Connected                  │
│                        [Test] [Remove]│
├──────────────────────────────────────┤
│ OpenAI                               │
│ API Key: (not configured)            │
│                    [Add key]          │
├──────────────────────────────────────┤
│ Ollama                               │
│ Endpoint: [http://localhost:11434]    │
│ Status: ● Running (3 models)         │
│                        [Test] [Remove]│
└──────────────────────────────────────┘
```

| 要素 | 詳細 |
|------|------|
| APIキー入力 | マスク表示（`••••`）。[Eye]ボタンで一時的に表示/非表示 |
| Status | ● Connected (緑) / ● Error (赤) / ○ Not configured (グレー) |
| [Test] | APIにテストリクエストを送信し、接続を確認。結果をStatusに反映 |
| [Remove] | APIキーを削除（確認ダイアログ） |
| [Add key] | 未設定プロバイダのキー入力欄を展開 |

APIキーの保存先: Tauri keyring（OS標準のセキュアストレージ）。フロントエンドのメモリにはマスク状態でのみ保持。

### モデル設定

| フィールド | UI要素 | 詳細 |
|-----------|--------|------|
| Default chat model | ドロップダウン | 設定済みプロバイダのモデル一覧から選択。Chatパネル新規セッションのデフォルト |
| Default inline AI model | ドロップダウン | EditorのインラインAIで使うデフォルトモデル。Chat modelと同じにも別にもできる |
| Session title model | ドロップダウン | セッションタイトル自動生成に使う軽量モデル。デフォルト: 同プロバイダの最安モデル |
| Model whitelist | チェックボックスリスト | プロバイダのモデル一覧から、Chat / インラインAIモデルセレクタに表示するモデルを絞り込む。未設定時は全モデル表示。キー: `ai.modelWhitelist` |
| Extended thinking (default) | トグル | OFF | 新規Chatセッションでの拡張思考のデフォルトON/OFF。キー: `ai.thinkingEnabled`。モデルが未対応の場合は自動的に無効 |

モデル一覧の取得:
- OpenRouter: API経由で動的取得（`/api/v1/models`）
- Anthropic / OpenAI: ハードコードリスト + API取得を試行
- Ollama: `GET /api/tags` でローカルにインストール済みのモデルを取得

### コスト表示（参考）

各モデルの横にトークン単価を参考表示（OpenRouterのモデル情報APIから取得可能な場合）。

### コンテキスト予算配分

各レイヤーのコンテキスト予算比率をカスタマイズできる。比率はモデルのコンテキストウィンドウに対する割合で指定し、モデルサイズに応じて自動スケールする。UI はスライダーで L1〜L5 + Response reserve を調整する形式。

```
Context budget allocation
──────────────────────────────────────
L1 Project info         [ 2%  ▼] (min: 500)
L2 Story so far         [10%  ▼] (min: 500)
L3 Current scene        [40%  ▼] (min: 2,000)
L4 Codex & Snippets     [20%  ▼] (min: 500)
L5 Conversation history [20%  ▼] (min: 1,000)
Response reserve        [ 5%  ▼] (min: 2,000)
                        ────────
                Total:   97%  ← 余剰3%は優先順位に応じて再配分

                         [Reset to defaults]
```

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| L1〜L5, Response reserve | ドロップダウン（1%刻み） | 上表参照 | 合計は100%以下。余剰は上位優先レイヤーに再配分 |
| 各レイヤーのfloor | 表示のみ | 固定値 | 最小トークン数。小コンテキストモデルでの最低保証 |

- 合計が100%を超える場合はバリデーションエラーを表示し保存不可
- 変更はプロジェクト単位で保存（`app_settings` テーブル、キー: `ai.contextBudget.*`）
- Chat設計書のプロンプトプレビューモーダルで実際の配分結果を確認可能

---

## Editor カテゴリ

エディタの外観と振る舞いを設定する。変更は即座にEditorに反映される（リアルタイムプレビュー）。

### テキスト表示

| フィールド | UI要素 | 選択肢 | デフォルト |
|-----------|--------|--------|-----------|
| Font family | ドロップダウン | システムフォント一覧 + カスタムフォント指定 | 游明朝 / Noto Serif JP |
| Font size | スライダー + 数値 | 14px - 24px (1px刻み) | 18px |
| Line height | スライダー + 数値 | 1.2 - 3.0 (0.1刻み) | 2.0 |
| Max content width | スライダー + 数値 | 480px - 960px (40px刻み) | 720px |
| Paragraph spacing | スライダー + 数値 | 0px - 24px (2px刻み) | 8px |

### 編集体験

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| Typewriter mode | トグル | OFF | カーソル行を常にキャンバス中央に固定 |
| Auto-save delay | スライダー | 2秒 | 0.5秒 - 10秒の範囲 |
| Spell check | トグル | OFF | ブラウザ内蔵スペルチェック。日本語中心の執筆で誤検知が多いため既定OFF |
| Smart quotes | トグル | OFF | 「"」→「"」"」の自動変換。日本語ではOFF推奨 |
| Smart dashes | トグル | OFF | 「--」→「—」の自動変換 |
| Word break | セグメント | normal | CSS `word-break` 相当の挙動を切り替える。`normal` / `keep-all` / `break-all`。キー: `editor.wordBreak` |
| Line break | セグメント | strict | 日本語行頭禁則の強度。`loose` / `normal` / `strict`。CSS `line-break` に対応。キー: `editor.lineBreak` |

> Focus mode（特定段落以外を薄く表示）と target character count（目標文字数表示）は `Settings` の型定義にフィールドとして存在するが、UI としての露出は現時点で保留（未設計）。

### インラインAI

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| Enable / command | トグル | ON | エディタ内の `/` コマンドトリガーを有効/無効 |
| Enable Ctrl+Shift+Space | トグル | ON | Ctrl+Shift+Space パレットを有効/無効 |

### アニメーション

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| Smooth caret | トグル | ON | カーソル移動時にスムーズにスライド |
| Cursor blink | トグル | ON | 滑らかなフェード点滅（ブラウザデフォルトの硬い点滅を置き換え） |
| Character fade-in | トグル | OFF | 入力時に文字がふわっと現れる |
| Character fade-out | トグル | OFF | 削除時に文字がすっと消える |
| Disable all animations | トグル | OFF | 上記4つを一括OFF |

---

## Display カテゴリ

UIの外観全般を設定する。

### テーマ

| フィールド | UI要素 | 選択肢 | デフォルト |
|-----------|--------|--------|-----------|
| Theme | セグメント | Light / Dark / System | System |
| Accent color | カラーピッカー | パープル系のプリセット5色 + カスタム | パープル (#7F77DD) |

### UI

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| UI language | ドロップダウン | 日本語 | 日本語 (ja) / English (en) / 中文 (zh) / 한국어 (ko) の 4 言語。UI要素の表示言語。i18next リソースと連動しネーミングルールのフォールバックにも影響 |
| UI scale | スライダー | 100% | 80% - 150%（10%刻み）。ウィンドウ全体のズーム。`uiScale` はグローバル設定 |
| Reduce motion | トグル | OFF | アニメーションを抑制し Framer Motion / GSAP の遷移を最小化。OS の `prefers-reduced-motion` とも連動。キー: `reduceMotion` |
| Show word count in Scenes | トグル | ON | Scenesパネルのツリーに文字数を表示 |
| Show AI badge in Scenes | トグル | OFF | ScenesパネルのツリーにAI帰属バッジを表示 |
| Codex highlight | トグル | ON | エディタ本文中のCodexハイライトを有効/無効 |
| Codex highlight style | セグメント | Color text | Color text（文字色をカテゴリカラーに変更）/ Underline（点線の下線をカテゴリカラーで表示） |
| Attribution highlight opacity | スライダー | 10% | Attr表示ON時の背景ハイライトの不透明度（5% - 25%） |

---

## Keys カテゴリ

キーボードショートカットのカスタマイズ。VS Codeのキーバインド設定画面を参考にした2カラムテーブル。

### 表示

```
Search keybindings...

Command                          Keybinding
────────────────────────────────────────────
Focus Scenes panel               Ctrl+Alt+S
Focus Chat panel                 Ctrl+Alt+C
Focus Codex panel                Ctrl+Alt+X
Focus Snippets panel             Ctrl+Alt+N
Focus Attribution panel          Ctrl+Alt+A
Focus Chat History panel         Ctrl+Alt+H
Focus Map panel                  Ctrl+Alt+M
Open Settings                    Ctrl+Alt+,
Command palette                  Ctrl+Shift+P
Toggle Left Dock                 Ctrl+Alt+B
Toggle Right Dock                Ctrl+Alt+R
Toggle Bottom Dock               Ctrl+Alt+J
Split editor vertically          Ctrl+\
Split editor horizontally        Ctrl+Shift+\
Find                             Ctrl+F
Find and Replace                 Ctrl+H
Find in all scenes               Ctrl+Shift+F
Inline AI palette                Ctrl+Space
...
```

### インタラクション

- 検索バーでコマンド名またはキーバインドを検索
- キーバインドセルをクリック → 「Press desired key combination...」状態に。次のキー入力をキャプチャ
- 競合するショートカットがある場合は警告表示
- 右クリック → 「Reset to default」でデフォルトに戻す
- 全ショートカットの「Reset all to defaults」ボタン

### 永続化

カスタムキーバインドは `project.db` の `app_settings` テーブルにJSON形式で保存。

---

## Data カテゴリ

プロジェクトのデータ管理に関する設定。

### プロジェクト情報

| フィールド | 詳細 |
|-----------|------|
| Project location | プロジェクトファイルの保存先パスを表示（読み取り専用） |
| Created | プロジェクト作成日時 |
| Last modified | 最終更新日時 |
| Scene count | シーン数 |
| Total characters | プロジェクト全体の合計文字数 |
| Database size | project.db のファイルサイズ |

### バックアップ

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| Auto-backup | トグル | ON | 定期的に自動バックアップを作成 |
| Backup interval | ドロップダウン | 1時間 | 15分 / 30分 / 1時間 / 3時間 / 毎日 |
| Max backups | 数値入力 | 10 | 保持するバックアップの最大数。超過分は古い順に削除 |
| Backup location | フォルダ選択 | プロジェクトフォルダ内 `backups/` | Tauriのフォルダダイアログで選択 |
| [Backup now] | ボタン | — | 即座にバックアップを作成 |
| [Open backups folder] | ボタン | — | バックアップフォルダをOSのファイルマネージャで開く |

バックアップ形式: プロジェクトフォルダ全体（`content/` + `codex/` + `snippets/` + `project.db`）をZIPアーカイブ。ファイル名: `{project_title}_{YYYYMMDD_HHmmss}.zip`

### リビジョン

シーン単位の自動リビジョン（スナップショット）に関する設定。

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| Auto interval | ドロップダウン + 数値 | 10分 | 自動でリビジョンを作成する間隔。`0` で自動作成を無効化。キー: `revision.autoInterval` |
| Keep count | 数値入力 | 50 | シーンあたりの保持リビジョン数の上限。超過分は古い順に削除。キー: `revision.keepCount` |

### エクスポート

| ボタン | 動作 |
|--------|------|
| Export as Markdown | 全チャプター・シーンを結合してMarkdownファイルを出力 |
| Export as plain text | Markdown記法を除去したプレーンテキストを出力 |
| Export Codex | 全Codexエントリをまとめた参照ファイル（Markdown or JSON） |
| Export Attribution report | Attributionパネルのレポートをエクスポート（Markdown or CSV） |

エクスポートはTauriのファイルダイアログで保存先を選択。

#### エクスポート詳細設定

エクスポートダイアログの既定値を Settings 側から管理する。詳細な挙動はエクスポートダイアログ設計書に委譲。

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| Format | セグメント | md | 出力フォーマット。`md` / `txt` / `html`。キー: `export.format` |
| Folder heading | セグメント | h1 | フォルダー名を見出し化する際のレベル。`none` / `h1` / `h2` / `h3`。キー: `export.folderHeading` |
| Scene divider | テキスト入力 | `\n\n---\n\n` | シーン間の区切り文字。空文字で区切りなし。キー: `export.sceneDivider` |
| Ruby style | セグメント | html | ルビ記法の出力形式。`html`（`<ruby>`タグ） / `markdown`（`{漢字|かんじ}` 形式） / `plain`（ルビを落とす）。キー: `export.rubyStyle` |

### データ管理

| ボタン | 動作 |
|--------|------|
| Rebuild FTS indexes | FTS5仮想テーブルを再構築（検索が壊れた場合のリカバリ） |
| Rebuild Codex mention cache | `scene_codex_mentions` を全 Codex × 全シーンで完全再スキャン（進捗バー付き）。Codex rename 時の部分再スキャンが Aho-Corasick の最長一致衝突で取りこぼした場合の逃げ道。詳細は Matrix 設計書参照 |
| Compact database | SQLiteの VACUUM を実行（データベースサイズ最適化） |
| Clear chat history | 全チャットセッション・メッセージを削除（確認ダイアログ。Codex/Snippetの抽出済みデータは残る） |
| Delete project | プロジェクト全体を削除（最終確認ダイアログ。テキスト入力での確認を要求） |
| Check integrity | 孤立参照チェック＆修復、Codex×シーン相互参照レポート生成 |

---

## Codex カテゴリ

Codex のエントリ種別（タイプ）を管理する。ビルトインタイプ（Character / Place / Item / Event の 4 種）に加えて、ユーザー定義のカスタムタイプを追加・編集・削除できる。

### 一覧 UI

```
Codex types
──────────────────────────────────────
  Built-in                    [編集可: ラベル/色のみ]
  ●  Character   #7F77DD    [Edit]
  ●  Place       #5FB98A    [Edit]
  ●  Item        #E0A94C    [Edit]
  ●  Event       #C76A8F    [Edit]

  Custom
  ●  Faction     #5A7FD8    [Edit] [Delete]
  ●  Artifact    #9E6BCF    [Edit] [Delete]

  [+ Add custom type]
──────────────────────────────────────
```

| 要素 | 詳細 |
|------|------|
| Swatch | パレット色のプレビュー。クリックで swatch picker を開き、プリセット 16 色 + カスタム HEX から選択 |
| Label | タイプの表示名。Codex パネル・フィルタ・バッジに使用 |
| Key | 内部識別子（英小文字 + ハイフン）。ビルトインは固定、カスタム作成時に自動生成 |
| Delete | カスタムタイプのみ削除可。既存エントリが存在する場合は確認ダイアログで移動先タイプを指定 |

### DB スキーマ

```sql
CREATE TABLE codex_types (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  color       TEXT NOT NULL,  -- HEX (#RRGGBB)
  builtin     INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

タイプ一覧は `typeApi`（Zustand ストア）経由で購読・更新する。Settings の Codex カテゴリは `typeApi` を薄くラップした UI として動作し、`app_settings` テーブルには保存しない。

---

## Linter カテゴリ

本文・スニペットに対する Lint ルールの設定と、プロジェクト固有の無視リストを管理する。UI は 2 タブ構成。

### タブ 1: ルール設定

Phase 1（基本ルール）および Phase 2（拡張ルール）の各ルールについて、ON/OFF と重要度（`info` / `warn` / `error`）を個別に切り替える。

```
Linter rules
──────────────────────────────────────
[Phase 1]  [Phase 2]

☑  rule/duplicate-paragraph    [warn  ▼]
☑  rule/long-sentence          [info  ▼]
☐  rule/mixed-quote-style      [warn  ▼]
...
```

- ルールカテゴリ（Phase）ごとにサブタブで切り替え
- ON/OFF はチェックボックス、重要度はドロップダウン
- ルールごとの説明文と「例を見る」リンク
- 「Reset to defaults」ボタンで Phase ごとに初期値へ戻す

### タブ 2: 無視リスト

プロジェクト内で「このスニペットについてはこのルールを無視する」という個別例外を管理する画面。

| 列 | 内容 |
|----|------|
| Rule | 無視対象のルール ID |
| Scope | 対象のシーン／スニペット（シーンタイトル + スニペット抜粋） |
| Added | 登録日時 |
| Note | ユーザーコメント（任意） |
| 操作 | 行選択 → [Delete] で削除 |

- 検索バーでルール名／シーン名／本文で横断検索
- 複数選択削除に対応
- シーン分割・統合時にも追従できるよう、無視エントリの `snippet_id` / `scene_id` を付け替える追従 API を介して更新される

### 設定の保存先

Linter 設定は `app_settings` テーブルではなく専用の `lintConfigStore`（Zustand + 永続化レイヤー）で管理する。無視リストは SQLite のテーブル `lint_ignores` に保存され、シーン・スニペットの CRUD と整合を取る。詳細は Linter 設計書に委譲。

---

## About カテゴリ

アプリに関するメタ情報とサポートリンクを表示する。設定項目ではなく情報表示が主体。

| 要素 | 詳細 |
|------|------|
| App version | `package.json` と `tauri.conf.json` から取得したバージョン番号（例: `Grimodex 0.12.3`）。クリックでコミットハッシュをトグル表示 |
| GitHub | リポジトリへの外部リンク。`shell.open` で OS デフォルトブラウザで開く |
| Welcome Tour | [Show again] ボタンで初回起動時の Welcome Tour を再表示する（内部フラグ `welcome.seen` をリセット） |
| Third-party licenses | npm / cargo それぞれの `THIRD_PARTY_LICENSES` 一覧をスクロール可能なビューで表示。検索バー付き |

---

## 設定の保存

### 即時保存

全ての設定変更は即座に保存される（「Save」ボタンは不要）。UI が変更されるたびにデバウンス 300ms で保存。`SettingsDialog` を閉じた瞬間には `flushPending` を呼び、保留中の変更を即時 flush してからダイアログを閉じる。

### 永続化の二層構造

Grimodex の設定はワークスペース（起動中の Grimodex プロセス全体）単位で共有されるべき項目と、プロジェクトごとに個別管理すべき項目に分かれる。

#### グローバル設定（ワークスペース越しに残る）

UI の外観など「どのプロジェクトを開いても同じであってほしい」項目は `useWorkspaceStore.globalSettings` 経由で読み書きし、アプリデータディレクトリの `global-settings.json` に保存する。プロジェクトを切り替えても値が維持される。

代表的なグローバル設定項目:

- `theme` / `colorTheme`（テーマとアクセントカラー）
- `uiLanguage`（UI 表示言語）
- `uiScale`（UI スケール）
- `reduceMotion`
- Welcome Tour の既読フラグなど About カテゴリ関連

#### プロジェクト固有設定

上記以外の項目はすべて `app_settings` テーブル（Drizzle ORM 経由）に 300ms debounce で保存する。プロジェクトを開き直すと当該プロジェクトの `project.db` から読み戻される。

#### カテゴリ独自ストア

一部のカテゴリは専用ストア／テーブルへ委譲し、Settings UI はそのファサードとして振る舞う:

| カテゴリ | 委譲先 | 備考 |
|---------|-------|------|
| Codex types | `typeApi`（Zustand） + `codex_types` テーブル | ビルトイン／カスタムタイプの CRUD |
| Linter (ルール + 無視リスト) | `lintConfigStore` + `lint_ignores` テーブル | `app_settings` テーブルには保存しない |
| AI (APIキー) | Tauri keyring | OS 標準のセキュアストレージ |
| AI (モデル選択 / 拡張思考 / ホワイトリスト等) | `chat/store` + `app_settings` テーブル | Chat パネルと共有 |

#### 保存先サマリ

| 設定カテゴリ | 保存先 | 理由 |
|-------------|--------|------|
| Project (メタ情報) | `projects` テーブル | プロジェクト固有 |
| Project (ネーミング / Phase resolution) | `app_settings` テーブル | プロジェクト固有 |
| AI (APIキー) | Tauri keyring | セキュリティ |
| AI (モデル・予算・thinking等) | `chat/store` + `app_settings` テーブル | プロジェクト固有 |
| Editor | `app_settings` テーブル | プロジェクト固有 |
| Display (theme / uiLanguage / uiScale / reduceMotion) | `global-settings.json` | グローバル |
| Display (Codex highlight / Attribution opacity 等) | `app_settings` テーブル | プロジェクト固有 |
| Keys | `app_settings` テーブル | プロジェクト固有 |
| Data (バックアップ / リビジョン / エクスポート) | `app_settings` テーブル | プロジェクト固有 |
| Codex (types) | `codex_types` テーブル（`typeApi` 経由） | プロジェクト固有 |
| Linter (ルール) | `lintConfigStore` → `app_settings` テーブル | プロジェクト固有 |
| Linter (無視リスト) | `lint_ignores` テーブル | プロジェクト固有 |
| About | 表示のみ（`welcome.seen` のみグローバル） | — |

### app_settings テーブル

```sql
CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL  -- JSON value
);
```

アプリ全体のKey-Valueストア。各設定項目は `editor.fontSize`、`display.theme`、`ai.defaultChatModel` のようなドット区切りのキーで保存。`project_settings` テーブルも併存するが、現在のすべてのキーはアプリ全体のプリファレンスのため `app_settings` 側に格納される（詳細は統合DBスキーマ参照）。

```typescript
// 使用例
await setSetting('editor.fontSize', '16');
await setSetting('display.theme', 'system');
await setSetting('ai.defaultChatModel', 'openrouter/anthropic/claude-sonnet-4.6');

const fontSize = await getSetting('editor.fontSize', '16');  // デフォルト値付き
```

---

## キーボードショートカット

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Alt+,` | Settingsを開く/閉じる（レイアウト設計書で定義済み） |
| `Escape` | Settingsを閉じる |
| `Ctrl+F`（Settings内） | Keysカテゴリの検索バーにフォーカス |

---

## 他パネルとの連携

### → Editor

- Font size、Line height、Typewriter mode等の変更は即座にEditorに反映
- InlineAI設定のON/OFFでEditorの `/` コマンドと `Ctrl+Shift+Space` の有効/無効が切り替わる
- Codex highlight設定でエディタ本文中のCodexハイライト表示をON/OFF

### → Chat

- Default chat model設定がChatパネルの新規セッションのデフォルトモデルになる
- AI instructions設定がChatのコンテキスト注入Layer 1に含まれる
- Session title model設定がセッションタイトル自動生成のモデルを決定

### → Scenes

- Show word count / Show AI badge 設定がScenesツリーの表示を制御
- ネーミングルール設定が新規ノード作成時のタイトル自動生成に反映される

### → Attribution

- Show AI badge設定がScenesとAttributionの両方に影響

### ← Chat（エラー時）

- Chatパネルで認証エラー (401) が発生した場合、エラーメッセージに「Open Settings」リンクが表示され、クリックでSettingsのAIカテゴリが開く

---

## 既存設計書との整合

### レイアウト設計書

SettingsはFloat専用。他のドックゾーンにはドロップ不可。`Ctrl+Alt+,` で開閉。

### Chatパネル設計書

AIプロバイダ設定（BYOK）のUI詳細はSettingsのAIカテゴリで定義。Chat設計書の「AIプロバイダ設定」セクションは仕様の定義、Settings設計書はUI実装の定義として役割分担。

### Editorパネル設計書

エディタのフォントサイズ（14-24px）、行間（1.2-3.0）、タイプライターモードはEditor設計書で言及されており、具体的な設定UIがSettingsのEditorカテゴリ。インラインAIの有効/無効設定もここで管理。

---

## Beat / Matrix / Grid 関連設定（追加項目）

[Beat システム設計書](./Grimodex_Beatシステム設計書.md) / [Matrix パネル設計書](./Grimodex_Matrixパネル設計書.md) / [Grid パネル設計書](./Grimodex_Gridパネル設計書.md) の導入に伴い、Settings の以下のカテゴリに項目を追加する。

### Editor カテゴリ

| 項目 | 値 | 既定 | 説明 |
|------|-----|------|------|
| Beat 表示モード（リニア編集モード時） | `通常 / 折りたたみ / 非表示` | `折りたたみ` | リニア編集モードでの Beat ブロックの扱い |
| Focus mode で Beat を非表示にする | boolean | true | Focus mode 時の Beat 非表示トグル |
| 文字数カウントに Beat 内テキストを含める | boolean | false | 執筆統計の文字数集計対象 |
| 全文検索で Beat 内テキストを対象にする | boolean | true | 検索範囲設定 |

### AI カテゴリ

| 項目 | 値 | 既定 | 説明 |
|------|-----|------|------|
| Beat type デフォルトプロンプト | テキストエディタ（type ごと） | （ハードコード値） | `summary` / `guided` / `dialogue` / `setting` / `micro` ごとに編集可（Beat 設計書 Phase B 以降） |
| Beat 生成時に予定 beat を AI コンテキストに注入 | boolean | true | Layer 3 への "Pending beats for this scene" セクション注入トグル |

### プロジェクト カテゴリ

| 項目 | 値 | 既定 | 保存先 | 説明 |
|------|-----|------|------|------|
| Subplot 識別タグ名 | string | `subplot` | `project_settings` | Codex の `lore` タイプを subplot として扱う際のタグ名（Codex 設計書連携）。プロジェクトごとに異なる慣習を採用できるため、global ではなく project スコープで保存する |

### スキーマ追加

設定の保存先はスコープに応じて分かれる：

- **`global-settings.json`**（アプリ全体）: editor / ai / matrix / grid 設定
- **`project_settings` テーブル**（プロジェクト単位）: プロジェクトごとに変えうる設定

#### `global-settings.json` への追加

```json
{
  "editor": {
    "beatDisplayInLinearMode": "collapsed",
    "hideBeatsInFocusMode": true,
    "includeBeatsInCharCount": false,
    "includeBeatsInFullTextSearch": true
  },
  "ai": {
    "beatTypePrompts": {
      "free": null,
      "summary": "...",
      "guided": "...",
      "dialogue": "...",
      "setting": "...",
      "micro": "..."
    },
    "injectPendingBeatsInGeneration": true
  },
  "matrix": {
    "showMode": "codex-all",
    "sortMode": "reading",
    "displayMode": "dot",
    "groupCodexByType": true,
    "hiddenColumnIds": [],
    "pinnedColumnIds": [],
    "collapsedTypeSections": [],
    "tagFilter": {
      "codex-all": [],
      "codex-characters": [],
      "codex-locations": [],
      "codex-items": [],
      "codex-lore": [],
      "pov": [],
      "location": [],
      "subplot": []
    },
    "customSets": [],
    "activeCustomSetId": null
  },
  "grid": {
    "containerId": null,
    "compactCards": false,
    "showSynopsis": true,
    "showBeats": true,
    "showCodex": true,
    "showLabel": true,
    "filter": {
      "emptyOnly": false,
      "hideCompleted": false,
      "codexFilter": []
    }
  }
}
```

`matrix` と `grid` セクションは Settings UI から直接編集する項目ではなく、各パネルで自動保存される（パネル設計書側でフィールドを定義）。Settings UI から編集するのは Editor / AI / プロジェクト カテゴリの項目のみ。

#### `project_settings` テーブルへの追加（プロジェクト単位）

| key | value 型 | 既定 | 説明 |
|-----|---------|------|------|
| `subplotTagName` | string | `subplot` | Codex `lore` タイプを subplot として識別するタグ名 |

プロジェクト依存設定は global ではなく `project_settings` テーブル（既存）に書き込む。プロジェクトごとに異なる慣習（例: `subplot` / `sub-plot` / `プロット`）を採用できる。
