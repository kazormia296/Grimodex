# プロットスレッド・タイムライン 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 名前付きプロットスレッドを TimelinePanel に「N 本の横レーン」として描き、各シーンに段階マーカー（introduce/develop/turn/climax/resolve）を置けるようにする。

**Architecture:** 専用テーブル `plot_threads` + `plot_thread_scene_links` を新設（Rust migrate.rs + Drizzle schema.ts）。Tauri コマンド群で CRUD し、`plotThreadStore`（zustand）が project スコープでロード。純関数 `plotThreadLaneModel` がスレッド×リンク×シーン順序からレーン描画モデルを生成し、既存 `TimelineViewport` を 2 レーン固定から `laneY(index)` の N レーンへ一般化して threads 表示モードを追加する。**新 PanelId は追加しない**（パネル登録ゼロ）。

**Tech Stack:** Tauri v2 / Rust (rusqlite, anyhow, thiserror) / React 19 / TypeScript strict / Zustand / Drizzle ORM / Vitest / SVG。

## Global Constraints

- ES modules のみ（CommonJS 禁止）、2 スペースインデント、TypeScript strict。
- React は関数コンポーネント + hooks。グローバル状態=Zustand。
- DB 操作は Drizzle ORM 経由（生 SQL は Rust コマンド内のみ）。
- Rust は `unwrap()` 禁止、`thiserror`/`anyhow` 使用。
- テストは Vitest、ソースと同階層に `*.test.ts(x)`。
- 設計ドキュメント・コメント・UI 文字列はすべて日本語ベース（UI 文字列は ja/en 両 locale）。
- ブランチ: `feat/plot-thread-timeline`（master 直 commit 禁止）。
- 新規 `PanelId` を **追加しない**（`validateLayoutState` ゲートを避ける。すべて TimelinePanel 内に収める）。
- `phase_type` enum は初版確定 = `introduce | develop | turn | climax | resolve`（CHECK 制約。後から広げると table rebuild）。
- 並び順キーは base62 fractional-index TEXT（`@/features/tree/fractionalIndex`、`cmpKeys` で辞書順比較）。treeNodes.sortOrder と同じ idiom。
- Rust テストは `cd src-tauri && cargo test --no-default-features`（default features だとローカルリンク失敗）。検証は最低 `cargo check --tests` まで（test 実行は CI / 自己検証 worktree）。

---

## ファイル構成

| ファイル | 責務 | 新規/変更 |
| --- | --- | --- |
| `src-tauri/src/database/migrate.rs` | 2 テーブルの DDL（`migrate()` の execute_batch に追記） | 変更 |
| `src/db/schema.ts` | Drizzle 定義 + 型 export | 変更 |
| `src-tauri/src/commands/plot_threads.rs` | Tauri CRUD コマンド | 新規 |
| `src-tauri/src/commands/mod.rs` | モジュール登録 | 変更 |
| `src-tauri/src/lib.rs` | invoke_handler 登録 | 変更 |
| `src/features/plot-threads/api.ts` | invoke ラッパ + 型 + 正規化 + Drizzle fallback | 新規 |
| `src/features/plot-threads/plotThreadStore.ts` | zustand store（load/CRUD/stale ガード） | 新規 |
| `src/features/plot-threads/plotThreadLaneModel.ts` | 純関数: レーン描画モデル生成 | 新規 |
| `src/features/timeline/timelineStore.ts` | `viewMode` 追加 + 永続化 | 変更 |
| `src/features/timeline/TimelineViewport.tsx` | `laneY` 一般化 + threads モード描画 | 変更 |
| `src/features/timeline/TimelineHeader.tsx` | view 切替トグル + スレッド追加ボタン | 変更 |
| `src/features/timeline/TimelineInspector.tsx` | マーカー/スレッド編集 | 変更 |
| `src/features/timeline/TimelineContextMenu.tsx` | マーカー追加/スレッド削除 | 変更 |
| `src/i18n/locales/{ja,en}.json`（実パスは既存 locale に合わせる） | 新規文字列 | 変更 |

---

## Task 1: DB マイグレーション（2 テーブル）

**Files:**
- Modify: `src-tauri/src/database/migrate.rs`（`fn migrate(&self)` 内の `execute_batch` SQL に追記）
- Test: `src-tauri/src/database/migrate.rs`（`#[cfg(test)]` モジュール）

**Interfaces:**
- Produces: テーブル `plot_threads`(id, project_id, name, color, description, sort_order, created_at, updated_at) と `plot_thread_scene_links`(id, thread_id, node_id, phase_type, note, sort_order, created_at, updated_at)。`phase_type` は CHECK enum。

- [ ] **Step 1: 既存テストの近くに、テーブル作成と CHECK 制約を検証する失敗テストを書く**

`migrate.rs` の `#[cfg(test)] mod tests` に追記（既存のテスト用 DB セットアップヘルパに合わせる。無ければ `Database::open_in_memory()` 等の既存パターンを流用）:

```rust
#[test]
fn plot_thread_tables_exist_and_enforce_phase_type() {
    let db = test_db(); // 既存のインメモリ DB 構築ヘルパ
    // 1) テーブルが作られている
    let threads = db
        .execute("SELECT count(*) AS c FROM plot_threads", &[], "get")
        .expect("plot_threads should exist");
    assert!(threads.first().is_some());
    let links = db
        .execute("SELECT count(*) AS c FROM plot_thread_scene_links", &[], "get")
        .expect("plot_thread_scene_links should exist");
    assert!(links.first().is_some());

    // 2) 正常な phase_type は挿入できる（FK のためダミー thread/scene を用意）
    db.execute(
        "INSERT INTO plot_threads (id, project_id, name, sort_order, created_at, updated_at) \
         VALUES ('t1','p1','Thread 1','a0', datetime('now'), datetime('now'))",
        &[], "run",
    ).unwrap();
    db.execute(
        "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order) \
         VALUES ('s1','p1','scene','Scene 1','a0')",
        &[], "run",
    ).ok(); // tree_nodes の必須列は既存スキーマに合わせる
    let ok = db.execute(
        "INSERT INTO plot_thread_scene_links (id, thread_id, node_id, phase_type, created_at, updated_at) \
         VALUES ('l1','t1','s1','introduce', datetime('now'), datetime('now'))",
        &[], "run",
    );
    assert!(ok.is_ok(), "valid phase_type must insert");

    // 3) 不正な phase_type は CHECK 制約で弾かれる
    let bad = db.execute(
        "INSERT INTO plot_thread_scene_links (id, thread_id, node_id, phase_type, created_at, updated_at) \
         VALUES ('l2','t1','s1','BOGUS', datetime('now'), datetime('now'))",
        &[], "run",
    );
    assert!(bad.is_err(), "invalid phase_type must be rejected by CHECK");
}
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `cd src-tauri && cargo test --no-default-features plot_thread_tables_exist`
Expected: FAIL（`no such table: plot_threads`）

- [ ] **Step 3: `migrate()` の execute_batch SQL に 2 つの CREATE TABLE を追記**

`codex_entry_phases`（migrate.rs:335 付近）のブロックと同じ形式で、`execute_batch` に渡す SQL 文字列の末尾へ追加:

```sql
CREATE TABLE IF NOT EXISTS plot_threads (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL DEFAULT '',
    color       TEXT,
    description TEXT,
    sort_order  TEXT NOT NULL DEFAULT 'a0',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_plot_threads_project
    ON plot_threads(project_id);

CREATE TABLE IF NOT EXISTS plot_thread_scene_links (
    id          TEXT PRIMARY KEY,
    thread_id   TEXT NOT NULL REFERENCES plot_threads(id) ON DELETE CASCADE,
    node_id     TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    phase_type  TEXT NOT NULL
                  CHECK(phase_type IN ('introduce','develop','turn','climax','resolve')),
    note        TEXT,
    sort_order  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_plot_thread_links_thread
    ON plot_thread_scene_links(thread_id);
CREATE INDEX IF NOT EXISTS idx_plot_thread_links_node
    ON plot_thread_scene_links(node_id);
```

注: `execute_batch` は `CREATE TABLE IF NOT EXISTS` で冪等。FK を効かせるため、既存 migrate がすでに `PRAGMA foreign_keys = ON` を設定していることを前提（設定済みでなければ CHECK のみ確実に効く。CHECK テストはどちらでも通る）。

- [ ] **Step 4: テストを走らせて通過を確認**

Run: `cd src-tauri && cargo test --no-default-features plot_thread_tables_exist`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add src-tauri/src/database/migrate.rs
git commit -m "feat(plot-thread): plot_threads / plot_thread_scene_links テーブルを追加"
```

---

## Task 2: Drizzle スキーマ定義

**Files:**
- Modify: `src/db/schema.ts`（`codexRelations` 定義の近くに追記）
- Test: なし（型のみ。tsc で検証）

**Interfaces:**
- Produces: `plotThreads` / `plotThreadSceneLinks` テーブルオブジェクトと `PlotThread`/`NewPlotThread`/`PlotThreadSceneLink`/`NewPlotThreadSceneLink` 型。

- [ ] **Step 1: schema.ts に定義を追加**

`codexRelations`（schema.ts:1132 付近）の FK テンプレに倣う:

```typescript
/** Plottr 型プロットスレッド = タイムライン上の名前付き横レーン。 */
export const plotThreads = sqliteTable(
  "plot_threads",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull().default(""),
    color: text("color"),
    description: text("description"),
    // レーン縦順の fractional-index（base62、辞書順比較）
    sortOrder: text("sort_order").notNull().default("a0"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index("idx_plot_threads_project").on(table.projectId)],
);

/** スレッドが特定シーンで踏む段階マーカー。 */
export const plotThreadSceneLinks = sqliteTable(
  "plot_thread_scene_links",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => plotThreads.id, { onDelete: "cascade" }),
    nodeId: text("node_id")
      .notNull()
      .references(() => treeNodes.id, { onDelete: "cascade" }),
    // 'introduce' | 'develop' | 'turn' | 'climax' | 'resolve'（CHECK は SQL 側）
    phaseType: text("phase_type").notNull(),
    note: text("note"),
    sortOrder: text("sort_order"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_plot_thread_links_thread").on(table.threadId),
    index("idx_plot_thread_links_node").on(table.nodeId),
  ],
);

export type PlotThread = typeof plotThreads.$inferSelect;
export type NewPlotThread = typeof plotThreads.$inferInsert;
export type PlotThreadSceneLink = typeof plotThreadSceneLinks.$inferSelect;
export type NewPlotThreadSceneLink = typeof plotThreadSceneLinks.$inferInsert;

/** マーカー段階の正準 enum と表示順序。 */
export const PLOT_PHASE_TYPES = [
  "introduce",
  "develop",
  "turn",
  "climax",
  "resolve",
] as const;
export type PlotPhaseType = (typeof PLOT_PHASE_TYPES)[number];
```

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 3: commit**

```bash
git add src/db/schema.ts
git commit -m "feat(plot-thread): Drizzle スキーマと型を追加"
```

---

## Task 3: Tauri CRUD コマンド

**Files:**
- Create: `src-tauri/src/commands/plot_threads.rs`
- Modify: `src-tauri/src/commands/mod.rs`（`pub(crate) mod plot_threads;`）
- Modify: `src-tauri/src/lib.rs`（invoke_handler に 7 コマンド登録）
- Test: `src-tauri/src/commands/plot_threads.rs`（`#[cfg(test)]`）

**Interfaces:**
- Consumes: `with_db`, `AppError`, `WorkspaceState`（`commands/mod.rs`）、`database::Database::execute`。
- Produces: コマンド `plot_thread_create / plot_thread_update / plot_thread_delete / plot_thread_list / plot_thread_link_create / plot_thread_link_update / plot_thread_link_delete`。すべて `project_id` または親 `thread_id` スコープ。

- [ ] **Step 1: 失敗テストを書く（create → list ラウンドトリップ）**

`plot_threads.rs` 末尾に:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    fn db() -> Database {
        let db = Database::open_in_memory().unwrap(); // 既存ヘルパに合わせる
        db.migrate().unwrap();
        db.execute(
            "INSERT INTO projects (id, name) VALUES ('p1','P')",
            &[], "run",
        ).ok();
        db
    }

    #[test]
    fn create_then_list_roundtrips() {
        let d = db();
        let created = plot_thread_create_impl(
            &d,
            PlotThreadCreatePayload {
                project_id: "p1".into(),
                name: "復讐の糸".into(),
                color: Some("#c33".into()),
                description: None,
                sort_order: "a0".into(),
            },
        ).unwrap();
        assert!(created.is_object());
        let rows = plot_thread_list_impl(&d, "p1".into()).unwrap();
        assert_eq!(rows.len(), 1);
    }
}
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `cd src-tauri && cargo test --no-default-features create_then_list_roundtrips`
Expected: FAIL（`plot_threads` モジュール/関数未定義）

- [ ] **Step 3: `plot_threads.rs` を実装**

`foreshadow.rs` の `_impl` + `#[tauri::command]` ペア構造に倣う:

```rust
use super::{with_db, AppError, WorkspaceState};
use crate::database;
use serde_json::Value;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlotThreadCreatePayload {
    pub project_id: String,
    pub name: String,
    pub color: Option<String>,
    pub description: Option<String>,
    pub sort_order: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlotThreadPatch {
    pub name: Option<String>,
    pub color: Option<Option<String>>,
    pub description: Option<Option<String>>,
    pub sort_order: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlotThreadLinkCreatePayload {
    pub thread_id: String,
    pub node_id: String,
    pub phase_type: String,
    pub note: Option<String>,
    pub sort_order: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlotThreadLinkPatch {
    pub node_id: Option<String>,
    pub phase_type: Option<String>,
    pub note: Option<Option<String>>,
    pub sort_order: Option<Option<String>>,
}

const PHASE_TYPES: [&str; 5] = ["introduce", "develop", "turn", "climax", "resolve"];

fn validate_phase(p: &str) -> anyhow::Result<()> {
    if PHASE_TYPES.contains(&p) {
        Ok(())
    } else {
        Err(anyhow::anyhow!("invalid phase_type: {p:?}"))
    }
}

fn one(rows: Vec<serde_json::Map<String, Value>>) -> Value {
    rows.first().cloned().map(Value::Object).unwrap_or(Value::Null)
}

// ───────── thread ─────────

fn plot_thread_create_impl(
    db: &database::Database,
    p: PlotThreadCreatePayload,
) -> anyhow::Result<Value> {
    let now = chrono::Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO plot_threads (id, project_id, name, color, description, sort_order, created_at, updated_at)\n         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String(id.clone()),
            Value::String(p.project_id),
            Value::String(p.name),
            p.color.map(Value::String).unwrap_or(Value::Null),
            p.description.map(Value::String).unwrap_or(Value::Null),
            Value::String(p.sort_order),
            Value::String(now.clone()),
            Value::String(now),
        ],
        "run",
    )?;
    Ok(one(db.execute(
        "SELECT * FROM plot_threads WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?))
}

#[tauri::command]
pub(crate) fn plot_thread_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: PlotThreadCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| plot_thread_create_impl(db, payload))
}

fn plot_thread_update_impl(
    db: &database::Database,
    id: String,
    patch: PlotThreadPatch,
) -> anyhow::Result<Value> {
    let mut sets: Vec<&str> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    if let Some(name) = patch.name {
        sets.push("name = ?");
        params.push(Value::String(name));
    }
    if let Some(color) = patch.color {
        sets.push("color = ?");
        params.push(color.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(desc) = patch.description {
        sets.push("description = ?");
        params.push(desc.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(so) = patch.sort_order {
        sets.push("sort_order = ?");
        params.push(Value::String(so));
    }
    if sets.is_empty() {
        return Ok(one(db.execute(
            "SELECT * FROM plot_threads WHERE id = ?",
            &[Value::String(id)],
            "get",
        )?));
    }
    sets.push("updated_at = ?");
    params.push(Value::String(chrono::Utc::now().to_rfc3339()));
    params.push(Value::String(id.clone()));
    let sql = format!("UPDATE plot_threads SET {} WHERE id = ?", sets.join(", "));
    db.execute(&sql, &params, "run")?;
    Ok(one(db.execute(
        "SELECT * FROM plot_threads WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?))
}

#[tauri::command]
pub(crate) fn plot_thread_update(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
    patch: PlotThreadPatch,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| plot_thread_update_impl(db, id, patch))
}

#[tauri::command]
pub(crate) fn plot_thread_delete(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        db.execute("DELETE FROM plot_threads WHERE id = ?", &[Value::String(id)], "run")?;
        Ok(())
    })
}

fn plot_thread_list_impl(db: &database::Database, project_id: String) -> anyhow::Result<Vec<Value>> {
    let rows = db.execute(
        "SELECT * FROM plot_threads WHERE project_id = ? ORDER BY sort_order ASC",
        &[Value::String(project_id)],
        "all",
    )?;
    Ok(rows.into_iter().map(Value::Object).collect())
}

#[tauri::command]
pub(crate) fn plot_thread_list(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
) -> Result<Vec<Value>, AppError> {
    with_db(&ws_state, |db| plot_thread_list_impl(db, project_id))
}

// ───────── link ─────────

fn plot_thread_link_create_impl(
    db: &database::Database,
    p: PlotThreadLinkCreatePayload,
) -> anyhow::Result<Value> {
    validate_phase(&p.phase_type)?;
    let now = chrono::Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO plot_thread_scene_links (id, thread_id, node_id, phase_type, note, sort_order, created_at, updated_at)\n         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String(id.clone()),
            Value::String(p.thread_id),
            Value::String(p.node_id),
            Value::String(p.phase_type),
            p.note.map(Value::String).unwrap_or(Value::Null),
            p.sort_order.map(Value::String).unwrap_or(Value::Null),
            Value::String(now.clone()),
            Value::String(now),
        ],
        "run",
    )?;
    Ok(one(db.execute(
        "SELECT * FROM plot_thread_scene_links WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?))
}

#[tauri::command]
pub(crate) fn plot_thread_link_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: PlotThreadLinkCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| plot_thread_link_create_impl(db, payload))
}

fn plot_thread_link_update_impl(
    db: &database::Database,
    id: String,
    patch: PlotThreadLinkPatch,
) -> anyhow::Result<Value> {
    if let Some(ref pt) = patch.phase_type {
        validate_phase(pt)?;
    }
    let mut sets: Vec<&str> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    if let Some(node_id) = patch.node_id {
        sets.push("node_id = ?");
        params.push(Value::String(node_id));
    }
    if let Some(pt) = patch.phase_type {
        sets.push("phase_type = ?");
        params.push(Value::String(pt));
    }
    if let Some(note) = patch.note {
        sets.push("note = ?");
        params.push(note.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(so) = patch.sort_order {
        sets.push("sort_order = ?");
        params.push(so.map(Value::String).unwrap_or(Value::Null));
    }
    if sets.is_empty() {
        return Ok(one(db.execute(
            "SELECT * FROM plot_thread_scene_links WHERE id = ?",
            &[Value::String(id)],
            "get",
        )?));
    }
    sets.push("updated_at = ?");
    params.push(Value::String(chrono::Utc::now().to_rfc3339()));
    params.push(Value::String(id.clone()));
    let sql = format!("UPDATE plot_thread_scene_links SET {} WHERE id = ?", sets.join(", "));
    db.execute(&sql, &params, "run")?;
    Ok(one(db.execute(
        "SELECT * FROM plot_thread_scene_links WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?))
}

#[tauri::command]
pub(crate) fn plot_thread_link_update(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
    patch: PlotThreadLinkPatch,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| plot_thread_link_update_impl(db, id, patch))
}

#[tauri::command]
pub(crate) fn plot_thread_link_delete(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        db.execute(
            "DELETE FROM plot_thread_scene_links WHERE id = ?",
            &[Value::String(id)],
            "run",
        )?;
        Ok(())
    })
}
```

注: link の list は thread 単位ではなく project 単位でまとめて取りたい（store が全レーン分を一度に必要とするため）。`plot_thread_list_links` を project スコープで追加:

```rust
#[tauri::command]
pub(crate) fn plot_thread_list_links(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
) -> Result<Vec<Value>, AppError> {
    with_db(&ws_state, |db| {
        let rows = db.execute(
            "SELECT l.* FROM plot_thread_scene_links l \
             JOIN plot_threads t ON t.id = l.thread_id \
             WHERE t.project_id = ?",
            &[Value::String(project_id)],
            "all",
        )?;
        Ok(rows.into_iter().map(Value::Object).collect())
    })
}
```

- [ ] **Step 4: mod.rs と lib.rs に登録**

`src-tauri/src/commands/mod.rs` の mod 宣言群に:
```rust
pub(crate) mod plot_threads;
```

`src-tauri/src/lib.rs` の `tauri::generate_handler![...]` に:
```rust
    commands::plot_threads::plot_thread_create,
    commands::plot_threads::plot_thread_update,
    commands::plot_threads::plot_thread_delete,
    commands::plot_threads::plot_thread_list,
    commands::plot_threads::plot_thread_link_create,
    commands::plot_threads::plot_thread_link_update,
    commands::plot_threads::plot_thread_link_delete,
    commands::plot_threads::plot_thread_list_links,
```

- [ ] **Step 5: テストを走らせて通過 + clippy**

Run: `cd src-tauri && cargo test --no-default-features create_then_list_roundtrips && cargo clippy --all-targets`
Expected: PASS / clippy warning なし（CI は `-D warnings`。引数 8 個超で `too_many_arguments` が出たら関数を payload struct 受けに保つ＝既にその形）

- [ ] **Step 6: commit**

```bash
git add src-tauri/src/commands/plot_threads.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(plot-thread): Tauri CRUD コマンド(thread/link)を追加"
```

---

## Task 4: JS API ラッパ + 型 + 正規化

**Files:**
- Create: `src/features/plot-threads/api.ts`
- Test: `src/features/plot-threads/api.test.ts`

**Interfaces:**
- Consumes: Task 3 のコマンド、Task 2 の `plotThreads`/`plotThreadSceneLinks`/`PlotPhaseType`。
- Produces:
  - 型 `PlotThreadRow { id, projectId, name, color, description, sortOrder, createdAt, updatedAt }`
  - 型 `PlotThreadLinkRow { id, threadId, nodeId, phaseType, note, sortOrder, createdAt, updatedAt }`
  - `createPlotThread / updatePlotThread / deletePlotThread / listPlotThreads`
  - `createPlotThreadLink / updatePlotThreadLink / deletePlotThreadLink / listPlotThreadLinks`

- [ ] **Step 1: 失敗テストを書く**

`api.test.ts`（既存 `foreshadow/api.test.ts` の db mock パターンに合わせる。**snake_case の行を mock する**こと）:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(), isTauriRuntime: () => false }));

import * as schema from "@/db/schema";
import { listPlotThreads } from "./api";
// 既存テストの db mock（drizzle）に合わせて threads を1件返す mock を構築

describe("plot-threads api", () => {
  it("normalizes snake_case rows from db into camelCase rows", async () => {
    // db.select... が [{ id, project_id, name, sort_order, created_at, updated_at }] を返すよう mock
    const rows = await listPlotThreads("p1");
    expect(rows[0]).toMatchObject({ projectId: "p1", sortOrder: expect.any(String) });
  });
});
```

- [ ] **Step 2: テストを走らせて失敗確認**

Run: `pnpm test --run src/features/plot-threads/api.test.ts`
Expected: FAIL（モジュール未作成）

- [ ] **Step 3: `api.ts` を実装（foreshadow/api.ts のパターン）**

```typescript
import { invoke } from "@/lib/tauri";
import { isTauriRuntime } from "@/lib/tauri";
import { db } from "@/db/client"; // 既存の drizzle クライアント import に合わせる
import { plotThreads, plotThreadSceneLinks } from "@/db/schema";
import type { PlotPhaseType } from "@/db/schema";
import { eq } from "drizzle-orm";

export interface PlotThreadRow {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
  description: string | null;
  sortOrder: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlotThreadLinkRow {
  id: string;
  threadId: string;
  nodeId: string;
  phaseType: PlotPhaseType;
  note: string | null;
  sortOrder: string | null;
  createdAt: string;
  updatedAt: string;
}

function s(v: unknown, fallback = ""): string {
  return v == null ? fallback : String(v);
}
function nullable(v: unknown): string | null {
  return v == null ? null : String(v);
}

function normalizeThread(raw: unknown): PlotThreadRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: s(r.id),
    projectId: s(r.projectId ?? r.project_id),
    name: s(r.name),
    color: nullable(r.color),
    description: nullable(r.description),
    sortOrder: s(r.sortOrder ?? r.sort_order, "a0"),
    createdAt: s(r.createdAt ?? r.created_at),
    updatedAt: s(r.updatedAt ?? r.updated_at),
  };
}

function normalizeLink(raw: unknown): PlotThreadLinkRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: s(r.id),
    threadId: s(r.threadId ?? r.thread_id),
    nodeId: s(r.nodeId ?? r.node_id),
    phaseType: s(r.phaseType ?? r.phase_type, "develop") as PlotPhaseType,
    note: nullable(r.note),
    sortOrder: nullable(r.sortOrder ?? r.sort_order),
    createdAt: s(r.createdAt ?? r.created_at),
    updatedAt: s(r.updatedAt ?? r.updated_at),
  };
}

// ───── threads ─────

export async function createPlotThread(data: {
  projectId: string;
  name: string;
  color?: string | null;
  description?: string | null;
  sortOrder: string;
}): Promise<PlotThreadRow> {
  if (isTauriRuntime()) {
    const created = await invoke("plot_thread_create", {
      payload: {
        projectId: data.projectId,
        name: data.name,
        color: data.color ?? null,
        description: data.description ?? null,
        sortOrder: data.sortOrder,
      },
    });
    return normalizeThread(created);
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.insert(plotThreads).values({
    id,
    projectId: data.projectId,
    name: data.name,
    color: data.color ?? null,
    description: data.description ?? null,
    sortOrder: data.sortOrder,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(plotThreads).where(eq(plotThreads.id, id));
  return normalizeThread(row);
}

export async function updatePlotThread(
  id: string,
  patch: Partial<Pick<PlotThreadRow, "name" | "color" | "description" | "sortOrder">>,
): Promise<void> {
  if (isTauriRuntime()) {
    const p: Record<string, unknown> = {};
    if (patch.name !== undefined) p.name = patch.name;
    if (patch.color !== undefined) p.color = patch.color;
    if (patch.description !== undefined) p.description = patch.description;
    if (patch.sortOrder !== undefined) p.sortOrder = patch.sortOrder;
    await invoke("plot_thread_update", { id, patch: p });
    return;
  }
  await db.update(plotThreads).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(plotThreads.id, id));
}

export async function deletePlotThread(id: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("plot_thread_delete", { id });
    return;
  }
  await db.delete(plotThreads).where(eq(plotThreads.id, id));
}

export async function listPlotThreads(projectId: string): Promise<PlotThreadRow[]> {
  if (isTauriRuntime()) {
    const rows = (await invoke("plot_thread_list", { projectId })) as unknown[];
    return rows.map(normalizeThread);
  }
  const rows = await db.select().from(plotThreads).where(eq(plotThreads.projectId, projectId));
  return rows.map(normalizeThread);
}

// ───── links ─────

export async function createPlotThreadLink(data: {
  threadId: string;
  nodeId: string;
  phaseType: PlotPhaseType;
  note?: string | null;
  sortOrder?: string | null;
}): Promise<PlotThreadLinkRow> {
  if (isTauriRuntime()) {
    const created = await invoke("plot_thread_link_create", {
      payload: {
        threadId: data.threadId,
        nodeId: data.nodeId,
        phaseType: data.phaseType,
        note: data.note ?? null,
        sortOrder: data.sortOrder ?? null,
      },
    });
    return normalizeLink(created);
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.insert(plotThreadSceneLinks).values({
    id,
    threadId: data.threadId,
    nodeId: data.nodeId,
    phaseType: data.phaseType,
    note: data.note ?? null,
    sortOrder: data.sortOrder ?? null,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(plotThreadSceneLinks).where(eq(plotThreadSceneLinks.id, id));
  return normalizeLink(row);
}

export async function updatePlotThreadLink(
  id: string,
  patch: Partial<Pick<PlotThreadLinkRow, "nodeId" | "phaseType" | "note" | "sortOrder">>,
): Promise<void> {
  if (isTauriRuntime()) {
    const p: Record<string, unknown> = {};
    if (patch.nodeId !== undefined) p.nodeId = patch.nodeId;
    if (patch.phaseType !== undefined) p.phaseType = patch.phaseType;
    if (patch.note !== undefined) p.note = patch.note;
    if (patch.sortOrder !== undefined) p.sortOrder = patch.sortOrder;
    await invoke("plot_thread_link_update", { id, patch: p });
    return;
  }
  await db.update(plotThreadSceneLinks).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(plotThreadSceneLinks.id, id));
}

export async function deletePlotThreadLink(id: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("plot_thread_link_delete", { id });
    return;
  }
  await db.delete(plotThreadSceneLinks).where(eq(plotThreadSceneLinks.id, id));
}

export async function listPlotThreadLinks(projectId: string): Promise<PlotThreadLinkRow[]> {
  if (isTauriRuntime()) {
    const rows = (await invoke("plot_thread_list_links", { projectId })) as unknown[];
    return rows.map(normalizeLink);
  }
  // 非 Tauri: join 相当を2クエリで（drizzle の join に合わせて調整可）
  const threads = await db.select().from(plotThreads).where(eq(plotThreads.projectId, projectId));
  const ids = new Set(threads.map((t) => t.id));
  const all = await db.select().from(plotThreadSceneLinks);
  return all.filter((l) => ids.has(l.threadId)).map(normalizeLink);
}
```

注: `db`/`isTauriRuntime`/`crypto.randomUUID` の import 元は既存 `foreshadow/api.ts` に厳密に合わせる（このリポジトリの実際の import パスを確認して揃える）。`createdAt/updatedAt` は本機能では文字列のまま扱う（Date 変換不要＝ソート/表示に使わないため。foreshadow は Date 化していたが本機能はレーン描画に日付を使わない）。

- [ ] **Step 4: テスト通過 + tsc**

Run: `pnpm test --run src/features/plot-threads/api.test.ts && npx tsc --noEmit`
Expected: PASS / エラーなし

- [ ] **Step 5: commit**

```bash
git add src/features/plot-threads/api.ts src/features/plot-threads/api.test.ts
git commit -m "feat(plot-thread): JS API ラッパと型を追加"
```

---

## Task 5: plotThreadStore（zustand）

**Files:**
- Create: `src/features/plot-threads/plotThreadStore.ts`
- Test: `src/features/plot-threads/plotThreadStore.test.ts`

**Interfaces:**
- Consumes: Task 4 の API、`getCurrentProjectId`（既存 projectStore）、`generateKeyBetween`（`@/features/tree/fractionalIndex`）。
- Produces: `usePlotThreadStore` — state `{ threads: PlotThreadRow[], links: PlotThreadLinkRow[], loading: boolean }`、actions `load(projectId)`, `addThread(name)`, `renameThread(id,name)`, `setThreadColor(id,color)`, `deleteThread(id)`, `reorderThread(id, beforeId, afterId)`, `addMarker(threadId, nodeId, phaseType)`, `updateMarker(id, patch)`, `deleteMarker(id)`。

- [ ] **Step 1: 失敗テスト（load の stale ガード）を書く**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const currentProject = { value: "p1" };
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => currentProject.value,
}));
vi.mock("./api", () => ({
  listPlotThreads: vi.fn(),
  listPlotThreadLinks: vi.fn(async () => []),
  createPlotThread: vi.fn(),
}));

import { listPlotThreads } from "./api";
import { usePlotThreadStore } from "./plotThreadStore";

describe("plotThreadStore", () => {
  beforeEach(() => {
    usePlotThreadStore.setState({ threads: [], links: [], loading: false });
    currentProject.value = "p1";
  });

  it("drops a stale load when the project switched mid-flight", async () => {
    (listPlotThreads as any).mockImplementation(async () => {
      currentProject.value = "p2"; // ロード中にプロジェクト切替
      return [{ id: "t1", projectId: "p1", name: "old", sortOrder: "a0" }];
    });
    await usePlotThreadStore.getState().load("p1");
    // p1 のロード結果は破棄される（現在 p2 のため）
    expect(usePlotThreadStore.getState().threads).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 失敗確認**

Run: `pnpm test --run src/features/plot-threads/plotThreadStore.test.ts`
Expected: FAIL

- [ ] **Step 3: store を実装（stale ガード必須）**

```typescript
import { create } from "zustand";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { generateKeyBetween } from "@/features/tree/fractionalIndex";
import type { PlotPhaseType } from "@/db/schema";
import {
  listPlotThreads,
  listPlotThreadLinks,
  createPlotThread,
  updatePlotThread,
  deletePlotThread,
  createPlotThreadLink,
  updatePlotThreadLink,
  deletePlotThreadLink,
  type PlotThreadRow,
  type PlotThreadLinkRow,
} from "./api";

interface PlotThreadState {
  threads: PlotThreadRow[];
  links: PlotThreadLinkRow[];
  loading: boolean;
  load: (projectId: string) => Promise<void>;
  addThread: (projectId: string, name: string) => Promise<void>;
  renameThread: (id: string, name: string) => Promise<void>;
  setThreadColor: (id: string, color: string | null) => Promise<void>;
  deleteThread: (id: string) => Promise<void>;
  addMarker: (threadId: string, nodeId: string, phaseType: PlotPhaseType) => Promise<void>;
  updateMarker: (id: string, patch: Partial<Pick<PlotThreadLinkRow, "nodeId" | "phaseType" | "note">>) => Promise<void>;
  deleteMarker: (id: string) => Promise<void>;
}

export const usePlotThreadStore = create<PlotThreadState>((set, get) => ({
  threads: [],
  links: [],
  loading: false,

  load: async (projectId) => {
    set({ loading: true });
    const [threads, links] = await Promise.all([
      listPlotThreads(projectId),
      listPlotThreadLinks(projectId),
    ]);
    // stale ガード: async 中にプロジェクトが切り替わっていたら破棄（Grimodex 頻出のストア汚染対策）
    if (getCurrentProjectId() !== projectId) return;
    set({ threads, links, loading: false });
  },

  addThread: async (projectId, name) => {
    const threads = get().threads;
    const last = threads[threads.length - 1];
    const sortOrder = generateKeyBetween(last ? last.sortOrder : null, null);
    const created = await createPlotThread({ projectId, name, sortOrder });
    if (getCurrentProjectId() !== projectId) return;
    set({ threads: [...get().threads, created] });
  },

  renameThread: async (id, name) => {
    await updatePlotThread(id, { name });
    set({ threads: get().threads.map((t) => (t.id === id ? { ...t, name } : t)) });
  },

  setThreadColor: async (id, color) => {
    await updatePlotThread(id, { color });
    set({ threads: get().threads.map((t) => (t.id === id ? { ...t, color } : t)) });
  },

  deleteThread: async (id) => {
    await deletePlotThread(id);
    set({
      threads: get().threads.filter((t) => t.id !== id),
      links: get().links.filter((l) => l.threadId !== id), // CASCADE をローカルにも反映
    });
  },

  addMarker: async (threadId, nodeId, phaseType) => {
    const created = await createPlotThreadLink({ threadId, nodeId, phaseType });
    set({ links: [...get().links, created] });
  },

  updateMarker: async (id, patch) => {
    await updatePlotThreadLink(id, patch);
    set({ links: get().links.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  },

  deleteMarker: async (id) => {
    await deletePlotThreadLink(id);
    set({ links: get().links.filter((l) => l.id !== id) });
  },
}));
```

- [ ] **Step 4: テスト通過**

Run: `pnpm test --run src/features/plot-threads/plotThreadStore.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add src/features/plot-threads/plotThreadStore.ts src/features/plot-threads/plotThreadStore.test.ts
git commit -m "feat(plot-thread): plotThreadStore(load+stale ガード+CRUD)を追加"
```

---

## Task 6: plotThreadLaneModel（純関数・レーン描画モデル）

**Files:**
- Create: `src/features/plot-threads/plotThreadLaneModel.ts`
- Test: `src/features/plot-threads/plotThreadLaneModel.test.ts`

**Interfaces:**
- Consumes: `PlotThreadRow`/`PlotThreadLinkRow`（api.ts）、シーン x インデックス `Map<string, number>`（呼び出し側が `computeSceneTimeIndex(nodes, mode)` で作る）、`cmpKeys`（fractionalIndex）。
- Produces:
  - `interface PlotLaneMarker { linkId: string; nodeId: string; phaseType: PlotPhaseType; x: number }`
  - `interface PlotLane { thread: PlotThreadRow; y: number; markers: PlotLaneMarker[] }`
  - `interface PlotLaneModel { lanes: PlotLane[]; contentWidth: number; contentHeight: number }`
  - `function laneY(index: number): number`
  - `function buildPlotLaneModel(args): PlotLaneModel`

- [ ] **Step 1: 失敗テストを書く**

```typescript
import { describe, it, expect } from "vitest";
import { buildPlotLaneModel, laneY } from "./plotThreadLaneModel";

const thread = (id: string, sortOrder: string, name = id) => ({
  id, projectId: "p1", name, color: null, description: null,
  sortOrder, createdAt: "", updatedAt: "",
});
const link = (id: string, threadId: string, nodeId: string, phaseType: any) => ({
  id, threadId, nodeId, phaseType, note: null, sortOrder: null, createdAt: "", updatedAt: "",
});

describe("plotThreadLaneModel", () => {
  const sceneX = new Map([["s1", 0], ["s2", 1], ["s3", 2]]);

  it("orders lanes by sortOrder and assigns increasing y", () => {
    const m = buildPlotLaneModel({
      threads: [thread("b", "a1"), thread("a", "a0")],
      links: [],
      sceneX,
    });
    expect(m.lanes.map((l) => l.thread.id)).toEqual(["a", "b"]); // a0 < a1
    expect(m.lanes[0].y).toBe(laneY(0));
    expect(m.lanes[1].y).toBe(laneY(1));
  });

  it("places markers at their scene x and drops markers whose scene is absent", () => {
    const m = buildPlotLaneModel({
      threads: [thread("t1", "a0")],
      links: [link("l1", "t1", "s2", "introduce"), link("l2", "t1", "GONE", "develop")],
      sceneX,
    });
    expect(m.lanes[0].markers).toHaveLength(1);
    expect(m.lanes[0].markers[0]).toMatchObject({ linkId: "l1", x: 1 });
  });

  it("is deterministic for markers in the same scene (orders by phase canonical order then id)", () => {
    const m = buildPlotLaneModel({
      threads: [thread("t1", "a0")],
      links: [link("l2", "t1", "s1", "develop"), link("l1", "t1", "s1", "introduce")],
      sceneX,
    });
    expect(m.lanes[0].markers.map((mk) => mk.linkId)).toEqual(["l1", "l2"]); // introduce < develop
  });
});
```

- [ ] **Step 2: 失敗確認**

Run: `pnpm test --run src/features/plot-threads/plotThreadLaneModel.test.ts`
Expected: FAIL

- [ ] **Step 3: 純関数を実装**

```typescript
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { PLOT_PHASE_TYPES, type PlotPhaseType } from "@/db/schema";
import type { PlotThreadRow, PlotThreadLinkRow } from "./api";

export const LANE_TOP = 60; // TimelineViewport の LANE_Y と整合（scheduled ベースライン）
export const LANE_HEIGHT = 56;

export function laneY(index: number): number {
  return LANE_TOP + index * LANE_HEIGHT;
}

export interface PlotLaneMarker {
  linkId: string;
  nodeId: string;
  phaseType: PlotPhaseType;
  x: number; // シーン x インデックス（px 変換は viewport の xOf に委ねる）
}
export interface PlotLane {
  thread: PlotThreadRow;
  y: number;
  markers: PlotLaneMarker[];
}
export interface PlotLaneModel {
  lanes: PlotLane[];
  contentWidth: number; // 最大シーン index（px 変換は viewport 側）
  contentHeight: number;
}

const PHASE_ORDER: Record<PlotPhaseType, number> = PLOT_PHASE_TYPES.reduce(
  (acc, p, i) => ({ ...acc, [p]: i }),
  {} as Record<PlotPhaseType, number>,
);

export function buildPlotLaneModel(args: {
  threads: PlotThreadRow[];
  links: PlotThreadLinkRow[];
  sceneX: Map<string, number>;
}): PlotLaneModel {
  const { threads, links, sceneX } = args;

  const orderedThreads = [...threads].sort((a, b) => {
    const c = cmpKeys(a.sortOrder, b.sortOrder);
    return c !== 0 ? c : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const linksByThread = new Map<string, PlotThreadLinkRow[]>();
  for (const l of links) {
    const arr = linksByThread.get(l.threadId) ?? [];
    arr.push(l);
    linksByThread.set(l.threadId, arr);
  }

  let maxX = 0;
  const lanes: PlotLane[] = orderedThreads.map((thread, index) => {
    const raw = linksByThread.get(thread.id) ?? [];
    const markers: PlotLaneMarker[] = raw
      .filter((l) => sceneX.has(l.nodeId)) // シーンが存在しないマーカーは描かない
      .map((l) => {
        const x = sceneX.get(l.nodeId)!;
        if (x > maxX) maxX = x;
        return { linkId: l.id, nodeId: l.nodeId, phaseType: l.phaseType, x };
      })
      .sort((a, b) => {
        if (a.x !== b.x) return a.x - b.x;
        const p = PHASE_ORDER[a.phaseType] - PHASE_ORDER[b.phaseType];
        if (p !== 0) return p;
        return a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0;
      });
    return { thread, y: laneY(index), markers };
  });

  return {
    lanes,
    contentWidth: maxX,
    contentHeight: laneY(orderedThreads.length),
  };
}
```

- [ ] **Step 4: テスト通過**

Run: `pnpm test --run src/features/plot-threads/plotThreadLaneModel.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add src/features/plot-threads/plotThreadLaneModel.ts src/features/plot-threads/plotThreadLaneModel.test.ts
git commit -m "feat(plot-thread): レーン描画モデル純関数を追加"
```

---

## Task 7: timelineStore に viewMode を追加

**Files:**
- Modify: `src/features/timeline/timelineStore.ts`
- Test: `src/features/timeline/timelineStore.test.ts`

**Interfaces:**
- Produces: state に `viewMode: "scenes" | "threads"`、action `setViewMode(mode)`。global-settings KV へ既存 `settings.timeline` と同じ debounce 永続化。

- [ ] **Step 1: 失敗テスト**

```typescript
it("persists viewMode and defaults to scenes", () => {
  expect(useTimelineStore.getState().viewMode).toBe("scenes");
  useTimelineStore.getState().setViewMode("threads");
  expect(useTimelineStore.getState().viewMode).toBe("threads");
});
```

- [ ] **Step 2: 失敗確認**

Run: `pnpm test --run src/features/timeline/timelineStore.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装**

`TimelineState` インターフェースに追加:
```typescript
  viewMode: "scenes" | "threads";
  setViewMode: (mode: "scenes" | "threads") => void;
```
初期値（`create` の返却オブジェクト内、既存 `axisMode` の近く）:
```typescript
  viewMode: "scenes",
  setViewMode: (mode) => {
    set({ viewMode: mode });
    get().persistSettings?.(); // 既存の永続化トリガに合わせる（debounce snapshot）
  },
```
`TimelineSettings`（global-settings へ書く型）と `loadAndSyncTimelineSettings` のシリアライズ/デシリアライズに `viewMode` を追加（既存 `axisMode`/`zoom` と同じ要領。読込時に未知値は `"scenes"` にフォールバック）。

- [ ] **Step 4: テスト通過**

Run: `pnpm test --run src/features/timeline/timelineStore.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add src/features/timeline/timelineStore.ts src/features/timeline/timelineStore.test.ts
git commit -m "feat(timeline): viewMode(scenes/threads)を追加し永続化"
```

---

## Task 8: TimelineViewport に threads レーン描画モード

**Files:**
- Modify: `src/features/timeline/TimelineViewport.tsx`
- Test: `src/features/timeline/TimelineViewport.test.tsx`（描画分岐の存在確認）+ 幾何は Task 6 の純関数テストで gate

**Interfaces:**
- Consumes: `usePlotThreadStore`, `buildPlotLaneModel`, `laneY`, `LANE_HEIGHT`、既存 `xOf(i)`（:120-129）、`useTimelineStore.viewMode`、`computeSceneTimeIndex`（既に viewport が axisMode から算出している scene 順）。
- Produces: `viewMode === "threads"` のとき N レーン + マーカーを描く SVG ブロック。

- [ ] **Step 1: 失敗テスト**

```typescript
it("renders thread lanes when viewMode is threads", () => {
  useTimelineStore.setState({ viewMode: "threads" });
  usePlotThreadStore.setState({
    threads: [{ id: "t1", projectId: "p1", name: "復讐", color: "#c33", sortOrder: "a0", description: null, createdAt: "", updatedAt: "" }],
    links: [], loading: false,
  });
  render(<TimelineViewport /* 既存テストの必須 props に合わせる */ />);
  expect(screen.getByText("復讐")).toBeInTheDocument();
});
```

- [ ] **Step 2: 失敗確認**

Run: `pnpm test --run src/features/timeline/TimelineViewport.test.tsx`
Expected: FAIL

- [ ] **Step 3: viewport を実装**

`TimelineViewport.tsx` の既存 scene 描画は `viewMode === "scenes"` のときだけにし、`"threads"` のとき以下を描く。シーン x は既存の `xOf(i)` をそのまま使う（マーカーの x = `xOf(marker.x)`）。レーン y は `laneY(index)`（Task 6 の定数）。

viewport コンポーネント本体に追加（既存の scenes / sceneOrder 算出の直後）:
```tsx
const viewMode = useTimelineStore((s) => s.viewMode);
const threads = usePlotThreadStore((s) => s.threads);
const links = usePlotThreadStore((s) => s.links);

// sceneX: nodeId -> 既存 scene 配列上の index（viewport が既に持つ scenes/order を流用）
const sceneX = useMemo(() => {
  const m = new Map<string, number>();
  scenes.forEach((sc, i) => m.set(sc.id, i));
  return m;
}, [scenes]);

const laneModel = useMemo(
  () => buildPlotLaneModel({ threads, links, sceneX }),
  [threads, links, sceneX],
);
```

SVG 内、scene circle 描画ループを `{viewMode === "scenes" && ( ...既存... )}` で包み、その後に:
```tsx
{viewMode === "threads" &&
  laneModel.lanes.map((lane) => (
    <g key={lane.thread.id} data-plot-lane={lane.thread.id}>
      {/* レーン背景線 */}
      <line
        x1={xOf(0)} y1={lane.y} x2={xOf(scenes.length - 1)} y2={lane.y}
        stroke="var(--border)" strokeWidth={1}
      />
      {/* レーン見出し（左固定） */}
      <text x={8} y={lane.y - 8} className="fill-foreground text-xs">
        {lane.thread.name}
      </text>
      {/* マーカー */}
      {lane.markers.map((mk) => (
        <circle
          key={mk.linkId}
          cx={xOf(mk.x)} cy={lane.y} r={6}
          fill={lane.thread.color ?? "var(--primary)"}
          stroke="var(--background)" strokeWidth={1.5}
          data-phase={mk.phaseType}
          onClick={() => onSelectMarker?.(mk.linkId)}
          style={{ cursor: "pointer" }}
        />
      ))}
    </g>
  ))}
```

SVG の高さ計算を `viewMode === "threads" ? Math.max(existingHeight, laneModel.contentHeight + LANE_HEIGHT) : existingHeight` に拡張（既存の height/viewBox 算出箇所を条件分岐）。

注: phase ごとの記号・色分けは v1 では「スレッド色の円 + `data-phase` 属性」で出し、Task 10 の凡例/インスペクタで phase ラベルを見せる。phase 別の形状（◇/▲ 等）は将来拡張（YAGNI）。

- [ ] **Step 4: テスト通過**

Run: `pnpm test --run src/features/timeline/TimelineViewport.test.tsx && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add src/features/timeline/TimelineViewport.tsx src/features/timeline/TimelineViewport.test.tsx
git commit -m "feat(timeline): threads モードでプロットスレッドのレーン描画を追加"
```

---

## Task 9: TimelineHeader に view 切替 + スレッド追加

**Files:**
- Modify: `src/features/timeline/TimelineHeader.tsx`
- Test: `src/features/timeline/TimelineHeader.test.tsx`

**Interfaces:**
- Consumes: `useTimelineStore.viewMode/setViewMode`、`usePlotThreadStore.addThread`、`getCurrentProjectId`、i18n `t`。

- [ ] **Step 1: 失敗テスト**

```typescript
it("toggles viewMode via the segmented control", async () => {
  render(<TimelineHeader /* 既存 props */ />);
  await userEvent.click(screen.getByRole("button", { name: /スレッド|Threads/ }));
  expect(useTimelineStore.getState().viewMode).toBe("threads");
});
```

- [ ] **Step 2: 失敗確認 → Step 3: 実装**

既存ヘッダーの axisMode トグル群の近くに、scenes/threads のセグメントトグルを追加（既存トグルの markup パターンを流用）。threads モードのときだけ「+ スレッド」ボタンを出し、`usePlotThreadStore.getState().addThread(getCurrentProjectId(), t("plotThread.newThreadName"))` を呼ぶ。

- [ ] **Step 4: テスト通過**

Run: `pnpm test --run src/features/timeline/TimelineHeader.test.tsx && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add src/features/timeline/TimelineHeader.tsx src/features/timeline/TimelineHeader.test.tsx
git commit -m "feat(timeline): ヘッダーに scenes/threads 切替とスレッド追加を追加"
```

---

## Task 10: TimelineInspector でマーカー/スレッド編集

**Files:**
- Modify: `src/features/timeline/TimelineInspector.tsx`
- Test: `src/features/timeline/TimelineInspector.test.tsx`

**Interfaces:**
- Consumes: 選択中マーカー/スレッド id（viewport の選択状態を timelineStore.selectedNodeIds とは別に持つか、新 `selectedPlotLinkId`/`selectedPlotThreadId` を timelineStore に追加）、`usePlotThreadStore`、`PLOT_PHASE_TYPES`、i18n。

- [ ] **Step 1: 失敗テスト** — マーカー選択時に phase セレクトが出て、変更が `updateMarker` を呼ぶ。
- [ ] **Step 2-3:** 実装。threads モード + マーカー選択時: phase_type の `<select>`（`PLOT_PHASE_TYPES` を `t("plotThread.phase." + p)` で表示）、note の textarea、`updateMarker` 呼び出し。スレッド選択時: 名前・色編集、削除ボタン（`deleteThread`）。
- [ ] **Step 4:** `pnpm test --run src/features/timeline/TimelineInspector.test.tsx && npx tsc --noEmit` → PASS
- [ ] **Step 5:** commit `feat(timeline): インスペクタでプロットマーカー/スレッドを編集`

---

## Task 11: TimelineContextMenu でマーカー追加/スレッド削除

**Files:**
- Modify: `src/features/timeline/TimelineContextMenu.tsx`
- Test: `src/features/timeline/TimelineContextMenu.test.tsx`

**Interfaces:**
- Consumes: 右クリック対象（レーン×シーン位置 or マーカー）、`usePlotThreadStore.addMarker/deleteMarker/deleteThread`。

- [ ] **Step 1: 失敗テスト** — レーン上でメニュー「ここにマーカー追加」を選ぶと `addMarker(threadId, nodeId, "develop")` が呼ばれる。
- [ ] **Step 2-3:** 実装。threads モードのコンテキストメニュー項目: 「マーカー追加（既定 develop）」「マーカー削除」「スレッド削除（確認付き）」。
- [ ] **Step 4:** `pnpm test --run src/features/timeline/TimelineContextMenu.test.tsx && npx tsc --noEmit` → PASS
- [ ] **Step 5:** commit `feat(timeline): コンテキストメニューでマーカー追加/削除`

---

## Task 12: i18n（ja/en）

**Files:**
- Modify: 既存 locale ファイル（`src/i18n/locales/ja.*` と `en.*`。実パス/形式は既存に合わせる）
- Test: 既存の locale parity テストがあればそれが gate（無ければ手動で両ファイル同期）

**Interfaces:**
- Produces: 以下のキー（両言語）:
  - `plotThread.viewScenes` = "シーン" / "Scenes"
  - `plotThread.viewThreads` = "スレッド" / "Threads"
  - `plotThread.addThread` = "＋ スレッド" / "+ Thread"
  - `plotThread.newThreadName` = "新しいスレッド" / "New Thread"
  - `plotThread.deleteThread` = "スレッドを削除" / "Delete Thread"
  - `plotThread.addMarker` = "ここにマーカーを追加" / "Add Marker Here"
  - `plotThread.deleteMarker` = "マーカーを削除" / "Delete Marker"
  - `plotThread.phase.introduce` = "導入" / "Introduce"
  - `plotThread.phase.develop` = "展開" / "Develop"
  - `plotThread.phase.turn` = "転" / "Turn"
  - `plotThread.phase.climax` = "クライマックス" / "Climax"
  - `plotThread.phase.resolve` = "回収" / "Resolve"

- [ ] **Step 1:** 両 locale に同じキー集合を追加（片方欠けると locale parity が落ちる）。
- [ ] **Step 2:** `pnpm test --run`（locale parity 関連）+ `npx tsc --noEmit`
- [ ] **Step 3:** commit `feat(timeline): プロットスレッド UI 文字列(ja/en)を追加`

---

## 最終検証（全タスク完了後）

- [ ] フル型チェック: `npx tsc --noEmit`
- [ ] フロント全テスト: `pnpm test --run`（scoped でなく full。browser-mock 不整合を見逃さないため）
- [ ] Lint: `pnpm lint:fix`
- [ ] Rust: 自己検証 worktree で `cargo test --no-default-features` + `cargo clippy --all-targets`（CI は `-D warnings`）
- [ ] レイアウト健全性: `pnpm test --run src/features/layout/`（新 PanelId を足していないので `validateLayoutState` は不変のはず＝回帰が無いことの確認）
- [ ] 設計書の「残=実機GUI QA」: 実プロジェクトで埋め込み index 有り → スレッド作成・マーカー配置・軸切替（reading/story/write）でレーンが追従するか体感確認。

## Self-Review（計画↔spec カバレッジ）

- spec §3.1/3.2 データモデル → Task 1, 2 ✅
- spec §3.3 マイグレーション → Task 1 ✅
- spec §4 コンポーネント（store/lane model/viewport/inspector/context menu/i18n） → Task 5,6,8,10,11,12 ✅
- spec §4.1 座標一般化（laneY） → Task 6（純関数）+ Task 8（適用）✅
- spec §4.2 操作（ドラッグ・編集） → Task 10,11（編集）。**ドラッグ移動（横=再アンカー / 縦=レーン移動）は v1.1 として Task 11 のメニュー操作で代替し、SVG ドラッグは別 PR に切り出す**（spec の YAGNI 範囲に合わせ初版はメニュー/インスペクタ操作で完結。ドラッグ追加時は既存 story-time ドラッグの axis-lock を流用）。
- spec §5 データフロー → Task 5,8 ✅
- spec §6 罠（パネル登録ゼロ/stale ガード/順序軸 1 本化/CHECK enum/snapshot/CASCADE/phase pin 分離） → Task 1,3,5,7,8 で対応 ✅
- spec §7 テスト方針 → 各タスクの TDD + 最終検証 ✅

Placeholder スキャン: 「TBD/後で」等なし。型整合: `PlotThreadRow`/`PlotThreadLinkRow`/`PlotPhaseType`/`buildPlotLaneModel`/`laneY` は Task 間で一貫。
