use rusqlite::{params, Connection};

use crate::snapshots::{
    attach_codex_spans, attach_snippet_spans, restore_codex_authorship_spans,
    restore_snippet_authorship_spans,
};

#[derive(Debug, Clone)]
pub struct UndoJournalInsert<'a> {
    pub id: &'a str,
    pub project_id: &'a str,
    pub surface: &'a str,
    pub entity_kind: &'a str,
    pub entity_id: &'a str,
    pub op_kind: &'a str,
    pub before_json: Option<&'a str>,
    pub after_json: Option<&'a str>,
    pub base_version: i64,
    pub result_version: i64,
    pub change_event_uid: Option<&'a str>,
}

pub fn insert_undo_journal_in_tx(
    conn: &Connection,
    row: UndoJournalInsert<'_>,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO undo_journal
         (id, project_id, surface, entity_kind, entity_id, op_kind,
          before_json, after_json, base_version, result_version, change_event_uid)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            row.id,
            row.project_id,
            row.surface,
            row.entity_kind,
            row.entity_id,
            row.op_kind,
            row.before_json,
            row.after_json,
            row.base_version,
            row.result_version,
            row.change_event_uid,
        ],
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct UndoJournalRow {
    pub id: String,
    pub project_id: String,
    pub entity_kind: String,
    pub entity_id: String,
    pub op_kind: String,
    pub before_json: Option<String>,
    pub after_json: Option<String>,
    pub base_version: i64,
    pub result_version: i64,
}

pub fn load_undo_journal(
    conn: &Connection,
    project_id: &str,
    journal_id: &str,
) -> anyhow::Result<UndoJournalRow> {
    conn.query_row(
        "SELECT id, project_id, entity_kind, entity_id, op_kind,
                before_json, after_json, base_version, result_version
         FROM undo_journal WHERE id = ?1 AND project_id = ?2",
        params![journal_id, project_id],
        |row| {
            Ok(UndoJournalRow {
                id: row.get(0)?,
                project_id: row.get(1)?,
                entity_kind: row.get(2)?,
                entity_id: row.get(3)?,
                op_kind: row.get(4)?,
                before_json: row.get(5)?,
                after_json: row.get(6)?,
                base_version: row.get(7)?,
                result_version: row.get(8)?,
            })
        },
    )
    .map_err(Into::into)
}

fn restore_codex_entry_fields(
    conn: &Connection,
    snap: &serde_json::Value,
    entity_id: &str,
    project_id: &str,
    replay_version: i64,
    expected_current_version: i64,
) -> anyhow::Result<()> {
    validate_codex_snapshot_identity(conn, snap, entity_id, project_id)?;
    let entry_type = snap["type"].as_str();
    let name = snap["name"].as_str().unwrap_or("");
    // The original workspace schema permits NULL summaries. Preserve an
    // explicit snapshot null; only a truly missing legacy key falls back to
    // the historical empty string.
    let summary = snap
        .get("summary")
        .map(serde_json::Value::as_str)
        .unwrap_or(Some(""));
    let content = snap["content"].as_str().unwrap_or("{}");
    let aliases = snap["aliases"].as_str();
    let excluded_aliases = snap["excludedAliases"].as_str();
    let readings = snap["readings"].as_str();
    let parent_id = snap["parentId"].as_str();
    let icon = snap["icon"].as_str();
    let tags_cache = snap["tagsCache"].as_str();
    let context_mode = snap["contextMode"].as_str().unwrap_or("mentioned");
    let children_budget = snap["childrenBudget"].as_str().unwrap_or("compact");
    let notes = snap["notes"].as_str();
    let updated = conn.execute(
        "UPDATE codex_entries SET type = COALESCE(?1, type), name = ?2,
         summary = ?3, content = ?4, aliases = ?5, excluded_aliases = ?6,
         readings = ?7, parent_id = ?8, icon = ?9, tags_cache = ?10,
         context_mode = ?11, children_budget = ?12, notes = ?13,
         version = ?14, updated_at = datetime('now')
         WHERE id = ?15 AND project_id = ?16 AND version = ?17",
        params![
            entry_type,
            name,
            summary,
            content,
            aliases,
            excluded_aliases,
            readings,
            parent_id,
            icon,
            tags_cache,
            context_mode,
            children_budget,
            notes,
            replay_version,
            entity_id,
            project_id,
            expected_current_version,
        ],
    )?;
    if updated == 0 {
        anyhow::bail!(
            "codex entry '{}' version {} conflict during journal restore",
            entity_id,
            expected_current_version
        );
    }
    restore_codex_authorship_spans(conn, entity_id, snap)?;
    Ok(())
}

fn validate_codex_snapshot_identity(
    conn: &Connection,
    snap: &serde_json::Value,
    entity_id: &str,
    project_id: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        snap["id"].as_str() == Some(entity_id),
        "codex entry '{}' journal snapshot identity mismatch",
        entity_id
    );
    anyhow::ensure!(
        snap["projectId"].as_str() == Some(project_id),
        "codex entry '{}' journal snapshot project mismatch",
        entity_id
    );
    if let Some(parent_id) = snap["parentId"].as_str().filter(|value| !value.is_empty()) {
        anyhow::ensure!(
            parent_id != entity_id,
            "codex entry '{}' cannot be its own parent during journal restore",
            entity_id
        );
        let parent_found: i64 = conn.query_row(
            "SELECT COUNT(*) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
            params![parent_id, project_id],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            parent_found == 1,
            "codex parent '{}' is not found in project '{}' during journal restore",
            parent_id,
            project_id
        );
    }
    Ok(())
}

fn insert_codex_from_snap(
    conn: &Connection,
    snap: &serde_json::Value,
    entity_id: &str,
    project_id: &str,
    replay_version: i64,
) -> anyhow::Result<()> {
    validate_codex_snapshot_identity(conn, snap, entity_id, project_id)?;
    let existing: i64 = conn.query_row(
        "SELECT COUNT(*) FROM codex_entries WHERE id = ?1",
        params![entity_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        existing == 0,
        "codex entry '{}' version conflict during journal restore",
        entity_id
    );
    let entry_type = snap["type"].as_str().unwrap_or("lore");
    let name = snap["name"].as_str().unwrap_or("Untitled");
    let summary = snap
        .get("summary")
        .map(serde_json::Value::as_str)
        .unwrap_or(Some(""));
    let content = snap["content"].as_str().unwrap_or("{}");
    let aliases = snap["aliases"].as_str();
    let excluded_aliases = snap["excludedAliases"].as_str();
    let readings = snap["readings"].as_str();
    let parent_id = snap["parentId"].as_str();
    let icon = snap["icon"].as_str();
    let tags_cache = snap["tagsCache"].as_str();
    let context_mode = snap["contextMode"].as_str().unwrap_or("mentioned");
    let children_budget = snap["childrenBudget"].as_str().unwrap_or("compact");
    let source_chat_message_id = snap["sourceChatMessageId"].as_str();
    let notes = snap["notes"].as_str();
    let created_at = snap["createdAt"].as_str();
    let inserted = conn.execute(
        "INSERT INTO codex_entries
         (id, project_id, type, name, aliases, excluded_aliases, readings, summary,
          content, parent_id, icon, tags_cache, context_mode, children_budget,
          source_chat_message_id, notes, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                 coalesce(?18, datetime('now')), datetime('now'))",
        params![
            entity_id,
            project_id,
            entry_type,
            name,
            aliases,
            excluded_aliases,
            readings,
            summary,
            content,
            parent_id,
            icon,
            tags_cache,
            context_mode,
            children_budget,
            source_chat_message_id,
            notes,
            replay_version,
            created_at,
        ],
    )?;
    anyhow::ensure!(
        inserted == 1,
        "codex entry '{}' was not restored",
        entity_id
    );
    restore_codex_authorship_spans(conn, entity_id, snap)?;
    Ok(())
}

fn next_codex_replay_version(version: i64, direction: &str) -> anyhow::Result<i64> {
    version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("codex entry version overflow during {direction}"))
}

/// Replace a replayed logical state token throughout one Codex entry's
/// journal chain. Adjacent create/update/delete commands then remain connected
/// after a fresh live version is allocated, while a stale external token can
/// never become current again (the ABA case).
fn advance_codex_journal_state_token(
    conn: &Connection,
    project_id: &str,
    entity_id: &str,
    previous_version: i64,
    replay_version: i64,
) -> anyhow::Result<()> {
    let updated = conn.execute(
        "UPDATE undo_journal
         SET base_version = CASE WHEN base_version = ?1 THEN ?2 ELSE base_version END,
             result_version = CASE WHEN result_version = ?1 THEN ?2 ELSE result_version END
         WHERE project_id = ?3 AND entity_kind = 'codex_entry' AND entity_id = ?4
           AND (base_version = ?1 OR result_version = ?1)",
        params![previous_version, replay_version, project_id, entity_id],
    )?;
    anyhow::ensure!(
        updated > 0,
        "codex entry undo journal chain for '{}' lost state version {}",
        entity_id,
        previous_version
    );
    Ok(())
}

fn foreshadow_snapshot_has_version(snap: &serde_json::Value) -> bool {
    snap.get("version")
        .and_then(serde_json::Value::as_i64)
        .is_some()
}

/// Restore a foreshadow row from a snapshot. v12 snapshots use the root
/// `version` as their OCC token and allocate a fresh version for every replay.
/// Pre-v12 snapshots have no version and retain their historical updated_at
/// guard so journals created before the migration remain replayable.
fn restore_foreshadow_fields(
    conn: &Connection,
    snap: &serde_json::Value,
    entity_id: &str,
    project_id: &str,
    target_state_token: i64,
    expected_current_token: i64,
) -> anyhow::Result<Option<i64>> {
    if foreshadow_snapshot_has_version(snap) {
        let replay_version = expected_current_token
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("foreshadow version overflow during journal restore"))?;
        let now = chrono::Utc::now().timestamp_millis();
        let updated = conn.execute(
            "UPDATE foreshadows SET title = ?1, intent = ?2, notes = ?3,
             payoff_scene_id = ?4, payoff_from_pos = ?5, payoff_to_pos = ?6,
             payoff_confirmed = ?7, abandoned = ?8, secret = ?9, load_bearing = ?10,
             mechanism = ?11, codex_link_dirty_at = ?12, version = ?13,
             created_at = ?14, updated_at = ?15
             WHERE id = ?16 AND project_id = ?17 AND version = ?18",
            params![
                snap["title"].as_str().unwrap_or(""),
                snap["intent"].as_str(),
                snap["notes"].as_str(),
                snap["payoffSceneId"].as_str(),
                snap["payoffFromPos"].as_i64(),
                snap["payoffToPos"].as_i64(),
                snap["payoffConfirmed"].as_i64().unwrap_or(0),
                snap["abandoned"].as_i64().unwrap_or(0),
                snap["secret"].as_i64().unwrap_or(1),
                snap["loadBearing"].as_str(),
                snap["mechanism"].as_str(),
                snap["codexLinkDirtyAt"].as_i64(),
                replay_version,
                snap["createdAt"].as_i64().unwrap_or(0),
                now,
                entity_id,
                project_id,
                expected_current_token,
            ],
        )?;
        if updated == 0 {
            anyhow::bail!(
                "foreshadow '{}' version {} conflict during journal restore",
                entity_id,
                expected_current_token
            );
        }
        return Ok(Some(replay_version));
    }

    let updated = conn.execute(
        "UPDATE foreshadows SET title = ?1, intent = ?2, notes = ?3,
         payoff_scene_id = ?4, payoff_from_pos = ?5, payoff_to_pos = ?6,
         payoff_confirmed = ?7, abandoned = ?8, secret = ?9, load_bearing = ?10,
         updated_at = ?11
         WHERE id = ?12 AND project_id = ?13 AND updated_at = ?14",
        params![
            snap["title"].as_str().unwrap_or(""),
            snap["intent"].as_str(),
            snap["notes"].as_str(),
            snap["payoffSceneId"].as_str(),
            snap["payoffFromPos"].as_i64(),
            snap["payoffToPos"].as_i64(),
            snap["payoffConfirmed"].as_i64().unwrap_or(0),
            snap["abandoned"].as_i64().unwrap_or(0),
            snap["secret"].as_i64().unwrap_or(1),
            snap["loadBearing"].as_str(),
            target_state_token,
            entity_id,
            project_id,
            expected_current_token,
        ],
    )?;
    if updated == 0 {
        anyhow::bail!(
            "foreshadow '{}' updated_at {} conflict during journal restore",
            entity_id,
            expected_current_token
        );
    }
    Ok(None)
}

fn insert_foreshadow_from_snap(
    conn: &Connection,
    snap: &serde_json::Value,
    replay_version: Option<i64>,
) -> anyhow::Result<()> {
    if foreshadow_snapshot_has_version(snap) {
        let version = replay_version.unwrap_or_else(|| snap["version"].as_i64().unwrap_or(0));
        let updated_at = replay_version
            .map(|_| chrono::Utc::now().timestamp_millis())
            .unwrap_or_else(|| snap["updatedAt"].as_i64().unwrap_or(0));
        conn.execute(
            "INSERT INTO foreshadows
             (id, project_id, title, intent, notes, payoff_scene_id, payoff_from_pos,
              payoff_to_pos, payoff_confirmed, abandoned, secret, load_bearing,
              mechanism, version, codex_link_dirty_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                     ?13, ?14, ?15, ?16, ?17)",
            params![
                snap["id"].as_str().unwrap_or(""),
                snap["projectId"].as_str().unwrap_or(""),
                snap["title"].as_str().unwrap_or("Untitled"),
                snap["intent"].as_str(),
                snap["notes"].as_str(),
                snap["payoffSceneId"].as_str(),
                snap["payoffFromPos"].as_i64(),
                snap["payoffToPos"].as_i64(),
                snap["payoffConfirmed"].as_i64().unwrap_or(0),
                snap["abandoned"].as_i64().unwrap_or(0),
                snap["secret"].as_i64().unwrap_or(1),
                snap["loadBearing"].as_str(),
                snap["mechanism"].as_str(),
                version,
                snap["codexLinkDirtyAt"].as_i64(),
                snap["createdAt"].as_i64().unwrap_or(0),
                updated_at,
            ],
        )?;
        return Ok(());
    }

    conn.execute(
        "INSERT INTO foreshadows
         (id, project_id, title, intent, notes, payoff_scene_id, payoff_from_pos,
          payoff_to_pos, payoff_confirmed, abandoned, secret, load_bearing,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            snap["id"].as_str().unwrap_or(""),
            snap["projectId"].as_str().unwrap_or(""),
            snap["title"].as_str().unwrap_or("Untitled"),
            snap["intent"].as_str(),
            snap["notes"].as_str(),
            snap["payoffSceneId"].as_str(),
            snap["payoffFromPos"].as_i64(),
            snap["payoffToPos"].as_i64(),
            snap["payoffConfirmed"].as_i64().unwrap_or(0),
            snap["abandoned"].as_i64().unwrap_or(0),
            snap["secret"].as_i64().unwrap_or(1),
            snap["loadBearing"].as_str(),
            snap["createdAt"].as_i64().unwrap_or(0),
            snap["updatedAt"].as_i64().unwrap_or(0),
        ],
    )?;
    Ok(())
}

pub fn advance_foreshadow_journal_state_token(
    conn: &Connection,
    project_id: &str,
    entity_id: &str,
    previous_version: i64,
    replay_version: i64,
) -> anyhow::Result<()> {
    let rows = {
        let mut stmt = conn.prepare(
            "SELECT id, before_json, after_json, base_version, result_version
             FROM undo_journal
             WHERE project_id = ?1 AND entity_kind = 'foreshadow' AND entity_id = ?2",
        )?;
        let mapped = stmt.query_map(params![project_id, entity_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;
        mapped.collect::<Result<Vec<_>, _>>()?
    };

    let mut updated = 0;
    for (journal_id, before_json, after_json, base_version, result_version) in rows {
        let uses_root_version = [before_json.as_deref(), after_json.as_deref()]
            .into_iter()
            .flatten()
            .try_fold(false, |found, raw| {
                let snap: serde_json::Value = serde_json::from_str(raw)?;
                Ok::<_, anyhow::Error>(found || foreshadow_snapshot_has_version(&snap))
            })?;
        if !uses_root_version
            || (base_version != previous_version && result_version != previous_version)
        {
            continue;
        }
        updated += conn.execute(
            "UPDATE undo_journal
             SET base_version = CASE WHEN base_version = ?1 THEN ?2 ELSE base_version END,
                 result_version = CASE WHEN result_version = ?1 THEN ?2 ELSE result_version END
             WHERE id = ?3 AND project_id = ?4",
            params![previous_version, replay_version, journal_id, project_id],
        )?;
    }
    anyhow::ensure!(
        updated > 0,
        "foreshadow undo journal chain for '{}' lost state version {}",
        entity_id,
        previous_version
    );
    Ok(())
}

fn insert_snippet_from_snap(conn: &Connection, snap: &serde_json::Value) -> anyhow::Result<()> {
    let id = snap["id"].as_str().unwrap_or("");
    let project = snap["projectId"].as_str().unwrap_or("");
    let title = snap["title"].as_str().unwrap_or("");
    let content = snap["content"].as_str().unwrap_or("{}");
    let scene_id = snap["sceneId"].as_str();
    let content_source = snap["contentSource"].as_str().unwrap_or("ai");
    let version = snap["version"].as_i64().unwrap_or(1);
    conn.execute(
        "INSERT INTO snippets
         (id, project_id, title, content, scene_id, content_source, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), datetime('now'))",
        params![
            id,
            project,
            title,
            content,
            scene_id,
            content_source,
            version
        ],
    )?;
    restore_snippet_authorship_spans(conn, id, snap)?;
    Ok(())
}

/// Revert an undo-journal entry (global-history undo path).
pub fn revert_undo_journal_in_tx(
    conn: &Connection,
    project_id: &str,
    journal_id: &str,
) -> anyhow::Result<()> {
    let row = load_undo_journal(conn, project_id, journal_id)?;
    match row.entity_kind.as_str() {
        "codex_entry" => match row.op_kind.as_str() {
            "create" => {
                let deleted = conn.execute(
                    "DELETE FROM codex_entries WHERE id = ?1 AND project_id = ?2 AND version = ?3",
                    params![row.entity_id, project_id, row.result_version],
                )?;
                if deleted == 0 {
                    anyhow::bail!(
                        "revert create: codex entry '{}' version {} not found",
                        row.entity_id,
                        row.result_version
                    );
                }
            }
            "update" => {
                let before = row
                    .before_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("revert update: missing before_json"))?;
                let snap: serde_json::Value = serde_json::from_str(before)?;
                let replay_version = next_codex_replay_version(row.result_version, "undo update")?;
                restore_codex_entry_fields(
                    conn,
                    &snap,
                    &row.entity_id,
                    project_id,
                    replay_version,
                    row.result_version,
                )?;
                advance_codex_journal_state_token(
                    conn,
                    project_id,
                    &row.entity_id,
                    row.base_version,
                    replay_version,
                )?;
            }
            "delete" => {
                // Undoing a delete re-inserts the row from the pre-delete
                // snapshot. Cascaded children (relations/phases/detail values)
                // are not restored — this mirrors the pre-cutover behavior
                // where deleteCodexEntry had no undo at all.
                let before = row
                    .before_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("revert delete: missing before_json"))?;
                let snap: serde_json::Value = serde_json::from_str(before)?;
                let replay_version = next_codex_replay_version(row.base_version, "undo delete")?;
                insert_codex_from_snap(conn, &snap, &row.entity_id, project_id, replay_version)?;
                advance_codex_journal_state_token(
                    conn,
                    project_id,
                    &row.entity_id,
                    row.base_version,
                    replay_version,
                )?;
            }
            other => anyhow::bail!("revert_undo_journal: unsupported codex op_kind '{other}'"),
        },
        "snippet" => match row.op_kind.as_str() {
            "create" => {
                let deleted = conn.execute(
                    "DELETE FROM snippets WHERE id = ?1 AND project_id = ?2 AND version = ?3",
                    params![row.entity_id, project_id, row.result_version],
                )?;
                if deleted == 0 {
                    anyhow::bail!(
                        "revert create: snippet '{}' version {} not found",
                        row.entity_id,
                        row.result_version
                    );
                }
            }
            other => anyhow::bail!("revert_undo_journal: unsupported snippet op_kind '{other}'"),
        },
        "foreshadow" => match row.op_kind.as_str() {
            "create" => {
                let after = row
                    .after_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("revert create: missing after_json"))?;
                let snap: serde_json::Value = serde_json::from_str(after)?;
                let versioned = foreshadow_snapshot_has_version(&snap);
                let deleted = if versioned {
                    conn.execute(
                        "DELETE FROM foreshadows
                         WHERE id = ?1 AND project_id = ?2 AND version = ?3",
                        params![row.entity_id, project_id, row.result_version],
                    )?
                } else {
                    // Explicit pre-v12 compatibility: old journals used the
                    // row timestamp as their optimistic token.
                    conn.execute(
                        "DELETE FROM foreshadows
                         WHERE id = ?1 AND project_id = ?2 AND updated_at = ?3",
                        params![row.entity_id, project_id, row.result_version],
                    )?
                };
                if deleted == 0 {
                    if versioned {
                        anyhow::bail!(
                            "revert create: foreshadow '{}' version {} not found (edited or removed)",
                            row.entity_id,
                            row.result_version
                        );
                    } else {
                        anyhow::bail!(
                            "revert create: foreshadow '{}' updated_at {} not found (edited or removed)",
                            row.entity_id,
                            row.result_version
                        );
                    }
                }
            }
            "update" => {
                let before = row
                    .before_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("revert update: missing before_json"))?;
                let snap: serde_json::Value = serde_json::from_str(before)?;
                if let Some(replay_version) = restore_foreshadow_fields(
                    conn,
                    &snap,
                    &row.entity_id,
                    project_id,
                    row.base_version,
                    row.result_version,
                )? {
                    advance_foreshadow_journal_state_token(
                        conn,
                        project_id,
                        &row.entity_id,
                        row.base_version,
                        replay_version,
                    )?;
                }
            }
            "delete" => {
                let before = row
                    .before_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("revert delete: missing before_json"))?;
                let snap: serde_json::Value = serde_json::from_str(before)?;
                if foreshadow_snapshot_has_version(&snap) {
                    let replay_version = row.base_version.checked_add(1).ok_or_else(|| {
                        anyhow::anyhow!("foreshadow version overflow during undo delete")
                    })?;
                    insert_foreshadow_from_snap(conn, &snap, Some(replay_version))?;
                    advance_foreshadow_journal_state_token(
                        conn,
                        project_id,
                        &row.entity_id,
                        row.base_version,
                        replay_version,
                    )?;
                } else {
                    insert_foreshadow_from_snap(conn, &snap, None)?;
                }
            }
            other => anyhow::bail!("revert_undo_journal: unsupported foreshadow op_kind '{other}'"),
        },
        other => anyhow::bail!("revert_undo_journal: unsupported entity_kind '{other}'"),
    }
    Ok(())
}

/// Re-apply an undo-journal entry (global-history redo path).
pub fn apply_undo_journal_in_tx(
    conn: &Connection,
    project_id: &str,
    journal_id: &str,
) -> anyhow::Result<()> {
    let row = load_undo_journal(conn, project_id, journal_id)?;
    match row.entity_kind.as_str() {
        "codex_entry" => match row.op_kind.as_str() {
            "create" => {
                let after = row
                    .after_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("apply create: missing after_json"))?;
                let snap: serde_json::Value = serde_json::from_str(after)?;
                let replay_version = next_codex_replay_version(row.result_version, "redo create")?;
                insert_codex_from_snap(conn, &snap, &row.entity_id, project_id, replay_version)?;
                advance_codex_journal_state_token(
                    conn,
                    project_id,
                    &row.entity_id,
                    row.result_version,
                    replay_version,
                )?;
            }
            "update" => {
                let after = row
                    .after_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("apply update: missing after_json"))?;
                let snap: serde_json::Value = serde_json::from_str(after)?;
                let replay_version = next_codex_replay_version(row.base_version, "redo update")?;
                restore_codex_entry_fields(
                    conn,
                    &snap,
                    &row.entity_id,
                    project_id,
                    replay_version,
                    row.base_version,
                )?;
                advance_codex_journal_state_token(
                    conn,
                    project_id,
                    &row.entity_id,
                    row.result_version,
                    replay_version,
                )?;
            }
            "delete" => {
                // Redoing a delete removes the row that undo just restored.
                // The matching undo rewrites both sides of the delete journal
                // to the fresh live token, so redo guards on result_version.
                let deleted = conn.execute(
                    "DELETE FROM codex_entries WHERE id = ?1 AND project_id = ?2 AND version = ?3",
                    params![row.entity_id, project_id, row.result_version],
                )?;
                if deleted == 0 {
                    anyhow::bail!(
                        "apply delete: codex entry '{}' version {} not found",
                        row.entity_id,
                        row.result_version
                    );
                }
            }
            other => anyhow::bail!("apply_undo_journal: unsupported codex op_kind '{other}'"),
        },
        "snippet" => match row.op_kind.as_str() {
            "create" => {
                let after = row
                    .after_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("apply create: missing after_json"))?;
                let snap: serde_json::Value = serde_json::from_str(after)?;
                insert_snippet_from_snap(conn, &snap)?;
            }
            other => anyhow::bail!("apply_undo_journal: unsupported snippet op_kind '{other}'"),
        },
        "foreshadow" => match row.op_kind.as_str() {
            "create" => {
                let after = row
                    .after_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("apply create: missing after_json"))?;
                let snap: serde_json::Value = serde_json::from_str(after)?;
                if foreshadow_snapshot_has_version(&snap) {
                    let replay_version = row.result_version.checked_add(1).ok_or_else(|| {
                        anyhow::anyhow!("foreshadow version overflow during redo create")
                    })?;
                    insert_foreshadow_from_snap(conn, &snap, Some(replay_version))?;
                    advance_foreshadow_journal_state_token(
                        conn,
                        project_id,
                        &row.entity_id,
                        row.result_version,
                        replay_version,
                    )?;
                } else {
                    insert_foreshadow_from_snap(conn, &snap, None)?;
                }
            }
            "update" => {
                let after = row
                    .after_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("apply update: missing after_json"))?;
                let snap: serde_json::Value = serde_json::from_str(after)?;
                if let Some(replay_version) = restore_foreshadow_fields(
                    conn,
                    &snap,
                    &row.entity_id,
                    project_id,
                    row.result_version,
                    row.base_version,
                )? {
                    advance_foreshadow_journal_state_token(
                        conn,
                        project_id,
                        &row.entity_id,
                        row.result_version,
                        replay_version,
                    )?;
                }
            }
            "delete" => {
                let before = row
                    .before_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("apply delete: missing before_json"))?;
                let snap: serde_json::Value = serde_json::from_str(before)?;
                let deleted = if foreshadow_snapshot_has_version(&snap) {
                    conn.execute(
                        "DELETE FROM foreshadows
                          WHERE id = ?1 AND project_id = ?2 AND version = ?3",
                        params![row.entity_id, project_id, row.result_version],
                    )?
                } else {
                    conn.execute(
                        "DELETE FROM foreshadows
                          WHERE id = ?1 AND project_id = ?2 AND updated_at = ?3",
                        params![row.entity_id, project_id, row.result_version],
                    )?
                };
                anyhow::ensure!(
                    deleted == 1,
                    "apply delete: foreshadow '{}' token {} not found",
                    row.entity_id,
                    row.result_version
                );
            }
            other => anyhow::bail!("apply_undo_journal: unsupported foreshadow op_kind '{other}'"),
        },
        other => anyhow::bail!("apply_undo_journal: unsupported entity_kind '{other}'"),
    }
    Ok(())
}

/// Build codex update before_json with authorship spans (call before mutation).
pub fn codex_update_before_snapshot(
    conn: &Connection,
    entry_id: &str,
    base_json: &str,
) -> anyhow::Result<String> {
    attach_codex_spans(conn, entry_id, base_json)
}

/// Build codex update after_json with authorship spans (call after mutation).
pub fn codex_update_after_snapshot(
    conn: &Connection,
    entry_id: &str,
    base_json: &str,
) -> anyhow::Result<String> {
    attach_codex_spans(conn, entry_id, base_json)
}

/// Build snippet create after_json with authorship spans.
pub fn snippet_create_after_snapshot(
    conn: &Connection,
    snippet_id: &str,
    base_json: &str,
) -> anyhow::Result<String> {
    attach_snippet_spans(conn, snippet_id, base_json)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use rusqlite::{params, Connection};
    use serde_json::json;

    use crate::snapshots::load_codex_authorship_spans;
    use crate::writes::LANE_SUMMARY_MODEL;

    use super::*;

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL);
             CREATE TABLE codex_entries (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                type TEXT NOT NULL,
                name TEXT NOT NULL,
                aliases TEXT,
                excluded_aliases TEXT,
                readings TEXT,
                summary TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL DEFAULT '{}',
                parent_id TEXT,
                icon TEXT,
                tags_cache TEXT,
                context_mode TEXT NOT NULL DEFAULT 'mentioned',
                children_budget TEXT NOT NULL DEFAULT 'compact',
                source_chat_message_id TEXT,
                notes TEXT,
                version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
             );
             CREATE TABLE snippets (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '{}',
                scene_id TEXT,
                content_source TEXT NOT NULL DEFAULT 'human',
                version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
             );
             CREATE TABLE authorship_spans (
                id TEXT PRIMARY KEY,
                codex_entry_id TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
                snippet_id TEXT REFERENCES snippets(id) ON DELETE CASCADE,
                from_pos INTEGER NOT NULL,
                to_pos INTEGER NOT NULL,
                source TEXT NOT NULL,
                model TEXT,
                chat_msg_id TEXT,
                trace_id TEXT,
                timestamp TEXT NOT NULL DEFAULT (datetime('now'))
             );
             CREATE TABLE undo_journal (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                surface TEXT NOT NULL,
                entity_kind TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                op_kind TEXT NOT NULL,
                before_json TEXT,
                after_json TEXT,
                base_version INTEGER NOT NULL,
                result_version INTEGER NOT NULL,
                change_event_uid TEXT
             );",
        )
        .unwrap();
        conn.execute("INSERT INTO projects (id, title) VALUES ('p1', 'Test')", [])
            .unwrap();
        conn
    }

    fn insert_span(
        conn: &Connection,
        entry_id: &str,
        from_pos: i64,
        to_pos: i64,
        model: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO authorship_spans
             (id, codex_entry_id, from_pos, to_pos, source, model)
             VALUES (?1, ?2, ?3, ?4, 'human', ?5)",
            params![
                uuid::Uuid::new_v4().to_string(),
                entry_id,
                from_pos,
                to_pos,
                model
            ],
        )
        .unwrap();
    }

    #[test]
    fn codex_update_undo_restores_authorship_spans() {
        let conn = setup_conn();
        let entry_id = "e1";
        conn.execute(
            "INSERT INTO codex_entries
             (id, project_id, type, name, summary, content, version)
             VALUES (?1, 'p1', 'lore', 'Old', 'old sum', '{}', 1)",
            params![entry_id],
        )
        .unwrap();
        insert_span(&conn, entry_id, 0, 5, None);
        insert_span(&conn, entry_id, 0, 8, Some(LANE_SUMMARY_MODEL));

        let before_base = conn
            .query_row(
                "SELECT json_object(
                    'id', id, 'projectId', project_id, 'type', type, 'name', name,
                    'summary', summary, 'content', content, 'aliases', aliases,
                    'parentId', parent_id, 'version', version
                 ) FROM codex_entries WHERE id = ?1",
                params![entry_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let before_json = codex_update_before_snapshot(&conn, entry_id, &before_base).unwrap();

        conn.execute(
            "UPDATE codex_entries
             SET type = 'character', name = 'New', summary = 'new sum', version = 2
             WHERE id = ?1",
            params![entry_id],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM authorship_spans WHERE codex_entry_id = ?1 AND model = ?2",
            params![entry_id, LANE_SUMMARY_MODEL],
        )
        .unwrap();
        insert_span(&conn, entry_id, 0, 7, Some(LANE_SUMMARY_MODEL));

        let after_base = conn
            .query_row(
                "SELECT json_object(
                    'id', id, 'projectId', project_id, 'type', type, 'name', name,
                    'summary', summary, 'content', content, 'aliases', aliases,
                    'parentId', parent_id, 'version', version
                 ) FROM codex_entries WHERE id = ?1",
                params![entry_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let after_json = codex_update_after_snapshot(&conn, entry_id, &after_base).unwrap();

        insert_undo_journal_in_tx(
            &conn,
            UndoJournalInsert {
                id: "j1",
                project_id: "p1",
                surface: "test",
                entity_kind: "codex_entry",
                entity_id: entry_id,
                op_kind: "update",
                before_json: Some(&before_json),
                after_json: Some(&after_json),
                base_version: 1,
                result_version: 2,
                change_event_uid: None,
            },
        )
        .unwrap();

        revert_undo_journal_in_tx(&conn, "p1", "j1").unwrap();

        let (entry_type, name, version): (String, String, i64) = conn
            .query_row(
                "SELECT type, name, version FROM codex_entries WHERE id = ?1",
                params![entry_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(entry_type, "lore");
        assert_eq!(name, "Old");
        assert_eq!(version, 3, "undo must allocate a fresh OCC token");

        let spans = load_codex_authorship_spans(&conn, entry_id).unwrap();
        assert_eq!(spans.len(), 2);
        assert!(spans.iter().any(|s| s.model.is_none()));
        assert!(spans
            .iter()
            .any(|s| s.model.as_deref() == Some(LANE_SUMMARY_MODEL) && s.to_pos == 8));

        apply_undo_journal_in_tx(&conn, "p1", "j1").unwrap();
        let (entry_type, name, version): (String, String, i64) = conn
            .query_row(
                "SELECT type, name, version FROM codex_entries WHERE id = ?1",
                params![entry_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(entry_type, "character");
        assert_eq!(name, "New");
        assert_eq!(version, 4, "redo must allocate another fresh OCC token");
        let spans = load_codex_authorship_spans(&conn, entry_id).unwrap();
        assert_eq!(spans.len(), 2);
        assert!(spans
            .iter()
            .any(|s| s.model.as_deref() == Some(LANE_SUMMARY_MODEL) && s.to_pos == 7));
    }

    #[test]
    fn snippet_create_undo_redo_preserves_entity_id() {
        let conn = setup_conn();
        let snippet_id = "s1";
        let after_base = json!({
            "id": snippet_id,
            "projectId": "p1",
            "title": "Title",
            "content": "{}",
            "sceneId": null,
            "contentSource": "ai",
            "version": 1,
        })
        .to_string();

        conn.execute(
            "INSERT INTO snippets
             (id, project_id, title, content, content_source, version)
             VALUES (?1, 'p1', 'Title', '{}', 'ai', 1)",
            params![snippet_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO authorship_spans
             (id, snippet_id, from_pos, to_pos, source, model)
             VALUES ('span1', ?1, 0, 3, 'ai', '__lane_content__')",
            params![snippet_id],
        )
        .unwrap();

        let after_json = snippet_create_after_snapshot(&conn, snippet_id, &after_base).unwrap();
        insert_undo_journal_in_tx(
            &conn,
            UndoJournalInsert {
                id: "j2",
                project_id: "p1",
                surface: "test",
                entity_kind: "snippet",
                entity_id: snippet_id,
                op_kind: "create",
                before_json: None,
                after_json: Some(&after_json),
                base_version: 0,
                result_version: 1,
                change_event_uid: None,
            },
        )
        .unwrap();

        revert_undo_journal_in_tx(&conn, "p1", "j2").unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM snippets WHERE id = ?1",
                params![snippet_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);

        apply_undo_journal_in_tx(&conn, "p1", "j2").unwrap();
        let title: String = conn
            .query_row(
                "SELECT title FROM snippets WHERE id = ?1",
                params![snippet_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Title");
        let span_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM authorship_spans WHERE snippet_id = ?1",
                params![snippet_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(span_count, 1);
    }
}
