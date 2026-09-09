use super::{
    binding::{self, BindingRead},
    test_support::Fixture,
    *,
};

#[test]
fn nir1_publication_atomically_binds_vectors_d1_metadata_and_canonical_freshness() {
    let f = Fixture::new();
    let (plan, docs) = f.prepare();
    assert_eq!(docs.len(), 2, "normal approved children");
    let result = publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(docs))
        .expect("audited publication");
    assert!(matches!(
        result,
        NirIndexPublishRead::Published {
            generation: 1,
            candidate_count: 2,
            newly_usable_published: true
        }
    ));
    assert_eq!(f.published_count(), 2);
    f.db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let BindingRead::Registered(binding) = binding::read(&tx,f.project())? else { panic!("complete registration"); };
        assert_eq!(binding.generation,1); assert!(!binding.dirty);
        let state:(String,String,Option<String>) = tx.query_row("SELECT evidence_freshness,build_action,last_evaluated_run_id FROM narrative_consumer_freshness WHERE project_id=?1 AND consumer_kind='semantic-index' AND consumer_key=?2",rusqlite::params![f.project(),INDEX_KEY],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        assert_eq!(state,("fresh".into(),"none".into(),None));
        Ok(())
    }).expect("coherent committed state");
    assert_eq!(f.runtime.lock().expect("runtime").proofs.len(), 1);
    assert_eq!(f.runtime.pause().expect("pause"), [f.project()]);
    assert!(f.runtime.lock().expect("paused").proofs.is_empty());
}

#[test]
fn nir1_partial_or_unaudited_outcomes_cannot_publish_any_pool() {
    for tamper in [false, true] {
        let f = Fixture::new();
        let (plan, docs) = f.prepare();
        let mut outcomes = f.outcomes(docs);
        if tamper {
            let NirEmbeddedDocument::Indexed { embedding, .. } = &mut outcomes[0] else {
                panic!("indexed");
            };
            *embedding = [0.0_f32, 1.0]
                .into_iter()
                .flat_map(f32::to_le_bytes)
                .collect();
        } else {
            outcomes.pop();
        }
        assert!(publish_chronicle_index_build(&f.db, &f.runtime, plan, outcomes).is_err());
        assert_eq!(f.published_count(), 0);
        assert!(f.runtime.lock().expect("runtime").proofs.is_empty());
    }
}

#[test]
fn nir1_typed_token_limit_is_a_complete_audited_non_execution() {
    let f = Fixture::new();
    let (plan, docs) = f.prepare();
    let outcomes = docs.into_iter().map(|doc| f.outcome(doc, true)).collect();
    assert!(matches!(
        publish_chronicle_index_build(&f.db, &f.runtime, plan, outcomes)
            .expect("typed skipped pool"),
        NirIndexPublishRead::Published {
            generation: 1,
            candidate_count: 0,
            newly_usable_published: true
        }
    ));
    assert_eq!(f.published_count(), 0);
}

#[test]
fn nir1_human_withdrawal_during_embedding_discards_the_entire_stale_build() {
    let f = Fixture::new();
    let (plan, docs) = f.prepare();
    let revision = docs[0].revision_id.clone();
    let outcomes = f.outcomes(docs);
    f.hold(&revision);
    assert!(matches!(
        publish_chronicle_index_build(&f.db, &f.runtime, plan, outcomes).expect("stale result"),
        NirIndexPublishRead::Stale
    ));
    assert_eq!(f.published_count(), 0);
}

#[test]
fn nir1_failure_after_canonical_publication_rolls_back_every_derived_surface() {
    let f = Fixture::new();
    let (plan, docs) = f.prepare();
    let outcomes = f.outcomes(docs);
    f.db.with_conn(|conn| {conn.execute_batch("CREATE TEMP TRIGGER nir1_fail_vector BEFORE INSERT ON narrative_nir1_chronicle_vectors BEGIN SELECT RAISE(ABORT,'nir1-test-vector-failure'); END")?;Ok(())}).expect("private failure injection");
    let error = publish_chronicle_index_build(&f.db, &f.runtime, plan, outcomes)
        .expect_err("atomic failure");
    assert!(format!("{error:#}").contains("nir1-test-vector-failure"));
    f.db.with_conn(|conn| {
        assert!(conn.is_autocommit());
        let tx = conn.unchecked_transaction()?;
        assert_eq!(binding::read(&tx, f.project())?, BindingRead::Missing);
        assert_eq!(
            tx.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_declaration_sets WHERE producer_id=?1",
                [PRODUCER_ID],
                |r| r.get::<_, i64>(0)
            )?,
            0
        );
        Ok(())
    })
    .expect("D1 V1 canonical metadata vector rollback");
    assert!(f.runtime.lock().expect("runtime").proofs.is_empty());
}

#[test]
fn nir1_rebuild_advances_d1_and_metadata_together_and_preserves_old_seals() {
    let f = Fixture::new();
    let (plan, docs) = f.prepare();
    let revision = docs[0].revision_id.clone();
    publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(docs))
        .expect("first generation");
    f.hold(&revision);
    let (plan, docs) = f.prepare();
    assert_eq!(docs.len(), 1);
    assert!(matches!(
        publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(docs))
            .expect("new generation"),
        NirIndexPublishRead::Published {
            generation: 2,
            candidate_count: 1,
            newly_usable_published: true
        }
    ));
    assert_eq!(f.published_count(), 1);
    f.db.with_conn(|conn| {
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_declaration_sets WHERE producer_id=?1",
                [PRODUCER_ID],
                |r| r.get::<_, i64>(0)
            )?,
            2
        );
        Ok(())
    })
    .expect("historical immutable generations retained");
}

#[test]
fn nir1_pause_during_embedding_prevents_publication_and_resume_invalidates_old_plan() {
    let f = Fixture::new();
    let (plan, docs) = f.prepare();
    let outcomes = f.outcomes(docs);
    f.runtime.pause().expect("pause");
    f.runtime.resume().expect("resume");
    assert!(matches!(
        publish_chronicle_index_build(&f.db, &f.runtime, plan, outcomes).expect("stale runtime"),
        NirIndexPublishRead::Stale
    ));
    assert_eq!(f.published_count(), 0);
}

#[test]
fn nir1_cold_cache_reuse_still_requires_publication_and_original_audits() {
    for corrupt_vector in [false, true] {
        let f = Fixture::new();
        let (plan, docs) = f.prepare();
        let outcomes = f.outcomes(docs);
        let identity = outcomes[0].identity().clone();
        publish_chronicle_index_build(&f.db, &f.runtime, plan, outcomes)
            .expect("first publication");
        f.runtime.pause().expect("pause");
        f.runtime.resume().expect("cold restart semantics");
        if corrupt_vector {
            f.db.with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_nir1_chronicle_vectors SET embedding=?1",
                    [[0.0_f32, 1.0]
                        .into_iter()
                        .flat_map(f32::to_le_bytes)
                        .collect::<Vec<_>>()],
                )?;
                Ok(())
            })
            .expect("private cache corruption");
        }
        let (plan, docs) = f.prepare();
        let reused =
            f.db.with_read_transaction(|conn| {
                assert!(super::query::current_proof(conn, &f.runtime, f.project())?.is_none());
                read_reusable_chronicle_embeddings(conn, &f.runtime, &plan, &identity)
            })
            .expect("cold admitted reusable outcomes");
        assert_eq!(reused.len(), docs.len());
        assert!(f
            .runtime
            .lock()
            .expect("no live authority from cache")
            .proofs
            .is_empty());
        let result = publish_chronicle_index_build(&f.db, &f.runtime, plan, reused);
        if corrupt_vector {
            assert!(format!(
                "{:#}",
                result.expect_err("audit catches cached vector changes")
            )
            .contains("audit inference outcome mismatch"));
            assert!(f
                .runtime
                .lock()
                .expect("no partial authority")
                .proofs
                .is_empty());
        } else {
            assert!(matches!(
                result.expect("verified cache publication"),
                NirIndexPublishRead::Published {
                    generation: 2,
                    candidate_count: 2,
                    ..
                }
            ));
        }
    }
}

#[test]
fn nir1_reuse_excludes_withdrawn_revision_and_every_model_identity_mismatch() {
    let f = Fixture::new();
    let (plan, docs) = f.prepare();
    let withdrawn = docs[0].revision_id.clone();
    let outcomes = f.outcomes(docs);
    let identity = outcomes[0].identity().clone();
    publish_chronicle_index_build(&f.db, &f.runtime, plan, outcomes).expect("first publication");
    f.hold(&withdrawn);
    let (plan, docs) = f.prepare();
    assert_eq!(docs.len(), 1);
    for field in 0..5 {
        let mut changed = identity.clone();
        match field {
            0 => changed.model_id.push_str("-different"),
            1 => changed.artifact_sha256 = "c".repeat(64),
            2 => changed.tokenizer_sha256 = "c".repeat(64),
            3 => changed.embedding_dim += 1,
            _ => changed.chunker_version.push_str("-different"),
        }
        let reused =
            f.db.with_read_transaction(|conn| {
                read_reusable_chronicle_embeddings(conn, &f.runtime, &plan, &changed)
            })
            .expect("mismatch");
        assert!(reused.is_empty());
    }
    let reused =
        f.db.with_read_transaction(|conn| {
            read_reusable_chronicle_embeddings(conn, &f.runtime, &plan, &identity)
        })
        .expect("matching current input");
    assert_eq!(reused.len(), 1);
    assert_ne!(reused[0].document().revision_id, withdrawn);
    assert!(matches!(
        publish_chronicle_index_build(&f.db, &f.runtime, plan, reused).expect("reused recovery"),
        NirIndexPublishRead::Published {
            generation: 2,
            candidate_count: 1,
            ..
        }
    ));
}

#[test]
fn nir1_compact_publication_rejects_changed_root_material_and_terminal_inputs() {
    for mutation in [
        "UPDATE narrative_extraction_artifacts SET payload_digest='changed-after-cold-replay'",
        "UPDATE narrative_extraction_tasks SET status='failed' WHERE status='completed'",
        "UPDATE narrative_consumer_freshness SET build_action='revalidate-exact' WHERE consumer_kind='proposal-revision'",
        "UPDATE narrative_dependency_edges SET read_set_json='[\"changed\"]' WHERE consumer_kind='proposal-revision'",
    ] {
        let f = Fixture::new();
        let (plan,docs) = f.prepare();
        let outcomes = f.outcomes(docs);
        f.db.with_conn(|conn| {assert!(conn.execute(mutation,[])?>0);Ok(())}).expect("private intervening mutation");
        assert!(matches!(publish_chronicle_index_build(&f.db,&f.runtime,plan,outcomes).expect("discard changed cold inputs"),NirIndexPublishRead::Stale),"{mutation}");
        assert_eq!(f.published_count(),0);
        assert!(f.runtime.lock().expect("no capability").proofs.is_empty());
    }
}

#[test]
fn nir1_rebuild_waits_for_pending_sources_of_candidates_that_become_excluded() {
    use crate::domain_writes::{tree_node_patch, TreeNodePatchPayload};
    use crate::narrative_extraction::change_feed::NarrativeChangeOrigin;
    use crate::narrative_extraction::incremental_freshness::run_incremental_freshness_cycle;
    use serde_json::json;

    let f = Fixture::new();
    let (plan, docs) = f.prepare();
    publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(docs))
        .expect("published baseline");
    let event = uuid::Uuid::new_v4().to_string();
    tree_node_patch(&f.db, TreeNodePatchPayload {
        project_id: f.project().into(), request_id: format!("nir1-pending-{event}"),
        session_id: "nir1-pending-build".into(), event_uid: event,
        node_id: f.manifest["s1"].as_str().expect("source").into(),
        patch: json!({"content": "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"changed supporting source\"}]}]}"})
            .as_object().expect("patch").clone(),
        base_version: None, bump_version: true,
        updated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        change_event: None, timelapse_doc_step_coverage: None,
        origin: NarrativeChangeOrigin::Human, original_transaction_id: None,
        undo_journal_id: None, source_domain: None, op_type: None, canonical_payload: None,
    }).expect("ordinary source writer and sealed Feed event");
    f.db.with_read_transaction(|conn| {
        assert!(matches!(prepare_chronicle_index_build(conn, &f.runtime, f.project())?,
            NirIndexBuildRead::Unavailable { reason: NirIndexUnavailableReason::PendingChange }),
            "the now-ineligible source still belongs to the previous whole pool; do not publish a temporary empty generation ahead of its Feed processing");
        Ok(())
    }).expect("pending publication precheck");
    assert_eq!(f.published_count(), 2, "no intermediate generation");
    for _ in 0..4 {
        run_incremental_freshness_cycle(&f.db).expect("ordinary canonical Feed processing");
    }
    let (plan, docs) = f.prepare();
    assert!(
        docs.is_empty(),
        "both fixture revisions depend on the edited scene"
    );
    assert!(matches!(
        publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(docs))
            .expect("one final excluded publication"),
        NirIndexPublishRead::Published {
            generation: 2,
            candidate_count: 0,
            ..
        }
    ));
}

#[test]
fn nir1_new_scope_projection_keeps_run_binding_through_publication_and_current_proof() {
    use crate::narrative_extraction::{
        narrative_extraction_append_human_decision,
        narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization_auto,
        AppendDecisionPayload, CreateHumanDerivedRevisionRequest, NarrativeAdapterIdentity,
    };
    let f = Fixture::new();
    let mut parent = f.manifest["revisionIds"][0]
        .as_str()
        .expect("original child")
        .to_owned();
    let mut proposal = String::new();
    let mut scope_children = Vec::new();
    for secret in [true, false] {
        let (id,digest,raw):(String,String,String)=f.db.with_conn(|c|Ok(c.query_row(
            "SELECT proposal_id,reconciliation_envelope_digest,payload_json FROM narrative_proposal_revisions WHERE id=?1",
            [&parent],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?)).expect("Native parent");
        proposal = id;
        let mut payload: serde_json::Value = serde_json::from_str(&raw).expect("payload");
        payload["disclosure"]["secret"] = serde_json::json!(secret);
        let result=narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization_auto(
            &f.db,f.project(),CreateHumanDerivedRevisionRequest {
                proposal_id:proposal.clone(),expected_current_revision_id:parent.clone(),parent_revision_id:parent,
                expected_parent_envelope_digest:digest,proposal_payload:payload,
                adapter:NarrativeAdapterIdentity {id:"chronicle.scene-event".into(),version:"1".into()},surface_id:"chronicle-review".into(),
            }).expect("new Scope child");
        parent = result["revisionId"].as_str().expect("child").into();
        scope_children.push(parent.clone());
    }
    let (_, unapproved) = f.prepare();
    assert!(
        !unapproved.iter().any(|d| d.revision_id == parent),
        "ancestor approval cannot approve the child"
    );
    narrative_extraction_append_human_decision(
        &f.db,
        AppendDecisionPayload {
            run_id: f.manifest["runId"].as_str().expect("Run").into(),
            project_id: f.project().into(),
            proposal_id: proposal,
            revision_id: parent.clone(),
            decision: "approved".into(),
            decision_json: None,
            created_by: None,
        },
    )
    .expect("explicit child approval");
    let (plan, docs) = f.prepare();
    assert!(docs.iter().any(|d| d.revision_id == parent));
    let controls = plan
        .snapshot
        .edges
        .iter()
        .filter(|e| e.source_object_identity.starts_with("scope-dependency:v1:"))
        .collect::<Vec<_>>();
    assert_eq!(controls.len(), 1);
    assert_eq!(
        controls[0].owning_run_id.as_deref(),
        f.manifest["runId"].as_str()
    );
    let result = publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(docs))
        .expect("new-source publication");
    assert!(matches!(
        result,
        NirIndexPublishRead::Published {
            candidate_count: 2,
            ..
        }
    ));
    f.db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        assert!(
            super::query::current_proof(&tx, &f.runtime, f.project())?.is_some(),
            "current proof accepts the exact new D1 generation and Run-bound Source"
        );
        Ok(())
    })
    .expect("query-ready new contract");
    assert_scope_batch_matches_single_reads_after_write_and_rollback(&f, &scope_children);
}

fn assert_scope_batch_matches_single_reads_after_write_and_rollback(
    f: &Fixture,
    children: &[String],
) {
    use crate::narrative_extraction::{
        dependency_edges::find_edges_by_consumer,
        restore_rebuild::{evaluate_edge_from_db, evaluate_owned_edges_from_db_in_tx},
    };
    f.db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut edges = Vec::new();
        for revision in children {
            edges.extend(find_edges_by_consumer(
                &tx,
                f.project(),
                "proposal-revision",
                revision,
            )?);
        }
        assert_eq!(
            edges
                .iter()
                .filter(|edge| edge
                    .source_object_identity
                    .starts_with("scope-dependency:v1:"))
                .count(),
            2,
            "two different normal Scope projections share the batch authority"
        );
        let single = || {
            edges
                .iter()
                .map(|edge| {
                    evaluate_edge_from_db(
                        &tx,
                        f.project(),
                        edge.owning_run_id.as_deref().unwrap_or(""),
                        edge,
                    )
                })
                .collect::<anyhow::Result<Vec<_>>>()
        };
        let before = single()?;
        assert_eq!(
            evaluate_owned_edges_from_db_in_tx(&tx, f.project(), &edges)?,
            before
        );
        tx.execute_batch("SAVEPOINT scope_batch_change")?;
        tx.execute(
            "UPDATE tree_nodes SET archived_at='2026-09-08T00:00:00.000Z' WHERE id=?1",
            [f.manifest["s1"].as_str().expect("anchor")],
        )?;
        let changed = single()?;
        assert_ne!(
            changed, before,
            "current reference validity must change the verdict"
        );
        assert_eq!(
            evaluate_owned_edges_from_db_in_tx(&tx, f.project(), &edges)?,
            changed,
            "a separate batch cannot reuse pre-write authority in the same transaction"
        );
        tx.execute_batch("ROLLBACK TO scope_batch_change; RELEASE scope_batch_change")?;
        assert_eq!(
            evaluate_owned_edges_from_db_in_tx(&tx, f.project(), &edges)?,
            before,
            "the rolled-back authority cannot escape its batch either"
        );
        let mut wrong_run = edges
            .iter()
            .find(|edge| {
                edge.source_object_identity
                    .starts_with("scope-dependency:v1:")
            })
            .expect("Scope edge")
            .clone();
        wrong_run.owning_run_id = Some("unrelated-run".into());
        assert!(
            evaluate_owned_edges_from_db_in_tx(&tx, f.project(), &[wrong_run]).is_err(),
            "shared project authority cannot substitute for each sealed Run binding"
        );
        Ok(())
    })
    .expect("same-snapshot batch equivalence and authority lifetime");
}

#[test]
fn nir1_runless_republication_rejects_corrupt_registration_before_edge_writes() {
    let f = Fixture::new();
    let (plan, docs) = f.prepare();
    publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(docs))
        .expect("initial publication");
    f.db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let edges = super::super::dependency_edges::find_edges_by_consumer(
            &tx, f.project(), "semantic-index", INDEX_KEY,
        )?;
        let observations = edges.into_iter().map(|edge| (edge.id,
            super::super::evaluator::EdgeObservation {
                freshness: super::super::evaluator::EvidenceFreshness::Fresh,
                reason_code: None,
                build_action: super::super::evaluator::BuildAction::None,
            },
        )).collect::<Vec<_>>();
        let epoch = super::super::semantic_epoch::get_current_epoch(&tx, f.project())?
            .expect("current epoch").id;
        tx.execute(
            "UPDATE narrative_semantic_index_metadata SET producer_id='corrupt' WHERE project_id=?1",
            [f.project()],
        )?;
        let before = tx.total_changes();
        let error = super::super::publish_runtime::publish_complete_runless_freshness_in_tx(
            &tx, f.project(), "semantic-index", INDEX_KEY, &observations, &epoch,
            "2026-09-08T00:00:00.000Z",
        ).expect_err("corrupt registration cannot publish even a complete set");
        assert!(error.to_string().contains("RESERVED_CONSUMER"));
        assert_eq!(tx.total_changes(), before);
        Ok(())
    }).expect("registration remains mandatory before batch writes");
}
