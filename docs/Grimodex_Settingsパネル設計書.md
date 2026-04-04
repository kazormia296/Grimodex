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
| Project | プロジェクトのメタ情報、文体ガイド、AI指示 |
| AI | APIキー管理、プロバイダ設定、モデル選択 |
| Editor | フォント、行間、タイプライターモード等 |
| Display | テーマ、UI言語、Attribution表示、Codexハイライト |
| Keys | キーボードショートカットのカスタマイズ |
| Data | バックアップ、エクスポート、プロジェクトの保存場所 |

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

モデル一覧の取得:
- OpenRouter: API経由で動的取得（`/api/v1/models`）
- Anthropic / OpenAI: ハードコードリスト + API取得を試行
- Ollama: `GET /api/tags` でローカルにインストール済みのモデルを取得

### コスト表示（参考）

各モデルの横にトークン単価を参考表示（OpenRouterのモデル情報APIから取得可能な場合）。

### コンテキスト予算配分

各レイヤーのコンテキスト予算比率をカスタマイズできる。比率はモデルのコンテキストウィンドウに対する割合で指定し、モデルサイズに応じて自動スケールする。

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
- 変更はプロジェクト単位で保存（`settings` テーブル、キー: `ai.contextBudget.*`）
- Chat設計書のプロンプトプレビューモーダルで実際の配分結果を確認可能

---

## Editor カテゴリ

エディタの外観と振る舞いを設定する。変更は即座にEditorに反映される（リアルタイムプレビュー）。

### テキスト表示

| フィールド | UI要素 | 選択肢 | デフォルト |
|-----------|--------|--------|-----------|
| Font family | ドロップダウン | システムフォント一覧 + カスタムフォント指定 | 游明朝 / Noto Serif JP |
| Font size | スライダー + 数値 | 14px - 24px (1px刻み) | 16px |
| Line height | スライダー + 数値 | 1.2 - 3.0 (0.1刻み) | 1.8 |
| Max content width | スライダー + 数値 | 480px - 960px (40px刻み) | 680px |
| Paragraph spacing | スライダー + 数値 | 0px - 24px (2px刻み) | 12px |

### 編集体験

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| Typewriter mode | トグル | OFF | カーソル行を常にキャンバス中央に固定 |
| Auto-save delay | スライダー | 2秒 | 0.5秒 - 10秒の範囲 |
| Spell check | トグル | ON | ブラウザ内蔵スペルチェック |
| Smart quotes | トグル | OFF | 「"」→「"」"」の自動変換。日本語ではOFF推奨 |
| Smart dashes | トグル | OFF | 「--」→「—」の自動変換 |

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
| Character fade-in | トグル | ON | 入力時に文字がふわっと現れる |
| Character fade-out | トグル | ON | 削除時に文字がすっと消える |
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
| UI language | ドロップダウン | 日本語 | 日本語 / English。UI要素の表示言語 |
| UI scale | スライダー | 100% | 80% - 150%。ウィンドウ全体のズーム |
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

カスタムキーバインドは `project.db` の `settings` テーブルにJSON形式で保存。

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

### エクスポート

| ボタン | 動作 |
|--------|------|
| Export as Markdown | 全チャプター・シーンを結合してMarkdownファイルを出力 |
| Export as plain text | Markdown記法を除去したプレーンテキストを出力 |
| Export Codex | 全Codexエントリをまとめた参照ファイル（Markdown or JSON） |
| Export Attribution report | Attributionパネルのレポートをエクスポート（Markdown or CSV） |

エクスポートはTauriのファイルダイアログで保存先を選択。

### データ管理

| ボタン | 動作 |
|--------|------|
| Rebuild FTS indexes | FTS5仮想テーブルを再構築（検索が壊れた場合のリカバリ） |
| Compact database | SQLiteの VACUUM を実行（データベースサイズ最適化） |
| Clear chat history | 全チャットセッション・メッセージを削除（確認ダイアログ。Codex/Snippetの抽出済みデータは残る） |
| Delete project | プロジェクト全体を削除（最終確認ダイアログ。テキスト入力での確認を要求） |
| Check integrity | 孤立参照チェック＆修復、Codex×シーン相互参照レポート生成 |

---

## 設定の保存

### 即時保存

全ての設定変更は即座に保存される（「Save」ボタンは不要）。UIが変更されるたびにデバウンス300msで保存。

### 保存先

| 設定カテゴリ | 保存先 | 理由 |
|-------------|--------|------|
| Project | `projects` テーブル | プロジェクト固有の情報 |
| AI (APIキー) | Tauri keyring | セキュリティ |
| AI (モデル選択等) | `settings` テーブル | プロジェクト固有 |
| Editor | `settings` テーブル | プロジェクト固有（将来グローバル設定も検討） |
| Display | `settings` テーブル | プロジェクト固有 |
| Keys | `settings` テーブル | プロジェクト固有 |
| Data (バックアップ) | `settings` テーブル | プロジェクト固有 |

### settingsテーブル

```sql
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL  -- JSON value
);
```

シンプルなKey-Valueストア。各設定項目は `editor.fontSize`、`display.theme`、`ai.defaultChatModel` のようなドット区切りのキーで保存。

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
