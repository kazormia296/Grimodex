use super::*;
use crate::narrative_extraction::{
    narrative_extraction_list_redecidable_proposals, narrative_extraction_list_scene_proposals,
    nir1_chronicle_index::test_support::Fixture, ListRedecidableProposalsPayload,
    ListSceneProposalsPayload, RedecidableProposalPage,
};

fn page(db: &Database, project: &str, cursor: Option<String>, limit: Option<u32>) -> anyhow::Result<RedecidableProposalPage> {
    narrative_extraction_list_redecidable_proposals(db, ListRedecidableProposalsPayload {
        project_id: project.into(), cursor, limit,
    })
}

fn verify_readers(
    fixture: &Fixture, proposal: &str, revision: &str, reason: Option<&str>, removal: bool,
) -> anyhow::Result<()> {
    let project = fixture.project();
    let db = &fixture.db;
    let scene = narrative_extraction_list_scene_proposals(db, ListSceneProposalsPayload {
        project_id: project.into(), scene_id: fixture.manifest["s1"].as_str().unwrap().into(),
        cursor: None, limit: None,
    })?;
    let item = serde_json::to_value(scene.items.iter().find(|item| item.proposal_id == proposal).unwrap())?;
    let bundle = get_run_review_bundle(db, fixture.manifest["runId"].as_str().unwrap().into(), project.into())?;
    let review = bundle["proposals"].as_array().unwrap().iter().find(|row| row["proposalId"] == proposal).unwrap();
    for key in ["reapproval", "removedVia", "rejectedAt", "rejectedBy"] {
        assert_eq!(item.get(key).unwrap(), review.get(key).unwrap());
    }
    assert_eq!(item["reapproval"], json!({"available":reason.is_none(),"reason":reason}));
    assert_eq!(item["rejectedBy"], json!(removal.then_some("event-removed")));
    assert_eq!(item["removedVia"], json!(removal.then_some("screen-delete")));
    assert_eq!(item["rejectedAt"], if removal { review["latestDecision"]["createdAt"].clone() } else { Value::Null });
    let list = page(db, project, None, None)?;
    let listed = list.items.iter().find(|item| item.proposal_id == proposal);
    assert_eq!(listed.is_some(), reason.is_none());
    if let Some(listed) = listed {
        assert_eq!(listed.revision_id, revision);
        assert_eq!(item["rejectedAt"], listed.rejected_at.as_str());
    }
    if let Some(reason) = reason {
        let result = narrative_extraction_reapprove_applied_proposals(db, ReapproveAppliedProposalsPayload {
            project_id: project.into(), targets: vec![ChronicleBulkApproveTarget {
                proposal_id: proposal.into(), revision_id: revision.into(),
            }],
        }, &mut || false)?;
        assert_reapproval_skip(&result, proposal, reason);
    }
    Ok(())
}

#[test]
fn scene_review_and_project_reads_agree_with_reapproval() -> anyhow::Result<()> {
    let fixture = Fixture::new();
    let db = &fixture.db;
    let project = fixture.project();
    let run = fixture.manifest["runId"].as_str().unwrap();
    let revisions: Vec<String> = serde_json::from_value(fixture.manifest["revisionIds"].clone())?;
    let revision = &revisions[0];
    let proposal: String = db.with_conn(|conn| Ok(conn.query_row(
        "SELECT proposal_id FROM narrative_proposal_revisions WHERE id=?1", [revision], |row| row.get(0),
    )?))?;
    enable_manual_apply_for_test(db);
    verify_readers(&fixture, &proposal, revision, Some("no-application"), false)?;
    chronicle_apply_revisions::prepare_and_apply_revisions(db, project, run, &revisions, "import");
    verify_readers(&fixture, &proposal, revision, Some("already-approved"), false)?;
    let event: String = db.with_conn(|conn| Ok(conn.query_row(
        "SELECT applied_entity_id FROM narrative_proposal_applications WHERE revision_id=?1", [revision], |row| row.get(0),
    )?))?;
    let journal = screen_delete_in_project(db, project, &[&event], false)?;
    verify_readers(&fixture, &proposal, revision, Some("event-missing"), true)?;
    replay_in_project(db, project, &journal, "undo", "restore")?;
    verify_readers(&fixture, &proposal, revision, None, true)?;

    db.with_conn(|conn| {
        conn.execute("INSERT INTO narrative_proposal_applications
            (id,commit_id,proposal_id,revision_id,applied_entity_kind,applied_entity_id,created_at)
            SELECT 'other-revision',commit_id,proposal_id,?2,'event',applied_entity_id,created_at
            FROM narrative_proposal_applications WHERE proposal_id=?1", params![proposal, revisions[1]])?;
        Ok(())
    })?;
    verify_readers(&fixture, &proposal, revision, Some("revision-changed"), true)?;
    db.with_conn(|conn| {
        conn.execute("INSERT INTO narrative_proposal_applications
            (id,commit_id,proposal_id,revision_id,applied_entity_kind,applied_entity_id,created_at,
             application_kind,compensates_application_id)
            SELECT 'undo-'||id,commit_id,proposal_id,revision_id,'event',applied_entity_id,created_at,'compensation',id
            FROM narrative_proposal_applications WHERE proposal_id=?1 AND application_kind='normal'", [&proposal])?;
        Ok(())
    })?;
    verify_readers(&fixture, &proposal, revision, Some("no-application"), true)?;
    db.with_conn(|conn| {
        conn.execute("INSERT INTO narrative_proposal_applications
            (id,commit_id,proposal_id,revision_id,applied_entity_kind,applied_entity_id,created_at)
            SELECT 'live-again',commit_id,proposal_id,revision_id,'event',applied_entity_id,created_at
            FROM narrative_proposal_applications WHERE revision_id=?1 AND application_kind='normal' LIMIT 1", [revision])?;
        conn.execute("INSERT INTO narrative_proposal_decisions
            (id,proposal_id,revision_id,decision,decision_json,created_at,created_by,actor_kind,actor_id,authority_scope)
            SELECT 'author-rejection',proposal_id,revision_id,decision,decision_json,'2999-01-01',
                   'electron:human-review','human','electron:human-review',authority_scope
              FROM narrative_proposal_decisions WHERE proposal_id=?1 AND decision='rejected'", [&proposal])?;
        Ok(())
    })?;
    verify_readers(&fixture, &proposal, revision, Some("not-removal-rejection"), false)?;
    // A missing proposal has no item on any read surface.
    verify_absent(&fixture, "absent")?;
    Ok(())
}

fn verify_absent(fixture: &Fixture, id: &str) -> anyhow::Result<()> {
    let db = &fixture.db;
    let project = fixture.project();
    let scene = narrative_extraction_list_scene_proposals(db, ListSceneProposalsPayload {
        project_id: project.into(), scene_id: fixture.manifest["s1"].as_str().unwrap().into(),
        cursor: None, limit: None,
    })?;
    let bundle = get_run_review_bundle(db, fixture.manifest["runId"].as_str().unwrap().into(), project.into())?;
    assert!(scene.items.iter().all(|item| item.proposal_id != id));
    assert!(bundle["proposals"].as_array().unwrap().iter().all(|p| p["proposalId"] != id));
    assert!(page(db, project, None, None)?.items.iter().all(|item| item.proposal_id != id));
    let result = narrative_extraction_reapprove_applied_proposals(db, ReapproveAppliedProposalsPayload {
        project_id: project.into(), targets: vec![ChronicleBulkApproveTarget { proposal_id: id.into(), revision_id:"absent-rev".into() }],
    }, &mut || false)?;
    assert_reapproval_skip(&result, id, "proposal-not-found");
    Ok(())
}

#[test]
fn project_pages_and_legacy_review_follow_their_contracts() -> anyhow::Result<()> {
    let db = human_import_ids(&["three", "one", "extra", "two"], |envelope| {
        let evidence: Vec<_> = (0..17).rev().map(|n| json!({
            "sourceKey": format!("project:scene:scene-{n:02}"), "quote": "private evidence",
        })).collect();
        envelope["effectiveMaterialBasis"] = json!({"evidenceSet": evidence});
    })?;
    let journal = screen_delete(&db, &["event-three", "event-one", "event-two"], true)?;
    replay(&db, &journal, "undo", "restore")?;
    execute(&db, "INSERT INTO projects (id, title) VALUES ('other','Other project')")?;
    let other = page(&db, "other", None, None)?;
    assert_eq!(other.total, 0);
    assert!(other.items.is_empty());
    assert_eq!(other.limit, 20);
    assert_eq!(page(&db, PROJECT, None, Some(u32::MAX))?.limit, 50);
    assert!(page(&db, PROJECT, None, Some(0)).unwrap_err().to_string().starts_with("NEX_REDECIDABLE_PROPOSALS_INPUT_INVALID"));
    assert!(serde_json::from_value::<ListRedecidableProposalsPayload>(json!({"projectId":PROJECT,"sceneId":"unexpected"})).is_err());
    let mut cursor = None;
    for (id, more) in [("one", true), ("three", true), ("two", false)] {
        let p = page(&db, PROJECT, cursor, Some(1))?;
        assert_eq!(p.total, 3);
        assert_eq!(p.items.len(), 1);
        let item = &p.items[0];
        assert_eq!(item.proposal_id, id);
        assert_eq!(item.title.as_deref(), Some(id));
        assert_eq!(item.evidence_scene_ids, (0..16).map(|n| format!("scene-{n:02}")).collect::<Vec<_>>());
        assert!(item.evidence_scene_ids_truncated);
        assert_eq!(serde_json::to_value(item)?.as_object().unwrap().len(), 7);
        assert_eq!(p.next_cursor.as_deref(), more.then_some(id));
        cursor = p.next_cursor;
    }
    // Older or unrecognized display metadata cannot change eligibility.
    for (suffix, detail) in [("1", json!({"cause":"event-removed"})),
                             ("2", json!({"cause":"event-removed","removedVia":"unexpected"}))] {
        db.with_conn(|conn| {
            conn.execute("INSERT INTO narrative_proposal_decisions
                (id,proposal_id,revision_id,decision,decision_json,created_at,created_by,actor_kind,actor_id,authority_scope)
                SELECT ?1,proposal_id,revision_id,decision,?2,?3,created_by,actor_kind,actor_id,authority_scope
                FROM narrative_proposal_decisions WHERE proposal_id='two' AND decision='rejected' LIMIT 1",
                params![format!("metadata-{suffix}"), detail.to_string(), format!("2999-01-0{suffix}")])?;
            Ok(())
        })?;
        let list = page(&db, PROJECT, None, None)?;
        let item = list.items.iter().find(|item| item.proposal_id == "two").unwrap();
        assert!(serde_json::to_value(item)?["removedVia"].is_null());
    }
    let result = reapprove(&db, &["one"])?;
    assert_eq!(result["approved"].as_array().unwrap().len(), 1);
    let list = page(&db, PROJECT, None, None)?;
    assert_eq!(list.total, 2);
    assert!(list.items.iter().all(|item| item.proposal_id != "one"));
    let bundle = get_run_review_bundle(&db, "existence-run".into(), PROJECT.into())?;
    assert_eq!(bundle["proposals"].as_array().unwrap().len(), 4);
    for row in bundle["proposals"].as_array().unwrap() {
        for key in ["reapproval", "removedVia", "rejectedBy", "rejectedAt"] {
            assert!(row.get(key).is_none());
        }
    }
    Ok(())
}

#[test]
#[ignore = "measures one native read against 5,000 live Applications"]
fn measure_first_redecidable_page_5000_applications() -> anyhow::Result<()> {
    let ids: Vec<_> = (0..25).map(|n| format!("p-{n:02}")).collect();
    let db = human_import_ids(&ids.iter().map(String::as_str).collect::<Vec<_>>(), |_| {})?;
    let events: Vec<_> = ids.iter().map(|id| format!("event-{id}")).collect();
    let journal = screen_delete(&db, &events.iter().map(String::as_str).collect::<Vec<_>>(), true)?;
    replay(&db, &journal, "undo", "restore")?;
    execute(&db, "WITH RECURSIVE copies(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM copies WHERE n<199)
        INSERT INTO narrative_proposal_applications
            (id,commit_id,proposal_id,revision_id,applied_entity_kind,applied_entity_id,created_at)
        SELECT a.id||'-copy-'||n,commit_id,proposal_id,revision_id,'event',applied_entity_id,created_at
        FROM narrative_proposal_applications a CROSS JOIN copies")?;
    let count: i64 = db.with_conn(|conn| Ok(conn.query_row(
        "SELECT count(*) FROM narrative_proposal_applications", [], |row| row.get(0),
    )?))?;
    assert_eq!(count, 5000);
    let start = std::time::Instant::now();
    let first = page(&db, PROJECT, None, None)?;
    eprintln!("5,000 Applications, 25 eligible proposals, 20 items: {:?}", start.elapsed());
    assert_eq!(first.total, 25);
    assert_eq!(first.items.len(), 20);
    assert!(first.next_cursor.is_some());
    Ok(())
}
