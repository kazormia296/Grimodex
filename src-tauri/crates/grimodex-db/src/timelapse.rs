//! Native-owned timelapse genesis baseline persistence.
//!
//! The renderer supplies only entity identity. Domain, entity type, and the
//! baseline payload are projected from trusted workspace tables while one
//! `BEGIN IMMEDIATE` transaction owns both the eligibility probes and inserts.

use std::collections::{HashMap, HashSet};

use anyhow::Context;
use rusqlite::{params, params_from_iter, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;

use super::Database;

const MAX_PROJECT_ID_LENGTH: usize = 512;
const MAX_ENTITY_ID_LENGTH: usize = 512;
const MAX_ENTITY_IDS: usize = 64;
const MAX_BATCH_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimelapseGenesisBaselineKind {
    Scene,
    Codex,
    Snippet,
}

impl TimelapseGenesisBaselineKind {
    pub fn parse(value: &str) -> anyhow::Result<Self> {
        match value {
            "scene" => Ok(Self::Scene),
            "codex" => Ok(Self::Codex),
            "snippet" => Ok(Self::Snippet),
            _ => anyhow::bail!(
                "TIMELAPSE_GENESIS_BASELINE_INVALID_KIND: kind must be scene, codex, or snippet"
            ),
        }
    }

    fn domain(self) -> &'static str {
        match self {
            Self::Scene => "editor",
            Self::Codex => "codex",
            Self::Snippet => "snippet",
        }
    }

    fn entity_type(self) -> &'static str {
        match self {
            Self::Scene => "scene",
            Self::Codex => "codex_entry",
            Self::Snippet => "snippet",
        }
    }

    fn table(self) -> &'static str {
        match self {
            Self::Scene => "tree_nodes",
            Self::Codex => "codex_entries",
            Self::Snippet => "snippets",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelapseGenesisBaselineAppendSummary {
    pub inserted_count: usize,
    pub skipped_existing_baseline_count: usize,
    pub skipped_existing_body_step_count: usize,
}

fn validate_request(
    project_id: &str,
    entity_ids: &[String],
    anchor_timestamp: i64,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !project_id.is_empty()
            && project_id.trim() == project_id
            && project_id.chars().count() <= MAX_PROJECT_ID_LENGTH,
        "TIMELAPSE_GENESIS_BASELINE_INVALID_PROJECT: projectId must be exact, non-empty, and at most {MAX_PROJECT_ID_LENGTH} characters"
    );
    anyhow::ensure!(
        !entity_ids.is_empty() && entity_ids.len() <= MAX_ENTITY_IDS,
        "TIMELAPSE_GENESIS_BASELINE_INVALID_ENTITIES: entityIds must contain 1..={MAX_ENTITY_IDS} items"
    );
    anyhow::ensure!(
        (0..=MAX_SAFE_INTEGER).contains(&anchor_timestamp),
        "TIMELAPSE_GENESIS_BASELINE_INVALID_TIMESTAMP: anchorTimestamp must be a non-negative safe integer"
    );

    let mut unique = HashSet::with_capacity(entity_ids.len());
    for entity_id in entity_ids {
        anyhow::ensure!(
            !entity_id.is_empty()
                && entity_id.trim() == entity_id
                && entity_id.chars().count() <= MAX_ENTITY_ID_LENGTH,
            "TIMELAPSE_GENESIS_BASELINE_INVALID_ENTITY: entityIds must be exact, non-empty, and at most {MAX_ENTITY_ID_LENGTH} characters"
        );
        anyhow::ensure!(
            unique.insert(entity_id.as_str()),
            "TIMELAPSE_GENESIS_BASELINE_DUPLICATE_ENTITY: entityIds must be unique"
        );
    }
    Ok(())
}

fn validate_projected_batch_size(owned_content: &[String]) -> anyhow::Result<()> {
    if owned_content.len() <= 1 {
        return Ok(());
    }
    let aggregate_bytes = owned_content.iter().try_fold(0usize, |total, content| {
        total
            .checked_add(content.len())
            .context("TIMELAPSE_GENESIS_BASELINE_BATCH_TOO_LARGE: payload byte count overflow")
    })?;
    anyhow::ensure!(
        aggregate_bytes <= MAX_BATCH_PAYLOAD_BYTES,
        "TIMELAPSE_GENESIS_BASELINE_BATCH_TOO_LARGE: multi-entity payload is {} bytes; maximum is {} bytes",
        aggregate_bytes,
        MAX_BATCH_PAYLOAD_BYTES
    );
    Ok(())
}

fn in_placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}

fn load_owned_entity_ids(
    tx: &Transaction<'_>,
    project_id: &str,
    kind: TimelapseGenesisBaselineKind,
    entity_ids: &[String],
) -> anyhow::Result<HashSet<String>> {
    let scene_predicate = match kind {
        TimelapseGenesisBaselineKind::Scene => " AND node_type = 'scene'",
        TimelapseGenesisBaselineKind::Codex | TimelapseGenesisBaselineKind::Snippet => "",
    };
    let sql = format!(
        "SELECT id
           FROM {}
          WHERE project_id = ?
            AND id IN ({}){}",
        kind.table(),
        in_placeholders(entity_ids.len()),
        scene_predicate
    );
    let mut statement = tx.prepare(&sql)?;
    let rows = statement.query_map(
        params_from_iter(std::iter::once(project_id).chain(entity_ids.iter().map(String::as_str))),
        |row| row.get::<_, String>(0),
    )?;
    Ok(rows.collect::<std::result::Result<HashSet<_>, _>>()?)
}

fn load_owned_content_batch(
    tx: &Transaction<'_>,
    project_id: &str,
    kind: TimelapseGenesisBaselineKind,
    entity_ids: &[String],
) -> anyhow::Result<Vec<String>> {
    let scene_predicate = match kind {
        TimelapseGenesisBaselineKind::Scene => " AND node_type = 'scene'",
        TimelapseGenesisBaselineKind::Codex | TimelapseGenesisBaselineKind::Snippet => "",
    };
    let sql = format!(
        "SELECT id, content
           FROM {}
          WHERE project_id = ?
            AND id IN ({}){}",
        kind.table(),
        in_placeholders(entity_ids.len()),
        scene_predicate
    );
    let mut statement = tx.prepare(&sql)?;
    let rows = statement.query_map(
        params_from_iter(std::iter::once(project_id).chain(entity_ids.iter().map(String::as_str))),
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )?;
    let content_by_id = rows.collect::<std::result::Result<HashMap<_, _>, _>>()?;
    entity_ids
        .iter()
        .map(|entity_id| {
            content_by_id.get(entity_id).cloned().with_context(|| {
                format!(
                    "TIMELAPSE_GENESIS_BASELINE_ENTITY_SCOPE_MISMATCH: {} entity '{}' does not belong to project '{}'",
                    kind.table(), entity_id, project_id
                )
            })
        })
        .collect()
}

fn load_existing_entity_ids(
    tx: &Transaction<'_>,
    sql_prefix: &str,
    project_id: &str,
    domain: &str,
    entity_ids: &[String],
) -> anyhow::Result<HashSet<String>> {
    let sql = format!("{sql_prefix} ({})", in_placeholders(entity_ids.len()));
    let mut statement = tx.prepare(&sql)?;
    let rows = statement.query_map(
        params_from_iter(
            [project_id, domain]
                .into_iter()
                .chain(entity_ids.iter().map(String::as_str)),
        ),
        |row| row.get::<_, String>(0),
    )?;
    Ok(rows.collect::<std::result::Result<HashSet<_>, _>>()?)
}

fn load_existing_body_steps(
    tx: &Transaction<'_>,
    project_id: &str,
    domain: &str,
    entity_ids: &[String],
) -> anyhow::Result<(HashSet<String>, bool)> {
    let sql = format!(
        "SELECT entity_id
           FROM change_events
          WHERE project_id = ?
            AND domain = ?
            AND op_type = 'doc.step'
            AND (entity_id IN ({}) OR entity_id IS NULL OR entity_id = '')",
        in_placeholders(entity_ids.len())
    );
    let mut statement = tx.prepare(&sql)?;
    let rows = statement.query_map(
        params_from_iter(
            [project_id, domain]
                .into_iter()
                .chain(entity_ids.iter().map(String::as_str)),
        ),
        |row| row.get::<_, Option<String>>(0),
    )?;
    let mut entity_steps = HashSet::new();
    let mut ambiguous_domain_step = false;
    for entity_id in rows {
        match entity_id? {
            Some(entity_id) if !entity_id.is_empty() => {
                entity_steps.insert(entity_id);
            }
            Some(_) | None => ambiguous_domain_step = true,
        }
    }
    Ok((entity_steps, ambiguous_domain_step))
}

impl Database {
    /// Append missing genesis baselines for one canonical editor-body kind.
    ///
    /// All source reads, ownership checks, eligibility probes, and inserts are
    /// serialized by one immediate transaction. A retry or a concurrent
    /// connection therefore observes committed rows before it can insert.
    pub fn append_timelapse_genesis_baselines(
        &self,
        project_id: &str,
        kind: TimelapseGenesisBaselineKind,
        entity_ids: &[String],
        anchor_timestamp: i64,
    ) -> anyhow::Result<TimelapseGenesisBaselineAppendSummary> {
        validate_request(project_id, entity_ids, anchor_timestamp)?;
        self.with_conn(|conn| {
            let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
            let project_exists = tx
                .query_row(
                    "SELECT 1 FROM projects WHERE id = ?1",
                    [project_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            anyhow::ensure!(
                project_exists,
                "TIMELAPSE_GENESIS_BASELINE_PROJECT_NOT_FOUND: project '{}' does not exist",
                project_id
            );

            let domain = kind.domain();
            let entity_type = kind.entity_type();
            // Verify the whole input scope from IDs only before eligibility.
            // A stale or mis-scoped member rejects the transaction without
            // reading large editor bodies or inserting a partial chunk.
            let owned_ids = load_owned_entity_ids(&tx, project_id, kind, entity_ids)?;
            for entity_id in entity_ids {
                anyhow::ensure!(
                    owned_ids.contains(entity_id),
                    "TIMELAPSE_GENESIS_BASELINE_ENTITY_SCOPE_MISMATCH: {} entity '{}' does not belong to project '{}'",
                    kind.table(),
                    entity_id,
                    project_id
                );
            }
            // Resolve snapshots first. A fully-baselined steady-state batch
            // must return without preparing any change_events statement.
            let existing_baselines = load_existing_entity_ids(
                &tx,
                "SELECT entity_id
                   FROM state_snapshots
                  WHERE project_id = ?
                    AND domain = ?
                    AND entity_id IN",
                project_id,
                domain,
                entity_ids,
            )?;
            let mut summary = TimelapseGenesisBaselineAppendSummary {
                inserted_count: 0,
                skipped_existing_baseline_count: 0,
                skipped_existing_body_step_count: 0,
            };
            let mut candidates = Vec::with_capacity(entity_ids.len());
            for entity_id in entity_ids {
                if existing_baselines.contains(entity_id) {
                    summary.skipped_existing_baseline_count += 1;
                    continue;
                }
                candidates.push(entity_id.clone());
            }

            if candidates.is_empty() {
                tx.commit()?;
                return Ok(summary);
            }

            // One bounded probe over only unsnapshotted candidates. Repeating
            // an unindexed change_events query per entity would rescan a long
            // event log up to 64 times on first-run or partial projects.
            let (existing_body_steps, ambiguous_domain_step) =
                load_existing_body_steps(&tx, project_id, domain, &candidates)?;
            let mut eligible_ids = Vec::with_capacity(candidates.len());
            for entity_id in candidates {
                if ambiguous_domain_step || existing_body_steps.contains(&entity_id) {
                    summary.skipped_existing_body_step_count += 1;
                    continue;
                }
                eligible_ids.push(entity_id);
            }

            if eligible_ids.is_empty() {
                tx.commit()?;
                return Ok(summary);
            }

            // Fetch trusted bodies only for rows that will actually insert.
            // Steady-state reopen therefore remains ID-only even for very
            // large documents that already own a snapshot or doc.step.
            let owned_content = load_owned_content_batch(&tx, project_id, kind, &eligible_ids)?;
            validate_projected_batch_size(&owned_content)?;

            for (entity_id, content) in eligible_ids.iter().zip(owned_content) {
                tx.execute(
                    "INSERT INTO state_snapshots
                         (project_id, domain, entity_type, entity_id,
                          anchor_sequence, anchor_timestamp, payload, encoding, created_at)
                     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, 'json', ?5)",
                    params![
                        project_id,
                        domain,
                        entity_type,
                        entity_id,
                        anchor_timestamp,
                        content
                    ],
                )?;
                summary.inserted_count += 1;
            }
            tx.commit()?;
            Ok(summary)
        })
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier,
    };

    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use rusqlite::params;

    use super::*;

    fn database() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("database");
        db.migrate().expect("schema");
        seed(&db);
        db
    }

    fn seed(db: &Database) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title, language) VALUES ('project-a', 'A', 'ja')",
                [],
            )?;
            conn.execute(
                "INSERT INTO projects (id, title, language) VALUES ('project-b', 'B', 'ja')",
                [],
            )?;
            for (id, project, node_type, content) in [
                (
                    "scene-new",
                    "project-a",
                    "scene",
                    r#"{"type":"doc","content":[]}"#,
                ),
                (
                    "scene-baseline",
                    "project-a",
                    "scene",
                    r#"{"type":"doc","content":[1]}"#,
                ),
                (
                    "scene-stepped",
                    "project-a",
                    "scene",
                    r#"{"type":"doc","content":[2]}"#,
                ),
                ("scene-other", "project-b", "scene", "{}"),
                ("note-a", "project-a", "note", "{}"),
            ] {
                conn.execute(
                    "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
                     VALUES (?1, ?2, ?3, ?1, ?4)",
                    params![id, project, node_type, content],
                )?;
            }
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, content)
                 VALUES ('codex-a', 'project-a', 'character', 'Codex A', '{\"type\":\"doc\"}')",
                [],
            )?;
            conn.execute(
                "INSERT INTO snippets (id, project_id, title, content)
                 VALUES ('snippet-a', 'project-a', 'Snippet A', '{\"type\":\"doc\"}')",
                [],
            )?;
            Ok(())
        })
        .expect("seed database");
    }

    #[test]
    fn derives_trusted_payload_domain_and_entity_type() {
        let db = database();
        let summary = db
            .append_timelapse_genesis_baselines(
                "project-a",
                TimelapseGenesisBaselineKind::Scene,
                &["scene-new".into()],
                123,
            )
            .expect("append baseline");
        assert_eq!(
            summary,
            TimelapseGenesisBaselineAppendSummary {
                inserted_count: 1,
                skipped_existing_baseline_count: 0,
                skipped_existing_body_step_count: 0,
            }
        );
        db.with_conn(|conn| {
            let row: (String, String, String, i64, i64, String, String, i64) = conn.query_row(
                "SELECT domain, entity_type, entity_id, anchor_sequence,
                        anchor_timestamp, payload, encoding, created_at
                   FROM state_snapshots",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )?;
            assert_eq!(
                row,
                (
                    "editor".into(),
                    "scene".into(),
                    "scene-new".into(),
                    0,
                    123,
                    r#"{"type":"doc","content":[]}"#.into(),
                    "json".into(),
                    123,
                )
            );
            Ok(())
        })
        .expect("read snapshot");
    }

    #[test]
    fn skips_only_the_same_entity_baseline_or_body_step() {
        let db = database();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO state_snapshots
                     (project_id, domain, entity_type, entity_id, anchor_sequence,
                      anchor_timestamp, payload, encoding, created_at)
                 VALUES ('project-a', 'editor', 'scene', 'scene-baseline', 9,
                         1, '{}', 'json', 1)",
                [],
            )?;
            conn.execute(
                "INSERT INTO change_events
                     (project_id, domain, op_type, entity_type, entity_id, payload,
                      session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('project-a', 'editor', 'doc.step', 'scene', 'scene-stepped', '{}',
                         'session-a', 1, 1, 'prev', 'hash')",
                [],
            )?;
            Ok(())
        })
        .expect("seed eligibility rows");

        let summary = db
            .append_timelapse_genesis_baselines(
                "project-a",
                TimelapseGenesisBaselineKind::Scene,
                &[
                    "scene-baseline".into(),
                    "scene-stepped".into(),
                    "scene-new".into(),
                ],
                200,
            )
            .expect("append eligible baseline");
        assert_eq!(
            summary,
            TimelapseGenesisBaselineAppendSummary {
                inserted_count: 1,
                skipped_existing_baseline_count: 1,
                skipped_existing_body_step_count: 1,
            }
        );
    }

    #[test]
    fn rejects_mis_scoped_or_wrong_kind_entities_before_any_insert() {
        for entity_id in ["scene-other", "note-a", "missing"] {
            let db = database();
            let error = db
                .append_timelapse_genesis_baselines(
                    "project-a",
                    TimelapseGenesisBaselineKind::Scene,
                    &["scene-new".into(), entity_id.into()],
                    1,
                )
                .expect_err("scope mismatch");
            assert!(
                error
                    .to_string()
                    .contains("TIMELAPSE_GENESIS_BASELINE_ENTITY_SCOPE_MISMATCH"),
                "unexpected error: {error:#}"
            );
            let count = db
                .with_conn(|conn| {
                    Ok(
                        conn.query_row("SELECT COUNT(*) FROM state_snapshots", [], |row| {
                            row.get::<_, i64>(0)
                        })?,
                    )
                })
                .expect("snapshot count");
            assert_eq!(count, 0);
        }
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_request_shapes() {
        let db = database();
        for (ids, timestamp) in [
            (Vec::<String>::new(), 1),
            (vec!["scene-new".into(), "scene-new".into()], 1),
            (vec![String::new()], 1),
            (vec![" scene-new".into()], 1),
            (vec!["scene-new".into()], -1),
            (vec!["scene-new".into()], MAX_SAFE_INTEGER + 1),
        ] {
            assert!(db
                .append_timelapse_genesis_baselines(
                    "project-a",
                    TimelapseGenesisBaselineKind::Scene,
                    &ids,
                    timestamp,
                )
                .is_err());
        }
        let too_many = (0..=MAX_ENTITY_IDS)
            .map(|index| format!("scene-{index}"))
            .collect::<Vec<_>>();
        assert!(db
            .append_timelapse_genesis_baselines(
                "project-a",
                TimelapseGenesisBaselineKind::Scene,
                &too_many,
                1,
            )
            .is_err());
        assert!(db
            .append_timelapse_genesis_baselines(
                " project-a",
                TimelapseGenesisBaselineKind::Scene,
                &["scene-new".into()],
                1,
            )
            .is_err());
    }

    #[test]
    fn bounds_multi_entity_payload_but_keeps_singletons_recoverable() {
        let oversized = "x".repeat(MAX_BATCH_PAYLOAD_BYTES + 1);
        validate_projected_batch_size(std::slice::from_ref(&oversized))
            .expect("oversized singleton stays baselineable");
        let error = validate_projected_batch_size(&[oversized, String::new()])
            .expect_err("oversized multi-entity transaction must split");
        assert!(error
            .to_string()
            .starts_with("TIMELAPSE_GENESIS_BASELINE_BATCH_TOO_LARGE:"));
    }

    #[test]
    fn payload_cap_applies_only_to_eligible_entities() {
        let db = database();
        let large = "x".repeat((MAX_BATCH_PAYLOAD_BYTES / 2) + 1);
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes SET content = ?1
                  WHERE id IN ('scene-new', 'scene-baseline')",
                [&large],
            )?;
            Ok(())
        })
        .expect("seed large bodies");
        let entity_ids = vec!["scene-new".into(), "scene-baseline".into()];
        let error = db
            .append_timelapse_genesis_baselines(
                "project-a",
                TimelapseGenesisBaselineKind::Scene,
                &entity_ids,
                1,
            )
            .expect_err("eligible large batch must split");
        assert!(error
            .to_string()
            .starts_with("TIMELAPSE_GENESIS_BASELINE_BATCH_TOO_LARGE:"));

        db.with_conn(|conn| {
            for entity_id in &entity_ids {
                conn.execute(
                    "INSERT INTO state_snapshots
                         (project_id, domain, entity_type, entity_id, anchor_sequence,
                          anchor_timestamp, payload, encoding, created_at)
                     VALUES ('project-a', 'editor', 'scene', ?1, 12, 1, '{}', 'json', 1)",
                    [entity_id],
                )?;
            }
            Ok(())
        })
        .expect("seed later rebaselines");
        let change_event_reads = Arc::new(AtomicUsize::new(0));
        let reads_for_hook = Arc::clone(&change_event_reads);
        db.with_conn(|conn| {
            conn.authorizer(Some(move |context: AuthContext<'_>| {
                if matches!(
                    context.action,
                    AuthAction::Read {
                        table_name: "change_events",
                        ..
                    }
                ) {
                    reads_for_hook.fetch_add(1, Ordering::SeqCst);
                    Authorization::Deny
                } else {
                    Authorization::Allow
                }
            }))?;
            Ok(())
        })
        .expect("install change_events read guard");
        let result = db.append_timelapse_genesis_baselines(
            "project-a",
            TimelapseGenesisBaselineKind::Scene,
            &entity_ids,
            2,
        );
        db.with_conn(|conn| {
            conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
            Ok(())
        })
        .expect("remove change_events read guard");
        let summary = result.expect("fully skipped batch must not query change_events");
        assert_eq!(summary.skipped_existing_baseline_count, 2);
        assert_eq!(summary.inserted_count, 0);
        assert_eq!(change_event_reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn ambiguous_legacy_domain_step_skips_every_requested_entity() {
        let db = database();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO change_events
                     (project_id, domain, op_type, entity_type, entity_id, payload,
                      session_id, sequence, timestamp, prev_hash, hash)
                 VALUES ('project-a', 'editor', 'doc.step', 'scene', NULL, '{}',
                         'legacy-session', 1, 1, 'prev', 'hash')",
                [],
            )?;
            Ok(())
        })
        .expect("seed ambiguous legacy step");
        let summary = db
            .append_timelapse_genesis_baselines(
                "project-a",
                TimelapseGenesisBaselineKind::Scene,
                &["scene-new".into(), "scene-baseline".into()],
                2,
            )
            .expect("ambiguous step is a safe skip");
        assert_eq!(summary.skipped_existing_body_step_count, 2);
        assert_eq!(summary.inserted_count, 0);
    }

    #[test]
    fn retry_is_idempotent() {
        let db = database();
        let first = db
            .append_timelapse_genesis_baselines(
                "project-a",
                TimelapseGenesisBaselineKind::Codex,
                &["codex-a".into()],
                10,
            )
            .expect("first append");
        let second = db
            .append_timelapse_genesis_baselines(
                "project-a",
                TimelapseGenesisBaselineKind::Codex,
                &["codex-a".into()],
                20,
            )
            .expect("retry append");
        assert_eq!(first.inserted_count, 1);
        assert_eq!(second.skipped_existing_baseline_count, 1);
    }

    #[test]
    fn concurrent_connections_cannot_duplicate_a_genesis_baseline() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-timelapse-genesis-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("grimodex.db");
        let first = Arc::new(Database::new(&path).expect("first database"));
        first.migrate().expect("schema");
        seed(&first);
        let second = Arc::new(Database::new(&path).expect("second database"));
        let barrier = Arc::new(Barrier::new(3));
        let handles = [first.clone(), second.clone()].map(|db| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                db.append_timelapse_genesis_baselines(
                    "project-a",
                    TimelapseGenesisBaselineKind::Snippet,
                    &["snippet-a".into()],
                    10,
                )
                .expect("concurrent append")
            })
        });
        barrier.wait();
        let summaries = handles.map(|handle| handle.join().expect("append thread"));
        assert_eq!(
            summaries
                .iter()
                .map(|summary| summary.inserted_count)
                .sum::<usize>(),
            1
        );
        assert_eq!(
            summaries
                .iter()
                .map(|summary| summary.skipped_existing_baseline_count)
                .sum::<usize>(),
            1
        );
        let count = first
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM state_snapshots
                      WHERE project_id = 'project-a'
                        AND domain = 'snippet'
                        AND entity_id = 'snippet-a'
                        AND anchor_sequence = 0",
                    [],
                    |row| row.get::<_, i64>(0),
                )?)
            })
            .expect("snapshot count");
        assert_eq!(count, 1);
        drop(first);
        drop(second);
        let _ = std::fs::remove_dir_all(dir);
    }
}
