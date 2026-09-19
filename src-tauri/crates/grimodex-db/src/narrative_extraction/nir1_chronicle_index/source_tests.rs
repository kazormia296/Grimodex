use std::{io::Read, path::PathBuf};

use flate2::read::GzDecoder;
use serde_json::Value;

use super::source::{read_eligibility_source, read_eligibility_source_with_control};
use crate::narrative_extraction::nir1_entity_relation_index::{
    GraphWorkControl, GraphWorkStage,
};
use crate::narrative_extraction::{validation_terminated, ValidationTerminationReason};
use crate::Database;

struct Fixture {
    db: Database,
    path: PathBuf,
    manifest: Value,
}

impl Fixture {
    fn new() -> Self {
        let mut bytes = Vec::new();
        GzDecoder::new(
            include_bytes!("../../../tests/support/nir1-reviewed-child-cold.db.gz").as_slice(),
        )
        .read_to_end(&mut bytes)
        .expect("normal UI cold fixture");
        let path = std::env::temp_dir().join(format!("nir1-source-{}.db", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).expect("private fixture copy");
        let db = Database::new(&path).expect("private fixture through Database");
        db.migrate().expect("migrate and backfill private fixture");
        Self {
            db,
            path,
            manifest: serde_json::from_str(include_str!(
                "../../../tests/support/nir1-reviewed-child-cold.json"
            ))
            .expect("normal UI provenance"),
        }
    }

    fn project(&self) -> &str {
        self.manifest["projectId"].as_str().expect("project")
    }

    fn token(&self) -> String {
        let project_id = self.project().to_owned();
        self.db
            .with_read_transaction(|tx| Ok(read_eligibility_source(tx, &project_id)?.digest))
            .expect("Source digest")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

struct MultiCandidateFixture {
    db: Database,
    path: PathBuf,
    manifest: Value,
}

impl MultiCandidateFixture {
    fn new() -> Self {
        let mut bytes = Vec::new();
        GzDecoder::new(
            include_bytes!("../../../tests/support/nir1-two-window-cold.db.gz").as_slice(),
        )
        .read_to_end(&mut bytes)
        .expect("two-window cold fixture");
        let path = std::env::temp_dir().join(format!(
            "nir1-source-two-window-{}.db",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, bytes).expect("private two-window fixture copy");
        let db = Database::new(&path).expect("private two-window fixture through Database");
        db.migrate().expect("migrate two-window fixture");
        Self {
            db,
            path,
            manifest: serde_json::from_str(include_str!(
                "../../../tests/support/nir1-two-window-cold.json"
            ))
            .expect("two-window provenance"),
        }
    }

    fn project(&self) -> &str {
        self.manifest["projectId"].as_str().expect("project")
    }

    fn approved_revisions(&self) -> Vec<String> {
        self.manifest["normalApprovedChildren"]
            .as_array()
            .expect("approved children")
            .iter()
            .map(|child| child["revisionId"].as_str().expect("revision").to_owned())
            .collect()
    }
}

impl Drop for MultiCandidateFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[test]
fn nir1_eligibility_source_is_deterministic_and_not_freshness_authority() {
    let f = Fixture::new();
    let token = f.token();
    assert_eq!(token, f.token());
    assert!(token.starts_with("sha256:") && token.len() == 71);
    // Negative private-copy mutation: changing canonical status must not
    // invent a second Freshness authority in this logical Source digest.
    f.db
        .with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_consumer_freshness SET evidence_freshness='unknown',build_action='manual'",
                [],
            )?;
            Ok(())
        })
        .expect("private freshness change");
    assert_eq!(token, f.token());
}

#[test]
fn nir1_eligibility_source_tracks_current_own_decision_identity_and_authority() {
    let f = Fixture::new();
    let token = f.token();
    let child = f.manifest["revisionIds"][0].as_str().expect("child");
    f.db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_proposal_decisions SET actor_id='wrong-actor' WHERE revision_id=?1",
            [child],
        )?;
        Ok(())
    })
    .expect("private negative actor mutation");
    assert_ne!(token, f.token());
    let actor_changed = f.token();
    f.db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_proposal_decisions SET id=id || '-replaced' WHERE revision_id=?1",
            [child],
        )?;
        Ok(())
    })
    .expect("private negative identity mutation");
    assert_ne!(actor_changed, f.token());
}

#[test]
fn nir1_eligibility_source_keeps_unapproved_current_roster_and_detects_withdrawal() {
    let f = Fixture::new();
    let token = f.token();
    f.db.with_conn(|conn| {
        conn.execute("UPDATE narrative_proposals SET status='rejected'", [])?;
        Ok(())
    })
    .expect("private withdrawal-shaped state");
    assert_ne!(token, f.token());
    let project_id = f.project().to_owned();
    let source =
        f.db.with_read_transaction(|tx| read_eligibility_source(tx, &project_id))
            .expect("unapproved roster");
    assert_eq!(
        source.revisions.len(),
        2,
        "unapproved identities must not disappear from Source dependencies"
    );
}

#[test]
fn nir1_eligibility_source_does_not_treat_a_missing_project_as_usable_empty() {
    let f = Fixture::new();
    f.db.with_read_transaction(|tx| {
        assert!(read_eligibility_source(tx, "missing-project").is_err());
        assert!(read_eligibility_source(tx, "").is_err());
        Ok(())
    })
    .expect("missing project source checks");
}

#[test]
fn nir1_eligibility_source_requires_one_caller_owned_snapshot() {
    let f = Fixture::new();
    let project_id = f.project().to_owned();
    f.db.with_conn(|conn| {
        assert!(read_eligibility_source(conn, &project_id).is_err());
        Ok(())
    })
    .expect("caller-owned snapshot check");
}

#[test]
fn nir1_chronicle_source_preserves_typed_lifecycle_stop() {
    struct Stop;
    impl GraphWorkControl for Stop {
        fn check(&mut self, _stage: GraphWorkStage) -> anyhow::Result<()> {
            Err(validation_terminated(
                ValidationTerminationReason::Cancelled,
                "test stop before roster scan",
            ))
        }
    }

    let f = Fixture::new();
    let project_id = f.project().to_owned();
    f.db.with_read_transaction(|tx| {
        let mut stop = Stop;
        let error = read_eligibility_source_with_control(tx, &project_id, &mut stop)
            .expect_err("stopped lifecycle must not produce Source");
        assert!(crate::narrative_extraction::is_validation_terminated(&error));
        Ok(())
    })
    .expect("typed stop check");
}

#[test]
fn nir1_compact_build_admission_matches_the_cold_reader_for_each_scene() {
    use crate::narrative_extraction::{
        material_membership::{read_revision_material_membership, MaterialMembershipRead},
        project_scope_authority::load_live_project_scope_authority,
        retrieval_admission::{
            build::{finalize_build_candidate, preflight_build_candidate},
            read_retrieval_query_context, read_revision_retrieval_eligibility,
            RetrievalQueryContextRead, RevisionEligibilityRead,
        },
    };
    let f = MultiCandidateFixture::new();
    let project_id = f.project().to_owned();
    f.db.with_read_transaction(|tx| {
        let authority = load_live_project_scope_authority(
            tx,
            &project_id,
            &format!("project:scope-authority:{project_id}"),
        )
        .expect("live scope");
        let revisions = f.approved_revisions();
        let mut material_source_keys = Vec::new();
        for revision in &revisions {
            if let MaterialMembershipRead::Complete(membership) =
                read_revision_material_membership(tx, &project_id, revision)?
            {
                material_source_keys.extend(
                    membership
                        .materials
                        .iter()
                        .map(|material| material.source_key.clone()),
                );
            }
        }
        let material_scope_cache =
            crate::narrative_extraction::scene_scope::preload_material_scene_scopes(
                tx,
                &project_id,
                &material_source_keys,
            )
            .expect("material scope cache");
        let scenes = tx
            .prepare(
                "SELECT id FROM tree_nodes WHERE project_id=?1 AND node_type='scene' ORDER BY id",
            )
            .expect("scenes")
            .query_map([project_id.as_str()], |row| row.get::<_, String>(0))
            .expect("scene rows")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("scene ids");
        let mut admitted = 0;
        let mut denied = 0;
        for revision in revisions {
            let preflight = preflight_build_candidate(tx, &project_id, &revision, &authority)
                .expect("cold build")
                .expect("normal approved child");
            let candidate = finalize_build_candidate(
                tx,
                &project_id,
                &authority,
                preflight,
                &material_scope_cache,
            )
            .expect("cold build")
            .expect("normal approved child");
            for scene in &scenes {
                let compact =
                    match read_retrieval_query_context(tx, &project_id, scene).expect("query") {
                        RetrievalQueryContextRead::Available(query) => candidate.admits(&query),
                        RetrievalQueryContextRead::Unavailable { .. } => false,
                    };
                let cold = read_revision_retrieval_eligibility(tx, &project_id, &revision, scene)
                    .expect("cold admission");
                assert_eq!(
                    compact,
                    matches!(cold, RevisionEligibilityRead::Eligible(_)),
                    "{revision} at {scene}"
                );
                if let RevisionEligibilityRead::Eligible(value) = cold {
                    assert_eq!(value.document(), &candidate.document);
                    assert_eq!(value.evidence(), candidate.evidence);
                    assert_eq!(value.current_decision_id(), candidate.current_decision_id);
                    admitted += 1;
                } else {
                    denied += 1;
                }
            }
        }
        assert!(
            admitted > 0 && denied > 0,
            "both admission boundaries must be exercised"
        );
        Ok(())
    })
    .expect("compact build admission snapshot");
}

#[test]
fn nir1_read_snapshot_preloads_shared_material_scopes_once() {
    use std::collections::BTreeSet;

    let f = Fixture::new();
    let project_id = f.project().to_owned();
    crate::narrative_extraction::MATERIAL_SCOPE_PRELOAD_QUERY_COUNT.with(|count| count.set(0));
    let candidate_scene_ids =
        f.db.with_read_transaction(|tx| {
            let snapshot = super::build::read_snapshot(tx, &project_id)?
                .expect("read snapshot with approved candidates");
            anyhow::ensure!(
                snapshot.candidates.len() >= 2,
                "regression fixture must contain multiple candidates"
            );
            Ok(snapshot
                .candidates
                .iter()
                .flat_map(|candidate| {
                    candidate
                        .material_scopes
                        .iter()
                        .map(|scope| scope.binding.scene_id.clone())
                })
                .collect::<Vec<_>>())
        })
        .expect("read shared material-scope snapshot");
    let unique_scene_ids = candidate_scene_ids.iter().collect::<BTreeSet<_>>();
    assert!(
        candidate_scene_ids.len() > unique_scene_ids.len(),
        "regression fixture must have candidates sharing a material scene"
    );
    assert_eq!(
        crate::narrative_extraction::MATERIAL_SCOPE_PRELOAD_QUERY_COUNT.with(|count| count.get()),
        1,
        "read_snapshot must preload unique material scopes once"
    );
}

#[test]
fn nir1_read_snapshot_filters_ineligible_missing_scope_before_global_preload() {
    use std::collections::BTreeSet;

    use crate::narrative_extraction::material_membership::{
        read_revision_material_membership, MaterialMembershipRead,
    };

    let f = MultiCandidateFixture::new();
    let project_id = f.project().to_owned();
    let revisions = f.approved_revisions();
    let missing_scene =
        f.db.with_read_transaction(|tx| {
            let first = match read_revision_material_membership(tx, &project_id, &revisions[0])? {
                MaterialMembershipRead::Complete(value) => value,
                MaterialMembershipRead::Unavailable { .. } => {
                    anyhow::bail!("first fixture membership must be complete")
                }
            };
            let second = match read_revision_material_membership(tx, &project_id, &revisions[1])? {
                MaterialMembershipRead::Complete(value) => value,
                MaterialMembershipRead::Unavailable { .. } => {
                    anyhow::bail!("second fixture membership must be complete")
                }
            };
            let first_scenes = first
                .materials
                .iter()
                .filter_map(|material| material.source_key.strip_prefix("project:scene:"))
                .collect::<BTreeSet<_>>();
            second
                .materials
                .iter()
                .filter_map(|material| material.source_key.strip_prefix("project:scene:"))
                .find(|scene_id| !first_scenes.contains(*scene_id))
                .map(str::to_owned)
                .ok_or_else(|| {
                    anyhow::anyhow!("fixture needs a scene unique to the ineligible candidate")
                })
        })
        .expect("unique ineligible material scene");
    f.db.with_conn(|conn| {
        // Keep the sealed membership complete while making this roster
        // entry ineligible; its scope row is then missing as well.
        conn.execute(
            "UPDATE narrative_proposals SET status='rejected' WHERE current_revision_id=?1",
            [&revisions[1]],
        )?;
        let deleted = conn.execute(
            "DELETE FROM narrative_scene_scope_bindings WHERE project_id=?1 AND scene_id=?2",
            rusqlite::params![project_id, missing_scene],
        )?;
        anyhow::ensure!(
            deleted == 1,
            "ineligible fixture scene scope row must be deleted"
        );
        Ok(())
    })
    .expect("make ineligible candidate scope unavailable");
    crate::narrative_extraction::MATERIAL_SCOPE_PRELOAD_QUERY_COUNT.with(|count| count.set(0));
    crate::narrative_extraction::MATERIAL_MEMBERSHIP_READ_COUNT.with(|count| count.set(0));
    let candidate_revisions =
        f.db.with_read_transaction(|tx| {
            let snapshot = super::build::read_snapshot(tx, &project_id)?
                .expect("valid candidate must survive ineligible scope corruption");
            anyhow::ensure!(
                snapshot.candidates.len() == 1,
                "only the approved candidate should remain"
            );
            Ok(snapshot
                .candidates
                .iter()
                .map(|candidate| candidate.revision_id.clone())
                .collect::<Vec<_>>())
        })
        .expect("filtered read snapshot");
    assert_eq!(candidate_revisions, vec![revisions[0].clone()]);
    assert_eq!(
        crate::narrative_extraction::MATERIAL_SCOPE_PRELOAD_QUERY_COUNT.with(|count| count.get()),
        1,
        "scope preload must cover only preliminary-approved candidates"
    );
    assert_eq!(
        crate::narrative_extraction::MATERIAL_MEMBERSHIP_READ_COUNT.with(|count| count.get()),
        revisions.len() + 1,
        "the source digest and each roster membership must be replayed once before finalization"
    );
}

#[test]
fn nir1_read_snapshot_keeps_unaffected_preflight_candidate_when_scope_is_missing() {
    use std::collections::BTreeSet;

    use crate::narrative_extraction::material_membership::{
        read_revision_material_membership, MaterialMembershipRead,
    };

    let f = MultiCandidateFixture::new();
    let project_id = f.project().to_owned();
    let revisions = f.approved_revisions();
    let missing_scene =
        f.db.with_read_transaction(|tx| {
            let first = match read_revision_material_membership(tx, &project_id, &revisions[0])? {
                MaterialMembershipRead::Complete(value) => value,
                MaterialMembershipRead::Unavailable { .. } => {
                    anyhow::bail!("first fixture membership must be complete")
                }
            };
            let second = match read_revision_material_membership(tx, &project_id, &revisions[1])? {
                MaterialMembershipRead::Complete(value) => value,
                MaterialMembershipRead::Unavailable { .. } => {
                    anyhow::bail!("second fixture membership must be complete")
                }
            };
            let first_scenes = first
                .materials
                .iter()
                .filter_map(|material| material.source_key.strip_prefix("project:scene:"))
                .collect::<BTreeSet<_>>();
            second
                .materials
                .iter()
                .filter_map(|material| material.source_key.strip_prefix("project:scene:"))
                .find(|scene_id| !first_scenes.contains(*scene_id))
                .map(str::to_owned)
                .ok_or_else(|| {
                    anyhow::anyhow!("fixture needs a scene unique to the second candidate")
                })
        })
        .expect("unique second-candidate material scene");
    f.db.with_conn(|conn| {
        let deleted = conn.execute(
            "DELETE FROM narrative_scene_scope_bindings WHERE project_id=?1 AND scene_id=?2",
            rusqlite::params![project_id, missing_scene],
        )?;
        anyhow::ensure!(
            deleted == 1,
            "second candidate scene scope row must be deleted"
        );
        Ok(())
    })
    .expect("make one preflight candidate scope unavailable");
    crate::narrative_extraction::MATERIAL_SCOPE_PRELOAD_QUERY_COUNT.with(|count| count.set(0));
    crate::narrative_extraction::MATERIAL_MEMBERSHIP_READ_COUNT.with(|count| count.set(0));
    let candidate_revisions =
        f.db.with_read_transaction(|tx| {
            let snapshot = super::build::read_snapshot(tx, &project_id)?
                .expect("unaffected candidate must survive missing scope");
            anyhow::ensure!(
                snapshot.candidates.len() == 1,
                "only the candidate with a complete scope cache should remain"
            );
            Ok(snapshot
                .candidates
                .iter()
                .map(|candidate| candidate.revision_id.clone())
                .collect::<Vec<_>>())
        })
        .expect("preflight-valid scope snapshot");
    assert_eq!(candidate_revisions, vec![revisions[0].clone()]);
    assert_eq!(
        crate::narrative_extraction::MATERIAL_SCOPE_PRELOAD_QUERY_COUNT.with(|count| count.get()),
        1,
        "both candidates must share one scope preload"
    );
    assert_eq!(
        crate::narrative_extraction::MATERIAL_MEMBERSHIP_READ_COUNT.with(|count| count.get()),
        revisions.len() + 1,
        "the source digest and both preflight memberships must be replayed exactly once"
    );
}

#[test]
fn nir1_read_snapshot_keeps_unaffected_candidate_when_existing_scope_row_is_corrupt() {
    use std::collections::BTreeSet;

    use crate::narrative_extraction::material_membership::{
        read_revision_material_membership, MaterialMembershipRead,
    };

    let f = MultiCandidateFixture::new();
    let project_id = f.project().to_owned();
    let revisions = f.approved_revisions();
    let (corrupt_scene, query_scene) =
        f.db.with_read_transaction(|tx| {
            let first = match read_revision_material_membership(tx, &project_id, &revisions[0])? {
                MaterialMembershipRead::Complete(value) => value,
                MaterialMembershipRead::Unavailable { .. } => {
                    anyhow::bail!("first fixture membership must be complete")
                }
            };
            let second = match read_revision_material_membership(tx, &project_id, &revisions[1])? {
                MaterialMembershipRead::Complete(value) => value,
                MaterialMembershipRead::Unavailable { .. } => {
                    anyhow::bail!("second fixture membership must be complete")
                }
            };
            let first_scenes = first
                .materials
                .iter()
                .filter_map(|material| material.source_key.strip_prefix("project:scene:"))
                .map(str::to_owned)
                .collect::<BTreeSet<_>>();
            let query_scene = tx.query_row(
                "SELECT id FROM tree_nodes
                  WHERE project_id=?1 AND node_type='scene'
                  ORDER BY sort_order DESC, id DESC LIMIT 1",
                [&project_id],
                |row| row.get::<_, String>(0),
            )?;
            let corrupt_scene = second
                .materials
                .iter()
                .filter_map(|material| material.source_key.strip_prefix("project:scene:"))
                .find(|scene_id| !first_scenes.contains(*scene_id))
                .map(str::to_owned)
                .ok_or_else(|| {
                    anyhow::anyhow!("fixture needs a scene unique to the second candidate")
                })?;
            Ok((corrupt_scene, query_scene))
        })
        .expect("disjoint candidate material scenes");
    f.db.with_conn(|conn| {
        conn.execute_batch("PRAGMA ignore_check_constraints=ON")?;
        let update_result = conn.execute(
            "UPDATE narrative_scene_scope_bindings
                    SET knowledge_holder_json=?3
                  WHERE project_id=?1 AND scene_id=?2",
            rusqlite::params![project_id, corrupt_scene, "{"],
        );
        let restore_result = conn.execute_batch("PRAGMA ignore_check_constraints=OFF");
        restore_result?;
        let updated = update_result?;
        anyhow::ensure!(
            updated == 1,
            "second candidate scope row must remain present while corrupt"
        );
        Ok(())
    })
    .expect("corrupt one existing material scope row");
    crate::narrative_extraction::MATERIAL_SCOPE_PRELOAD_QUERY_COUNT.with(|count| count.set(0));
    crate::narrative_extraction::MATERIAL_MEMBERSHIP_READ_COUNT.with(|count| count.set(0));
    let candidate_revisions =
        f.db.with_read_transaction(|tx| {
            let snapshot = super::build::read_snapshot(tx, &project_id)?
                .expect("unaffected candidate must survive corrupt scope");
            anyhow::ensure!(
                snapshot.candidates.len() == 1,
                "only the candidate with a valid scope cache should remain"
            );
            Ok(snapshot
                .candidates
                .iter()
                .map(|candidate| candidate.revision_id.clone())
                .collect::<Vec<_>>())
        })
        .expect("preflight-valid corrupt scope snapshot");
    assert_eq!(candidate_revisions, vec![revisions[0].clone()]);
    assert_eq!(
        crate::narrative_extraction::MATERIAL_SCOPE_PRELOAD_QUERY_COUNT.with(|count| count.get()),
        1,
        "both candidates must share one scope preload"
    );
    assert_eq!(
        crate::narrative_extraction::MATERIAL_MEMBERSHIP_READ_COUNT.with(|count| count.get()),
        revisions.len() + 1,
        "the source digest and both preflight memberships must be replayed exactly once"
    );

    let cold =
        f.db.with_read_transaction(|tx| {
            crate::narrative_extraction::read_revision_retrieval_eligibility(
                tx,
                &project_id,
                &revisions[1],
                &query_scene,
            )
        })
        .expect("corrupt scope is a normal cold-admission denial");
    assert!(matches!(
        cold,
        crate::narrative_extraction::RevisionEligibilityRead::Unavailable {
            reason:
                crate::narrative_extraction::RevisionEligibilityReason::MaterialAuthorityUnavailable
        }
    ));
}

#[test]
fn nir1_read_snapshot_keeps_unaffected_candidate_when_existing_scope_version_is_real() {
    use std::collections::BTreeSet;

    use crate::narrative_extraction::material_membership::{
        read_revision_material_membership, MaterialMembershipRead,
    };

    let f = MultiCandidateFixture::new();
    let project_id = f.project().to_owned();
    let revisions = f.approved_revisions();
    let (corrupt_scene, query_scene) =
        f.db.with_read_transaction(|tx| {
            let first = match read_revision_material_membership(tx, &project_id, &revisions[0])? {
                MaterialMembershipRead::Complete(value) => value,
                MaterialMembershipRead::Unavailable { .. } => {
                    anyhow::bail!("first fixture membership must be complete")
                }
            };
            let second = match read_revision_material_membership(tx, &project_id, &revisions[1])? {
                MaterialMembershipRead::Complete(value) => value,
                MaterialMembershipRead::Unavailable { .. } => {
                    anyhow::bail!("second fixture membership must be complete")
                }
            };
            let first_scenes = first
                .materials
                .iter()
                .filter_map(|material| material.source_key.strip_prefix("project:scene:"))
                .map(str::to_owned)
                .collect::<BTreeSet<_>>();
            let query_scene = tx.query_row(
                "SELECT id FROM tree_nodes
                  WHERE project_id=?1 AND node_type='scene'
                  ORDER BY sort_order DESC, id DESC LIMIT 1",
                [&project_id],
                |row| row.get::<_, String>(0),
            )?;
            let corrupt_scene = second
                .materials
                .iter()
                .filter_map(|material| material.source_key.strip_prefix("project:scene:"))
                .find(|scene_id| !first_scenes.contains(*scene_id))
                .map(str::to_owned)
                .ok_or_else(|| {
                    anyhow::anyhow!("fixture needs a scene unique to the second candidate")
                })?;
            Ok((corrupt_scene, query_scene))
        })
        .expect("disjoint candidate material scenes");
    f.db.with_conn(|conn| {
        conn.execute_batch("PRAGMA ignore_check_constraints=ON")?;
        let update_result = conn.execute(
            "UPDATE narrative_scene_scope_bindings
                    SET version=?3
                  WHERE project_id=?1 AND scene_id=?2",
            rusqlite::params![project_id, corrupt_scene, 1.5_f64],
        );
        let restore_result = conn.execute_batch("PRAGMA ignore_check_constraints=OFF");
        restore_result?;
        let updated = update_result?;
        anyhow::ensure!(
            updated == 1,
            "second candidate scope row must remain present with REAL version"
        );
        Ok(())
    })
    .expect("persist REAL version corruption only in private fixture");
    crate::narrative_extraction::MATERIAL_SCOPE_PRELOAD_QUERY_COUNT.with(|count| count.set(0));
    crate::narrative_extraction::MATERIAL_MEMBERSHIP_READ_COUNT.with(|count| count.set(0));
    let candidate_revisions =
        f.db.with_read_transaction(|tx| {
            let snapshot = super::build::read_snapshot(tx, &project_id)?
                .expect("unaffected candidate must survive REAL scope version");
            anyhow::ensure!(
                snapshot.candidates.len() == 1,
                "only the candidate with a valid scope cache should remain"
            );
            Ok(snapshot
                .candidates
                .iter()
                .map(|candidate| candidate.revision_id.clone())
                .collect::<Vec<_>>())
        })
        .expect("preflight-valid REAL version snapshot");
    assert_eq!(candidate_revisions, vec![revisions[0].clone()]);
    assert_eq!(
        crate::narrative_extraction::MATERIAL_SCOPE_PRELOAD_QUERY_COUNT.with(|count| count.get()),
        1,
        "both candidates must share one scope preload"
    );
    assert_eq!(
        crate::narrative_extraction::MATERIAL_MEMBERSHIP_READ_COUNT.with(|count| count.get()),
        revisions.len() + 1,
        "the source digest and both preflight memberships must be replayed exactly once"
    );

    let cold =
        f.db.with_read_transaction(|tx| {
            crate::narrative_extraction::read_revision_retrieval_eligibility(
                tx,
                &project_id,
                &revisions[1],
                &query_scene,
            )
        })
        .expect("REAL scope version is a normal cold-admission denial");
    assert!(matches!(
        cold,
        crate::narrative_extraction::RevisionEligibilityRead::Unavailable {
            reason:
                crate::narrative_extraction::RevisionEligibilityReason::MaterialAuthorityUnavailable
        }
    ));
}

#[test]
fn nir1_scope_sql_failures_propagate_from_both_readers() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};

    let f = Fixture::new();
    let project_id = f.project().to_owned();
    let revision_id = f.manifest["revisionIds"][0]
        .as_str()
        .expect("revision")
        .to_owned();
    // s2 is after the child's material source; s1 correctly denies before
    // material preload with SourceNotBeforeQuery.
    let query_scene_id = f.manifest["s2"].as_str().expect("query scene").to_owned();
    crate::narrative_extraction::MATERIAL_SCOPE_PRELOAD_QUERY_COUNT.with(|count| count.set(0));
    f.db.with_conn(|conn| {
        conn.authorizer(Some(|context: AuthContext<'_>| {
            if matches!(
                context.action,
                AuthAction::Read {
                    table_name: "narrative_scene_scope_bindings",
                    ..
                }
            ) && crate::narrative_extraction::MATERIAL_SCOPE_PRELOAD_QUERY_COUNT
                .with(|count| count.get() > 0)
            {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }))?;
        let snapshot_result = {
            let tx = conn.unchecked_transaction()?;
            let result = super::build::read_snapshot(&tx, &project_id);
            anyhow::ensure!(
                result.is_err(),
                "scope-table authorizer failure must escape read_snapshot"
            );
            result
        };
        drop(snapshot_result);
        crate::narrative_extraction::MATERIAL_SCOPE_PRELOAD_QUERY_COUNT.with(|count| count.set(0));
        let eligibility_result = {
            let tx = conn.unchecked_transaction()?;
            let result = crate::narrative_extraction::read_revision_retrieval_eligibility(
                &tx,
                &project_id,
                &revision_id,
                &query_scene_id,
            );
            anyhow::ensure!(
                result.is_err(),
                "material scope preload authorizer failure must escape cold retrieval reader"
            );
            result
        };
        drop(eligibility_result);
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
        Ok(())
    })
    .expect("scope-table authorizer failures");
}
