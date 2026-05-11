//! PostEffects Tauri コマンド群。
//! 設計書: docs/Grimodex_PostEffects設計書.md
//!
//! 実行フロー:
//!   start_post_effect_run → 即 run_id 返却 (fire-and-forget)
//!     → tokio::spawn で run_consistency_task / run_intra_task を実行
//!     → post_effect:progress / :partial / :done / :error イベントを emit

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use super::PostEffectAbortFlag;
use super::{AiSettingsPath, AppError, WorkspaceState};
use crate::ai::{call_post_effect_api, get_api_key, read_ai_settings};

// ---------------------------------------------------------------------------
// プロンプトバージョン定数 (プロンプトの本質的変更で minor/major を上げる)
// ---------------------------------------------------------------------------

const CONSISTENCY_PROMPT_VERSION: &str = "consistency_v1.0";
const INTRA_PROMPT_VERSION: &str = "intra_scene_consistency_v1.0";

// ---------------------------------------------------------------------------
// システムプロンプト定数 (凍結文字列 — template literal で動的注入しない)
// AUDIT POINT: cache_control は Codex prefix と Scene の境界に正確に挿入される。
// call_post_effect_api がこの前提でキャッシュ境界を制御する。
// ---------------------------------------------------------------------------

const CONSISTENCY_SYSTEM_PROMPT: &str = r#"You are a continuity checker for a novel manuscript.

Your task: inspect SCENE TEXT for factual contradictions against the CODEX entries provided.

Rules:
- Report ONLY violations where a specific claim in SCENE TEXT directly contradicts a specific field in the CODEX.
- Do NOT report internal scene inconsistencies between two passages (that is intra_scene_consistency's role).
- Do NOT report anything that is not in the CODEX at all — only check against what is explicitly stated in CODEX fields.
- If a span does not contradict any CODEX entry, do not report it.
- Include enough context in found_context (~30 characters before/after found_text) to locate the exact position in the scene.

Respond with a JSON object in this exact format (no markdown, no explanation, only the JSON):
{
  "violations": [
    {
      "entry_id": "string",
      "source_field": "summary" | "content" | "detail",
      "source_excerpt": "string (quote from CODEX that is contradicted)",
      "detail_definition_id": "string or null",
      "expected_value": "string (what CODEX says)",
      "found_text": "string (exact text in SCENE that contradicts)",
      "found_context": "string (~30 chars before+after found_text for positioning)",
      "confidence": "high" | "medium" | "low",
      "reason": "string (brief explanation)"
    }
  ]
}"#;

const INTRA_SYSTEM_PROMPT: &str = r#"You are a continuity checker for a novel manuscript.

Your task: detect internal self-contradictions WITHIN the SCENE TEXT itself.

Rules:
- Only report contradictions where two different passages in the SAME scene are inconsistent (same character's state/action/attribute contradicting itself, etc.).
- No CODEX is provided — judge only by the scene text itself.
- Do NOT report anything that is not a genuine contradiction.
- Include enough context in found_context (~30 characters before/after found_text) to locate the exact position.

Respond with a JSON object in this exact format (no markdown, no explanation, only the JSON):
{
  "pairs": [
    {
      "a": {
        "found_text": "string (first contradicting passage)",
        "found_context": "string (~30 chars before+after)"
      },
      "b": {
        "found_text": "string (second contradicting passage)",
        "found_context": "string (~30 chars before+after)"
      },
      "confidence": "high" | "medium" | "low",
      "reason": "string (brief explanation)"
    }
  ]
}"#;

// ---------------------------------------------------------------------------
// Input / Output 型
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct StartPostEffectRunArgs {
    project_id: String,
    effect_type: String,
    scope_type: String,
    scope_target_id: Option<String>,
    model: String,
    prompt_version: String,
    input_hash: String,
    /// JSON array of CodexPayloadEntry (consistency のみ; intra では空 JSON array を渡す)
    codex_payload_json: String,
    scene_text: String,
}

#[derive(Serialize)]
pub(crate) struct StartPostEffectRunResult {
    run_id: String,
    from_cache: bool,
}

// ---------------------------------------------------------------------------
// Multi-scene run types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct ScenePayload {
    scene_id: String,
    codex_payload_json: String,
    scene_text: String,
}

#[derive(Deserialize)]
pub(crate) struct StartPostEffectRunMultiArgs {
    project_id: String,
    effect_type: String,
    scope_type: String,
    scope_target_id: Option<String>,
    model: String,
    prompt_version: String,
    input_hash: String,
    scenes: Vec<ScenePayload>,
}

#[derive(Clone, Serialize)]
struct ProgressEvent<'a> {
    run_id: &'a str,
    stage: &'a str,
    progress: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
}

#[derive(Clone, Serialize)]
struct PartialEvent<'a> {
    run_id: &'a str,
    annotation_id: String,
}

#[derive(Clone, Serialize)]
struct DoneEvent<'a> {
    run_id: &'a str,
    annotation_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
}

#[derive(Clone, Serialize)]
struct ErrorEvent<'a> {
    run_id: &'a str,
    error: String,
}

// ---------------------------------------------------------------------------
// テキスト検索ユーティリティ
// ---------------------------------------------------------------------------

/// 空白を正規化 (連続空白→単一スペース、trim)。
fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// SHA-256 ハッシュ (hex)。dismiss_key / dedupe key に使用。
fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

/// dismiss_key (consistency): hash(entry_id + "|" + normalize(found_text))
fn dismiss_key_consistency(entry_id: &str, found_text: &str) -> String {
    sha256_hex(&format!("{}|{}", entry_id, normalize_ws(found_text)))
}

/// dismiss_key (intra_scene): hash(scene_id + "|" + sorted found_texts joined)
fn dismiss_key_intra(scene_id: &str, a_text: &str, b_text: &str) -> String {
    let mut texts = [normalize_ws(a_text), normalize_ws(b_text)];
    texts.sort();
    sha256_hex(&format!("{}|{}|{}", scene_id, texts[0], texts[1]))
}

/// LLM が返す JSON を markdown コードブロックから取り出す。
fn extract_json(raw: &str) -> &str {
    let trimmed = raw.trim();
    if let Some(inner) = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
    {
        inner.trim_end_matches("```").trim()
    } else {
        trimmed
    }
}

/// `found_context` をシーン本文で緩めにマッチし、その window 内で
/// `found_text` を locate する。文字単位のオフセットを返す。
/// 失敗時は `None` (orphaned annotation として扱う)。
fn find_text_position(
    scene_text: &str,
    found_text: &str,
    found_context: &str,
) -> Option<(usize, usize)> {
    let norm_scene = normalize_ws(scene_text);
    let norm_ctx = normalize_ws(found_context);
    let norm_ft = normalize_ws(found_text);

    if norm_ft.is_empty() {
        return None;
    }

    // まず found_context でウィンドウを絞る
    let search_region = if norm_ctx.is_empty() {
        norm_scene.as_str()
    } else {
        // context に found_text が含まれるはずなので context の前後 50 字拡張
        if let Some(ctx_pos) = norm_scene.find(norm_ctx.as_str()) {
            let start = ctx_pos.saturating_sub(50);
            let end = (ctx_pos + norm_ctx.len() + 50).min(norm_scene.len());
            &norm_scene[start..end]
        } else {
            norm_scene.as_str()
        }
    };

    // ウィンドウ内で found_text を検索
    let region_start = norm_scene.find(search_region).unwrap_or(0);

    if let Some(rel_pos) = search_region.find(norm_ft.as_str()) {
        let abs_start = region_start + rel_pos;
        let abs_end = abs_start + norm_ft.len();
        Some((abs_start, abs_end))
    } else {
        // フォールバック: 全文で検索
        norm_scene
            .find(norm_ft.as_str())
            .map(|pos| (pos, pos + norm_ft.len()))
    }
}

// ---------------------------------------------------------------------------
// DB ヘルパー: dismiss_key が manual dismiss 済みかチェック
// ---------------------------------------------------------------------------

fn is_manually_dismissed(conn: &rusqlite::Connection, dismiss_key: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM post_effect_annotations
          WHERE json_extract(metadata, '$.dismiss_key') = ?
            AND json_extract(metadata, '$.dismiss_source') = 'manual'
          LIMIT 1",
        params![dismiss_key],
        |_| Ok(()),
    )
    .is_ok()
}

// ---------------------------------------------------------------------------
// consistency run
// ---------------------------------------------------------------------------

/// consistency チェックを 1 シーン分実行し、挿入したアノテーション数を返す。
/// 進捗イベントや run ステータス更新は呼び出し側が担当する。
#[allow(clippy::too_many_arguments)]
async fn process_consistency_scene(
    app: &AppHandle,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    codex_payload_json: &str,
    scene_text: &str,
    ai_settings_path: &std::path::PathBuf,
) -> Result<usize, anyhow::Error> {
    let ai_settings = read_ai_settings(ai_settings_path);
    let api_key = match get_api_key(&ai_settings.provider) {
        Ok(Some(k)) => k,
        Ok(None) => return Err(anyhow::anyhow!("API キーが設定されていません")),
        Err(e) => return Err(anyhow::anyhow!("API キー取得失敗: {e}")),
    };

    let raw_response = call_post_effect_api(
        &ai_settings,
        &api_key,
        CONSISTENCY_SYSTEM_PROMPT,
        Some(codex_payload_json),
        scene_text,
    )
    .await
    .map_err(|e| anyhow::anyhow!("AI 呼び出し失敗: {e}"))?;

    let json_str = extract_json(&raw_response);
    let parsed: Value =
        serde_json::from_str(json_str).map_err(|e| anyhow::anyhow!("LLM 出力のパース失敗: {e}"))?;

    let violations = parsed["violations"].as_array().cloned().unwrap_or_default();

    let codex_entries: Vec<Value> = serde_json::from_str(codex_payload_json).unwrap_or_default();
    let name_map: HashMap<String, String> = codex_entries
        .iter()
        .filter_map(|e| {
            let id = e["id"].as_str()?.to_string();
            let name = e["name"].as_str()?.to_string();
            Some((id, name))
        })
        .collect();

    let mut seen_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    let deduped: Vec<&Value> = violations
        .iter()
        .filter(|v| {
            let entry_id = v["entry_id"].as_str().unwrap_or("");
            let source_field = v["source_field"].as_str().unwrap_or("");
            let detail_id = v["detail_definition_id"].as_str().unwrap_or("__none__");
            let found_text = normalize_ws(v["found_text"].as_str().unwrap_or(""));
            let key = format!("{entry_id}|{source_field}|{detail_id}|{found_text}");
            seen_keys.insert(key)
        })
        .collect();

    let ws_state = app.state::<WorkspaceState>();
    let count: usize = super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let mut count = 0usize;

            for violation in &deduped {
                let entry_id = violation["entry_id"].as_str().unwrap_or("");
                let found_text = violation["found_text"].as_str().unwrap_or("");
                let found_context = violation["found_context"].as_str().unwrap_or("");
                let confidence = violation["confidence"].as_str().unwrap_or("medium");
                let reason = violation["reason"].as_str().unwrap_or("");
                let expected_value = violation["expected_value"].as_str().unwrap_or("");
                let source_field = violation["source_field"].as_str().unwrap_or("content");
                let source_excerpt = violation["source_excerpt"].as_str();
                let detail_def_id = violation["detail_definition_id"].as_str();

                let severity = match confidence {
                    "high" => "error",
                    "low" => "suggestion",
                    _ => "warning",
                };

                let dismiss_key = dismiss_key_consistency(entry_id, found_text);
                let entry_name = name_map.get(entry_id).cloned().unwrap_or_default();
                let initial_status = if is_manually_dismissed(conn, &dismiss_key) {
                    "dismissed"
                } else {
                    "open"
                };

                let (range_start, range_end, orphaned) =
                    match find_text_position(scene_text, found_text, found_context) {
                        Some((s, e)) => (s as i64, e as i64, false),
                        None => (0i64, 0i64, true),
                    };

                let annotation_id = Uuid::new_v4().to_string();
                let content = format!(
                    "{}.{} と矛盾: {}",
                    entry_name,
                    detail_def_id.unwrap_or(source_field),
                    found_text
                );
                let metadata = serde_json::json!({
                    "codex_ref": {
                        "entry_id": entry_id,
                        "entry_name": entry_name,
                        "source_field": source_field,
                        "source_excerpt": source_excerpt,
                        "detail_definition_id": detail_def_id,
                        "expected_value": expected_value,
                        "found_value": found_text,
                        "found_text": found_text,
                        "found_context": found_context,
                        "confidence": confidence,
                        "llm_reason": reason,
                        "dismiss_key": dismiss_key,
                    },
                    "orphaned": orphaned,
                });

                conn.execute(
                    "INSERT INTO post_effect_annotations
                        (id, project_id, run_id, anchor_type, scene_id,
                         range_start, range_end, text_snapshot,
                         category, severity, content, author_role,
                         status, metadata, created_at, updated_at)
                     VALUES (?, ?, ?, 'scene_range', ?,
                             ?, ?, ?,
                             'consistency_anchor', ?, ?, 'ai',
                             ?, ?, datetime('now'), datetime('now'))",
                    params![
                        annotation_id,
                        project_id,
                        run_id,
                        scene_id,
                        range_start,
                        range_end,
                        found_text,
                        severity,
                        content,
                        initial_status,
                        metadata.to_string(),
                    ],
                )?;

                let _ = app.emit(
                    "post_effect:partial",
                    PartialEvent {
                        run_id,
                        annotation_id: annotation_id.clone(),
                    },
                );
                count += 1;
            }

            // 同じ scene の前回 open アノテーションを dismissed に
            conn.execute(
                "UPDATE post_effect_annotations
                    SET status = 'dismissed',
                        metadata = json_set(metadata, '$.dismiss_source', 'run_completed'),
                        updated_at = datetime('now')
                  WHERE status = 'open'
                    AND project_id = ?
                    AND scene_id = ?
                    AND category = 'consistency_anchor'
                    AND run_id != ?
                    AND run_id IS NOT NULL",
                params![project_id, scene_id, run_id],
            )?;

            Ok(count)
        })
    })?;

    Ok(count)
}

#[allow(clippy::too_many_arguments)]
async fn run_consistency_task(
    app: AppHandle,
    run_id: String,
    project_id: String,
    scene_id: String,
    codex_payload_json: String,
    scene_text: String,
    ai_settings_path: std::path::PathBuf,
) {
    let emit_err = |msg: &str| {
        let _ = app.emit(
            "post_effect:error",
            ErrorEvent {
                run_id: &run_id,
                error: msg.to_string(),
            },
        );
    };

    let _ = app.emit(
        "post_effect:progress",
        ProgressEvent {
            run_id: &run_id,
            stage: "calling_ai",
            progress: 0.1,
            message: None,
        },
    );

    match process_consistency_scene(
        &app,
        &run_id,
        &project_id,
        &scene_id,
        &codex_payload_json,
        &scene_text,
        &ai_settings_path,
    )
    .await
    {
        Ok(n) => {
            finalize_run(&app, &run_id);
            let _ = app.emit(
                "post_effect:done",
                DoneEvent {
                    run_id: &run_id,
                    annotation_count: n,
                    summary: None,
                },
            );
        }
        Err(e) => {
            emit_err(&e.to_string());
            fail_run(&app, &run_id, &e.to_string());
        }
    }
}

// ---------------------------------------------------------------------------
// intra_scene_consistency run
// ---------------------------------------------------------------------------

/// intra_scene_consistency チェックを 1 シーン分実行し、挿入したペア数を返す。
/// 進捗イベントや run ステータス更新は呼び出し側が担当する。
async fn process_intra_scene(
    app: &AppHandle,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    scene_text: &str,
    ai_settings_path: &std::path::PathBuf,
) -> Result<usize, anyhow::Error> {
    let ai_settings = read_ai_settings(ai_settings_path);
    let api_key = match get_api_key(&ai_settings.provider) {
        Ok(Some(k)) => k,
        Ok(None) => return Err(anyhow::anyhow!("API キーが設定されていません")),
        Err(e) => return Err(anyhow::anyhow!("API キー取得失敗: {e}")),
    };

    let raw_response = call_post_effect_api(
        &ai_settings,
        &api_key,
        INTRA_SYSTEM_PROMPT,
        None,
        scene_text,
    )
    .await
    .map_err(|e| anyhow::anyhow!("AI 呼び出し失敗: {e}"))?;

    let json_str = extract_json(&raw_response);
    let parsed: Value =
        serde_json::from_str(json_str).map_err(|e| anyhow::anyhow!("LLM 出力のパース失敗: {e}"))?;

    let pairs = parsed["pairs"].as_array().cloned().unwrap_or_default();

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let deduped: Vec<&Value> = pairs
        .iter()
        .filter(|p| {
            let a_t = normalize_ws(p["a"]["found_text"].as_str().unwrap_or(""));
            let b_t = normalize_ws(p["b"]["found_text"].as_str().unwrap_or(""));
            let mut sorted = [a_t.clone(), b_t.clone()];
            sorted.sort();
            let key = format!("{}|{}", scene_id, sorted.join("|"));
            seen.insert(key)
        })
        .collect();

    let ws_state = app.state::<WorkspaceState>();
    let count: usize = super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let mut count = 0usize;

            for pair in &deduped {
                let a_text = pair["a"]["found_text"].as_str().unwrap_or("");
                let a_ctx = pair["a"]["found_context"].as_str().unwrap_or("");
                let b_text = pair["b"]["found_text"].as_str().unwrap_or("");
                let b_ctx = pair["b"]["found_context"].as_str().unwrap_or("");
                let confidence = pair["confidence"].as_str().unwrap_or("medium");
                let reason = pair["reason"].as_str().unwrap_or("");
                let severity = match confidence {
                    "high" => "error",
                    "low" => "suggestion",
                    _ => "warning",
                };

                let dismiss_key = dismiss_key_intra(scene_id, a_text, b_text);
                let initial_status = if is_manually_dismissed(conn, &dismiss_key) {
                    "dismissed"
                } else {
                    "open"
                };

                let (a_start, a_end, a_orphaned) =
                    match find_text_position(scene_text, a_text, a_ctx) {
                        Some((s, e)) => (s as i64, e as i64, false),
                        None => (0i64, 0i64, true),
                    };
                let (b_start, b_end, b_orphaned) =
                    match find_text_position(scene_text, b_text, b_ctx) {
                        Some((s, e)) => (s as i64, e as i64, false),
                        None => (0i64, 0i64, true),
                    };

                let ann_a_id = Uuid::new_v4().to_string();
                let ann_b_id = Uuid::new_v4().to_string();
                let relation_id = Uuid::new_v4().to_string();

                let meta_a = serde_json::json!({
                    "confidence": confidence,
                    "llm_reason": reason,
                    "found_text": a_text,
                    "found_context": a_ctx,
                    "dismiss_key": dismiss_key,
                    "orphaned": a_orphaned,
                });
                let meta_b = serde_json::json!({
                    "confidence": confidence,
                    "llm_reason": reason,
                    "found_text": b_text,
                    "found_context": b_ctx,
                    "dismiss_key": dismiss_key,
                    "orphaned": b_orphaned,
                });

                conn.execute(
                    "INSERT INTO post_effect_annotations
                        (id, project_id, run_id, anchor_type, scene_id,
                         range_start, range_end, text_snapshot,
                         category, severity, content, author_role,
                         status, metadata, created_at, updated_at)
                     VALUES (?, ?, ?, 'scene_range', ?,
                             ?, ?, ?,
                             'consistency_anchor', ?, ?, 'ai',
                             ?, ?, datetime('now'), datetime('now'))",
                    params![
                        ann_a_id,
                        project_id,
                        run_id,
                        scene_id,
                        a_start,
                        a_end,
                        a_text,
                        severity,
                        reason,
                        initial_status,
                        meta_a.to_string(),
                    ],
                )?;
                conn.execute(
                    "INSERT INTO post_effect_annotations
                        (id, project_id, run_id, anchor_type, scene_id,
                         range_start, range_end, text_snapshot,
                         category, severity, content, author_role,
                         status, metadata, created_at, updated_at)
                     VALUES (?, ?, ?, 'scene_range', ?,
                             ?, ?, ?,
                             'consistency_anchor', ?, ?, 'ai',
                             ?, ?, datetime('now'), datetime('now'))",
                    params![
                        ann_b_id,
                        project_id,
                        run_id,
                        scene_id,
                        b_start,
                        b_end,
                        b_text,
                        severity,
                        reason,
                        initial_status,
                        meta_b.to_string(),
                    ],
                )?;
                conn.execute(
                    "INSERT INTO post_effect_annotation_relations
                        (id, project_id, run_id,
                         annotation_a_id, annotation_b_id,
                         relation_type, direction, description, status, metadata, created_at)
                     VALUES (?, ?, ?, ?, ?, 'contradiction', 'bidirectional', ?, 'open', '{}', datetime('now'))",
                    params![relation_id, project_id, run_id, ann_a_id, ann_b_id, reason],
                )?;

                let _ = app.emit(
                    "post_effect:partial",
                    PartialEvent {
                        run_id,
                        annotation_id: ann_a_id.clone(),
                    },
                );
                count += 1;
            }

            // 同じ scene の前回 open アノテーションを dismissed に
            conn.execute(
                "UPDATE post_effect_annotations
                    SET status = 'dismissed',
                        metadata = json_set(metadata, '$.dismiss_source', 'run_completed'),
                        updated_at = datetime('now')
                  WHERE status = 'open'
                    AND project_id = ?
                    AND scene_id = ?
                    AND category = 'consistency_anchor'
                    AND run_id != ?
                    AND run_id IS NOT NULL",
                params![project_id, scene_id, run_id],
            )?;

            Ok(count)
        })
    })?;

    Ok(count)
}

async fn run_intra_task(
    app: AppHandle,
    run_id: String,
    project_id: String,
    scene_id: String,
    scene_text: String,
    ai_settings_path: std::path::PathBuf,
) {
    let emit_err = |msg: &str| {
        let _ = app.emit(
            "post_effect:error",
            ErrorEvent {
                run_id: &run_id,
                error: msg.to_string(),
            },
        );
    };

    let _ = app.emit(
        "post_effect:progress",
        ProgressEvent {
            run_id: &run_id,
            stage: "calling_ai",
            progress: 0.1,
            message: None,
        },
    );

    match process_intra_scene(
        &app,
        &run_id,
        &project_id,
        &scene_id,
        &scene_text,
        &ai_settings_path,
    )
    .await
    {
        Ok(n) => {
            finalize_run(&app, &run_id);
            let _ = app.emit(
                "post_effect:done",
                DoneEvent {
                    run_id: &run_id,
                    annotation_count: n,
                    summary: None,
                },
            );
        }
        Err(e) => {
            emit_err(&e.to_string());
            fail_run(&app, &run_id, &e.to_string());
        }
    }
}

// ---------------------------------------------------------------------------
// Multi-scene run task
// ---------------------------------------------------------------------------

async fn run_multi_task(
    app: AppHandle,
    run_id: String,
    project_id: String,
    effect_type: String,
    scenes: Vec<ScenePayload>,
    ai_settings_path: std::path::PathBuf,
) {
    let total = scenes.len();
    let mut total_count = 0usize;

    for (idx, scene) in scenes.into_iter().enumerate() {
        let progress = (idx as f32) / (total as f32).max(1.0) * 0.9;
        let msg = format!("{}/{}", idx + 1, total);
        let _ = app.emit(
            "post_effect:progress",
            ProgressEvent {
                run_id: &run_id,
                stage: "calling_ai",
                progress,
                message: Some(&msg),
            },
        );

        let result = if effect_type == "consistency" {
            process_consistency_scene(
                &app,
                &run_id,
                &project_id,
                &scene.scene_id,
                &scene.codex_payload_json,
                &scene.scene_text,
                &ai_settings_path,
            )
            .await
        } else {
            process_intra_scene(
                &app,
                &run_id,
                &project_id,
                &scene.scene_id,
                &scene.scene_text,
                &ai_settings_path,
            )
            .await
        };

        match result {
            Ok(n) => total_count += n,
            Err(e) => {
                let _ = app.emit(
                    "post_effect:error",
                    ErrorEvent {
                        run_id: &run_id,
                        error: e.to_string(),
                    },
                );
                fail_run(&app, &run_id, &e.to_string());
                return;
            }
        }
    }

    finalize_run(&app, &run_id);
    let _ = app.emit(
        "post_effect:done",
        DoneEvent {
            run_id: &run_id,
            annotation_count: total_count,
            summary: None,
        },
    );
}

// ---------------------------------------------------------------------------
// ヘルパー: run を failed に落とす
// ---------------------------------------------------------------------------

fn fail_run(app: &AppHandle, run_id: &str, error_message: &str) {
    let ws_state = app.state::<WorkspaceState>();
    let _ = super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE post_effect_runs
                    SET status = 'failed', error_message = ?, completed_at = datetime('now')
                  WHERE id = ?",
                params![error_message, run_id],
            )?;
            Ok(())
        })
    });
}

fn finalize_run(app: &AppHandle, run_id: &str) {
    let ws_state = app.state::<WorkspaceState>();
    let _ = super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE post_effect_runs
                    SET status = 'completed', completed_at = datetime('now')
                  WHERE id = ?",
                params![run_id],
            )?;
            Ok(())
        })
    });
}

// ---------------------------------------------------------------------------
// Tauri コマンド
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn start_post_effect_run(
    ws_state: State<'_, WorkspaceState>,
    ai_settings_path: State<'_, AiSettingsPath>,
    abort_flag: State<'_, PostEffectAbortFlag>,
    app_handle: AppHandle,
    args: StartPostEffectRunArgs,
) -> Result<StartPostEffectRunResult, AppError> {
    // abort フラグをリセット
    abort_flag
        .flag
        .store(false, std::sync::atomic::Ordering::Relaxed);

    let effect_type = args.effect_type.as_str();
    let supported = matches!(effect_type, "consistency" | "intra_scene_consistency");
    if !supported {
        return Err(
            anyhow::anyhow!("effect_type '{}' は Phase 1b では未実装です", effect_type).into(),
        );
    }

    let prompt_version = if effect_type == "consistency" {
        CONSISTENCY_PROMPT_VERSION
    } else {
        INTRA_PROMPT_VERSION
    };
    if args.prompt_version != prompt_version {
        tracing::warn!(
            "prompt_version mismatch: got '{}', expected '{}'",
            args.prompt_version,
            prompt_version
        );
    }

    // キャッシュチェック: 同一 input_hash の completed run があれば再利用
    let cached_run_id: Option<String> = super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let result = conn.query_row(
                "SELECT id FROM post_effect_runs
                  WHERE project_id = ?
                    AND effect_type = ?
                    AND scope_type = ?
                    AND COALESCE(scope_target_id, '') = COALESCE(?, '')
                    AND input_hash = ?
                    AND status = 'completed'
                  ORDER BY started_at DESC
                  LIMIT 1",
                params![
                    args.project_id,
                    args.effect_type,
                    args.scope_type,
                    args.scope_target_id.as_deref(),
                    args.input_hash,
                ],
                |row: &rusqlite::Row<'_>| row.get::<_, String>(0),
            );
            Ok(result.ok())
        })
    })?;

    if let Some(existing_id) = cached_run_id {
        return Ok(StartPostEffectRunResult {
            run_id: existing_id,
            from_cache: true,
        });
    }

    // run 行を INSERT (UNIQUE 制約でも重複 running をブロック)
    let run_id = Uuid::new_v4().to_string();
    let run_id_clone = run_id.clone();

    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO post_effect_runs
                    (id, project_id, effect_type, scope_type, scope_target_id,
                     model, prompt_version, input_hash, status, started_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', datetime('now'))",
                params![
                    run_id_clone,
                    args.project_id,
                    args.effect_type,
                    args.scope_type,
                    args.scope_target_id.as_deref(),
                    args.model,
                    args.prompt_version,
                    args.input_hash,
                ],
            )?;
            Ok(())
        })
    })?;

    // scene_id は scope_target_id から取得 (scope_type='scene' のみ Phase 1b 対応)
    let scene_id = args.scope_target_id.clone().unwrap_or_default();

    let app = app_handle.clone();
    let ai_path = ai_settings_path.path.clone();
    let project_id = args.project_id.clone();
    let effect = args.effect_type.clone();
    let codex_json = args.codex_payload_json.clone();
    let scene_text = args.scene_text.clone();
    let rid = run_id.clone();

    tokio::task::spawn(async move {
        if effect == "consistency" {
            run_consistency_task(
                app, rid, project_id, scene_id, codex_json, scene_text, ai_path,
            )
            .await;
        } else {
            run_intra_task(app, rid, project_id, scene_id, scene_text, ai_path).await;
        }
    });

    Ok(StartPostEffectRunResult {
        run_id,
        from_cache: false,
    })
}

#[tauri::command]
pub(crate) async fn start_post_effect_run_multi(
    ws_state: State<'_, WorkspaceState>,
    ai_settings_path: State<'_, AiSettingsPath>,
    abort_flag: State<'_, PostEffectAbortFlag>,
    app_handle: AppHandle,
    args: StartPostEffectRunMultiArgs,
) -> Result<StartPostEffectRunResult, AppError> {
    abort_flag
        .flag
        .store(false, std::sync::atomic::Ordering::Relaxed);

    if args.scenes.is_empty() {
        return Err(anyhow::anyhow!("scenes が空です").into());
    }

    let effect_type = args.effect_type.as_str();
    let supported = matches!(effect_type, "consistency" | "intra_scene_consistency");
    if !supported {
        return Err(anyhow::anyhow!("effect_type '{}' は未実装です", effect_type).into());
    }

    // キャッシュチェック: 同一 input_hash の completed run があれば再利用
    let cached_run_id: Option<String> = super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let result = conn.query_row(
                "SELECT id FROM post_effect_runs
                  WHERE project_id = ?
                    AND effect_type = ?
                    AND scope_type = ?
                    AND COALESCE(scope_target_id, '') = COALESCE(?, '')
                    AND input_hash = ?
                    AND status = 'completed'
                  ORDER BY started_at DESC
                  LIMIT 1",
                params![
                    args.project_id,
                    args.effect_type,
                    args.scope_type,
                    args.scope_target_id.as_deref(),
                    args.input_hash,
                ],
                |row: &rusqlite::Row<'_>| row.get::<_, String>(0),
            );
            Ok(result.ok())
        })
    })?;

    if let Some(existing_id) = cached_run_id {
        return Ok(StartPostEffectRunResult {
            run_id: existing_id,
            from_cache: true,
        });
    }

    let run_id = Uuid::new_v4().to_string();
    let run_id_clone = run_id.clone();

    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO post_effect_runs
                    (id, project_id, effect_type, scope_type, scope_target_id,
                     model, prompt_version, input_hash, status, started_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', datetime('now'))",
                params![
                    run_id_clone,
                    args.project_id,
                    args.effect_type,
                    args.scope_type,
                    args.scope_target_id.as_deref(),
                    args.model,
                    args.prompt_version,
                    args.input_hash,
                ],
            )?;
            Ok(())
        })
    })?;

    let app = app_handle.clone();
    let ai_path = ai_settings_path.path.clone();
    let project_id = args.project_id.clone();
    let effect = args.effect_type.clone();
    let scenes = args.scenes;
    let rid = run_id.clone();

    tokio::task::spawn(async move {
        run_multi_task(app, rid, project_id, effect, scenes, ai_path).await;
    });

    Ok(StartPostEffectRunResult {
        run_id,
        from_cache: false,
    })
}

#[tauri::command]
pub(crate) fn abort_post_effect_run(
    abort_flag: State<'_, PostEffectAbortFlag>,
    ws_state: State<'_, WorkspaceState>,
    run_id: String,
) -> Result<(), AppError> {
    abort_flag
        .flag
        .store(true, std::sync::atomic::Ordering::Relaxed);
    // DB 上も cancelled にする (タスクが既に終わっている場合は影響なし)
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE post_effect_runs
                    SET status = 'cancelled', completed_at = datetime('now')
                  WHERE id = ? AND status = 'running'",
                params![run_id],
            )?;
            Ok(())
        })
    })
}

#[tauri::command]
pub(crate) fn list_post_effect_runs(
    ws_state: State<'_, WorkspaceState>,
    project_id: String,
    effect_type: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<Value>, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let limit = limit.unwrap_or(20);
            let offset = offset.unwrap_or(0);
            let rows = if let Some(et) = &effect_type {
                let mut stmt = conn.prepare(
                    "SELECT id, project_id, effect_type, scope_type, scope_target_id,
                            model, prompt_version, input_hash, status, summary,
                            error_message, started_at, completed_at
                       FROM post_effect_runs
                      WHERE project_id = ? AND effect_type = ?
                      ORDER BY started_at DESC
                      LIMIT ? OFFSET ?",
                )?;
                let r: Result<Vec<_>, _> = stmt
                    .query_map(params![project_id, et, limit, offset], row_to_run_value)?
                    .collect();
                r?
            } else {
                let mut stmt = conn.prepare(
                    "SELECT id, project_id, effect_type, scope_type, scope_target_id,
                            model, prompt_version, input_hash, status, summary,
                            error_message, started_at, completed_at
                       FROM post_effect_runs
                      WHERE project_id = ?
                      ORDER BY started_at DESC
                      LIMIT ? OFFSET ?",
                )?;
                let r: Result<Vec<_>, _> = stmt
                    .query_map(params![project_id, limit, offset], row_to_run_value)?
                    .collect();
                r?
            };
            Ok(rows)
        })
    })
}

#[tauri::command]
pub(crate) fn get_post_effect_run(
    ws_state: State<'_, WorkspaceState>,
    run_id: String,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let run = conn.query_row(
                "SELECT id, project_id, effect_type, scope_type, scope_target_id,
                        model, prompt_version, input_hash, status, summary,
                        error_message, started_at, completed_at
                   FROM post_effect_runs WHERE id = ?",
                params![run_id],
                row_to_run_value,
            )?;

            let annotations = {
                let mut stmt = conn.prepare(
                    "SELECT * FROM post_effect_annotations WHERE run_id = ? ORDER BY created_at",
                )?;
                let r: Result<Vec<_>, _> =
                    stmt.query_map(params![run_id], row_to_annotation_value)?.collect();
                r?
            };
            let relations = {
                let mut stmt = conn.prepare(
                    "SELECT * FROM post_effect_annotation_relations WHERE run_id = ? ORDER BY created_at",
                )?;
                let r: Result<Vec<_>, _> =
                    stmt.query_map(params![run_id], row_to_relation_value)?.collect();
                r?
            };

            let mut result = run;
            result["annotations"] = Value::Array(annotations);
            result["relations"] = Value::Array(relations);
            result["lens_data"] = Value::Array(vec![]);
            Ok(result)
        })
    })
}

#[tauri::command]
pub(crate) fn list_annotations_for_scene(
    ws_state: State<'_, WorkspaceState>,
    project_id: String,
    scene_id: String,
    status: Option<String>,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let annotations = if let Some(st) = &status {
                let mut stmt = conn.prepare(
                    "SELECT * FROM post_effect_annotations
                      WHERE project_id = ? AND scene_id = ? AND status = ?
                      ORDER BY range_start, created_at",
                )?;
                let r: Result<Vec<_>, _> = stmt
                    .query_map(params![project_id, scene_id, st], row_to_annotation_value)?
                    .collect();
                r?
            } else {
                let mut stmt = conn.prepare(
                    "SELECT * FROM post_effect_annotations
                      WHERE project_id = ? AND scene_id = ?
                      ORDER BY range_start, created_at",
                )?;
                let r: Result<Vec<_>, _> = stmt
                    .query_map(params![project_id, scene_id], row_to_annotation_value)?
                    .collect();
                r?
            };

            // 両端のどちらかが上記 annotations に含まれる relation を返す
            let ann_ids: Vec<String> = annotations
                .iter()
                .filter_map(|a| a["id"].as_str().map(|s: &str| s.to_string()))
                .collect();

            let relations = if ann_ids.is_empty() {
                vec![]
            } else {
                let placeholders = ann_ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
                let sql = format!(
                    "SELECT * FROM post_effect_annotation_relations
                      WHERE annotation_a_id IN ({placeholders})
                         OR annotation_b_id IN ({placeholders})"
                );
                let mut stmt = conn.prepare(&sql)?;
                // params は ann_ids を 2 回渡す必要がある
                let all_ids: Vec<&dyn rusqlite::ToSql> = ann_ids
                    .iter()
                    .chain(ann_ids.iter())
                    .map(|s| s as &dyn rusqlite::ToSql)
                    .collect();
                let r: Result<Vec<_>, _> = stmt
                    .query_map(all_ids.as_slice(), row_to_relation_value)?
                    .collect();
                r?
            };

            Ok(serde_json::json!({
                "annotations": annotations,
                "relations": relations,
            }))
        })
    })
}

#[tauri::command]
pub(crate) fn update_annotation_status(
    ws_state: State<'_, WorkspaceState>,
    annotation_id: String,
    status: String,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            // dismiss_source を status に合わせて更新
            let dismiss_source = if status == "dismissed" {
                Some("manual")
            } else {
                None
            };

            if let Some(src) = dismiss_source {
                conn.execute(
                    "UPDATE post_effect_annotations
                        SET status = ?,
                            metadata = json_set(metadata, '$.dismiss_source', ?),
                            updated_at = datetime('now')
                      WHERE id = ?",
                    params![status, src, annotation_id],
                )?;
            } else {
                conn.execute(
                    "UPDATE post_effect_annotations
                        SET status = ?, updated_at = datetime('now')
                      WHERE id = ?",
                    params![status, annotation_id],
                )?;
            }

            let ann = conn.query_row(
                "SELECT * FROM post_effect_annotations WHERE id = ?",
                params![annotation_id],
                row_to_annotation_value,
            )?;
            Ok(ann)
        })
    })
}

#[tauri::command]
pub(crate) fn update_relation_status(
    ws_state: State<'_, WorkspaceState>,
    relation_id: String,
    status: String,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE post_effect_annotation_relations
                    SET status = ?, metadata = json_set(metadata, '$.updated_at', datetime('now'))
                  WHERE id = ?",
                params![status, relation_id],
            )?;

            // §2: 両端 annotation を同じ status にカスケード
            conn.execute(
                "UPDATE post_effect_annotations
                    SET status = ?,
                        metadata = json_set(metadata, '$.dismiss_source', 'cascade'),
                        updated_at = datetime('now')
                  WHERE id IN (
                      SELECT annotation_a_id FROM post_effect_annotation_relations WHERE id = ?
                      UNION
                      SELECT annotation_b_id FROM post_effect_annotation_relations WHERE id = ?
                  )",
                params![status, relation_id, relation_id],
            )?;

            let rel = conn.query_row(
                "SELECT * FROM post_effect_annotation_relations WHERE id = ?",
                params![relation_id],
                row_to_relation_value,
            )?;
            Ok(rel)
        })
    })
}

#[tauri::command]
pub(crate) fn save_post_effect_annotations(
    ws_state: State<'_, WorkspaceState>,
    project_id: String,
    scene_id: String,
    annotations: Vec<Value>,
) -> Result<(), AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            for ann in &annotations {
                let id = ann["id"].as_str().unwrap_or("");
                let range_start = ann["range_start"].as_i64().unwrap_or(0);
                let range_end = ann["range_end"].as_i64().unwrap_or(0);
                let text_snapshot = ann["text_snapshot"].as_str().unwrap_or("");
                conn.execute(
                    "UPDATE post_effect_annotations
                        SET range_start = ?, range_end = ?, text_snapshot = ?,
                            updated_at = datetime('now')
                      WHERE id = ? AND project_id = ? AND scene_id = ?",
                    params![
                        range_start,
                        range_end,
                        text_snapshot,
                        id,
                        project_id,
                        scene_id
                    ],
                )?;
            }
            Ok(())
        })
    })
}

// ---------------------------------------------------------------------------
// Row → serde_json::Value ヘルパー
// ---------------------------------------------------------------------------

fn row_to_run_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(serde_json::json!({
        "id":               row.get::<_, String>(0)?,
        "projectId":        row.get::<_, String>(1)?,
        "effectType":       row.get::<_, String>(2)?,
        "scopeType":        row.get::<_, String>(3)?,
        "scopeTargetId":    row.get::<_, Option<String>>(4)?,
        "model":            row.get::<_, String>(5)?,
        "promptVersion":    row.get::<_, String>(6)?,
        "inputHash":        row.get::<_, Option<String>>(7)?,
        "status":           row.get::<_, String>(8)?,
        "summary":          row.get::<_, Option<String>>(9)?,
        "errorMessage":     row.get::<_, Option<String>>(10)?,
        "startedAt":        row.get::<_, String>(11)?,
        "completedAt":      row.get::<_, Option<String>>(12)?,
    }))
}

fn row_to_annotation_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let metadata_str: String = row.get("metadata").unwrap_or_else(|_| "{}".into());
    let metadata: Value =
        serde_json::from_str(&metadata_str).unwrap_or(Value::Object(Default::default()));
    Ok(serde_json::json!({
        "id":           row.get::<_, String>("id")?,
        "projectId":    row.get::<_, String>("project_id")?,
        "runId":        row.get::<_, Option<String>>("run_id")?,
        "anchorType":   row.get::<_, String>("anchor_type")?,
        "sceneId":      row.get::<_, Option<String>>("scene_id")?,
        "rangeStart":   row.get::<_, Option<i64>>("range_start")?,
        "rangeEnd":     row.get::<_, Option<i64>>("range_end")?,
        "textSnapshot": row.get::<_, Option<String>>("text_snapshot")?,
        "category":     row.get::<_, String>("category")?,
        "persona":      row.get::<_, Option<String>>("persona")?,
        "severity":     row.get::<_, Option<String>>("severity")?,
        "content":      row.get::<_, String>("content")?,
        "authorRole":   row.get::<_, String>("author_role")?,
        "parentId":     row.get::<_, Option<String>>("parent_id")?,
        "status":       row.get::<_, String>("status")?,
        "metadata":     metadata,
        "createdAt":    row.get::<_, String>("created_at")?,
        "updatedAt":    row.get::<_, String>("updated_at")?,
    }))
}

fn row_to_relation_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let metadata_str: String = row.get("metadata").unwrap_or_else(|_| "{}".into());
    let metadata: Value =
        serde_json::from_str(&metadata_str).unwrap_or(Value::Object(Default::default()));
    Ok(serde_json::json!({
        "id":              row.get::<_, String>("id")?,
        "projectId":       row.get::<_, String>("project_id")?,
        "runId":           row.get::<_, Option<String>>("run_id")?,
        "annotationAId":   row.get::<_, String>("annotation_a_id")?,
        "annotationBId":   row.get::<_, String>("annotation_b_id")?,
        "relationType":    row.get::<_, String>("relation_type")?,
        "direction":       row.get::<_, String>("direction")?,
        "description":     row.get::<_, Option<String>>("description")?,
        "status":          row.get::<_, String>("status")?,
        "metadata":        metadata,
        "createdAt":       row.get::<_, String>("created_at")?,
    }))
}
