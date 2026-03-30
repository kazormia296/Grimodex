# NoveLoom — AI統合小説執筆エディタ 開発ワークフロー

## 全体方針

Claude Codeをメイン開発ツールとし、5フェーズ・7スプリントでMVPを構築する。
各フェーズは「探索→計画→実装→検証」のサイクルで回し、フェーズ間では必ず `/clear` でコンテキストをリセットする。

**技術スタック**: Tauri v2 + React 19 + TypeScript + TipTap + SQLite + Drizzle ORM + Zustand + shadcn/ui + Vercel AI SDK

**開発環境**: Windows + Claude Code (Max 5x以上推奨)

**コア設計思想**: AIチャットが執筆体験の中心。チャットから生まれた知識（キャラクター設定、プロット断片、世界観メモ）をCodex/Snippetとして構造化し、再利用する。AIが書いた部分と人間が書いた部分は常に区別可能。

---

## 優先順位（変更後）

```
P0  Scaffold          — Tauri + React + TipTap の最小シェル
P1  Minimal Editor     — シーン編集・保存・ツリーナビゲーション
P2  AI Chat           — BYOK設定 + チャットパネル + ストリーミング ★最重要
P3  Codex + Extraction — チャットからCodex/Snippet抽出 ★最重要
P4  AI Attribution     — AI執筆 vs 人間執筆の追跡・可視化
P5  Japanese Features  — ルビ・縦書き・日本語FTS
```

---

## 1. プロジェクト初期構成

### 1.1 ディレクトリ構成

```
noveloom/
├── CLAUDE.md
├── CLAUDE.local.md
├── .claudeignore
├── .claude/
│   ├── settings.json
│   ├── settings.local.json
│   └── skills/
│       ├── explore-codebase/SKILL.md
│       ├── implement-feature/SKILL.md
│       ├── review-code/SKILL.md
│       ├── test-feature/SKILL.md
│       ├── debug-issue/SKILL.md
│       └── add-tauri-command/SKILL.md   # ★ Tauri IPC一括追加
├── docs/
│   ├── SPEC.md
│   ├── ARCHITECTURE.md
│   └── phases/
├── src-tauri/
│   ├── CLAUDE.md                        # ★ Rust固有規約
│   └── src/
├── src/
│   ├── CLAUDE.md                        # ★ React/TS固有規約
│   ├── components/
│   ├── features/
│   │   ├── editor/          # TipTapエディタ
│   │   ├── project/         # プロジェクト管理
│   │   ├── chat/            # AIチャットパネル ★
│   │   ├── codex/           # コデックス + 抽出 ★
│   │   ├── snippets/        # スニペット管理 ★
│   │   └── attribution/     # AI帰属追跡 ★
│   ├── stores/
│   ├── db/
│   └── lib/
└── active/
```

### 1.2 CLAUDE.md（更新版）

```markdown
# NoveLoom — AI統合小説執筆エディタ

## プロジェクト概要
Tauri v2 + React 19 + TypeScript。TipTapベースのリッチテキストエディタに
AIチャットパネルとCodex/Snippet抽出機能を組み合わせた小説執筆ツール。
**コア体験: AIとのチャットから知識を抽出し、構造化して執筆に活かす。**

## コマンド
- 開発サーバー: npm run tauri dev
- フロントのみ: npm run dev
- ビルド: npm run tauri build
- テスト: npm test
- テスト(単体): npm test -- --run [ファイルパス]
- Lint: npm run lint:fix
- 型チェック: npx tsc --noEmit
- Rustチェック: cd src-tauri && cargo check

## コード規約
- ES modules（import/export）、CommonJS禁止
- 2スペースインデント、TypeScript strictモード
- React: 関数コンポーネント + hooks のみ
- 状態管理: グローバル=Zustand、局所=Jotai
- DB操作: Drizzle ORM経由、生SQL禁止
- テスト: Vitest、ソースと同階層に *.test.ts
- コンポーネント: 1ファイル1コンポーネント、200行超えたら分割

## アーキテクチャ原則
- feature-based ディレクトリ構造（src/features/[name]/）
- Tauri Command経由でRust↔JSブリッジ
- SQLite WALモード、FTS5有効
- エディタ: シーンごとに独立TipTapインスタンス
- AIチャット: シーンごとに独立した会話履歴を保持
- 帰属追跡: テキスト挿入時にsource metadata（human/ai/ai-edited）を記録

## スキル発火条件
| トリガーワード | 発動スキル | 動作 |
|--------------|-----------|------|
| 「調べて」「調査」 | /explore-codebase | コード探索 |
| 「実装して」「作って」 | /implement-feature | 実装フロー |
| 「レビュー」 | /review-code | コードレビュー |
| 「テスト」 | /test-feature | テスト作成・実行 |
| 「デバッグ」「修正」 | /debug-issue | デバッグフロー |

## Compact時の保持事項
変更済みファイル一覧、テスト状態、現フェーズ・タスク番号、
アーキテクチャ決定事項（ARCHITECTURE.md参照）を必ず保持すること。

## コンテキスト圧迫時の行動規範
- コードを読まずに書かない
- 検証を省略しない
- 焦りを自覚したら「コンテキスト残量が少ないため区切ります」と宣言する
```

---

## 2. 開発フェーズ計画

### Phase 0: プロジェクト初期化（1日）

**目的**: Tauri v2 + React + TipTap の最小限のシェルを動かす

```
セッション1: プロジェクトスキャフォールド
────────────────────────────────────
「Tauri v2 + React 19 + TypeScript + Vite のプロジェクトを作成して。
 TipTap、shadcn/ui、Zustand、Jotaiもインストール。
 npm run tauri dev で空のウィンドウが表示されることを確認して。」
→ /clear

セッション2: 基盤設定
────────────────────────────────────
「Vitest、ESLint、Prettierを設定して。
 tsconfig.jsonをstrictモードに。
 src/features/ ディレクトリ構造を作成して。
 Drizzle ORMをsqlite-proxyモードでセットアップして。
 最小限のSQLiteスキーマ（projectsテーブルのみ）で
 Tauri Command経由のCRUDが動くことをテストで確認して。」
→ /clear
```

### Phase 1: ミニマルエディタ（Sprint 1、1–2週間）

**目的**: 「書ける」最小限を作る。AI Chat に早く進むため slim に保つ。

```
タスク1.1: TipTapエディタ + ツールバー
────────────────────────────────────
「src/features/editor/ にTipTapエディタを実装して。
 - StarterKit拡張を有効化
 - 文字数カウント表示
 - ツールバー（太字・斜体・見出し・リスト）
 - Markdown import/export（tiptap-markdown）
 エディタに文字を入力しMarkdownエクスポートできることをテスト。」
→ /clear

タスク1.2: シーン管理 + サイドバー
────────────────────────────────────
「シーン管理とサイドバーナビゲーションを実装して。
 - 各シーンは独立したTipTapドキュメントインスタンス
 - サイドバーにシーン一覧をツリー表示
 - シーンの作成・削除・名前変更・クリック切替
 - Zustand storeでプロジェクト構造を管理
 テスト: シーン作成→編集→切替→データ保持。」
→ /clear

タスク1.3: SQLite永続化 + 自動保存
────────────────────────────────────
「Drizzle ORMでスキーマを定義して。
 テーブル: projects, chapters, scenes
 本文はMarkdownファイル content/{scene-uuid}.md に保存。
 SQLite WALモード。自動保存（デバウンス2秒）。
 テスト: 作成→編集→再起動→データ復元。」
→ /clear
```

### Phase 2: AIチャット（Sprint 2–3、2–3週間）★最重要

**目的**: エディタの隣にAIチャットパネルを配置し、執筆のコア体験を作る。

```
タスク2.1: BYOK設定 + Vercel AI SDK基盤
────────────────────────────────────
「src/features/chat/ にAIチャットの基盤を実装して。
 - 設定画面: APIキー入力（OpenRouter/OpenAI/Anthropic/Ollama）
 - APIキーはTauri keyringsで安全に保存
 - Vercel AI SDKのstreamText()でテスト接続
 - モデル選択ドロップダウン
 テスト: キー保存→読込→APIコール成功。」
→ /clear

タスク2.2: チャットパネルUI
────────────────────────────────────
「エディタの右側にリサイズ可能なチャットパネルを実装して。
 - shadcn/ui Resizable Panels で分割
 - チャットメッセージ表示（user/assistant区別）
 - プロンプト入力エリア + 送信ボタン
 - ストリーミング表示（トークンごとに表示更新）
 - Markdownレンダリング（assistant側）
 テスト: メッセージ送信→ストリーミング受信→表示。」
→ /clear

タスク2.3: シーンコンテキスト自動注入
────────────────────────────────────
「チャット送信時に現在のシーンのコンテキストを自動注入して。
 - 現在のシーン本文をシステムプロンプトに含める
 - プロジェクト概要（タイトル、ジャンル、文体設定）を常時含める
 - トークン数をjs-tiktokenで計算・表示
 テスト: シーン切替→チャットのコンテキストが更新される。」
→ /clear

タスク2.4: チャット→エディタ挿入
────────────────────────────────────
「AIの応答テキストをエディタに挿入する機能を実装して。
 - 応答メッセージに「挿入」ボタンを表示
 - クリックでカーソル位置（または末尾）に挿入
 - 挿入テキストの選択範囲をハイライト表示（一時的）
 - 挿入時にsource: 'ai' メタデータを付与（Phase 4で使用）
 テスト: AI生成→挿入→エディタに反映。」
→ /clear

タスク2.5: 会話履歴の永続化
────────────────────────────────────
「チャット会話履歴をSQLiteに保存して。
 テーブル: chat_sessions, chat_messages
 - シーンごとに独立した会話セッション
 - セッション一覧表示・切替・削除
 - アプリ再起動後も会話が復元される
 テスト: 会話→再起動→履歴表示。」
→ /clear
```

### Phase 3: Codex + チャット抽出（Sprint 4–5、2–3週間）★最重要

**目的**: AIチャットの会話から知識をCodex/Snippetとして抽出・構造化する。

```
タスク3.1: Codex DBスキーマ + Snippet
────────────────────────────────────
「Drizzleスキーマにコデックスとスニペット用テーブルを追加して。

 codex_entries:
   id, type ('character'|'location'|'item'|'lore'),
   name, summary, content, tags, created_at, updated_at,
   source_chat_message_id (nullable, 抽出元への参照)

 snippets:
   id, title, content, tags, scene_id (nullable),
   source_chat_message_id (nullable, 抽出元への参照),
   created_at

 FTS5インデックスをtrigramトークナイザーで作成。
 CRUD操作のテスト。」
→ /clear

タスク3.2: チャットからCodex抽出UI
────────────────────────────────────
「チャットメッセージからCodexエントリを抽出する機能を実装して。
 - メッセージ右クリック or 「⋮」メニュー →「Codexに抽出」
 - 抽出ダイアログ:
   - type選択（character/location/item/lore）
   - name入力（AIが提案、ユーザーが編集可能）
   - content: メッセージ全文 or テキスト選択範囲
   - tags入力
 - 保存後、元メッセージに「Codex抽出済み」バッジ表示
 - source_chat_message_id で逆引き可能
 テスト: メッセージ選択→抽出→Codexに保存→バッジ表示。」
→ /clear

タスク3.3: チャットからSnippet抽出UI
────────────────────────────────────
「チャットメッセージからSnippetを抽出する機能を実装して。
 - メッセージの一部テキストを選択→「Snippetとして保存」
 - またはメッセージ全体を「Snippetとして保存」
 - Snippet: 再利用可能なテキスト断片（台詞案、描写案、設定文等）
 - Snippetパネルで一覧表示・検索・エディタへD&D挿入
 テスト: テキスト選択→Snippet保存→パネル表示→D&D挿入。」
→ /clear

タスク3.4: Codex管理UI
────────────────────────────────────
「src/features/codex/ にコデックス管理UIを実装して。
 - 左パネル: カテゴリフィルタ付きリスト
 - 右パネル: エントリ詳細（TipTapミニエディタ）
 - shadcn/ui Resizable Panels で分割
 - コマンドパレット（Ctrl+K）で全文検索
 - 各エントリに「抽出元チャット」へのリンク
 テスト: 登録→検索→編集→抽出元参照。」
→ /clear

タスク3.5: Codexコンテキスト注入
────────────────────────────────────
「AIチャット送信時にCodexエントリを自動注入して。
 - 現在のシーンに登場するキャラクター・設定を検出
 - 該当するCodexエントリの要約をシステムプロンプトに追加
 - 手動でCodexエントリをチャットに「ピン留め」する機能も追加
 テスト: キャラ名含むシーン→チャット→Codex情報が注入される。」
→ /clear

タスク3.6: エディタ内Codexハイライト
────────────────────────────────────
「エディタ本文中のCodexエントリ名をハイライトして。
 - TipTap Pure Decorationsで文書構造は変更しない
 - ホバーでCodexプレビューをポップオーバー表示
 - クリックでCodex詳細パネルを開く
 テスト: Codexエントリ追加→エディタでハイライト更新。」
→ /clear
```

### Phase 4: AI帰属追跡（Sprint 6、1–2週間）

**目的**: AIが書いた部分と人間が書いた部分を視覚的に区別できるようにする。

```
タスク4.1: 帰属メタデータ基盤
────────────────────────────────────
「テキストの帰属（authorship）を追跡する基盤を実装して。

 データモデル:
 - TipTapのMark拡張で 'authorship' markを定義
 - attrs: { source: 'human'|'ai'|'ai-edited', timestamp, model? }
 - 人間が直接タイプ → source: 'human'
 - AIチャットから挿入 → source: 'ai', model名を記録
 - AI生成テキストを人間が編集 → source: 'ai-edited'

 Markの付与ルール:
 - 通常の入力: 自動的に 'human' markが付与
 - タスク2.4の挿入機能: 'ai' markが付与（既に実装済みの接続点）
 - AI markのあるテキスト内を編集 → 'ai-edited' に変更

 テスト: 人間入力→humanマーク、AI挿入→aiマーク、編集→ai-editedマーク。」
→ /clear

タスク4.2: 帰属の可視化UI
────────────────────────────────────
「帰属情報の表示をトグルできるUIを実装して。
 - ツールバーに「帰属表示」トグルボタン
 - ON時:
   - AI生成テキスト: 左マージンに薄い縦線（色付き）
   - AI-edited: 左マージンに別色の縦線
   - 人間テキスト: マーカーなし（デフォルト）
 - ホバーで詳細ツールチップ（source, model, timestamp）
 - OFF時: 通常表示（マーカー非表示）
 - Pure Decorationsで実装（文書構造に影響しない）
 テスト: AI挿入→トグルON→マーカー表示→OFF→非表示。」
→ /clear

タスク4.3: 帰属レポート
────────────────────────────────────
「シーン/チャプター単位の帰属統計を表示して。
 - AI生成 / AI-edited / 人間の文字数・割合
 - 簡易的な棒グラフまたはプログレスバーで表示
 - プロジェクト全体のサマリーも表示
 テスト: 混合テキスト→統計が正しく計算される。」
→ /clear
```

### Phase 5: 日本語固有機能（Sprint 7、1–2週間）

```
タスク5.1: ルビ（振り仮名）対応
────────────────────────────────────
「TipTapカスタムインラインノードでルビを実装して。
 - <ruby>要素をレンダリング
 - ショートカットまたはコンテキストメニューでルビ付与
 - Markdownエクスポート時は {漢字|ふりがな} 形式に変換」
→ /clear

タスク5.2: 縦書きプレビュー
────────────────────────────────────
「CSS writing-mode: vertical-rl を使った縦書きプレビューモード。
 エディタ自体は横書きのまま、プレビューパネルで縦書き表示。」
→ /clear
```

---

## 3. 新機能の設計メモ

### AIチャット↔Codex抽出のデータフロー

```
[AIチャット]
    │
    ├─── 「Codexに抽出」───→ [codex_entries]
    │     type, name,           source_chat_message_id で
    │     content, tags         元メッセージを逆引き可能
    │
    ├─── 「Snippetとして保存」→ [snippets]
    │     title, content,       D&Dでエディタに挿入可能
    │     tags                  挿入時に 'ai' attribution付与
    │
    └─── 「エディタに挿入」───→ [TipTap editor]
          挿入テキストに             authorship mark: 'ai'
          ai attribution付与         model名・timestamp記録
```

### Authorship Mark の TipTap 実装方針

```typescript
// Mark定義（概念）
const AuthorshipMark = Mark.create({
  name: 'authorship',
  addAttributes() {
    return {
      source: { default: 'human' },    // 'human' | 'ai' | 'ai-edited'
      model: { default: null },         // 'claude-sonnet-4.6' etc.
      timestamp: { default: null },
      chatMessageId: { default: null }, // 抽出元への参照
    }
  },
  // Decorationとして可視化（文書構造に影響しない）
  // export時にmarkを除外すればクリーンなMarkdownになる
})
```

### 帰属の判定ルール

```
入力操作           → 付与されるmark
─────────────────────────────────────
キーボード入力      → { source: 'human' }
ペースト（外部）    → { source: 'human' }
AI応答を「挿入」    → { source: 'ai', model, chatMessageId }
Snippetを D&D挿入   → 元Snippetの source を継承
AI markテキストを編集 → { source: 'ai-edited', originalModel }
```

---

## 4. セッション運用ルール

### コンテキスト管理の鉄則

```
■ 1セッション = 1タスク（上記のタスク番号単位）
■ タスク完了 → /clear → 次のタスクへ
■ コンテキスト使用率50%で /compact を実行
■ 無関係な話題には絶対に脱線しない

■ Document & Clearパターン（長いタスク用）:
  active/[task-name]/
  ├── [task-name]-plan.md
  ├── [task-name]-context.md
  └── [task-name]-tasks.md

  → /clear 後「active/[task-name]-tasks.md を読んで続行して」
```

### モデル使い分け

```
Sonnet 4.6（デフォルト）:
  - 通常の実装タスク、テスト作成、UIコンポーネント

Opus 4.6（/model opus で切替）:
  - アーキテクチャ設計判断（特にAuthorship Markの設計）
  - 複雑なデバッグ
  - TipTapカスタムMark/Decoration設計
  - Tauri Command設計
```

### 思考レベルの使い分け

```
/effort low   : typo修正、定型CRUD、設定変更
/effort medium: 通常の機能実装（デフォルト）
/effort high  : TipTap Mark拡張、チャット↔Codex連携ロジック
/effort max   : Authorship追跡アーキテクチャ、原因不明のバグ
```

---

## 5. Hooks / MCP / 品質ゲート

### Hooks設定（Windows）

Hooksは決定論的（100%実行）、Skillsは確率論的（Claudeが判断）。
**「絶対に起きなければならないこと → Hook、判断に委ねてよいこと → Skill」**

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [{
          "type": "command",
          "command": "powershell -c \"[System.Media.SystemSounds]::Asterisk.Play()\""
        }]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [{
          "type": "command",
          "command": "powershell -c \"[System.Media.SystemSounds]::Exclamation.Play()\""
        }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "powershell -c \"$input = [Console]::In.ReadToEnd(); $cmd = ($input | ConvertFrom-Json).tool_input.command; if ($cmd -match 'rm -rf|sudo|tauri build.*--release') { Write-Error 'Blocked: dangerous command'; exit 2 }; exit 0\""
        }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|MultiEdit|Write",
        "hooks": [{
          "type": "command",
          "command": "powershell -c \"$input = [Console]::In.ReadToEnd(); $f = ($input | ConvertFrom-Json).tool_input.file_path; if ($f -match '\\.rs$') { cd src-tauri; cargo fmt -- $f 2>$null } elseif ($f -match '\\.(ts|tsx)$') { npx prettier --write $f 2>$null }; exit 0\""
        }]
      }
    ]
  }
}
```

> **PreToolUse**: `rm -rf`, `sudo`, リリースビルドをブロック（exit 2で拒否）
> **PostToolUse**: .rs → `cargo fmt`、.ts/.tsx → `prettier` を自動実行

### MCP サーバー（最大4つ、フェーズで切替）

```bash
# 常時有効（2つ）
claude mcp add --transport sse context7 https://mcp.context7.com/sse
claude mcp add github --scope user -- npx @modelcontextprotocol/server-github

# UI実装フェーズのみ有効化（/mcp で切替）
claude mcp add playwright -- npx @playwright/mcp

# Tauri開発フェーズで有効化（スクリーンショット・DOM確認・コンソールログ）
claude mcp add tauri-mcp -- npx -y @hypothesi/tauri-mcp-server
```

> **Tauri MCP**: Tauriアプリのスクリーンショット取得、DOM状態確認、コンソールログ読み取りが可能。
> Tauriアプリ側に`tauri_plugin_mcp_bridge`プラグインの追加が必要（`#[cfg(debug_assertions)]`で開発時のみ）。
> PlaywrightとTauri MCPは同時に有効化しない（トークンオーバーヘッド対策）。

### 外部Skillリポジトリ（必要に応じてインストール）

```bash
# Tauri v2 専用スキル（39個、必要なものだけ選択）
npx playbooks add skill dchuk/claude-code-tauri-skills --skill tauri-project-setup

# Rust専用スキル（所有権追跡、3層メタ認知）
npx playbooks add skill actionbook/rust-skills
```

> 外部スキルは無差別にインストールしない。descriptionの衝突で予期しないスキルが
> 発火するリスクがある。必要なものだけ選択すること。

### 品質ゲート

```
Phase 0 完了条件:
  □ npm run tauri dev でウィンドウ表示
  □ SQLite CRUD がTauri Command経由で動作

Phase 1 完了条件:
  □ TipTapエディタで文章入力・保存・読込
  □ シーンの作成・削除・切替
  □ 再起動後のデータ保持

Phase 2 完了条件:  ★
  □ APIキー設定・保存・読込
  □ チャットパネルでストリーミング生成表示
  □ 現在のシーンコンテキストがチャットに注入される
  □ 生成テキストのエディタ挿入（ai attribution付き）
  □ 会話履歴の永続化・復元

Phase 3 完了条件:  ★
  □ チャットメッセージからCodexエントリ抽出
  □ チャットメッセージからSnippet抽出
  □ Snippetのエディタへのドラッグ&ドロップ挿入
  □ Codex全文検索（FTS5 trigram）
  □ Codexエントリのチャットへの自動注入
  □ エディタ内Codexハイライト + ホバープレビュー

Phase 4 完了条件:
  □ human/ai/ai-edited の自動分類
  □ 帰属表示トグル（マージンマーカー）
  □ 帰属統計レポート

Phase 5 完了条件:
  □ ルビの付与・表示・エクスポート
  □ 縦書きプレビュー表示
```

---

