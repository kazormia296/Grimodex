//! Real SQLite admission boundaries. Loaded only by the diagnostic test build.
use super::*;
use crate::narrative_extraction::nir1_capacity_fixtures::build_fixture_from_manifest;
use crate::narrative_extraction::source_revision::is_validation_capacity_exceeded;

fn sum_text(conn: &Connection, query: &str) -> Result<usize> {
    let mut statement = conn.prepare(query)?;
    let columns = statement.column_count();
    let mut rows = statement.query([])?;
    let mut bytes = 0;
    while let Some(row) = rows.next()? {
        for column in 0..columns {
            if let rusqlite::types::ValueRef::Text(text) = row.get_ref(column)? {
                bytes += text.len();
            }
        }
    }
    Ok(bytes)
}

#[test]
fn stored_graph_rows_and_bytes_accept_n_and_refuse_n_plus_one() -> Result<()> {
    for d1 in [false, true] {
        let db = crate::test_support::current_schema_memory()?;
        db.with_conn(|conn| {
            conn.execute("INSERT INTO projects(id,title) VALUES('p','P')", [])?;
            if d1 {
                conn.execute("INSERT INTO narrative_dependency_declaration_sets
                    (id,project_id,consumer_kind,consumer_key,producer_id,producer_generation,dependency_set_digest,state,created_at)
                    VALUES('set','p',?1,?2,'producer',1,?3,'sealed','now')",
                    params![CONSUMER_KIND,INDEX_KEY,format!("sha256:{}", "0".repeat(64))])?;
                conn.execute("INSERT INTO narrative_dependency_declaration_heads
                    (project_id,consumer_kind,consumer_key,active_declaration_set_id,producer_id,producer_generation,version,updated_at)
                    VALUES('p',?1,?2,'set','producer',1,1,'now')", params![CONSUMER_KIND,INDEX_KEY])?;
            }
            let insert = |n: usize| -> Result<()> {
                if d1 {
                    conn.execute("INSERT INTO narrative_dependency_declaration_entries
                        (id,declaration_set_id,source_object_identity,dependency_key,dependency_role,role_contract_version,selector_json,selector_digest,created_at)
                        VALUES(?1,'set',?1,?2,'role','v1','{}',?2,'now')",
                        params![format!("e{n}"),format!("sha256:{}", "0".repeat(64))])?;
                } else {
                    conn.execute("INSERT INTO narrative_dependency_edges
                        (id,project_id,consumer_kind,consumer_key,source_object_identity,read_set_json,created_at)
                        VALUES(?1,'p',?2,?3,?1,'[]','now')", params![format!("e{n}"),CONSUMER_KIND,INDEX_KEY])?;
                }
                Ok(())
            };
            let table = if d1 { "narrative_dependency_declaration_entries" } else { "narrative_dependency_edges" };
            let tx = conn.unchecked_transaction()?;
            for n in 0..nir1_capacity::STORED_COLLECTION_LIMIT { insert(n)?; }
            tx.commit()?;
            preflight_stored_graph_capacity(conn, "p")?;
            insert(nir1_capacity::STORED_COLLECTION_LIMIT)?;
            let error = preflight_stored_graph_capacity(conn, "p").expect_err("N+1 stored rows");
            assert!(is_validation_capacity_exceeded(&error), "{error:#}");
            assert!(error.to_string().contains(if d1 { "stored-D1-rows" } else { "stored-edge-rows" }));
            conn.execute(&format!("DELETE FROM {table} WHERE id<> 'e0'"), [])?;
            let mut bytes = sum_text(conn, &format!("SELECT * FROM {table}"))?;
            if d1 {
                bytes += sum_text(conn, "SELECT * FROM narrative_dependency_declaration_sets")?;
                bytes += sum_text(conn, "SELECT active_declaration_set_id,producer_id,updated_at FROM narrative_dependency_declaration_heads")?;
            }
            conn.execute(&format!("UPDATE {table} SET created_at=created_at||?1"), ["x".repeat(nir1_capacity::INPUT_BYTES - bytes)])?;
            preflight_stored_graph_capacity(conn, "p")?;
            conn.execute(&format!("UPDATE {table} SET created_at=created_at||'x'"), [])?;
            let error = preflight_stored_graph_capacity(conn, "p").expect_err("N+1 stored bytes");
            assert!(is_validation_capacity_exceeded(&error), "{error:#}");
            assert!(conn.is_autocommit());
            Ok(())
        })?;
    }
    Ok(())
}

fn rebuild_cycle_control(
    should_stop: &dyn Fn() -> Result<()>,
) -> super::super::maintenance_runtime::MaintenanceCycleControl<'_> {
    use super::super::maintenance_runtime::{DesiredWork, MaintenanceCycleControl};
    fn no_key(_: &str) -> Result<()> {
        Ok(())
    }
    fn no_work(_: &DesiredWork) -> Result<()> {
        Ok(())
    }
    MaintenanceCycleControl {
        should_stop,
        stop_signal: None,
        finalization_granted_signal: None,
        defer_preempted_run: &no_key,
        grant_finalize: &no_key,
        register_work: &no_work,
        work_started: &no_work,
        work_completed: &no_work,
        work_noop_completed: &no_work,
        work_deferred: &no_work,
        attach_run: None,
        reserve_run: None,
        mark_run_creation_started: None,
        mark_run_reuse_selection_unknown: None,
        mark_run_creation_outcome: None,
        reset_run_creation_tracking: None,
        mark_run_terminalized: None,
    }
}

#[test]
fn rebuild_entry_refuses_oversize_graph_before_d1_or_edge_materialization() -> Result<()> {
    use super::super::restore_rebuild::rebuild_narrative_derived_state_for_project_with_control;
    use nir1_capacity::materialization_probe::READS;

    let control = rebuild_cycle_control(&|| Ok(()));
    for controlled in [false, true] {
        for d1 in [true, false] {
            for bytes in [false, true] {
                let db = crate::test_support::current_schema_memory()?;
                db.with_conn(|conn| {
                    conn.execute_batch("INSERT INTO projects(id,title) VALUES('p','P');
                        INSERT INTO narrative_semantic_epochs(id,project_id,epoch_number,reason,created_at)
                        VALUES('epoch','p',0,'initial','2026-09-22T00:00:00.000Z');")?;
                    let n = if bytes { 1 } else { nir1_capacity::STORED_COLLECTION_LIMIT as i64 + 1 };
                    if d1 {
                        conn.execute("INSERT INTO narrative_dependency_declaration_sets
                            (id,project_id,consumer_kind,consumer_key,producer_id,producer_generation,dependency_set_digest,state,created_at)
                            VALUES('set','p',?1,?2,'producer',1,?3,'sealed','now')",
                            params![CONSUMER_KIND,INDEX_KEY,format!("sha256:{}", "0".repeat(64))])?;
                        conn.execute("INSERT INTO narrative_dependency_declaration_heads
                            (project_id,consumer_kind,consumer_key,active_declaration_set_id,producer_id,producer_generation,version,updated_at)
                            VALUES('p',?1,?2,'set','producer',1,1,'now')", params![CONSUMER_KIND,INDEX_KEY])?;
                        conn.execute("WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<?1)
                            INSERT INTO narrative_dependency_declaration_entries
                            (id,declaration_set_id,source_object_identity,dependency_key,dependency_role,role_contract_version,selector_json,selector_digest,created_at)
                            SELECT 'e'||n,'set','codex:e'||n,?2,'direct-evidence','1','{}',?2,'now' FROM x",
                            params![n,format!("sha256:{}", "0".repeat(64))])?;
                        if bytes {
                            conn.execute("UPDATE narrative_dependency_declaration_entries SET selector_json=?1",
                                [serde_json::json!({"padding":"x".repeat(nir1_capacity::INPUT_BYTES + 1)}).to_string()])?;
                        }
                    } else {
                        conn.execute("WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<?1)
                            INSERT INTO narrative_dependency_edges
                            (id,project_id,consumer_kind,consumer_key,source_object_identity,read_set_json,created_at)
                            SELECT 'e'||n,'p',?2,?3,'codex:e'||n,'[]','now' FROM x", params![n,CONSUMER_KIND,INDEX_KEY])?;
                        if bytes {
                            conn.execute("UPDATE narrative_dependency_edges SET read_set_json=?1",
                                [serde_json::json!(["x".repeat(nir1_capacity::INPUT_BYTES + 1)]).to_string()])?;
                        }
                    }
                    Ok(())
                })?;
                READS.with(|reads| reads.replace(Some(Vec::new())));
                let result = rebuild_narrative_derived_state_for_project_with_control(
                    &db,
                    "p",
                    controlled.then_some(&control),
                    "capacity-rebuild",
                );
                let reads = READS.with(|reads| reads.take().unwrap());
                assert!(reads.is_empty(), "materialized before admission: controlled={controlled}, d1={d1}, bytes={bytes}: {reads:?}");
                let error = result.expect_err("oversize stored Graph must refuse Rebuild");
                assert!(is_validation_capacity_exceeded(&error), "{error:#}");
                assert!(
                    error
                        .to_string()
                        .contains(if d1 { "stored-D1-" } else { "stored-edge-" }),
                    "{error:#}"
                );
                db.with_conn(|conn| {
                    assert!(conn.is_autocommit());
                    let statuses: (String, String, String) = conn.query_row(
                        "SELECT r.status,a.status,a.retry_disposition FROM narrative_extraction_runs r
                         JOIN narrative_extraction_tasks t ON t.run_id=r.id
                         JOIN narrative_extraction_attempts a ON a.task_id=t.id
                         WHERE r.run_kind='semantic-index-rebuild'", [],
                        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
                    assert_eq!(statuses, ("failed".into(),"failed".into(),"manual".into()));
                    Ok(())
                })?;
            }
        }
    }
    Ok(())
}

#[test]
fn rebuild_rechecks_graph_growth_after_the_d1_snapshot() -> Result<()> {
    use super::super::restore_rebuild::{
        rebuild_narrative_derived_state_for_project_with_control,
        rebuild_narrative_derived_state_for_project_with_graph_control,
    };
    use nir1_capacity::materialization_probe::READS;

    struct Check<'a>(&'a dyn Fn() -> Result<()>);
    impl GraphWorkControl for Check<'_> {
        fn check(&mut self, _: GraphWorkStage) -> Result<()> {
            (self.0)()
        }
        fn allows_full_eligibility(&self) -> bool {
            true
        }
    }
    for controlled in [false, true] {
        let root =
            std::env::temp_dir().join(format!("nir1-rebuild-capacity-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root)?;
        let path = root.join("workspace.db");
        crate::test_support::current_schema_memory()?.with_conn(|conn| {
            conn.backup("main", &path, None)?;
            Ok(())
        })?;
        let db = crate::Database::new(&path)?;
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO projects(id,title) VALUES('p','P');
                INSERT INTO narrative_semantic_epochs(id,project_id,epoch_number,reason,created_at)
                VALUES('epoch','p',0,'initial','2026-09-22T00:00:00.000Z');",
            )?;
            Ok(())
        })?;
        let runtime = NirChronicleIndexRuntime::new(&db, 1);
        let snapshot =
            db.with_read_transaction(|conn| prepare_graph_index_build(conn, &runtime, "p"))?;
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            publish_nir1_entity_relation_index_in_tx(&tx, &runtime, snapshot)?;
            tx.commit()?;
            Ok(())
        })?;
        let writer = Connection::open(&path)?;
        writer.busy_timeout(Duration::ZERO)?;
        let injected = std::cell::Cell::new(false);
        let padding = serde_json::json!(["x".repeat(nir1_capacity::INPUT_BYTES + 1)]).to_string();
        let grow_after_d1 = || -> Result<()> {
            let read_d1 = READS.with(|reads| {
                reads
                    .borrow()
                    .as_ref()
                    .is_some_and(|reads| reads.iter().any(|(d1, _)| *d1))
            });
            if injected.get() || !read_d1 {
                return Ok(());
            }
            // A separate WAL writer can change a read snapshot immediately;
            // for the cycle's IMMEDIATE snapshot, wait until the owner next
            // releases the transaction. Never wait or reenter its mutex.
            match writer.execute_batch("BEGIN IMMEDIATE") {
                Ok(()) => {}
                Err(rusqlite::Error::SqliteFailure(code, _))
                    if matches!(
                        code.code,
                        rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                    ) =>
                {
                    return Ok(())
                }
                Err(error) => return Err(error.into()),
            }
            writer.execute(
                "UPDATE narrative_dependency_edges SET read_set_json=?1
                WHERE project_id='p' AND consumer_kind=?2 AND consumer_key=?3",
                params![padding, CONSUMER_KIND, INDEX_KEY],
            )?;
            writer.execute_batch("COMMIT")?;
            injected.set(true);
            Ok(())
        };
        READS.with(|reads| reads.replace(Some(Vec::new())));
        let result = if controlled {
            rebuild_narrative_derived_state_for_project_with_control(
                &db,
                "p",
                Some(&rebuild_cycle_control(&grow_after_d1)),
                "capacity-rebuild",
            )
        } else {
            rebuild_narrative_derived_state_for_project_with_graph_control(
                &db,
                "p",
                &mut Check(&grow_after_d1),
            )
        };
        let reads = READS.with(|reads| reads.take().unwrap());
        assert!(injected.get(), "the concurrent writer must actually commit");
        assert!(
            !reads.is_empty() && reads.iter().all(|(d1, autocommit)| *d1 && !*autocommit),
            "all D1 reads use snapshots; no Graph Edge materialization: {reads:?}"
        );
        let error =
            result.expect_err("the later phase must recheck the newly enlarged stored Graph");
        assert!(is_validation_capacity_exceeded(&error), "{error:#}");
        assert!(error.to_string().contains("stored-edge-bytes"), "{error:#}");
        drop(writer);
        drop(runtime);
        drop(db);
        std::fs::remove_dir_all(root)?;
    }
    Ok(())
}

#[test]
fn source_byte_boundary_and_roster_projection_guard_preserve_prior_generation() -> Result<()> {
    let root = std::env::temp_dir().join(format!("nir1-capacity-bytes-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root)?;
    let manifest = root.join("manifest.json");
    let path = root.join("source.db");
    let project = super::super::nir1_capacity_fixtures::NIR1_CAPACITY_FIXTURE_PROJECT_ID;
    std::fs::write(
        &manifest,
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion":"nir1-capacity/1", "diagnosticOnly":true,
            "fixtures":[{"id":"source-bytes-N", "qualifiedMaterials":16,
                "qualifiedRevisions":8, "ineligibleCandidates":10,
                "sourceInputBytes":nir1_capacity::INPUT_BYTES}]
        }))?,
    )?;
    build_fixture_from_manifest(&manifest, "source-bytes-N", &path)?;
    let db = crate::Database::new(&path)?;
    let runtime = NirChronicleIndexRuntime::new(&db, 1);
    let snapshot = db.with_read_transaction(|conn| {
        assert_eq!(
            source_capacity_usage(conn, project)?.0,
            nir1_capacity::INPUT_BYTES
        );
        prepare_graph_index_build(conn, &runtime, project)
    })?;
    let binding = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let binding = publish_nir1_entity_relation_index_in_tx(&tx, &runtime, snapshot)?;
        tx.commit()?;
        Ok(binding)
    })?;
    db.with_read_transaction(|conn| {
        let id: String = conn.query_row("SELECT r.id FROM narrative_proposal_revisions r
            JOIN narrative_proposals p ON p.id=r.proposal_id JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id
            WHERE s.run_id='nir1-capacity-qualified-run' LIMIT 1", [], |row| row.get(0))?;
        let (mut revision, decision) = read_nir1_entity_relation_revision_current_for_graph_index(conn, project, &id)?.expect("qualified Native A2 revision");
        let mut used = SourceCapacity::default();
        admit_roster_bytes(&mut used, &revision, &decision)?;
        // Exercise the projection's own independent limit, without pretending
        // that this enlarged synthetic reference is a valid A2 input bundle.
        revision.material_basis.evidence_set[0].evidence_ref.push_str(&"x".repeat(nir1_capacity::ROSTER_BYTES - used.roster_bytes));
        let mut exact = SourceCapacity::default();
        admit_roster_bytes(&mut exact, &revision, &decision)?;
        assert_eq!(exact.roster_bytes, nir1_capacity::ROSTER_BYTES);
        revision.material_basis.evidence_set[0].evidence_ref.push('x');
        assert!(is_validation_capacity_exceeded(&admit_roster_bytes(&mut SourceCapacity::default(), &revision, &decision).expect_err("N+1 retained bytes")));
        Ok(())
    })?;
    db.with_conn(|conn| {
        conn.execute("UPDATE narrative_proposal_revisions SET payload_json=payload_json||' '
            WHERE id=(SELECT r.id FROM narrative_proposal_revisions r JOIN narrative_proposals p ON p.id=r.proposal_id
                JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id WHERE s.run_id='nir1-capacity-fixture-run' LIMIT 1)", [])?;
        Ok(())
    })?;
    let error = db
        .with_read_transaction(|conn| prepare_graph_index_build(conn, &runtime, project))
        .err()
        .expect("N+1 input refuses prepare");
    assert!(is_validation_capacity_exceeded(&error), "{error:#}");
    assert!(error.to_string().contains("input-bytes"));
    db.with_conn(|conn| {
        assert!(conn.is_autocommit());
        let generation: i64 = conn.query_row("SELECT generation FROM narrative_semantic_index_metadata WHERE project_id=?1 AND index_key=?2", params![project,INDEX_KEY], |row| row.get(0))?;
        assert_eq!(generation, binding.generation);
        Ok(())
    })?;
    drop(runtime);
    drop(db);
    std::fs::remove_dir_all(root)?;
    Ok(())
}
