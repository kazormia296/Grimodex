//! Plot thread (Plottr 型プロットスレッド) の DB 操作。
//!
//! 実装本体を旧 `src-tauri/src/commands/plot_threads.rs` から本クレートへ移動した
//! (Electron 移行 Phase 3 バッチ1 — Tauri コマンドと napi `Backend` の両方が薄い
//! ラッパーとして呼ぶ。`trash_bin` / `foreshadow` と同じ構図)。署名・SQL・
//! XPROJ ガード・エラー文字列は移動前と完全に同一。
//!
//! `plot_threads` = タイムライン上の名前付き横レーン、
//! `plot_thread_scene_links` = スレッドが特定シーンで踏む段階マーカー。
//! schema は src-tauri/src/database/migrate.rs と src/db/schema.ts でミラー。

use serde_json::Value;

use super::Database;

const PHASE_TYPES: [&str; 5] = ["introduce", "develop", "turn", "climax", "resolve"];

fn validate_phase(p: &str) -> anyhow::Result<()> {
    if PHASE_TYPES.contains(&p) {
        Ok(())
    } else {
        Err(anyhow::anyhow!("invalid phase_type: {p:?}"))
    }
}

fn one(rows: Vec<serde_json::Map<String, Value>>) -> Value {
    rows.first()
        .cloned()
        .map(Value::Object)
        .unwrap_or(Value::Null)
}

/// 行 id の所属 project_id を引く。table は静的リテラルのみ（インジェクション無し）。
fn project_of(db: &Database, table: &str, id: &str) -> anyhow::Result<Option<String>> {
    let sql = format!("SELECT project_id FROM {table} WHERE id = ?");
    let rows = db.execute(&sql, &[Value::String(id.to_string())], "get")?;
    Ok(rows
        .first()
        .and_then(|r| r.get("project_id"))
        .and_then(|v| v.as_str())
        .map(str::to_string))
}

// ─────────────────────── DTO ───────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadCreatePayload {
    project_id: String,
    name: String,
    color: Option<String>,
    description: Option<String>,
    sort_order: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadPatch {
    name: Option<String>,
    color: Option<Option<String>>,
    description: Option<Option<String>>,
    sort_order: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadLinkCreatePayload {
    thread_id: String,
    node_id: String,
    phase_type: String,
    note: Option<String>,
    sort_order: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadLinkPatch {
    thread_id: Option<String>,
    node_id: Option<String>,
    phase_type: Option<String>,
    note: Option<Option<String>>,
    sort_order: Option<Option<String>>,
}

// ─────────────────────── thread CRUD ───────────────────────

pub fn create(db: &Database, p: PlotThreadCreatePayload) -> anyhow::Result<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO plot_threads (id, project_id, name, color, description, sort_order)\n         VALUES (?, ?, ?, ?, ?, ?)",
        &[
            Value::String(id.clone()),
            Value::String(p.project_id),
            Value::String(p.name),
            p.color.map(Value::String).unwrap_or(Value::Null),
            p.description.map(Value::String).unwrap_or(Value::Null),
            Value::String(p.sort_order),
        ],
        "run",
    )?;
    Ok(one(db.execute(
        "SELECT * FROM plot_threads WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?))
}

pub fn update(db: &Database, id: String, patch: PlotThreadPatch) -> anyhow::Result<Value> {
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
    if let Some(description) = patch.description {
        sets.push("description = ?");
        params.push(description.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(sort_order) = patch.sort_order {
        sets.push("sort_order = ?");
        params.push(Value::String(sort_order));
    }
    if sets.is_empty() {
        return Ok(one(db.execute(
            "SELECT * FROM plot_threads WHERE id = ?",
            &[Value::String(id)],
            "get",
        )?));
    }
    sets.push("updated_at = datetime('now')");
    params.push(Value::String(id.clone()));
    let sql = format!("UPDATE plot_threads SET {} WHERE id = ?", sets.join(", "));
    db.execute(&sql, &params, "run")?;
    Ok(one(db.execute(
        "SELECT * FROM plot_threads WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?))
}

pub fn delete(db: &Database, id: String) -> anyhow::Result<()> {
    db.execute(
        "DELETE FROM plot_threads WHERE id = ?",
        &[Value::String(id)],
        "run",
    )?;
    Ok(())
}

pub fn list(db: &Database, project_id: String) -> anyhow::Result<Vec<Value>> {
    let rows = db.execute(
        "SELECT * FROM plot_threads WHERE project_id = ? ORDER BY sort_order ASC",
        &[Value::String(project_id)],
        "all",
    )?;
    Ok(rows.into_iter().map(Value::Object).collect())
}

// ─────────────────────── link CRUD ───────────────────────

pub fn link_create(db: &Database, p: PlotThreadLinkCreatePayload) -> anyhow::Result<Value> {
    validate_phase(&p.phase_type)?;
    // XPROJ ガード: thread と node が同一 project に属することを強制する。
    // FK は行の存在のみ検証し project 所有権は見ないため、ここで明示照合する。
    let thread_project = project_of(db, "plot_threads", &p.thread_id)?;
    let node_project = project_of(db, "tree_nodes", &p.node_id)?;
    match (thread_project, node_project) {
        (Some(a), Some(b)) if a == b => {}
        _ => {
            return Err(anyhow::anyhow!(
                "plot thread link must reference a thread and scene in the same project"
            ))
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO plot_thread_scene_links (id, thread_id, node_id, phase_type, note, sort_order)\n         VALUES (?, ?, ?, ?, ?, ?)",
        &[
            Value::String(id.clone()),
            Value::String(p.thread_id),
            Value::String(p.node_id),
            Value::String(p.phase_type),
            p.note.map(Value::String).unwrap_or(Value::Null),
            p.sort_order.map(Value::String).unwrap_or(Value::Null),
        ],
        "run",
    )?;
    Ok(one(db.execute(
        "SELECT * FROM plot_thread_scene_links WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?))
}

pub fn link_update(db: &Database, id: String, patch: PlotThreadLinkPatch) -> anyhow::Result<Value> {
    if let Some(ref pt) = patch.phase_type {
        validate_phase(pt)?;
    }
    let mut sets: Vec<&str> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    // 別スレッドへ移動する場合は XPROJ ガード: 移動先スレッドと（変更後の）シーンが
    // 同一 project であることを強制する。node_id が同 patch に無ければ既存値を引く。
    if let Some(ref new_thread_id) = patch.thread_id {
        let effective_node_id: Option<String> = match &patch.node_id {
            Some(n) => Some(n.clone()),
            None => db
                .execute(
                    "SELECT node_id FROM plot_thread_scene_links WHERE id = ?",
                    &[Value::String(id.clone())],
                    "get",
                )?
                .first()
                .and_then(|r| r.get("node_id"))
                .and_then(|v| v.as_str())
                .map(str::to_string),
        };
        let thread_project = project_of(db, "plot_threads", new_thread_id)?;
        let node_project = match &effective_node_id {
            Some(n) => project_of(db, "tree_nodes", n)?,
            None => None,
        };
        match (thread_project, node_project) {
            (Some(a), Some(b)) if a == b => {}
            _ => {
                return Err(anyhow::anyhow!(
                    "plot thread link move must stay within the same project"
                ))
            }
        }
        sets.push("thread_id = ?");
        params.push(Value::String(new_thread_id.clone()));
    }
    if let Some(node_id) = patch.node_id {
        sets.push("node_id = ?");
        params.push(Value::String(node_id));
    }
    if let Some(phase_type) = patch.phase_type {
        sets.push("phase_type = ?");
        params.push(Value::String(phase_type));
    }
    if let Some(note) = patch.note {
        sets.push("note = ?");
        params.push(note.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(sort_order) = patch.sort_order {
        sets.push("sort_order = ?");
        params.push(sort_order.map(Value::String).unwrap_or(Value::Null));
    }
    if sets.is_empty() {
        return Ok(one(db.execute(
            "SELECT * FROM plot_thread_scene_links WHERE id = ?",
            &[Value::String(id)],
            "get",
        )?));
    }
    sets.push("updated_at = datetime('now')");
    params.push(Value::String(id.clone()));
    let sql = format!(
        "UPDATE plot_thread_scene_links SET {} WHERE id = ?",
        sets.join(", ")
    );
    db.execute(&sql, &params, "run")?;
    Ok(one(db.execute(
        "SELECT * FROM plot_thread_scene_links WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?))
}

pub fn link_delete(db: &Database, id: String) -> anyhow::Result<()> {
    db.execute(
        "DELETE FROM plot_thread_scene_links WHERE id = ?",
        &[Value::String(id)],
        "run",
    )?;
    Ok(())
}

pub fn list_links(db: &Database, project_id: String) -> anyhow::Result<Vec<Value>> {
    let rows = db.execute(
        "SELECT l.* FROM plot_thread_scene_links l \
         JOIN plot_threads t ON t.id = l.thread_id \
         WHERE t.project_id = ?",
        &[Value::String(project_id)],
        "all",
    )?;
    Ok(rows.into_iter().map(Value::Object).collect())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db.execute("INSERT INTO projects (id) VALUES ('p1')", &[], "run")
            .unwrap();
        db
    }

    #[test]
    fn create_then_list_roundtrips() {
        let d = db();
        let created = create(
            &d,
            PlotThreadCreatePayload {
                project_id: "p1".into(),
                name: "復讐の糸".into(),
                color: Some("#c33".into()),
                description: None,
                sort_order: "a0".into(),
            },
        )
        .unwrap();
        assert!(created.is_object());
        let rows = list(&d, "p1".into()).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn link_create_rejects_invalid_phase() {
        let d = db();
        create(
            &d,
            PlotThreadCreatePayload {
                project_id: "p1".into(),
                name: "t".into(),
                color: None,
                description: None,
                sort_order: "a0".into(),
            },
        )
        .unwrap();
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title) VALUES ('s1','p1','scene','S1')",
            &[],
            "run",
        )
        .unwrap();
        // thread id を取得
        let threads = list(&d, "p1".into()).unwrap();
        let tid = threads[0]
            .as_object()
            .and_then(|o| o.get("id"))
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();

        let bad = link_create(
            &d,
            PlotThreadLinkCreatePayload {
                thread_id: tid.clone(),
                node_id: "s1".into(),
                phase_type: "BOGUS".into(),
                note: None,
                sort_order: None,
            },
        );
        assert!(bad.is_err(), "invalid phase_type must be rejected");

        let ok = link_create(
            &d,
            PlotThreadLinkCreatePayload {
                thread_id: tid,
                node_id: "s1".into(),
                phase_type: "introduce".into(),
                note: None,
                sort_order: None,
            },
        );
        assert!(ok.is_ok(), "valid phase_type must insert");
    }

    #[test]
    fn link_create_rejects_cross_project() {
        let d = db();
        // p1 にスレッド、p2 にシーン。
        d.execute("INSERT INTO projects (id) VALUES ('p2')", &[], "run")
            .unwrap();
        create(
            &d,
            PlotThreadCreatePayload {
                project_id: "p1".into(),
                name: "t".into(),
                color: None,
                description: None,
                sort_order: "a0".into(),
            },
        )
        .unwrap();
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title) VALUES ('s2','p2','scene','S2')",
            &[],
            "run",
        )
        .unwrap();
        let tid = list(&d, "p1".into()).unwrap()[0]
            .as_object()
            .and_then(|o| o.get("id"))
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();

        // p1 のスレッド × p2 のシーンは拒否される。
        let cross = link_create(
            &d,
            PlotThreadLinkCreatePayload {
                thread_id: tid,
                node_id: "s2".into(),
                phase_type: "introduce".into(),
                note: None,
                sort_order: None,
            },
        );
        assert!(cross.is_err(), "cross-project link must be rejected");
    }

    #[test]
    fn link_update_moves_thread_within_project_and_rejects_cross_project() {
        let d = db();
        d.execute("INSERT INTO projects (id) VALUES ('p2')", &[], "run")
            .unwrap();
        for (id, so) in [("a", "a0"), ("b", "a1")] {
            d.execute(
                "INSERT INTO plot_threads (id, project_id, name, sort_order) VALUES (?, 'p1', ?, ?)",
                &[
                    Value::String(id.into()),
                    Value::String(id.into()),
                    Value::String(so.into()),
                ],
                "run",
            )
            .unwrap();
        }
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title) VALUES ('s1','p1','scene','S1')",
            &[],
            "run",
        )
        .unwrap();
        d.execute(
            "INSERT INTO plot_threads (id, project_id, name, sort_order) VALUES ('c','p2','c','a0')",
            &[],
            "run",
        )
        .unwrap();
        let link = link_create(
            &d,
            PlotThreadLinkCreatePayload {
                thread_id: "a".into(),
                node_id: "s1".into(),
                phase_type: "introduce".into(),
                note: None,
                sort_order: None,
            },
        )
        .unwrap();
        let lid = link
            .as_object()
            .and_then(|o| o.get("id"))
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();

        // 同 project の thread b へ移動 → OK & 反映される。
        let ok = link_update(
            &d,
            lid.clone(),
            PlotThreadLinkPatch {
                thread_id: Some("b".into()),
                node_id: None,
                phase_type: None,
                note: None,
                sort_order: None,
            },
        )
        .unwrap();
        assert_eq!(
            ok.as_object()
                .and_then(|o| o.get("thread_id"))
                .and_then(|v| v.as_str()),
            Some("b")
        );

        // 別 project の thread c へ移動 → 拒否。
        let cross = link_update(
            &d,
            lid,
            PlotThreadLinkPatch {
                thread_id: Some("c".into()),
                node_id: None,
                phase_type: None,
                note: None,
                sort_order: None,
            },
        );
        assert!(cross.is_err(), "cross-project thread move must be rejected");
    }
}
