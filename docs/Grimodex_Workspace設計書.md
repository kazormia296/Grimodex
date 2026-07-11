# Grimodex Workspace 設計書

## 概要

本書は **Workspace** という概念の定義と、その階層構造の拡張方針を扱う。

現状の Grimodex は「1 つの Workspace = 1 つの小説（Project）」として運用されている。
本拡張では Workspace を **複数の小説をまとめる入れ物** として再定義し、

```
Workspace ─┬─ Project A（小説 1）─┬─ Folder（章）─ Scene / Note …
           │                      └─ Codex / Snippet / Chat …
           ├─ Project B（小説 2）─ …
           └─ Project C（小説 3）─ …
```

という **Workspace → Project → Folders/Scenes** の階層を実現する。

### 目的・想定ユースケース

- **シリーズもの執筆**：同じ世界観・キャラクターを共有する複数巻を 1 つの Workspace に置く。
- **作品の整理**：1 人の作者が抱える複数の小説を 1 箇所で管理する。
- **Codex の再利用**：同一 Workspace 内の Project 間で、キャラクター・世界観などの
  Codex を新規 Project 作成時にコピー（シード）して引き継ぐ。

### 重要な前提

DB スキーマは **既に多 Project 対応済み** である。`projects` テーブルが存在し、
`tree_nodes` / `codex_*` / `snippets` / `chat_*` などの Project スコープテーブルは
すべて `project_id` 外部キーを持つ。したがって本拡張は **スキーマ変更を伴わない**
（Phase 1〜2 の範囲）。実体は **フロントエンドの単一 Project 前提を解消するリファクタ** である。

---

## 現状と課題

### Workspace は「ファイルシステム上のディレクトリ」

Workspace は DB エンティティではない。実体は以下を含むディレクトリ：

- `grimodex.db` — SQLite データベース（WAL モード、FTS5 有効）。Workspace に 1 つ。
- `.grimodex/workspace.json` — `WorkspaceMeta`（`id` + `created_at`）。

`open_workspace` Tauri コマンド（`src-tauri/src/commands/workspace.rs`）が
ディレクトリ内の `grimodex.db` を検証して開く。`grimodex.db` 1 ファイルの中に
**複数の Project を格納できる**設計だが、現状は 1 つしか作られていない。

### 「Workspace = Project」は UX 上の制約にすぎない

スキーマは多 Project 対応済みなのに、フロントエンドが単一 Project を前提にしている：

1. **`DEFAULT_PROJECT_ID = "default-project"` の直書きが散在**
   - 専用定数 `src/features/project/constants.ts` の `PROJECT_ID` のほか、
     `codex/codexStore.ts` / `tree/treeStore.ts` / `chat/ChatHistoryPanel.tsx` で
     同名定数が**重複定義**されている。
   - さらに約 40 箇所でリテラル `"default-project"` が直書きされている。

2. **`projectId` で絞らないクエリ（潜在バグ）**
   - `codex/api.ts` の `listCodexEntries` と `snippets/api.ts` の `listSnippets` は
     `project_id` で絞らず**全件返す**。Project が 1 つしかない現状では露見しないが、
     2 つ目の Project ができた瞬間に他 Project のデータが混入する。

3. **「現在の Project」を保持する明示的な状態がない**
   - de-facto の current project は `useTreeStore.getState().projectId`。
     `loadTree(projectId)` 実行時にセットされ、Grid / Label / Foreshadow / Trash などは
     そこから `projectId` を読んでいる。Tree のロードに暗黙的に依存した脆い構造。

### Project 作成行の起点

`grimodex.db` 初期化時、Rust マイグレーション
（`src-tauri/crates/grimodex-db/src/migrate.rs`）が
`INSERT OR IGNORE INTO projects ... VALUES ('default-project', ...)` で
`default-project` 行を常設する。サンプルワークスペース生成時のみ
`src-tauri/src/commands/onboarding.rs` が独自 `project_id` で置き換える。

---

## 用語と階層定義

| 用語 | 実体 | 備考 |
|---|---|---|
| **Workspace** | FS ディレクトリ（`grimodex.db` + `.grimodex/workspace.json`） | DB エンティティではない。複数 Project の入れ物 |
| **Project** | `projects` テーブルの 1 行 | 1 つの小説。`grimodex.db` 内に複数持てる |
| **Folder** | `tree_nodes` 行（`node_type='folder'`） | 章 = ルート Folder（`parent_id IS NULL`）。入れ子可 |
| **Scene** | `tree_nodes` 行（`node_type='scene'`） | 本文を持つ葉ノード |
| **Note** | `tree_nodes` 行（`node_type='note'`） | Scene の兄弟。本文を持つ |

Project 配下の Folder/Scene/Note は `tree_nodes` の自己参照ツリーで表現される。
専用の「Chapter」エンティティは存在せず、章はルート Folder として扱う。

---

## データモデル

### projects テーブル

`src/db/schema.ts` の `projects`：`id` / `title` / `genre` / `pov` / `tense` /
`language` / `styleGuide` / `aiInstructions` / `outline` / `phaseResolutionMode` /
`aiPolicy` / `createdAt` / `updatedAt`。

### Project スコープのテーブル群

以下は `project_id` 外部キー（`ON DELETE CASCADE`）で Project に紐づく：
`tree_nodes` / `codex_types` / `codex_entries` / `codex_tags` /
`codex_detail_definitions` / `snippets` / `chat_sessions` / `labels` /
`foreshadows` / `lint_term_dictionary` / `post_effect_runs` /
`post_effect_annotations` / `project_snapshots` / `map_boards` /
`trash_items` / `project_settings` ほか。

孫テーブル（`chat_messages`、`codex_detail_values`、`map_*` の子など）は
親経由で Project にカスケードする。

### codex_entries の type は複合外部キー

Codex シード（Phase 3）の設計上、重要な性質：

- `codex_entries.type` 列には codex type の **スラグ**が入る。
- 複合 FK：`(project_id, type) → codex_types(project_id, slug)`
  （`ON UPDATE CASCADE` / `ON DELETE RESTRICT`）。
- `codex_detail_definitions` も `(project_id, type_slug) → codex_types(project_id, slug)`
  の複合 FK を持つ。

→ ある type を同じスラグで別 Project にコピーすれば、その type に属する
`codex_entries` の `type` 列は無変更のまま FK が解決する（remap 不要）。

### スキーマ変更の要否

- **Phase 1〜2：スキーマ変更なし。** 既存の `project_id` スコープをそのまま使う。
- **Phase 3（Codex シード）：スキーマ変更なし。** シードは既存テーブルへの行コピー。

---

## 設計判断

### 5.1 `currentProjectId` を明示的な単一情報源にする

現状 current project は `treeStore.projectId` に暗黙的に宿っている。これを
**専用ストア `useProjectStore` の `currentProjectId`** に昇格させ、全機能が
そこを単一の参照点とする。

- **理由**：Tree のロード完了に依存した暗黙状態は、Project 切替（Phase 2）で破綻する。
  切替の起点となる明示的な状態が必要。
- **影響**：`DEFAULT_PROJECT_ID` の直書き約 40 箇所を `useProjectStore` 読みに置換する。

### 5.2 Codex 共有は「新規 Project 作成時の type 単位コピー（シード）」

同一 Workspace 内の Project 間で Codex を引き継ぐ手段として、
**新規 Project 作成時に、コピー元 Project から codex type を選んで複製する**
方式を採用する。ライブ参照（編集が双方に伝播する仕組み）は採らない。

- **粒度**：codex type 単位で選択（例：「キャラクターだけ」「世界観だけ」）。
- **根拠**：
  - `codex_entries.project_id` を必須のまま保てる → スキーマのスコープ設計を変えない。
  - Project の独立性を維持できる（巻ごとに Codex が閉じる）。
- **トレードオフ（明示的に受容）**：コピーなので**分岐**する。シード後にコピー元を
  編集してもシード先には伝播しない。シリーズもので「同一人物のはずなのに差分が出る」
  のは弱点だが、v1 として割り切る。

### 5.3 検討した代替案

| 案 | 内容 | 判定 |
|---|---|---|
| ライブ参照 | `codex_entries.project_id` を nullable 化、または junction テーブルで Project 跨ぎ参照 | **却下**。スコープ設計全体に波及。全クエリ・全機能が「自 Project + 共有」を意識する必要が生じる |
| シード時に全 Codex コピー | コピー元の Codex を丸ごと複製 | **却下**。不要なエントリまで運ぶ。type 単位選択を採用 |
| エントリ個別選択 | ツリーで個々のエントリをチェック | **却下**。ダイアログ UI が過大。type 単位が UI コストと柔軟性のバランス点 |

---

## アーキテクチャ

### useProjectStore

**新規** `src/features/project/projectStore.ts`。Zustand ストア。

| メンバ | 役割 |
|---|---|
| `currentProjectId: string \| null` | 現在の Project。全機能の単一参照点 |
| `initCurrentProject()` | `listProjects()` で既存 Project を 1 件選び `currentProjectId` にセット。リテラル `"default-project"` 依存をここ 1 箇所に閉じる |
| `setCurrentProject(id)` | current project を切り替える。Phase 1 では `initCurrentProject` 経由のみ。Phase 2 の切替 UI が使う |
| `loadProject(projectId)` | `setCurrentProject` + Project メタデータ適用（言語・phaseResolutionMode）。Phase 2 で「mount 済みパネルの再ロード」まで拡張する |

### projectId 配線

`project_id` で絞っていないクエリ／ストアを修正し、`currentProjectId` を流す。
`listProjects` / `createProject` 等の Project CRUD は `src/features/project/api.ts`
に既存のものを再利用する。

### ブートストラップ順序

`openWorkspace`（`src/features/workspace/store.ts`）で、`grimodex.db` オープン確定後・
editor ビュー描画前に `initCurrentProject()` を `await` する。これにより
editor 描画時には `currentProjectId` が確定済みとなり、各パネルが安全に読める。

### 既知の制約

Map / Timeline / Matrix の状態は global settings（cross-workspace）に永続化されており、
Project スコープを持たない。Phase 1 では現状維持とし、Phase 2 で per-project 化の
要否を判断する。

---

## フェーズ計画

| Phase | 内容 | ユーザー可視 |
|---|---|---|
| **Phase 1** | 基盤配線。`useProjectStore` 導入、`projectId` 全配線、`codex`/`snippet` 潜在バグ修正 | なし（純リファクタ） |
| **Phase 2** | `projects` CRUD UI、新規 Project ダイアログ、Project 切替 UI、`loadProject` の切替対応拡張 | あり |
| **Phase 3** | 新規 Project 作成時の Codex type 単位シード | あり |

---

## Phase 1 詳細仕様

UI 上は引き続き 1 Project のまま。純リファクタ + `codex`/`snippet` の潜在リーク修正。

### P1-1. `useProjectStore` の新設と重複定数の削除

- `src/features/project/projectStore.ts` を新規作成（上記アーキテクチャ参照）。
- `src/features/project/constants.ts` の `PROJECT_ID` は `initCurrentProject` の
  フォールバックリテラルとして残す。
- `codexStore` / `treeStore` / `ChatHistoryPanel` の重複 `DEFAULT_PROJECT_ID` 定数を削除。

### P1-2. projectId 配線（潜在バグ修正）

- `codex/api.ts` `listCodexEntries(projectId, type?)`：`WHERE project_id = ?` を追加。
- `snippets/api.ts` `listSnippets(projectId, sceneId?)`：`WHERE project_id = ?` を追加。
- `codexStore` / `snippetStore` のロード系（`loadEntries` / `search` / `setFilterType` /
  `create`）が `currentProjectId` を読む。
- `revision/projectSnapshotApi.ts` の `PROJECT_ID` 直書きを除去。
- PK(id) ベースの getter（`getNode` / `getCodexEntry` / `getSnippet`）は UUID 主キーで
  Project 跨ぎの衝突がないため修正不要。

### P1-3. ハードコード `"default-project"` の全置換

約 40 箇所のリテラル直書きを `useProjectStore` 読みに置換（Lint / Tree / Map /
Foreshadow / Codex / Export-Import / Command Center / Editor / Trash / Settings /
Snippet / screenshotBootstrap 各所）。テストや `browser-mock.ts` の seed リテラルは対象外。

### P1-4. ブートストラップ集約

- `App.tsx` の `getProject("default-project")`（言語・phaseResolutionMode 適用）を
  `loadProject(currentProjectId)` に集約。
- `openWorkspace` で `initCurrentProject()` を `await`。

### P1 の非対象

Project 切替 UI / CRUD UI（Phase 2）、Codex シード（Phase 3）、Map/Timeline/Matrix の
per-project 化、Rust 側の変更（`default-project` 常設はそのまま）。

---

## Phase 2 / 3 方針

### Phase 2：Project CRUD UI と切替

- 既存 `src/features/project/api.ts` の CRUD を UI に接続。
- 新規 Project ダイアログ（タイトル・ジャンル等のメタ入力）。
- Project 切替 UI（一覧 + 選択）。
- `loadProject` を拡張し、切替時に mount 済みパネルの状態を破棄→再構築
  （tree / codex / snippet / chat / grid / map / foreshadow / trash の再ロード）。
  Project 切替は実質「Workspace 再オープンの Project 版」に相当する。

### Phase 3：Codex type 単位シード

- 新規 Project ダイアログに「コピー元 Project + codex type 選択」を追加。
- シードは選択 type について以下を複製し、`id` / `parentId` / `entryId` /
  `definitionId` を remap する：
  `codex_types` → `codex_detail_definitions` → 該当 `codex_entries` →
  `codex_detail_values`。
- `codex_entries.type` 列はスラグなので、type を同スラグでコピーすれば
  複合 FK が無変更で解決する（データモデル節参照）。

---

## 検証方針

- `npx tsc --noEmit` / `pnpm lint:fix` — 型・lint クリーン。
- `pnpm test` — 既存テスト。テスト環境は `default-project` を seed するため
  `initCurrentProject` はそれを返し、挙動は不変。
- **新規テスト**：2 つ目の Project 行と双方の codex/snippet を作り、
  `listCodexEntries` / `listSnippets` が `currentProjectId` 側のみ返すことを検証
  （潜在リークバグ修正の回帰防止）。
- `pnpm electron:dev` — ワークスペースを開き、tree / codex / snippet / chat / grid /
  map / foreshadow / trash / lint が従来どおり表示されることを目視確認。

---

## 関連ドキュメント

- `docs/Grimodex_統合DBスキーマ.md` — DB スキーマの Single Source of Truth。
- `docs/Grimodex_Scenesパネル設計書.md` — `tree_nodes` ツリーの詳細。
- `docs/Grimodex_Codexパネル設計書.md` — Codex の型・詳細定義・Phase の詳細。
- `docs/adr/002-phase-resolution-modes.md` — `projects.phaseResolutionMode` の設計判断。
