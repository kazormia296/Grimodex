use crate::{test_support::current_schema_memory, Database};
use rusqlite::{params, Connection};
use std::path::Path;

#[derive(Clone, Copy)]
struct Rule<'a> {
    id: &'a str,
    rule_id: &'a str,
    revision_no: i64,
    supersedes: Option<&'a str>,
    state: &'a str,
    kind: &'a str,
    scope_kind: &'a str,
    scope_scene_id: Option<&'a str>,
    surface_text: Option<&'a str>,
    entry_id: Option<&'a str>,
    other_entry_id: Option<&'a str>,
    canonical_name: Option<&'a str>,
    keep_previous_as_alias: Option<i64>,
    provenance_kind: &'a str,
    provenance_ref: &'a str,
    request_id: &'a str,
}

impl<'a> Rule<'a> {
    fn valid(id: &'a str, kind: &'a str, request_id: &'a str) -> Self {
        let (surface_text, entry_id, other_entry_id, canonical_name, keep_previous_as_alias) =
            match kind {
                "must-link-surface" | "preferred-binding" => {
                    (Some("Name"), Some("entry-a"), None, None, None)
                }
                "cannot-link-entries" | "suppressed-merge-candidate" => {
                    (None, Some("entry-a"), Some("entry-b"), None, None)
                }
                _ => (None, Some("entry-a"), None, Some("Canonical"), Some(1)),
            };
        Self {
            id,
            rule_id: id,
            revision_no: 1,
            supersedes: None,
            state: "active",
            kind,
            scope_kind: "any",
            scope_scene_id: None,
            surface_text,
            entry_id,
            other_entry_id,
            canonical_name,
            keep_previous_as_alias,
            provenance_kind: "manual",
            provenance_ref: "manual",
            request_id,
        }
    }
}

fn insert_rule(conn: &Connection, rule: Rule<'_>) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO identity_correction_rule_revisions
            (id, project_id, rule_id, revision_no, supersedes_revision_id, state, kind,
             scope_kind, scope_scene_id, surface_text, entry_id, other_entry_id,
             canonical_name, keep_previous_as_alias, reason, provenance_kind,
             provenance_ref, actor_id, created_at, request_id)
         VALUES (?1, 'p', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 NULL, ?14, ?15, 'author', 'now', ?16)",
        params![
            rule.id,
            rule.rule_id,
            rule.revision_no,
            rule.supersedes,
            rule.state,
            rule.kind,
            rule.scope_kind,
            rule.scope_scene_id,
            rule.surface_text,
            rule.entry_id,
            rule.other_entry_id,
            rule.canonical_name,
            rule.keep_previous_as_alias,
            rule.provenance_kind,
            rule.provenance_ref,
            rule.request_id,
        ],
    )
}

fn seed_project(db: &Database) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('p', 'Project')",
            [],
        )?;
        Ok(())
    })
    .expect("seed project");
}

fn seed_proposal_revisions(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest, status, created_at)
         VALUES ('run-erm', 'p', 'surface', '{}', '{}', 'digest', 'completed', 'now')",
        [],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposal_sets
            (id, run_id, project_id, set_kind, status, summary_json, created_at, updated_at)
         VALUES ('set-erm', 'run-erm', 'p', 'test', 'draft', '{}', 'now', 'now')",
        [],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposals
            (id, proposal_set_id, proposal_key, kind, payload_json, created_at, updated_at)
         VALUES ('proposal-erm', 'set-erm', 'proposal-key', 'test', '{}', 'now', 'now')",
        [],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposal_revisions
            (id, proposal_id, revision_number, payload_json, origin_kind, created_at, created_by)
         VALUES ('proposal-r1', 'proposal-erm', 1, '{}', 'legacy-unbound', 'now', 'author'),
                ('proposal-r2', 'proposal-erm', 2, '{}', 'legacy-unbound', 'now', 'author')",
        [],
    )?;
    Ok(())
}

fn insert_operation(
    conn: &Connection,
    id: &str,
    project_id: &str,
    kind: &str,
    undoes: Option<&str>,
    request_id: &str,
    sequence: i64,
) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO identity_lineage_operations
            (id, project_id, op_kind, undoes_operation_id, reason, actor_id, created_at,
             request_id, narrative_commit_id, applied_change_sequence)
         VALUES (?1, ?2, ?3, ?4, 'reason', 'author', 'now', ?5, NULL, ?6)",
        params![id, project_id, kind, undoes, request_id, sequence],
    )
}

fn insert_application(
    conn: &Connection,
    id: &str,
    rule_revision_id: &str,
    route: &str,
    outcome: &str,
    output_revision_id: Option<&str>,
    batch_id: Option<&str>,
) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO identity_correction_applications
            (id, project_id, origin_proposal_revision_id, input_proposal_revision_id,
             output_proposal_revision_id, rule_revision_id, route, outcome, reason_code,
             reapply_batch_id, created_at)
         VALUES (?1, 'p', 'proposal-r1', 'proposal-r1', ?2, ?3, ?4, ?5, 'test', ?6, 'now')",
        params![
            id,
            output_revision_id,
            rule_revision_id,
            route,
            outcome,
            batch_id
        ],
    )
}

fn seed_all_erm_rows(db: &Database) {
    seed_project(db);
    db.with_conn(|conn| {
        insert_rule(
            conn,
            Rule::valid("rule-r1", "must-link-surface", "rule-request"),
        )?;
        insert_operation(conn, "op-1", "p", "merge", None, "op-request", 1)?;
        insert_operation(
            conn,
            "op-undo",
            "p",
            "undo",
            Some("op-1"),
            "undo-request",
            2,
        )?;
        conn.execute(
            "INSERT INTO identity_lineage_mappings
                (operation_id, ordinal, source_entry_id, target_entry_id, source_disposition)
             VALUES ('op-1', 0, 'entry-a', 'entry-b', 'retired')",
            [],
        )?;
        conn.execute(
            "INSERT INTO identity_lineage_reference_assignments
                (operation_id, ordinal, reference_kind, reference_id, from_entry_id, to_entry_id)
             VALUES ('op-1', 0, 'codex-entry', 'entry-a', 'entry-a', 'entry-b')",
            [],
        )?;
        seed_proposal_revisions(conn)?;
        insert_application(
            conn,
            "application-1",
            "rule-r1",
            "extraction",
            "conflict",
            None,
            Some("extraction-run-1"),
        )?;
        Ok(())
    })
    .expect("seed ERM rows");
}

#[test]
fn erm_fresh_install_creates_all_objects() {
    let db = Database::new(Path::new(":memory:")).expect("open empty workspace");
    db.migrate().expect("install current schema");
    db.with_conn(|conn| {
        let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(version, grimodex_core::SCHEMA_VERSION);
        assert!(grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?);
        Ok(())
    })
    .expect("verify fresh install checkpoint");
}

#[test]
fn erm_schema_48_migrates_version_47_and_installs_all_objects() {
    let db = current_schema_memory().expect("v47 current schema fixture");
    db.with_conn(|conn| {
        conn.execute_batch(
            "DROP TABLE identity_correction_applications;
             DROP TABLE identity_lineage_reference_assignments;
             DROP TABLE identity_lineage_mappings;
             DROP TABLE identity_lineage_operations;
             DROP TABLE identity_correction_rule_revisions;
             PRAGMA user_version = 47;",
        )?;
        Ok(())
    })
    .expect("prepare a version-47 database");

    db.migrate().expect("migrate version 47 to current");
    db.with_conn(|conn| {
        let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(version, grimodex_core::SCHEMA_VERSION);
        assert!(grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?);
        for table in [
            "identity_correction_rule_revisions",
            "identity_lineage_operations",
            "identity_lineage_mappings",
            "identity_lineage_reference_assignments",
            "identity_correction_applications",
        ] {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                [table],
                |row| row.get(0),
            )?;
            assert!(exists, "missing migrated table {table}");
        }
        Ok(())
    })
    .expect("verify v47 checkpoint");
}

#[test]
fn current_schema_marker_only_upgrade_from_previous_requires_checkpoint() {
    let db = current_schema_memory().expect("current schema fixture");
    let schema_version_before = db
        .with_conn(|conn| {
            Ok(conn.pragma_query_value(None, "schema_version", |row| row.get::<_, i64>(0))?)
        })
        .expect("read SQLite schema version");
    db.with_conn(|conn| {
        conn.pragma_update(
            None,
            "user_version",
            grimodex_core::PREVIOUS_COMPATIBLE_SCHEMA_VERSION,
        )?;
        Ok(())
    })
    .expect("set previous schema marker");

    db.migrate()
        .expect("finalize converged previous marker without waiting");
    db.with_conn(|conn| {
        let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let schema_version_after: i64 =
            conn.pragma_query_value(None, "schema_version", |row| row.get(0))?;
        assert_eq!(version, grimodex_core::SCHEMA_VERSION);
        assert_eq!(schema_version_after, schema_version_before);
        assert!(grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?);
        Ok(())
    })
    .expect("verify marker-only finalization");
}

#[test]
fn erm_rule_revision_checks_and_uniques_match_schema_contract() {
    let db = current_schema_memory().expect("current schema");
    seed_project(&db);
    db.with_conn(|conn| {
        for (id, kind) in [
            ("rule-surface", "must-link-surface"),
            ("rule-pair", "cannot-link-entries"),
            ("rule-binding", "preferred-binding"),
            ("rule-canonical", "preferred-canonical-name"),
            ("rule-suppressed", "suppressed-merge-candidate"),
        ] {
            insert_rule(conn, Rule::valid(id, kind, id))?;
        }
        let mut exact = Rule::valid("rule-exact", "must-link-surface", "request-exact");
        exact.scope_kind = "exact";
        exact.scope_scene_id = Some("scene-id");
        exact.provenance_kind = "review-proposal";
        exact.provenance_ref = "proposal-r1";
        insert_rule(conn, exact)?;

        let mut successor = Rule::valid("rule-next", "must-link-surface", "request-next");
        successor.rule_id = "rule-surface";
        successor.revision_no = 2;
        successor.supersedes = Some("rule-surface");
        insert_rule(conn, successor)?;

        let mut invalid = Vec::new();
        let mut row = Rule::valid(
            "bad-surface-missing",
            "must-link-surface",
            "bad-surface-missing",
        );
        row.surface_text = None;
        invalid.push(row);
        let mut row = Rule::valid(
            "bad-surface-entry",
            "must-link-surface",
            "bad-surface-entry",
        );
        row.entry_id = None;
        invalid.push(row);
        let mut row = Rule::valid(
            "bad-surface-other",
            "must-link-surface",
            "bad-surface-other",
        );
        row.other_entry_id = Some("entry-b");
        invalid.push(row);
        let mut row = Rule::valid("bad-surface-name", "must-link-surface", "bad-surface-name");
        row.canonical_name = Some("Wrong");
        invalid.push(row);
        let mut row = Rule::valid(
            "bad-surface-alias",
            "must-link-surface",
            "bad-surface-alias",
        );
        row.keep_previous_as_alias = Some(1);
        invalid.push(row);
        let mut row = Rule::valid("bad-pair-entry", "cannot-link-entries", "bad-pair-entry");
        row.entry_id = None;
        invalid.push(row);
        let mut row = Rule::valid("bad-pair-other", "cannot-link-entries", "bad-pair-other");
        row.other_entry_id = None;
        invalid.push(row);
        let mut row = Rule::valid("bad-pair-order", "cannot-link-entries", "bad-pair-order");
        row.entry_id = Some("entry-z");
        row.other_entry_id = Some("entry-a");
        invalid.push(row);
        let mut row = Rule::valid(
            "bad-pair-surface",
            "cannot-link-entries",
            "bad-pair-surface",
        );
        row.surface_text = Some("Name");
        invalid.push(row);
        let mut row = Rule::valid("bad-pair-name", "cannot-link-entries", "bad-pair-name");
        row.canonical_name = Some("Wrong");
        invalid.push(row);
        let mut row = Rule::valid("bad-pair-alias", "cannot-link-entries", "bad-pair-alias");
        row.keep_previous_as_alias = Some(0);
        invalid.push(row);
        let mut row = Rule::valid(
            "bad-canonical-entry",
            "preferred-canonical-name",
            "bad-canonical-entry",
        );
        row.entry_id = None;
        invalid.push(row);
        let mut row = Rule::valid(
            "bad-canonical-name",
            "preferred-canonical-name",
            "bad-canonical-name",
        );
        row.canonical_name = None;
        invalid.push(row);
        let mut row = Rule::valid(
            "bad-canonical-alias",
            "preferred-canonical-name",
            "bad-canonical-alias",
        );
        row.keep_previous_as_alias = None;
        invalid.push(row);
        let mut row = Rule::valid(
            "bad-canonical-alias-value",
            "preferred-canonical-name",
            "bad-canonical-alias-value",
        );
        row.keep_previous_as_alias = Some(2);
        invalid.push(row);
        let mut row = Rule::valid(
            "bad-canonical-surface",
            "preferred-canonical-name",
            "bad-canonical-surface",
        );
        row.surface_text = Some("Name");
        invalid.push(row);
        let mut row = Rule::valid(
            "bad-canonical-other",
            "preferred-canonical-name",
            "bad-canonical-other",
        );
        row.other_entry_id = Some("entry-b");
        invalid.push(row);
        let mut row = Rule::valid("bad-any-scene", "must-link-surface", "bad-any-scene");
        row.scope_scene_id = Some("scene-id");
        invalid.push(row);
        let mut row = Rule::valid("bad-exact-scene", "must-link-surface", "bad-exact-scene");
        row.scope_kind = "exact";
        invalid.push(row);
        let mut row = Rule::valid("bad-scope-kind", "must-link-surface", "bad-scope-kind");
        row.scope_kind = "project";
        invalid.push(row);
        let mut row = Rule::valid(
            "bad-first-supersedes",
            "must-link-surface",
            "bad-first-supersedes",
        );
        row.supersedes = Some("prior");
        invalid.push(row);
        let mut row = Rule::valid(
            "bad-next-no-supersedes",
            "must-link-surface",
            "bad-next-no-supersedes",
        );
        row.revision_no = 2;
        invalid.push(row);
        let mut row = Rule::valid(
            "bad-revision-zero",
            "must-link-surface",
            "bad-revision-zero",
        );
        row.revision_no = 0;
        invalid.push(row);
        let mut row = Rule::valid("bad-state", "must-link-surface", "bad-state");
        row.state = "deleted";
        invalid.push(row);
        let row = Rule::valid("bad-kind", "unknown", "bad-kind");
        invalid.push(row);
        for row in invalid {
            assert!(
                insert_rule(conn, row).is_err(),
                "invalid rule row passed: {}",
                row.id
            );
        }

        let mut duplicate_series = Rule::valid(
            "rule-series-duplicate",
            "must-link-surface",
            "request-series-duplicate",
        );
        duplicate_series.rule_id = "rule-surface";
        assert!(insert_rule(conn, duplicate_series).is_err());

        let mut duplicate_supersedes = Rule::valid(
            "rule-next-duplicate",
            "must-link-surface",
            "request-next-duplicate",
        );
        duplicate_supersedes.revision_no = 2;
        duplicate_supersedes.supersedes = Some("rule-surface");
        assert!(insert_rule(conn, duplicate_supersedes).is_err());

        let mut duplicate_request = Rule::valid(
            "rule-request-duplicate",
            "must-link-surface",
            "rule-surface",
        );
        duplicate_request.rule_id = "another-rule";
        assert!(insert_rule(conn, duplicate_request).is_err());
        Ok(())
    })
    .expect("verify rule revision CHECK and UNIQUE constraints");
}

#[test]
fn erm_lineage_and_application_constraints_match_schema_contract() {
    let db = current_schema_memory().expect("current schema");
    seed_project(&db);
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('p2', 'Other')",
            [],
        )?;
        insert_rule(
            conn,
            Rule::valid("rule-r1", "must-link-surface", "rule-request"),
        )?;
        insert_operation(conn, "op-1", "p", "merge", None, "op-request", 1)?;
        assert!(insert_operation(
            conn,
            "op-undo",
            "p",
            "undo",
            Some("op-1"),
            "undo-request",
            2
        )
        .is_ok());
        assert!(insert_operation(
            conn,
            "op-undo-duplicate",
            "p",
            "undo",
            Some("op-1"),
            "undo-request-duplicate",
            3
        )
        .is_err());
        assert!(
            insert_operation(conn, "op-no-target", "p", "undo", None, "op-no-target", 4).is_err()
        );
        assert!(insert_operation(
            conn,
            "op-wrong-target",
            "p",
            "merge",
            Some("op-1"),
            "op-wrong-target",
            5
        )
        .is_err());
        assert!(insert_operation(
            conn,
            "op-cross-project",
            "p2",
            "undo",
            Some("op-1"),
            "op-cross-project",
            6
        )
        .is_err());
        assert!(
            insert_operation(conn, "op-bad-kind", "p", "unknown", None, "op-bad-kind", 7).is_err()
        );
        assert!(insert_operation(
            conn,
            "op-request-duplicate",
            "p",
            "split",
            None,
            "op-request",
            8
        )
        .is_err());

        conn.execute(
            "INSERT INTO identity_lineage_mappings
                (operation_id, ordinal, source_entry_id, target_entry_id, source_disposition)
             VALUES ('op-1', 0, 'entry-a', 'entry-b', 'retained')",
            [],
        )?;
        assert!(conn
            .execute(
                "INSERT INTO identity_lineage_mappings
                (operation_id, ordinal, source_entry_id, target_entry_id, source_disposition)
             VALUES ('op-1', 1, 'entry-a', 'entry-b', 'unknown')",
                [],
            )
            .is_err());
        conn.execute(
            "INSERT INTO identity_lineage_reference_assignments
                (operation_id, ordinal, reference_kind, reference_id, from_entry_id, to_entry_id)
             VALUES ('op-1', 0, 'codex-entry', 'entry-a', 'entry-a', 'entry-b')",
            [],
        )?;
        seed_proposal_revisions(conn)?;
        assert!(insert_application(
            conn,
            "app-conflict",
            "rule-r1",
            "extraction",
            "conflict",
            None,
            Some("extraction-run-1")
        )
        .is_ok());
        assert!(insert_application(
            conn,
            "app-applied",
            "rule-r1",
            "reapply",
            "applied",
            Some("proposal-r2"),
            Some("batch-1")
        )
        .is_ok());
        assert!(insert_application(
            conn,
            "app-applied-no-output",
            "rule-r1",
            "reapply",
            "applied",
            None,
            Some("batch-2")
        )
        .is_err());
        assert!(insert_application(
            conn,
            "app-conflict-output",
            "rule-r1",
            "reapply",
            "conflict",
            Some("proposal-r2"),
            Some("batch-3")
        )
        .is_err());
        // route / outcome / provenance vocabularies belong to the later
        // writers (ERM PR 2-3), so the schema leaves them open; the batch id
        // is required so the retry uniqueness cannot be bypassed by NULL.
        assert!(insert_application(
            conn,
            "app-null-batch",
            "rule-r1",
            "reapply",
            "stale",
            None,
            None
        )
        .is_err());
        assert!(insert_application(
            conn,
            "app-batch-duplicate",
            "rule-r1",
            "reapply",
            "stale",
            None,
            Some("batch-1")
        )
        .is_err());
        Ok(())
    })
    .expect("verify lineage and application constraints");
}

#[test]
fn erm_writer_owned_vocabularies_stay_open_in_the_schema() {
    // DR-M3-39: the route / outcome / provenance vocabularies and the optional
    // provenance reference and lineage reason belong to the later writers
    // (ERM PR 2-3). The schema must not close them, or a writer would need
    // another schema bump.
    let db = current_schema_memory().expect("current schema");
    seed_all_erm_rows(&db);
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO identity_correction_rule_revisions
                (id, project_id, rule_id, revision_no, state, kind, scope_kind,
                 surface_text, entry_id, provenance_kind, provenance_ref, actor_id,
                 created_at, request_id)
             VALUES ('rule-open', 'p', 'rule-open', 1, 'active', 'must-link-surface', 'any',
                     'Open', 'entry-a', 'future-provenance', NULL, 'author', 'now',
                     'open-request')",
            [],
        )?;
        conn.execute(
            "INSERT INTO identity_lineage_operations
                (id, project_id, op_kind, reason, actor_id, created_at, request_id,
                 applied_change_sequence, ai_disclosure_choice)
             VALUES ('op-open', 'p', 'merge', NULL, 'author', 'now', 'op-open-request', 1,
                     'future-choice')",
            [],
        )?;
        insert_application(
            conn,
            "app-open",
            "rule-r1",
            "future-route",
            "future-outcome",
            None,
            Some("batch-open"),
        )?;
        Ok(())
    })
    .expect("writer-owned vocabularies and optional columns are accepted");
}

#[test]
fn all_erm_tables_reject_updates_and_renderer_generic_sql_read_write() {
    let db = current_schema_memory().expect("current schema");
    seed_all_erm_rows(&db);
    db.with_conn(|conn| {
        for sql in [
            "UPDATE identity_correction_rule_revisions SET state = 'retired' WHERE id = 'rule-r1'",
            "UPDATE identity_lineage_operations SET reason = 'changed' WHERE id = 'op-1'",
            "UPDATE identity_lineage_mappings SET target_entry_id = 'changed' WHERE operation_id = 'op-1'",
            "UPDATE identity_lineage_reference_assignments SET to_entry_id = 'changed' WHERE operation_id = 'op-1'",
            "UPDATE identity_correction_applications SET reason_code = 'changed' WHERE id = 'application-1'",
        ] {
            assert!(conn.execute(sql, []).is_err(), "UPDATE unexpectedly passed: {sql}");
        }
        Ok(())
    })
    .expect("verify immutable update guards");

    for table in [
        "identity_correction_rule_revisions",
        "identity_lineage_operations",
        "identity_lineage_mappings",
        "identity_lineage_reference_assignments",
        "identity_correction_applications",
    ] {
        let read =
            db.execute_renderer_profile_egress(&format!("SELECT * FROM {table}"), &[], "all");
        assert!(
            read.is_err(),
            "renderer read unexpectedly passed for {table}"
        );
        let write = db.execute_renderer_profile_egress(&format!("DELETE FROM {table}"), &[], "run");
        assert!(
            write.is_err(),
            "renderer write unexpectedly passed for {table}"
        );
    }
}

#[test]
fn project_delete_cascades_every_erm_table() {
    let db = current_schema_memory().expect("current schema");
    seed_all_erm_rows(&db);
    crate::domain_writes::project_delete(
        &db,
        crate::domain_writes::ProjectDeletePayload {
            project_id: "p".to_string(),
        },
    )
    .expect("project delete must cascade through ERM history");
    db.with_conn(|conn| {
        for table in [
            "identity_correction_rule_revisions",
            "identity_lineage_operations",
            "identity_lineage_mappings",
            "identity_lineage_reference_assignments",
            "identity_correction_applications",
        ] {
            let count: i64 =
                conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?;
            assert_eq!(count, 0, "project delete left rows in {table}");
        }
        Ok(())
    })
    .expect("verify ERM rows were removed");
}
