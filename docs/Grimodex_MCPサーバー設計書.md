# Grimodex MCP サーバー設計書

## 1. 概要

### 目的

Grimodex のプロジェクトデータ（シーン本文、Codex、チャット履歴等）を
**MCP (Model Context Protocol)** サーバーとして公開し、
Claude Code などの AI エージェントから自然言語で操作できるようにする。

### ユースケース

```
ユーザー → Claude Code → MCP Server → Grimodex DB / Content Files
              ↓
  「第3章のキャラ名を全シーンで置換して」
  「Codexに未登場のキャラがいないか確認して」
  「伏線を整理して未回収のものをリストにして」
  「全体の文体を統一して」
```

### 棲み分け

| 操作タイプ | 担当 |
|-----------|------|
| 1シーンの執筆・対話 | Grimodex 内蔵 AI チャット |
| プロジェクト横断の分析・一括操作 | Claude Code + MCP Server |

### スコープ

- **v1**: 読み取り中心 + Codex 書き込み
- **v2**: シーン書き込み（ファイル監視連携が前提）
- **v3**: AI チャット履歴の活用、スナップショット操作

---

## 2. アーキテクチャ

### 全体構成

```
┌──────────────────────┐
│    Claude Code       │
│  (MCP Client)        │
└────────┬─────────────┘
         │ stdio (JSON-RPC 2.0)
         │
┌────────▼──────────────────────────────┐
│ shell 別 launcher                     │
│ Tauri: Grimodex 本体 + `mcp`          │
│ Electron: standalone grimodex-mcp     │
└────────┬──────────────────────────────┘
         │ 共通 grimodex-mcp::run_blocking
         │ 直接アクセス
    ┌────┴────┐
    │         │
┌───▼───┐ ┌──▼──────────┐
│SQLite │ │ Content Dir  │
│(WAL)  │ │ (.md files)  │
└───────┘ └─────────────┘
    ▲
    │  ← GUI 起動時の本体と同じ DB を共有
┌───┴────────────────┐
│  Grimodex GUI      │
│  (Tauri/Electron)  │
└────────────────────┘
```

### 設計判断

| 決定事項 | 選択 | 理由 |
|---------|------|------|
| 配置形態 | 実行コア共通・shell 別 launcher | Tauri は本体 + `mcp`、Electron は standalone sidecar + main-owned `--license-file`。どちらも GUI 未起動で動作し、同じ `run_blocking` を呼ぶ |
| トランスポート | stdio | ローカル用途、設定がシンプル、MCP 標準 |
| DB 同時アクセス | WAL モード + busy_timeout | 読み取り中心なら安全、書き込みは Codex のみ (v1) |
| シーン書き込み | v1 では不可（読み取り専用） | エディタ内バッファとの競合を回避 |
| コンテンツ形式 | Markdown テキスト | Claude Code が処理しやすい。ProseMirror JSON は返さない |
| Rust SDK | `rmcp` クレート | 公式 Rust SDK、tokio ベース |

### Cargo ワークスペース構成

**現状の実装** (`src-tauri/crates/grimodex-mcp/`):

```
src-tauri/
├── Cargo.toml          ← workspace root (members = ["crates/grimodex-mcp", "crates/grimodex-lint"])
├── src/                ← 既存の Tauri アプリ
├── crates/
│   ├── grimodex-mcp/         ← lib + bin の二段構成
│   │   ├── Cargo.toml        ← [lib] grimodex_mcp + [[bin]] grimodex-mcp
│   │   └── src/
│   │       ├── lib.rs         ← 本体 (pub Cli / run / run_blocking + ログ設定)
│   │       ├── main.rs        ← standalone bin の薄い shim (run_blocking を呼ぶだけ)
│   │       ├── server.rs      ← rmcp `ServerHandler` (`GrimodexServer`)
│   │       ├── tools/
│   │       │   ├── mod.rs
│   │       │   ├── project.rs
│   │       │   ├── tree.rs
│   │       │   ├── scene.rs
│   │       │   ├── codex.rs
│   │       │   ├── foreshadow.rs
│   │       │   ├── timeline.rs
│   │       │   ├── search.rs
│   │       │   ├── chat.rs
│   │       │   ├── snippets.rs
│   │       │   ├── stats.rs
│   │       │   └── lint.rs    ← Linter DTO（型のみ Phase 1 で凍結、コマンドは未実装）
│   │       ├── db.rs          ← DB 接続 (rusqlite + WAL) + 型付きクエリ
│   │       ├── convert.rs     ← ProseMirror JSON → Markdown 変換
│   │       └── sanitize.rs    ← Phase 3 書き込みツール向け入力検証
│   └── grimodex-lint/         ← Lint エンジン（別設計書参照）
```

※ 現状未実装: `content.rs`（シーン本文はファイルではなく `tree_nodes.content` から読む。後述 §5 参照）、共有ライブラリ `grimodex-core`。

**将来拡張**: `database.rs`, `content.rs` 等を共有ライブラリクレート
(`grimodex-core`) に抽出し、Tauri アプリと MCP サーバーの両方から
参照する構成にする。v1 では MCP サーバー側に必要最低限のコードを複製している。

### エントリポイント（実行コア共通・shell 別起動）

MCP の実行コアは `grimodex-mcp` crate の `run_blocking()` に統一する一方、外部 MCP
client が spawn する実行ファイルと先頭引数は desktop shell ごとに異なる。

- **Tauri**: 本体アプリバイナリを `mcp` サブコマンド付きで起動する。
  `src-tauri/src/main.rs` が Tauri 初期化の**前**に argv を見て分岐し、
  `argv[1] == "mcp"` のとき `grimodex_mcp::run_blocking()` を呼ぶため GUI は開かない。
  本体 `grimodex` crate から `grimodex-mcp` への依存は一方向。
- **Electron**: 本体 GUI ではなく、package に同梱した standalone sidecar を直接起動する。
  macOS / Windows は `resources/bin/grimodex-mcp[.exe]`、packaged Linux は起動時に更新する
  `<userData>/bin/grimodex-mcp` を使う。Electron main が sidecar の絶対 path と
  `<userData>/license.json` の絶対 path を決定し、後者を
  `--license-file <absolute-path>` として先頭引数へ固定する。renderer はこのライセンス
  authority を選べない。

standalone `[[bin]]` は Electron の product sidecar に加え、dev / CI / headless の lean
実行経路としても残置する。本体バイナリが load-time link する `ort` や Linux の
`libwebkit2gtk` を必要としないため、GUI 非依存の検証にも使える（[[#6 設定]] 参照）。

### DB 接続

```rust
// grimodex-mcp/src/db.rs
use rusqlite::Connection;

pub fn open_db(workspace_path: &Path) -> Result<Connection> {
    let db_path = workspace_path.join("grimodex.db");
    let conn = Connection::open(&db_path)?;

    // Grimodex 本体と同じ PRAGMA 設定
    conn.execute_batch("
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
    ")?;

    Ok(conn)
}
```

---

## 3. MCP Tools

### 3.1 プロジェクト情報

#### `get_project`

プロジェクトの基本情報を取得する。

```json
{
  "name": "get_project",
  "description": "プロジェクトのタイトル、ジャンル、文体設定、AI指示などの基本情報を取得する",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**戻り値:**
```json
{
  "id": "uuid",
  "title": "影の回廊",
  "genre": "ファンタジー",
  "pov": "一人称",
  "tense": "現在形",
  "language": "ja",
  "styleGuide": "比喩は視覚的なものを優先...",
  "aiInstructions": "...",
  "createdAt": "2026-01-15T...",
  "updatedAt": "2026-04-10T..."
}
```

---

### 3.2 シーン・構造

#### `list_tree`

章・シーン・ノートのツリー構造を取得する。

```json
{
  "name": "list_tree",
  "description": "プロジェクトの章・シーン・ノートのツリー構造を階層的に取得する。各ノードのタイトル、種類(folder/scene/note)、ステータス、あらすじを含む",
  "inputSchema": {
    "type": "object",
    "properties": {
      "node_type": {
        "type": "string",
        "enum": ["folder", "scene", "note"],
        "description": "フィルタ: 指定した種類のノードのみ返す"
      },
      "status": {
        "type": "string",
        "enum": ["outline", "draft", "complete", "revision", "final"],
        "description": "フィルタ: 指定したステータスのノードのみ返す"
      }
    },
    "required": []
  }
}
```

**戻り値:**
```json
[
  {
    "id": "uuid",
    "parentId": null,
    "nodeType": "folder",
    "title": "第1章 目覚め",
    "sortOrder": 1.0,
    "status": null,
    "synopsis": null,
    "children": [
      {
        "id": "uuid",
        "parentId": "parent-uuid",
        "nodeType": "scene",
        "title": "朝の教室",
        "sortOrder": 1.0,
        "status": "draft",
        "synopsis": "主人公が異変に気づく場面",
        "wordCount": 2340,
        "children": []
      }
    ]
  }
]
```

#### `read_scene`

シーンの本文を Markdown で取得する。

```json
{
  "name": "read_scene",
  "description": "指定したシーンの本文をMarkdown形式で取得する。シーンID、タイトル、またはパス（章名/シーン名）で指定可能",
  "inputSchema": {
    "type": "object",
    "properties": {
      "scene_id": {
        "type": "string",
        "description": "シーンのUUID"
      },
      "title": {
        "type": "string",
        "description": "シーンのタイトル（部分一致検索）"
      }
    },
    "required": []
  }
}
```

**戻り値:**
```json
{
  "id": "uuid",
  "title": "朝の教室",
  "status": "draft",
  "synopsis": "主人公が異変に気づく場面",
  "chapter": "第1章 目覚め",
  "wordCount": 2340,
  "markdown": "　教室に入ると、いつもと空気が違った。\n\n..."
}
```

#### `read_scenes_batch`

複数シーンの本文を一括取得する。

```json
{
  "name": "read_scenes_batch",
  "description": "複数シーンの本文を一括でMarkdown形式で取得する。章単位やステータスでフィルタ可能",
  "inputSchema": {
    "type": "object",
    "properties": {
      "scene_ids": {
        "type": "array",
        "items": { "type": "string" },
        "description": "取得するシーンIDの配列"
      },
      "parent_id": {
        "type": "string",
        "description": "指定した章(folder)配下の全シーンを取得"
      },
      "status": {
        "type": "string",
        "enum": ["outline", "draft", "complete", "revision", "final"],
        "description": "指定したステータスのシーンのみ取得"
      },
      "limit": {
        "type": "integer",
        "default": 20,
        "maximum": 50,
        "description": "最大取得シーン数（デフォルト20、上限50）"
      }
    },
    "required": []
  }
}
```

※ 現状の実装: `scene_ids` を渡した場合は先頭から最大 50 件、`parent_id`/`status` 指定で全シーン取得した場合も 50 件で切り詰める。`limit` パラメータは未実装（常に上限 50）。

---

### 3.3 全文検索

#### `search_project`

FTS5 トリグラムインデックスを使った横断検索。日本語対応。

※ ツール名は実装上 `search_project`（MCP クライアントが汎用 `search` と
衝突しないよう接尾辞を付けている）。

```json
{
  "name": "search_project",
  "description": "プロジェクト全体をFTS5全文検索する。シーン本文、Codexエントリ、チャット履歴、ノートを横断的に検索。日本語対応（トリグラムトークナイザ）",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "検索クエリ（FTS5構文対応: AND/OR/NOT、フレーズ検索 \"...\" ）"
      },
      "scope": {
        "type": "string",
        "enum": ["all", "scenes", "codex", "snippets", "chat"],
        "description": "検索対象を限定する。省略時は \"all\""
      },
      "limit": {
        "type": "integer",
        "default": 20,
        "description": "最大結果数"
      }
    },
    "required": ["query"]
  }
}
```

**戻り値:**
```json
{
  "results": [
    {
      "type": "scene",
      "id": "uuid",
      "title": "朝の教室",
      "chapter": "第1章 目覚め",
      "snippet": "...教室に入ると、いつもと<<空気が違った>>。窓の外は...",
      "rank": 0.95
    },
    {
      "type": "codex",
      "id": "uuid",
      "name": "真田陽介",
      "entryType": "character",
      "snippet": "...<<空気>>を読む能力に長けている...",
      "rank": 0.72
    }
  ],
  "totalCount": 15
}
```

---

### 3.4 Codex（設定資料）

#### `list_codex_entries`

Codex エントリの一覧を取得する。

```json
{
  "name": "list_codex_entries",
  "description": "Codex（設定資料）エントリの一覧を取得する。キャラクター、場所、アイテム等のカテゴリでフィルタ可能",
  "inputSchema": {
    "type": "object",
    "properties": {
      "type_slug": {
        "type": "string",
        "description": "エントリタイプのslugでフィルタ (例: character, location, item, lore)"
      },
      "tag": {
        "type": "string",
        "description": "タグ名でフィルタ"
      }
    },
    "required": []
  }
}
```

※ 現状の実装ではパラメータ名は `type_slug`（予約語 `type` を避けるため）。

**戻り値:**
```json
[
  {
    "id": "uuid",
    "name": "真田陽介",
    "type": "character",
    "typeLabel": "キャラクター",
    "aliases": ["陽介", "真田"],
    "summary": "主人公。22歳、魔法工学科の学生。",
    "tags": ["主要キャラ", "工学科"],
    "contextMode": "mentioned",
    "hasChildren": true
  }
]
```

#### `get_codex_entry`

Codex エントリの詳細を取得する。

```json
{
  "name": "get_codex_entry",
  "description": "指定したCodexエントリの完全な詳細を取得する。プロフィール項目、フェーズ情報、関連タグを含む",
  "inputSchema": {
    "type": "object",
    "properties": {
      "entry_id": {
        "type": "string",
        "description": "エントリのUUID"
      },
      "name": {
        "type": "string",
        "description": "エントリ名で検索（部分一致）"
      }
    },
    "required": []
  }
}
```

**戻り値:**
```json
{
  "id": "uuid",
  "name": "真田陽介",
  "type": "character",
  "aliases": ["陽介", "真田"],
  "summary": "主人公。22歳、魔法工学科の学生。",
  "content": "真田陽介は魔法工学科の3年生で...(Markdown)",
  "notes": "第8章で覚醒イベント予定 (Markdown)",
  "tags": ["主要キャラ", "工学科"],
  "details": [
    { "name": "年齢", "value": "22" },
    { "name": "所属", "value": "魔法工学科" },
    { "name": "関係者", "value": "桐谷凛（同級生）" }
  ],
  "phases": [
    {
      "id": "uuid",
      "label": "覚醒後",
      "anchorScene": "第8章 - 真実",
      "summaryOverride": "覚醒後の陽介は..."
    }
  ],
  "children": [
    { "id": "uuid", "name": "真田の剣", "type": "item" }
  ]
}
```

#### `create_codex_entry`

新しい Codex エントリを作成する。

```json
{
  "name": "create_codex_entry",
  "description": "新しいCodexエントリを作成する。キャラクター、場所、アイテム、設定などの設定資料を追加",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "エントリ名（必須、最大 255 文字）"
      },
      "type_slug": {
        "type": "string",
        "description": "エントリタイプ slug (例: character, location, item, lore)"
      },
      "aliases": {
        "type": "array",
        "items": { "type": "string" },
        "description": "別名リスト（本文中のハイライト検出に使用、最大 50 個・各 100 文字）"
      },
      "summary": {
        "type": "string",
        "description": "概要（AI コンテキストに注入される要約文、最大 2000 文字）"
      },
      "content": {
        "type": "string",
        "description": "詳細な説明（プレーンな Markdown、最大 1 MB）。内部で ProseMirror JSON に変換して保存"
      },
      "tags": {
        "type": "array",
        "items": { "type": "string" },
        "description": "タグ名のリスト（未登録のタグは新規作成される）"
      }
    },
    "required": ["name", "type_slug"]
  }
}
```

※ 現状未実装: `parent_id`（子エントリとして作成する経路）。  
※ 実装追加: `tags`（作成と同時にタグを付与）。

#### `update_codex_entry`

既存の Codex エントリを更新する。

```json
{
  "name": "update_codex_entry",
  "description": "既存のCodexエントリを更新する。指定したフィールドのみ更新される",
  "inputSchema": {
    "type": "object",
    "properties": {
      "entry_id": {
        "type": "string",
        "description": "更新するエントリのUUID"
      },
      "name": { "type": "string" },
      "aliases": {
        "type": "array",
        "items": { "type": "string" }
      },
      "summary": { "type": "string" },
      "content": { "type": "string", "description": "Markdown（最大 1 MB、内部で ProseMirror JSON に変換）" },
      "tags": {
        "type": "array",
        "items": { "type": "string" },
        "description": "タグ名のリスト（既存のタグを置き換える）"
      }
    },
    "required": ["entry_id"]
  }
}
```

---

### 3.5 チャット履歴

#### `list_chat_sessions`

チャットセッション一覧を取得する。

```json
{
  "name": "list_chat_sessions",
  "description": "チャットセッションの一覧を取得する。シーン単位のセッションとその概要を確認できる",
  "inputSchema": {
    "type": "object",
    "properties": {
      "node_id": {
        "type": "string",
        "description": "特定のツリーノード（シーン等）に紐づくセッションのみ取得"
      }
    },
    "required": []
  }
}
```

※ パラメータ名は実装上 `node_id`（チャットセッションはシーン以外のノードにも紐づき得るため）。

#### `read_chat_history`

チャットセッションのメッセージ履歴を取得する。

```json
{
  "name": "read_chat_history",
  "description": "指定したチャットセッションのメッセージ履歴を取得する。AIとの過去の議論内容を確認できる",
  "inputSchema": {
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "description": "チャットセッションのUUID"
      },
      "anchors_only": {
        "type": "boolean",
        "default": false,
        "description": "アンカーメッセージのみ取得 (Tier 1+2)。具体的には: role='user' のすべてのメッセージ、Codex/Snippet として抽出された AI メッセージ、Editor に挿入された AI メッセージ。汎用的な雑談や未採用の候補出力など Tier 3 のメッセージは除外される"
      },
      "limit": {
        "type": "integer",
        "default": 100,
        "maximum": 200,
        "description": "最大メッセージ数（1-200、デフォルト 100）"
      }
    },
    "required": ["session_id"]
  }
}
```

**互換性ノート (旧 `starred_only` パラメータ)**: v1 初期では `starred_only` (boolean)
パラメータが存在したが、⭐スター機能廃止に伴い `anchors_only` に置換された。
クライアント実装は `anchors_only` を使用すること。
サーバは互換性のため `starred_only` を受け付けた場合 `anchors_only` として
解釈するが、deprecation 警告をログに出す。

---

### 3.6 スニペット

#### `list_snippets`

スニペット（抽出されたテキスト断片）の一覧を取得する。

```json
{
  "name": "list_snippets",
  "description": "チャットやシーンから抽出されたスニペットの一覧を取得する",
  "inputSchema": {
    "type": "object",
    "properties": {
      "tag": {
        "type": "string",
        "description": "タグ名でフィルタ（部分一致）"
      },
      "limit": {
        "type": "integer",
        "default": 50,
        "maximum": 100,
        "description": "最大取得件数（1-100、デフォルト 50）"
      }
    },
    "required": []
  }
}
```

戻り値はスニペットの `content`（ProseMirror JSON）を Markdown に変換した形で返す。

---

### 3.7 統計・分析

#### `get_project_stats`

プロジェクトの統計情報を取得する。

```json
{
  "name": "get_project_stats",
  "description": "プロジェクト全体の統計情報を取得する。文字数、シーン数、章ごとの内訳、Codexエントリ数、ステータス分布を含む",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**戻り値（現状の実装）:**
```json
{
  "scene_count": 42,
  "folder_count": 12,
  "status_distribution": [
    ["draft", 18],
    ["complete", 12],
    ["outline", 5],
    ["revision", 5],
    ["final", 2]
  ],
  "codex_entry_count": 41,
  "codex_by_type": [
    ["character", 15],
    ["item", 12],
    ["location", 8],
    ["lore", 6]
  ]
}
```

**将来拡張（未実装）**: `totalWordCount`、章単位の `chaptersBreakdown`、
プロジェクト全体の `attribution`（人間 vs AI 比率）。  
帰属比率は別ツール `get_attribution_report` で取得する。

#### `get_attribution_report`

帰属（AI/人間）の詳細レポートを取得する。

```json
{
  "name": "get_attribution_report",
  "description": "各シーンのAI/人間のテキスト寄与率を詳細に取得する",
  "inputSchema": {
    "type": "object",
    "properties": {
      "scene_id": {
        "type": "string",
        "description": "特定シーンのレポートのみ取得。省略時は全シーン"
      }
    },
    "required": []
  }
}
```

---

### 3.8 ツール一覧（サマリ）

| ツール名 | 読/書 | v1 | 概要 |
|---------|------|-----|------|
| `list_projects` | R | o | プロジェクト一覧（pinned 時は bound 1 件のみ・XPROJ） |
| `select_project` | — | o | current project 切替（`--all-projects` 必須・pinned 時拒否） |
| `get_project` | R | o | プロジェクト基本情報 |
| `list_tree` | R | o | ツリー構造一覧 |
| `read_scene` | R | o | シーン本文（Markdown） |
| `read_scenes_batch` | R | o | 複数シーン一括取得 |
| `search_project` | R | o | FTS5 横断検索 |
| `list_codex_entries` | R | o | Codex 一覧 |
| `get_codex_entry` | R | o | Codex 詳細 |
| `create_codex_entry` | W | o | Codex 新規作成（knowledgeWrite gate） |
| `update_codex_entry` | W | o | Codex 更新（knowledgeWrite gate） |
| `create_snippet` | W | o | Snippet 新規作成（knowledgeWrite gate） |
| `propose_scene_body` | W | o | シーン本文を accept/reject 用にステージ（bodyWrite gate） |
| `list_chat_sessions` | R | o | チャットセッション一覧 |
| `read_chat_history` | R | o | チャット履歴取得 |
| `list_snippets` | R | o | スニペット一覧 |
| `get_project_stats` | R | o | プロジェクト統計 |
| `get_attribution_report` | R | o | 帰属レポート |
| `list_codex_tags` | R | o | Codex タグ一覧（usageCount 付き） |
| `search_codex_by_tags` | R | o | タグ OR 検索で Codex エントリ取得 |
| `find_related_entries` | R | o | 起点エントリ名/別名から関連 Codex 探索 |
| `get_chapter_summaries` | R | o | folder 単位のシーン synopsis 一覧 |
| `list_open_foreshadows` | R | o | 未回収伏線一覧（secret 除外） |
| `get_foreshadow_detail` | R | o | 単一伏線の詳細（setups / payoff） |
| `create_foreshadow` | W | o | 伏線新規作成（knowledgeWrite gate・secret 既定 true・tracked: undo_journal+change_event を 1tx 記録） |
| `update_foreshadow` | W | o | 伏線更新（knowledgeWrite gate・project スコープ・tracked 同上。undo は updated_at 楽観ガードの versionless 設計） |
| `get_scene_timeline_neighbors` | R | o | story-time 前後シーン（最大各3件） |
| `get_writing_context` | R | o | curated context 一発集約（project / 章outline / storySoFar / シーン本文MD+intent / timeline近傍 / シーン伏線+未回収伏線(secret除外) / codex mention+always。cap超過はdropped数で報告） |
| `list_events` | R | o | 作中年表イベント一覧（作中順・kind フィルタ可・primaryCharacter は codex 名解決） |
| `get_event_detail` | R | o | 単一イベント詳細（参加者 / 紐づきシーン / 因果。XPROJ=project の events に在ること） |
| `get_character_timeline` | R | o | 人物の作中経歴（primary/participant 関与イベントを作中順・各時点の ageAtEvent） |
| `get_chronicle_state` | R | o | シーン作中時刻の世界状態スナップショット（resolveSceneAnchor→pick→derive を Rust 移植。**in-app と同一 JSON schema**・fixture で TS↔Rust drift を gate） |
| `create_event` | W | o | 作中年表イベント作成（knowledgeWrite gate・tracked: change_event domain='event' + undo_journal surface='mcp'） |
| `update_event` | W | o | イベント更新（渡したフィールドのみ・project スコープ・tracked。XPROJ=他プロジェクト id は no-op→not found） |
| `delete_event` | W | o | イベント削除（participants/scene/relation を cascade・削除前スナップショットを undo before に格納） |
| `stamp_scene_event` | W | o | シーンにイベントを stamp（scene/event とも active project 必須） |
| `unstamp_scene_event` | W | o | scene↔event の stamp 解除 |
| `set_event_participants` | W | o | イベント参加者集合を置換（全削除→再挿入） |
| `add_event_relation` | W | o | 因果エッジ追加（cause→effect。自己ループ禁止・両端 active project 必須） |
| `remove_event_relation` | W | o | 因果エッジ削除 |
| `write_scene` | W | v2 | シーン本文書き込み |
| `create_scene` | W | v2 | シーン新規作成 |
| `update_scene_metadata` | W | v2 | シーンメタデータ更新 |
| `semantic_search` | R | defer | セマンティック検索（§3.11・モデルパス解決が前提） |

**`tools/list` 件数（現行）**: プロジェクト管理 2（`list_projects` / `select_project`）
+ 読み取り 24 + 書き込み 14 = **40 ツール**
（write 14 = create_codex_entry / update_codex_entry / create_snippet / propose_scene_body
/ create_foreshadow / update_foreshadow / create_event / update_event / delete_event /
stamp_scene_event / unstamp_scene_event / set_event_participants / add_event_relation /
remove_event_relation。うち年表 8 種が 2026-06 追加（in-app agent の `agent_event_*` と
tracked-write parity）。read 24 = 従来 20 + 年表 read 4（list_events / get_event_detail /
get_character_timeline / get_chronicle_state）。
`select_project` は DB を書かずセッションの current project を切替えるだけ。
write_scene 等の scene 書き込みは v2 で未実装ゆえ tools/list に出ない。
`semantic_search` は defer（§3.11）ゆえ tools/list に出ない）。
クラウド LLM クライアント（Claude Desktop / Claude Code / Hermes Agent 等）では
**`--readonly` 付きで起動する**ことを推奨。ただし `--readonly` は **call-time gate** であり、
write 14 ツールは tools/list には**載る**が、呼び出すと「readonly mode」エラーを返す
（list-time で隠れるわけではない）。

### 3.9 In-app チャット executor との能力パリティ

Grimodex 内蔵 Agent の read-only executor 14 種のうち、専用 MCP ツール名が
異なるものは既存 MCP で近似可能。2026-06 時点で不足していた 7 種を
専用ツールとして追加し、**意味的パリティ**を達成した。

| chat executor | MCP の対応 |
| --- | --- |
| `search_codex` | `search_project(scope="codex")` |
| `list_codex_by_type` | `list_codex_entries(type_slug=...)` |
| `get_codex_entry` | `get_codex_entry(entry_id=...)` |
| `list_chapters` | `list_tree(node_type=...)` |
| `get_scene` | `read_scene(scene_id=...)` |
| `search_scenes` | `search_project(scope="scenes")` |
| `search_snippets` | `search_project(scope="snippets")` または `list_snippets(tag=...)` |
| `list_codex_tags` | `list_codex_tags`（同名・新規） |
| `search_codex_by_tags` | `search_codex_by_tags`（同名・新規） |
| `find_related_entries` | `find_related_entries`（同名・新規） |
| `get_chapter_summaries` | `get_chapter_summaries`（同名・新規） |
| `list_open_foreshadows` | `list_open_foreshadows`（同名・新規） |
| `get_foreshadow_detail` | `get_foreshadow_detail`（同名・新規） |
| `get_scene_timeline_neighbors` | `get_scene_timeline_neighbors`（同名・新規） |
| `list_events`（chronicle read） | `list_events`（同名・新規） |
| `get_event_detail`（chronicle read） | `get_event_detail`（同名・新規） |
| `get_character_timeline`（chronicle read） | `get_character_timeline`（同名・新規） |
| `get_chronicle_state`（chronicle read） | `get_chronicle_state`（同名・新規） |

加えて in-app の **chronicle write 8 種**（`agent_event_*`）に対応する
`create_event` / `update_event` / `delete_event` / `stamp_scene_event` /
`unstamp_scene_event` / `set_event_participants` / `add_event_relation` /
`remove_event_relation` を追加し、tracked-write parity（change_event domain='event'
+ undo_journal、surface のみ in-app=`in-app-agent` / MCP=`mcp` で差異）を達成した。

**既知ドリフト（byte-for-byte 一致は要求しない）:**

- **章ノード**: 現行 DB の `tree_nodes.node_type` は `folder | scene | note`。
  チャット executor / 旧 docs の `chapter` / `part` は legacy 表現。
  MCP `get_chapter_summaries` は **`folder` を章として扱う**。
- **`list_open_foreshadows`**: `derivedLabel`（seeded / needs_strengthening / critical_weak /
  planned 等）を **JSON に含める**（`id`, `title`, `intent`, `loadBearing`, `setupCount`, `derivedLabel`）。
  チャット executor は最終出力から `derivedLabel` を落とすが、toolDefinitions の宣言契約と伏線整理
  ユースケースに合わせ MCP は返す。**意図的な差分**でありチャット出力との byte-for-byte parity は非対象。
- **`get_foreshadow_detail` setup.strength**: チャットは `strength ?? aiStrength ?? null`。
  MCP も同じ（`careful.strength` は見ない）。
- **`get_scene_timeline_neighbors`**: チャット executor は JS `cmpKeys` で全件ソート。
  MCP は `story_time_order COLLATE BINARY` の SQL 近傍クエリ（fractional key 文字列順は同等）。
  なお **target scene は `server.project_id` で必ず絞る**（単一 DB に全プロジェクトを持つため、
  他プロジェクトの scene_id でタイムラインを読まれないようにする XPROJ 防御）。
- **`get_chronicle_state`**: TS の `resolveSceneAnchor → pickSnapshotCharacters →
  deriveChronicleSnapshot` を Rust に移植（`grimodex-mcp/src/chronicle_snapshot.rs`）。
  **構造化 JSON は in-app と同一 schema** を要求し、両者が読む共有 fixture
  （`src/features/chronicle/fixtures/chronicle-snapshot/*.json`）で TS 側
  （`chronicleSnapshot.fixtures.test.ts`）・Rust 側（`chronicle_snapshot::tests`）が
  expected と deep-equal を assert する＝ derive drift を CI が gate する。
  **唯一の理論差分**: `truncate` の文字数カウントが JS=UTF-16 code unit / Rust=Unicode
  scalar value で、アストラル文字（絵文字等）でのみ乖離しうる。fixture は cap 内の
  title/note のみ使い truncation を発火させないため parity gate には現れない。
  MCP は in-app と違い「active scene」概念が無いため `scene_id` は実質必須
  （未指定 / events 0 件は `null` を返す）。

### 3.10 Linter 連携（Phase 1 で型のみ凍結）

詳細は `docs/Grimodex_Linter設計書.md` §「MCP サーバー連携」を参照。
実コマンド（`list_lint_diagnostics`, `run_lint`, `list_lint_rules`,
`apply_lint_fix`）は MCP v2 / v4 で実装予定だが、外部クライアントが
スキーマに対してコードを書けるよう、DTO 定義のみ Phase 1 で凍結済み
（`tools/lint.rs` の `LintDiagnosticDto` 他）。
座標系は LSP に合わせ `line` = 1-origin、`column` / `length` = 0-origin UTF-16 コードユニット。

### 3.11 セマンティック検索ツール（defer 判断 / 2026-06-08）

外部エージェントの retrieval を強化する `semantic_search`（読み取り専用）を MCP に
出す案を検討したが、**「公開するだけ」では実装できない**ことが判明したため defer する。

**フィージビリティの壁:**

- `grimodex-mcp` クレートの依存は `grimodex-core` + rusqlite 等のみで、embedding 基盤
  （`ort` / `tokenizers` / `ndarray`）も推論コード（`src-tauri/src/semantic/` = 本体
  `grimodex_lib` 側、`semantic-embedding` feature gate）も**持たない**。
- 本命のボトルネックは依存の重さではなく **スタンドアロン stdio バイナリでのモデルパス解決**。
  仮に embedding コードを共有クレートへ抽出しても、MCP バイナリには `tauri::AppHandle` が
  無く `model_int8.onnx` / `tokenizer.json` を**どこから読むか**が未解決のまま残る。
- `ort` を MCP バイナリに足すと、CLAUDE.md が警告する libort_sys の glibc symbol mismatch
  によるローカルリンク失敗が MCP 側にも再来する。

**選択肢（採用＝A）:**

| 案 | 内容 | 評価 |
|----|------|------|
| **A. defer（採用）** | 本ドキュメントに壁を記録し、別途設計で着手 | 最小リスク。foreshadow write を先に確定 |
| B. フル抽出 | `src-tauri/src/semantic` を共有クレート化＋MCP に ort 追加＋モデルパスを env/config で解決 | 大規模・ビルド重・glibc/ort 痛が MCP に再来 |
| C. アプリ委譲 | クエリ embedding を起動中アプリにローカル IPC で委譲 | アプリ起動中のみ動作・実行時結合とプロトコル追加が必要 |

着手時は **案 B のモデルパス解決サブ問題**を先に潰すこと。詳細は
`docs/Grimodex_セマンティック検索設計書.md`（本体側の embedding 経路）を参照。

---

## 4. MCP Resources

URI ベースで Grimodex のデータをリソースとして公開する。
Claude Code がコンテキストとして参照できる。

| URI パターン | 説明 |
|-------------|------|
| `grimodex://project` | プロジェクト情報 |
| `grimodex://tree` | ツリー構造全体 |
| `grimodex://scene/{id}` | シーン本文 (Markdown) |
| `grimodex://codex/{id}` | Codex エントリ詳細 |
| `grimodex://codex` | Codex 全エントリ概要 |
| `grimodex://stats` | プロジェクト統計 |

※ 現状未実装。`GrimodexServer::get_info` は `ServerCapabilities::builder().enable_tools()`
のみを宣言しており、`resources` capability は公開していない。すべて Tool 経由でアクセスする。

---

## 5. コンテンツ変換

### ProseMirror JSON → Markdown

Codex エントリの `content` と `notes` は ProseMirror JSON で保存されている。
MCP サーバーはこれを Markdown に変換して返す。

対応するノードタイプ:

| ProseMirror Node | Markdown 出力 |
|-----------------|---------------|
| `paragraph` | テキスト + 改行 |
| `heading` | `#` ~ `######` |
| `bulletList` / `listItem` | `- ` |
| `orderedList` / `listItem` | `1. ` |
| `codeBlock` | ` ``` ` |
| `blockquote` | `> ` |
| `horizontalRule` | `---` |
| `table` | GFM テーブル |
| `ruby` | `{漢字\|かんじ}` |
| `sceneBreak` | `***` |

対応するマーク:

| Mark | Markdown |
|------|----------|
| `bold` | `**text**` |
| `italic` | `*text*` |
| `strike` | `~~text~~` |
| `code` | `` `text` `` |
| `link` | `[text](url)` |
| `underline` | `<u>text</u>` |
| `emphasisDots` | `《《text》》` |

`authorship` マークは変換時に除去する（帰属情報は別途 API で取得）。

### シーン本文

**現状の実装**: シーン本文は DB の `tree_nodes.content` カラム（ProseMirror JSON）
から読み取り、`prosemirror_to_markdown` で変換して返す。Content Dir
からの直接読み取りは実装していない（`content.rs` モジュールも未作成）。
ProseMirror JSON 以外（プレーンテキスト）が入っていた場合はそのまま返す
フォールバックを持つ（`tools::scene::load_scene`）。

**将来拡張**: 別途 Content Dir に Markdown ファイルとして保存する運用に
切り替える場合、`content.rs` を追加してファイルパス解決とエンコーディング
処理をそこに集約する想定。

---

## 6. 設定

### ビルド

MCP core は共通だが、配布物と `.mcp.json` の `command` / 先頭引数は shell 別である。

| Shell | `command` | `args` prefix | ライセンス path |
|---|---|---|---|
| Tauri | installer が配る本体アプリの絶対 path | `mcp` | 省略時に従来の Tauri app-data から解決 |
| Electron | standalone `grimodex-mcp[.exe]` の絶対 path（packaged Linux は `<userData>/bin/grimodex-mcp`） | `--license-file`, `<absolute userData/license.json>` | Electron main が所有・注入 |

Tauri 本体の path 例:

| OS | パス例 |
|----|--------|
| macOS | `/Applications/Grimodex.app/Contents/MacOS/Grimodex` |
| Windows | `C:\Program Files\Grimodex\Grimodex.exe` |
| Linux (deb/rpm) | `/usr/bin/grimodex` |
| Linux (AppImage) | AppImage ファイル自体（`Grimodex_x.y.z.AppImage`） |

Electron sidecar は release packaging 前に必ず licensing feature 付きで build する。

```bash
# dev / beta（licensing feature なし）
pnpm mcp:build
# Electron product sidecar（licensing feature あり）
pnpm mcp:build:release
# product N-API の feature 検証も含めた配布前 build
pnpm electron:native:release
```

**Phase 4 実装済み**: packaged Linux は app 起動時に package 側 source を executable regular
non-symlink file として検証し、`<userData>/bin/grimodex-mcp` へ eager refresh する。source と
既存 destination の SHA-256 が同じなら mode を 0755 に補正し、異なる場合は 0600 の一時 file
へ copy → 0755 → fsync → 同一 directory 内 rename の順で置換する。copy 中に source identity /
size / mtime / ctime が変化した場合や更新に失敗した場合は未完成 file を削除し、既存の
known-good destination を置換しない。したがって AppImage の一時 mount が app 終了後に消えても、
コピー済み `.mcp.json` の `command` は安定している。これは AppImage に限らず packaged Linux
で同じ契約を使い、更新版 sidecar は次回起動時に設定画面を開かなくても反映される。

アプリ内（設定 → AI → MCP 連携）のコピーボタンは、実行 shell から返された
`command` / `argsPrefix` と、現在の workspace / project identity を組み合わせて
`.mcp.json` を出力する。スコープ（この作品＝`--project` / 全作品＝`--all-projects`）×
書込権限（読み取り専用＝`--readonly` / ポリシー準拠＝`--readonly` なし）を明示ボタンで
選ぶ。workspace switch 中や、取得中に workspace / project が変わった場合はコピーしない。

`--project <ID>` は任意。省略時は `projects ORDER BY created_at LIMIT 1` の先頭を使用する。

dev / CI / headless では standalone bin を直接 build・実行してよい。Electron product と同じ
ライセンス authority を検証するときは `--license-file` に絶対 path を明示する。

```bash
cd src-tauri
cargo build --release -p grimodex-mcp
./target/release/grimodex-mcp \
  --license-file /absolute/app-data/license.json \
  --workspace /abs/ws \
  --readonly

# Tauri 統合 path の dev 検証
cargo run -- mcp --workspace /abs/ws --readonly
```

### .mcp.json（Claude Code / Desktop）

**クラウド LLM では `--readonly` を必ず付ける**（write 14 ツールを call-time で無効化）。

Tauri（本体アプリ + `mcp` subcommand）:

```json
{
  "mcpServers": {
    "grimodex": {
      "command": "/Applications/Grimodex.app/Contents/MacOS/Grimodex",
      "args": [
        "mcp",
        "--workspace",
        "/absolute/path/to/grimodex-workspace",
        "--project",
        "<project-id>",
        "--readonly"
      ],
      "env": {}
    }
  }
}
```

Electron Linux（stable standalone sidecar + main-owned license path）:

```json
{
  "mcpServers": {
    "grimodex": {
      "command": "/absolute/electron-user-data/bin/grimodex-mcp",
      "args": [
        "--license-file",
        "/absolute/electron-user-data/license.json",
        "--workspace",
        "/absolute/path/to/grimodex-workspace",
        "--project",
        "<project-id>",
        "--readonly"
      ],
      "env": {}
    }
  }
}
```

Tauri の `args` prefix は `"mcp"`、Electron の prefix は
`"--license-file", "<absolute path>"` であり、相互に置換できない。Electron の
license path は renderer や MCP client の入力ではなく Electron main が現在の `userData` から
生成する。ローカルで Codex 書き込みも使う場合のみ末尾の `"--readonly"` を外す。

### Hermes Agent `mcp_servers`

[Nous Hermes Agent](https://github.com/NousResearch/hermes-agent) 等の MCP クライアントでも
同じ stdio 設定を使う。`command` / `--workspace` / Electron の `--license-file` は
**absolute path** を使う。次は Tauri の例であり、Electron では直前の JSON 例と同じ
standalone command / license prefix に置き換える。

```yaml
# Tauri 例: Hermes Agent 設定の mcp_servers 節（YAML 形式の場合）
mcp_servers:
  grimodex:
    command: /Applications/Grimodex.app/Contents/MacOS/Grimodex
    args:
      - mcp
      - --workspace
      - /absolute/path/to/grimodex-workspace
      - --readonly
    env: {}
```

接続後 `tools/list` が **40 ツール**（プロジェクト管理 2 + read 24 + write 14）を返すことを確認する。write 14 種は
`--readonly` でも list には載るが、呼び出すと call-time でエラー応答する（list-time では隠れない）。

### .mcp.json（standalone dev / headless）

dev で standalone bin を直に指す例。`mcp` サブコマンドを**付けない**点は Electron と
同じだが、Electron product config では main が `--license-file` を必ず付与する。次の例も
licensing feature を有効にして product parity を確認する場合は実在する絶対 license path を使う。

```json
{
  "mcpServers": {
    "grimodex": {
      "command": "/absolute/repo/src-tauri/target/release/grimodex-mcp",
      "args": [
        "--license-file",
        "/absolute/app-data/license.json",
        "--workspace",
        "/path/to/your/novel-project",
        "--readonly"
      ],
      "env": {}
    }
  }
}
```

### CLI オプション

```
grimodex-mcp [OPTIONS]

Options:
  -w, --workspace <PATH>   Grimodex ワークスペースのパス（必須）
      --license-file <ABSOLUTE_PATH>
                           license.json の絶対パス。Electron product は main が
                           <userData>/license.json を注入。省略時は従来の Tauri
                           app-data path を使う
  -p, --project <ID>       プロジェクトID（省略時は最初のプロジェクトを使用。
                           --all-projects 時は初期 current として扱う）
      --readonly           書き込みツールを無効化（call-time gate）
      --all-projects       select_project でのプロジェクト切替を許可する。
                           ローカル/信頼クライアント専用（接続スコープが DB 全体に広がる）
      --verbose            デバッグログを stderr に出力
  -h, --help               ヘルプ表示
```

**プロジェクトスコープ（既定 = ピン留め）**:

- 既定（`--all-projects` 無し）は **1 プロジェクトにピン留め**。全ツールが起動時の
  project に固定スコープし、`select_project` は拒否、`list_projects` はそのピン留め
  プロジェクト 1 件のみ返す（他プロジェクトの id/title を漏らさない）。`.mcp.json` の
  エントリ＝「この AI にはこの 1 作品だけ」という監査可能なアクセス許可になる。
- `--all-projects` は **明示オプトイン**。`select_project(project_id)` で current を
  切り替えられ、`list_projects` が全プロジェクトを列挙する。接続スコープが DB 全体に
  広がるため **ローカル/信頼クライアント専用**。クラウド用途では `--all-projects` を
  付けない（付けるなら最低限 `--readonly` と併用）。
- read-by-id 系はモードに関わらず常に **current project でスコープ**する（`--all-projects`
  でも、別プロジェクトの id を読むには先に `select_project` で切り替える）。XPROJ 防御
  （[[#3.9]]）は不変。

### 起動時の検証

**現状の実装** (`grimodex-mcp/src/lib.rs::run`。Tauri 本体 subcommand と Electron
standalone sidecar はどちらも `run_blocking` に委譲する):

1. `--license-file` があれば絶対 path であることを検証し、なければ従来の Tauri
   app-data path を解決する。Electron product では main が前者を必ず注入する
2. `--workspace` パスに `grimodex.db` が存在するか確認
3. DB を WAL モードで開く（`busy_timeout = 5000`、`foreign_keys = ON`）
4. **スキーマバージョン検証**: `PRAGMA user_version` を読み、`grimodex_core::SCHEMA_VERSION`
   と不一致なら **readonly に降格**して `warn` ログを出す（`bail` はしない＝古い/新しい
   DB でも read は通す。書き込みだけ止めて破壊を防ぐ）
5. `--project` 未指定時は `SELECT id FROM projects ORDER BY created_at LIMIT 1` で先頭プロジェクトを採用
6. ログ出力先（stderr ＋ `~/.grimodex/logs/lint-mcp-*.log` の日次ローテーション）を初期化
7. MCP サーバーを stdio で起動。write tool は呼出しごとに同じ license file を再読込する

※ 現状未実装: Content Dir パスの解決（§5 のとおりファイルを使わないため）。
DB スキーマの詳細は `docs/Grimodex_統合DBスキーマ.md` を参照。

---

## 7. セキュリティ

### データアクセス

- MCP サーバーは**ローカルのみ**で動作（stdio）。ネットワーク公開しない
- API キーにはアクセスしない（Tauri keyring / Electron safeStorage のどちらにも非依存）
- `--readonly` フラグで書き込みを完全に無効化可能
- **配布同梱に伴う到達面の変化**: MCP サーバは Tauri の installer 済み本体
  （`mcp` サブコマンド）または Electron の同梱 standalone sidecar として
  **エンドユーザーから到達可能**になった（旧: 別途ビルドが必要な非同梱 bin）。
  単一 `grimodex.db` に全プロジェクトを持つため、
  read-by-id 系ツールは `server.project_id` でスコープし、クライアントが渡す bare
  id で他プロジェクトを読めないようにすること（§3.9 XPROJ 防御参照）。新規 read-by-id
  ツールを足すときも project_id スコープを必須とする。
- **`--all-projects` のスコープ拡大**: このフラグは接続を **DB 全体**（全プロジェクト）に
  広げる明示オプトイン。`select_project` の許可ゲートは1箇所（pinned 時は拒否）に集約され、
  既定のピン留め＝接続単位の最小権限は壊れない。ただし `--all-projects` を付けた接続は
  全作品にアクセスし得るため **ローカル/信頼クライアント専用**。なおピン留めが守るのは
  「どの作品を見せるか」であり、見せた作品の本文がクラウドへ exfil されること自体は
  防げない（秘匿原稿はクラウド MCP に繋がない/ローカルモデルを使う）。

### ライセンスゲート (Phase 2 / 2026-06-11)

write 系ツールはライセンス状態でも制限する（`--readonly` とは独立した別ゲート）。
`GrimodexServer::ensure_license_allows_write()`（`server.rs`）が、14 の write ツール
（`create_codex_entry` / `update_codex_entry` / `create_snippet` / `propose_scene_body`
/ `create_foreshadow` / `update_foreshadow` / `create_event` / `update_event` /
`delete_event` / `stamp_scene_event` / `unstamp_scene_event` / `set_event_participants`
/ `add_event_relation` / `remove_event_relation`）の冒頭で呼ばれ、制限状態なら
`invalid_params` エラーで一括ブロックする。read 系ツールは常時許可（Phase 2 決定）。

- **制限状態**: `grimodex_core::license::LicenseStatus::is_write_restricted()` が
  `true` を返す `TrialExpired`（試用期限切れ） / `LicenseStale`（最終検証から猶予超過）
  / `Revoked`（キー失効）の 3 状態。`Trial` / `Licensed` / `Grace` では許可。
- **再読み込み**: 呼び出しごとに `license.json` を読み直す（`reload_policy` と同じ思想。
  アプリ側での再アクティベートを MCP 再起動なしで反映する。write 呼び出しは低頻度ゆえ I/O 許容）。
- **パス解決**: `license_gate::resolve_license_file_path()` は、明示された
  `--license-file` が絶対 path であることを検証する。Electron product は main が Backend と
  同じ `<userData>/license.json` を明示注入する。Tauri subcommand / dev で省略した場合だけ、
  `dirs::data_dir()` ＋ `grimodex_core::license::APP_IDENTIFIER` の従来 path に fallback する。
- **fail-soft**: `licensing` feature 無効ビルド（ベータ）、`license.json` の欠損・破損、
  パス解決不能はいずれも **許可側に倒す**（read は default = 試用初期状態を返すため）。
- **ゲート順序**: 各 write ツールは `--readonly`（call-time）→ `ensure_license_allows_write()`
  → 各ツールの AI ポリシー（`knowledgeWrite` / `bodyWrite`）の順に検査する。

### 書き込み制限 (v1)

- シーン本文への書き込みは v1 では無効
  - エディタの in-memory バッファとの競合を回避
  - v2 でファイル監視（`notify` クレート）を導入後に解禁
- Codex エントリの書き込みは許可（条件付き）
  - Codex パネルは `entries` を Zustand ストアにキャッシュし、
    明示的な操作（作成・削除・フィルタ変更）時のみ DB から再読み込みする
  - MCP からの書き込みは Grimodex 側に即座には反映されない
  - **Phase 3 前提タスク**: Codex ストアに DB 変更検知 or 定期リロードを追加し、
    外部書き込みを安全にハンドリングできることを確認してから書き込みツールを有効化する
  - 暫定対応: MCP で Codex を更新した後、ユーザーに Grimodex 側で
    パネルを閉じて開き直す旨を返答メッセージに含める
- 伏線（foreshadow）の書き込みは許可（条件付き）
  - `create_foreshadow` / `update_foreshadow` は Codex と同じ `knowledgeWrite` gate
    （伏線は構造化メタデータ＝知識のため新ポリシーキーを設けず流用）
  - **XPROJ ハードニング**: 本体の `foreshadow_update_impl` は `WHERE id = ?` のみで
    project スコープしない（アプリ内なら安全）。外部ライターである MCP では
    cross-project 書き込みの穴になるため、MCP 版 `update_foreshadow` は
    `WHERE id = ? AND project_id = ?` で必ず絞り、0 件なら not-found エラーを返す
  - `secret` は create の任意パラメータ（既定 true）。既定固定だと
    「作成したのに `list_open_foreshadows` に出ない」不整合になるため公開した
  - payoff 位置アンカー（`payoff_from_pos` 等）はエディタ座標が必要なため MCP では非公開
- DB の `busy_timeout` を 5000ms に設定し、`SQLITE_BUSY` をエラーとして返す

### コンテンツサニタイズ (Stored XSS 防止)

MCP サーバーという外部ライターの追加により、DB 内コンテンツを暗黙的に
信頼できなくなる。Grimodex 本体は DB から読み取ったコンテンツを
Tauri webview 内で描画するため、悪意ある HTML/JS が混入すると
Stored XSS が成立する。

**多層防御:**
- **MCP サーバー側（書き込み時）**: Codex の `content`, `summary`, `notes`
  フィールドに対し、書き込み前に HTML タグをストリップする。
  Markdown として有効なテキストのみを受け付ける
- **Grimodex 本体側（読み取り時）**: DB からの読み取り時にもサニタイズを行う。
  外部ライターが存在する前提のセキュリティモデルに移行する
  （本体側の対応は MCP とは別タスクとして実施）
- `<script>`, `<iframe>`, `<object>`, `<embed>`, `on*` イベントハンドラ属性、
  `javascript:` URI スキームを明示的にブロックする

### FTS5 クエリ制限 (DoS 防止)

`search` ツールはユーザー入力を FTS5 `MATCH` に渡す。
パラメータ化クエリで SQL インジェクションは防げるが、FTS5 エンジン自体が
独自構文（`AND`/`OR`/`NOT`、`*` ワイルドカード）を解釈するため、
複雑なクエリが CPU 負荷を引き起こし、Grimodex 本体の DB パフォーマンスに
悪影響を与える可能性がある。

**対策:**
- クエリ文字列の長さ制限: 最大 500 文字
- ワイルドカード `*` の使用回数制限: 最大 3 個
- `sqlite3_progress_handler` によるクエリタイムアウト: 3 秒
- FTS5 構文エラーはユーザーフレンドリーなメッセージで返す

### 入力バリデーション

- SQL インジェクション防止: パラメータ化クエリのみ使用（`db_execute` パターン踏襲）
- パストラバーサル防止:
  - `scene_id` は UUID 形式のみ受け付け
  - `title` ベースの検索は**必ず DB ルックアップ経由で UUID を解決**し、
    ファイルパスへの直接結合は行わない
- 入力サイズ制限: `content` フィールドは 1MB まで
- Codex `aliases` バリデーション:
  - 1エイリアスあたり最大 100 文字
  - エイリアス数は最大 50 個
  - 制御文字・NULL バイトを拒否
  - FTS5 特殊構文文字（`*`, `"`, `NEAR` 等）はエスケープして格納

---

## 8. 実装フェーズ

### Phase 1: 基盤 + 読み取りツール

1. Cargo ワークスペース構成を作成
2. `rmcp` で stdio MCP サーバーの骨格を実装
3. DB 接続 + Content Dir 読み取りを実装
4. ProseMirror JSON → Markdown 変換器を実装
5. 読み取りツール（20個）を実装:
   - プロジェクト・ツリー: `get_project`, `list_tree`, `read_scene`, `read_scenes_batch`, `get_project_stats`
   - 検索: `search_project`
   - Codex: `list_codex_entries`, `get_codex_entry`, `list_codex_tags`, `search_codex_by_tags`, `find_related_entries`
   - 構成: `get_chapter_summaries`
   - 伏線: `list_open_foreshadows`, `get_foreshadow_detail`
   - タイムライン: `get_scene_timeline_neighbors`
   - チャット: `list_chat_sessions`, `read_chat_history`
   - スニペット: `list_snippets`
   - 統計: `get_attribution_report`
   - コンテキスト集約: `get_writing_context`
6. 書き込みツール（6個）を実装:
   - `create_codex_entry`, `update_codex_entry`
   - `create_snippet`
   - `propose_scene_body`
   - `create_foreshadow`, `update_foreshadow`
7. Claude Code で接続テスト

### Phase 2: 検索 + チャット

1. FTS5 検索ツール `search` を実装（クエリ長制限・タイムアウト含む）
2. チャット履歴ツール `list_chat_sessions`, `read_chat_history` を実装
3. スニペット `list_snippets` を実装
4. `get_attribution_report` を実装
5. MCP Resources を実装

### Phase 3: Codex 書き込み

1. コンテンツサニタイズ層を実装（HTML ストリップ、aliases バリデーション）
2. `create_codex_entry` を実装
3. `update_codex_entry` を実装
4. FTS5 インデックスの同期更新を実装
5. Stored XSS テスト（悪意ある HTML を書き込んで Grimodex 側で無害化されることを確認）
6. 書き込み時の排他制御テスト

### Phase 4: シーン書き込み (v2)

1. Grimodex 本体にファイル監視（`notify` クレート）を追加
2. 外部変更検出時のエディタ再読み込み UI を実装
3. `write_scene`, `create_scene`, `update_scene_metadata` を実装
4. 書き込み時の Content Dir + DB 両方の整合性を保証

---

## 9. 依存クレート（追加分）

```toml
[dependencies]
rmcp = { version = "1.6", features = ["server", "transport-io", "macros"] }
schemars = "1"
rusqlite = { version = "0.39", features = ["bundled"] }
serde = { version = "1", features = ["derive"] }
serde_json = { version = "1", features = ["preserve_order"] }
tokio = { version = "1", features = ["full"] }
clap = { version = "4", features = ["derive"] }
anyhow = "1"
thiserror = "2"
uuid = { version = "1", features = ["v4"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
tracing-appender = "0.2"
dirs = "5"
chrono = "0.4"
```

※ `rmcp` は当初 0.1 系を想定していたが、現状 1.6 系を使用。`macros` フィーチャを
有効化して `#[tool_router]` / `#[tool_handler]` マクロでハンドラを定義している。  
※ ファイルロギング (`tracing-appender`) と HOME ディレクトリ解決 (`dirs`)、
タイムスタンプ整形 (`chrono`) は設計書段階では未列挙だった追加分。

---

## 10. テスト計画

### 単体テスト

- ProseMirror JSON → Markdown 変換の各ノードタイプ
- DB クエリの正確性（テスト用 in-memory DB）
- Content Dir のファイル解決ロジック
- 入力バリデーション（UUID 形式、サイズ制限）

### 統合テスト

- テスト用ワークスペースを作成し、全ツールの動作を確認
- Grimodex 本体と MCP サーバーの同時アクセス（WAL 動作確認）
- `SQLITE_BUSY` 発生時のエラーハンドリング

### E2E テスト

- Claude Code から `.mcp.json` 経由で接続
- 自然言語での操作テスト:
  - 「このプロジェクトの構成を教えて」→ `list_tree` + `get_project`
  - 「田中というキャラを検索して」→ `search` or `list_codex_entries`
  - 「新しいキャラをCodexに追加して」→ `create_codex_entry`
