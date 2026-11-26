use super::*;
use crate::agent_writes::{
    agent_event_delete_with_authority_impl, agent_event_delete_with_request_impl,
    AgentEventIdPayload,
};
use crate::narrative_extraction::{
    narrative_extraction_apply_commit, narrative_extraction_prepare_commit,
};

use crate::project_snapshots::{
    create_project_snapshot, project_snapshot_restore_context, RestoreScope,
};

const PROJECT: &str = "project-1";

/// Two separate approvals and Applications, sharing one real Prepare/Apply transaction.
fn human_import() -> anyhow::Result<Database> {
    let db = current_schema_full_db();
    seed_scene(&db, "source");
    import_events(&db, &["one", "two"])?;
    Ok(db)
}

fn import_events(db: &Database, ids: &[&str]) -> anyhow::Result<()> {
    enable_manual_apply_for_test(db);
    create_run_with_task(db, "existence-run", "existence-task");
    let mut envelope = scene_body_envelope(db, "existence-run", "existence-task", "source");
    envelope["changeKind"] = json!("add");
    let mut seeds = Vec::new();
    for &id in ids {
        seeds.push(ProposalSeed {
            proposal_id: Some(id.into()),
            proposal_key: id.into(),
            kind: "chronicle.event.create".into(),
            payload_json: json!({
                "eventId": format!("event-{id}"), "title": id, "kind": "generic",
                "placement": {"mode":"append-tail","afterOrdinal":null},
                "precision":"unknown","secret":false,
                "startGranularity":"none","endGranularity":"none"
            }),
            reconciliation_envelope: Some(envelope.clone()),
        });
    }
    let saved = save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: "existence-run".into(),
            project_id: PROJECT.into(),
            proposal_set_id: Some("existence-set".into()),
            set_kind: "chronicle.extract.review@1".into(),
            summary_json: None,
            proposals: seeds.clone(),
        },
    )?;
    let mut operations = Vec::new();
    let mut applications = Vec::new();
    for (seed, saved) in seeds
        .into_iter()
        .zip(saved["proposals"].as_array().unwrap())
    {
        let proposal = seed.proposal_id.unwrap();
        let revision = saved["revisionId"].as_str().unwrap().to_owned();
        assert_eq!(saved["proposalId"], proposal);
        append_human_decision(
            db,
            AppendDecisionPayload {
                project_id: PROJECT.into(),
                run_id: "existence-run".into(),
                proposal_id: proposal.clone(),
                revision_id: revision.clone(),
                decision: "approved".into(),
                decision_json: None,
                created_by: None,
            },
        )?;
        operations.push(CommitOperation {
            kind: seed.kind,
            payload: seed.payload_json,
            proposal_id: proposal.clone(),
            revision_id: revision.clone(),
        });
        applications.push(CommitApplicationRef {
            proposal_id: proposal,
            revision_id: revision,
        });
    }
    let prepared = narrative_extraction_prepare_commit(
        db,
        PrepareCommitPayload {
            project_id: PROJECT.into(),
            run_id: "existence-run".into(),
            proposal_set_id: "existence-set".into(),
            request_id: "import".into(),
            session_id: "session".into(),
            plan_digest: "ignored".into(),
            surface: Some("narrative-extraction".into()),
            operations,
            applications,
            entity_bindings: vec![],
            expected_tail_ordinal: None,
            expected_calendar_version: None,
        },
    )?;
    narrative_extraction_apply_commit(
        db,
        ApplyCommitPayload {
            project_id: PROJECT.into(),
            prepared_commit_id: prepared["preparedCommitId"].as_str().unwrap().into(),
            request_id: "import".into(),
            session_id: "session".into(),
            expected_version: prepared["version"].as_i64(),
        },
    )?;
    Ok(())
}

#[test]
fn ai_and_mcp_cannot_delete_a_human_approved_import() -> anyhow::Result<()> {
    let db = human_import()?;
    let version: i64 = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT e.version FROM events e JOIN narrative_field_authority f
           ON f.entity_id = e.id AND f.project_id = e.project_id
          WHERE e.id='event-one' AND e.secret=0 AND f.entity_kind='event'
            AND f.field_path='/title' AND f.owner_kind='human'",
            [],
            |r| r.get(0),
        )?)
    })?;
    let payload = |surface| AgentEventIdPayload {
        project_id: PROJECT.into(),
        session_id: "session".into(),
        event_id: "event-one".into(),
        base_version: version,
        surface,
    };
    let context = serde_json::from_value(json!({
        "requestId":"agent-delete","eventUid":"agent-delete-event","origin":"ai-apply",
        "authorityRoute":"interactive-agent-command","caller":"chat-tool-executor",
        "controls":["knowledge-write-policy","stable-request-id","agent-provenance","field-authority",
                    "typed-writer","occ","undo-journal","change-event","change-feed"],
        "provenance":{"requestId":"agent-delete","traceId":"trace"}
    }))?;
    let agent = agent_event_delete_with_authority_impl(&db, payload(None), context).unwrap_err();
    assert!(
        agent.to_string().contains("NEX_FIELD_AUTHORITY_DENIED"),
        "{agent:#}"
    );
    let mcp =
        agent_event_delete_with_request_impl(&db, payload(Some("mcp".into())), Some("mcp-delete"))
            .unwrap_err();
    assert!(
        mcp.to_string().contains("NEX_FIELD_AUTHORITY_DENIED"),
        "{mcp:#}"
    );
    Ok(())
}

fn revoke(conn: &Connection, ids: &[String]) -> anyhow::Result<usize> {
    append_event_existence_decisions_in_tx(
        conn,
        PROJECT,
        EventExistenceChange::Removed {
            event_ids: ids,
            via: RemovedVia::SnapshotRestore,
        },
    )
}

fn state(conn: &Connection, proposal: &str) -> anyhow::Result<(String, i64)> {
    Ok(conn.query_row(
        "SELECT p.status, (SELECT count(*) FROM narrative_proposal_decisions d
                         WHERE d.proposal_id=p.id) FROM narrative_proposals p WHERE p.id=?1",
        [proposal],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

#[test]
fn one_lookup_revokes_each_approval_once_and_rolls_back_with_its_caller() -> anyhow::Result<()> {
    let db = human_import()?;
    db.with_conn(|conn| {
        let index_key = crate::narrative_extraction::nir1_chronicle_index::INDEX_KEY;
        conn.execute(
            "INSERT INTO narrative_semantic_index_metadata
               (project_id,index_key,generation,built_at,source_digest,dependency_set_digest,dirty_cache_flag)
             VALUES (?1,?2,1,'2026-01-01','source','deps',0)", params![PROJECT, index_key])?;
        let dirty = || -> rusqlite::Result<bool> {
            conn.query_row("SELECT dirty_cache_flag FROM narrative_semantic_index_metadata
                             WHERE project_id=?1 AND index_key=?2", params![PROJECT,index_key], |r| r.get(0))
        };
        let tx = conn.unchecked_transaction()?;
        let mut ids = vec!["event-one".to_string(), "event-two".into()];
        ids.extend((2..2000).map(|i| format!("unrelated-{i}")));
        let plan = tx.prepare(&format!("EXPLAIN QUERY PLAN {REMOVED_EVENT_PROPOSALS_SQL}"))?
            .query_map(params![PROJECT, serde_json::to_string(&ids)?, NIR1_ENTITY_RELATION_PROPOSAL_KIND],
                       |r| r.get::<_, String>(3))?.collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(plan.iter().filter(|line| line.as_str() == "SCAN a").count(), 1, "{plan:?}");
        assert!(plan.iter().any(|line| line.contains("idx_narrative_compensation_target")), "{plan:?}");
        assert_eq!(append_event_existence_decisions_in_tx(&tx, "other-project",
            EventExistenceChange::Removed { event_ids: &ids, via: RemovedVia::ScreenDelete })?, 0);
        assert_eq!(revoke(&tx, &ids)?, 2);
        assert!(dirty()?);
        assert_eq!(revoke(&tx, &ids)?, 0);
        for proposal in ["one", "two"] {
            assert_eq!(state(&tx, proposal)?, ("rejected".into(), 2));
            let (raw, previous): (String, String) = tx.query_row(
                "SELECT d.decision_json, previous.id FROM narrative_proposal_decisions d
                   JOIN narrative_proposal_decisions previous ON previous.proposal_id=d.proposal_id
                    AND previous.revision_id=d.revision_id AND previous.decision='approved'
                  WHERE d.proposal_id=?1 AND d.decision='rejected' AND d.created_at>previous.created_at
                    AND d.actor_kind='ai' AND d.actor_id='native:event-existence-sync'
                    AND d.override_field_paths_json='[]' AND d.authority_scope=previous.authority_scope",
                [proposal], |r| Ok((r.get(0)?, r.get(1)?)))?;
            assert_eq!(serde_json::from_str::<Value>(&raw)?, json!({"cause":"event-removed",
                "removedVia":"snapshot-restore","removedEventId":format!("event-{proposal}"),
                "revokesDecisionId":previous}));
        }
        tx.rollback()?;
        assert!(!dirty()?);
        for proposal in ["one", "two"] {
            assert_eq!(state(conn, proposal)?, ("approved".into(), 1));
        }
        Ok(())
    })
}

#[test]
fn a_failed_second_decision_can_roll_back_the_first_and_the_removal() -> anyhow::Result<()> {
    let db = human_import()?;
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM events WHERE project_id=?1", [PROJECT])?;
        tx.execute_batch(
            "CREATE TEMP TRIGGER fail_second_existence_decision BEFORE INSERT ON narrative_proposal_decisions
             WHEN EXISTS (SELECT 1 FROM narrative_proposal_decisions WHERE actor_id='native:event-existence-sync')
             BEGIN SELECT RAISE(ABORT, 'second decision failed'); END;"
        )?;
        let err = revoke(&tx, &["event-one".into(), "event-two".into()]).unwrap_err();
        assert!(err.to_string().contains("second decision failed"), "{err:#}");
        tx.rollback()?;
        let events: i64 = conn.query_row("SELECT count(*) FROM events WHERE project_id=?1", [PROJECT], |r| r.get(0))?;
        assert_eq!(events, 2);
        for proposal in ["one", "two"] {
            assert_eq!(state(conn, proposal)?, ("approved".into(), 1));
        }
        Ok(())
    })
}

#[test]
fn ineligible_applications_leave_status_and_decisions_untouched() -> anyhow::Result<()> {
    let db = human_import()?;
    db.with_conn(|conn| {
        for (setup, event) in [
            ("", "handwritten"),
            ("INSERT INTO narrative_proposal_revisions
                (id,proposal_id,revision_number,payload_json,created_at,created_by)
              VALUES ('other-revision','one',2,'{}','2025-01-01','legacy');
              UPDATE narrative_proposals SET current_revision_id='other-revision' WHERE id='one';
              INSERT INTO narrative_proposal_decisions
                 (id,proposal_id,revision_id,decision,created_at,created_by)
              VALUES ('new-approval','one','other-revision','approved','2999-01-01','legacy')", "event-one"),
            ("UPDATE narrative_proposals SET status='held' WHERE id='one'", "event-one"),
            ("UPDATE narrative_proposals SET kind='nir1.entity-relation@1' WHERE id='one'", "event-one"),
            ("INSERT INTO narrative_proposal_decisions
                 (id,proposal_id,revision_id,decision,created_at,created_by)
               SELECT 'later',proposal_id,revision_id,'held','2999-01-01','legacy'
                 FROM narrative_proposal_decisions WHERE proposal_id='one'", "event-one"),
            ("INSERT INTO narrative_proposal_decisions
                 (id,proposal_id,revision_id,decision,created_at,created_by)
               SELECT 'later',proposal_id,'older-revision','approved','2999-01-01','legacy'
                 FROM narrative_proposal_decisions WHERE proposal_id='one'", "event-one"),
            ("INSERT INTO narrative_proposal_applications
                 (id,commit_id,proposal_id,revision_id,applied_entity_kind,applied_entity_id,created_at,
                  application_kind,compensates_application_id)
               SELECT 'retraction',commit_id,proposal_id,revision_id,'event',applied_entity_id,created_at,
                      'compensation',id FROM narrative_proposal_applications WHERE proposal_id='one'", "event-one"),
            ("INSERT INTO narrative_proposal_applications
                 (id,commit_id,proposal_id,revision_id,applied_entity_kind,applied_entity_id,created_at)
               SELECT 'other',commit_id,proposal_id,revision_id,'codex_entry','other-kind',created_at
                 FROM narrative_proposal_applications WHERE proposal_id='one'", "other-kind"),
        ] {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(setup)?;
            let before = state(&tx, "one")?;
            assert_eq!(revoke(&tx, &[event.to_string()])?, 0, "{setup}");
            assert_eq!(state(&tx, "one")?, before);
            assert_eq!(state(&tx, "two")?, ("approved".into(), 1));
            tx.rollback()?;
        }
        Ok(())
    })
}

#[test]
fn only_the_native_existence_writer_can_append_after_apply() {
    use sha2::{Digest, Sha256};
    let source = include_str!("narrative_extraction/repository.rs");
    let start = source.find("fn append_decision_on_conn(").unwrap();
    let end = source[start..]
        .find("\n#[derive(Clone, Copy, serde::Serialize)]")
        .unwrap()
        + start;
    assert_eq!(
        hex::encode(Sha256::digest(&source.as_bytes()[start..end])),
        "a47bd72dc0a5d379a248eccaff9fafe3493b481f366f985fc1b3c410ea4e2b4a"
    );
    // Which production functions append decisions at all is pinned by
    // `proposal_decision_writer_inventory` (narrative_scope_storage_authority).
    let production = source.split("mod unit_tests {").next().unwrap();
    let insertion = "INSERT INTO narrative_proposal_decisions";
    assert_eq!(production.matches(insertion).count(), 2);
    let writer = production
        .split("fn append_event_existence_decisions_in_tx(")
        .nth(1)
        .unwrap()
        .split("\n}")
        .next()
        .unwrap();
    assert_eq!(writer.matches(insertion).count(), 1);
    for check in [
        "ensure_proposal_not_applied",
        "ensure_current_chronicle_proposal_set_unconsumed",
        "validate_current_chronicle_decision_against_plan",
    ] {
        assert!(source[start..end].contains(check));
        assert!(!writer.contains(check));
    }
}

fn execute(db: &Database, sql: &str) -> anyhow::Result<()> {
    db.with_conn(|conn| Ok(conn.execute_batch(sql)?))
}

fn fail_sync(db: &Database) -> anyhow::Result<()> {
    execute(
        db,
        "CREATE TEMP TRIGGER fail_sync BEFORE INSERT ON narrative_proposal_decisions
                 WHEN NEW.actor_id='native:event-existence-sync'
                 BEGIN SELECT RAISE(ABORT,'injected version conflict'); END",
    )
}

fn check_failure(error: anyhow::Error, replay: bool) {
    let message = error.to_string();
    if replay {
        assert!(
            message.starts_with("NEX_EXISTENCE_SYNC_FAILED:"),
            "{error:#}"
        );
        assert!(!message.contains("version conflict"), "{error:#}");
    } else {
        assert!(
            !message.starts_with("NEX_EXISTENCE_SYNC_FAILED:"),
            "{error:#}"
        );
        assert!(
            format!("{error:#}").contains("injected version conflict"),
            "{error:#}"
        );
    }
}

fn check_event(db: &Database, event: &str, present: bool) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM events WHERE project_id=?1 AND id=?2)",
            params![PROJECT, event],
            |r| r.get(0),
        )?;
        assert_eq!(exists, present, "{event}");
        Ok(())
    })
}

fn check_decisions(db: &Database, proposal: &str, via: Option<&str>) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        let routes = conn
            .prepare(
                "SELECT json_extract(decision_json, '$.removedVia')
            FROM narrative_proposal_decisions WHERE proposal_id=?1 AND decision='rejected'",
            )?
            .query_map([proposal], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(routes, via.into_iter().collect::<Vec<_>>(), "{proposal}");
        assert_eq!(
            state(conn, proposal)?,
            if via.is_some() {
                ("rejected".into(), 2)
            } else {
                ("approved".into(), 1)
            }
        );
        Ok(())
    })
}

fn handwritten(db: &Database) -> anyhow::Result<Value> {
    crate::agent_writes::agent_event_create_impl(
        db,
        serde_json::from_value(json!({
            "requestId":"create-hand", "eventId":"hand", "projectId":PROJECT,
            "sessionId":"session", "surface":"manual", "title":"hand", "ordinal":"z1",
            "startTime":1, "startGranularity":"day"
        }))?,
    )
}

fn screen_delete(db: &Database, ids: &[&str], bulk: bool) -> anyhow::Result<Value> {
    screen_delete_in_project(db, PROJECT, ids, bulk)
}

fn screen_delete_in_project(
    db: &Database,
    project: &str,
    ids: &[&str],
    bulk: bool,
) -> anyhow::Result<Value> {
    let context = serde_json::from_value(json!({
        "requestId":"screen", "eventUid":"screen-event", "origin":"human",
        "authorityRoute":"human-direct", "caller":"human-ui",
        "controls":["runtime-policy","actor-context","typed-writer","occ","change-event","change-feed"]
    }))?;
    if bulk {
        let operations: Vec<_> = ids
            .iter()
            .map(|id| json!({"kind":"eventDelete","eventId":id,"baseVersion":1}))
            .collect();
        crate::chronicle_bulk::agent_chronicle_bulk_mutate_with_authority_impl(
            db,
            serde_json::from_value(json!({"projectId":project,"sessionId":"session",
                "surface":"manual","requestId":"screen","operations":operations}))?,
            Some(context),
        )
    } else {
        assert_eq!(ids.len(), 1);
        agent_event_delete_with_authority_impl(
            db,
            AgentEventIdPayload {
                project_id: project.into(),
                session_id: "session".into(),
                surface: Some("manual".into()),
                event_id: ids[0].into(),
                base_version: 1,
            },
            context,
        )
    }
}

mod chronicle_apply_revisions {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/support/chronicle_apply_revisions.rs"
    ));
}

#[test]
fn readers_accept_an_applied_proposal_rejected_by_screen_delete() -> anyhow::Result<()> {
    use crate::narrative_extraction::{
        narrative_extraction_get_run_review_bundle, narrative_extraction_list_scene_proposals,
        nir1_chronicle_index::{
            publish_chronicle_index_build, test_support::Fixture, NirIndexPublishRead,
        },
        ListSceneProposalsPayload, RunRefPayload, SceneProposalChronicleState,
        SceneProposalReviewState,
    };

    let fixture = Fixture::new();
    let db = &fixture.db;
    let project = fixture.project();
    let run = fixture.manifest["runId"].as_str().unwrap();
    let revisions: Vec<String> = serde_json::from_value(fixture.manifest["revisionIds"].clone())?;
    let target = &revisions[0];
    enable_manual_apply_for_test(db);
    chronicle_apply_revisions::prepare_and_apply_revisions(db, project, run, &revisions, "import");
    let (proposal, event): (String, String) = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT proposal_id, applied_entity_id FROM narrative_proposal_applications WHERE revision_id=?1",
            [target], |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    })?;
    let (_, before) = fixture.prepare();
    assert!(before
        .iter()
        .any(|document| &document.revision_id == target));
    screen_delete_in_project(db, project, &[&event], false)?;

    let page = narrative_extraction_list_scene_proposals(
        db,
        ListSceneProposalsPayload {
            project_id: project.into(),
            scene_id: fixture.manifest["s1"].as_str().unwrap().into(),
            cursor: None,
            limit: None,
        },
    )?;
    let item = page
        .items
        .iter()
        .find(|item| item.proposal_id == proposal)
        .expect("deleted event's proposal");
    assert_eq!(&item.revision_id, target);
    assert_eq!(item.review_state, SceneProposalReviewState::Rejected);
    assert_eq!(item.chronicle_state, SceneProposalChronicleState::Applied);

    let bundle = narrative_extraction_get_run_review_bundle(
        db,
        RunRefPayload {
            run_id: run.into(),
            project_id: project.into(),
            chronicle_blocked_discard: None,
        },
    )?;
    let row = bundle["proposals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["proposalId"] == proposal)
        .unwrap();
    assert_eq!(row["status"], "rejected");
    assert_eq!(
        row["latestDecision"]["actorId"],
        "native:event-existence-sync"
    );
    assert_eq!(row["application"]["revisionId"], target.as_str());
    assert_eq!(row["application"]["appliedEntityId"], event);

    let (plan, documents) = fixture.prepare();
    assert!(documents
        .iter()
        .all(|document| &document.revision_id != target));
    let count = documents.len();
    let published =
        publish_chronicle_index_build(db, &fixture.runtime, plan, fixture.outcomes(documents))?;
    assert!(
        matches!(
            published,
            NirIndexPublishRead::Published {
                candidate_count, ..
            } if candidate_count == count
        ),
        "{published:?}"
    );
    Ok(())
}

fn replay(db: &Database, journal: &Value, direction: &str, request: &str) -> anyhow::Result<Value> {
    crate::agent_writes::agent_undo_journal_impl(
        db,
        serde_json::from_value(json!({
            "projectId":PROJECT,"sessionId":"session","journalId":journal["undoJournalId"],
            "requestId":request,"direction":direction,"origin":direction,
            "authorityRoute":"history-replay","caller":"undo-redo-command",
            "controls":["original-transaction","journal-lineage","typed-writer","occ","change-event","change-feed"]
        }))?,
    )
}

#[test]
fn screen_deletes_roll_back_and_retries_return_the_same_receipt() -> anyhow::Result<()> {
    for bulk in [false, true] {
        for imported in [false, true] {
            let db = human_import()?;
            handwritten(&db)?;
            let ids: &[&str] = match (imported, bulk) {
                (false, _) => &["hand"],
                (true, false) => &["event-one"],
                (true, true) => &["hand", "event-one", "event-two"],
            };
            fail_sync(&db)?;
            if imported {
                check_failure(screen_delete(&db, ids, bulk).unwrap_err(), false);
                for id in ids {
                    check_event(&db, id, true)?;
                }
                check_decisions(&db, "one", None)?;
                execute(&db, "DROP TRIGGER fail_sync")?;
            }
            let result = screen_delete(&db, ids, bulk)?;
            assert_eq!(screen_delete(&db, ids, bulk)?, result);
            for id in ids {
                check_event(&db, id, false)?;
            }
            check_decisions(&db, "one", imported.then_some("screen-delete"))?;
            check_decisions(&db, "two", (imported && bulk).then_some("screen-delete"))?;
        }
    }
    Ok(())
}

#[test]
fn replaying_single_and_bulk_deletes_syncs_once_and_only_marks_sync_errors() -> anyhow::Result<()> {
    for bulk in [false, true] {
        let db = human_import()?;
        // Model a pre-X deletion journal: forward deletion left the approval in place.
        execute(
            &db,
            "UPDATE narrative_proposals SET status='held' WHERE id='one'",
        )?;
        let journal = screen_delete(&db, &["event-one"], bulk)?;
        execute(
            &db,
            "UPDATE narrative_proposals SET status='approved' WHERE id='one'",
        )?;
        replay(&db, &journal, "undo", "undo")?;
        fail_sync(&db)?;
        check_failure(replay(&db, &journal, "redo", "redo").unwrap_err(), true);
        check_event(&db, "event-one", true)?;
        check_decisions(&db, "one", None)?;
        execute(&db, "DROP TRIGGER fail_sync")?;
        let receipt = replay(&db, &journal, "redo", "redo")?;
        assert_eq!(receipt, replay(&db, &journal, "redo", "redo")?);
        replay(&db, &journal, "undo", "again-undo")?;
        replay(&db, &journal, "redo", "again-redo")?;
        check_event(&db, "event-one", false)?;
        check_decisions(&db, "one", Some("undo-redo"))?;
        check_decisions(&db, "two", None)?;
        let err = replay(&db, &journal, "redo", "stale-redo").unwrap_err();
        assert!(
            !err.to_string().contains("NEX_EXISTENCE_SYNC_FAILED:"),
            "{err:#}"
        );
    }
    Ok(())
}

#[test]
fn undo_of_an_event_create_uses_only_its_journal_event_id() -> anyhow::Result<()> {
    for has_application in [false, true] {
        let db = human_import()?;
        let journal = handwritten(&db)?;
        if has_application {
            // Import normally has a commit journal. Model an event create journal
            // targeting the same identity as an existing Application.
            execute(&db, "INSERT INTO narrative_proposal_applications
                (id,commit_id,proposal_id,revision_id,applied_entity_kind,applied_entity_id,created_at)
                SELECT 'hand-application',commit_id,proposal_id,revision_id,'event','hand',created_at
                  FROM narrative_proposal_applications WHERE proposal_id='one'")?;
        }
        fail_sync(&db)?;
        if has_application {
            check_failure(replay(&db, &journal, "undo", "undo").unwrap_err(), true);
            check_event(&db, "hand", true)?;
            execute(&db, "DROP TRIGGER fail_sync")?;
        }
        replay(&db, &journal, "undo", "undo")?;
        check_event(&db, "hand", false)?;
        check_decisions(&db, "one", has_application.then_some("undo-redo"))?;
        check_decisions(&db, "two", None)?;
    }
    Ok(())
}

#[test]
fn commit_undo_rolls_back_and_revokes_each_removed_import_once() -> anyhow::Result<()> {
    let db = human_import()?;
    handwritten(&db)?;
    let commit: String = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT id FROM narrative_apply_commits WHERE project_id=?1",
            [PROJECT],
            |r| r.get(0),
        )?)
    })?;
    let undo = || {
        crate::narrative_extraction::narrative_extraction_undo_commit(
            &db,
            serde_json::from_value(json!({"projectId":PROJECT, "sessionId":"session",
                                     "commitId":commit,"requestId":"undo-import"}))?,
        )
    };
    fail_sync(&db)?;
    check_failure(undo().unwrap_err(), false);
    for proposal in ["one", "two"] {
        check_event(&db, &format!("event-{proposal}"), true)?;
        check_decisions(&db, proposal, None)?;
    }
    execute(&db, "DROP TRIGGER fail_sync")?;
    assert_eq!(undo()?, undo()?);
    for proposal in ["one", "two"] {
        check_event(&db, &format!("event-{proposal}"), false)?;
        check_decisions(&db, proposal, Some("commit-undo"))?;
    }
    check_event(&db, "hand", true)?;
    Ok(())
}

#[test]
fn restore_revokes_only_before_minus_after_and_rolls_back_on_failure() -> anyhow::Result<()> {
    use crate::project_snapshots::{
        apply_project_snapshot_restore, build_canonical_restore_plan,
        ApplyProjectSnapshotRestorePayload,
    };
    for keep_two in [false, true] {
        let db = human_import()?;
        let one =
            db.with_conn(|conn| crate::agent_writes::collect_event_snapshot(conn, "event-one"))?;
        // Capture the actual desired snapshot. An already-missing old import
        // must keep its approval, just like an event retained across restore.
        execute(&db, "DELETE FROM events WHERE id='event-one'")?;
        if !keep_two {
            execute(&db, "DELETE FROM events WHERE id='event-two'")?;
        }
        capture_rd6_snapshot(&db, None)?;
        db.with_conn(|conn| {
            crate::agent_writes::apply_event_snapshot(conn, PROJECT, &one, Some(1), true)
        })?;
        handwritten(&db)?;
        let scopes = [RestoreScope::Body];
        let plan = db.with_conn(|conn| {
            build_canonical_restore_plan(conn, PROJECT, "snapshot", &scopes.into_iter().collect())
        })?;
        let payload = ApplyProjectSnapshotRestorePayload {
            project_id: PROJECT.into(),
            session_id: "session".into(),
            request_id: "restore".into(),
            snapshot_id: "snapshot".into(),
            scopes: scopes.to_vec(),
            inserts: plan.inserts,
        };
        let restore = || apply_project_snapshot_restore(&db, payload.clone());
        fail_sync(&db)?;
        check_failure(restore().unwrap_err(), false);
        check_event(&db, "event-one", true)?;
        check_event(&db, "hand", true)?;
        check_decisions(&db, "one", None)?;
        execute(&db, "DROP TRIGGER fail_sync")?;
        let first = restore()?;
        // §5 0 (d): a restore that removes events must not take the no-op branch.
        assert!(!first.no_op);
        assert_eq!(first, restore()?);
        check_event(&db, "event-one", false)?;
        check_event(&db, "hand", false)?;
        check_event(&db, "event-two", keep_two)?;
        check_decisions(&db, "one", Some("snapshot-restore"))?;
        check_decisions(&db, "two", None)?;
    }
    Ok(())
}

use crate::narrative_extraction::{
    narrative_extraction_reapprove_applied_proposals, ChronicleBulkApproveTarget,
    ReapproveAppliedProposalsPayload,
};

fn reapproval_request(
    db: &Database,
    ids: &[&str],
) -> anyhow::Result<ReapproveAppliedProposalsPayload> {
    db.with_conn(|conn| {
        let mut targets = Vec::new();
        for &id in ids {
            let revision = conn
                .query_row(
                    "SELECT current_revision_id FROM narrative_proposals WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or_else(|| "missing-revision".to_owned());
            targets.push(ChronicleBulkApproveTarget {
                proposal_id: id.into(),
                revision_id: revision,
            });
        }
        Ok(ReapproveAppliedProposalsPayload {
            project_id: PROJECT.into(),
            targets,
        })
    })
}

fn reapprove(db: &Database, ids: &[&str]) -> anyhow::Result<Value> {
    narrative_extraction_reapprove_applied_proposals(db, reapproval_request(db, ids)?, &mut || {
        false
    })
}

fn assert_reapproval_skip(result: &Value, proposal: &str, reason: &str) {
    assert_eq!(
        *result,
        json!({
            "approved": [], "skipped": [{"proposalId":proposal,"reasons":[reason]}],
            "failed": [], "stopped": false
        })
    );
}

#[test]
fn reapproval_invalid_requests_write_nothing() -> anyhow::Result<()> {
    let db = human_import()?;
    let journal = screen_delete(&db, &["event-one"], false)?;
    replay(&db, &journal, "undo", "restore")?;
    let valid = reapproval_request(&db, &["one"])?;
    let target = &valid.targets[0];
    let item = json!({"proposalId":target.proposal_id, "revisionId":target.revision_id});
    for invalid in [
        json!({"projectId":PROJECT,"targets":[item],"override":true}),
        json!({"projectId":PROJECT,"targets":[{"proposalId":"one","revisionId":"r","decision":"approved"}]}),
    ] {
        assert!(serde_json::from_value::<ReapproveAppliedProposalsPayload>(invalid).is_err());
    }
    let mut too_many = vec![item.clone()];
    too_many.extend((0..4096).map(|i| json!({"proposalId":format!("p{i}"),"revisionId":"r"})));
    for (project, targets) in [
        (PROJECT, json!([])),
        (PROJECT, json!(too_many)),
        (PROJECT, json!([item, item])),
        (" project-1", json!([item])),
        ("", json!([item])),
        (
            PROJECT,
            json!([item,{"proposalId":"two ","revisionId":"r"}]),
        ),
        (
            PROJECT,
            json!([item,{"proposalId":"two","revisionId":" r"}]),
        ),
        (PROJECT, json!([item,{"proposalId":"","revisionId":"r"}])),
        (PROJECT, json!([item,{"proposalId":"two","revisionId":""}])),
    ] {
        let payload = serde_json::from_value(json!({"projectId":project, "targets":targets}))?;
        let error = narrative_extraction_reapprove_applied_proposals(&db, payload, &mut || false)
            .unwrap_err();
        assert!(error.to_string().starts_with("NEX_REAPPROVE_INVALID:"));
    }
    db.with_conn(|conn| {
        assert_eq!(state(conn, "one")?, ("rejected".into(), 2));
        assert_eq!(state(conn, "two")?, ("approved".into(), 1));
        Ok(())
    })
}

#[test]
fn reapproval_skips_ineligible_targets_without_writing() -> anyhow::Result<()> {
    let db = human_import()?;
    screen_delete(&db, &["event-one"], false)?;
    let mut wrong_project = reapproval_request(&db, &["one"])?;
    wrong_project.project_id = "other".into();
    assert_reapproval_skip(
        &narrative_extraction_reapprove_applied_proposals(&db, wrong_project, &mut || false)?,
        "one",
        "proposal-not-found",
    );
    let mut stale = reapproval_request(&db, &["one"])?;
    stale.targets[0].revision_id = "earlier".into();
    assert_reapproval_skip(
        &narrative_extraction_reapprove_applied_proposals(&db, stale, &mut || false)?,
        "one",
        "revision-changed",
    );
    assert_reapproval_skip(&reapprove(&db, &["two"])?, "two", "already-approved");
    // Even with one live event, every event for this proposal must exist.
    execute(
        &db,
        "INSERT INTO narrative_proposal_applications
        (id,commit_id,proposal_id,revision_id,applied_entity_kind,applied_entity_id,created_at)
        SELECT 'also-present',commit_id,proposal_id,revision_id,'event','event-two',created_at
        FROM narrative_proposal_applications WHERE proposal_id='one'",
    )?;
    assert_reapproval_skip(&reapprove(&db, &["one"])?, "one", "event-missing");
    execute(&db, "INSERT INTO narrative_proposal_decisions
        (id,proposal_id,revision_id,decision,decision_json,created_at,created_by,actor_kind,actor_id,authority_scope)
        SELECT 'later-human-rejection',proposal_id,revision_id,decision,decision_json,'2999-01-01',
               'electron:human-review','human','electron:human-review',authority_scope
          FROM narrative_proposal_decisions WHERE proposal_id='one' AND decision='rejected'")?;
    assert_reapproval_skip(&reapprove(&db, &["one"])?, "one", "not-removal-rejection");
    execute(&db, "INSERT INTO narrative_proposal_applications
        (id,commit_id,proposal_id,revision_id,applied_entity_kind,applied_entity_id,created_at,
         application_kind,compensates_application_id)
        SELECT 'undo-'||id,commit_id,proposal_id,revision_id,'event',applied_entity_id,created_at,'compensation',id
        FROM narrative_proposal_applications WHERE proposal_id='one' AND application_kind='normal'")?;
    assert_reapproval_skip(&reapprove(&db, &["one"])?, "one", "no-application");
    execute(
        &db,
        "INSERT INTO narrative_proposal_applications
        (id,commit_id,proposal_id,revision_id,applied_entity_kind,applied_entity_id,created_at)
        SELECT 'old-import',commit_id,'one',revision_id,'event',applied_entity_id,created_at
        FROM narrative_proposal_applications WHERE proposal_id='two'",
    )?;
    assert_reapproval_skip(&reapprove(&db, &["one"])?, "one", "revision-changed");
    db.with_conn(|conn| {
        assert_eq!(state(conn, "one")?, ("rejected".into(), 3));
        assert_eq!(state(conn, "two")?, ("approved".into(), 1));
        Ok(())
    })
}

#[test]
fn reapproval_writer_judges_the_target_itself() -> anyhow::Result<()> {
    let db = human_import()?;
    screen_delete(&db, &["event-one"], false)?;
    // "one" lost its event and "two" is still approved: calling the writer
    // directly, without the command's judgement, is refused for both.
    let request = reapproval_request(&db, &["one", "two"])?;
    db.with_conn(|conn| {
        for (target, reason) in request
            .targets
            .iter()
            .zip(["event-missing", "already-approved"])
        {
            let tx = conn.unchecked_transaction()?;
            let error = append_event_existence_decisions_in_tx(
                &tx,
                PROJECT,
                EventExistenceChange::Reapproved {
                    target,
                    decision_id: "unverified",
                },
            )
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                format!("NEX_REAPPROVE_NOT_ELIGIBLE: {reason}")
            );
        }
        assert_eq!(state(conn, "one")?, ("rejected".into(), 2));
        assert_eq!(state(conn, "two")?, ("approved".into(), 1));
        Ok(())
    })
}

#[test]
fn reapproval_records_human_authority_and_can_be_revoked_again() -> anyhow::Result<()> {
    let db = human_import()?;
    let journal = screen_delete(&db, &["event-one", "event-two"], true)?;
    replay(&db, &journal, "undo", "restore")?;
    let index = crate::narrative_extraction::nir1_chronicle_index::INDEX_KEY;
    db.with_conn(|conn| {
        conn.execute("INSERT INTO narrative_semantic_index_metadata
            (project_id,index_key,generation,built_at,source_digest,dependency_set_digest,dirty_cache_flag)
            VALUES (?1,?2,1,'2026-01-01','source','deps',0)", params![PROJECT,index])?;
        Ok(())
    })?;
    let result = reapprove(&db, &["one", "absent", "two"])?;
    assert_eq!(
        result["skipped"],
        json!([{"proposalId":"absent","reasons":["proposal-not-found"]}])
    );
    assert_eq!(result["failed"], json!([]));
    assert_eq!(result["stopped"], false);
    assert_eq!(result["approved"].as_array().unwrap().len(), 2);
    db.with_conn(|conn| {
        for (i, proposal) in ["one", "two"].iter().enumerate() {
            let receipt = &result["approved"][i];
            assert_eq!(receipt["proposalId"], *proposal);
            let (raw, rejected): (String, String) = conn.query_row(
                "SELECT d.decision_json, r.id FROM narrative_proposal_decisions d
                   JOIN narrative_proposal_decisions r ON r.proposal_id=d.proposal_id AND r.revision_id=d.revision_id
                    AND r.decision='rejected' AND r.created_at<d.created_at
                  WHERE d.id=?1 AND d.proposal_id=?2 AND d.revision_id=?3 AND d.decision='approved'
                    AND d.actor_kind='human' AND d.actor_id='electron:human-review'
                    AND d.authority_scope=r.authority_scope AND d.override_field_paths_json='[]'",
                params![receipt["decisionId"].as_str().unwrap(), proposal, receipt["revisionId"].as_str().unwrap()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            assert_eq!(serde_json::from_str::<Value>(&raw)?, json!({"cause":"event-reapproved","reapprovesDecisionId":rejected}));
            assert_eq!(state(conn, proposal)?, ("approved".into(), 3));
        }
        let dirty: bool = conn.query_row("SELECT dirty_cache_flag FROM narrative_semantic_index_metadata
            WHERE project_id=?1 AND index_key=?2", params![PROJECT,index], |r| r.get(0))?;
        assert!(dirty);
        Ok(())
    })?;
    assert_reapproval_skip(&reapprove(&db, &["one"])?, "one", "already-approved");
    // The events came back with a new version, so the import itself can no
    // longer be undone (design §3; confirmation 139).
    let commit: String = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT id FROM narrative_apply_commits WHERE project_id=?1",
            [PROJECT],
            |r| r.get(0),
        )?)
    })?;
    let refused = crate::narrative_extraction::narrative_extraction_undo_commit(
        &db,
        serde_json::from_value(json!({"projectId":PROJECT, "sessionId":"session",
                                 "commitId":commit,"requestId":"undo-after-reapproval"}))?,
    )
    .unwrap_err();
    assert!(
        refused.to_string().contains("NEX_COMMIT_EVENT_EDITED"),
        "{refused:#}"
    );
    db.with_conn(|conn| {
        assert_eq!(state(conn, "one")?, ("approved".into(), 3));
        assert_eq!(state(conn, "two")?, ("approved".into(), 3));
        Ok(())
    })?;
    replay(&db, &journal, "redo", "remove-again")?;
    db.with_conn(|conn| {
        assert_eq!(state(conn, "one")?, ("rejected".into(), 4));
        assert_eq!(state(conn, "two")?, ("rejected".into(), 4));
        Ok(())
    })
}

#[test]
fn reapproval_honors_stop_policy_and_rollback() -> anyhow::Result<()> {
    let db = human_import()?;
    let journal = screen_delete(&db, &["event-one", "event-two"], true)?;
    replay(&db, &journal, "undo", "restore")?;
    execute(
        &db,
        "UPDATE narrative_runtime_policy SET runtime_mode='disabled'",
    )?;
    let disabled = reapprove(&db, &["one"])?;
    assert_eq!(
        disabled["failed"],
        json!([{"proposalId":"one","code":"NARRATIVE_ENGINE_DISABLED"}])
    );
    execute(
        &db,
        "UPDATE narrative_runtime_policy SET runtime_mode='manual-apply'",
    )?;
    db.with_conn(|conn| {
        assert_eq!(state(conn, "one")?, ("rejected".into(), 2));
        Ok(())
    })?;
    execute(
        &db,
        "CREATE TEMP TRIGGER fail_status BEFORE UPDATE OF status ON narrative_proposals
        WHEN NEW.id='one' BEGIN SELECT RAISE(ABORT,'write failed'); END",
    )?;
    let result = reapprove(&db, &["one", "two"])?;
    assert_eq!(
        result["failed"],
        json!([{"proposalId":"one","code":"NEX_REAPPROVE_FAILED"}])
    );
    assert_eq!(result["approved"][0]["proposalId"], "two");
    db.with_conn(|conn| {
        assert_eq!(state(conn, "one")?, ("rejected".into(), 2));
        assert_eq!(state(conn, "two")?, ("approved".into(), 3));
        Ok(())
    })?;
    execute(&db, "DROP TRIGGER fail_status")?;
    let mut calls = 0;
    let stopped = narrative_extraction_reapprove_applied_proposals(
        &db,
        reapproval_request(&db, &["one", "two"])?,
        &mut || {
            calls += 1;
            calls == 2
        },
    )?;
    assert_eq!(stopped["approved"].as_array().unwrap().len(), 1);
    assert_eq!(stopped["approved"][0]["proposalId"], "one");
    assert_eq!(stopped["stopped"], true);
    assert_eq!(stopped["skipped"], json!([]));
    assert_eq!(stopped["failed"], json!([]));
    Ok(())
}

fn capture_rd6_snapshot(db: &Database, version: Option<&str>) -> anyhow::Result<()> {
    create_project_snapshot(
        db,
        serde_json::from_value(json!({
            "projectId": PROJECT, "snapshotId": "snapshot", "name": "snapshot",
            "createdAt": "2026-11-25",
            "treeRows": [{"snapshot_id":"snapshot", "node_id":"source", "node_type":"scene",
                          "title":"Scene", "sort_order":"a", "body_version_id":version}],
            "codexRows": [], "snippetRows": [], "versionIds": version.into_iter().collect::<Vec<_>>()
        }))?,
    )
}

fn preview_loss(db: &Database, scope: RestoreScope) -> anyhow::Result<usize> {
    let context =
        project_snapshot_restore_context(db, PROJECT.into(), "snapshot".into(), vec![scope])?;
    Ok(context.approval_loss_count)
}

#[test]
fn restore_approval_loss_matches_new_rejections() -> anyhow::Result<()> {
    use crate::project_snapshots::{
        apply_project_snapshot_restore, build_canonical_restore_plan,
        ApplyProjectSnapshotRestorePayload,
    };
    let db = current_schema_full_db();
    seed_scene(&db, "source");
    capture_rd6_snapshot(&db, None)?;
    import_events(&db, &["one", "two", "three", "four"])?;
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        assert_eq!(revoke(&tx, &["event-one".into()])?, 1);
        tx.commit()?;
        Ok(())
    })?;
    assert_eq!(preview_loss(&db, RestoreScope::Codex)?, 0);
    let count = preview_loss(&db, RestoreScope::Body)?;
    assert_eq!(count, 3);
    let rejections = || {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT count(*) FROM narrative_proposal_decisions WHERE decision='rejected'
               AND actor_id='native:event-existence-sync'
               AND json_extract(decision_json, '$.removedVia')='snapshot-restore'",
                [],
                |r| r.get::<_, i64>(0),
            )? as usize)
        })
    };
    let before = rejections()?;
    assert_eq!(before, 1);
    let scopes = [RestoreScope::Body];
    let plan = db.with_conn(|conn| {
        build_canonical_restore_plan(conn, PROJECT, "snapshot", &scopes.into_iter().collect())
    })?;
    apply_project_snapshot_restore(
        &db,
        ApplyProjectSnapshotRestorePayload {
            project_id: PROJECT.into(),
            session_id: "session".into(),
            request_id: "restore".into(),
            snapshot_id: "snapshot".into(),
            scopes: scopes.to_vec(),
            inserts: plan.inserts,
        },
    )?;
    assert_eq!(rejections()? - before, count);
    Ok(())
}

#[test]
fn restore_approval_loss_skips_retained_and_handwritten() -> anyhow::Result<()> {
    let db = human_import()?;
    capture_rd6_snapshot(&db, None)?;
    assert_eq!(preview_loss(&db, RestoreScope::Body)?, 0);
    handwritten(&db)?;
    assert_eq!(preview_loss(&db, RestoreScope::Body)?, 0);
    Ok(())
}

#[test]
fn restore_approval_loss_skips_missing_events_aux() -> anyhow::Result<()> {
    let db = current_schema_full_db();
    seed_scene(&db, "source");
    capture_rd6_snapshot(&db, None)?;
    import_events(&db, &["one"])?;
    assert_eq!(preview_loss(&db, RestoreScope::Body)?, 1);
    execute(
        &db,
        "DELETE FROM project_snapshot_aux WHERE snapshot_id='snapshot' AND scope='events'",
    )?;
    assert_eq!(preview_loss(&db, RestoreScope::Body)?, 0);
    Ok(())
}

#[test]
#[ignore = "timing with 60 imported events and a large scene"]
fn measure_restore_approval_loss_context() -> anyhow::Result<()> {
    use std::time::Instant;
    let db = current_schema_full_db();
    seed_scene(&db, "source");
    let body = json!({"type":"doc", "content":[{"type":"paragraph", "content":[
        {"type":"text", "text":"本文。".repeat(128 * 1024)}
    ]}]})
    .to_string();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO content_versions
                (id, entity_type, entity_id, content, version_number, snapshot_type, created_at)
             VALUES ('body', 'scene', 'source', ?1, 1, 'manual', '2026-11-25')",
            [&body],
        )?;
        Ok(())
    })?;
    capture_rd6_snapshot(&db, Some("body"))?;
    // 60, not 2,000: Native's append ordinals fail past "az" (it makes "b0"
    // where JS fractional-indexing makes "b00", and rejects "b00"), a
    // separate defect that stops one import of more than ~61 events.
    let proposals: Vec<_> = (0..60).map(|i| format!("proposal-{i}")).collect();
    import_events(
        &db,
        &proposals.iter().map(String::as_str).collect::<Vec<_>>(),
    )?;
    let ids: Vec<_> = proposals.iter().map(|id| format!("event-{id}")).collect();
    for scope in [RestoreScope::Body, RestoreScope::Codex, RestoreScope::Body] {
        let start = Instant::now();
        let context =
            project_snapshot_restore_context(&db, PROJECT.into(), "snapshot".into(), vec![scope])?;
        let elapsed = start.elapsed();
        assert_eq!(
            context.approval_loss_count,
            if scope == RestoreScope::Body { 60 } else { 0 }
        );
        assert_eq!(context.content_rows[0].content.len(), body.len());
        eprintln!("context {scope:?}, {} body bytes: {elapsed:?}", body.len());
    }
    db.with_conn(|conn| {
        let start = Instant::now();
        let count = count_removed_event_proposals(conn, PROJECT, &ids)?;
        eprintln!(
            "count only, {} applications: {:?}",
            ids.len(),
            start.elapsed()
        );
        assert_eq!(count, 60);
        Ok(())
    })
}
