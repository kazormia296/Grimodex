use super::*;
use crate::agent_writes::{
    agent_event_delete_with_authority_impl, agent_event_delete_with_request_impl,
    AgentEventIdPayload,
};
use crate::narrative_extraction::{
    narrative_extraction_apply_commit, narrative_extraction_prepare_commit,
};

const PROJECT: &str = "project-1";

/// Two separate approvals and Applications, sharing one real Prepare/Apply transaction.
fn human_import() -> anyhow::Result<Database> {
    let db = current_schema_full_db();
    enable_manual_apply_for_test(&db);
    create_run_with_task(&db, "existence-run", "existence-task");
    seed_scene(&db, "source");
    let mut envelope = scene_body_envelope(&db, "existence-run", "existence-task", "source");
    envelope["changeKind"] = json!("add");
    let mut seeds = Vec::new();
    for id in ["one", "two"] {
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
        &db,
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
            &db,
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
        &db,
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
        &db,
        ApplyCommitPayload {
            project_id: PROJECT.into(),
            prepared_commit_id: prepared["preparedCommitId"].as_str().unwrap().into(),
            request_id: "import".into(),
            session_id: "session".into(),
            expected_version: prepared["version"].as_i64(),
        },
    )?;
    Ok(db)
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
    let source = include_str!("repository.rs");
    let start = source.find("fn append_decision_on_conn(").unwrap();
    let end = source[start..]
        .find("\n#[derive(Clone, Copy, serde::Serialize)]")
        .unwrap()
        + start;
    assert_eq!(
        hex::encode(Sha256::digest(&source.as_bytes()[start..end])),
        "a47bd72dc0a5d379a248eccaff9fafe3493b481f366f985fc1b3c410ea4e2b4a"
    );
    // The ownership validator rejects unregistered files. Inspect the other
    // registered writers too, since they can legitimately mutate related tables.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let registry =
        std::fs::read_to_string(root.join("scripts/quality/validate-native-writer-ownership.mjs"))
            .unwrap();
    let (_, registry) = registry.split_once("\"narrative.authority\": [").unwrap();
    let (files, _) = registry.split_once("],").unwrap();
    let mut found_repository = false;
    for file in files
        .lines()
        .filter_map(|line| line.trim().strip_prefix('"')?.strip_suffix("\","))
    {
        if file == "src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs" {
            found_repository = true;
            continue;
        }
        let contents = std::fs::read_to_string(root.join(file)).unwrap();
        let production = contents.split("#[cfg(test)]\nmod ").next().unwrap();
        let sql = production
            .to_ascii_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(!sql.contains("into narrative_proposal_decisions"), "{file}");
    }
    assert!(found_repository);
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
