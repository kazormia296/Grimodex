# Grimodex 実装ワークフロー

> 作成日: 2026-04-02
> 更新日: 2026-04-03
> 基準: docs/ 配下の全設計書 + SPEC.md Phase 1-6

本文書は、設計書（docs/）の仕様と現在の実装状態を比較し、
残りの実装タスクを依存関係順に整理したワークフローである。

---

## 1. 現状サマリ

### 1.1 実装済み（設計書準拠）

| レイヤー | 状態 | 詳細 |
|---------|------|------|
| **統合DBスキーマ** | **完了** | 17テーブル + FTS5 3テーブル + トリガー。設計書と完全一致 |
| **Drizzle ORM定義** | **完了** | `src/db/schema.ts` — 全テーブル定義済み |
| **スキーマテスト** | **完了** | `src/db/schema.test.ts` — 制約・FTS5同期・帰属CHECK・CASCADE検証 |

### 1.2 実装済み（設計書との乖離あり）

以下のレイヤーは基本的な構造は実装済みだが、設計書が更新されたため
仕様との差分が存在する。セクション2のギャップ分析を参照のこと。

| レイヤー | 状態 | 詳細 |
|---------|------|------|
| **Tauriコマンド (Backend)** | **要更新** | 20コマンド実装済み。リビジョン履歴・AIエージェント用コマンドが未実装 |
| **API関数 (Frontend)** | **要更新** | 50以上の関数実装済み。新規設計書の機能に対応するAPI未実装 |
| **Zustandストア** | **要更新** | 10ストア実装済み。Synopsis・リビジョン・レイアウト等のストア未実装 |
| **Reactコンポーネント** | **要更新** | 28コンポーネント実装済み。各パネルの詳細UIが設計書未到達 |
| **テストスイート** | **部分的** | 41ファイル。スキーマテストは準拠済み、他はロジック層のテスト |

### 1.3 SPEC.md Phase 対応状況

| Phase | 名称 | 状態 |
|-------|------|------|
| Phase 1 | 基盤 | **データ層完了** — DB・ORM・ストア基盤あり。UIは簡易版 |
| Phase 2 | AIチャット | **データ層完了** — ストリーミング・コンテキスト基盤あり。UI詳細未到達 |
| Phase 3 | Codex | **データ層完了** — CRUD・FTS5・マッチング基盤あり。UI詳細未到達 |
| Phase 4 | 抽出と統合 | **データ層完了** — 抽出・帰属基盤あり。UI詳細未到達 |
| Phase 5 | 帰属追跡と仕上げ | **部分的** — Mark拡張・オーバーレイ済み。レポートUI未実装 |
| Phase 6 | パフォーマンスと品質 | **部分的** — FTS最適化・仮想化リスト済み。UIの磨き上げが残存 |

### 1.4 結論

**データ層（DBスキーマ・テスト）は設計書に完全準拠。**
ロジック層（Tauriコマンド・API・ストア）は基本構造があるが新仕様に未対応。
UI層は簡易版のみで、各パネル設計書の詳細仕様・レイアウトシステム・
リビジョン履歴・AIエージェントの実装が主要な残タスクである。

---

## 2. 設計書 vs 実装 ギャップ分析

以下、各設計書ごとに「実装済み」「未実装」を整理する。
**★ マークは前回ワークフロー（04/02）以降に設計書が更新された項目。**

### 2.1 レイアウトシステム設計書

**現状:** `App.tsx` で固定3ペインレイアウト（Sidebar | Editor | RightPanel）。
`ResizablePanelGroup` によるリサイズのみ対応。

| 仕様項目 | 状態 |
|---------|------|
| Activity Bar（アイコン＋インジケータドット） | 未実装 |
| Left Dock（タブ切替、折りたたみ） | 未実装 — Sidebar は Scenes 固定 |
| Center（Editor Groups、分割） | 未実装 — 単一エディタのみ |
| Right Dock（タブ切替、折りたたみ） | **部分的** — RightPanel に 4 タブあり（Chat/Codex/Snippets/Attribution）。折りたたみ・Dock状態管理なし |
| Bottom Dock（Snippets, Attribution） | 未実装 — RightPanel タブに統合中 |
| フローティングウィンドウ | 未実装 |
| パネル状態管理（Closed/Docked/Collapsed/Floating） | 未実装 |
| レイアウト永続化（settings テーブル）★ 保存先が layout.json → settings テーブルに変更 | 未実装 |
| キーボードショートカット（Ctrl+Alt+S/C/X 等） | 未実装 |
| D&D によるパネル移動 | 未実装 |

### 2.2 Scenes パネル設計書

**現状:** `Sidebar.tsx` — フラットなシーンリスト、作成・削除・リネーム。

| 仕様項目 | 状態 |
|---------|------|
| 基本的なシーン一覧表示 | **実装済み** |
| シーン作成・削除・リネーム | **実装済み** |
| Part/Chapter/Scene/Folder/Note 階層ツリー | 未実装 — フラットリスト |
| D&D 並び替え（fractional indexing） | 未実装 |
| ステータスドット（Outline/Draft/Complete/Revision/Final） | 未実装 |
| 文字数表示 | 未実装 |
| AI帰属バッジ | 未実装 |
| フィルタ入力（インクリメンタル検索） | 未実装 |
| ツールバー（作成メニュー、展開/折りたたみ） | 未実装 |
| コンテキストメニュー | 未実装 |
| ★ Synopsis フィールド（シーン概要テキスト） | 未実装 |
| ★ AI Synopsis 生成ボタン（✦ Generate） | 未実装 |
| ★ ステータス遷移時の自動生成提案 | 未実装 |
| ★ storySoFar カバレッジ警告ピル | 未実装 |
| ★ Outline ビューモード（Synopsis インライン表示） | 未実装 |
| Codex Quick セクション | 未実装 |
| マルチセレクト D&D（Ctrl+Click, Shift+Click） | 未実装 |
| キーボードナビゲーション（矢印キー、F2リネーム等） | 未実装 |

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
| ★ Toolbar追加: 傍点・インラインコメント・段落インデント | 未実装 |
| マルチタブ（Editor Group モデル） | 未実装 |
| タブバー（プレビュー/固定、パンくず） | 未実装 |
| 分割エディタ（水平・垂直） | 未実装 |
| インライン AI コマンド（/continue, /rewrite 等） | 未実装 |
| Diff 表示（Accept/Reject） | 未実装 |
| Find & Replace | 未実装 |
| ステータスバー（文字数、AI率、カーソル位置） | 未実装 |
| コンテキストメニュー（Add to Codex 等） | 未実装 |
| キーボードショートカット一式 | 部分的 — 基本的な書式ショートカットのみ。Find&Replace・分割・パネル操作系なし |
| ★ Synopsis ヘッダーエリア（折りたたみ式） | 未実装 |
| ★ Codex/Snippet エディタタブ（AI対応） | 未実装 |

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
| ヘッダー（シーンインジケータ） | 部分的 — シーン名表示あり。ドロップダウン切替・Sessions/+ボタンなし |
| ★ 🌐 Global Chat トグル | 未実装 |
| ★ 🔧 Agent Mode トグル | 未実装 |
| コンテキストバー（視覚的ピル表示） | 未実装 |
| ★ コンテキストモード反映（always/mentioned/suppress/hidden） | 未実装 |
| ★ 子エントリ自動注入（BFS、サブツリー予算） | 未実装 |
| セッション一覧 UI（切替・管理） | 未実装 |
| セッション自動タイトル生成 | 未実装 |
| `/` コマンド（continue, describe 等） | 未実装 |
| ★ `@` メンション補完（Codexエントリ検索） | 未実装 |
| モデルセレクタ（入力エリア内） | 未実装 |
| メッセージアクション（Regenerate/Edit/Delete） | 部分的 — 挿入・抽出ボタンあり。Regenerate/Edit/Delete なし |
| ★ テキスト選択ツールバー（部分挿入・抽出） | 未実装 |
| ★ Layer 2: storySoFar（前シーンSynopsis注入） | 未実装 |
| ★ Layer 5: Progressive Summarization | 未実装 |
| ★ プロンプトプレビューモーダル | 未実装 |
| ★ AI/Manual 抽出モード切替 | 未実装 |
| ★ 入力エリア TipTap Mini（リッチテキスト、Markdownライブレンダー） | 未実装 |
| エラーハンドリング（401認証/429レート制限/ネットワーク障害/ストリーム中断） | 未実装 |
| Chapter summary コンテキスト（Layer 2） | 未実装 |

### 2.5 AIエージェント設計書 ★ 新規

**現状:** 未実装。設計書は 04/02 以降に追加。

| 仕様項目 | 状態 |
|---------|------|
| Agent Mode トグル UI（🔧） | 未実装 |
| Agent Mode システムプロンプト（ツール定義注入） | 未実装 |
| ツール実行フレームワーク（Tauri Backend） | 未実装 |
| 16+ ツール定義（search_codex, get_scene 等） | 未実装 |
| ツール呼び出し上限（10回/メッセージ） | 未実装 |
| トークン予算管理（コンテキスト上限の30%、最小2,000トークン） | 未実装 |
| ツール呼び出し可視化（折りたたみブロック） | 未実装 |
| Context Creator UI（✦ AI ボタン） | 未実装 |
| Context Creator 検索フロー（軽量LLM） | 未実装 |
| プレビューチェックボックス＋一括ピン追加 | 未実装 |
| モデル互換性チェック（supportsToolUse） | 未実装 |
| ツール呼び出し履歴の永続化（metadata） | 未実装 |

### 2.6 リビジョン履歴設計書 ★ 新規

**現状:** `content_versions` テーブルはスキーマ定義・テスト済み。UI・Tauriコマンドは未実装。

| 仕様項目 | 状態 |
|---------|------|
| 自動リビジョン作成（5分間隔、設定可能） | 未実装 |
| 手動リビジョン作成（Ctrl+S） | 未実装 |
| リビジョンプルーニング（デフォルト50件保持） | 未実装 |
| リビジョン履歴モーダル（2カラムレイアウト） | 未実装 |
| コンテンツプレビュー（読み取り専用TipTap） | 未実装 |
| リビジョンタイムライン（auto/manual区別） | 未実装 |
| Diff 表示（diff-match-patch、追加/削除ハイライト） | 未実装 |
| リストア機能（安全スナップショット自動作成） | 未実装 |
| マスタースナップショット（プロジェクト全体） | 未実装 |
| マスタースナップショット作成ダイアログ | 未実装 |
| マスタースナップショット一覧・復元・削除 | 未実装 |
| Tauriコマンド（9コマンド: list/get/create/restore/prune + project snapshot CRUD） | 未実装 |
| revisionHistoryStore（Zustand） | 未実装 |
| キーボードショートカット（Ctrl+S, Ctrl+Shift+H, Ctrl+Alt+S） | 未実装 |
| ページネーション（20件ずつロード） | 未実装 |

### 2.7 Codex パネル設計書

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

### 2.8 Snippets パネル設計書

**現状:** `SnippetPanel.tsx` — 検索、分割ビュー、D&D、コピー。

| 仕様項目 | 状態 |
|---------|------|
| CRUD | **実装済み** |
| 検索（デバウンス） | **実装済み** |
| 分割ビュー（リスト＋詳細） | **実装済み** |
| D&D でエディタへ挿入 | **実装済み** |
| クリップボードコピー（帰属メタデータ付き） | **実装済み** |
| ソースバッジ（[AI]/[Human]） | 部分的 — バッジ表示あり。source値に基づく一貫した色分け・アイコンなし |
| フィルタバー（ソース、タグ、ソート） | 未実装 |
| 使用回数カウント表示 | 未実装（スキーマは対応済み） |
| タグクラウド UI | 未実装 |
| クリップボード貼り付けで Snippet 作成 | 未実装 |
| インライン展開（全画面編集） | 未実装 |

### 2.9 Attribution パネル設計書

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

### 2.10 Chat History パネル設計書

**現状:** 未実装。Chat History パネルは存在しない。

| 仕様項目 | 状態 |
|---------|------|
| セッション一覧（シーン別グループ） | 未実装 |
| FTS5 メッセージ検索 | 未実装 |
| フィルタ（シーン、抽出有無、プロジェクトスコープ） | 未実装 |
| セッションカード（タイトル、メッセージ数、抽出数） | 未実装 |
| 検索結果モード（メッセージスニペット表示） | 未実装 |
| Codex/Snippet バッジポップオーバー | 未実装 |

### 2.11 Settings パネル設計書

**現状:** `AiSettingsDialog.tsx` — AI 設定（プロバイダー、APIキー、モデル選択）のみ。

| 仕様項目 | 状態 |
|---------|------|
| AI プロバイダー設定 | **実装済み** |
| API キー管理（Keyring） | **実装済み** |
| モデル選択 | **実装済み** |
| 接続テスト | **実装済み** |
| プロジェクト設定（タイトル、ジャンル、POV 等） | 未実装（スキーマは対応済み） |
| エディタ設定（フォント、行高、自動保存間隔等） | 未実装 |
| 表示設定（テーマ、UIスケール、Codexハイライト等） | 未実装 |
| キーバインド設定 | 未実装 |
| データ管理（バックアップ、エクスポート、メンテナンス） | 部分的（IntegrityCheckDialog あり） |
| ★ リビジョン設定（自動リビジョン間隔、保持件数） | 未実装 |
| ★ Synopsis 自動提案設定 | 未実装 |

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
| A-7 | レイアウト永続化 | settings テーブルに保存・復元 |

**後回し（Post-MVP）:** フローティングウィンドウ、D&D パネル移動

### Phase B: Scenes パネル強化

**前提:** ツリー構造はエディタ・チャット・Attribution の基盤。
**設計書:** `Grimodex_Scenesパネル設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| B-1 | 階層ツリー表示 | tree_nodes の parent_id/node_type に基づく Part > Chapter > Scene / Folder > Note ツリー |
| B-2 | ノードタイプ別 CRUD | Part/Chapter/Scene/Folder/Note それぞれの作成 UI（ドロップダウンメニュー） |
| B-3 | D&D 並び替え | fractional indexing（sort_order）を使ったドラッグ＆ドロップ。@dnd-kit/core + sortable。ノードタイプ制約の検証 |
| B-4 | ステータスドット | Scene にステータス表示（Outline/Draft/Complete/Revision/Final）。クリックで変更 |
| B-5 | 文字数・AI率バッジ | 各ノードの文字数と AI 帰属率を表示（オプション） |
| B-6 | フィルタ入力 | インクリメンタル検索。祖先パス表示 |
| B-7 | ★ Synopsis フィールド | シーン選択時に Synopsis エディタ表示。プレースホルダー「What happens in this scene?」 |
| B-8 | ★ AI Synopsis 生成 | ✦ Generate ボタン。軽量モデルでシーン内容からSynopsis自動生成。既存Synopsis上書き確認。**AI設定（プロバイダー・APIキー）が前提** |
| B-9 | ★ Synopsis 自動提案 | ステータス遷移（Complete/Revision/Final）時にSynopsis未記入なら Toast で生成提案 |
| B-10 | ★ storySoFar カバレッジ | 前シーンの Synopsis 充填率を表示。< 50% で警告ピル。「Generate all」ポップオーバー |
| B-11 | ★ Outline ビューモード | ツリー/Outline 切替。Outline モードで Synopsis をタイトル下にインライン表示 |
| B-12 | Codex Quick セクション | アクティブシーンの Codex エントリ一覧。ピン留め対応 |
| B-13 | コンテキストメニュー | シーン/チャプター/パート/フォルダ/ノート別の右クリックメニュー |
| B-14 | キーボードナビゲーション | 矢印キー、Enter/Space、F2リネーム、Delete、Ctrl+F |

### Phase C: Editor パネル強化

**前提:** Phase B 完了（階層ツリーからの複数シーン操作が必要）。
**設計書:** `Grimodex_Editorパネル設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| C-1 | マルチタブ基盤 | Editor Group モデル。タブバー（プレビュー/固定状態）、パンくず表示 |
| C-2 | ★ Toolbar 拡張 | 傍点（emphasis dots）、インラインコメント、段落インデントボタン追加 |
| C-3 | ステータスバー | 文字数、AI帰属率、カーソル位置、シーンステータス、保存状態 |
| C-4 | ★ Synopsis ヘッダー | Editor 上部に折りたたみ式 Synopsis エディタ。AI 生成ボタン付き |
| C-5 | ★ Codex/Snippet エディタタブ | Codex エントリや Snippet をエディタタブとして開く。AI補助対応 |
| C-6 | コンテキストメニュー | 右クリック：Add to Codex / Save as Snippet / Look up in Chat / 書式設定 |
| C-7 | Find & Replace | Ctrl+F/H。単一シーン＋全プロジェクト検索。正規表現対応 |
| C-8 | インライン AI コマンド | `/continue`, `/rewrite` 等。Diff 表示 + Accept/Reject UI |
| C-9 | 分割エディタ | Ctrl+\ で右分割、Ctrl+Shift+\ で下分割 |

### Phase D: Chat パネル強化

**前提:** Phase B 完了（セッションのシーン紐付け、Synopsis/storySoFar データ）。
Phase C との依存は C-8（インラインAI）連携部分のみで、大半のタスクは B 完了後に着手可能。
**設計書:** `Grimodex_Chatパネル設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| D-1 | セッション管理 UI | セッション一覧サイドシート。作成・削除・リネーム・切替 |
| D-2 | セッション自動タイトル | 軽量モデルで 3-6 語のタイトル自動生成。手動編集後は再生成抑止 |
| D-3 | ★ Global Chat トグル | 🌐 ボタンでプロジェクトスコープチャット。node_id=NULL のセッション |
| D-4 | コンテキストバー | ピル表示（Project / Scene / Codex / Snippets）。トークン数内訳 |
| D-5 | ★ コンテキストモード反映 | always/mentioned/suppress/hidden のフィルタリングをコンテキスト構築に適用 |
| D-6 | ★ 子エントリ自動注入 | ピン済みエントリの子をBFS順で注入。サブツリー予算800トークン/親 |
| D-7 | ★ Layer 2: storySoFar | 前シーンの Synopsis をスライディングウィンドウで注入。予算内でカット |
| D-8 | ★ Layer 5: Progressive Summarization | 8往復超の古いメッセージを要約。⭐マーク付きは除外 |
| D-9 | `/` コマンド | `/continue`, `/describe`, `/dialogue`, `/summarize` 等をシステムプロンプトに注入 |
| D-10 | ★ `@` メンション補完 | 入力中の @ でCodexエントリ検索ポップアップ。hidden除外 |
| D-11 | モデルセレクタ | 入力エリア内のモデル選択 UI。セッション単位で上書き可能 |
| D-12 | メッセージアクション拡充 | Regenerate / Edit / Delete。Edit は入力エリアに復元 |
| D-13 | ★ テキスト選択ツールバー | メッセージ内テキスト選択時のフローティングツールバー（部分挿入・抽出・コピー） |
| D-14 | ★ AI/Manual 抽出モード | Codex 抽出時の AI自動解析 / 手動入力 モード切替 |
| D-15 | ★ プロンプトプレビュー | コンテキストバーからモーダルを開き、全レイヤーの内容とトークン数を確認 |
| D-16 | ★ 入力エリア TipTap Mini | リッチテキスト入力（Bold/Italic/Code/List）。Markdownライブレンダー。Auto-height（5行まで） |
| D-17 | エラーハンドリング | 401→Settings誘導、429→自動リトライ、ネットワーク→3回リトライ、ストリーム中断→受信テキスト保持 |
| D-18 | ★ Context Creator | ✦ AI ボタン → 指示入力 → 軽量LLMがツールで検索 → プレビュー → 一括ピン追加（Agent Mode 不要で動作） |

### Phase E: AIエージェント ★ 新規

**前提:** Phase D 完了（Chat パネルのセッション管理・コンテキスト構築が基盤）。
E-2 の Tauri Backend ツール実装は Phase D と並行着手可能。
**設計書:** `Grimodex_AIエージェント設計書.md`
**備考:** Context Creator（✦ AI ボタン）は Agent Mode と独立した機能のため Phase D-18 に配置。

| # | タスク | 概要 |
|---|--------|------|
| E-1 | Agent Mode トグル | 🔧 ボタン。Tool Use 対応モデルのみ有効化。非対応モデルはツールチップで説明 |
| E-2 | ツール定義・実行基盤 | Tauri Backend にツール実行ハンドラ。16+ ツール（search_codex, get_scene 等）。**Phase D と並行着手可能** |
| E-3 | Agent システムプロンプト | Agent Mode ON 時にツール定義を注入。Layer 4（自動Codex注入）を無効化 |
| E-4 | ツール呼び出し可視化 | AI メッセージ内に折りたたみブロックでツール名・パラメータ・結果を表示 |
| E-5 | 呼び出し制限 | 10回/メッセージ上限。超過時はシステムメッセージ挿入 |
| E-6 | トークン予算管理 | モデルコンテキスト上限の30%（最小2,000トークン）。超過時はツール呼び出し拒否＋システムメッセージ挿入 |
| E-7 | ツール呼び出し履歴 | chat_messages.metadata にパラメータ・結果サマリ・トークン数を永続化 |

### Phase F: リビジョン履歴 ★ 新規

**前提:** スキーマは実装済み。F-1〜F-4（バックエンド・ストア・自動/手動リビジョン）は **依存なしで即着手可能**。
F-5〜F-9（履歴モーダルUI・⏱ボタン）は Phase C のステータスバー実装後。
**設計書:** `Grimodex_リビジョン履歴設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| F-1 | Tauriコマンド追加 | 9コマンド: list/get/create/restore/prune_content_versions + create/list/restore/delete_project_snapshots |
| F-2 | revisionHistoryStore | モーダル状態、リビジョンリスト、選択、ページネーション管理 |
| F-3 | 自動リビジョン作成 | 5分間隔（設定可能）でコンテンツ差分検出時にスナップショット作成 |
| F-4 | 手動リビジョン（Ctrl+S） | 即時リビジョン作成。間隔無視 |
| F-5 | リビジョン履歴モーダル | 左: 読み取り専用TipTapプレビュー、右: リビジョンタイムライン。20件ずつページネーション |
| F-6 | Diff 表示 | diff-match-patch による差分ハイライト（追加=緑、削除=赤取消線）。Show changes トグル |
| F-7 | リストア機能 | 確認ダイアログ → 現状を安全スナップショットとして保存 → コンテンツ上書き → Toast通知 |
| F-8 | プルーニング | デフォルト50件保持。auto優先削除。マスタースナップショット参照分は保護 |
| F-9 | マスタースナップショット | Ctrl+Alt+S で作成ダイアログ。全エンティティの手動リビジョンを記録。一覧・復元・削除UI |

### Phase G: Codex パネル強化

**前提:** Phase A（Left Dock に配置）、Phase B（シーンとの連携）。
**設計書:** `Grimodex_Codexパネル設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| G-1 | Context Mode UI | always/mentioned/suppress/hidden をエントリ編集画面に追加 |
| G-2 | Aliases / Excluded Aliases UI | 一覧表示・追加・削除 |
| G-3 | カスタム詳細フィールド UI | codex_detail_definitions に基づくフォーム生成（text/dropdown/codex_reference） |
| G-4 | リレーション UI | 親子ツリー表示。追加・削除。却下済み関係の管理 |
| G-5 | アイコン画像管理 | WebP アップロード、プレビュー |
| G-6 | ソートオプション | 名前、タイプ、作成日、更新日、参照頻度 |

### Phase H: Snippets パネル強化

**前提:** Phase A（Bottom Dock に配置）。
**設計書:** `Grimodex_Snippetsパネル設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| H-1 | フィルタバー | ソース（All/Chat/Editor/Manual）、タグ、ソート（Recent/Title/Most used） |
| H-2 | ソースバッジ強化 | [AI] / [Human] バッジの一貫した表示 |
| H-3 | 使用回数表示 | usage_count をカード上に表示 |
| H-4 | クリップボード貼り付け作成 | Ctrl+V でスニペットパネルに直接保存 |

### Phase I: Attribution パネル強化

**前提:** Phase A（Bottom Dock に配置）、Phase B（スコープ選択の階層情報）。
**設計書:** `Grimodex_Attributionパネル設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| I-1 | スコープセレクタ | Project / Part / Chapter / Scene ドロップダウン |
| I-2 | サマリカード | 総文字数、各ソース文字数＋パーセンテージ |
| I-3 | ブレークダウンバー | 積み上げ水平バー（Human/AI/Unknown） |
| I-4 | シーン別テーブル | ミニ棒グラフ付きテーブル |
| I-5 | モデル別使用量 | モデルごとの文字数・割合 |
| I-6 | フィルタモード | カードクリックでエディタ内の該当ソースをハイライト |
| I-7 | エクスポート（Markdown / CSV） | レポート出力 |

### Phase J: Chat History パネル

**前提:** Phase A（Left Dock に配置）、Phase D（セッション管理）。
**設計書:** `Grimodex_ChatHistoryパネル設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| J-1 | ChatHistory コンポーネント作成 | セッション一覧（シーン別グループ） |
| J-2 | FTS5 メッセージ検索 | chat_messages_fts を使った全文検索 |
| J-3 | フィルタ UI | シーン選択、抽出有無トグル、プロジェクトスコープ |
| J-4 | セッションカード | タイトル、日時、プレビュー、メッセージ数/抽出数バッジ |
| J-5 | 検索結果モード | メッセージスニペット表示。クリックで ChatPanel へ遷移 |

### Phase K: Settings パネル完成

**前提:** Phase A（フローティング表示）。
**設計書:** `Grimodex_Settingsパネル設計書.md`

| # | タスク | 概要 |
|---|--------|------|
| K-1 | Settings ダイアログ構造 | 左サイドバー＋右コンテンツの 2 カラムレイアウト |
| K-2 | プロジェクト設定 | タイトル、ジャンル、POV、テンス、言語、スタイルガイド、AI指示 |
| K-3 | エディタ設定 | フォント、サイズ、行高、段落間隔、タイプライターモード、自動保存間隔 |
| K-4 | 表示設定 | テーマ（Light/Dark/System）、UIスケール、Codexハイライトスタイル |
| K-5 | キーバインド設定 | キーバインドテーブル。リバインド。コンフリクト警告 |
| K-6 | データ管理 | バックアップ設定、エクスポート、FTSリビルド、DB圧縮 |
| K-7 | ★ リビジョン設定 | 自動リビジョン間隔（1-60分）、保持件数（10-200件） |
| K-8 | ★ Synopsis 設定 | Auto-suggest synopsis トグル（デフォルトON） |

---

## 4. 依存関係グラフ

```
Phase A (レイアウト基盤)
├── Phase B (Scenes 強化: Synopsis/storySoFar 含む)
│   ├── Phase C (Editor 強化: Toolbar拡張/Synopsis ヘッダー含む)
│   │   └── Phase F-UI (リビジョン履歴 モーダルUI: F-5〜F-9)
│   ├── Phase D (Chat 強化: B完了後に着手可能、C非依存)
│   │   ├── Phase E (AIエージェント: E-2はD並行可)
│   │   └── Phase J (Chat History)
│   ├── Phase G (Codex 強化)
│   └── Phase I (Attribution 強化)
├── Phase F-backend (リビジョン バックエンド: F-1〜F-4、依存なし)
├── Phase H (Snippets 強化)
└── Phase K (Settings 完成)
```

**クリティカルパス:** A → B → D → E

**並行可能:**
- Phase C と Phase D は Phase B 完了後に **並行着手可能**
- Phase F-backend（F-1〜F-4）は **即着手可能**（他フェーズ非依存）
- Phase F-UI（F-5〜F-9）は Phase C 完了後
- Phase E-2（Tauri ツール実装）は Phase D と **並行着手可能**
- Phase G, H, I は Phase A/B 完了後に並行着手可能
- Phase J は Phase D 完了後に着手可能（E と並行可）
- Phase K は Phase A 完了後いつでも着手可能

---

## 5. 各フェーズの主要成果物

| Phase | 新規コンポーネント | 新規/改修ストア | 新規テスト |
|-------|-------------------|----------------|-----------|
| A | ActivityBar, DockZone, BottomDock | layoutStore | レイアウト状態、永続化 |
| B | TreeView, NodeCreateMenu, StatusDot, SynopsisEditor, CodexQuick, OutlineView | sceneStore 改修 | D&D、ステータス遷移、Synopsis生成 |
| C | TabBar, EditorGroup, StatusBar, FindReplace, InlineAI, SynopsisHeader | editorStore 改修 | マルチタブ、Find&Replace |
| D | SessionDrawer, ContextBar, ModelSelector, CommandInput, MentionPopup, PromptPreview, ContextCreator | chatStore 改修 | セッション管理、コンテキスト層、コマンド、Context Creator |
| E | AgentToggle, ToolCallBlock | agentStore 新規 | ツール実行、予算管理 |
| F | RevisionHistoryModal, DiffView, SnapshotDialog, SnapshotList | revisionHistoryStore 新規 | リビジョンCRUD、Diff、リストア |
| G | ContextModeSelect, DetailFieldForm, RelationTree | codexStore 改修 | カスタムフィールド、リレーション |
| H | FilterBar（Snippets 用） | snippetStore 改修 | フィルタ、使用回数 |
| I | ScopeSelector, BreakdownBar, SceneTable, ModelUsage | attributionStore 改修 | スコープ集計、エクスポート |
| J | ChatHistoryPanel, SessionCard, SearchResult | （chatStore 共用） | 検索、フィルタ |
| K | SettingsDialog（フル版）, KeybindTable | settingsStore 新規 | 設定の保存・復元 |

---

## 6. Tauriコマンド追加見込み

| Phase | コマンド | 概要 |
|-------|---------|------|
| B | （既存 db_execute でカバー可能） | ツリー操作は Drizzle ORM 経由 |
| D | （既存 send_chat_message 改修） | コンテキスト層の構築ロジック追加 |
| D | context_creator_search | Context Creator 用軽量ツール実行（E-2 のツール基盤を先行利用） |
| E | agent_execute_tool | ツール実行ハンドラ（16+ ツール分岐）。D-18 と共通基盤 |
| F | list_content_versions | リビジョンメタデータ取得（content除外） |
| F | get_content_version | 特定リビジョンのcontent付き取得 |
| F | create_content_snapshot | 手動スナップショット作成 |
| F | restore_content_version | リビジョン復元 |
| F | prune_content_versions | 古いリビジョンの削除 |
| F | create_project_snapshot | マスタースナップショット作成 |
| F | list_project_snapshots | マスタースナップショット一覧 |
| F | restore_project_snapshot | マスタースナップショット復元 |
| F | delete_project_snapshot | マスタースナップショット削除 |
| K | （既存 get/save_global_settings 拡張） | 新設定項目の追加 |

---

## 7. テスト戦略

各フェーズで以下のテストを追加する:

1. **ストアテスト** — 状態遷移、エッジケース（Vitest）
2. **API テスト** — Tauri invoke モック経由のデータフロー（Vitest）
3. **コンポーネントテスト** — ユーザー操作シナリオ（Testing Library）
4. **結合テスト** — パネル間のデータ連携（ストア→コンポーネント）

既存テストスイート（41ファイル）がリグレッション防止の基盤として機能する。
スキーマテストは設計書完全準拠済み。

---

## 8. 備考

- **スキーマ追加は不要** — 全テーブル・カラムが統合DBスキーマに定義済み。UI がスキーマに追いつく形。
- **Tauri コマンド追加** — Phase E（エージェントツール実行）、Phase F（リビジョン履歴 9コマンド）で大幅な追加が必要。
- **新規設計書** — AIエージェント設計書とリビジョン履歴設計書が 04/02 以降に追加。それぞれ Phase E, F として独立フェーズ化。
- **設計書更新** — Scenes（Synopsis/storySoFar）、Editor（Toolbar拡張）、Chat（Global Chat/コンテキスト戦略）の仕様が更新済み。各フェーズに ★ タスクとして反映。
- **Post-MVP** — フローティングウィンドウ、D&Dパネル移動、コラボレーション、モバイル対応は本ワークフローのスコープ外。
