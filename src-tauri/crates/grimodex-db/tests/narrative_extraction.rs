use chrono::{Duration, Utc};
use grimodex_db::narrative_extraction::{
    self, ensure_test_schema, AppendDecisionPayload, AppendRevisionPayload, ApplyCommitPayload,
    ClaimTaskPayload, CommitApplicationRef, CommitOperation, CreateRunPayload, CreateTaskSeed,
    FinishTaskPayload, GetCommitStatusPayload, ListResumableRunsPayload, PrepareCommitPayload,
    ProposalSeed, ReviseAndDecidePayload, RunRefPayload, SaveProposalSetPayload, UndoCommitPayload,
};
use grimodex_db::{
    load_narrative_runtime_policy_from_db, set_narrative_runtime_policy, Database,
    SetNarrativeRuntimePolicyInput,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn rfc3339_millis(dt: chrono::DateTime<Utc>) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn create_run_with_task(db: &Database, run_id: &str, task_id: &str) {
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: format!("spec-{run_id}"),
            snapshot_digest: Some("revision-1".to_string()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(task_id.to_string()),
                task_kind: "extract_window".to_string(),
                input_json: Some(json!({ "windowId": "w-1" })),
                priority: None,
            }],
        },
    )
    .expect("create run");
}

fn claim_with_owner(db: &Database, run_id: &str, lease_owner: &str, lease_secs: i64) -> Value {
    narrative_extraction::narrative_extraction_claim_task(
        db,
        ClaimTaskPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            lease_owner: lease_owner.to_string(),
            lease_duration_secs: Some(lease_secs),
            task_kinds: None,
        },
    )
    .expect("claim task")
}

fn set_task_lease_expires_at(db: &Database, task_id: &str, lease_expires_at: &str) {
    db.execute(
        "UPDATE narrative_extraction_tasks
            SET lease_expires_at = ?
          WHERE id = ?",
        &[
            Value::String(lease_expires_at.to_string()),
            Value::String(task_id.to_string()),
        ],
        "run",
    )
    .expect("set lease_expires_at");
}

fn cancellation_ledger_state(db: &Database, run_id: &str) -> Value {
    db.with_conn(|conn| {
        let run = conn.query_row(
            "SELECT status, completed_at, version
               FROM narrative_extraction_runs
              WHERE id = ?1",
            [run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )?;
        let tasks = conn
            .prepare(
                "SELECT id, status, lease_owner, lease_expires_at, heartbeat_at,
                        completed_at, version
                   FROM narrative_extraction_tasks
                  WHERE run_id = ?1
                  ORDER BY id ASC",
            )?
            .query_map([run_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let attempts = conn
            .prepare(
                "SELECT attempt.id, attempt.status, attempt.completed_at,
                        attempt.error_message, attempt.failure_code,
                        attempt.retry_disposition, attempt.policy_version,
                        attempt.next_attempt_at, attempt.output_json
                   FROM narrative_extraction_attempts attempt
                   JOIN narrative_extraction_tasks task ON task.id = attempt.task_id
                  WHERE task.run_id = ?1
                  ORDER BY attempt.id ASC",
            )?
            .query_map([run_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(json!({
            "run": run,
            "tasks": tasks,
            "attempts": attempts,
        }))
    })
    .expect("load cancellation ledger state")
}

fn test_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.with_conn(|conn| {
        conn.execute(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'p')",
            [],
        )?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
            [],
        )?;
        ensure_test_schema(conn)
    })
    .expect("seed narrative extraction schema");
    db
}

fn migrated_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate");
    db.execute(
        "INSERT INTO projects (id, title) VALUES (?, 'Project')",
        &[Value::String("project-1".to_string())],
        "run",
    )
    .expect("insert project");
    db
}

fn test_envelope(run_id: &str, task_id: &str) -> Value {
    test_envelope_with_anchors(run_id, task_id, &["anchor:one".to_string()], false)
}

fn test_envelope_with_anchors(
    run_id: &str,
    task_id: &str,
    anchor_ids: &[String],
    reverse_evidence_rows: bool,
) -> Value {
    let source_key = format!("snapshot:{run_id}");
    let read_set = json!([{
        "inputRef": source_key,
        "kind": "snapshot-document",
        "revisionToken": "revision-1"
    }]);
    let evidence_indexes: Vec<usize> = if reverse_evidence_rows {
        (0..anchor_ids.len()).rev().collect()
    } else {
        (0..anchor_ids.len()).collect()
    };
    let evidence_set = evidence_indexes
        .into_iter()
        .map(|index| {
            let quote = format!("sealed evidence {index}");
            json!({
                "evidenceRef": anchor_ids[index],
                "documentRef": "D000001",
                "sourceKey": source_key,
                "revisionToken": "revision-1",
                "quote": quote,
                "quoteDigest": format!("sha256:{}", hex::encode(Sha256::digest(quote.as_bytes()))),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "schemaVersion": 1,
        "runId": run_id,
        "taskId": task_id,
        "reconcilerId": "test.reconciler",
        "reconcilerVersion": "1.0.0",
        "proposalSchemaId": "narrative.test",
        "proposalSchemaVersion": "1",
        "sourceBasis": [{
            "sourceKind": "snapshot-document",
            "sourceKey": source_key,
            "revisionToken": "revision-1"
        }],
        "evidenceSet": evidence_set,
        "readSet": read_set,
        "readSetDigest": format!("sha256:{}", narrative_extraction::digest_plan(&read_set)),
        "changeKind": "add"
    })
}

fn insert_scene(db: &Database, scene_id: &str, version: i64) {
    db.execute(
        "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order, version)
         VALUES (?, 'project-1', 'scene', 'Scene', '{}', 'a0', ?)",
        &[
            Value::String(scene_id.to_string()),
            Value::Number(version.into()),
        ],
        "run",
    )
    .expect("insert scene");
}

fn event_create_payload(event_id: &str, title: &str, scene_id: &str, version: i64) -> Value {
    json!({
        "eventId": event_id,
        "title": title,
        "note": null,
        "kind": "generic",
        "precision": "unknown",
        "placement": { "mode": "append-tail", "afterOrdinal": null },
        "secret": false,
        "revealSceneId": scene_id,
        "evidenceSceneLinks": [{
            "sceneId": scene_id,
            "expectedSceneVersion": version,
            "evidenceAnchorIds": ["anchor:one"]
        }],
        "detail": null,
        "primaryCodexId": null,
        "locationCodexId": null,
        "participants": [],
        "startTime": null,
        "endTime": null,
        "startGranularity": "none",
        "endGranularity": "none",
        "semanticType": "event"
    })
}

fn seed_proposals(
    db: &Database,
    run_id: &str,
    proposal_set_id: &str,
    payloads: &[Value],
) -> Vec<(String, String)> {
    seed_proposal_rows(
        db,
        run_id,
        proposal_set_id,
        payloads,
        "chronicle.event.create@1",
    )
}

fn current_chronicle_plan_proposal(operation_payload: &Value) -> Value {
    let evidence_anchor_ids = operation_payload
        .pointer("/evidenceSceneLinks/0/evidenceAnchorIds")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let mut proposal = json!({
        "eventId": operation_payload["eventId"],
        "title": operation_payload["title"],
        "note": operation_payload["note"],
        "actuality": "actual",
        "significance": "scene-level",
        "evidenceAnchorIds": evidence_anchor_ids,
        "evidenceDocumentRefs": ["D000001"],
        "disclosure": {
            "secret": operation_payload["secret"],
            "revealDocumentRef": "D000001",
        },
        "unresolvedMetadata": {
            "participantSurfaces": [],
            "locationSurface": null,
            "temporalExpressions": [],
        },
    });
    if let Some(semantic_type) = operation_payload.get("semanticType") {
        proposal["semanticType"] = semantic_type.clone();
    }
    proposal
}

fn current_chronicle_envelope(run_id: &str, task_id: &str, operation_payload: &Value) -> Value {
    let anchor_ids = operation_payload
        .pointer("/evidenceSceneLinks/0/evidenceAnchorIds")
        .and_then(Value::as_array)
        .expect("current Chronicle operation evidence anchors")
        .iter()
        .map(|anchor| {
            anchor
                .as_str()
                .expect("current Chronicle operation evidence anchor string")
                .to_string()
        })
        .collect::<Vec<_>>();
    let mut envelope = test_envelope_with_anchors(run_id, task_id, &anchor_ids, true);
    let snapshot_digest = current_chronicle_snapshot_payload(run_id)["snapshot"]["digest"]
        .as_str()
        .expect("current Snapshot digest")
        .to_string();
    envelope["sourceBasis"][0]["revisionToken"] = json!(snapshot_digest);
    envelope["readSet"][0]["revisionToken"] = json!(snapshot_digest);
    for evidence in envelope["evidenceSet"]
        .as_array_mut()
        .expect("current Envelope evidenceSet")
    {
        evidence["revisionToken"] = json!(snapshot_digest);
    }
    envelope["readSetDigest"] = json!(grimodex_core::canonical_json_digest(&envelope["readSet"])
        .expect("current Envelope read-set digest"));
    envelope
}

fn seed_current_chronicle_proposals(
    db: &Database,
    run_id: &str,
    proposal_set_id: &str,
    operation_payloads: &[Value],
) -> Vec<(String, String)> {
    let plan_proposals = operation_payloads
        .iter()
        .map(current_chronicle_plan_proposal)
        .collect::<Vec<_>>();
    let envelopes = operation_payloads
        .iter()
        .map(|operation| {
            let anchor_ids = operation
                .pointer("/evidenceSceneLinks/0/evidenceAnchorIds")
                .and_then(Value::as_array)
                .expect("current Chronicle operation evidence anchors")
                .iter()
                .map(|anchor| {
                    anchor
                        .as_str()
                        .expect("current Chronicle operation evidence anchor string")
                        .to_string()
                })
                .collect::<Vec<_>>();
            test_envelope_with_anchors(run_id, &format!("{run_id}-task"), &anchor_ids, true)
        })
        .collect::<Vec<_>>();
    seed_proposal_rows_with_envelopes(
        db,
        run_id,
        proposal_set_id,
        &plan_proposals,
        "chronicle.create-event@1",
        Some(&envelopes),
    )
}

fn seed_proposal_rows(
    db: &Database,
    run_id: &str,
    proposal_set_id: &str,
    payloads: &[Value],
    proposal_kind: &str,
) -> Vec<(String, String)> {
    seed_proposal_rows_with_envelopes(db, run_id, proposal_set_id, payloads, proposal_kind, None)
}

fn seed_proposal_rows_with_envelopes(
    db: &Database,
    run_id: &str,
    proposal_set_id: &str,
    payloads: &[Value],
    proposal_kind: &str,
    envelopes: Option<&[Value]>,
) -> Vec<(String, String)> {
    assert!(envelopes.is_none_or(|rows| rows.len() == payloads.len()));
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec".to_string(),
            snapshot_digest: Some("revision-1".to_string()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(format!("{run_id}-task")),
                task_kind: "extract_window".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create run");

    let proposals: Vec<ProposalSeed> = payloads
        .iter()
        .enumerate()
        .map(|(index, payload)| ProposalSeed {
            proposal_id: Some(format!("{run_id}-prop-{index}")),
            proposal_key: format!(
                "{}:{index}",
                payload["eventId"]
                    .as_str()
                    .expect("Chronicle test Proposal requires eventId")
            ),
            kind: proposal_kind.to_string(),
            payload_json: payload.clone(),
            reconciliation_envelope: Some(
                envelopes
                    .map(|rows| rows[index].clone())
                    .unwrap_or_else(|| test_envelope(run_id, &format!("{run_id}-task"))),
            ),
        })
        .collect();

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some(proposal_set_id.to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals,
        },
    )
    .expect("save proposal set");

    saved["proposals"]
        .as_array()
        .expect("proposals")
        .iter()
        .map(|proposal| {
            (
                proposal["proposalId"].as_str().unwrap().to_string(),
                proposal["revisionId"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn decide_current_chronicle_proposal(
    db: &Database,
    run_id: &str,
    proposal: &mut (String, String),
    operation_payload: &Value,
    decision: &str,
) {
    if decision == "approved" {
        append_current_chronicle_revision(db, run_id, proposal, operation_payload);
    }
    decide_proposal(db, run_id, proposal, decision);
}

fn append_current_chronicle_revision(
    db: &Database,
    run_id: &str,
    proposal: &mut (String, String),
    operation_payload: &Value,
) {
    let revised = narrative_extraction::narrative_extraction_append_revision(
        db,
        AppendRevisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal.0.clone(),
            payload_json: current_chronicle_plan_proposal(operation_payload),
            reconciliation_envelope: Some(current_chronicle_envelope(
                run_id,
                &format!("{run_id}-task"),
                operation_payload,
            )),
            inherit_reconciliation_envelope: None,
            expected_current_revision_id: proposal.1.clone(),
            created_by: Some("test".to_string()),
        },
    )
    .expect("append compiled current Chronicle revision");
    proposal.1 = revised["revisionId"]
        .as_str()
        .expect("compiled current Chronicle revision id")
        .to_string();
}

fn append_decision(
    db: &Database,
    run_id: &str,
    proposal: &(String, String),
    decision: &str,
    decision_json: Option<Value>,
) -> anyhow::Result<Value> {
    narrative_extraction::narrative_extraction_append_human_decision(
        db,
        AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal.0.clone(),
            revision_id: proposal.1.clone(),
            decision: decision.to_string(),
            decision_json,
            created_by: Some("test".to_string()),
        },
    )
}

fn seed_approved_proposals(
    db: &Database,
    run_id: &str,
    proposal_set_id: &str,
    payloads: &[Value],
) -> Vec<(String, String)> {
    let pairs = seed_proposals(db, run_id, proposal_set_id, payloads);
    for (proposal_id, revision_id) in &pairs {
        narrative_extraction::narrative_extraction_append_human_decision(
            db,
            AppendDecisionPayload {
                run_id: run_id.to_string(),
                project_id: "project-1".to_string(),
                proposal_id: proposal_id.clone(),
                revision_id: revision_id.clone(),
                decision: "approved".to_string(),
                decision_json: None,
                created_by: Some("test".to_string()),
            },
        )
        .expect("approve");
    }
    pairs
}

fn decide_proposal(db: &Database, run_id: &str, proposal: &(String, String), decision: &str) {
    narrative_extraction::narrative_extraction_append_human_decision(
        db,
        AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal.0.clone(),
            revision_id: proposal.1.clone(),
            decision: decision.to_string(),
            decision_json: None,
            created_by: Some("test".to_string()),
        },
    )
    .unwrap_or_else(|error| panic!("{decision} Proposal {}: {error:#}", proposal.0));
}

fn enable_manual_apply(db: &Database) {
    let before = load_narrative_runtime_policy_from_db(db).expect("policy");
    set_narrative_runtime_policy(
        db,
        SetNarrativeRuntimePolicyInput {
            expected_version: before.version,
            runtime_mode: "manual-apply".into(),
            maintenance_enabled: false,
            generic_import_enabled: false,
            background_ai_enabled: false,
        },
    )
    .expect("set manual-apply");
}

fn prepare_and_apply(db: &Database, prepare: PrepareCommitPayload) -> Value {
    enable_manual_apply(db);
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(db, prepare.clone())
        .expect("prepare");
    let prepared_commit_id = prepared["preparedCommitId"]
        .as_str()
        .expect("id")
        .to_string();
    let version = prepared["version"].as_i64();
    narrative_extraction::narrative_extraction_apply_commit(
        db,
        ApplyCommitPayload {
            project_id: prepare.project_id.clone(),
            prepared_commit_id,
            request_id: prepare.request_id.clone(),
            session_id: prepare.session_id.clone(),
            expected_version: version,
        },
    )
    .expect("apply")
}

fn build_prepare(
    request_id: &str,
    plan_digest: &str,
    proposal_set_id: &str,
    run_id: &str,
    ops: Vec<(String, String, Value)>,
) -> PrepareCommitPayload {
    let operations: Vec<CommitOperation> = ops
        .iter()
        .map(|(proposal_id, revision_id, payload)| CommitOperation {
            kind: "chronicle.event.create".to_string(),
            payload: payload.clone(),
            proposal_id: proposal_id.clone(),
            revision_id: revision_id.clone(),
        })
        .collect();
    let applications: Vec<CommitApplicationRef> = ops
        .iter()
        .map(|(proposal_id, revision_id, _)| CommitApplicationRef {
            proposal_id: proposal_id.clone(),
            revision_id: revision_id.clone(),
        })
        .collect();
    PrepareCommitPayload {
        project_id: "project-1".to_string(),
        run_id: run_id.to_string(),
        proposal_set_id: proposal_set_id.to_string(),
        request_id: request_id.to_string(),
        plan_digest: plan_digest.to_string(),
        session_id: "sess-commit".to_string(),
        surface: Some("narrative-extraction".to_string()),
        operations,
        applications,
        expected_tail_ordinal: None,
        entity_bindings: vec![],
        expected_calendar_version: None,
    }
}

fn seal_run_as_current_chronicle(db: &Database, run_id: &str) {
    seal_run_as_current_chronicle_with_matches(db, run_id, &[]);
}

fn current_chronicle_proposal_set_id(run_id: &str) -> String {
    format!("chronicle-plan-proposals:{run_id}:{run_id}-task")
}

fn current_chronicle_snapshot_payload(run_id: &str) -> Value {
    let projection = json!({
        "schemaVersion": 1,
        "unit": "utf16",
        "canonicalLength": 0,
        "segments": [],
    });
    let origin = json!({
        "kind": "project-node",
        "projectId": "project-1",
        "nodeId": "scene-1",
        "sourceVersion": 0,
        "sourceUpdatedAt": "2026-08-26T00:00:00.000Z",
        "sourceUri": null,
    });
    let content_digest = grimodex_core::canonical_json_digest(&json!({
        "normalizerVersion": "gdx-canonical-text/1",
        "text": "",
    }))
    .expect("seal current Snapshot content");
    let document_digest = grimodex_core::canonical_json_digest(&json!({
        "normalizerVersion": "gdx-canonical-text/1",
        "parentSourceKey": null,
        "title": "Scene 1",
        "orderIndex": 0,
        "canonical": { "text": "", "blocks": [] },
    }))
    .expect("seal current Snapshot document");
    let artifact_digest = grimodex_core::canonical_json_digest(&json!({
        "schemaVersion": 1,
        "normalizerVersion": "gdx-canonical-text/1",
        "sourceKey": "project:scene:scene-1",
        "parentSourceKey": null,
        "semanticDigest": document_digest,
        "contentDigest": content_digest,
        "projection": projection,
        "origin": origin,
    }))
    .expect("seal current Snapshot document artifact");
    let document = json!({
        "ref": "D000001",
        "sourceKey": "project:scene:scene-1",
        "parentRef": null,
        "title": "Scene 1",
        "orderIndex": 0,
        "canonical": {
            "unit": "utf16",
            "text": "",
            "blocks": [],
            "projection": projection,
            "projectionMap": projection,
            "diagnostics": [],
        },
        "contentDigest": content_digest,
        "documentDigest": document_digest,
        "artifactDigest": artifact_digest,
        "origin": origin,
    });
    let omissions = json!([]);
    let snapshot_digest = grimodex_core::canonical_json_digest(&json!({
        "schemaVersion": 1,
        "language": "ja",
        "normalizerVersion": "gdx-canonical-text/1",
        "documentDigests": [document["documentDigest"].clone()],
        "omissions": omissions,
    }))
    .expect("seal current Snapshot");
    let snapshot_artifact_digest = grimodex_core::canonical_json_digest(&json!({
        "schemaVersion": 1,
        "normalizerVersion": "gdx-canonical-text/1",
        "semanticDigest": snapshot_digest,
        "originProjectId": "project-1",
        "documents": [{
            "sourceKey": document["sourceKey"].clone(),
            "artifactDigest": document["artifactDigest"].clone(),
        }],
        "omissions": omissions,
    }))
    .expect("seal current Snapshot artifact");
    let source_view_digest = grimodex_core::canonical_json_digest(&json!({
        "schemaVersion": 1,
        "ref": "SV000001",
        "documentRef": "D000001",
        "documentArtifactDigest": document["artifactDigest"].clone(),
        "documentRange": { "start": 0, "end": 0 },
        "text": "",
    }))
    .expect("seal current Source View");
    json!({
        "snapshot": {
            "schemaVersion": 1,
            "id": format!("snapshot:{run_id}"),
            "snapshotId": format!("snapshot:{run_id}"),
            "createdAt": "2026-08-26T00:00:00.000Z",
            "language": "ja",
            "normalizerVersion": "gdx-canonical-text/1",
            "digest": snapshot_digest,
            "artifactDigest": snapshot_artifact_digest,
            "origin": { "kind": "grimodex-project", "projectId": "project-1" },
            "documents": [document],
            "omissions": omissions,
        },
        "sourceViews": [{
            "ref": "SV000001",
            "documentRef": "D000001",
            "documentRange": { "start": 0, "end": 0 },
            "text": "",
            "digest": source_view_digest,
        }],
        "scopeAuthorityDocuments": [{
            "documentRef": "D000001",
            "sourceKey": "project:scene:scene-1",
            "rawStoryKey": null,
        }],
        "existingEventsCatalog": {
            "kind": "chronicle.existing-events-catalog@1",
            "events": [],
        },
    })
}

fn seal_run_as_current_chronicle_with_matches(db: &Database, run_id: &str, matches: &[Value]) {
    let catalog = json!({
        "kind": "chronicle.existing-events-catalog@1",
        "events": [],
    });
    let catalog_digest = format!("sha256:{}", narrative_extraction::digest_plan(&catalog));
    let snapshot_payload = current_chronicle_snapshot_payload(run_id);
    let snapshot_digest = snapshot_payload["snapshot"]["digest"]
        .as_str()
        .expect("current Snapshot digest")
        .to_string();
    let spec = json!({
        "kind": "chronicle.extract.run-spec@2",
        "domain": "chronicle",
        "version": 2,
        "taskChain": [
            "source.snapshot@1",
            "source.window-plan@1",
            "chronicle.observe-events@1",
            "evidence.resolve@1",
            "chronicle.merge-local-observations@1",
            "chronicle.cluster-event-observations@1",
            "chronicle.synthesize-event@1",
            "chronicle.match-existing-events@1",
            "chronicle.plan-proposals@1",
        ],
        "executionMode": "deterministic-fallback",
        "existingEventsCatalogDigest": catalog_digest,
        "coordinatorContractDigest": format!("sha256:{}", "b".repeat(64)),
    });
    let spec_digest = format!("sha256:{}", narrative_extraction::digest_plan(&spec));
    db.with_conn(|conn| {
        let (proposal_set_id, task_id): (String, String) = conn.query_row(
            "SELECT proposal_set.id, task.id
               FROM narrative_proposal_sets proposal_set
               JOIN narrative_extraction_tasks task ON task.run_id = proposal_set.run_id
              WHERE proposal_set.run_id = ?1
              ORDER BY task.id ASC
              LIMIT 1",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        anyhow::ensure!(
            proposal_set_id == current_chronicle_proposal_set_id(run_id),
            "test current Chronicle ProposalSet does not use its deterministic Run/Task id"
        );
        let mut statement = conn.prepare(
            "SELECT revision.payload_json
               FROM narrative_proposals proposal
               JOIN narrative_proposal_revisions revision
                 ON revision.proposal_id = proposal.id
                AND revision.revision_number = 1
              WHERE proposal.proposal_set_id = ?1
              ORDER BY proposal.id ASC",
        )?;
        let proposals = statement
            .query_map([proposal_set_id.as_str()], |row| {
                let payload: String = row.get(0)?;
                serde_json::from_str::<Value>(&payload).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        payload.len(),
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        anyhow::ensure!(
            matches.is_empty() || matches.len() == proposals.len(),
            "test match roster differs from ProposalSet"
        );
        let planned = proposals
            .iter()
            .enumerate()
            .map(|(index, proposal)| {
                json!({
                    "proposal": proposal,
                    "match": matches.get(index).cloned().unwrap_or_else(|| json!({ "status": "none" })),
                    "hypothesisId": format!("hypothesis:{index}"),
                })
            })
            .collect::<Vec<_>>();
        let artifact = json!({
            "proposalSetId": proposal_set_id,
            "proposals": proposals,
            "planned": planned,
        });
        let artifact_digest = grimodex_core::canonical_json_digest(&artifact)?;
        conn.execute(
            "INSERT INTO narrative_extraction_artifacts
                (id, run_id, task_id, attempt_id, artifact_kind,
                 payload_storage, payload_json, payload_ref, payload_digest, created_at)
             VALUES (?1, ?2, ?3, ?4, 'chronicle.proposal-plan@1',
                     'inline-json', ?5, NULL, ?6, '2026-08-26T00:00:00.000Z')",
            rusqlite::params![
                format!("artifact-plan-{run_id}"),
                run_id,
                task_id,
                format!("attempt-plan-{run_id}"),
                artifact.to_string(),
                artifact_digest,
            ],
        )?;
        let (set_kind, summary_json): (String, String) = conn.query_row(
            "SELECT set_kind, summary_json
               FROM narrative_proposal_sets
              WHERE id = ?1 AND run_id = ?2 AND project_id = 'project-1'",
            rusqlite::params![proposal_set_id, run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut summary: Value = serde_json::from_str(&summary_json)?;
        let mut manifest_statement = conn.prepare(
            "SELECT proposal.proposal_key, proposal.kind, revision.payload_json,
                    revision.reconciliation_envelope_json,
                    revision.reconciliation_envelope_digest
               FROM narrative_proposals proposal
               JOIN narrative_proposal_revisions revision
                 ON revision.proposal_id = proposal.id
                AND revision.revision_number = 1
              WHERE proposal.proposal_set_id = ?1
              ORDER BY proposal.proposal_key ASC",
        )?;
        let manifest_proposals = manifest_statement
            .query_map([proposal_set_id.as_str()], |row| {
                let payload_json: String = row.get(2)?;
                let envelope_json: Option<String> = row.get(3)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    payload_json,
                    envelope_json,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(
                |(proposal_key, kind, payload_json, envelope_json, envelope_digest)| {
                    Ok::<_, anyhow::Error>(json!({
                        "proposalKey": proposal_key,
                        "kind": kind,
                        "payloadJson": serde_json::from_str::<Value>(&payload_json)?,
                        "reconciliationEnvelope": envelope_json
                            .as_deref()
                            .map(serde_json::from_str::<Value>)
                            .transpose()?,
                        "reconciliationEnvelopeDigest": envelope_digest,
                    }))
                },
            )
            .collect::<anyhow::Result<Vec<_>>>()?;
        let attempt_id = format!("attempt-plan-{run_id}");
        let manifest = json!({
            "kind": "chronicle.plan-proposal-set-manifest@1",
            "version": 1,
            "projectId": "project-1",
            "runId": run_id,
            "taskId": task_id,
            "attemptId": attempt_id,
            "proposalSetId": proposal_set_id,
            "setKind": set_kind,
            "summaryJson": summary,
            "proposalPlanArtifactDigest": artifact_digest,
            "proposals": manifest_proposals,
        });
        let manifest_digest = grimodex_core::canonical_json_digest(&manifest)?;
        summary
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("test ProposalSet summary is not an object"))?
            .insert(
                "chroniclePlanTaskBinding".to_string(),
                json!({
                    "kind": "chronicle.plan-proposal-set-binding@1",
                    "version": 1,
                    "taskId": task_id,
                    "attemptId": attempt_id,
                    "proposalSetId": proposal_set_id,
                    "proposalManifestDigest": manifest_digest,
                }),
            );
        conn.execute(
            "UPDATE narrative_proposal_sets
                SET summary_json = ?1, version = version + 1
              WHERE id = ?2 AND run_id = ?3 AND project_id = 'project-1'",
            rusqlite::params![summary.to_string(), proposal_set_id, run_id],
        )?;
        let plan_output = json!({
            "proposalSetId": proposal_set_id,
            "proposalCount": manifest["proposals"]
                .as_array()
                .map(Vec::len)
                .unwrap_or_default(),
        });
        conn.execute(
            "UPDATE narrative_extraction_tasks
                SET task_kind = 'chronicle.plan-proposals@1', status = 'completed',
                    output_json = ?1, attempt_count = 1,
                    started_at = '2026-08-25T23:59:59.000Z',
                    completed_at = '2026-08-26T00:00:00.000Z'
              WHERE id = ?2 AND run_id = ?3",
            rusqlite::params![
                plan_output.to_string(),
                task_id,
                run_id,
            ],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_attempts
                (id, task_id, attempt_number, status, started_at, completed_at, output_json)
             VALUES (?1, ?2, 1, 'completed', '2026-08-25T23:59:59.000Z',
                     '2026-08-26T00:00:00.000Z', ?3)",
            rusqlite::params![attempt_id, task_id, plan_output.to_string()],
        )?;
        let snapshot_task_id = format!("{run_id}-snapshot-task");
        let snapshot_attempt_id = format!("{run_id}-snapshot-attempt");
        let scope_authority = grimodex_core::narrative_scope_authority_basis::build_narrative_scope_authority_basis_v2(
            "project-1",
            run_id,
            &snapshot_digest,
            &[grimodex_core::narrative_scope_authority_basis::NarrativeScopeAuthorityDocumentInputV2 {
                document_ref: "D000001".to_string(),
                source_key: "project:scene:scene-1".to_string(),
                raw_story_key: None,
            }],
        )?;
        let snapshot_output = json!({
            "snapshotDigest": snapshot_digest,
            "documentCount": 1,
            "corpusPayloadDigest": grimodex_core::canonical_json_digest(&snapshot_payload)?,
            "scopeAuthorityCompositeDigest": scope_authority.digests.composite_digest,
        });
        conn.execute(
            "INSERT INTO narrative_extraction_tasks
                (id, run_id, task_kind, status, input_json, output_json,
                 priority, attempt_count, created_at, started_at, completed_at, version)
             VALUES (?1, ?2, 'source.snapshot@1', 'completed', '{}', ?3,
                     100, 1, '2026-08-26T00:00:00.000Z',
                     '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:01.000Z', 0)",
            rusqlite::params![snapshot_task_id, run_id, snapshot_output.to_string()],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_attempts
                (id, task_id, attempt_number, status, started_at, completed_at, output_json)
             VALUES (?1, ?2, 1, 'completed', '2026-08-26T00:00:00.000Z',
                     '2026-08-26T00:00:01.000Z', ?3)",
            rusqlite::params![
                snapshot_attempt_id,
                snapshot_task_id,
                snapshot_output.to_string(),
            ],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_artifacts
                (id, run_id, task_id, attempt_id, artifact_kind,
                 payload_storage, payload_json, payload_ref, payload_digest, created_at)
             VALUES (?1, ?2, ?3, ?4, 'source.snapshot@1',
                     'inline-json', ?5, NULL, ?6, '2026-08-26T00:00:01.000Z')",
            rusqlite::params![
                format!("{run_id}-snapshot-artifact"),
                run_id,
                snapshot_task_id,
                snapshot_attempt_id,
                snapshot_payload.to_string(),
                grimodex_core::canonical_json_digest(&snapshot_payload)?,
            ],
        )?;
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET spec_json = ?1, spec_digest = ?2, catalog_digest = ?3,
                    snapshot_digest = ?4, scope_json = ?5
              WHERE id = ?6 AND project_id = 'project-1'",
            rusqlite::params![
                spec.to_string(),
                spec_digest,
                catalog_digest,
                snapshot_digest,
                json!({ "folderId": "folder-1", "sceneIds": ["scene-1"] }).to_string(),
                run_id,
            ],
        )?;
        Ok(())
    })
    .expect("seal current Chronicle Run spec, plan artifact, and empty Event catalog");
}

fn apply_current_chronicle_event(
    db: &Database,
    run_id: &str,
    event_id: &str,
    title: &str,
) -> Value {
    insert_scene(db, "scene-1", 0);
    let payload = event_create_payload(event_id, title, "scene-1", 0);
    let proposal_set_id = current_chronicle_proposal_set_id(run_id);
    let mut pairs = seed_current_chronicle_proposals(
        db,
        run_id,
        &proposal_set_id,
        std::slice::from_ref(&payload),
    );
    seal_run_as_current_chronicle(db, run_id);
    decide_current_chronicle_proposal(db, run_id, &mut pairs[0], &payload, "approved");
    prepare_and_apply(
        db,
        build_prepare(
            &format!("{run_id}-apply"),
            &format!("{run_id}-plan"),
            &proposal_set_id,
            run_id,
            vec![(pairs[0].0.clone(), pairs[0].1.clone(), payload)],
        ),
    )
}

#[test]
fn create_run_and_get_run_persist_projection() {
    let db = test_db();
    let created = narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some("run-integration-1".to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({ "folderId": "folder-1" }),
            spec_json: json!({ "domain": "chronicle", "version": 1 }),
            spec_digest: "spec-digest-1".to_string(),
            snapshot_digest: Some("snapshot-digest-1".to_string()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: Some(json!({ "mode": "partial" })),
            tasks: vec![CreateTaskSeed {
                task_id: Some("task-plan-1".to_string()),
                task_kind: "plan_windows".to_string(),
                input_json: Some(json!({ "windowCount": 2 })),
                priority: Some(5),
            }],
        },
    )
    .expect("create run");

    assert_eq!(created["runId"], "run-integration-1");
    assert_eq!(created["status"], "running");

    let loaded = narrative_extraction::narrative_extraction_get_run(
        &db,
        "run-integration-1".to_string(),
        "project-1".to_string(),
    )
    .expect("get run");

    assert_eq!(loaded["run"]["runId"], "run-integration-1");
    assert_eq!(loaded["run"]["projectId"], "project-1");
    assert_eq!(loaded["run"]["snapshotDigest"], "snapshot-digest-1");
    assert_eq!(loaded["taskCounts"]["queued"], 1);
    assert_eq!(loaded["tasks"][0]["taskKind"], "plan_windows");
}

#[test]
fn claim_task_acquires_queued_task_under_immediate_transaction() {
    let db = test_db();
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some("run-integration-2".to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({ "folderId": "folder-2" }),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec-digest-2".to_string(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some("task-observe-1".to_string()),
                task_kind: "extract_window".to_string(),
                input_json: Some(json!({ "windowId": "w-1" })),
                priority: None,
            }],
        },
    )
    .expect("create run");

    let claim = narrative_extraction::narrative_extraction_claim_task(
        &db,
        ClaimTaskPayload {
            run_id: "run-integration-2".to_string(),
            project_id: "project-1".to_string(),
            lease_owner: "worker-a".to_string(),
            lease_duration_secs: Some(120),
            task_kinds: None,
        },
    )
    .expect("claim task");

    assert_eq!(claim["claimed"], true);
    assert_eq!(claim["task"]["taskId"], "task-observe-1");
    assert_eq!(claim["task"]["taskKind"], "extract_window");
    assert!(claim["task"]["attemptId"].is_string());

    let second_claim = narrative_extraction::narrative_extraction_claim_task(
        &db,
        ClaimTaskPayload {
            run_id: "run-integration-2".to_string(),
            project_id: "project-1".to_string(),
            lease_owner: "worker-b".to_string(),
            lease_duration_secs: Some(120),
            task_kinds: None,
        },
    )
    .expect("second claim");
    assert_eq!(second_claim["claimed"], false);

    let loaded = narrative_extraction::narrative_extraction_get_run(
        &db,
        "run-integration-2".to_string(),
        "project-1".to_string(),
    )
    .expect("get run after claim");
    assert_eq!(loaded["taskCounts"]["running"], 1);
    assert_eq!(loaded["tasks"][0]["leaseOwner"], "worker-a");
}

#[test]
fn claim_task_reclaims_same_day_expired_rfc3339_lease() {
    let db = test_db();
    create_run_with_task(&db, "run-lease-expired", "task-lease-expired");

    let first = claim_with_owner(&db, "run-lease-expired", "worker-a", 120);
    assert_eq!(first["claimed"], true);

    let past = rfc3339_millis(Utc::now() - Duration::minutes(5));
    set_task_lease_expires_at(&db, "task-lease-expired", &past);

    let reclaim = claim_with_owner(&db, "run-lease-expired", "worker-b", 120);
    assert_eq!(reclaim["claimed"], true);
    assert_eq!(reclaim["task"]["taskId"], "task-lease-expired");
    assert_eq!(reclaim["task"]["attemptNumber"], 2);

    let loaded = narrative_extraction::narrative_extraction_get_run(
        &db,
        "run-lease-expired".to_string(),
        "project-1".to_string(),
    )
    .expect("get run after reclaim");
    assert_eq!(loaded["tasks"][0]["leaseOwner"], "worker-b");
}

#[test]
fn claim_task_does_not_reclaim_same_day_future_rfc3339_lease() {
    let db = test_db();
    create_run_with_task(&db, "run-lease-future", "task-lease-future");

    let first = claim_with_owner(&db, "run-lease-future", "worker-a", 120);
    assert_eq!(first["claimed"], true);

    let future = rfc3339_millis(Utc::now() + Duration::minutes(5));
    set_task_lease_expires_at(&db, "task-lease-future", &future);

    let second = claim_with_owner(&db, "run-lease-future", "worker-b", 120);
    assert_eq!(second["claimed"], false);

    let loaded = narrative_extraction::narrative_extraction_get_run(
        &db,
        "run-lease-future".to_string(),
        "project-1".to_string(),
    )
    .expect("get run after blocked reclaim");
    assert_eq!(loaded["tasks"][0]["leaseOwner"], "worker-a");
}

#[test]
fn claim_task_reclaims_lease_across_utc_date_boundary() {
    let db = test_db();
    create_run_with_task(&db, "run-lease-boundary", "task-lease-boundary");

    let first = claim_with_owner(&db, "run-lease-boundary", "worker-a", 120);
    assert_eq!(first["claimed"], true);

    // Yesterday late UTC still expires before "now", even when calendar day differs.
    let past_across_day = rfc3339_millis(Utc::now() - Duration::hours(25));
    set_task_lease_expires_at(&db, "task-lease-boundary", &past_across_day);

    let reclaim = claim_with_owner(&db, "run-lease-boundary", "worker-b", 120);
    assert_eq!(reclaim["claimed"], true);
    assert_eq!(reclaim["task"]["taskId"], "task-lease-boundary");

    // Tomorrow early UTC must remain leased.
    let future_across_day = rfc3339_millis(Utc::now() + Duration::hours(25));
    set_task_lease_expires_at(&db, "task-lease-boundary", &future_across_day);

    let blocked = claim_with_owner(&db, "run-lease-boundary", "worker-c", 120);
    assert_eq!(blocked["claimed"], false);

    let loaded = narrative_extraction::narrative_extraction_get_run(
        &db,
        "run-lease-boundary".to_string(),
        "project-1".to_string(),
    )
    .expect("get run after boundary checks");
    assert_eq!(loaded["tasks"][0]["leaseOwner"], "worker-b");
}

#[test]
fn claim_task_with_single_kind_filter_binds_parameters() {
    let db = test_db();
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some("run-kind-1".to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec-kind-1".to_string(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![
                CreateTaskSeed {
                    task_id: Some("task-snapshot".to_string()),
                    task_kind: "snapshot".to_string(),
                    input_json: Some(json!({ "stage": 1 })),
                    priority: Some(3),
                },
                CreateTaskSeed {
                    task_id: Some("task-observe".to_string()),
                    task_kind: "observe".to_string(),
                    input_json: Some(json!({ "stage": 2 })),
                    priority: Some(2),
                },
            ],
        },
    )
    .expect("create run");

    let claim = narrative_extraction::narrative_extraction_claim_task(
        &db,
        ClaimTaskPayload {
            run_id: "run-kind-1".to_string(),
            project_id: "project-1".to_string(),
            lease_owner: "worker-kind".to_string(),
            lease_duration_secs: Some(120),
            task_kinds: Some(vec!["snapshot".to_string()]),
        },
    )
    .expect("claim snapshot by kind");
    assert_eq!(claim["claimed"], true);
    assert_eq!(claim["task"]["taskId"], "task-snapshot");
    assert_eq!(claim["task"]["taskKind"], "snapshot");
}

#[test]
fn claim_task_with_multi_kind_filter_and_miss_and_expired_lease() {
    let db = test_db();
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some("run-kind-2".to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec-kind-2".to_string(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![
                CreateTaskSeed {
                    task_id: Some("task-snapshot-2".to_string()),
                    task_kind: "snapshot".to_string(),
                    input_json: Some(json!({ "stage": 1 })),
                    priority: Some(3),
                },
                CreateTaskSeed {
                    task_id: Some("task-observe-2".to_string()),
                    task_kind: "observe".to_string(),
                    input_json: Some(json!({ "stage": 2 })),
                    priority: Some(2),
                },
            ],
        },
    )
    .expect("create run");

    let miss = narrative_extraction::narrative_extraction_claim_task(
        &db,
        ClaimTaskPayload {
            run_id: "run-kind-2".to_string(),
            project_id: "project-1".to_string(),
            lease_owner: "worker-miss".to_string(),
            lease_duration_secs: Some(120),
            task_kinds: Some(vec!["synthesize".to_string()]),
        },
    )
    .expect("kind miss must not error");
    assert_eq!(miss["claimed"], false);

    let first = narrative_extraction::narrative_extraction_claim_task(
        &db,
        ClaimTaskPayload {
            run_id: "run-kind-2".to_string(),
            project_id: "project-1".to_string(),
            lease_owner: "worker-a".to_string(),
            lease_duration_secs: Some(120),
            task_kinds: Some(vec!["snapshot".to_string(), "observe".to_string()]),
        },
    )
    .expect("multi-kind claim");
    assert_eq!(first["claimed"], true);
    assert_eq!(first["task"]["taskId"], "task-snapshot-2");

    let past = rfc3339_millis(Utc::now() - Duration::minutes(5));
    set_task_lease_expires_at(&db, "task-snapshot-2", &past);

    let reclaim = narrative_extraction::narrative_extraction_claim_task(
        &db,
        ClaimTaskPayload {
            run_id: "run-kind-2".to_string(),
            project_id: "project-1".to_string(),
            lease_owner: "worker-b".to_string(),
            lease_duration_secs: Some(120),
            task_kinds: Some(vec!["snapshot".to_string()]),
        },
    )
    .expect("expired lease reclaim with kind");
    assert_eq!(reclaim["claimed"], true);
    assert_eq!(reclaim["task"]["taskId"], "task-snapshot-2");
    assert_eq!(reclaim["task"]["attemptNumber"], 2);
}

#[test]
fn finish_task_rejects_after_lease_expiry() {
    let db = test_db();
    create_run_with_task(&db, "run-lease-finish", "task-lease-finish");

    let claim = claim_with_owner(&db, "run-lease-finish", "worker-a", 120);
    assert_eq!(claim["claimed"], true);
    let attempt_id = claim["task"]["attemptId"]
        .as_str()
        .expect("attemptId")
        .to_string();

    let past = rfc3339_millis(Utc::now() - Duration::minutes(5));
    set_task_lease_expires_at(&db, "task-lease-finish", &past);

    let err = narrative_extraction::narrative_extraction_finish_task(
        &db,
        FinishTaskPayload {
            run_id: "run-lease-finish".to_string(),
            project_id: "project-1".to_string(),
            task_id: "task-lease-finish".to_string(),
            attempt_id,
            lease_owner: "worker-a".to_string(),
            output_json: Some(json!({ "ok": true })),
            artifacts: vec![],
            chronicle_stage_bundle: None,
            chronicle_stage_receipts: vec![],
            historical_scope_authority_basis: None,
            chronicle_plan_proposal_set: None,
        },
    )
    .expect_err("finish must reject expired lease");
    assert!(
        err.to_string().contains("task lease expired"),
        "unexpected error: {err}"
    );
}

#[test]
fn cancel_run_marks_active_tasks_cancelled() {
    let db = migrated_db();
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some("run-integration-3".to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({}),
            spec_digest: "spec-digest-3".to_string(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![
                CreateTaskSeed {
                    task_id: Some("task-cancel-1".to_string()),
                    task_kind: "plan_windows".to_string(),
                    input_json: None,
                    priority: None,
                },
                CreateTaskSeed {
                    task_id: Some("task-cancel-terminal".to_string()),
                    task_kind: "already_completed".to_string(),
                    input_json: None,
                    priority: None,
                },
            ],
        },
    )
    .expect("create run");

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_extraction_tasks
                SET status = 'completed', attempt_count = 1,
                    started_at = '2026-08-25T00:00:00.000Z',
                    completed_at = '2026-08-25T00:00:01.000Z'
              WHERE id = 'task-cancel-terminal'",
            [],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_attempts
                (id, task_id, attempt_number, status, started_at, completed_at, output_json)
             VALUES ('attempt-cancel-terminal', 'task-cancel-terminal', 1, 'completed',
                     '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:01.000Z',
                     '{\"preserved\":true}')",
            [],
        )?;
        Ok(())
    })
    .expect("seed already-terminal Task and Attempt");

    let claimed = narrative_extraction::narrative_extraction_claim_task(
        &db,
        ClaimTaskPayload {
            run_id: "run-integration-3".to_string(),
            project_id: "project-1".to_string(),
            lease_owner: "cancel-worker".to_string(),
            lease_duration_secs: Some(300),
            task_kinds: None,
        },
    )
    .expect("claim task before generic cancellation");
    let attempt_id = claimed["task"]["attemptId"]
        .as_str()
        .expect("claimed Attempt id")
        .to_string();

    let cancelled = narrative_extraction::narrative_extraction_cancel_run(
        &db,
        RunRefPayload {
            run_id: "run-integration-3".to_string(),
            project_id: "project-1".to_string(),
            chronicle_blocked_discard: None,
        },
    )
    .expect("cancel run");

    assert_eq!(cancelled["status"], "cancelled");

    let loaded = narrative_extraction::narrative_extraction_get_run(
        &db,
        "run-integration-3".to_string(),
        "project-1".to_string(),
    )
    .expect("get cancelled run");
    assert_eq!(loaded["run"]["status"], "cancelled");
    assert_eq!(loaded["taskCounts"]["cancelled"], 1);
    assert_eq!(loaded["taskCounts"]["completed"], 1);

    let terminal_ledger = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT run.completed_at, task.completed_at, attempt.status,
                        attempt.completed_at, attempt.error_message,
                        attempt.failure_code, attempt.retry_disposition,
                        attempt.policy_version, attempt.next_attempt_at
                   FROM narrative_extraction_runs run
                   JOIN narrative_extraction_tasks task ON task.run_id = run.id
                   JOIN narrative_extraction_attempts attempt ON attempt.task_id = task.id
                  WHERE run.id = 'run-integration-3'
                    AND attempt.id = ?1",
                [&attempt_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                },
            )
            .map_err(Into::into)
        })
        .expect("load generic cancellation terminal ledger");
    let lifecycle_at = terminal_ledger
        .0
        .as_deref()
        .expect("cancelled Run lifecycle timestamp");
    assert_eq!(terminal_ledger.1.as_deref(), Some(lifecycle_at));
    assert_eq!(terminal_ledger.2, "failed");
    assert_eq!(terminal_ledger.3.as_deref(), Some(lifecycle_at));
    assert_eq!(
        terminal_ledger.4.as_deref(),
        Some("NEX_RUN_CANCELLED: Run cancelled")
    );
    assert_eq!(terminal_ledger.5.as_deref(), Some("NEX_RUN_CANCELLED"));
    assert_eq!(terminal_ledger.6.as_deref(), Some("terminal"));
    assert_eq!(terminal_ledger.7.as_deref(), Some("v1"));
    assert_eq!(terminal_ledger.8, None);

    let preserved_terminal: (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT status, completed_at, failure_code, retry_disposition, output_json
                   FROM narrative_extraction_attempts
                  WHERE id = 'attempt-cancel-terminal'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .map_err(Into::into)
        })
        .expect("load preserved terminal Attempt");
    assert_eq!(preserved_terminal.0, "completed");
    assert_eq!(
        preserved_terminal.1.as_deref(),
        Some("2026-08-25T00:00:01.000Z")
    );
    assert_eq!(preserved_terminal.2, None);
    assert_eq!(preserved_terminal.3, None);
    assert_eq!(
        preserved_terminal.4.as_deref(),
        Some("{\"preserved\":true}")
    );

    let before_duplicate = cancellation_ledger_state(&db, "run-integration-3");
    let duplicate_error = narrative_extraction::narrative_extraction_cancel_run(
        &db,
        RunRefPayload {
            run_id: "run-integration-3".to_string(),
            project_id: "project-1".to_string(),
            chronicle_blocked_discard: None,
        },
    )
    .expect_err("duplicate cancellation remains fail closed");
    assert!(duplicate_error
        .to_string()
        .contains("run is not cancellable"));
    assert_eq!(
        cancellation_ledger_state(&db, "run-integration-3"),
        before_duplicate
    );
}

#[test]
fn cancel_run_rolls_back_run_and_task_when_attempt_terminalization_fails() {
    let db = migrated_db();
    create_run_with_task(&db, "run-cancel-rollback", "task-cancel-rollback");
    let claimed = claim_with_owner(&db, "run-cancel-rollback", "cancel-worker", 300);
    assert_eq!(claimed["claimed"], true);
    let before = cancellation_ledger_state(&db, "run-cancel-rollback");

    db.with_conn(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER reject_run_cancelled_attempt
             BEFORE UPDATE ON narrative_extraction_attempts
             WHEN OLD.status = 'running'
              AND NEW.status = 'failed'
              AND NEW.failure_code = 'NEX_RUN_CANCELLED'
             BEGIN
               SELECT RAISE(ABORT, 'injected cancellation terminalization failure');
             END;",
        )?;
        Ok(())
    })
    .expect("install cancellation failure trigger");

    let error = narrative_extraction::narrative_extraction_cancel_run(
        &db,
        RunRefPayload {
            run_id: "run-cancel-rollback".to_string(),
            project_id: "project-1".to_string(),
            chronicle_blocked_discard: None,
        },
    )
    .expect_err("Attempt terminalization failure rolls back the transaction");
    assert!(error
        .to_string()
        .contains("injected cancellation terminalization failure"));
    assert_eq!(
        cancellation_ledger_state(&db, "run-cancel-rollback"),
        before,
        "Run, Task, Attempt, and lease evidence remain unchanged after rollback"
    );
}

#[test]
fn apply_commit_creates_three_events_atomically() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 3);
    let payloads = [
        event_create_payload("event-a", "A", "scene-1", 3),
        event_create_payload("event-b", "B", "scene-1", 3),
        event_create_payload("event-c", "C", "scene-1", 3),
    ];
    let pairs = seed_approved_proposals(&db, "run-commit-1", "set-1", &payloads);
    let ops = vec![
        (pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone()),
        (pairs[1].0.clone(), pairs[1].1.clone(), payloads[1].clone()),
        (pairs[2].0.clone(), pairs[2].1.clone(), payloads[2].clone()),
    ];
    let payload = build_prepare(
        "req-atomic-1",
        "digest-atomic-1",
        "set-1",
        "run-commit-1",
        ops,
    );

    let applied = prepare_and_apply(&db, payload);
    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["created"].as_array().unwrap().len(), 3);

    let event_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM events WHERE project_id = 'project-1'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(event_count, 3);

    let link_count: i64 = db
        .with_conn(
            |conn| Ok(conn.query_row("SELECT COUNT(*) FROM scene_events", [], |r| r.get(0))?),
        )
        .unwrap();
    assert_eq!(link_count, 3);

    let status = narrative_extraction::narrative_extraction_get_commit_status(
        &db,
        GetCommitStatusPayload {
            project_id: "project-1".to_string(),
            commit_id: None,
            request_id: Some("req-atomic-1".to_string()),
        },
    )
    .expect("status");
    assert_eq!(status["found"], true);
    assert_eq!(status["status"], "applied");
}

#[test]
fn current_chronicle_prepare_rejects_partial_review_before_commit_dml() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let run_id = "run-current-partial-review";
    let set_id = current_chronicle_proposal_set_id(run_id);
    let payloads = [
        event_create_payload("event-reviewed", "Reviewed", "scene-1", 0),
        event_create_payload("event-unreviewed", "Unreviewed", "scene-1", 0),
    ];
    let mut pairs = seed_current_chronicle_proposals(&db, run_id, &set_id, &payloads);
    seal_run_as_current_chronicle(&db, run_id);
    decide_current_chronicle_proposal(&db, run_id, &mut pairs[0], &payloads[0], "approved");
    enable_manual_apply(&db);

    let error = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(
            "req-current-partial-review",
            "ignored-caller-plan-digest",
            &set_id,
            run_id,
            vec![(pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone())],
        ),
    )
    .expect_err("an unreviewed Proposal must block an all-or-nothing current Chronicle Apply");
    assert!(
        error
            .to_string()
            .contains("NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE"),
        "unexpected error: {error:#}"
    );

    let (event_count, commit_count, application_count): (i64, i64, i64) = db
        .with_conn(|conn| {
            Ok((
                conn.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?,
                conn.query_row("SELECT COUNT(*) FROM narrative_apply_commits", [], |row| {
                    row.get(0)
                })?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_proposal_applications",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("read rejected partial-apply state");
    assert_eq!((event_count, commit_count, application_count), (0, 0, 0));
}

#[test]
fn current_chronicle_prepare_requires_exact_duplicate_free_approved_roster() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let run_id = "run-current-exact-roster";
    let set_id = current_chronicle_proposal_set_id(run_id);
    let payloads = [
        event_create_payload("event-roster-a", "Roster A", "scene-1", 0),
        event_create_payload("event-roster-b", "Roster B", "scene-1", 0),
    ];
    let mut pairs = seed_current_chronicle_proposals(&db, run_id, &set_id, &payloads);
    seal_run_as_current_chronicle(&db, run_id);
    for (proposal, payload) in pairs.iter_mut().zip(payloads.iter()) {
        decide_current_chronicle_proposal(&db, run_id, proposal, payload, "approved");
    }
    enable_manual_apply(&db);

    let omitted = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(
            "req-current-roster-omitted",
            "ignored",
            &set_id,
            run_id,
            vec![(pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone())],
        ),
    )
    .expect_err("omitting an approved Proposal must fail exact coverage");
    assert!(
        omitted
            .to_string()
            .contains("NEX_CHRONICLE_APPLY_COVERAGE_MISMATCH"),
        "unexpected omitted-roster error: {omitted:#}"
    );

    let duplicate = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(
            "req-current-roster-duplicate",
            "ignored",
            &set_id,
            run_id,
            vec![
                (pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone()),
                (pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone()),
            ],
        ),
    )
    .expect_err("duplicating one approved Proposal must fail exact coverage");
    assert!(
        duplicate
            .to_string()
            .contains("NEX_CHRONICLE_APPLY_COVERAGE_MISMATCH"),
        "unexpected duplicate-roster error: {duplicate:#}"
    );

    let commit_count: i64 = db
        .with_conn(|conn| {
            Ok(
                conn.query_row("SELECT COUNT(*) FROM narrative_apply_commits", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .expect("count rejected Prepare rows");
    assert_eq!(commit_count, 0);
}

#[test]
fn current_chronicle_prepare_rejects_every_nonterminal_review_status() {
    for status in ["unreviewed", "held", "deferred"] {
        let db = migrated_db();
        insert_scene(&db, "scene-1", 0);
        let payloads = [
            event_create_payload(
                &format!("event-{status}-approved"),
                "Approved",
                "scene-1",
                0,
            ),
            event_create_payload(&format!("event-{status}-pending"), "Pending", "scene-1", 0),
        ];
        let run_id = format!("run-current-review-{status}");
        let set_id = current_chronicle_proposal_set_id(&run_id);
        let mut pairs = seed_current_chronicle_proposals(&db, &run_id, &set_id, &payloads);
        seal_run_as_current_chronicle(&db, &run_id);
        decide_current_chronicle_proposal(&db, &run_id, &mut pairs[0], &payloads[0], "approved");
        if status != "unreviewed" {
            decide_proposal(&db, &run_id, &pairs[1], status);
        }
        enable_manual_apply(&db);

        let error = narrative_extraction::narrative_extraction_prepare_commit(
            &db,
            build_prepare(
                &format!("req-current-review-{status}"),
                "ignored",
                &set_id,
                &run_id,
                vec![(pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone())],
            ),
        )
        .expect_err("nonterminal review state must block current Chronicle Apply");
        assert!(
            error
                .to_string()
                .contains("NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE"),
            "unexpected {status} error: {error:#}"
        );
    }
}

#[test]
fn current_chronicle_probable_duplicates_require_typed_current_decisions() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let payloads = [
        event_create_payload("event-probable-create", "Create", "scene-1", 0),
        event_create_payload("event-probable-skip", "Skip", "scene-1", 0),
    ];
    let run_id = "run-current-probable-decisions";
    let set_id = current_chronicle_proposal_set_id(run_id);
    let mut pairs = seed_current_chronicle_proposals(&db, run_id, &set_id, &payloads);
    let probable_match = json!({
        "status": "probable-duplicate",
        "candidates": ["event-existing"],
        "reasons": ["title-only"],
    });
    seal_run_as_current_chronicle_with_matches(
        &db,
        run_id,
        &[probable_match.clone(), probable_match],
    );
    enable_manual_apply(&db);

    let bare_rejection = append_decision(&db, run_id, &pairs[1], "rejected", None)
        .expect_err("bare rejection must fail before Decision/status DML");
    assert!(
        bare_rejection
            .to_string()
            .contains("probableDuplicateChoice='skip-as-same'"),
        "unexpected bare rejection error: {bare_rejection:#}"
    );
    let (status_after_bare_reject, decision_count): (String, i64) = db
        .with_conn(|conn| {
            Ok((
                conn.query_row(
                    "SELECT status FROM narrative_proposals WHERE id = ?1",
                    [&pairs[1].0],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_proposal_decisions WHERE proposal_id = ?1",
                    [&pairs[1].0],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("read rejected bare probable Decision state");
    assert_eq!(status_after_bare_reject, "unreviewed");
    assert_eq!(decision_count, 0);
    let resumable = narrative_extraction::narrative_extraction_list_resumable_runs(
        &db,
        ListResumableRunsPayload {
            project_id: "project-1".to_string(),
            surface_path_id: Some("chronicle.extract".to_string()),
            limit: Some(20),
        },
    )
    .expect("discover probable Proposal after rejected bare Decision");
    assert!(resumable
        .as_array()
        .unwrap()
        .iter()
        .any(|candidate| candidate["runId"] == run_id));

    append_decision(
        &db,
        run_id,
        &pairs[1],
        "rejected",
        Some(json!({ "probableDuplicateChoice": "skip-as-same" })),
    )
    .expect("record skip-as-same rejection");

    append_current_chronicle_revision(&db, run_id, &mut pairs[0], &payloads[0]);
    let bare_approval = append_decision(&db, run_id, &pairs[0], "approved", None)
        .expect_err("bare approval must fail before Decision/status DML");
    assert!(
        bare_approval
            .to_string()
            .contains("probableDuplicateChoice='create-as-new'"),
        "unexpected bare approval error: {bare_approval:#}"
    );
    append_decision(
        &db,
        run_id,
        &pairs[0],
        "approved",
        Some(json!({ "probableDuplicateChoice": "create-as-new" })),
    )
    .expect("record create-as-new approval");

    let final_prepare = build_prepare(
        "req-probable-final",
        "ignored",
        &set_id,
        run_id,
        vec![(pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone())],
    );
    let prepared =
        narrative_extraction::narrative_extraction_prepare_commit(&db, final_prepare.clone())
            .expect("typed probable-duplicate choices satisfy Native review");
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: "project-1".to_string(),
            prepared_commit_id: prepared["preparedCommitId"].as_str().unwrap().to_string(),
            request_id: final_prepare.request_id,
            session_id: final_prepare.session_id,
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect("apply create-as-new and exclude skip-as-same");
    assert_eq!(applied["created"].as_array().unwrap().len(), 1);
}

#[test]
fn current_chronicle_plan_attempt_authority_is_exact_before_decision_dml() {
    for corruption in ["orphan", "duplicate-current-number"] {
        let db = migrated_db();
        insert_scene(&db, "scene-1", 0);
        let run_id = format!("run-current-plan-attempt-{corruption}");
        let set_id = current_chronicle_proposal_set_id(&run_id);
        let payload = event_create_payload(
            &format!("event-plan-attempt-{corruption}"),
            "Plan attempt",
            "scene-1",
            0,
        );
        let pairs =
            seed_current_chronicle_proposals(&db, &run_id, &set_id, std::slice::from_ref(&payload));
        seal_run_as_current_chronicle(&db, &run_id);
        db.with_conn(|conn| {
            let task_id = format!("{run_id}-task");
            match corruption {
                "orphan" => {
                    conn.execute(
                        "DELETE FROM narrative_extraction_attempts WHERE id = ?1",
                        [format!("attempt-plan-{run_id}")],
                    )?;
                }
                "duplicate-current-number" => {
                    let output_json: String = conn.query_row(
                        "SELECT output_json FROM narrative_extraction_tasks WHERE id = ?1",
                        [&task_id],
                        |row| row.get(0),
                    )?;
                    conn.execute(
                        "INSERT INTO narrative_extraction_attempts
                            (id, task_id, attempt_number, status, started_at,
                             completed_at, output_json)
                         VALUES (?1, ?2, 1, 'failed',
                                 '2026-08-26T00:00:00.000Z',
                                 '2026-08-26T00:00:01.000Z', ?3)",
                        rusqlite::params![
                            format!("attempt-plan-duplicate-{run_id}"),
                            task_id,
                            output_json,
                        ],
                    )?;
                }
                _ => unreachable!(),
            }
            Ok(())
        })
        .expect("corrupt exact plan Attempt authority");

        let error = append_decision(&db, &run_id, &pairs[0], "rejected", None)
            .expect_err("orphan/stale current plan Attempt must reject before Decision DML");
        assert!(
            error
                .to_string()
                .contains("NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT"),
            "unexpected {corruption} plan authority error: {error:#}"
        );
        let (status, decision_count): (String, i64) = db
            .with_conn(|conn| {
                Ok((
                    conn.query_row(
                        "SELECT status FROM narrative_proposals WHERE id = ?1",
                        [&pairs[0].0],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM narrative_proposal_decisions WHERE proposal_id = ?1",
                        [&pairs[0].0],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("read rejected plan Attempt Decision state");
        assert_eq!(status, "unreviewed");
        assert_eq!(decision_count, 0);
    }
}

#[test]
fn current_chronicle_plan_match_rehash_cannot_bypass_manifest_binding() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let run_id = "run-current-plan-match-tamper";
    let set_id = current_chronicle_proposal_set_id(run_id);
    let payloads = [
        event_create_payload("event-plan-tamper-a", "Apply", "scene-1", 0),
        event_create_payload("event-plan-tamper-b", "Reject", "scene-1", 0),
    ];
    let mut pairs = seed_current_chronicle_proposals(&db, run_id, &set_id, &payloads);
    seal_run_as_current_chronicle(&db, run_id);
    decide_current_chronicle_proposal(&db, run_id, &mut pairs[0], &payloads[0], "approved");
    decide_proposal(&db, run_id, &pairs[1], "rejected");
    db.with_conn(|conn| {
        let artifact_json: String = conn.query_row(
            "SELECT payload_json
               FROM narrative_extraction_artifacts
              WHERE run_id = ?1 AND artifact_kind = 'chronicle.proposal-plan@1'",
            [run_id],
            |row| row.get(0),
        )?;
        let mut artifact: Value = serde_json::from_str(&artifact_json)?;
        artifact["planned"][0]["match"] = json!({
            "status": "probable-duplicate",
            "candidates": ["event-forged"],
            "reasons": ["rehash-tamper"],
        });
        conn.execute(
            "UPDATE narrative_extraction_artifacts
                SET payload_json = ?1, payload_digest = ?2
              WHERE run_id = ?3 AND artifact_kind = 'chronicle.proposal-plan@1'",
            rusqlite::params![
                artifact.to_string(),
                grimodex_core::canonical_json_digest(&artifact)?,
                run_id,
            ],
        )?;
        Ok(())
    })
    .expect("rewrite and rehash sealed plan match metadata");
    enable_manual_apply(&db);

    let error = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(
            "req-plan-match-tamper",
            "ignored",
            &set_id,
            run_id,
            vec![(pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone())],
        ),
    )
    .expect_err("rehashing a rewritten match must not bypass the ProposalSet manifest");
    assert!(
        error
            .to_string()
            .contains("NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT"),
        "unexpected plan match tamper error: {error:#}"
    );
    let commit_count: i64 = db
        .with_conn(|conn| {
            Ok(
                conn.query_row("SELECT COUNT(*) FROM narrative_apply_commits", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .expect("count plan-tamper commits");
    assert_eq!(commit_count, 0);
}

#[test]
fn current_chronicle_native_compiler_rejects_renderer_field_tampering() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let run_id = "run-current-compiler-tamper";
    let set_id = current_chronicle_proposal_set_id(run_id);
    let payload = event_create_payload("event-compiler-sealed", "Sealed", "scene-1", 0);
    let mut pairs =
        seed_current_chronicle_proposals(&db, run_id, &set_id, std::slice::from_ref(&payload));
    seal_run_as_current_chronicle(&db, run_id);
    decide_current_chronicle_proposal(&db, run_id, &mut pairs[0], &payload, "approved");
    enable_manual_apply(&db);

    let mut event_id = payload.clone();
    event_id["eventId"] = json!("event-renderer-forged");
    let mut title = payload.clone();
    title["title"] = json!("Renderer forged title");
    let mut reveal = payload.clone();
    reveal["revealSceneId"] = json!("scene-forged");
    let mut evidence_version = payload.clone();
    evidence_version["evidenceSceneLinks"][0]["expectedSceneVersion"] = json!(99);
    let mut anchors = payload.clone();
    anchors["evidenceSceneLinks"][0]["evidenceAnchorIds"] = json!(["anchor:forged"]);
    let mut fixed_detail = payload.clone();
    fixed_detail["detail"] = json!("renderer-forged-detail");
    let mut semantic_type = payload.clone();
    semantic_type["semanticType"] = json!("state");

    for (case, tampered, expected_code) in [
        ("event-id", event_id, "NEX_PROPOSAL_PAYLOAD_MISMATCH"),
        ("title", title, "NEX_PROPOSAL_PAYLOAD_MISMATCH"),
        ("reveal-scene", reveal, "NEX_PROPOSAL_PAYLOAD_MISMATCH"),
        (
            "evidence-version",
            evidence_version,
            "NEX_SCENE_VERSION_MISMATCH",
        ),
        ("evidence-anchors", anchors, "NEX_PROPOSAL_PAYLOAD_MISMATCH"),
        (
            "fixed-detail",
            fixed_detail,
            "NEX_PROPOSAL_PAYLOAD_MISMATCH",
        ),
        (
            "semantic-type",
            semantic_type,
            "NEX_PROPOSAL_PAYLOAD_MISMATCH",
        ),
    ] {
        let error = narrative_extraction::narrative_extraction_prepare_commit(
            &db,
            build_prepare(
                &format!("req-current-compiler-tamper-{case}"),
                "ignored",
                &set_id,
                run_id,
                vec![(pairs[0].0.clone(), pairs[0].1.clone(), tampered)],
            ),
        )
        .expect_err("renderer-compiled fields must be derived from Native authority");
        assert!(
            error.to_string().contains(expected_code),
            "unexpected {case} compiler error: {error:#}"
        );
    }

    let commit_count: i64 = db
        .with_conn(|conn| {
            Ok(
                conn.query_row("SELECT COUNT(*) FROM narrative_apply_commits", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .expect("count compiler-tamper commits");
    assert_eq!(commit_count, 0);
}

#[test]
fn current_chronicle_snapshot_origin_rehash_is_rejected_by_terminal_output_cas() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let run_id = "run-current-snapshot-origin-tamper";
    let set_id = current_chronicle_proposal_set_id(run_id);
    let operation = event_create_payload("event-snapshot-sealed", "Sealed", "scene-1", 0);
    let mut pairs =
        seed_current_chronicle_proposals(&db, run_id, &set_id, std::slice::from_ref(&operation));
    seal_run_as_current_chronicle(&db, run_id);
    decide_current_chronicle_proposal(&db, run_id, &mut pairs[0], &operation, "approved");
    db.with_conn(|conn| {
        let artifact_json: String = conn.query_row(
            "SELECT payload_json
               FROM narrative_extraction_artifacts
              WHERE run_id = ?1 AND artifact_kind = 'source.snapshot@1'",
            [run_id],
            |row| row.get(0),
        )?;
        let mut artifact: Value = serde_json::from_str(&artifact_json)?;
        artifact["snapshot"]["documents"][0]["origin"]["sourceVersion"] = json!(7);

        let document = artifact["snapshot"]["documents"][0].clone();
        let document_artifact_digest = grimodex_core::canonical_json_digest(&json!({
            "schemaVersion": 1,
            "normalizerVersion": "gdx-canonical-text/1",
            "sourceKey": document["sourceKey"],
            "parentSourceKey": null,
            "semanticDigest": document["documentDigest"],
            "contentDigest": document["contentDigest"],
            "projection": document["canonical"]["projection"],
            "origin": document["origin"],
        }))?;
        artifact["snapshot"]["documents"][0]["artifactDigest"] = json!(document_artifact_digest);
        let snapshot_digest = artifact["snapshot"]["digest"].clone();
        let omissions = artifact["snapshot"]["omissions"].clone();
        artifact["snapshot"]["artifactDigest"] =
            json!(grimodex_core::canonical_json_digest(&json!({
                "schemaVersion": 1,
                "normalizerVersion": "gdx-canonical-text/1",
                "semanticDigest": snapshot_digest,
                "originProjectId": "project-1",
                "documents": [{
                    "sourceKey": artifact["snapshot"]["documents"][0]["sourceKey"],
                    "artifactDigest": document_artifact_digest,
                }],
                "omissions": omissions,
            }))?);
        artifact["sourceViews"][0]["digest"] =
            json!(grimodex_core::canonical_json_digest(&json!({
                "schemaVersion": 1,
                "ref": artifact["sourceViews"][0]["ref"],
                "documentRef": artifact["sourceViews"][0]["documentRef"],
                "documentArtifactDigest": document_artifact_digest,
                "documentRange": artifact["sourceViews"][0]["documentRange"],
                "text": artifact["sourceViews"][0]["text"],
            }))?);
        conn.execute(
            "UPDATE narrative_extraction_artifacts
                SET payload_json = ?1, payload_digest = ?2
              WHERE run_id = ?3 AND artifact_kind = 'source.snapshot@1'",
            rusqlite::params![
                artifact.to_string(),
                grimodex_core::canonical_json_digest(&artifact)?,
                run_id,
            ],
        )?;
        Ok(())
    })
    .expect("rewrite every inner Snapshot origin seal and outer artifact digest");
    enable_manual_apply(&db);

    let error = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(
            "req-snapshot-origin-tamper",
            "ignored",
            &set_id,
            run_id,
            vec![(pairs[0].0.clone(), pairs[0].1.clone(), operation)],
        ),
    )
    .expect_err("terminal Snapshot output must seal the full corpus payload bytes");
    assert!(
        error
            .to_string()
            .contains("NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH")
            && error.to_string().contains("corpusPayloadDigest"),
        "unexpected Snapshot origin tamper error: {error:#}"
    );
    let commit_count: i64 = db
        .with_conn(|conn| {
            Ok(
                conn.query_row("SELECT COUNT(*) FROM narrative_apply_commits", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .expect("count Snapshot-origin tamper commits");
    assert_eq!(commit_count, 0);
}

#[test]
fn current_chronicle_apply_invalidates_on_ambiguous_snapshot_owner() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let run_id = "run-current-snapshot-owner-apply";
    let set_id = current_chronicle_proposal_set_id(run_id);
    let operation = event_create_payload("event-snapshot-owner", "Owner", "scene-1", 0);
    let mut pairs =
        seed_current_chronicle_proposals(&db, run_id, &set_id, std::slice::from_ref(&operation));
    seal_run_as_current_chronicle(&db, run_id);
    decide_current_chronicle_proposal(&db, run_id, &mut pairs[0], &operation, "approved");
    enable_manual_apply(&db);
    let prepare = build_prepare(
        "req-snapshot-owner-apply",
        "ignored",
        &set_id,
        run_id,
        vec![(pairs[0].0.clone(), pairs[0].1.clone(), operation)],
    );
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(&db, prepare.clone())
        .expect("prepare before Snapshot owner corruption");
    db.with_conn(|conn| {
        let output_json: String = conn.query_row(
            "SELECT output_json
               FROM narrative_extraction_tasks
              WHERE run_id = ?1 AND task_kind = 'source.snapshot@1'",
            [run_id],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_tasks
                (id, run_id, task_kind, status, input_json, output_json,
                 priority, attempt_count, created_at, started_at, completed_at, version)
             VALUES (?1, ?2, 'source.snapshot@1', 'completed', '{}', ?3,
                     100, 1, '2026-08-26T00:00:02.000Z',
                     '2026-08-26T00:00:02.000Z', '2026-08-26T00:00:03.000Z', 0)",
            rusqlite::params![
                format!("{run_id}-snapshot-task-duplicate"),
                run_id,
                output_json
            ],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_attempts
                (id, task_id, attempt_number, status, started_at, completed_at, output_json)
             VALUES (?1, ?2, 1, 'completed', '2026-08-26T00:00:02.000Z',
                     '2026-08-26T00:00:03.000Z', ?3)",
            rusqlite::params![
                format!("{run_id}-snapshot-attempt-duplicate"),
                format!("{run_id}-snapshot-task-duplicate"),
                output_json,
            ],
        )?;
        Ok(())
    })
    .expect("insert a second completed Snapshot owner after Prepare");

    let error = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: "project-1".to_string(),
            prepared_commit_id: prepared["preparedCommitId"].as_str().unwrap().to_string(),
            request_id: prepare.request_id,
            session_id: prepare.session_id,
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect_err("ambiguous Snapshot authority must invalidate the prepared Apply");
    assert!(
        error
            .to_string()
            .contains("NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID"),
        "unexpected Snapshot topology error: {error:#}"
    );
    let (event_count, application_count, commit_status): (i64, i64, String) = db
        .with_conn(|conn| {
            Ok((
                conn.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_proposal_applications",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT status FROM narrative_apply_commits WHERE id = ?1",
                    [&prepared["preparedCommitId"].as_str().unwrap()],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("read invalidated Snapshot-owner Apply state");
    assert_eq!((event_count, application_count), (0, 0));
    assert_eq!(commit_status, "invalidated");
}

#[test]
fn current_chronicle_prepare_rejects_duplicate_snapshot_attempt_number() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let run_id = "run-current-snapshot-attempt-duplicate";
    let set_id = current_chronicle_proposal_set_id(run_id);
    let operation = event_create_payload("event-snapshot-attempt", "Attempt", "scene-1", 0);
    let mut pairs =
        seed_current_chronicle_proposals(&db, run_id, &set_id, std::slice::from_ref(&operation));
    seal_run_as_current_chronicle(&db, run_id);
    decide_current_chronicle_proposal(&db, run_id, &mut pairs[0], &operation, "approved");
    db.with_conn(|conn| {
        let task_id = format!("{run_id}-snapshot-task");
        let output_json: String = conn.query_row(
            "SELECT output_json FROM narrative_extraction_tasks WHERE id = ?1",
            [&task_id],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_attempts
                (id, task_id, attempt_number, status, started_at, completed_at, output_json)
             VALUES (?1, ?2, 1, 'failed', '2026-08-26T00:00:02.000Z',
                     '2026-08-26T00:00:03.000Z', ?3)",
            rusqlite::params![
                format!("{run_id}-snapshot-attempt-stale"),
                task_id,
                output_json,
            ],
        )?;
        Ok(())
    })
    .expect("insert a stale duplicate Snapshot Attempt number");
    enable_manual_apply(&db);

    let error = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(
            "req-snapshot-attempt-duplicate",
            "ignored",
            &set_id,
            run_id,
            vec![(pairs[0].0.clone(), pairs[0].1.clone(), operation)],
        ),
    )
    .expect_err("duplicate current Snapshot Attempt number must reject Prepare");
    assert!(
        error
            .to_string()
            .contains("NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID"),
        "unexpected Snapshot Attempt ambiguity error: {error:#}"
    );
    let commit_count: i64 = db
        .with_conn(|conn| {
            Ok(
                conn.query_row("SELECT COUNT(*) FROM narrative_apply_commits", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .expect("count Snapshot-attempt ambiguity commits");
    assert_eq!(commit_count, 0);
}

#[test]
fn current_chronicle_applies_approved_and_rejected_set_once_and_seals_mutations() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let mut payloads = [
        event_create_payload("event-atomic-reviewed", "Approved", "scene-1", 0),
        event_create_payload("event-atomic-rejected", "Rejected", "scene-1", 0),
    ];
    // The reviewed Proposal owns anchor order. Its Envelope intentionally
    // stores these two anchors in reverse row order, and both anchors resolve
    // to the same document. Native compilation must still reproduce this
    // exact renderer operation rather than inheriting Envelope row order.
    payloads[0]["evidenceSceneLinks"][0]["evidenceAnchorIds"] = json!(["anchor:two", "anchor:one"]);
    let run_id = "run-current-approved-rejected";
    let set_id = current_chronicle_proposal_set_id(run_id);
    let mut pairs = seed_current_chronicle_proposals(&db, run_id, &set_id, &payloads);
    seal_run_as_current_chronicle(&db, run_id);
    decide_current_chronicle_proposal(&db, run_id, &mut pairs[0], &payloads[0], "approved");
    decide_proposal(&db, run_id, &pairs[1], "rejected");
    enable_manual_apply(&db);
    let prepare = build_prepare(
        "req-current-approved-rejected",
        "ignored",
        &set_id,
        run_id,
        vec![(pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone())],
    );

    let prepared = narrative_extraction::narrative_extraction_prepare_commit(&db, prepare.clone())
        .expect("prepare exact approved roster");
    let prepared_commit_id = prepared["preparedCommitId"].as_str().unwrap().to_string();
    let apply_payload = ApplyCommitPayload {
        project_id: "project-1".to_string(),
        prepared_commit_id: prepared_commit_id.clone(),
        request_id: prepare.request_id.clone(),
        session_id: prepare.session_id.clone(),
        expected_version: prepared["version"].as_i64(),
    };
    let first = narrative_extraction::narrative_extraction_apply_commit(&db, apply_payload.clone())
        .expect("apply exact approved roster");
    assert_eq!(first["status"], "applied");

    let replay_prepare =
        narrative_extraction::narrative_extraction_prepare_commit(&db, prepare.clone())
            .expect("same request Prepare must replay after its own catalog mutation");
    assert_eq!(replay_prepare["preparedCommitId"], prepared_commit_id);
    assert_eq!(replay_prepare["idempotentReplay"], true);
    let replay_apply = narrative_extraction::narrative_extraction_apply_commit(&db, apply_payload)
        .expect("same prepared Apply must replay after its own catalog mutation");
    assert_eq!(replay_apply["commitId"], first["commitId"]);
    assert_eq!(replay_apply["idempotentReplay"], true);

    let reopen_error = narrative_extraction::narrative_extraction_append_human_decision(
        &db,
        AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: pairs[1].0.clone(),
            revision_id: pairs[1].1.clone(),
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("test".to_string()),
        },
    )
    .expect_err("an applied current set must not reopen a rejected Proposal");
    assert!(
        reopen_error
            .to_string()
            .contains("NEX_CHRONICLE_APPLY_SET_CONSUMED"),
        "unexpected reopen error: {reopen_error:#}"
    );
    narrative_extraction::narrative_extraction_append_human_decision(
        &db,
        AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: pairs[1].0.clone(),
            revision_id: pairs[1].1.clone(),
            decision: "rejected".to_string(),
            decision_json: Some(json!({ "reason": "partial-set-cleanup" })),
            created_by: Some("test".to_string()),
        },
    )
    .expect("reject-only cleanup remains available for historical partial sets");
    let revision_error = narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: pairs[1].0.clone(),
            payload_json: payloads[1].clone(),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: None,
            expected_current_revision_id: pairs[1].1.clone(),
            created_by: Some("test".to_string()),
        },
    )
    .expect_err("an applied current set must not accept a new Revision");
    assert!(revision_error
        .to_string()
        .contains("NEX_CHRONICLE_APPLY_SET_CONSUMED"));

    let (event_count, application_count): (i64, i64) = db
        .with_conn(|conn| {
            Ok((
                conn.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_proposal_applications",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("read atomic Apply state");
    assert_eq!((event_count, application_count), (1, 1));
}

#[test]
fn current_chronicle_apply_revalidates_exact_roster_after_prepare() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let payloads = [
        event_create_payload("event-apply-cas-a", "Approved", "scene-1", 0),
        event_create_payload("event-apply-cas-b", "Rejected", "scene-1", 0),
    ];
    let run_id = "run-current-apply-coverage-cas";
    let set_id = current_chronicle_proposal_set_id(run_id);
    let mut pairs = seed_current_chronicle_proposals(&db, run_id, &set_id, &payloads);
    seal_run_as_current_chronicle(&db, run_id);
    decide_current_chronicle_proposal(&db, run_id, &mut pairs[0], &payloads[0], "approved");
    decide_proposal(&db, run_id, &pairs[1], "rejected");
    enable_manual_apply(&db);
    let prepare = build_prepare(
        "req-current-apply-coverage-cas",
        "ignored",
        &set_id,
        run_id,
        vec![(pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone())],
    );
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(&db, prepare.clone())
        .expect("prepare before Decision drift");
    decide_current_chronicle_proposal(&db, run_id, &mut pairs[1], &payloads[1], "approved");

    let error = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: "project-1".to_string(),
            prepared_commit_id: prepared["preparedCommitId"].as_str().unwrap().to_string(),
            request_id: prepare.request_id,
            session_id: prepare.session_id,
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect_err("Apply must re-CAS the exact approved roster");
    assert!(
        error
            .to_string()
            .contains("NEX_CHRONICLE_APPLY_COVERAGE_MISMATCH"),
        "unexpected Apply coverage error: {error:#}"
    );
    let (event_count, application_count, commit_status): (i64, i64, String) = db
        .with_conn(|conn| {
            Ok((
                conn.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_proposal_applications",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT status FROM narrative_apply_commits WHERE id = ?1",
                    [&prepared["preparedCommitId"].as_str().unwrap()],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("read rejected Apply state");
    assert_eq!((event_count, application_count), (0, 0));
    assert_eq!(commit_status, "invalidated");
}

#[test]
fn legacy_chronicle_prepare_keeps_subset_apply_compatibility() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let payloads = [
        event_create_payload("event-legacy-approved", "Approved", "scene-1", 0),
        event_create_payload("event-legacy-unreviewed", "Unreviewed", "scene-1", 0),
    ];
    let pairs = seed_proposals(
        &db,
        "run-legacy-partial-review",
        "set-legacy-partial-review",
        &payloads,
    );
    decide_proposal(&db, "run-legacy-partial-review", &pairs[0], "approved");
    enable_manual_apply(&db);

    let prepared = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(
            "req-legacy-partial-review",
            "ignored",
            "set-legacy-partial-review",
            "run-legacy-partial-review",
            vec![(pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone())],
        ),
    )
    .expect("legacy non-v2 Chronicle keeps subset-Apply compatibility");
    assert_eq!(prepared["status"], "prepared");
}

#[test]
fn legacy_chronicle_does_not_gain_current_compiler_kind_mapping() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let payload = event_create_payload("event-legacy-kind", "Legacy kind", "scene-1", 0);
    let run_id = "run-legacy-current-kind";
    let set_id = "set-legacy-current-kind";
    let pairs =
        seed_current_chronicle_proposals(&db, run_id, set_id, std::slice::from_ref(&payload));
    decide_proposal(&db, run_id, &pairs[0], "approved");
    enable_manual_apply(&db);

    let error = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(
            "req-legacy-current-kind",
            "ignored",
            set_id,
            run_id,
            vec![(pairs[0].0.clone(), pairs[0].1.clone(), payload)],
        ),
    )
    .expect_err("current compiler kind mapping must not expand legacy acceptance");
    assert!(
        error.to_string().contains("NEX_PROPOSAL_KIND_MISMATCH"),
        "unexpected legacy kind error: {error:#}"
    );
    let commit_count: i64 = db
        .with_conn(|conn| {
            Ok(
                conn.query_row("SELECT COUNT(*) FROM narrative_apply_commits", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .expect("count rejected legacy compiler mapping commits");
    assert_eq!(commit_count, 0);
}

#[test]
fn historical_partial_set_can_reject_remaining_proposals_and_leave_resume_discovery() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let payloads = [
        event_create_payload("event-historical-applied", "Applied", "scene-1", 0),
        event_create_payload("event-historical-pending", "Pending", "scene-1", 0),
    ];
    let run_id = "run-historical-partial-cleanup";
    let set_id = current_chronicle_proposal_set_id(run_id);
    let pairs = seed_current_chronicle_proposals(&db, run_id, &set_id, &payloads);
    decide_proposal(&db, run_id, &pairs[0], "approved");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_apply_commits
                (id, project_id, run_id, proposal_set_id, request_id, plan_digest,
                 status, created_at, completed_at, version)
             VALUES ('commit-historical-partial', 'project-1', ?1, ?2,
                     'request-historical-partial', 'plan-historical-partial',
                     'applied', '2026-08-26T00:00:00.000Z',
                     '2026-08-26T00:00:01.000Z', 1)",
            rusqlite::params![run_id, set_id],
        )?;
        conn.execute(
            "INSERT INTO narrative_proposal_applications
                (id, commit_id, proposal_id, revision_id, applied_entity_kind,
                 applied_entity_id, created_at)
             VALUES ('application-historical-partial', 'commit-historical-partial',
                     ?1, ?2, 'event', 'event-historical-applied',
                     '2026-08-26T00:00:01.000Z')",
            rusqlite::params![pairs[0].0, pairs[0].1],
        )?;
        Ok(())
    })
    .expect("seed pre-atomic partial Application ledger");
    // Model a workspace written by the pre-atomic current Chronicle build:
    // A owns an Application while B remains unreviewed.
    seal_run_as_current_chronicle(&db, run_id);

    let before = narrative_extraction::narrative_extraction_list_resumable_runs(
        &db,
        ListResumableRunsPayload {
            project_id: "project-1".to_string(),
            surface_path_id: Some("chronicle.extract".to_string()),
            limit: Some(20),
        },
    )
    .expect("discover historical partial review");
    assert!(before
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["runId"] == run_id));

    decide_proposal(&db, run_id, &pairs[1], "rejected");
    let after = narrative_extraction::narrative_extraction_list_resumable_runs(
        &db,
        ListResumableRunsPayload {
            project_id: "project-1".to_string(),
            surface_path_id: Some("chronicle.extract".to_string()),
            limit: Some(20),
        },
    )
    .expect("rediscover after reject-only cleanup");
    assert!(
        after
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["runId"] != run_id),
        "an applied Proposal plus rejected remainder must not remain resumable"
    );
}

#[test]
fn apply_commit_rolls_back_all_on_failure() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 1);
    let payloads = [
        event_create_payload("event-ok", "A", "scene-1", 1),
        event_create_payload("event-bad", "B", "scene-1", 99),
    ];
    let pairs = seed_approved_proposals(&db, "run-commit-2", "set-2", &payloads);
    // Second op expects wrong scene version → whole commit fails.
    let ops = vec![
        (pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone()),
        (pairs[1].0.clone(), pairs[1].1.clone(), payloads[1].clone()),
    ];
    let payload = build_prepare("req-fail-1", "digest-fail-1", "set-2", "run-commit-2", ops);
    enable_manual_apply(&db);
    let err = narrative_extraction::narrative_extraction_prepare_commit(&db, payload)
        .expect_err("prepare should fail");
    assert!(err.to_string().contains("NEX_SCENE_VERSION_MISMATCH"));

    let event_count: i64 = db
        .with_conn(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(event_count, 0);

    let commit_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_apply_commits WHERE status = 'failed'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(
        commit_count, 0,
        "failed prepare must not create an apply audit row"
    );
}

#[test]
fn apply_commit_is_idempotent_for_same_request_and_digest() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let payloads = [event_create_payload("event-only", "Only", "scene-1", 0)];
    let pairs = seed_approved_proposals(&db, "run-commit-3", "set-3", &payloads);
    let ops = vec![(pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone())];
    let payload = build_prepare("req-idem-1", "digest-idem-1", "set-3", "run-commit-3", ops);
    let first = prepare_and_apply(&db, payload.clone());
    let second = prepare_and_apply(&db, payload);
    assert_eq!(first["commitId"], second["commitId"]);
    assert_eq!(second["idempotentReplay"], true);

    let event_count: i64 = db
        .with_conn(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(event_count, 1);
}

#[test]
fn apply_commit_rejects_same_request_with_different_digest() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let first_payloads = [event_create_payload("event-only-2", "Only", "scene-1", 0)];
    let first_pairs = seed_approved_proposals(&db, "run-commit-4a", "set-4a", &first_payloads);
    let first_ops = vec![(
        first_pairs[0].0.clone(),
        first_pairs[0].1.clone(),
        first_payloads[0].clone(),
    )];
    prepare_and_apply(
        &db,
        build_prepare(
            "req-conflict-1",
            "digest-a",
            "set-4a",
            "run-commit-4a",
            first_ops,
        ),
    );

    // Same requestId but a different sealed plan must conflict on Native digest.
    let second_payloads = [event_create_payload("event-only-3", "Other", "scene-1", 0)];
    let second_pairs = seed_approved_proposals(&db, "run-commit-4b", "set-4b", &second_payloads);
    let second_ops = vec![(
        second_pairs[0].0.clone(),
        second_pairs[0].1.clone(),
        second_payloads[0].clone(),
    )];
    let second = build_prepare(
        "req-conflict-1",
        "digest-b",
        "set-4b",
        "run-commit-4b",
        second_ops,
    );
    enable_manual_apply(&db);
    let err = narrative_extraction::narrative_extraction_prepare_commit(&db, second)
        .expect_err("conflict");
    assert!(err.to_string().contains("NEX_COMMIT_IDEMPOTENCY_CONFLICT"));
}

#[test]
fn undo_commit_removes_all_events_and_refuses_edited() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let payloads = [
        event_create_payload("event-u1", "A", "scene-1", 0),
        event_create_payload("event-u2", "B", "scene-1", 0),
    ];
    let pairs = seed_approved_proposals(&db, "run-commit-5", "set-5", &payloads);
    let ops = vec![
        (pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone()),
        (pairs[1].0.clone(), pairs[1].1.clone(), payloads[1].clone()),
    ];
    let payload = build_prepare("req-undo-1", "digest-undo-1", "set-5", "run-commit-5", ops);
    let applied = prepare_and_apply(&db, payload);
    let commit_id = applied["commitId"].as_str().unwrap().to_string();

    let undone = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess".to_string(),
            surface: None,
            commit_id: Some(commit_id.clone()),
            request_id: Some("undo-events-initial".to_string()),
        },
    )
    .expect("undo");
    assert_eq!(undone["status"], "undone");

    let event_count: i64 = db
        .with_conn(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(event_count, 0);

    // Redo then edit one event → undo must refuse.
    narrative_extraction::narrative_extraction_redo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess".to_string(),
            surface: None,
            commit_id: Some(commit_id.clone()),
            request_id: Some("redo-events".to_string()),
        },
    )
    .expect("redo");

    db.execute(
        "UPDATE events SET title = 'edited by human', version = version + 1 WHERE id = 'event-u1'",
        &[],
        "run",
    )
    .expect("human edit");

    let refuse = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess".to_string(),
            surface: None,
            commit_id: Some(commit_id),
            request_id: Some("undo-events-edited".to_string()),
        },
    )
    .expect_err("edited refuse");
    assert!(refuse.to_string().contains("NEX_COMMIT_EVENT_EDITED"));

    let remaining: i64 = db
        .with_conn(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(remaining, 2);
}

#[test]
fn legacy_null_run_commit_supports_status_undo_redo_and_idempotent_replay() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let payload =
        event_create_payload("event-legacy-null-run", "Legacy nullable Run", "scene-1", 0);
    let pairs = seed_approved_proposals(
        &db,
        "run-legacy-null-commit",
        "set-legacy-null-commit",
        std::slice::from_ref(&payload),
    );
    let prepare = build_prepare(
        "request-legacy-null-commit",
        "plan-legacy-null-commit",
        "set-legacy-null-commit",
        "run-legacy-null-commit",
        vec![(pairs[0].0.clone(), pairs[0].1.clone(), payload)],
    );
    let applied = prepare_and_apply(&db, prepare.clone());
    let commit_id = applied["commitId"].as_str().expect("commit id").to_string();
    db.execute(
        "UPDATE narrative_apply_commits SET run_id = NULL WHERE id = ?",
        &[Value::String(commit_id.clone())],
        "run",
    )
    .expect("model a historical nullable-run ApplyCommit");

    let status = narrative_extraction::narrative_extraction_get_commit_status(
        &db,
        GetCommitStatusPayload {
            project_id: "project-1".to_string(),
            commit_id: Some(commit_id.clone()),
            request_id: None,
        },
    )
    .expect("legacy NULL run Commit must remain readable");
    assert_eq!(status["status"], "applied");

    let apply_replay = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: "project-1".to_string(),
            prepared_commit_id: commit_id.clone(),
            request_id: prepare.request_id.clone(),
            session_id: prepare.session_id.clone(),
            expected_version: None,
        },
    )
    .expect("legacy NULL run Apply lost-response replay must decode");
    assert_eq!(apply_replay["idempotentReplay"], true);

    let undo_payload = UndoCommitPayload {
        project_id: "project-1".to_string(),
        session_id: "sess-legacy-null-run".to_string(),
        surface: None,
        commit_id: Some(commit_id.clone()),
        request_id: Some("undo-legacy-null-run".to_string()),
    };
    let undone = narrative_extraction::narrative_extraction_undo_commit(&db, undo_payload.clone())
        .expect("legacy NULL run Commit must remain undoable");
    assert_eq!(undone["status"], "undone");
    let undo_replay = narrative_extraction::narrative_extraction_undo_commit(&db, undo_payload)
        .expect("legacy NULL run Undo replay must return its durable receipt");
    assert_eq!(undo_replay, undone);

    let redo_payload = UndoCommitPayload {
        project_id: "project-1".to_string(),
        session_id: "sess-legacy-null-run".to_string(),
        surface: None,
        commit_id: Some(commit_id.clone()),
        request_id: Some("redo-legacy-null-run".to_string()),
    };
    let redone = narrative_extraction::narrative_extraction_redo_commit(&db, redo_payload.clone())
        .expect("legacy NULL run Commit must remain redoable");
    assert_eq!(redone["status"], "redone");
    let redo_replay = narrative_extraction::narrative_extraction_redo_commit(&db, redo_payload)
        .expect("legacy NULL run Redo replay must return its durable receipt");
    assert_eq!(redo_replay, redone);

    let final_state: (Option<String>, String, i64) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT run_id, status,
                        (SELECT COUNT(*) FROM events WHERE id = 'event-legacy-null-run')
                   FROM narrative_apply_commits WHERE id = ?1",
                rusqlite::params![commit_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(Into::into)
        })
        .expect("read final legacy NULL run lifecycle");
    assert_eq!(final_state, (None, "redone".to_string(), 1));
}

#[test]
fn current_chronicle_redo_accepts_catalog_restored_by_its_own_undo() {
    let db = migrated_db();
    let applied = apply_current_chronicle_event(
        &db,
        "run-current-redo-clean",
        "event-current-redo-clean",
        "宿舎が砲撃される",
    );
    let commit_id = applied["commitId"].as_str().expect("commit id").to_string();

    narrative_extraction::narrative_extraction_undo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess-current-redo-clean".to_string(),
            surface: None,
            commit_id: Some(commit_id.clone()),
            request_id: Some("undo-current-redo-clean".to_string()),
        },
    )
    .expect("Undo must remove the original Apply Event");

    let redone = narrative_extraction::narrative_extraction_redo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess-current-redo-clean".to_string(),
            surface: None,
            commit_id: Some(commit_id),
            request_id: Some("redo-current-redo-clean".to_string()),
        },
    )
    .expect("an unchanged post-Undo catalog must permit the exact Redo");
    assert_eq!(redone["status"], "redone");
    let restored: (i64, String) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*), MIN(id) FROM events WHERE project_id = 'project-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(Into::into)
        })
        .expect("read restored Event catalog");
    assert_eq!(restored, (1, "event-current-redo-clean".to_string()));
}

#[test]
fn current_chronicle_redo_rejects_different_id_duplicate_added_after_undo() {
    let db = migrated_db();
    let applied = apply_current_chronicle_event(
        &db,
        "run-current-redo-drift",
        "event-current-redo-original",
        "宿舎が砲撃される",
    );
    let commit_id = applied["commitId"].as_str().expect("commit id").to_string();

    narrative_extraction::narrative_extraction_undo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess-current-redo-drift".to_string(),
            surface: None,
            commit_id: Some(commit_id.clone()),
            request_id: Some("undo-current-redo-drift".to_string()),
        },
    )
    .expect("Undo must remove the original Apply Event");
    db.execute(
        "INSERT INTO events (id, project_id, title, ordinal, version)
         VALUES ('event-current-redo-duplicate', 'project-1', '宿舎が砲撃される', 'a0', 0)",
        &[],
        "run",
    )
    .expect("add a different-id duplicate after Undo");
    let before: (String, i64, i64, i64) = db
        .with_conn(|conn| {
            Ok((
                conn.query_row(
                    "SELECT status FROM narrative_apply_commits WHERE id = ?1",
                    rusqlite::params![commit_id],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT version FROM narrative_apply_commits WHERE id = ?1",
                    rusqlite::params![commit_id],
                    |row| row.get(0),
                )?,
                conn.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?,
                conn.query_row(
                    "SELECT COUNT(*) FROM change_events
                      WHERE op_type = 'narrative.commit.redo'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("read pre-Redo durable state");

    let error = narrative_extraction::narrative_extraction_redo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess-current-redo-drift".to_string(),
            surface: None,
            commit_id: Some(commit_id.clone()),
            request_id: Some("redo-current-redo-drift".to_string()),
        },
    )
    .expect_err("a different-id live duplicate must block Redo before Event DML");
    assert!(error
        .to_string()
        .contains("NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT"));
    let after: (String, i64, i64, i64, i64) = db
        .with_conn(|conn| {
            Ok((
                conn.query_row(
                    "SELECT status FROM narrative_apply_commits WHERE id = ?1",
                    rusqlite::params![commit_id],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT version FROM narrative_apply_commits WHERE id = ?1",
                    rusqlite::params![commit_id],
                    |row| row.get(0),
                )?,
                conn.query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?,
                conn.query_row(
                    "SELECT COUNT(*) FROM events WHERE id = 'event-current-redo-original'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM change_events
                      WHERE op_type = 'narrative.commit.redo'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("read rejected Redo durable state");
    assert_eq!((after.0, after.1, after.2, after.4), before);
    assert_eq!(after.3, 0, "the original Event must remain absent");
}

#[test]
fn undo_commit_retry_returns_the_exact_receipt_before_status_checks() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let payloads = [event_create_payload(
        "event-undo-retry",
        "Retry",
        "scene-1",
        0,
    )];
    let pairs = seed_approved_proposals(&db, "run-undo-retry", "set-undo-retry", &payloads);
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-undo-retry-apply",
            "digest-undo-retry",
            "set-undo-retry",
            "run-undo-retry",
            vec![(pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone())],
        ),
    );
    let commit_id = applied["commitId"].as_str().unwrap().to_string();
    let first_payload = UndoCommitPayload {
        project_id: "project-1".to_string(),
        session_id: "sess-before-restart".to_string(),
        surface: None,
        commit_id: Some(commit_id),
        request_id: Some("undo-action-retry-1".to_string()),
    };
    let mut retry_payload = first_payload.clone();
    retry_payload.session_id = "sess-after-restart".to_string();

    let first = narrative_extraction::narrative_extraction_undo_commit(&db, first_payload)
        .expect("first undo");
    let retry = narrative_extraction::narrative_extraction_undo_commit(&db, retry_payload)
        .expect("retry must replay before status validation");
    assert_eq!(retry, first);
    assert_eq!(retry["status"], "undone");

    db.with_conn(|conn| {
        let canonical_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM change_events
              WHERE project_id = 'project-1'
                AND op_type = 'narrative.commit.undo'",
            [],
            |row| row.get(0),
        )?;
        let feed_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_change_transactions
              WHERE project_id = 'project-1'
                AND source_domain = 'narrative.commit.undo'
                AND request_id = 'undo-action-retry-1'",
            [],
            |row| row.get(0),
        )?;
        let receipt_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM idempotency_requests
              WHERE domain = 'narrative_commit_undo'
                AND request_id = 'undo-action-retry-1'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(canonical_count, 1);
        assert_eq!(feed_count, 1);
        assert_eq!(receipt_count, 1);
        Ok(())
    })
    .expect("inspect undo retry artifacts");
}

#[test]
fn undo_redo_cycles_without_event_edited_false_positive() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let payloads = [
        event_create_payload("event-cycle-1", "A", "scene-1", 0),
        event_create_payload("event-cycle-2", "B", "scene-1", 0),
    ];
    let pairs = seed_approved_proposals(&db, "run-commit-6", "set-6", &payloads);
    let ops = vec![
        (pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone()),
        (pairs[1].0.clone(), pairs[1].1.clone(), payloads[1].clone()),
    ];
    let payload = build_prepare(
        "req-cycle-1",
        "digest-cycle-1",
        "set-6",
        "run-commit-6",
        ops,
    );
    let applied = prepare_and_apply(&db, payload);
    let commit_id = applied["commitId"].as_str().unwrap().to_string();
    let replay_payload = |request_id: String| UndoCommitPayload {
        project_id: "project-1".to_string(),
        session_id: "sess".to_string(),
        surface: None,
        commit_id: Some(commit_id.clone()),
        request_id: Some(request_id),
    };

    for cycle in 1..=2 {
        let undone = narrative_extraction::narrative_extraction_undo_commit(
            &db,
            replay_payload(format!("undo-event-cycle-{cycle}")),
        )
        .unwrap_or_else(|err| panic!("undo cycle {cycle}: {err}"));
        assert_eq!(undone["status"], "undone");

        let event_count: i64 = db
            .with_conn(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(
            event_count, 0,
            "events must be gone after undo cycle {cycle}"
        );

        let redone = narrative_extraction::narrative_extraction_redo_commit(
            &db,
            replay_payload(format!("redo-event-cycle-{cycle}")),
        )
        .unwrap_or_else(|err| panic!("redo cycle {cycle}: {err}"));
        assert_eq!(redone["status"], "redone");

        let event_count: i64 = db
            .with_conn(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(
            event_count, 2,
            "events must be restored after redo cycle {cycle}"
        );

        let versions: Vec<i64> = db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT version FROM events
                      WHERE id IN ('event-cycle-1', 'event-cycle-2')
                      ORDER BY id",
                )?;
                let rows = stmt.query_map([], |row| row.get(0))?;
                rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
            })
            .unwrap();
        // Apply starts at 1; each redo bumps to previous+1.
        assert_eq!(versions, vec![cycle + 1, cycle + 1]);
    }

    // Final undo after two full cycles must still succeed (journal stayed in sync).
    let final_undo = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        replay_payload("undo-event-cycle-final".to_string()),
    )
    .expect("final undo");
    assert_eq!(final_undo["status"], "undone");
}

#[test]
fn append_decision_rejects_stale_revision_when_current_advanced() {
    let db = migrated_db();
    let run_id = "run-occ-1";
    let proposal_set_id = "set-occ-1";
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec-occ".to_string(),
            snapshot_digest: Some("revision-1".to_string()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(format!("{run_id}-task")),
                task_kind: "extract_window".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create run");

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some(proposal_set_id.to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("prop-occ".to_string()),
                proposal_key: "key-occ".to_string(),
                kind: "chronicle.event.create@1".to_string(),
                payload_json: json!({ "title": "Rev1" }),
                reconciliation_envelope: Some(test_envelope(run_id, &format!("{run_id}-task"))),
            }],
        },
    )
    .expect("save");
    let proposal_id = saved["proposals"][0]["proposalId"]
        .as_str()
        .unwrap()
        .to_string();
    let rev1 = saved["proposals"][0]["revisionId"]
        .as_str()
        .unwrap()
        .to_string();

    let rev2 = narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            payload_json: json!({ "title": "Rev2" }),
            expected_current_revision_id: rev1.clone(),
            created_by: Some("test".to_string()),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: None,
        },
    )
    .expect("append rev2");
    let rev2_id = rev2["revisionId"].as_str().unwrap().to_string();
    assert_ne!(rev1, rev2_id);

    let stale = narrative_extraction::narrative_extraction_append_decision(
        &db,
        AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            revision_id: rev1,
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("stale-window".to_string()),
        },
    )
    .expect_err("stale revision must fail");
    assert!(
        stale.to_string().contains("NEX_PROPOSAL_REVISION_MISMATCH"),
        "unexpected error: {stale}"
    );

    let status: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT status FROM narrative_proposals WHERE id = ?1",
                rusqlite::params![proposal_id],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(status, "unreviewed");

    narrative_extraction::narrative_extraction_append_decision(
        &db,
        AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id,
            revision_id: rev2_id,
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("current-window".to_string()),
        },
    )
    .expect("current revision approve");
}

/// Create a run + a single-proposal ProposalSet, returning (proposalId, rev1).
fn seed_single_proposal(
    db: &Database,
    run_id: &str,
    proposal_set_id: &str,
    proposal_id: &str,
) -> (String, String) {
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: format!("spec-{run_id}"),
            snapshot_digest: Some("revision-1".to_string()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(format!("{run_id}-task")),
                task_kind: "extract_window".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create run");

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some(proposal_set_id.to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some(proposal_id.to_string()),
                proposal_key: format!("{proposal_id}-key"),
                kind: "chronicle.event.create@1".to_string(),
                payload_json: json!({ "title": "Rev1" }),
                reconciliation_envelope: Some(test_envelope(run_id, &format!("{run_id}-task"))),
            }],
        },
    )
    .expect("save proposal set");

    let rev1 = saved["proposals"][0]["revisionId"]
        .as_str()
        .unwrap()
        .to_string();
    (proposal_id.to_string(), rev1)
}

fn count_revisions(db: &Database, proposal_id: &str) -> i64 {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM narrative_proposal_revisions WHERE proposal_id = ?1",
            rusqlite::params![proposal_id],
            |row| row.get(0),
        )?)
    })
    .unwrap()
}

#[test]
fn revise_and_decide_approves_atomically_with_new_revision() {
    let db = migrated_db();
    let (proposal_id, rev1) =
        seed_single_proposal(&db, "run-rad-happy", "set-rad-happy", "prop-rad-happy");
    assert_eq!(count_revisions(&db, &proposal_id), 1);

    let result = narrative_extraction::narrative_extraction_revise_and_decide(
        &db,
        ReviseAndDecidePayload {
            run_id: "run-rad-happy".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            payload_json: json!({ "title": "Rev2" }),
            expected_current_revision_id: rev1.clone(),
            decision: "approved".to_string(),
            decision_json: Some(json!({ "source": "test" })),
            created_by: Some("reviewer".to_string()),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: None,
        },
    )
    .expect("revise and decide");

    let new_revision_id = result["revisionId"].as_str().unwrap().to_string();
    assert_ne!(new_revision_id, rev1);
    assert_eq!(result["revisionNumber"], 2);
    assert_eq!(result["decision"], "approved");
    assert_eq!(result["status"], "approved");
    assert_eq!(result["proposalId"], proposal_id);
    assert!(result["decisionId"].is_string());

    // Both writes landed atomically.
    assert_eq!(count_revisions(&db, &proposal_id), 2);

    let (status, current_revision): (String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT status, current_revision_id FROM narrative_proposals WHERE id = ?1",
                rusqlite::params![proposal_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(status, "approved");
    assert_eq!(current_revision, new_revision_id);

    let decision_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_proposal_decisions
                  WHERE proposal_id = ?1 AND revision_id = ?2 AND decision = 'approved'",
                rusqlite::params![proposal_id, new_revision_id],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(decision_count, 1);
}

#[test]
fn revise_and_decide_rolls_back_revision_on_invalid_decision() {
    let db = migrated_db();
    let (proposal_id, rev1) =
        seed_single_proposal(&db, "run-rad-bad", "set-rad-bad", "prop-rad-bad");
    assert_eq!(count_revisions(&db, &proposal_id), 1);

    let err = narrative_extraction::narrative_extraction_revise_and_decide(
        &db,
        ReviseAndDecidePayload {
            run_id: "run-rad-bad".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            payload_json: json!({ "title": "Rev2" }),
            expected_current_revision_id: rev1.clone(),
            decision: "totally-bogus".to_string(),
            decision_json: None,
            created_by: Some("reviewer".to_string()),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: None,
        },
    )
    .expect_err("invalid decision must fail");
    assert!(
        err.to_string().contains("unsupported proposal decision"),
        "unexpected error: {err}"
    );

    // The would-be revision must be rolled back with the failed decision.
    assert_eq!(count_revisions(&db, &proposal_id), 1);

    let (status, current_revision): (String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT status, current_revision_id FROM narrative_proposals WHERE id = ?1",
                rusqlite::params![proposal_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(status, "unreviewed");
    assert_eq!(current_revision, rev1);

    let decision_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_proposal_decisions WHERE proposal_id = ?1",
                rusqlite::params![proposal_id],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(decision_count, 0);
}

#[test]
fn revise_and_decide_rejects_stale_expected_current_revision() {
    let db = migrated_db();
    let (proposal_id, rev1) =
        seed_single_proposal(&db, "run-rad-stale", "set-rad-stale", "prop-rad-stale");

    // Advance the current revision so rev1 becomes stale.
    let rev2 = narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: "run-rad-stale".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            payload_json: json!({ "title": "Rev2" }),
            expected_current_revision_id: rev1.clone(),
            created_by: Some("test".to_string()),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: None,
        },
    )
    .expect("append rev2");
    let rev2_id = rev2["revisionId"].as_str().unwrap().to_string();
    assert_eq!(count_revisions(&db, &proposal_id), 2);

    let err = narrative_extraction::narrative_extraction_revise_and_decide(
        &db,
        ReviseAndDecidePayload {
            run_id: "run-rad-stale".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            payload_json: json!({ "title": "Rev3" }),
            expected_current_revision_id: rev1.clone(),
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("stale-window".to_string()),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: None,
        },
    )
    .expect_err("stale expected revision must conflict");
    assert!(
        err.to_string().contains("NEX_PROPOSAL_REVISION_CONFLICT"),
        "unexpected error: {err}"
    );

    // No third revision, no decision, current stays at rev2, status unreviewed.
    assert_eq!(count_revisions(&db, &proposal_id), 2);

    let (status, current_revision): (String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT status, current_revision_id FROM narrative_proposals WHERE id = ?1",
                rusqlite::params![proposal_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(status, "unreviewed");
    assert_eq!(current_revision, rev2_id);

    let decision_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_proposal_decisions WHERE proposal_id = ?1",
                rusqlite::params![proposal_id],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(decision_count, 0);
}

#[test]
fn get_run_review_bundle_returns_artifacts_proposals_and_latest_decision() {
    let db = test_db();
    create_run_with_task(&db, "run-review-bundle", "task-review-bundle");

    let claim = claim_with_owner(&db, "run-review-bundle", "worker-bundle", 120);
    assert_eq!(claim["claimed"], true);
    let attempt_id = claim["task"]["attemptId"]
        .as_str()
        .expect("attemptId")
        .to_string();

    narrative_extraction::narrative_extraction_finish_task(
        &db,
        FinishTaskPayload {
            run_id: "run-review-bundle".to_string(),
            project_id: "project-1".to_string(),
            task_id: "task-review-bundle".to_string(),
            attempt_id,
            lease_owner: "worker-bundle".to_string(),
            output_json: Some(json!({ "ok": true })),
            artifacts: vec![
                narrative_extraction::ArtifactInput {
                    artifact_id: Some("art-proposals".to_string()),
                    artifact_kind: "chronicle.extract.proposals@1".to_string(),
                    payload_storage: Some("inline-json".to_string()),
                    payload_json: Some(json!({
                        "proposalSetId": "set-review-bundle",
                        "proposals": [{ "eventId": "ev-1", "title": "From artifact" }],
                        "planned": [{
                            "proposal": { "eventId": "ev-1", "title": "From artifact" },
                            "match": { "status": "none" },
                            "hypothesisId": "h-1"
                        }]
                    })),
                    payload_ref: None,
                    payload_digest: None,
                },
                narrative_extraction::ArtifactInput {
                    artifact_id: Some("art-snapshot".to_string()),
                    artifact_kind: "chronicle.extract.snapshot@1".to_string(),
                    payload_storage: Some("inline-json".to_string()),
                    payload_json: Some(json!({ "snapshot": { "documents": [] } })),
                    payload_ref: None,
                    payload_digest: None,
                },
            ],
            chronicle_stage_bundle: None,
            chronicle_stage_receipts: vec![],
            historical_scope_authority_basis: None,
            chronicle_plan_proposal_set: None,
        },
    )
    .expect("finish with artifacts");

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-review-bundle".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-review-bundle".to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("prop-review-1".to_string()),
                proposal_key: "ev-1:0".to_string(),
                kind: "chronicle.event.create@1".to_string(),
                payload_json: json!({ "eventId": "ev-1", "title": "Native title" }),
                reconciliation_envelope: None,
            }],
        },
    )
    .expect("save proposal set");
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .expect("revisionId")
        .to_string();

    narrative_extraction::narrative_extraction_append_decision(
        &db,
        AppendDecisionPayload {
            run_id: "run-review-bundle".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: "prop-review-1".to_string(),
            revision_id: revision_id.clone(),
            decision: "approved".to_string(),
            decision_json: Some(json!({ "source": "test" })),
            created_by: Some("reviewer".to_string()),
        },
    )
    .expect("approve");

    let bundle = narrative_extraction::narrative_extraction_get_run_review_bundle(
        &db,
        RunRefPayload {
            run_id: "run-review-bundle".to_string(),
            project_id: "project-1".to_string(),
            chronicle_blocked_discard: None,
        },
    )
    .expect("get review bundle");

    assert_eq!(bundle["runId"], "run-review-bundle");
    assert_eq!(bundle["projectId"], "project-1");
    let artifacts = bundle["artifacts"].as_array().expect("artifacts");
    assert_eq!(artifacts.len(), 2);
    assert!(artifacts.iter().any(|a| {
        a["artifactKind"] == "chronicle.extract.proposals@1"
            && a["payloadJson"]["proposalSetId"] == "set-review-bundle"
    }));

    assert_eq!(bundle["proposalSet"]["proposalSetId"], "set-review-bundle");
    let proposals = bundle["proposals"].as_array().expect("proposals");
    assert_eq!(proposals.len(), 1);
    assert_eq!(proposals[0]["proposalId"], "prop-review-1");
    assert_eq!(proposals[0]["proposalKey"], "ev-1:0");
    assert_eq!(proposals[0]["status"], "approved");
    assert_eq!(proposals[0]["currentRevisionId"], revision_id);
    assert_eq!(proposals[0]["payloadJson"]["title"], "Native title");
    assert_eq!(proposals[0]["latestDecision"]["decision"], "approved");
    assert_eq!(proposals[0]["latestDecision"]["revisionId"], revision_id);
    assert_eq!(
        proposals[0]["latestDecision"]["decisionJson"]["source"],
        "test"
    );

    let mismatch = narrative_extraction::narrative_extraction_get_run_review_bundle(
        &db,
        RunRefPayload {
            run_id: "run-review-bundle".to_string(),
            project_id: "other-project".to_string(),
            chronicle_blocked_discard: None,
        },
    )
    .expect_err("project mismatch must fail closed");
    assert!(
        mismatch
            .to_string()
            .contains("narrative extraction run project mismatch"),
        "unexpected error: {mismatch}"
    );
}

#[test]
fn get_run_review_bundle_rejects_corrupt_current_chronicle_resume_artifact() {
    let db = test_db();
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some("run-corrupt-resume-artifact".to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({ "folderId": "folder-1", "sceneIds": [] }),
            spec_json: json!({ "domain": "chronicle", "version": 1 }),
            spec_digest: "spec-corrupt-resume-artifact".to_string(),
            snapshot_digest: Some("snapshot-corrupt-resume-artifact".to_string()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some("task-corrupt-resume-artifact".to_string()),
                task_kind: "source.snapshot@1".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create Chronicle run");
    let claim = claim_with_owner(
        &db,
        "run-corrupt-resume-artifact",
        "corrupt-resume-worker",
        120,
    );
    let attempt_id = claim["task"]["attemptId"]
        .as_str()
        .expect("attempt id")
        .to_string();
    narrative_extraction::narrative_extraction_finish_task(
        &db,
        FinishTaskPayload {
            run_id: "run-corrupt-resume-artifact".to_string(),
            project_id: "project-1".to_string(),
            task_id: "task-corrupt-resume-artifact".to_string(),
            attempt_id,
            lease_owner: "corrupt-resume-worker".to_string(),
            output_json: Some(json!({ "snapshotDigest": "snapshot-corrupt-resume-artifact" })),
            artifacts: vec![narrative_extraction::ArtifactInput {
                artifact_id: Some("artifact-corrupt-resume".to_string()),
                artifact_kind: "source.snapshot@1".to_string(),
                payload_storage: Some("inline-json".to_string()),
                payload_json: Some(json!({ "snapshot": { "documents": [] } })),
                payload_ref: None,
                payload_digest: None,
            }],
            chronicle_stage_bundle: None,
            chronicle_stage_receipts: vec![],
            historical_scope_authority_basis: None,
            chronicle_plan_proposal_set: None,
        },
    )
    .expect("finish snapshot task");
    db.execute(
        "UPDATE narrative_extraction_artifacts
            SET payload_digest = ?
          WHERE id = 'artifact-corrupt-resume'",
        &[Value::String(format!("sha256:{}", "0".repeat(64)))],
        "run",
    )
    .expect("corrupt digest");

    let error = narrative_extraction::narrative_extraction_get_run_review_bundle(
        &db,
        RunRefPayload {
            run_id: "run-corrupt-resume-artifact".to_string(),
            project_id: "project-1".to_string(),
            chronicle_blocked_discard: None,
        },
    )
    .expect_err("resume hydration must reject a corrupted canonical artifact digest");
    assert!(
        error
            .to_string()
            .contains("NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT"),
        "unexpected error: {error}"
    );
}

#[test]
fn get_run_review_bundle_hydrates_only_the_verified_current_chronicle_attempt() {
    let db = test_db();
    let run_id = "run-current-artifact-only";
    let task_id = "task-current-artifact-only";
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({ "folderId": "folder-1", "sceneIds": [] }),
            spec_json: json!({ "domain": "chronicle", "version": 1 }),
            spec_digest: "spec-current-artifact-only".to_string(),
            snapshot_digest: Some("snapshot-current-artifact-only".to_string()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(task_id.to_string()),
                task_kind: "source.snapshot@1".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create Chronicle run");
    let claim = claim_with_owner(&db, run_id, "current-artifact-worker", 120);
    let attempt_id = claim["task"]["attemptId"]
        .as_str()
        .expect("current attempt id")
        .to_string();
    let current_payload = json!({ "snapshot": { "documents": ["current"] } });
    narrative_extraction::narrative_extraction_finish_task(
        &db,
        FinishTaskPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            task_id: task_id.to_string(),
            attempt_id,
            lease_owner: "current-artifact-worker".to_string(),
            output_json: Some(json!({ "snapshotDigest": "snapshot-current-artifact-only" })),
            artifacts: vec![narrative_extraction::ArtifactInput {
                artifact_id: Some("artifact-current-attempt".to_string()),
                artifact_kind: "source.snapshot@1".to_string(),
                payload_storage: Some("inline-json".to_string()),
                payload_json: Some(current_payload.clone()),
                payload_ref: None,
                payload_digest: None,
            }],
            chronicle_stage_bundle: None,
            chronicle_stage_receipts: vec![],
            historical_scope_authority_basis: None,
            chronicle_plan_proposal_set: None,
        },
    )
    .expect("finish current Chronicle snapshot attempt");

    // Model an old attempt whose imported/late-written artifact sorts after
    // the completed current Attempt.  It is internally canonical, so merely
    // validating the current row is insufficient if the full Run artifact
    // roster is then returned to the last-write-wins coordinator cache.
    let stale_payload = json!({ "snapshot": { "documents": ["stale"] } });
    let stale_payload_json = serde_json::to_string(&stale_payload).expect("stale payload JSON");
    let stale_payload_digest =
        grimodex_core::canonical_json_digest(&stale_payload).expect("stale canonical digest");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_attempts
                (id, task_id, attempt_number, status, started_at, completed_at, output_json)
             VALUES ('attempt-stale-prior', ?1, 0, 'completed',
                     '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', '{}')",
            [task_id],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_artifacts
                (id, run_id, task_id, attempt_id, artifact_kind, payload_storage,
                 payload_json, payload_ref, payload_digest, created_at)
             VALUES ('artifact-stale-prior', ?1, ?2, 'attempt-stale-prior',
                     'source.snapshot@1', 'inline-json', ?3, NULL, ?4,
                     '2099-01-01T00:00:00.000Z')",
            rusqlite::params![run_id, task_id, stale_payload_json, stale_payload_digest],
        )?;
        Ok(())
    })
    .expect("seed later stale artifact from a prior attempt");

    let bundle = narrative_extraction::narrative_extraction_get_run_review_bundle(
        &db,
        RunRefPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            chronicle_blocked_discard: None,
        },
    )
    .expect("Native hydration must ignore a stale prior-attempt artifact");
    let artifacts = bundle["artifacts"].as_array().expect("artifact roster");
    assert_eq!(
        artifacts.len(),
        1,
        "only the verified current artifact is exposed"
    );
    assert_eq!(artifacts[0]["artifactId"], "artifact-current-attempt");
    assert_eq!(artifacts[0]["payloadJson"], current_payload);
}

#[test]
fn apply_commit_rejects_missing_applications_and_unapproved_payload() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let payloads = [event_create_payload("event-x", "X", "scene-1", 0)];
    let pairs = seed_approved_proposals(&db, "run-failopen", "set-failopen", &payloads);

    let payload = build_prepare(
        "req-failopen-1",
        "digest-failopen-1",
        "set-failopen",
        "run-failopen",
        vec![(pairs[0].0.clone(), pairs[0].1.clone(), payloads[0].clone())],
    );
    let mut payload = payload;
    payload.applications.clear();
    enable_manual_apply(&db);
    let err = narrative_extraction::narrative_extraction_prepare_commit(&db, payload)
        .expect_err("empty applications must fail closed");
    assert!(
        err.to_string().contains("NEX_COMMIT_APPLICATIONS_MISMATCH"),
        "unexpected error: {err}"
    );

    // Unapproved proposal must not apply even with matching applications.
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some("run-unapproved".to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec-unapproved".to_string(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![],
        },
    )
    .expect("create");
    let unapproved_payload = event_create_payload("event-unapproved", "Nope", "scene-1", 0);
    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-unapproved".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-unapproved".to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("prop-unapproved".to_string()),
                proposal_key: "key-unapproved".to_string(),
                kind: "chronicle.event.create@1".to_string(),
                payload_json: unapproved_payload.clone(),
                reconciliation_envelope: None,
            }],
        },
    )
    .expect("save");
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .unwrap()
        .to_string();
    let payload = build_prepare(
        "req-unapproved",
        "digest-unapproved",
        "set-unapproved",
        "run-unapproved",
        vec![(
            "prop-unapproved".to_string(),
            revision_id,
            unapproved_payload,
        )],
    );
    enable_manual_apply(&db);
    let err = narrative_extraction::narrative_extraction_prepare_commit(&db, payload)
        .expect_err("unapproved must fail");
    assert!(
        err.to_string().contains("NEX_PROPOSAL_NOT_APPROVED"),
        "unexpected error: {err}"
    );
}

#[test]
fn apply_commit_rejects_revision_payload_mismatch() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let approved = [event_create_payload("event-m", "M", "scene-1", 0)];
    let pairs = seed_approved_proposals(&db, "run-rev-mismatch", "set-rev-mismatch", &approved);
    let ops = vec![(
        pairs[0].0.clone(),
        pairs[0].1.clone(),
        // Title diverges from approved revision → digest mismatch.
        event_create_payload("event-m", "Different", "scene-1", 0),
    )];
    let payload = build_prepare(
        "req-rev-mismatch",
        "digest-rev-mismatch",
        "set-rev-mismatch",
        "run-rev-mismatch",
        ops,
    );
    enable_manual_apply(&db);
    let err = narrative_extraction::narrative_extraction_prepare_commit(&db, payload)
        .expect_err("title mismatch must fail");
    assert!(
        err.to_string().contains("NEX_PROPOSAL_PAYLOAD_MISMATCH"),
        "unexpected error: {err}"
    );
}

#[test]
fn list_resumable_runs_excludes_applied_completed_runs() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);

    // In-progress run without a ProposalSet is NOT review-resumable.
    create_run_with_task(&db, "run-resumable-pending", "task-resumable-pending");
    db.execute(
        "UPDATE narrative_extraction_runs SET status = 'running' WHERE id = ?",
        &[Value::String("run-resumable-pending".to_string())],
        "run",
    )
    .expect("mark running");

    // Completed + approved but unapplied → resumable.
    let review_payloads = [event_create_payload("event-r", "R", "scene-1", 0)];
    let pairs = seed_approved_proposals(
        &db,
        "run-resumable-review",
        "set-resumable-review",
        &review_payloads,
    );
    db.execute(
        "UPDATE narrative_extraction_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
        &[Value::String("run-resumable-review".to_string())],
        "run",
    )
    .expect("mark completed");

    // Completed + applied → not resumable.
    let applied_payloads = [event_create_payload(
        "event-applied",
        "Applied",
        "scene-1",
        0,
    )];
    let applied_pairs =
        seed_approved_proposals(&db, "run-applied", "set-applied", &applied_payloads);
    let payload = build_prepare(
        "req-applied",
        "digest-applied",
        "set-applied",
        "run-applied",
        vec![(
            applied_pairs[0].0.clone(),
            applied_pairs[0].1.clone(),
            applied_payloads[0].clone(),
        )],
    );
    prepare_and_apply(&db, payload);
    db.execute(
        "UPDATE narrative_extraction_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
        &[Value::String("run-applied".to_string())],
        "run",
    )
    .expect("mark applied completed");

    let listed = narrative_extraction::narrative_extraction_list_resumable_runs(
        &db,
        ListResumableRunsPayload {
            project_id: "project-1".to_string(),
            surface_path_id: Some("chronicle.extract".to_string()),
            limit: Some(20),
        },
    )
    .expect("list");
    let ids: Vec<&str> = listed
        .as_array()
        .expect("array")
        .iter()
        .map(|row| row["runId"].as_str().unwrap())
        .collect();
    assert!(
        !ids.contains(&"run-resumable-pending"),
        "running without ProposalSet must not hide review restores"
    );
    assert!(ids.contains(&"run-resumable-review"));
    assert!(!ids.contains(&"run-applied"));
    // pairs used to keep approved revision alive for review run
    assert!(!pairs.is_empty());
}

#[test]
fn list_resumable_runs_prefers_older_review_over_crashed_running() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);

    // Older completed review with unapplied proposals.
    let review_payloads = [event_create_payload("event-old", "Old", "scene-1", 0)];
    let _pairs = seed_approved_proposals(&db, "run-old-review", "set-old-review", &review_payloads);
    db.execute(
        "UPDATE narrative_extraction_runs
            SET status = 'completed',
                started_at = '2026-01-01T00:00:00.000Z',
                completed_at = '2026-01-01T00:01:00.000Z'
          WHERE id = ?",
        &[Value::String("run-old-review".to_string())],
        "run",
    )
    .expect("mark old completed");

    // Newer crashed running run without ProposalSet.
    create_run_with_task(&db, "run-crash-running", "task-crash-running");
    db.execute(
        "UPDATE narrative_extraction_runs
            SET status = 'running',
                started_at = '2026-01-02T00:00:00.000Z'
          WHERE id = ?",
        &[Value::String("run-crash-running".to_string())],
        "run",
    )
    .expect("mark crash running");

    let listed = narrative_extraction::narrative_extraction_list_resumable_runs(
        &db,
        ListResumableRunsPayload {
            project_id: "project-1".to_string(),
            surface_path_id: Some("chronicle.extract".to_string()),
            limit: Some(20),
        },
    )
    .expect("list");
    let ids: Vec<&str> = listed
        .as_array()
        .expect("array")
        .iter()
        .map(|row| row["runId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["run-old-review"]);
}

#[test]
fn relation_dependencies_in_summary_json_survive_append_revision() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    create_run_with_task(&db, "run-rel-deps", "task-rel-deps");

    let entity_a = "prop-entity-a";
    let entity_b = "prop-entity-b";
    let relation_id = "prop-relation-1";
    let summary = json!({
        "relationDependencies": {
            relation_id: [
                { "kind": "requires-resolution", "proposalId": entity_a },
                { "kind": "requires-resolution", "proposalId": entity_b }
            ]
        }
    });

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-rel-deps".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-rel-deps".to_string()),
            set_kind: "codex.structure.extract.review@1".to_string(),
            summary_json: Some(summary.clone()),
            proposals: vec![
                ProposalSeed {
                    proposal_id: Some(entity_a.to_string()),
                    proposal_key: "entity-a".to_string(),
                    kind: "codex.entity.bind@1".to_string(),
                    payload_json: json!({ "narrativeEntityId": "ne-a", "canonicalName": "ライカ" }),
                    reconciliation_envelope: None,
                },
                ProposalSeed {
                    proposal_id: Some(entity_b.to_string()),
                    proposal_key: "entity-b".to_string(),
                    kind: "codex.entity.bind@1".to_string(),
                    payload_json: json!({ "narrativeEntityId": "ne-b", "canonicalName": "ベルカ" }),
                    reconciliation_envelope: None,
                },
                ProposalSeed {
                    proposal_id: Some(relation_id.to_string()),
                    proposal_key: "relation-1".to_string(),
                    kind: "codex.relation.create@1".to_string(),
                    payload_json: json!({
                        "subjectEntityId": "ne-a",
                        "objectEntityId": "ne-b",
                        "relation": {
                            "relationType": "friend",
                            "directionality": "symmetric",
                            "forwardLabel": "友人",
                            "inverseLabel": "友人"
                        },
                        "validity": "current"
                    }),
                    reconciliation_envelope: None,
                },
            ],
        },
    )
    .expect("save");

    let proposals = saved["proposals"].as_array().expect("proposals");
    assert_eq!(proposals.len(), 3);
    for proposal in proposals {
        let id = proposal["proposalId"].as_str().unwrap();
        assert!(
            id == entity_a || id == entity_b || id == relation_id,
            "stable client proposalId must be preserved, got {id}"
        );
    }

    let relation = proposals
        .iter()
        .find(|row| row["proposalId"] == relation_id)
        .expect("relation");
    let revision_id = relation["revisionId"].as_str().unwrap().to_string();

    // Approve-style revision overwrites domain payload without dependencies.
    narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: "run-rel-deps".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: relation_id.to_string(),
            expected_current_revision_id: revision_id,
            payload_json: json!({
                "kind": "codex.relation.create",
                "fromCodexId": "codex-a",
                "toCodexId": "codex-b",
                "relationType": "friend",
                "forwardLabel": "友人",
                "inverseLabel": "友人",
                "directionality": "symmetric",
                "semanticKey": "friend:a:b"
            }),
            created_by: Some("reviewer".to_string()),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: None,
        },
    )
    .expect("append revision");

    let bundle = narrative_extraction::narrative_extraction_get_run_review_bundle(
        &db,
        RunRefPayload {
            run_id: "run-rel-deps".to_string(),
            project_id: "project-1".to_string(),
            chronicle_blocked_discard: None,
        },
    )
    .expect("bundle");

    let summary_json = &bundle["proposalSet"]["summaryJson"];
    assert_eq!(
        summary_json["relationDependencies"][relation_id][0]["proposalId"],
        entity_a
    );
    assert_eq!(
        summary_json["relationDependencies"][relation_id][1]["proposalId"],
        entity_b
    );

    let relation_row = bundle["proposals"]
        .as_array()
        .expect("proposals")
        .iter()
        .find(|row| row["proposalId"] == relation_id)
        .expect("relation row");
    assert!(
        relation_row["payloadJson"].get("dependencies").is_none(),
        "domain payload must not carry dependencies after approve revision"
    );
}

#[test]
fn client_proposal_ids_collide_across_runs_when_reused() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);

    create_run_with_task(&db, "run-collide-1", "task-collide-1");
    narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-collide-1".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-collide-1".to_string()),
            set_kind: "codex.structure.extract.review@1".to_string(),
            summary_json: Some(json!({ "proposalCount": 1 })),
            proposals: vec![ProposalSeed {
                proposal_id: Some("codex-bind-1".to_string()),
                proposal_key: "entity-1".to_string(),
                kind: "codex.entity.bind@1".to_string(),
                payload_json: json!({ "canonicalName": "ライカ" }),
                reconciliation_envelope: None,
            }],
        },
    )
    .expect("first save should succeed");

    create_run_with_task(&db, "run-collide-2", "task-collide-2");
    let err = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-collide-2".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-collide-2".to_string()),
            set_kind: "codex.structure.extract.review@1".to_string(),
            summary_json: Some(json!({ "proposalCount": 1 })),
            proposals: vec![ProposalSeed {
                proposal_id: Some("codex-bind-1".to_string()),
                proposal_key: "entity-1".to_string(),
                kind: "codex.entity.bind@1".to_string(),
                payload_json: json!({ "canonicalName": "ライカ" }),
                reconciliation_envelope: None,
            }],
        },
    )
    .expect_err("reused client proposalId across runs must violate PRIMARY KEY");
    let message = format!("{err:#}");
    assert!(
        message.contains("UNIQUE")
            || message.contains("unique")
            || message.contains("constraint")
            || message.contains("PRIMARY"),
        "unexpected error: {message}"
    );
}

#[test]
fn distinct_client_proposal_ids_persist_across_consecutive_runs() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);

    create_run_with_task(&db, "run-unique-1", "task-unique-1");
    let first = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-unique-1".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-unique-1".to_string()),
            set_kind: "codex.structure.extract.review@1".to_string(),
            summary_json: Some(json!({ "proposalCount": 1 })),
            proposals: vec![ProposalSeed {
                proposal_id: Some("11111111-1111-4111-8111-111111111111".to_string()),
                proposal_key: "entity-1".to_string(),
                kind: "codex.entity.bind@1".to_string(),
                payload_json: json!({ "canonicalName": "ライカ" }),
                reconciliation_envelope: None,
            }],
        },
    )
    .expect("first unique save");

    create_run_with_task(&db, "run-unique-2", "task-unique-2");
    let second = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-unique-2".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-unique-2".to_string()),
            set_kind: "codex.structure.extract.review@1".to_string(),
            summary_json: Some(json!({ "proposalCount": 1 })),
            proposals: vec![ProposalSeed {
                proposal_id: Some("22222222-2222-4222-8222-222222222222".to_string()),
                proposal_key: "entity-1".to_string(),
                kind: "codex.entity.bind@1".to_string(),
                payload_json: json!({ "canonicalName": "ライカ" }),
                reconciliation_envelope: None,
            }],
        },
    )
    .expect("second unique save");

    assert_eq!(
        first["proposals"][0]["proposalId"],
        "11111111-1111-4111-8111-111111111111"
    );
    assert_eq!(
        second["proposals"][0]["proposalId"],
        "22222222-2222-4222-8222-222222222222"
    );
}

fn seed_deferred_proposal_with_decision(
    db: &Database,
    run_id: &str,
    proposal_set_id: &str,
    proposal_id: &str,
    decision_json: Value,
) {
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: format!("spec-{run_id}"),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![],
        },
    )
    .expect("create run");

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some(proposal_set_id.to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some(proposal_id.to_string()),
                proposal_key: format!("{proposal_id}-key"),
                kind: "chronicle.event.create@1".to_string(),
                payload_json: json!({ "title": "Deferred proposal" }),
                reconciliation_envelope: None,
            }],
        },
    )
    .expect("save proposal set");

    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .unwrap()
        .to_string();

    narrative_extraction::narrative_extraction_append_decision(
        db,
        AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.to_string(),
            revision_id,
            decision: "deferred".to_string(),
            decision_json: Some(decision_json),
            created_by: Some("reviewer".to_string()),
        },
    )
    .expect("defer");
}

#[test]
fn list_resumable_runs_excludes_already_satisfied_deferred_only() {
    let db = migrated_db();

    seed_deferred_proposal_with_decision(
        &db,
        "run-deferred-satisfied",
        "set-deferred-satisfied",
        "prop-deferred-satisfied",
        json!({ "reason": "already-satisfied" }),
    );
    db.execute(
        "UPDATE narrative_extraction_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
        &[Value::String("run-deferred-satisfied".to_string())],
        "run",
    )
    .expect("mark completed");

    seed_deferred_proposal_with_decision(
        &db,
        "run-deferred-open",
        "set-deferred-open",
        "prop-deferred-open",
        json!({ "reason": "needs-more-context" }),
    );
    db.execute(
        "UPDATE narrative_extraction_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
        &[Value::String("run-deferred-open".to_string())],
        "run",
    )
    .expect("mark completed");

    let listed = narrative_extraction::narrative_extraction_list_resumable_runs(
        &db,
        ListResumableRunsPayload {
            project_id: "project-1".to_string(),
            surface_path_id: Some("chronicle.extract".to_string()),
            limit: Some(20),
        },
    )
    .expect("list");
    let ids: Vec<&str> = listed
        .as_array()
        .expect("array")
        .iter()
        .map(|row| row["runId"].as_str().unwrap())
        .collect();

    assert!(
        !ids.contains(&"run-deferred-satisfied"),
        "already-satisfied deferred alone must not keep run resumable"
    );
    assert!(
        ids.contains(&"run-deferred-open"),
        "deferred without already-satisfied must remain resumable"
    );
}
