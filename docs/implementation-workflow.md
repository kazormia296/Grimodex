# Grimodex 実装ワークフロー

> 作成日: 2026-04-02
> 基準: docs/ 配下の全設計書 + SPEC.md Phase 1-6

本文書は、設計書（docs/）の仕様と現在の実装状態を比較し、
残りの実装タスクを依存関係順に整理したワークフローである。

---

## 1. 現状サマリ

### 1.1 実装済み（設計書準拠）

| レイヤー | 状態 | 詳細 |
|---------|------|------|
| **統合DBスキーマ** | **完了** | 14テーブル + FTS5 3テーブル + トリガー。設計書と完全一致 |
| **Drizzle ORM定義** | **完了** | `src/db/schema.ts` — 全テーブル定義済み |
| **スキーマテスト** | **完了** | `src/db/schema.test.ts` — 制約・FTS5同期を検証 |
| **Tauriコマンド (Backend)** | **完了** | 20コマンド（workspace/db/content/ai/maintenance） |
| **API関数 (Frontend)** | **完了** | 50以上の関数（chat/codex/snippet/tree/project/attribution） |
| **Zustandストア** | **完了** | 10ストア（chat/codex/editor/snippet/workspace/attribution/tree 等） |
| **テストスイート** | **完了** | 41ファイル / 389テスト 全パス |

### 1.2 SPEC.md Phase 対応状況

| Phase | 名称 | 状態 |
|-------|------|------|
| Phase 1 | 基盤 | **完了** — プロジェクト管理、ツリー、エディタ、DB、自動保存 |
| Phase 2 | AIチャット | **完了** — API設定、セッションCRUD、ストリーミング、基本コンテキスト |
| Phase 3 | Codex | **完了** — CRUD、タグ、FTS5、ピン留め、コンテキスト構築 |
| Phase 4 | 抽出と統合 | **完了** — Codex/Snippet抽出、帰属マーク挿入、コピーペースト帰属 |
| Phase 5 | 帰属追跡と仕上げ | **ほぼ完了** — Mark拡張、オーバーレイ、永続化済み。エクスポートは一部 |
| Phase 6 | パフォーマンスと品質 | **部分的** — FTS最適化、仮想化リスト済み。UIの磨き上げが残存 |

### 1.3 結論

**SPEC.md の MVP スコープ（Phase 1-6）はコアロジック・データ層としてほぼ実装完了している。**
残りの作業は主に、各パネル設計書で定義された **UI/UX の詳細仕様** と **レイアウトシステム** の実装である。

---

## 2. 設計書 vs 実装 ギャップ分析

以下、各設計書ごとに「実装済み」「未実装」を整理する。

### 2.1 レイアウトシステム設計書

**現状:** `App.tsx` で固定3ペインレイアウト（Sidebar | Editor | RightPanel）。
`ResizablePanelGroup` によるリサイズのみ対応。

| 仕様項目 | 状態 |
|---------|------|
| Activity Bar（アイコン＋インジケータドット） | 未実装 |
| Left Dock（タブ切替、折りたたみ） | 未実装 — Sidebar は Scenes 固定 |
| Center（Editor Groups、分割） | 未実装 — 単一エディタのみ |
| Right Dock（タブ切替、折りたたみ） | **部分的** — RightPanel に 4 タブあり |
| Bottom Dock（Snippets, Attribution） | 未実装 — RightPanel タブに統合中 |
| フローティングウィンドウ | 未実装 |
| パネル状態管理（Closed/Docked/Collapsed/Floating） | 未実装 |
| レイアウト永続化（layout.json） | 未実装 |
| キーボードショートカット（Ctrl+Alt+S/C/X 等） | 未実装 |
| D&D によるパネル移動 | 未実装 |

### 2.2 Scenes パネル設計書

**現状:** `Sidebar.tsx` — フラットなシーンリスト、作成・削除・リネーム。

| 仕様項目 | 状態 |
|---------|------|
| 基本的なシーン一覧表示 | **実装済み** |
| シーン作成・削除・リネーム | **実装済み** |
| Part/Chapter/Scene/Folder/Note 階層ツリー | 未実装 — フラットリスト |
| D&D による並び替え | 未実装 |
| ステータスドット（Outline/Draft/Complete/Revision/Final） | 未実装 |
| 文字数表示 | 未実装 |
| AI帰属バッジ | 未実装 |
| フィルタ入力（インクリメンタル検索） | 未実装 |
| ツールバー（作成メニュー、展開/折りたたみ） | 未実装 |
| Codex Quick セクション | 未実装 |
| コンテキストメニュー | 未実装 |

### 2.3 Editor パネル設計書

**現状:** `SceneEditor.tsx` — 単一シーンの TipTap エディタ。帰属追跡・Codexハイライト・自動保存・縦書きプレビュー実装済み。

| 仕様項目 | 状態 |
|---------|------|
| TipTap エディタ基本機能 | **実装済み** |
| Toolbar（書式設定ボタン） | **実装済み** |
| 自動保存（2秒デバウンス） | **実装済み** |
| AuthorshipMark（帰属追跡） | **実装済み** |
| Codex ハイライト（Aho-Corasick） | **実装済み** |
| CodexPopover | **実装済み** |
| クリップボード帰属追跡 | **実装済み** |
| Snippet D&D 挿入 | **実装済み** |
| 縦書きプレビュー | **実装済み** |
| ルビ（RubyNode） | **実装済み** |
| 文字数カウント | **実装済み** |
| マルチタブ（Editor Group モデル） | 未実装 |
| タブバー（プレビュー/固定、パンくず） | 未実装 |
| 分割エディタ（水平・垂直） | 未実装 |
| インライン AI コマンド（/continue, /rewrite 等） | 未実装 |
| Diff 表示（Accept/Reject） | 未実装 |
| Find & Replace | 未実装 |
| ステータスバー（文字数、AI率、カーソル位置） | 未実装 |
| コンテキストメニュー（Add to Codex 等） | 未実装 |
| キーボードショートカット一式 | 部分的 |

### 2.4 Chat パネル設計書

**現状:** `ChatPanel.tsx` — ストリーミングチャット、Codex/Snippet 抽出、ピン留め。

| 仕様項目 | 状態 |
|---------|------|
| メッセージ表示（User/AI/System） | **実装済み** |
| ストリーミング応答 | **実装済み** |
| 入力エリア（Enter で送信） | **実装済み** |
| Codex 抽出ダイアログ | **実装済み** |
| Snippet 抽出ダイアログ | **実装済み** |
| エディタへの挿入ボタン | **実装済み** |
| ピン留め Codex バッジ | **実装済み** |
| コンテキストトークン数表示 | **実装済み** |
| ヘッダー（シーンインジケータ） | 部分的 |
| コンテキストバー（視覚的ピル表示） | 未実装 |
| セッション一覧 UI（切替・管理） | 未実装 |
| セッション自動タイトル生成 | 未実装 |
| `/` コマンド（continue, describe 等） | 未実装 |
| モデルセレクタ（入力エリア内） | 未実装 |
| メッセージアクション（Regenerate/Edit/Delete） | 部分的 |
| コンテキストレイヤー詳細 UI | 未実装 |
| AI/Manual 抽出モード切替 | 未実装 |
| Chapter summary コンテキスト（Layer 2） | 未実装 |

### 2.5 Codex パネル設計書

**現状:** `CodexPanel.tsx` + `CodexManagementPanel.tsx` — 検索、タイプフィルタ、詳細表示、編集。

| 仕様項目 | 状態 |
|---------|------|
| エントリ CRUD | **実装済み** |
| FTS5 検索 | **実装済み** |
| タイプフィルタタブ | **実装済み** |
| タグ表示・編集 | **実装済み** |
| 詳細画面（分割ビュー） | **実装済み** |
| チャット抽出ソース表示 | **実装済み** |
| 仮想化リスト | **実装済み** |
| Ctrl+K コマンドパレット | **実装済み** |
| Codex マッチング（Aho-Corasick） | **実装済み** |
| クロスリファレンス検出 | **実装済み** |
| Aliases / Excluded Aliases | **部分的** — スキーマ定義済み、UI は要確認 |
| Context Mode UI（always/mentioned/suppress/hidden） | 未実装（スキーマは対応済み） |
| カスタム詳細フィールド UI | 未実装（スキーマは対応済み） |
| リレーション（親子ツリー）UI | 未実装（スキーマは対応済み） |
| アイコン画像管理（WebP） | 未実装 |
| ソートオプション | 未実装 |
| バルク操作 | 未実装 |

### 2.6 Snippets パネル設計書

**現状:** `SnippetPanel.tsx` — 検索、分割ビュー、D&D、コピー。

| 仕様項目 | 状態 |
|---------|------|
| CRUD | **実装済み** |
| 検索（デバウンス） | **実装済み** |
| 分割ビュー（リスト＋詳細） | **実装済み** |
| D&D でエディタへ挿入 | **実装済み** |
| クリップボードコピー（帰属メタデータ付き） | **実装済み** |
| ソースバッジ（[AI]/[Human]） | 部分的 |
| フィルタバー（ソース、タグ、ソート） | 未実装 |
| 使用回数カウント表示 | 未実装（スキーマは対応済み） |
| タグクラウド UI | 未実装 |
| クリップボード貼り付けで Snippet 作成 | 未実装 |
| インライン展開（全画面編集） | 未実装 |

### 2.7 Attribution パネル設計書

**現状:** `AttributionReport.tsx` — Human/AI/Unknown のパーセンテージバーとエクスポートボタン。

| 仕様項目 | 状態 |
|---------|------|
| 基本的な Human/AI/Unknown 割合表示 | **実装済み** |
| Agent Trace エクスポート | **実装済み** |
| スコープセレクタ（Project/Part/Chapter/Scene） | 未実装 |
| サマリカード（総文字数、各ソース文字数） | 未実装 |
| ブレークダウンバー（積み上げ棒グラフ） | 未実装 |
| シーン別テーブル（ミニ棒グラフ付き） | 未実装 |
| モデル別使用量 | 未実装 |
| フィルタモード（クリックでエディタハイライト） | 未実装 |
| エクスポート（Markdown/CSV） | 未実装 |

### 2.8 Chat History パネル設計書

**現状:** 未実装。Chat History パネルは存在しない。

| 仕様項目 | 状態 |
|---------|------|
| セッション一覧（シーン別グループ） | 未実装 |
| FTS5 メッセージ検索 | 未実装 |
| フィルタ（シーン、抽出有無、プロジェクトスコープ） | 未実装 |
| セッションカード（タイトル、メッセージ数、抽出数） | 未実装 |
| 検索結果モード（メッセージスニペット表示） | 未実装 |
| Codex/Snippet バッジポップオーバー | 未実装 |

### 2.9 Settings パネル設計書

**現状:** `AiSettingsDialog.tsx` — AI 設定（プロバイダー、APIキー、モデル選択）のみ。

| 仕様項目 | 状態 |
|---------|------|
| AI プロバイダー設定 | **実装済み** |
| API キー管理（Keyring） | **実装済み** |
| モデル選択 | **実装済み** |
| 接続テスト | **実装済み** |
| プロジェクト設定（タイトル、ジャンル、POV 等） | 未実装（スキーマは対応済み） |
| エディタ設定（フォント、行高、自動保存間隔等） | 未実装 |
| 表示設定（テーマ、UIスケール、コードックスハイライト等） | 未実装 |
| キーバインド設定 | 未実装 |
| データ管理（バックアップ、エクスポート、メンテナンス） | 部分的（IntegrityCheckDialog あり） |

---

## 3. 実装ワークフロー（優先度順）

設計書の依存関係とユーザー体験への影響度に基づき、以下の順序で実装する。
各フェーズは前フェーズの完了を前提とする（ただしフェーズ内のタスクは並行可能）。

### Phase A: レイアウトシステム基盤

**前提:** 全パネルの配置・表示切替の土台。他の全 UI 改善の前提条件。
**設計書:** `Grimodex_レイアウトシステム設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| A-1 | layoutStore 作成 | パネル状態（Closed/Docked/Collapsed）、ドックゾーン構成、アクティブタブを管理する Zustand ストア |
| A-2 | Activity Bar 実装 | 左端40px固定バー。アイコン＋インジケータドット。クリックでパネルトグル |
| A-3 | Left Dock 実装 | Scenes / Codex / Chat History をタブ切替。折りたたみ対応 |
| A-4 | Bottom Dock 実装 | Snippets / Attribution をタブ切替。リサイズ＋折りたたみ対応 |
| A-5 | Right Dock 改修 | 既存 RightPanel を Dock 化。折りたたみ対応 |
| A-6 | パネルキーボードショートカット | Ctrl+Alt+S/C/X/H/N/A/B/R/J |
| A-7 | レイアウト永続化 | settings テーブルまたは layout.json に保存・復元 |

**後回し（Post-MVP）:** フローティングウィンドウ、D&D パネル移動

### Phase B: Scenes パネル強化

**前提:** ツリー構造はエディタ・チャット・Attribution の基盤。
**設計書:** `Grimodex_Scenesパネル設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| B-1 | 階層ツリー表示 | tree_nodes の parent_id/node_type に基づく Part > Chapter > Scene / Folder > Note ツリー |
| B-2 | ノードタイプ別 CRUD | Part/Chapter/Scene/Folder/Note それぞれの作成 UI（ドロップダウンメニュー） |
| B-3 | D&D 並び替え | fractional indexing（sort_order）を使ったドラッグ＆ドロップ。ノードタイプ制約の検証 |
| B-4 | ステータスドット | Scene にステータス表示（Outline/Draft/Complete/Revision/Final）。クリックで変更 |
| B-5 | 文字数・AI率バッジ | 各ノードの文字数と AI 帰属率を表示（オプション） |
| B-6 | フィルタ入力 | インクリメンタル検索。祖先パス表示 |
| B-7 | Codex Quick セクション | アクティブシーンの Codex エントリ一覧。ピン留め対応 |

### Phase C: Editor パネル強化

**前提:** Phase B 完了（階層ツリーからの複数シーン操作が必要）。
**設計書:** `Grimodex_Editorパネル設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| C-1 | マルチタブ基盤 | Editor Group モデル。タブバー（プレビュー/固定状態）、パンくず表示 |
| C-2 | ステータスバー | 文字数、AI帰属率、カーソル位置 |
| C-3 | コンテキストメニュー | 右クリック：Add to Codex / Save as Snippet / Look up in Chat / 書式設定 |
| C-4 | Find & Replace | Ctrl+F/H。単一シーン＋全プロジェクト検索。正規表現対応 |
| C-5 | インライン AI コマンド | `/continue`, `/rewrite` 等。Diff 表示 + Accept/Reject UI |
| C-6 | 分割エディタ | Ctrl+\ で右分割、Ctrl+Shift+\ で下分割 |

### Phase D: Chat パネル強化

**前提:** Phase B（セッションのシーン紐付け）、Phase C（インラインAIとの連携）。
**設計書:** `Grimodex_Chatパネル設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| D-1 | セッション管理 UI | セッション一覧ドロワー。作成・削除・リネーム・切替 |
| D-2 | セッション自動タイトル | 軽量モデルで 3-6 語のタイトル自動生成 |
| D-3 | コンテキストバー | ピル表示（Project / Scene / Codex / Snippets）。トークン数内訳 |
| D-4 | `/` コマンド | `/continue`, `/describe`, `/dialogue`, `/summarize` 等をシステムプロンプトに注入 |
| D-5 | モデルセレクタ | 入力エリア内のモデル選択 UI |
| D-6 | Chapter summary コンテキスト | Layer 2: スライディングウィンドウで章サマリーを注入 |
| D-7 | メッセージアクション拡充 | Regenerate / Edit / Delete |
| D-8 | AI/Manual 抽出モード | 抽出時のモード切替 UI |

### Phase E: Codex パネル強化

**前提:** Phase A（Left Dock に配置）、Phase B（シーンとの連携）。
**設計書:** `Grimodex_Codexパネル設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| E-1 | Context Mode UI | always/mentioned/suppress/hidden をエントリ編集画面に追加 |
| E-2 | Aliases / Excluded Aliases UI | 一覧表示・追加・削除 |
| E-3 | カスタム詳細フィールド UI | codex_detail_definitions に基づくフォーム生成（text/dropdown/codex_reference） |
| E-4 | リレーション UI | 親子ツリー表示。追加・削除。却下済み関係の管理 |
| E-5 | アイコン画像管理 | WebP アップロード、プレビュー |
| E-6 | ソートオプション | 名前、タイプ、作成日、更新日 |

### Phase F: Snippets パネル強化

**前提:** Phase A（Bottom Dock に配置）。
**設計書:** `Grimodex_Snippetsパネル設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| F-1 | フィルタバー | ソース（All/Chat/Editor/Manual）、タグ、ソート（Recent/Title/Most used） |
| F-2 | ソースバッジ強化 | [AI] / [Human] バッジの一貫した表示 |
| F-3 | 使用回数表示 | usage_count をカード上に表示 |
| F-4 | クリップボード貼り付け作成 | Ctrl+V でスニペットパネルに直接保存 |

### Phase G: Attribution パネル強化

**前提:** Phase A（Bottom Dock に配置）、Phase B（スコープ選択の階層情報）。
**設計書:** `Grimodex_Attributionパネル設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| G-1 | スコープセレクタ | Project / Part / Chapter / Scene ドロップダウン |
| G-2 | サマリカード | 総文字数、各ソース文字数＋パーセンテージ |
| G-3 | ブレークダウンバー | 積み上げ水平バー（Human/AI/Unknown） |
| G-4 | シーン別テーブル | ミニ棒グラフ付きテーブル |
| G-5 | モデル別使用量 | モデルごとの文字数・割合 |
| G-6 | フィルタモード | カードクリックでエディタ内の該当ソースをハイライト |
| G-7 | エクスポート（Markdown / CSV） | レポート出力 |

### Phase H: Chat History パネル

**前提:** Phase A（Left Dock に配置）、Phase D（セッション管理）。
**設計書:** `Grimodex_ChatHistoryパネル設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| H-1 | ChatHistory コンポーネント作成 | セッション一覧（シーン別グループ） |
| H-2 | FTS5 メッセージ検索 | chat_messages_fts を使った全文検索 |
| H-3 | フィルタ UI | シーン選択、抽出有無トグル、プロジェクトスコープ |
| H-4 | セッションカード | タイトル、日時、プレビュー、メッセージ数/抽出数バッジ |
| H-5 | 検索結果モード | メッセージスニペット表示。クリックで ChatPanel へ遷移 |

### Phase I: Settings パネル完成

**前提:** Phase A（フローティング表示）。
**設計書:** `Grimodex_Settingsパネル設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| I-1 | Settings ダイアログ構造 | 左サイドバー＋右コンテンツの 2 カラムレイアウト |
| I-2 | プロジェクト設定 | タイトル、ジャンル、POV、テンス、言語、スタイルガイド、AI指示 |
| I-3 | エディタ設定 | フォント、サイズ、行高、段落間隔、タイプライターモード、自動保存間隔 |
| I-4 | 表示設定 | テーマ（Light/Dark/System）、UIスケール、Codexハイライトスタイル |
| I-5 | キーバインド設定 | キーバインドテーブル。リバインド。コンフリクト警告 |
| I-6 | データ管理 | バックアップ設定、エクスポート、FTSリビルド、DB圧縮 |

---

## 4. 依存関係グラフ

```
Phase A (レイアウト基盤)
├── Phase B (Scenes 強化)
│   ├── Phase C (Editor 強化)
│   │   └── Phase D (Chat 強化) ──→ Phase H (Chat History)
│   ├── Phase E (Codex 強化)
│   └── Phase G (Attribution 強化)
├── Phase F (Snippets 強化)
└── Phase I (Settings 完成)
```

**クリティカルパス:** A → B → C → D → H

**並行可能:**
- Phase E, F, G は Phase A/B 完了後に並行着手可能
- Phase I は Phase A 完了後いつでも着手可能

---

## 5. 各フェーズの主要成果物

| Phase | 新規コンポーネント | 新規/改修ストア | 新規テスト |
|-------|-------------------|----------------|-----------|
| A | ActivityBar, DockZone, BottomDock | layoutStore | レイアウト状態、永続化 |
| B | TreeView, NodeCreateMenu, StatusDot, CodexQuick | sceneStore 改修 | D&D、ステータス遷移 |
| C | TabBar, EditorGroup, StatusBar, FindReplace, InlineAI | editorStore 改修 | マルチタブ、Find&Replace |
| D | SessionDrawer, ContextBar, ModelSelector, CommandInput | chatStore 改修 | セッション管理、コマンド |
| E | ContextModeSelect, DetailFieldForm, RelationTree | codexStore 改修 | カスタムフィールド、リレーション |
| F | FilterBar（Snippets 用） | snippetStore 改修 | フィルタ、使用回数 |
| G | ScopeSelector, BreakdownBar, SceneTable, ModelUsage | attributionStore 改修 | スコープ集計、エクスポート |
| H | ChatHistoryPanel, SessionCard, SearchResult | （chatStore 共用） | 検索、フィルタ |
| I | SettingsDialog（フル版）, KeybindTable | settingsStore 新規 | 設定の保存・復元 |

---

## 6. テスト戦略

各フェーズで以下のテストを追加する:

1. **ストアテスト** — 状態遷移、エッジケース（Vitest）
2. **API テスト** — Tauri invoke モック経由のデータフロー（Vitest）
3. **コンポーネントテスト** — ユーザー操作シナリオ（Testing Library）
4. **結合テスト** — パネル間のデータ連携（ストア→コンポーネント）

既存の 389 テストがリグレッション防止の基盤として機能する。

---

## 7. 備考

- **スキーマ追加は不要** — 全テーブル・カラムが統合DBスキーマに定義済み。UI がスキーマに追いつく形。
- **Tauri コマンド追加** — Phase B（ツリー操作）、Phase I（設定管理）で若干の追加が必要な可能性あり。既存の `db_execute` で大半はカバー可能。
- **Post-MVP** — フローティングウィンドウ、D&Dパネル移動、コラボレーション、モバイル対応は本ワークフローのスコープ外。
