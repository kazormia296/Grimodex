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
│   Data   │  Tense:  [Past tense          ▼]         │
│   Codex  │  Language: [日本語            ▼]          │
│   Map    │  Phase resolution: [auto      ▼]         │
│   Linter │                                          │
│   Usage  │  （Outline / Style guide / AI            │
│   License│    instructions は AI カテゴリへ移設）     │
│   About  │                                          │
│          │                                          │
└──────────┴──────────────────────────────────────────┘
```

左サイドバー（幅120px固定）にカテゴリナビゲーション、右メインエリアに設定項目。ダイアログのデフォルトサイズは 640×480px、リサイズ可能。

---

## カテゴリ一覧

カテゴリは `SETTINGS_CATEGORIES`（`src/features/settings/types.ts`）が正本で、現状 **12 カテゴリ**（License は licensing 無効ビルドでは `CategoryNav` が項目ごと非表示にする）。

| カテゴリ | 内容 |
|---------|------|
| Project | プロジェクトのメタ情報、Phase 解決モード、ネーミングルール、ゴミ箱、執筆タイムラプス記録、デフォルト雛形保存 |
| AI | APIキー管理、プロバイダ設定（OpenRouter / OpenAI / Anthropic / Ollama / OpenAI 互換 / Sakana / AI のべりすと / CLI エージェント）、ツールプロトコル、モデル選択、モデルホワイトリスト、拡張思考、Web 検索 (RAG) ドメイン制御、AI 使用ポリシー・AI 作品設定（Outline / 対象読者 / Style guide / AI instructions）、関連シーン自動注入（意味/ハイブリッド検索）、コンテキスト予算配分、Beat AI 統合、AI プロンプト追記カスタマイズ、MCP 連携 |
| Editor | フォント、行間、タイプライターモード、執筆目標（日次文字数）、縦書き・縦中横、和欧スペーシング、単語・行頭禁則、段落字下げ、インライン AI、Beat 表示モード等 |
| Display | カラーテーマ、ライト／ダーク、UI 言語、UI フォント、UI スケール、reduceMotion、Glass エフェクト、Attribution 表示、Codex ハイライト |
| Keys | キーボードショートカットのカスタマイズ |
| Data | プロジェクト情報、バックアップ、リビジョン、エクスポート、外部マウント、Codex 言及キャッシュ再構築、FTS 再構築、VACUUM、整合性チェック |
| Codex | ビルトイン／ユーザー定義 Codex タイプの管理とパレット色割り当て |
| Map | Map パネルの新規付箋・エッジの既定（パレット / 色スロット / エッジスタイル） |
| Linter | 校正ルールの ON/OFF と重要度、用語辞書、スニペット単位の無視リスト管理 |
| Usage | プロジェクト単位の AI トークン使用量・推定コスト・prompt cache 読込率・サーフェス別内訳（表示のみ） |
| License | ライセンス認証状態・キー入力・端末解除・再検証（licensing 有効ビルドのみ） |
| About | アプリ情報、利用規約、開発者メッセージ、THIRD_PARTY_LICENSES 一覧 |

> Project / AI / Editor の各カテゴリは `SettingScopeHeader` でグローバル設定セクションとプロジェクト設定セクションを視覚的に分ける。AI カテゴリのプロジェクトスコープには、以前 Project カテゴリにあった AI 使用ポリシー・AI 作品設定（Outline / 対象読者 / Style guide / AI instructions）が集約されている（`AiProjectSettings`、i18n キーは互換のため `settings.project.*` のまま）。

---

## Project カテゴリ

プロジェクトのメタ情報・ネーミング・ゴミ箱・タイムラプス記録・デフォルト雛形を設定する（`ProjectCategory`）。

> **（2026-06-18 追記）** Outline / 対象読者 / Style guide / AI instructions と AI 使用ポリシーは Project カテゴリから **AI カテゴリのプロジェクトスコープ**（`AiProjectSettings`）へ集約された。これらの値は Chat のコンテキスト注入 Layer 1（Project info）として全ての AI 呼び出しに含まれる。本節の以下「Outline / Style guide / AI instructions」サブセクションは AI カテゴリへの参照として残す。

### フィールド

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| Title | テキスト入力 | 「Untitled Project」 | プロジェクト名。タイトルバーに表示 |
| Genre | ドロップダウン | 未選択 | Fantasy / Sci-Fi / Mystery / Romance / Horror / Literary / Historical / Other + カスタム入力 |
| POV | ドロップダウン | 未選択 | First person / Third person limited / Third person omniscient / Second person |
| Tense | ドロップダウン | 未選択 | Past tense / Present tense |
| Language | ドロップダウン | 日本語 | 作品の執筆言語。AIへの指示言語にも影響 |
| Phase resolution mode | ドロップダウン | auto | Codex Phase（登場時期）の解決モード。`reading`: 読者視点での初出順。`story`: 物語内時系列順。`auto`。キー: `phaseResolutionMode`（`projects` 列・既定 `auto`）。変更時は `usePhaseStore.setResolutionMode` にも反映 |

### AI 作品設定（Outline / 対象読者 / Style guide / AI instructions）

> **（2026-06-18 追記）** これらは **AI カテゴリのプロジェクトスコープ**（`AiProjectSettings`）に移設された。値は `projects` テーブル列に保存され、AI コンテキスト注入に使われる。

- **Outline** — 複数行テキストエリア（最大 8,000 文字、`projects.outline` 列）。AI コンテキスト Layer 2（Story so far）への常時注入対象。`tree_nodes.synopsis` が章/シーンの outline を担うのに対し、こちらはプロジェクト全体の outline を著者が手書きするフィールド
- **対象読者** — 複数行テキストエリア（最大 2,000 文字、`projects.target_readers` 列）。想定読者層を AI に伝える
- **Style guide** — 複数行テキストエリア（最大 2,000 文字、`projects.style_guide` 列）。Layer 1 に含まれ AI の文体を制御。例: 「文語調で書く。一人称は『我』。会話文は方言を使う。」
- **AI instructions** — 複数行テキストエリア（最大 4,000 文字、`projects.ai_instructions` 列）。Style guide が「文体」に特化するのに対し、AI の振る舞い全般を制御。例: 「登場人物の名前を勝手に変えない。日本語で応答する。」

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

### ゴミ箱

削除された文字片・構造ノードの保持に関する設定。`src/features/trash-bin/` 配下と連携する。

| フィールド | UI 要素 | デフォルト | 詳細 |
|-----------|---------|-----------|------|
| ゴミ箱を有効化 | チェックボックス | ON | `trashBin.enabled`。OFF にすると削除時にゴミ箱を経由せず即時消去 |
| 保持期間 | ドロップダウン | 60 日 | `trashBin.retentionDays`。`7` / `30` / `60` / `90` / `-1`（無期限）。期限超過分は次回起動 / 1 時間ごとの掃除で削除される |

### 執筆タイムラプス

執筆過程の記録（タイムラプス）の per-project トグルと履歴パージ（`TimelapseSettings`）。

| フィールド | UI 要素 | デフォルト | 詳細 |
|-----------|---------|-----------|------|
| この作品の変更を記録 | トグル | ON | `timelapse.enabled`（project スコープ）。OFF→ON で再開すると履歴に欠落が生じるため、既存イベントが残っている場合は破棄確認ダイアログを出す。トグルは必ずオーケストレーター `setTimelapseEnabled` を唯一の writer として経由する（auto-persist する `SettingToggle` は wipe/baseline 処理をスキップしてしまうため使わない） |
| 履歴を削除 | ボタン | — | `purgeTimelapseHistory`。`change_events` を全削除（確認ダイアログ付き） |

> per-project の読み書きは固定 `PROJECT_ID` の settings store ではなく `currentProjectId` を直接使う（recorder が `currentProjectId` で `change_events` を書くため整合させる）。

### AI 使用ポリシー

> **（2026-06-18 追記）** AI 使用ポリシーは **AI カテゴリのプロジェクトスコープ**（`AiProjectSettings`）へ移設された。設計は下記のまま。

プロジェクト単位で AI 機能の使用範囲を制御する。`projects.ai_policy` 列に JSON で保存され、`src/features/ai-policy/` のプリセット展開ロジックを介して各機能の許可判定に使われる。

| フィールド | UI 要素 | デフォルト | 詳細 |
|-----------|---------|-----------|------|
| プリセット | ドロップダウン | Full | `full` / `assist-off` / `review-only` / `off`。個別トグルを変更すると自動的に `custom` 扱いになる |
| チャット | チェックボックス | ON | チャットパネル・Agent・CLI 連携の許可（`chat`） |
| 本文書き込み | チェックボックス | ON | インライン AI・Beat 生成の許可（`bodyWrite`） |
| 分析 | チェックボックス | ON | 整合性チェック・伏線 AI の許可（`analysis`） |
| 構成編集 | チェックボックス | ON | AI による章/シーン構成の生成・再編（`structureWrite`） |
| 知識書き込み | チェックボックス | ON | AI による Codex・伏線・スニペットの自律的な作成・更新（`knowledgeWrite`） |
| 本文提案の自動適用（ヘッドレス） | チェックボックス | OFF | `ai.autoAcceptBodyProposals`（project）。MCP/エージェントの本文提案を人間の承認なしで適用（対象は末尾追記と一意アンカー挿入のみ。置換・アンカー無し挿入は常に手動レビュー）。本文書き込みポリシー ON のときのみ有効 |
| 関連シーンの自動注入（意味検索） | チェックボックス | ON | `ai.semanticRecall`（project）。Layer4 RAG。チャット送信時に意味的に関連する過去シーン抜粋を文脈に自動注入 |
| 固有名詞の語彙一致も併用（ハイブリッド検索） | チェックボックス | ON | `ai.hybridRecall`（project）。意味検索（dense）に全文検索（FTS5/bm25）を RRF 融合し固有名詞の recall を補う。関連シーン自動注入が OFF のときは無効 |
| 意味検索インデックスの再構築 | ボタン | — | プロジェクト内の全シーンを再インデックス。インデックス状態（シーン数/チャンク数・stale チャンク数）も表示。進行状況は画面右下に表示 |

### デフォルト雛形

「現在のプロジェクト設定をデフォルト雛形として保存」ボタンを置き、`useWorkspaceStore.updateProjectDefaults()` を介して `globalSettings.projectDefaults` を更新する。今後新規作成するプロジェクトはこの雛形を初期値としてシード（`project_settings` テーブルにコピー）される。

### DBスキーマ

Project カテゴリ・AI 作品設定の各フィールド（`title` / `genre` / `pov` / `tense` / `language` / `outline` / `target_readers` / `style_guide` / `ai_instructions` / `phase_resolution_mode` / `ai_policy` 等）は `projects` テーブルに保存される。列定義は [統合DBスキーマ](./Grimodex_統合DBスキーマ.md) を正本とする。

---

## AI カテゴリ

BYOKのAPIキー管理とモデル設定。Chatパネル設計書で定義されたBYOK仕様をUIに落とし込む。`SettingScopeHeader` でグローバル設定（プロバイダ / モデル / Web 検索ポリシー）とプロジェクト設定に分かれ、プロジェクトスコープには AI 使用ポリシー・AI 作品設定（Outline / 対象読者 / Style guide / AI instructions、`AiProjectSettings`）・コンテキスト予算配分・Beat AI 統合・AI プロンプト追記カスタマイズ・MCP 連携が並ぶ。

### プロバイダ設定

プロバイダ選択は**ボタンタブ形式**（複数同時には保持せず、`localSettings.provider` 1 つ）で切り替える。選択中のプロバイダ固有設定（API キー / エンドポイント / ベース URL 等）と「テスト接続」ボタンが下に展開される。

現状サポートしているプロバイダ（`AI_PROVIDERS` / `src/features/chat/types.ts`）:

| プロバイダ | 識別子 | 詳細 |
|-----------|--------|------|
| OpenRouter | `openrouter` | API キー必須。`/api/v1/models` から動的にモデル一覧取得。`Provider pin` で 1 つのサブプロバイダにルーティング固定可能（Anthropic prompt cache 最適化用） |
| OpenAI | `openai` | API キー必須 |
| Anthropic | `anthropic` | API キー必須 |
| Ollama | `ollama` | API キー不要。`Endpoint`（既定 `http://localhost:11434`）を指定し `GET /api/tags` でモデル取得 |
| OpenAI 互換 | `openai-compatible` | llama.cpp / LM Studio / vLLM / 自前ホストの GPU 推論サーバ等。`Base URL` / `コンテキスト窓` / `最大出力` / `構造化出力許可` を入力。API キーは任意 |
| Sakana | `sakana` | API キー必須。fugu 系モデルを利用する HTTP プロバイダ |
| AI のべりすと | `ai-novelist` | 日本語小説特化プロバイダ。Base URL 二系統（legacy `/api` + v1 `/v1`）。`GET /v1/models` で v1 モデル動的取得 + レガシー静的リストをマージ。API キー必須。legacy モデル選択時のみ KoboldAI サンプリングパラメータ編集可。`multilingualMode` チェックボックスあり。構造化出力（Codex 自動抽出 / Synopsis 自動生成）はデフォルト無効 |
| CLI エージェント | `cli` | API キーではなく**ローカル CLI バイナリ**経由で呼び出す。`Claude Code` (`claude`) / `Codex CLI` (`codex`) / `OpenCode` (`opencode`) を選択し、バイナリパスを「自動検出」または手動指定。事前に CLI 側で `claude login` 等の認証が必要。ツール（ファイル R/W / shell）は全て無効化された状態で起動する |

```
┌──────────────────────────────────────────────┐
│ プロバイダ                                    │
│ [OpenRouter] [OpenAI] [Anthropic] [Ollama]   │
│ [OpenAI 互換] [Sakana] [AI のべりすと] [CLI] │
│                                              │
│ ─ 選択中のプロバイダ固有設定 ─                  │
│ API Key: [••••••••••]  [Show] [Save] [Delete]│
│ ...                                          │
│                              [テスト接続]      │
└──────────────────────────────────────────────┘
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
| Model whitelist | チェックボックスリスト | プロバイダのモデル一覧から、Chat / インラインAIモデルセレクタに表示するモデルを絞り込む。検索フィルタ付き・developer 別グルーピング。未設定時は全モデル表示。キー: `ai.modelWhitelist`（global） |
| Thinking mode | トグル | 拡張思考の ON/OFF。thinking 対応モデル選択時のみ表示。常時推論モデル（`canDisableReasoning === false`）は ON 固定・操作不可。対応モデルでは `reasoningEffortOverride`（low / medium / high / auto）も併せて選べる |
| Provider pin | ドロップダウン | OpenRouter 選択時のみ。1 つのサブプロバイダにルーティング固定（Anthropic prompt cache 最適化用）。`localSettings.openrouterProviderPin` |
| Tool call protocol | ドロップダウン | `auto` / `native` / `hermes`。LLM のツール呼び出しプロトコルを選ぶ。Anthropic / CLI は native 固定のため非表示。それ以外（ネイティブ tool-calling が不安定なローカル/互換モデル）で Hermes 形式に切り替えられる。`localSettings.toolProtocolMode`（`ToolProtocolMode`） |

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
| L1〜L5, Response reserve | スライダー（各レイヤー 1% 〜 60%、1% 刻み） | 上表参照 | 合計は100%以下。余剰は上位優先レイヤーに再配分。`[Reset to defaults]` で既定へ |
| 各レイヤーのfloor | 表示のみ | 固定値 | 最小トークン数。小コンテキストモデルでの最低保証 |

- 合計が100%を超える場合はバリデーションエラーを表示し保存不可
- 変更はプロジェクト単位で保存（`project_settings` テーブル、キー: `ai.contextBudget.*`）
- Chat設計書のプロンプトプレビューモーダルで実際の配分結果を確認可能

### Beat AI 統合

Beat システム（Phase C）の AI 連携設定。

| フィールド | UI 要素 | デフォルト | キー |
|-----------|---------|-----------|------|
| Beat を AI コンテキストに注入 | トグル | ON | `beat.injectIntoContext` |
| Beat 役割推論を有効化 | トグル | ON | `beat.inferRoles` |
| 役割推論の信頼度しきい値 | スライダー | 70% | `beat.roleInferenceConfidenceThreshold`（`0.5` - `0.95`、0.05 刻み） |

### Web 検索 (RAG) ドメイン制御（2026-06-18 追記）

Chat の Web 検索（RAG）のドメイン許可/拒否ポリシーを設定する。RAG 対応プロバイダ（`isRagCapableProvider`、OpenRouter / Anthropic）選択時のみ表示。グローバル設定。第三者（検索プロバイダ）へクエリ・本文が送信される旨の開示警告を常時表示する。

| フィールド | UI 要素 | デフォルト | キー |
|-----------|---------|-----------|------|
| ドメインモード | ドロップダウン | `off` | `ai.webSearch.domainMode`（`off` / `allow` / `block`） |
| ドメインリスト | テキストエリア（改行区切り） | 空 | `ai.webSearch.domains`（JSON 配列。`normalizeDomainList` で正規化して保存） |
| 本文トークン上限 | 数値 | 未設定 | `ai.webSearch.maxContentTokens`。OpenRouter（exa）経路でのみ表示・有効 |

- `allow` モードでリストが空のときは fail-open（全 Web 検索が通る）になるため注意喚起を表示
- OpenRouter ではドメイン制御 / 本文上限の指定が exa 強制（追加課金・未検証経路）になり得るため警告を表示。Anthropic は native `web_search` でドメイン制御を検証済み（exa 非経由・追加課金なし）

### AI プロンプト追記カスタマイズ（2026-06-18 追記）

各 AI 機能の組み込みプロンプトに、プロジェクト固有の追記指示を足す（追記式・空欄なら組み込みプロンプトのまま byte-identical）。プロジェクトスコープ。各スロット最大 2,000 文字のテキストエリア。

| スロット | キー |
|---------|------|
| チャット | `aiPrompt.custom.chat` |
| 校閲 | `aiPrompt.custom.kouetsu` |
| 伏線 | `aiPrompt.custom.foreshadow` |
| インライン AI | `aiPrompt.custom.inline` |
| Beat | `aiPrompt.custom.beat` |
| AI 分岐 | `aiPrompt.custom.aiBranch` |

### MCP 連携（2026-06-18 追記）

外部 MCP クライアントをこの Grimodex インストールに向ける `.mcp.json` スニペットをクリップボードへコピーする（`McpIntegrationSection`、AI カテゴリ末尾）。アプリバイナリ自身が MCP サーバ（`Grimodex mcp …`）を兼ね、スニペットの `command` は `get_mcp_config` が解決する OS 別の絶対パス。各ボタンはコピー動作のみでアプリのモード変更は伴わない。

| 軸 | 選択肢 |
|----|--------|
| スコープ（行） | このプロジェクト（`--project` で pinned） / 全プロジェクト（`--all-projects`、DB 全体・ローカル/信頼環境のみ） |
| 書込権限（ボタン） | 読み取り専用（`--readonly`、クラウド安全） / ポリシー準拠（`--readonly` なし。書き込みはプロジェクトの AI ポリシー `knowledgeWrite` / `bodyWrite` に従う＝アプリ内 AI と同じ） |

> 以前は Chat パネルにあったが AI カテゴリへ移設された。

---

## Editor カテゴリ

エディタの外観と振る舞いを設定する。変更は即座にEditorに反映される（リアルタイムプレビュー）。`SettingScopeHeader` でグローバルなユーザー嗜好（テキスト表示 / 編集体験 / インライン AI / Beat / アニメーション / 執筆目標の既定）と、作品ごとに変えうるプロジェクト設定（執筆目標の上書き / 縦書き・縦中横 / 段落スタイル）に分かれる。

### テキスト表示

| フィールド | UI要素 | 選択肢 | デフォルト |
|-----------|--------|--------|-----------|
| Font family | `FontFamilySelect` | 同梱フォント + システムフォント列挙 + カスタム指定 | 日本語 `"Noto Serif JP"` / 英語 `"Literata"`（`LANGUAGE_DEFAULT_OVERRIDES`、`editor.fontFamily`） |
| Font size | スライダー + 数値 | 14px - 24px (1px刻み) | 18px |
| Line height | スライダー + 数値 | 1.2 - 3.0 (0.1刻み) | 2.0（英語は 1.6） |
| Max content width | スライダー + 数値 | 480px - 960px (40px刻み) | 720px |
| Paragraph spacing | スライダー + 数値 | 0px - 24px (2px刻み) | 8px（英語は 0、字下げ運用） |

### 編集体験

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| Typewriter mode | トグル | OFF | カーソル行を常にキャンバス中央に固定 |
| Auto-save delay | スライダー | 2秒 | 0.5秒 - 10秒の範囲（`editor.autoSaveDelay`、ms） |
| Spell check | トグル | OFF | ブラウザ内蔵スペルチェック。日本語中心の執筆で誤検知が多いため既定OFF（英語は ON） |
| Smart quotes | トグル | OFF | 引用符の自動変換。日本語ではOFF推奨（英語は ON） |
| Smart dashes | トグル | OFF | 「--」→「—」の自動変換（英語は ON） |
| Markdown strict line breaks | トグル | OFF | OFF=GFM/Obsidian 互換（単一改行が改行になる）/ ON=CommonMark 仕様（単一改行はソフトブレイク）。キー: `editor.markdownStrictLineBreaks` |

> Word break / Line break / Paragraph indent / 和欧スペーシングはプロジェクト固有設定のため、下記「段落スタイル」（プロジェクトスコープ）に移動した。

> Focus mode（特定段落以外を薄く表示）と target character count（`editor.targetCharCount`）は型定義に存在するが Editor カテゴリ UI には未露出（focusMode は別経路、行番号 `editor.showLineNumbers` はエディタツールバー側のトグルで操作する）。

### インラインAI

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| Enable / command | トグル | ON | エディタ内の `/` コマンドトリガーを有効/無効（`editor.inlineAiCommand`） |
| Enable Ctrl+Shift+Space | トグル | ON | Ctrl+Shift+Space パレットを有効/無効（`editor.inlineAiShortcut`） |

### Beat

| フィールド | UI要素 | デフォルト | キー |
|-----------|--------|-----------|------|
| Focus mode で Beat を非表示にする | トグル | OFF | `editor.focusModeHideBeats` |
| Beat 表示モード（リニア編集モード時） | ドロップダウン | collapsed | `editor.linearBeatDisplay`（`normal` / `collapsed` / `hidden`） |

### アニメーション

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| Smooth caret | トグル | ON | カーソル移動時にスムーズにスライド |
| Cursor blink | トグル | ON | 滑らかなフェード点滅（ブラウザデフォルトの硬い点滅を置き換え） |
| Character fade-in | トグル | OFF | 入力時に文字がふわっと現れる |
| Character fade-out | トグル | OFF | 削除時に文字がすっと消える |
| Disable all animations | トグル | OFF | 上記4つを一括OFF（`editor.disableAllAnimations`）。ON にすると上記 4 トグルは無効化される |

### 執筆目標（2026-06-18 追記）

日次の目標文字数（writing goal）。二段構成で、グローバルセクションに全プロジェクト共通の既定値、プロジェクトセクションに当該プロジェクト固有の上書きを置く。`SettingNumberInput`（100 字刻み、0 = 目標なし）。

| フィールド | スコープ | デフォルト | キー |
|-----------|---------|-----------|------|
| 日次目標（既定） | global | 0 | `goal.dailyDefaultChars` |
| 日次目標（このプロジェクト） | project | 0（0 のとき既定にフォールバック） | `goal.dailyChars` |

### 書字方向（縦書き・縦中横）（2026-06-18 追記）

プロジェクト固有設定。

| フィールド | UI要素 | デフォルト | キー |
|-----------|--------|-----------|------|
| 縦書きモード | トグル | OFF | `editor.verticalMode` |
| 縦中横 | ドロップダウン | `2` | `editor.tateChuYoko`（`off` / `2`=2桁のみ正立結合 / `all`=全桁）。縦書き時に半角数字を正立結合する |

### 段落スタイル（2026-06-18 追記）

CSS の禁則・字下げ・和欧スペーシング。いずれもプロジェクト固有設定（作品ごとに変えうる）。

| フィールド | UI要素 | デフォルト | キー |
|-----------|--------|-----------|------|
| Paragraph indent | ドロップダウン | 0 | `editor.paragraphIndent`（`0`=オフ / `1` / `2`、英語は既定 1） |
| Word break | ドロップダウン | normal | `editor.wordBreak`（CSS `word-break` 相当。`auto-phrase` / `normal` / `break-all` / `keep-all`） |
| Line break | ドロップダウン | strict | `editor.lineBreak`（日本語行頭禁則の強度。CSS `line-break`。`strict` / `normal` / `loose` / `auto`） |
| 和欧スペーシング | ドロップダウン | normal | `editor.textAutospace`（CSS `text-autospace`。`normal`=CJK↔英数字に四分アキ相当を自動挿入 / `no-autospace`。WebKit 既定は no-autospace なので `normal` を明示する） |

---

## Display カテゴリ

UIの外観全般を設定する。

### テーマ

| フィールド | UI要素 | 選択肢 | デフォルト |
|-----------|--------|--------|-----------|
| Color theme | ドロップダウン | `simple` / `dark-academia` / `modern-mystic` / `warm-craft`（`src/lib/colorThemes.ts` の `COLOR_THEMES`） | `simple` |
| Light / Dark | ドロップダウン | System / Dark / Light | System |

> 当初の設計では「アクセント色のプリセット 5 色 + カスタム」を想定していたが、現状はカラーテーマ単位（パレット全体＋ライト／ダークの双方を含む）でプリセット選択する形に統一されている。

### UI

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| UI language | ドロップダウン | 日本語 | **現状の実装**は日本語 (ja) / English (en) の 2 言語。中文 / 한국어 はネーミングルールのフォールバック実装（i18next リソース）は存在するが、UI 言語セレクタには未追加（将来拡張） |
| UI font | `FontFamilySelect` | `"M PLUS 1"`（同梱） | UI 表示書体。`display.uiFontFamily`（global）。同梱フォント + システムフォント列挙 + カスタム指定 |
| UI scale | スライダー | 100% | 80% - 上限（実機の Hi-DPI に応じて `getUiScaleMaxPercent()` で算出、最大 150% 程度）。5% 刻み。ポインタドラッグ中は IPC を抑制し、リリース時にのみコミットする。`uiScale` はグローバル設定 |
| Reduce motion | トグル | OFF | アニメーションを抑制し Framer Motion / GSAP の遷移を最小化。OS の `prefers-reduced-motion` とも連動。キー: `display.reduceMotion` |
| Show word count in Scenes | トグル | ON | Scenesパネルのツリーに文字数を表示（`display.showWordCount`） |
| Show AI badge in Scenes | トグル | OFF | ScenesパネルのツリーにAI帰属バッジを表示（`display.showAiBadge`） |

### Codex ハイライト / Attribution

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| Codex highlight | トグル | ON | エディタ本文中のCodexハイライトを有効/無効。キー: `display.codexHighlight` |
| Codex highlight style | ドロップダウン | Color text | Color text（文字色をカテゴリカラーに変更）/ Underline（点線の下線をカテゴリカラーで表示）。キー: `display.codexHighlightStyle` |
| Attribution highlight opacity | スライダー | 10% | Attr表示ON時の背景ハイライトの不透明度（5% - 25%）。キー: `display.attributionHighlightOpacity` |

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
| Auto-backup | トグル | ON | 定期的に自動バックアップを作成。キー: `data.autoBackup` |
| Backup interval | スライダー（15 - 360 分、15 分刻み） | 60 分 | キー: `data.backupInterval` |
| Max backups | スライダー（1 - 50） | 10 | キー: `data.maxBackups` |
| Backup location | — | プロジェクトフォルダ内 `backups/` | ※ 現状未実装（フォルダ選択 UI はまだ存在せず、出力先は固定） |
| [Backup now] / [Open backups folder] | — | — | ※ 現状未実装 |

バックアップ形式: プロジェクトフォルダ全体（`content/` + `codex/` + `snippets/` + `project.db`）をZIPアーカイブ。ファイル名: `{project_title}_{YYYYMMDD_HHmmss}.zip`

### リビジョン

シーン単位の自動リビジョン（スナップショット）に関する設定。

| フィールド | UI要素 | デフォルト | 詳細 |
|-----------|--------|-----------|------|
| Auto interval | スライダー（1 - 60 分） | 5 分 | 自動でリビジョンを作成する間隔。キー: `revision.autoInterval` |
| Keep count | スライダー（10 - 200、10 刻み） | 50 | シーンあたりの保持リビジョン数の上限。超過分は古い順に削除。キー: `revision.keepCount` |

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
| Format | セグメント | plaintext | 出力フォーマット。`markdown` / `plaintext` / `html`。キー: `export.format` |
| Folder heading | トグル | ON | フォルダー名を見出しとして出力するか。キー: `export.folderHeading`（bool） |
| Folder heading style | セグメント | squares | プレーンテキスト時の見出し記号スタイル。`squares` / `brackets` / `numbers`。キー: `export.folderHeadingStyle` |
| Scene divider | セグメント | blank | シーン間区切り。`blank` / `blank2` / `asterisks` / `hr` / `rule` / `none` / `custom`。キー: `export.sceneDivider`（`custom` 時のみ `export.sceneDividerCustom` を併用） |
| Scene title | セグメント | none | シーンタイトルの出力スタイル。`none` / `heading` / `bold` / `plain`。キー: `export.sceneTitle` |
| Ruby style | セグメント | 自動 | ルビ出力。`html`（`<ruby>`タグ） / `parentheses`（括弧）/ `aozora`（青空文庫風）/ `base`（ルビを落とす）。空欄時は出力形式に応じて自動選択。キー: `export.rubyStyle` |
| Emphasis dots style | セグメント | 自動 | 傍点出力。`html` / `aozora` / `double-angle` / `plain`。空欄時は自動。キー: `export.emphasisDotsStyle` |
| Scene break style | セグメント | asterisks | 本文中シーンブレイク (`SceneBreakNode`) の出力スタイル。`asterisks` / `hr` / `blank` / `custom`。キー: `export.sceneBreakStyle`（`custom` 時は `export.sceneBreakCustom` 併用） |
| Include trash bin | チェックボックス | OFF | ゴミ箱の中身を export に含めるか。キー: `export.includeTrashBin` |

> Export 詳細設定の編集 UI は Settings カテゴリ「Data」内ではなく、エクスポートダイアログ（`src/features/export/ExportSettingsPanel.tsx`）が一次的な編集面となっている。Data カテゴリ内には「エクスポートを開く」「Codex JSON エクスポート」ボタンのみが置かれる。

### データ管理

| ボタン | 動作 |
|--------|------|
| Rebuild FTS indexes | FTS5仮想テーブルを再構築（検索が壊れた場合のリカバリ） |
| Rebuild Codex mention cache | `scene_codex_mentions` を全 Codex × 全シーンで完全再スキャン（進捗バー付き）。Codex rename 時の部分再スキャンが Aho-Corasick の最長一致衝突で取りこぼした場合の逃げ道。詳細は Matrix 設計書参照 |
| Compact database | SQLiteの VACUUM を実行（データベースサイズ最適化） |
| Clear chat history | 全チャットセッション・メッセージを削除（確認ダイアログ。Codex/Snippetの抽出済みデータは残る） |
| Delete project | プロジェクト全体を削除（最終確認ダイアログ。テキスト入力での確認を要求） |
| Check integrity | 孤立参照チェック＆修復、Codex×シーン相互参照レポート生成（`IntegrityCheckSection`） |

> データ管理セクションの下に外部マウント管理（`externalMount` / `MountListDialog`）が並ぶ。

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

## Map カテゴリ（2026-06-18 追記）

Map パネルで新規作成する付箋・エッジの既定値を設定する（`MapCategory`）。いずれもグローバル設定。

### 付箋の既定

| フィールド | UI 要素 | デフォルト | キー |
|-----------|---------|-----------|------|
| パレット | ドロップダウン | `post-it-playful` | `map.defaultStickyPaletteId`（`src/lib/stickyPalettes.ts` の `PALETTES`） |
| 既定色 | カラースウォッチ | 0（パレット先頭の色スロット） | `map.defaultStickyColorSlot`。選択中パレットの色配列からスロット番号で選ぶ |

### エッジの既定

| フィールド | UI 要素 | デフォルト | キー |
|-----------|---------|-----------|------|
| 既定のエッジスタイル | ドロップダウン | `solid` | `map.defaultEdgeStyle`（`solid` / `dashed` / `dotted`） |

---

## Linter カテゴリ

本文・スニペットに対する Lint ルールの設定と、プロジェクト固有の無視リストを管理する。UI は **3 タブ構成**（`ルール設定` / `用語辞書` / `無視リスト`）。

### タブ 1: ルール設定

ルールは言語別／用途別に 4 グループ（`ja/` / `en/` / `project/` / `codex/`）に分類されて表示される。各ルールについて、ON/OFF と重要度（`info` / `warn` / `error`）を個別に切り替える。校正全体を有効/無効にするマスタートグルもある。

```
校正
──────────────────────────────────────
☑  校正 を有効にする        [Reset all]

[ja] 日本語ルール
☑  ja/duplicate-paragraph    [warn  ▼]
☑  ja/long-sentence          [info  ▼]
☐  ja/mixed-quote-style      [warn  ▼]
...

[en] 英語ルール / [project] / [codex]
...
```

- グループ単位でセクション表示
- ON/OFF はチェックボックス、重要度はドロップダウン
- ルールごとの説明文と「例を見る」リンク
- 「Reset all」ボタンで全ルールを初期値へ戻す

### タブ 2: 用語辞書

プロジェクト固有の用語（`Term`）と表記ゆれの基準形（`canonical`）／許容バリアントを管理する。本文に「許容外の表記」が現れたら校正側で警告できる。詳細は Linter 設計書（`TermDictionaryTab`）に委譲。

### タブ 3: 無視リスト

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

## Usage カテゴリ（2026-06-18 追記）

プロジェクト単位の AI トークン使用量・推定コストを表示する（`UsageCategory`、表示のみ）。`ai_usage` 台帳（`getProjectUsageSummary`）を集計する。書き込み側（`recordAiUsage`）と同じ `projectId` 源（tree store）を使って read/write のずれを防ぐ。

| セクション | 内容 |
|-----------|------|
| 合計 | 生成回数 / 入力トークン / 出力トークン / 推定コスト（推定値を含む場合は `≈` 接頭辞）。計測不能（unmetered）件数があれば併記 |
| Prompt cache | キャッシュ読込率（read /(read+write)）/ cache read トークン / cache write トークン。キャッシュトークンがある場合のみ表示 |
| サーフェス別 | チャット・インライン AI・校閲・抽出など発生サーフェス別の件数・トークン・コスト内訳（`surfaceLabel`） |

> コストはモデル価格表からの推定であり、実際の課金額とは一致しないことがある旨の注記を表示する。

---

## License カテゴリ（2026-06-18 追記）

ライセンス認証の状態確認・キー入力・端末解除・再検証を行う（`LicenseCategory`、ライセンス認証設計書 §7）。licensing 無効ビルドでは `CategoryNav` が項目ごと非表示にする（`LicenseCategory` も `licensingEnabled` が false なら `null` を返す）。状態は `useLicenseStore` から購読する。

| 状態 | 表示・操作 |
|------|-----------|
| trial / trial_expired | 残日数（`trialDaysRemaining`）またはトライアル終了。キー入力 + アクティベート、購入リンク（Polar） |
| licensed / grace | アクティベート済み（キー末尾 `keyTail` / grace 残日数）。最終検証日時、「この端末を解除」（二段階確認ボタン） |
| license_stale | 「再検証」ボタン（オンライン再確認） |
| revoked | 失効表示・機能制限の説明 |

---

## About カテゴリ

アプリに関するメタ情報とサポートリンクを表示する。設定項目ではなく情報表示が主体。`src/features/settings/categories/about/` 配下のサブコンポーネントで構成される。

| 要素 | コンポーネント | 詳細 |
|------|---------------|------|
| App info header | `AppInfoHeader` | アプリ名・バージョン・ロゴ等のヘッダー表示 |
| 利用規約 | `CollapsibleDocSection`（`TERMS_ja.md`） | 折りたたみ可能な利用規約ビュー |
| 開発者メッセージ | `CollapsibleDocSection`（`DEVELOPER_MESSAGE_ja.md`） | 折りたたみ可能な開発者メッセージ |
| Third-party licenses | `LicensesSection` | npm / cargo の `THIRD_PARTY_LICENSES` を一覧表示 |

> 当初設計にあった「Welcome Tour 再表示ボタン (`welcome.seen` リセット)」「GitHub リンク」は現状未実装。バージョン番号もヘッダーで表示するのみで、クリックによるコミットハッシュトグル等は持たない。

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

`KEY_SCOPE` が `project` のキーは `setProjectSetting` 経由で `project_settings` テーブルに 300ms debounce で保存する。プロジェクトを開き直すと当該プロジェクトの `project.db` から読み戻される。`KEY_SCOPE` に載っていない旧来キー（legacy 層）は従来どおり `app_settings` テーブル（`setSetting`）へ保存される。

> `settingsStore` は legacy（`app_settings`）/ project（`project_settings`）/ global（`global-settings.json` の `userPreferences`）の 3 層を `DEFAULT_SETTINGS` < 言語別オーバーライド（`LANGUAGE_DEFAULT_OVERRIDES`）< legacy < project < global の優先順位でマージする。書き込み先は `KEY_SCOPE[key]` で決まる（`persistSetting`）。

#### カテゴリ独自ストア

一部のカテゴリは専用ストア／テーブルへ委譲し、Settings UI はそのファサードとして振る舞う:

| カテゴリ | 委譲先 | 備考 |
|---------|-------|------|
| Codex types | `typeApi`（Zustand） + `codex_types` テーブル | ビルトイン／カスタムタイプの CRUD |
| Linter (ルール + 無視リスト) | `lintConfigStore` + `lint_ignores` テーブル | `app_settings` テーブルには保存しない |
| AI (APIキー) | Tauri keyring | OS 標準のセキュアストレージ |
| AI (プロバイダ / モデル選択 / 拡張思考 / Tool protocol 等) | `chat/store`（`useAiSettingsStore`） | Chat パネルと共有 |

#### 保存先サマリ

| 設定カテゴリ | 保存先 | 理由 |
|-------------|--------|------|
| Project (メタ情報 / outline / 対象読者 / aiPolicy / phaseResolutionMode) | `projects` テーブル | プロジェクト固有 |
| Project (ネーミング `tree.folderNaming` / 採番スコープ `tree.numberingScope`) | `project_settings` テーブル | プロジェクト固有 |
| Project (ゴミ箱 `trashBin.enabled` / `trashBin.retentionDays`) | `project_settings` テーブル（legacy 層）※ | プロジェクト固有 |
| Project (タイムラプス `timelapse.enabled`) | `project_settings` テーブル | プロジェクト固有 |
| Project (デフォルト雛形 `projectDefaults`) | `global-settings.json` | 全プロジェクトの初期値として共有 |
| AI (APIキー) | Tauri keyring | セキュリティ |
| AI (プロバイダ / モデル / Provider pin / Tool protocol / openai-compatible / ai-novelist サンプリング・多言語モード / cli 設定) | `chat/store` 経由 | グローバル |
| AI (`ai.inlineModel` / `ai.sessionTitleModel` / `ai.modelWhitelist`) | `global-settings.json` | グローバル |
| AI (Web 検索 `ai.webSearch.domainMode` / `ai.webSearch.domains` / `ai.webSearch.maxContentTokens`) | `global-settings.json` | グローバル |
| AI (`ai.autoAcceptBodyProposals` / `ai.semanticRecall` / `ai.hybridRecall`) | `project_settings` テーブル | プロジェクト固有 |
| AI (コンテキスト予算 `ai.contextBudget.*`) | `project_settings` テーブル | プロジェクト固有 |
| AI (Beat 連携 `beat.injectIntoContext` / `beat.inferRoles` / `beat.roleInferenceConfidenceThreshold`) | `project_settings` テーブル | プロジェクト固有 |
| AI (プロンプト追記 `aiPrompt.custom.*`) | `project_settings` テーブル | プロジェクト固有 |
| Editor (フォント / 行間 / アニメーション / インライン AI / Beat 表示 / `goal.dailyDefaultChars` 等のユーザー嗜好) | `global-settings.json` | グローバル |
| Editor (`wordBreak` / `lineBreak` / `paragraphIndent` / `textAutospace` / `verticalMode` / `tateChuYoko` / `targetCharCount` / `goal.dailyChars`) | `project_settings` テーブル | プロジェクト固有（作品ごとに変えうる） |
| Display (theme / colorTheme / uiLanguage / uiScale / `display.uiFontFamily`) | `global-settings.json` | グローバル |
| Display (reduceMotion / Codex highlight / Attribution opacity 等) | `global-settings.json`（`KEY_SCOPE` 上は `global`） | グローバル |
| Keys (`keys.bindings`) | `global-settings.json` | グローバル |
| Data (バックアップ / リビジョン) | `global-settings.json` | グローバル |
| Map (`map.defaultStickyPaletteId` / `map.defaultStickyColorSlot` / `map.defaultEdgeStyle`) | `global-settings.json` | グローバル |
| Data (エクスポート詳細 `export.*`) | `project_settings` テーブル | プロジェクト固有 |
| Codex (types) | `codex_types` テーブル（`typeApi` 経由） | プロジェクト固有 |
| Linter (ルール / 用語辞書) | `lintConfigStore` | プロジェクト固有 |
| Linter (無視リスト) | `lint_ignores` テーブル | プロジェクト固有 |
| Usage | `ai_usage` 台帳の集計（表示のみ） | — |
| License | `useLicenseStore`（Rust 側に保存） | 端末ごと |
| About | 表示のみ | — |

> ※ `trashBin.*` は `KEY_SCOPE` に未登録のため legacy 層（`app_settings`）に保存される可能性がある。スコープの正本は `KEY_SCOPE`（`src/features/settings/types.ts`）で、`KEY_SCOPE[key]` が `global` なら `global-settings.json` の `userPreferences`、`project` なら `project_settings` テーブル、未登録なら legacy（`app_settings`）に書き込まれる。設計書と実装で表現が食い違う場合は `KEY_SCOPE` を正とする。

### settings 保存テーブル

設定の Key-Value は `app_settings`（legacy・アプリ全体）と `project_settings`（プロジェクト固有）の 2 テーブルに分かれ、いずれもドット区切りキー（例: `editor.fontSize`、`ai.contextBudget.l3`）で JSON 値を保存する。テーブルの DDL は [統合DBスキーマ](./Grimodex_統合DBスキーマ.md) を正本とする。`KEY_SCOPE` が `project` のキーは `project_settings`、未登録キーは `app_settings`、`global` のキーは `global-settings.json` に書き込まれる。

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

> **（2026-06-18 追記）** 下記のうち `editor.linearBeatDisplay` / `editor.focusModeHideBeats` は実装済みで、本文「Editor カテゴリ § Beat」に記載済み（UI 上の保存先キーが正本。下表の旧 JSON 例の `beatDisplayInLinearMode` / `hideBeatsInFocusMode` は古いキー名で、実際は `editor.linearBeatDisplay` / `editor.focusModeHideBeats`）。`beatTypePrompts` / `injectPendingBeatsInGeneration` / `includeBeatsInCharCount` / `includeBeatsInFullTextSearch` / `subplotTagName` は現状コードに存在しない（未実装の提案）。

### Editor カテゴリ

| 項目 | 値 | 既定 | キー | 説明 |
|------|-----|------|------|------|
| Beat 表示モード（リニア編集モード時） | `normal` / `collapsed` / `hidden` | `collapsed` | `editor.linearBeatDisplay` | リニア編集モードでの Beat ブロックの扱い（実装済み） |
| Focus mode で Beat を非表示にする | boolean | false | `editor.focusModeHideBeats` | Focus mode 時の Beat 非表示トグル（実装済み） |
| 文字数カウントに Beat 内テキストを含める | boolean | false | — | ※ 現状未実装（執筆統計の集計対象は本文のみ） |
| 全文検索で Beat 内テキストを対象にする | boolean | true | — | ※ 現状未実装（検索範囲の切替 UI は未提供） |

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
