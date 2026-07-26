//! Foreshadow (伏線) の DB 操作。
//!
//! 実装本体を旧 `src-tauri/src/commands/foreshadow.rs` から本クレートへ移動した
//! (Electron 移行 Phase 3 バッチ1 — Tauri コマンドと napi `Backend` の両方が薄い
//! ラッパーとして呼ぶ。`trash_bin` / `plot_threads` と同じ構図)。SQL・検証・
//! エラー文字列・Option<Option<T>> patch の 3 値挙動は移動前と完全に同一。
//!
//! すべて純 `db.execute` / `db.execute_batch_tx` で、`grimodex_core::writes`
//! (undo_journal / change_events の tracked write) は使わない。tracked な
//! foreshadow 生成は agent_writes 側の別コマンド。

use serde_json::Value;

use super::{BatchStatement, Database};

// ─────────────────────────── DTO ───────────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowCreatePayload {
    project_id: String,
    title: String,
    intent: Option<String>,
    load_bearing: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowPatch {
    title: Option<String>,
    intent: Option<Option<String>>,
    notes: Option<Option<String>>,
    payoff_scene_id: Option<Option<String>>,
    payoff_from_pos: Option<Option<i64>>,
    payoff_to_pos: Option<Option<i64>>,
    payoff_confirmed: Option<bool>,
    abandoned: Option<bool>,
    secret: Option<bool>,
    load_bearing: Option<Option<String>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanResolvePayload {
    setup_id: String,
    action: String,
    scene_id: Option<String>,
    from_pos: Option<i64>,
    to_pos: Option<i64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupAnchorInput {
    id: String,
    foreshadow_id: String,
    scene_id: String,
    from_pos: i64,
    to_pos: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayoffAnchorInput {
    foreshadow_id: String,
    scene_id: String,
    from_pos: i64,
    to_pos: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorMarkOutput {
    from: i64,
    to: i64,
    mark_name: String,
    attrs: Value,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowSetupPatch {
    strength: Option<Option<String>>,
    ai_strength: Option<Option<String>>,
    ai_reasoning: Option<Option<String>>,
    is_orphan: Option<bool>,
    last_evaluated_at: Option<Option<i64>>,
}

/// `foreshadow_setup_create_ai` の 12 引数を束ねた DTO。Tauri コマンドは従来
/// どおり 12 個の flat 引数で受けてこの struct を組み立て、napi は FE が送る
/// camelCase オブジェクトを `from_wire` でこの struct に落とす（両者とも同一
/// serde 経路）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupCreateAiInput {
    pub id: String,
    pub foreshadow_id: String,
    pub scene_id: String,
    pub from_pos: i64,
    pub to_pos: i64,
    pub kind: String,
    pub strength: Option<String>,
    pub ai_strength: Option<String>,
    pub attribution: String,
    pub ai_rationale: Option<String>,
    pub ai_reasoning: Option<String>,
    pub last_evaluated_at: Option<i64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowListWithLabelsResponse {
    foreshadows: Vec<Value>,
    setups: Vec<Value>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowSceneInfoResponse {
    setup_foreshadow_ids: Vec<String>,
    payoff_foreshadow_ids: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowSceneContextResponse {
    setups: Vec<Value>,
    payoffs: Vec<Value>,
    setup_scene_rows: Vec<Value>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowChapterStatsBundle {
    scenes: Vec<Value>,
    setups_on_scenes: Vec<Value>,
    payoff_foreshadows: Vec<Value>,
    related_foreshadows: Vec<Value>,
    related_setups: Vec<Value>,
}

// ─────────────────────────── ヘルパー ───────────────────────────

/// `load_bearing` 列に許される値。`deriveLabel.ts` の判定軸と一致。
/// 不明値は `deriveLabel` で silently `needs_strengthening` に落ちるため、
/// データ整合性確保のため Rust 境界で厳格に弾く。
fn validate_load_bearing(value: Option<&str>) -> anyhow::Result<()> {
    match value {
        None | Some("critical") | Some("supporting") | Some("optional") => Ok(()),
        Some(other) => Err(anyhow::anyhow!(
            "invalid load_bearing value: {:?} (expected one of: critical, supporting, optional, null)",
            other
        )),
    }
}

fn in_placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}

fn fetch_setup_label_rows(db: &Database, foreshadow_ids: &[String]) -> anyhow::Result<Vec<Value>> {
    if foreshadow_ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders = in_placeholders(foreshadow_ids.len());
    let params: Vec<Value> = foreshadow_ids.iter().cloned().map(Value::String).collect();
    let setup_rows = db.execute(
        &format!(
            "SELECT foreshadow_id, is_orphan, strength, ai_strength, ai_reasoning \
             FROM foreshadow_setups WHERE foreshadow_id IN ({placeholders})"
        ),
        &params,
        "all",
    )?;
    Ok(setup_rows.into_iter().map(Value::Object).collect())
}

// ─────────────────────────── foreshadow CRUD ───────────────────────────

pub fn create(db: &Database, payload: ForeshadowCreatePayload) -> anyhow::Result<Value> {
    validate_load_bearing(payload.load_bearing.as_deref())?;
    let now = chrono::Utc::now().timestamp_millis();
    let id = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO foreshadows
         (id, project_id, title, intent, notes, payoff_scene_id, payoff_from_pos, payoff_to_pos, payoff_confirmed, abandoned, secret, load_bearing, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, 0, 1, ?, ?, ?)",
        &[
            Value::String(id.clone()),
            Value::String(payload.project_id),
            Value::String(payload.title),
            payload.intent.map(Value::String).unwrap_or(Value::Null),
            payload.load_bearing.map(Value::String).unwrap_or(Value::Null),
            Value::Number(now.into()),
            Value::Number(now.into()),
        ],
        "run",
    )?;
    let rows = db.execute(
        "SELECT * FROM foreshadows WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?;
    Ok(rows
        .first()
        .cloned()
        .map(Value::Object)
        .unwrap_or(Value::Null))
}

pub fn update(db: &Database, id: String, patch: ForeshadowPatch) -> anyhow::Result<Value> {
    if let Some(ref lb) = patch.load_bearing {
        validate_load_bearing(lb.as_deref())?;
    }
    let now = chrono::Utc::now().timestamp_millis();
    let mut sets: Vec<&str> = Vec::new();
    let mut params: Vec<Value> = Vec::new();

    if let Some(title) = patch.title {
        sets.push("title = ?");
        params.push(Value::String(title));
    }
    if let Some(intent) = patch.intent {
        sets.push("intent = ?");
        params.push(intent.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(notes) = patch.notes {
        sets.push("notes = ?");
        params.push(notes.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(payoff_scene_id) = patch.payoff_scene_id {
        sets.push("payoff_scene_id = ?");
        params.push(payoff_scene_id.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(payoff_from_pos) = patch.payoff_from_pos {
        sets.push("payoff_from_pos = ?");
        params.push(
            payoff_from_pos
                .map(|v| Value::Number(v.into()))
                .unwrap_or(Value::Null),
        );
    }
    if let Some(payoff_to_pos) = patch.payoff_to_pos {
        sets.push("payoff_to_pos = ?");
        params.push(
            payoff_to_pos
                .map(|v| Value::Number(v.into()))
                .unwrap_or(Value::Null),
        );
    }
    if let Some(payoff_confirmed) = patch.payoff_confirmed {
        sets.push("payoff_confirmed = ?");
        params.push(Value::Bool(payoff_confirmed));
    }
    if let Some(abandoned) = patch.abandoned {
        sets.push("abandoned = ?");
        params.push(Value::Bool(abandoned));
    }
    if let Some(secret) = patch.secret {
        sets.push("secret = ?");
        params.push(Value::Bool(secret));
    }
    if let Some(load_bearing) = patch.load_bearing {
        sets.push("load_bearing = ?");
        params.push(load_bearing.map(Value::String).unwrap_or(Value::Null));
    }

    if sets.is_empty() {
        let rows = db.execute(
            "SELECT * FROM foreshadows WHERE id = ?",
            &[Value::String(id)],
            "get",
        )?;
        return Ok(rows
            .first()
            .cloned()
            .map(Value::Object)
            .unwrap_or(Value::Null));
    }

    sets.push("updated_at = ?");
    params.push(Value::Number(now.into()));
    params.push(Value::String(id.clone()));

    let sql = format!("UPDATE foreshadows SET {} WHERE id = ?", sets.join(", "));
    db.execute(&sql, &params, "run")?;
    let rows = db.execute(
        "SELECT * FROM foreshadows WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?;
    Ok(rows
        .first()
        .cloned()
        .map(Value::Object)
        .unwrap_or(Value::Null))
}

pub fn delete(db: &Database, id: String) -> anyhow::Result<()> {
    db.execute(
        "DELETE FROM foreshadows WHERE id = ?",
        &[Value::String(id)],
        "run",
    )?;
    Ok(())
}

/// List foreshadows and their setup rows in a single DB lock acquisition.
/// Avoids a follow-up `db_execute` IPC that can time out under lock contention.
pub fn list_with_labels(
    db: &Database,
    project_id: String,
) -> anyhow::Result<ForeshadowListWithLabelsResponse> {
    let foreshadow_rows = db.execute(
        "SELECT * FROM foreshadows WHERE project_id = ? ORDER BY updated_at DESC",
        &[Value::String(project_id)],
        "all",
    )?;

    let foreshadows: Vec<Value> = foreshadow_rows.into_iter().map(Value::Object).collect();

    if foreshadows.is_empty() {
        return Ok(ForeshadowListWithLabelsResponse {
            foreshadows,
            setups: vec![],
        });
    }

    let ids: Vec<String> = foreshadows
        .iter()
        .filter_map(|v| {
            v.as_object()
                .and_then(|o| o.get("id"))
                .and_then(|id| id.as_str())
                .map(str::to_owned)
        })
        .collect();

    let placeholders = std::iter::repeat_n("?", ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let params: Vec<Value> = ids.into_iter().map(Value::String).collect();
    let setup_rows = db.execute(
        &format!(
            "SELECT foreshadow_id, is_orphan, strength, ai_strength, ai_reasoning, scene_id \
             FROM foreshadow_setups WHERE foreshadow_id IN ({placeholders})"
        ),
        &params,
        "all",
    )?;

    let setups = setup_rows.into_iter().map(Value::Object).collect();

    Ok(ForeshadowListWithLabelsResponse {
        foreshadows,
        setups,
    })
}

/// Open (unresolved) foreshadows + setup label rows in one DB lock acquisition.
pub fn list_open_for_context(
    db: &Database,
    project_id: String,
) -> anyhow::Result<ForeshadowListWithLabelsResponse> {
    let foreshadow_rows = db.execute(
        "SELECT id, title, intent, load_bearing, payoff_confirmed, abandoned, updated_at \
         FROM foreshadows \
         WHERE project_id = ? AND payoff_confirmed = 0 AND abandoned = 0 AND secret = 0",
        &[Value::String(project_id)],
        "all",
    )?;
    let foreshadows: Vec<Value> = foreshadow_rows.into_iter().map(Value::Object).collect();
    if foreshadows.is_empty() {
        return Ok(ForeshadowListWithLabelsResponse {
            foreshadows,
            setups: vec![],
        });
    }
    let ids: Vec<String> = foreshadows
        .iter()
        .filter_map(|v| {
            v.as_object()
                .and_then(|o| o.get("id"))
                .and_then(|id| id.as_str())
                .map(str::to_owned)
        })
        .collect();
    let setups = fetch_setup_label_rows(db, &ids)?;
    Ok(ForeshadowListWithLabelsResponse {
        foreshadows,
        setups,
    })
}

pub fn get_scene_info(
    db: &Database,
    scene_id: String,
) -> anyhow::Result<ForeshadowSceneInfoResponse> {
    let setup_rows = db.execute(
        "SELECT DISTINCT foreshadow_id FROM foreshadow_setups WHERE scene_id = ?",
        &[Value::String(scene_id.clone())],
        "all",
    )?;
    let payoff_rows = db.execute(
        "SELECT id FROM foreshadows WHERE payoff_scene_id = ?",
        &[Value::String(scene_id)],
        "all",
    )?;
    let setup_foreshadow_ids = setup_rows
        .iter()
        .filter_map(|row| {
            row.get("foreshadow_id")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        })
        .collect();
    let payoff_foreshadow_ids = payoff_rows
        .iter()
        .filter_map(|row| row.get("id").and_then(|v| v.as_str()).map(str::to_owned))
        .collect();
    Ok(ForeshadowSceneInfoResponse {
        setup_foreshadow_ids,
        payoff_foreshadow_ids,
    })
}

pub fn get_scene_context(
    db: &Database,
    scene_id: String,
) -> anyhow::Result<ForeshadowSceneContextResponse> {
    let setup_rows = db.execute(
        "SELECT DISTINCT f.title AS title, f.intent AS intent \
         FROM foreshadow_setups fs \
         INNER JOIN foreshadows f ON fs.foreshadow_id = f.id \
         WHERE fs.scene_id = ? AND f.abandoned = 0",
        &[Value::String(scene_id.clone())],
        "all",
    )?;
    let payoff_rows = db.execute(
        "SELECT f.id AS id, f.title AS title, f.intent AS intent \
         FROM foreshadows f \
         WHERE f.payoff_scene_id = ? AND f.abandoned = 0",
        &[Value::String(scene_id.clone())],
        "all",
    )?;
    let payoff_ids: Vec<String> = payoff_rows
        .iter()
        .filter_map(|row| row.get("id").and_then(|v| v.as_str()).map(str::to_owned))
        .collect();
    let setup_scene_rows = if payoff_ids.is_empty() {
        vec![]
    } else {
        let placeholders = in_placeholders(payoff_ids.len());
        let params: Vec<Value> = payoff_ids.into_iter().map(Value::String).collect();
        db.execute(
            &format!(
                "SELECT fs.foreshadow_id AS foreshadow_id, tn.title AS scene_title \
                 FROM foreshadow_setups fs \
                 INNER JOIN tree_nodes tn ON fs.scene_id = tn.id \
                 WHERE fs.foreshadow_id IN ({placeholders})"
            ),
            &params,
            "all",
        )?
        .into_iter()
        .map(Value::Object)
        .collect()
    };
    Ok(ForeshadowSceneContextResponse {
        setups: setup_rows.into_iter().map(Value::Object).collect(),
        payoffs: payoff_rows.into_iter().map(Value::Object).collect(),
        setup_scene_rows,
    })
}

pub fn list_by_codex_entry(
    db: &Database,
    codex_entry_id: String,
) -> anyhow::Result<ForeshadowListWithLabelsResponse> {
    let link_rows = db.execute(
        "SELECT foreshadow_id FROM foreshadow_codex_links WHERE codex_entry_id = ?",
        &[Value::String(codex_entry_id)],
        "all",
    )?;
    if link_rows.is_empty() {
        return Ok(ForeshadowListWithLabelsResponse {
            foreshadows: vec![],
            setups: vec![],
        });
    }
    let ids: Vec<String> = link_rows
        .iter()
        .filter_map(|row| {
            row.get("foreshadow_id")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        })
        .collect();
    let placeholders = in_placeholders(ids.len());
    let params: Vec<Value> = ids.iter().cloned().map(Value::String).collect();
    let foreshadow_rows = db.execute(
        &format!("SELECT * FROM foreshadows WHERE id IN ({placeholders})"),
        &params,
        "all",
    )?;
    let foreshadows: Vec<Value> = foreshadow_rows.into_iter().map(Value::Object).collect();
    let setups = fetch_setup_label_rows(db, &ids)?;
    Ok(ForeshadowListWithLabelsResponse {
        foreshadows,
        setups,
    })
}

pub fn get_chapter_stats(
    db: &Database,
    chapter_id: String,
) -> anyhow::Result<ForeshadowChapterStatsBundle> {
    let scenes = db.execute(
        "SELECT id, content FROM tree_nodes WHERE parent_id = ? AND node_type = 'scene'",
        &[Value::String(chapter_id)],
        "all",
    )?;
    if scenes.is_empty() {
        return Ok(ForeshadowChapterStatsBundle {
            scenes: vec![],
            setups_on_scenes: vec![],
            payoff_foreshadows: vec![],
            related_foreshadows: vec![],
            related_setups: vec![],
        });
    }
    let scene_ids: Vec<String> = scenes
        .iter()
        .filter_map(|row| row.get("id").and_then(|v| v.as_str()).map(str::to_owned))
        .collect();
    let scene_placeholders = in_placeholders(scene_ids.len());
    let scene_params: Vec<Value> = scene_ids.iter().cloned().map(Value::String).collect();
    let setups_on_scenes = db.execute(
        &format!("SELECT * FROM foreshadow_setups WHERE scene_id IN ({scene_placeholders})"),
        &scene_params,
        "all",
    )?;
    let payoff_foreshadows = db.execute(
        &format!("SELECT * FROM foreshadows WHERE payoff_scene_id IN ({scene_placeholders})"),
        &scene_params,
        "all",
    )?;
    let mut related_ids: Vec<String> = setups_on_scenes
        .iter()
        .filter_map(|row| {
            row.get("foreshadow_id")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        })
        .collect();
    for row in &payoff_foreshadows {
        if let Some(id) = row.get("id").and_then(|v| v.as_str()) {
            if !related_ids.iter().any(|existing| existing == id) {
                related_ids.push(id.to_string());
            }
        }
    }
    if related_ids.is_empty() {
        return Ok(ForeshadowChapterStatsBundle {
            scenes: scenes.into_iter().map(Value::Object).collect(),
            setups_on_scenes: setups_on_scenes.into_iter().map(Value::Object).collect(),
            payoff_foreshadows: payoff_foreshadows.into_iter().map(Value::Object).collect(),
            related_foreshadows: vec![],
            related_setups: vec![],
        });
    }
    let related_placeholders = in_placeholders(related_ids.len());
    let related_params: Vec<Value> = related_ids.iter().cloned().map(Value::String).collect();
    let related_foreshadows = db.execute(
        &format!("SELECT * FROM foreshadows WHERE id IN ({related_placeholders})"),
        &related_params,
        "all",
    )?;
    let related_setups = fetch_setup_label_rows(db, &related_ids)?;
    Ok(ForeshadowChapterStatsBundle {
        scenes: scenes.into_iter().map(Value::Object).collect(),
        setups_on_scenes: setups_on_scenes.into_iter().map(Value::Object).collect(),
        payoff_foreshadows: payoff_foreshadows.into_iter().map(Value::Object).collect(),
        related_foreshadows: related_foreshadows.into_iter().map(Value::Object).collect(),
        related_setups,
    })
}

pub fn get_setup(db: &Database, setup_id: String) -> anyhow::Result<Option<Value>> {
    let rows = db.execute(
        "SELECT * FROM foreshadow_setups WHERE id = ?",
        &[Value::String(setup_id)],
        "get",
    )?;
    Ok(rows.first().cloned().map(Value::Object))
}

pub fn update_setup(db: &Database, id: String, patch: ForeshadowSetupPatch) -> anyhow::Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut sets: Vec<&str> = Vec::new();
    let mut params: Vec<Value> = Vec::new();

    if let Some(strength) = patch.strength {
        sets.push("strength = ?");
        params.push(strength.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(ai_strength) = patch.ai_strength {
        sets.push("ai_strength = ?");
        params.push(ai_strength.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(ai_reasoning) = patch.ai_reasoning {
        sets.push("ai_reasoning = ?");
        params.push(ai_reasoning.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(is_orphan) = patch.is_orphan {
        sets.push("is_orphan = ?");
        params.push(Value::Bool(is_orphan));
    }
    if let Some(last_evaluated_at) = patch.last_evaluated_at {
        sets.push("last_evaluated_at = ?");
        params.push(
            last_evaluated_at
                .map(|v| Value::Number(v.into()))
                .unwrap_or(Value::Null),
        );
    }

    if sets.is_empty() {
        return Ok(());
    }

    sets.push("updated_at = ?");
    params.push(Value::Number(now.into()));
    params.push(Value::String(id.clone()));

    let sql = format!(
        "UPDATE foreshadow_setups SET {} WHERE id = ?",
        sets.join(", ")
    );
    db.execute(&sql, &params, "run")?;
    Ok(())
}

pub fn get(db: &Database, id: String) -> anyhow::Result<Value> {
    let foreshadow_rows = db.execute(
        "SELECT * FROM foreshadows WHERE id = ?",
        &[Value::String(id.clone())],
        "get",
    )?;
    let setup_rows = db.execute(
        "SELECT * FROM foreshadow_setups WHERE foreshadow_id = ? ORDER BY created_at ASC",
        &[Value::String(id)],
        "all",
    )?;
    let mut detail = serde_json::Map::new();
    detail.insert(
        "foreshadow".to_string(),
        foreshadow_rows
            .first()
            .cloned()
            .map(Value::Object)
            .unwrap_or(Value::Null),
    );
    detail.insert(
        "setups".to_string(),
        Value::Array(setup_rows.into_iter().map(Value::Object).collect()),
    );
    Ok(Value::Object(detail))
}

pub fn link_codex(db: &Database, foreshadow_id: String, codex_id: String) -> anyhow::Result<()> {
    db.execute(
        "INSERT OR IGNORE INTO foreshadow_codex_links (foreshadow_id, codex_entry_id) VALUES (?, ?)",
        &[Value::String(foreshadow_id), Value::String(codex_id)],
        "run",
    )?;
    Ok(())
}

pub fn unlink_codex(db: &Database, foreshadow_id: String, codex_id: String) -> anyhow::Result<()> {
    db.execute(
        "DELETE FROM foreshadow_codex_links WHERE foreshadow_id = ? AND codex_entry_id = ?",
        &[Value::String(foreshadow_id), Value::String(codex_id)],
        "run",
    )?;
    Ok(())
}

pub fn list_linked_codex(db: &Database, foreshadow_id: String) -> anyhow::Result<Vec<Value>> {
    let rows = db.execute(
        "SELECT ce.* FROM codex_entries ce \
         JOIN foreshadow_codex_links fcl ON ce.id = fcl.codex_entry_id \
         WHERE fcl.foreshadow_id = ? \
         ORDER BY ce.name ASC",
        &[Value::String(foreshadow_id)],
        "all",
    )?;
    Ok(rows.into_iter().map(Value::Object).collect())
}

pub fn set_setup_strength(
    db: &Database,
    setup_id: String,
    strength: Option<String>,
) -> anyhow::Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    db.execute(
        "UPDATE foreshadow_setups SET strength = ?, updated_at = ? WHERE id = ?",
        &[
            strength.map(Value::String).unwrap_or(Value::Null),
            Value::Number(now.into()),
            Value::String(setup_id),
        ],
        "run",
    )?;
    Ok(())
}

pub fn setup_create_ai(db: &Database, input: SetupCreateAiInput) -> anyhow::Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    db.execute(
        "INSERT INTO foreshadow_setups
         (id, foreshadow_id, scene_id, from_pos, to_pos, kind, strength, ai_strength,
          attribution, ai_rationale, ai_reasoning, last_evaluated_at, is_orphan, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           from_pos   = excluded.from_pos,
           to_pos     = excluded.to_pos,
           is_orphan  = 0,
           updated_at = excluded.updated_at",
        &[
            Value::String(input.id),
            Value::String(input.foreshadow_id),
            Value::String(input.scene_id),
            Value::Number(input.from_pos.into()),
            Value::Number(input.to_pos.into()),
            Value::String(input.kind),
            input.strength.map(Value::String).unwrap_or(Value::Null),
            input.ai_strength.map(Value::String).unwrap_or(Value::Null),
            Value::String(input.attribution),
            input.ai_rationale.map(Value::String).unwrap_or(Value::Null),
            input.ai_reasoning.map(Value::String).unwrap_or(Value::Null),
            input
                .last_evaluated_at
                .map(|v| Value::Number(v.into()))
                .unwrap_or(Value::Null),
            Value::Number(now.into()),
            Value::Number(now.into()),
        ],
        "run",
    )?;
    Ok(())
}

pub fn resolve_orphan(db: &Database, payload: OrphanResolvePayload) -> anyhow::Result<Option<String>> {
    let now = chrono::Utc::now().timestamp_millis();
    match payload.action.as_str() {
        "reanchor" => {
            let scene_id = payload
                .scene_id
                .ok_or_else(|| anyhow::anyhow!("reanchor requires scene_id"))?;
            let from_pos = payload
                .from_pos
                .ok_or_else(|| anyhow::anyhow!("reanchor requires from_pos"))?;
            let to_pos = payload
                .to_pos
                .ok_or_else(|| anyhow::anyhow!("reanchor requires to_pos"))?;
            db.execute(
                "UPDATE foreshadow_setups
                 SET scene_id = ?, from_pos = ?, to_pos = ?, is_orphan = 0, updated_at = ?
                 WHERE id = ?",
                &[
                    Value::String(scene_id),
                    Value::Number(from_pos.into()),
                    Value::Number(to_pos.into()),
                    Value::Number(now.into()),
                    Value::String(payload.setup_id),
                ],
                "run",
            )?;
            Ok(None)
        }
        "delete" => {
            db.execute(
                "DELETE FROM foreshadow_setups WHERE id = ?",
                &[Value::String(payload.setup_id)],
                "run",
            )?;
            Ok(None)
        }
        "reinsert" => {
            let rows = db.execute(
                "SELECT foreshadow_id, strength, ai_strength, ai_reasoning, attribution, ai_rationale, last_evaluated_at
                 FROM foreshadow_setups WHERE id = ?",
                &[Value::String(payload.setup_id.clone())],
                "get",
            )?;
            let Some(existing) = rows.first() else {
                return Ok(None);
            };
            let new_id = uuid::Uuid::new_v4().to_string();
            // INSERT + DELETE must be atomic to prevent duplicate rows on partial failure.
            db.execute_batch_tx(&[
                BatchStatement {
                    sql: "INSERT INTO foreshadow_setups
                          (id, foreshadow_id, scene_id, from_pos, to_pos, kind, strength, ai_strength, ai_reasoning, attribution, ai_rationale, last_evaluated_at, is_orphan, created_at, updated_at)
                          VALUES (?, ?, ?, ?, ?, 'inserted_new', ?, ?, ?, ?, ?, ?, 0, ?, ?)"
                        .to_string(),
                    params: vec![
                        Value::String(new_id.clone()),
                        existing.get("foreshadow_id").cloned().unwrap_or(Value::Null),
                        payload
                            .scene_id
                            .map(Value::String)
                            .unwrap_or(Value::Null),
                        payload
                            .from_pos
                            .map(|v| Value::Number(v.into()))
                            .unwrap_or(Value::Null),
                        payload
                            .to_pos
                            .map(|v| Value::Number(v.into()))
                            .unwrap_or(Value::Null),
                        existing.get("strength").cloned().unwrap_or(Value::Null),
                        existing.get("ai_strength").cloned().unwrap_or(Value::Null),
                        existing.get("ai_reasoning").cloned().unwrap_or(Value::Null),
                        existing
                            .get("attribution")
                            .cloned()
                            .unwrap_or_else(|| Value::String("human".to_string())),
                        existing.get("ai_rationale").cloned().unwrap_or(Value::Null),
                        existing
                            .get("last_evaluated_at")
                            .cloned()
                            .unwrap_or(Value::Null),
                        Value::Number(now.into()),
                        Value::Number(now.into()),
                    ],
                    method: "run".to_string(),
                },
                BatchStatement {
                    sql: "DELETE FROM foreshadow_setups WHERE id = ?".to_string(),
                    params: vec![Value::String(payload.setup_id)],
                    method: "run".to_string(),
                },
            ])?;
            Ok(Some(new_id))
        }
        _ => Ok(None),
    }
}

pub fn save_anchors_for_scene(
    db: &Database,
    scene_id: String,
    setups: Vec<SetupAnchorInput>,
    payoffs: Vec<PayoffAnchorInput>,
    doc_content_size: i64,
) -> anyhow::Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut statements: Vec<BatchStatement> = Vec::new();

    for s in &setups {
        statements.push(BatchStatement {
            sql: "INSERT INTO foreshadow_setups
                  (id, foreshadow_id, scene_id, from_pos, to_pos, kind, attribution, is_orphan, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, 'designated_existing', 'human', 0, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET
                    from_pos   = excluded.from_pos,
                    to_pos     = excluded.to_pos,
                    is_orphan  = 0,
                    updated_at = excluded.updated_at"
                .to_string(),
            params: vec![
                Value::String(s.id.clone()),
                Value::String(s.foreshadow_id.clone()),
                Value::String(s.scene_id.clone()),
                Value::Number(s.from_pos.into()),
                Value::Number(s.to_pos.into()),
                Value::Number(now.into()),
                Value::Number(now.into()),
            ],
            method: "run".to_string(),
        });
    }

    for p in &payoffs {
        statements.push(BatchStatement {
            sql: "UPDATE foreshadows
                  SET payoff_scene_id = ?, payoff_from_pos = ?, payoff_to_pos = ?, updated_at = ?
                  WHERE id = ?"
                .to_string(),
            params: vec![
                Value::String(p.scene_id.clone()),
                Value::Number(p.from_pos.into()),
                Value::Number(p.to_pos.into()),
                Value::Number(now.into()),
                Value::String(p.foreshadow_id.clone()),
            ],
            method: "run".to_string(),
        });
    }

    if setups.is_empty() {
        // Guard: skip bulk-orphan when the document has content (doc_content_size > 2).
        // ProseMirror empty doc has size=2 (root+paragraph). A non-empty doc with zero
        // extracted setups could indicate an extraction bug; conservatively skip to
        // prevent accidental data loss. Users can reload or manually clean orphans.
        if doc_content_size <= 2 {
            statements.push(BatchStatement {
                sql: "UPDATE foreshadow_setups SET is_orphan = 1, updated_at = ? WHERE scene_id = ?"
                    .to_string(),
                params: vec![Value::Number(now.into()), Value::String(scene_id.clone())],
                method: "run".to_string(),
            });
        }
    } else {
        let placeholders = std::iter::repeat_n("?", setups.len())
            .collect::<Vec<_>>()
            .join(", ");
        let mut params = vec![Value::Number(now.into()), Value::String(scene_id.clone())];
        params.extend(setups.iter().map(|s| Value::String(s.id.clone())));
        statements.push(BatchStatement {
            sql: format!(
                "UPDATE foreshadow_setups
                 SET is_orphan = 1, updated_at = ?
                 WHERE scene_id = ? AND id NOT IN ({placeholders})"
            ),
            params,
            method: "run".to_string(),
        });
    }

    if !statements.is_empty() {
        db.execute_batch_tx(&statements)?;
    }
    Ok(())
}

pub fn load_anchors_for_scene(
    db: &Database,
    scene_id: String,
) -> anyhow::Result<Vec<AnchorMarkOutput>> {
    let setup_rows = db.execute(
        "SELECT id, foreshadow_id, from_pos, to_pos
         FROM foreshadow_setups
         WHERE scene_id = ? AND is_orphan = 0",
        &[Value::String(scene_id.clone())],
        "all",
    )?;
    let payoff_rows = db.execute(
        "SELECT id, payoff_from_pos, payoff_to_pos
         FROM foreshadows
         WHERE payoff_scene_id = ?",
        &[Value::String(scene_id)],
        "all",
    )?;

    let mut out = Vec::new();
    for row in setup_rows {
        let from = row.get("from_pos").and_then(|v| v.as_i64()).unwrap_or(0);
        let to = row.get("to_pos").and_then(|v| v.as_i64()).unwrap_or(0);
        if from <= 0 || to <= 0 {
            continue;
        }
        let setup_id = row
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let foreshadow_id = row
            .get("foreshadow_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        out.push(AnchorMarkOutput {
            from,
            to,
            mark_name: "foreshadowSetup".to_string(),
            attrs: serde_json::json!({ "setupId": setup_id, "foreshadowId": foreshadow_id }),
        });
    }
    for row in payoff_rows {
        let from = row
            .get("payoff_from_pos")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let to = row
            .get("payoff_to_pos")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        if from <= 0 || to <= 0 {
            continue;
        }
        let foreshadow_id = row
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        out.push(AnchorMarkOutput {
            from,
            to,
            mark_name: "foreshadowPayoff".to_string(),
            attrs: serde_json::json!({ "foreshadowId": foreshadow_id }),
        });
    }
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::path::Path;

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        db
    }

    fn insert_project(db: &Database) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO projects (id, title) VALUES (?, 'Test')",
            &[Value::String(id.clone())],
            "run",
        )
        .expect("insert project");
        id
    }

    fn insert_foreshadow(db: &Database, project_id: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        db.execute(
            "INSERT INTO foreshadows (id, project_id, title, payoff_confirmed, abandoned, secret, created_at, updated_at)
             VALUES (?, ?, 'Test', 0, 0, 0, ?, ?)",
            &[
                Value::String(id.clone()),
                Value::String(project_id.to_string()),
                Value::Number(now.into()),
                Value::Number(now.into()),
            ],
            "run",
        )
        .expect("insert foreshadow");
        id
    }

    fn insert_scene(db: &Database, project_id: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
             VALUES (?, ?, 'scene', 'Scene', '{}', 'a0')",
            &[
                Value::String(id.clone()),
                Value::String(project_id.to_string()),
            ],
            "run",
        )
        .expect("insert scene");
        id
    }

    fn insert_setup(
        db: &Database,
        foreshadow_id: &str,
        scene_id: &str,
        from_pos: i64,
        to_pos: i64,
        is_orphan: bool,
    ) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        db.execute(
            "INSERT INTO foreshadow_setups
             (id, foreshadow_id, scene_id, from_pos, to_pos, kind, attribution, is_orphan, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'designated_existing', 'human', ?, ?, ?)",
            &[
                Value::String(id.clone()),
                Value::String(foreshadow_id.to_string()),
                Value::String(scene_id.to_string()),
                Value::Number(from_pos.into()),
                Value::Number(to_pos.into()),
                Value::Bool(is_orphan),
                Value::Number(now.into()),
                Value::Number(now.into()),
            ],
            "run",
        )
        .expect("insert setup");
        id
    }

    // ── update ────────────────────────────────────────────────────────

    #[test]
    fn update_impl_no_fields_returns_existing() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);

        let patch = ForeshadowPatch {
            title: None,
            intent: None,
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: None,
        };
        let result = update(&db, fid.clone(), patch).unwrap();
        assert_eq!(result["id"], Value::String(fid));
    }

    #[test]
    fn update_impl_single_field_updates_title() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);

        let patch = ForeshadowPatch {
            title: Some("新タイトル".to_string()),
            intent: None,
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: None,
        };
        let result = update(&db, fid.clone(), patch).unwrap();
        assert_eq!(result["title"], Value::String("新タイトル".to_string()));
    }

    #[test]
    fn update_impl_null_clear_intent() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);

        // Set intent first
        let set_patch = ForeshadowPatch {
            title: None,
            intent: Some(Some("intent".to_string())),
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: None,
        };
        update(&db, fid.clone(), set_patch).unwrap();

        // Now clear it with Some(None)
        let clear_patch = ForeshadowPatch {
            title: None,
            intent: Some(None),
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: None,
        };
        let result = update(&db, fid.clone(), clear_patch).unwrap();
        assert_eq!(result["intent"], Value::Null);
    }

    // ── load_bearing 軸（Phase 6） ─────────────────────────────────────

    #[test]
    fn validate_load_bearing_accepts_known_values_and_null() {
        assert!(validate_load_bearing(None).is_ok());
        assert!(validate_load_bearing(Some("critical")).is_ok());
        assert!(validate_load_bearing(Some("supporting")).is_ok());
        assert!(validate_load_bearing(Some("optional")).is_ok());
    }

    #[test]
    fn validate_load_bearing_rejects_unknown_values() {
        assert!(validate_load_bearing(Some("")).is_err());
        assert!(validate_load_bearing(Some("Critical")).is_err());
        assert!(validate_load_bearing(Some("required")).is_err());
        assert!(validate_load_bearing(Some("'; DROP TABLE foreshadows --")).is_err());
    }

    #[test]
    fn create_impl_persists_load_bearing() {
        let db = test_db();
        let proj = insert_project(&db);
        let payload = ForeshadowCreatePayload {
            project_id: proj,
            title: "T".to_string(),
            intent: None,
            load_bearing: Some("critical".to_string()),
        };
        let row = create(&db, payload).unwrap();
        assert_eq!(row["load_bearing"], Value::String("critical".to_string()));
    }

    #[test]
    fn create_impl_rejects_invalid_load_bearing() {
        let db = test_db();
        let proj = insert_project(&db);
        let payload = ForeshadowCreatePayload {
            project_id: proj.clone(),
            title: "T".to_string(),
            intent: None,
            load_bearing: Some("required".to_string()),
        };
        let result = create(&db, payload);
        assert!(result.is_err(), "invalid load_bearing should reject");

        // バリデーション後の副作用が無いこと（INSERT が実行されていない）を確認
        let rows = db
            .execute(
                "SELECT COUNT(*) AS n FROM foreshadows WHERE project_id = ?",
                &[Value::String(proj)],
                "all",
            )
            .unwrap();
        assert_eq!(rows[0]["n"], Value::Number(0.into()));
    }

    #[test]
    fn update_impl_sets_load_bearing() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);

        let patch = ForeshadowPatch {
            title: None,
            intent: None,
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: Some(Some("supporting".to_string())),
        };
        let result = update(&db, fid, patch).unwrap();
        assert_eq!(
            result["load_bearing"],
            Value::String("supporting".to_string())
        );
    }

    #[test]
    fn update_impl_clears_load_bearing_with_some_none() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);

        // まず critical にセット
        let set_patch = ForeshadowPatch {
            title: None,
            intent: None,
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: Some(Some("critical".to_string())),
        };
        update(&db, fid.clone(), set_patch).unwrap();

        // Some(None) で NULL クリア
        let clear_patch = ForeshadowPatch {
            title: None,
            intent: None,
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: Some(None),
        };
        let result = update(&db, fid, clear_patch).unwrap();
        assert_eq!(result["load_bearing"], Value::Null);
    }

    #[test]
    fn update_impl_rejects_invalid_load_bearing() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);

        let patch = ForeshadowPatch {
            title: Some("should not apply".to_string()),
            intent: None,
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: Some(Some("bogus".to_string())),
        };
        let result = update(&db, fid.clone(), patch);
        assert!(result.is_err(), "invalid load_bearing should reject");

        // 同 patch 内の他フィールドも反映されていないことを確認（早期 return）
        let rows = db
            .execute(
                "SELECT title FROM foreshadows WHERE id = ?",
                &[Value::String(fid)],
                "get",
            )
            .unwrap();
        assert_eq!(rows[0]["title"], Value::String("Test".to_string()));
    }

    // ── resolve_orphan ────────────────────────────────────────────────

    #[test]
    fn resolve_orphan_reanchor_missing_scene_id_errors() {
        let db = test_db();
        let payload = OrphanResolvePayload {
            setup_id: "s-1".to_string(),
            action: "reanchor".to_string(),
            scene_id: None,
            from_pos: Some(10),
            to_pos: Some(20),
        };
        let result = resolve_orphan(&db, payload);
        assert!(
            result.is_err(),
            "reanchor with missing scene_id should error"
        );
    }

    #[test]
    fn resolve_orphan_reanchor_missing_from_pos_errors() {
        let db = test_db();
        let payload = OrphanResolvePayload {
            setup_id: "s-1".to_string(),
            action: "reanchor".to_string(),
            scene_id: Some("sc-1".to_string()),
            from_pos: None,
            to_pos: Some(20),
        };
        let result = resolve_orphan(&db, payload);
        assert!(result.is_err());
    }

    #[test]
    fn resolve_orphan_reanchor_updates_row() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let old_scene = insert_scene(&db, &proj);
        let new_scene = insert_scene(&db, &proj);
        let sid = insert_setup(&db, &fid, &old_scene, 0, 0, true);

        let payload = OrphanResolvePayload {
            setup_id: sid.clone(),
            action: "reanchor".to_string(),
            scene_id: Some(new_scene.clone()),
            from_pos: Some(5),
            to_pos: Some(15),
        };
        resolve_orphan(&db, payload).unwrap();

        let rows = db
            .execute(
                "SELECT scene_id, from_pos, to_pos, is_orphan FROM foreshadow_setups WHERE id = ?",
                &[Value::String(sid)],
                "get",
            )
            .unwrap();
        let row = rows.first().unwrap();
        assert_eq!(row["scene_id"], Value::String(new_scene));
        assert_eq!(row["from_pos"], Value::Number(5.into()));
        assert_eq!(row["is_orphan"], Value::Number(0.into()));
    }

    #[test]
    fn resolve_orphan_reinsert_is_atomic_old_deleted_new_created() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let scene = insert_scene(&db, &proj);
        let sid = insert_setup(&db, &fid, &scene, 0, 0, true);

        let payload = OrphanResolvePayload {
            setup_id: sid.clone(),
            action: "reinsert".to_string(),
            scene_id: Some(scene.clone()),
            from_pos: Some(10),
            to_pos: Some(20),
        };
        let new_id = resolve_orphan(&db, payload).unwrap().unwrap();

        // Old row must be gone
        let old_rows = db
            .execute(
                "SELECT id FROM foreshadow_setups WHERE id = ?",
                &[Value::String(sid)],
                "all",
            )
            .unwrap();
        assert!(old_rows.is_empty(), "old setup should be deleted");

        // New row must exist with correct coords
        let new_rows = db
            .execute(
                "SELECT from_pos, to_pos, is_orphan FROM foreshadow_setups WHERE id = ?",
                &[Value::String(new_id)],
                "get",
            )
            .unwrap();
        let row = new_rows.first().unwrap();
        assert_eq!(row["from_pos"], Value::Number(10.into()));
        assert_eq!(row["to_pos"], Value::Number(20.into()));
        assert_eq!(row["is_orphan"], Value::Number(0.into()));
    }

    #[test]
    fn resolve_orphan_reinsert_missing_setup_returns_none() {
        let db = test_db();
        let payload = OrphanResolvePayload {
            setup_id: "nonexistent".to_string(),
            action: "reinsert".to_string(),
            scene_id: Some("sc".to_string()),
            from_pos: Some(1),
            to_pos: Some(5),
        };
        let result = resolve_orphan(&db, payload).unwrap();
        assert!(result.is_none());
    }

    // ── save_anchors_for_scene ────────────────────────────────────────

    #[test]
    fn save_anchors_orphans_absent_setups() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let scene = insert_scene(&db, &proj);
        let kept = insert_setup(&db, &fid, &scene, 1, 5, false);
        let gone = insert_setup(&db, &fid, &scene, 6, 10, false);

        // Only "kept" is in the setups list
        let setups = vec![SetupAnchorInput {
            id: kept.clone(),
            foreshadow_id: fid.clone(),
            scene_id: scene.clone(),
            from_pos: 1,
            to_pos: 5,
        }];
        save_anchors_for_scene(&db, scene.clone(), setups, vec![], 50).unwrap();

        let rows = db
            .execute(
                "SELECT id, is_orphan FROM foreshadow_setups WHERE scene_id = ? ORDER BY id",
                &[Value::String(scene)],
                "all",
            )
            .unwrap();
        let orphan_map: std::collections::HashMap<String, i64> = rows
            .iter()
            .map(|r| {
                (
                    r["id"].as_str().unwrap().to_string(),
                    r["is_orphan"].as_i64().unwrap_or(0),
                )
            })
            .collect();
        assert_eq!(orphan_map[&kept], 0, "kept setup must not be orphaned");
        assert_eq!(orphan_map[&gone], 1, "gone setup must be orphaned");
    }

    #[test]
    fn save_anchors_bulk_orphan_skipped_when_doc_has_content() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let scene = insert_scene(&db, &proj);
        let sid = insert_setup(&db, &fid, &scene, 1, 5, false);

        // setups empty but doc has content (size > 2) → bulk orphan must be skipped
        save_anchors_for_scene(&db, scene.clone(), vec![], vec![], 50).unwrap();

        let rows = db
            .execute(
                "SELECT is_orphan FROM foreshadow_setups WHERE id = ?",
                &[Value::String(sid)],
                "get",
            )
            .unwrap();
        assert_eq!(
            rows.first().unwrap()["is_orphan"],
            Value::Number(0.into()),
            "must not bulk-orphan when doc has content"
        );
    }

    #[test]
    fn save_anchors_bulk_orphan_fires_when_doc_empty() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let scene = insert_scene(&db, &proj);
        let sid = insert_setup(&db, &fid, &scene, 1, 5, false);

        // setups empty and doc is empty (size <= 2) → bulk orphan must fire
        save_anchors_for_scene(&db, scene.clone(), vec![], vec![], 2).unwrap();

        let rows = db
            .execute(
                "SELECT is_orphan FROM foreshadow_setups WHERE id = ?",
                &[Value::String(sid)],
                "get",
            )
            .unwrap();
        assert_eq!(
            rows.first().unwrap()["is_orphan"],
            Value::Number(1.into()),
            "must bulk-orphan when doc is empty"
        );
    }

    // ── load_anchors_for_scene ────────────────────────────────────────

    #[test]
    fn load_anchors_skips_setup_with_zero_coords() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let scene = insert_scene(&db, &proj);
        // Insert setup with from=0/to=0 (invalid coords)
        insert_setup(&db, &fid, &scene, 0, 0, false);

        let result = load_anchors_for_scene(&db, scene.clone()).unwrap();
        assert!(
            result.is_empty(),
            "setup with zero coords must be filtered out"
        );
    }

    #[test]
    fn load_anchors_returns_valid_setup() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let scene = insert_scene(&db, &proj);
        insert_setup(&db, &fid, &scene, 10, 20, false);

        let result = load_anchors_for_scene(&db, scene.clone()).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].from, 10);
        assert_eq!(result[0].to, 20);
        assert_eq!(result[0].mark_name, "foreshadowSetup");
    }

    #[test]
    fn load_anchors_skips_orphan_setups() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let scene = insert_scene(&db, &proj);
        insert_setup(&db, &fid, &scene, 10, 20, true); // orphan

        let result = load_anchors_for_scene(&db, scene.clone()).unwrap();
        assert!(result.is_empty(), "orphan setup must be excluded");
    }
}
