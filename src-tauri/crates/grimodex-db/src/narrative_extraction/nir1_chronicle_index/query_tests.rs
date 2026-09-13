use super::{test_support::Fixture, *};
use crate::narrative_extraction::{
    read_narrative_scene_scope, update_narrative_scene_scope, NarrativeSceneScopeUpdatePayload,
};
use grimodex_core::narrative_scene_scope::NarrativeScopeConstraintV1;

fn publish(f: &Fixture) {
    let (plan, docs) = f.prepare();
    assert!(matches!(
        publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(docs)).expect("publish"),
        NirIndexPublishRead::Published {
            newly_usable_published: true,
            ..
        }
    ));
}

#[test]
fn nir1_maintenance_hint_survives_query_release_and_observes_real_dirty_state() {
    let f = Fixture::new();
    let hint = || {
        f.db.with_read_transaction(|conn| f.runtime.rebuild_requested(conn, f.project()))
            .expect("scheduling hint")
    };
    assert_eq!(hint(), Some(true));
    publish(&f);
    assert_eq!(hint(), Some(false));
    // No query batch, lease or S2 is retained by this maintenance owner.
    let revision = f.manifest["children"][0]["revisionId"].as_str();
    let revision=revision.map(str::to_owned).unwrap_or_else(||f.db.with_conn(|conn|
        Ok(conn.query_row("SELECT revision_id FROM narrative_nir1_chronicle_vectors ORDER BY revision_id LIMIT 1",[],|r|r.get::<_,String>(0))?)).expect("published revision"));
    f.hold(&revision);
    assert_eq!(hint(), Some(true));
    publish(&f);
    assert_eq!(hint(), Some(false));
    f.runtime.pause().expect("pause");
    assert_eq!(hint(), None);
    f.runtime.resume().expect("resume");
    assert_eq!(
        hint(),
        Some(true),
        "cold private capability must be reconstructed"
    );
}

fn query(f: &Fixture, scene: &str) -> NirQualifiedRead {
    f.db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        qualify_chronicle_index_query(&tx, &f.runtime, f.project(), scene)
    })
    .expect("query snapshot")
}

fn batch(f: &Fixture) -> NirQualifiedBatch {
    let NirQualifiedRead::Qualified(batch) = query(f, f.manifest["s2"].as_str().expect("S2"))
    else {
        panic!("usable S2 query");
    };
    batch
}

fn valid(f: &Fixture, batch: &NirQualifiedBatch) -> bool {
    f.db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        validate_chronicle_query_snapshot(&tx, &f.runtime, batch)
    })
    .expect("currentness")
}

fn captured(f: &Fixture, scene: &str) -> NirQuerySnapshot {
    f.db.with_read_transaction(|conn| {
        let NirQueryStatusRead::Available {
            snapshot: Some(snapshot),
            ..
        } = read_chronicle_query_status(conn, &f.runtime, f.project(), scene)?
        else {
            panic!("usable first snapshot")
        };
        Ok(snapshot)
    })
    .expect("capture original query")
}

#[test]
fn nir1_bound_scoring_never_replaces_the_original_query_or_generation() {
    let f = Fixture::new();
    publish(&f);
    let s2 = f.manifest["s2"].as_str().expect("S2");
    let original = captured(&f, s2);
    let other = captured(&f, f.manifest["s1"].as_str().expect("S1"));
    let batch =
        f.db.with_read_transaction(|conn| {
            let NirQualifiedRead::Qualified(batch) =
                qualify_chronicle_index_snapshot(conn, &f.runtime, &original)?
            else {
                panic!("original snapshot qualifies")
            };
            assert_eq!(batch.documents().len(), 2);
            assert!(validate_chronicle_bound_batch(
                conn, &f.runtime, &original, &batch
            )?);
            assert!(
                !validate_chronicle_bound_batch(conn, &f.runtime, &other, &batch)?,
                "same proof cannot borrow another S2"
            );
            Ok(batch)
        })
        .expect("bound scoring");
    f.hold(batch.documents()[0].revision_id());
    publish(&f);
    let current = captured(&f, s2);
    f.db.with_read_transaction(|conn| {
        assert!(
            matches!(
                qualify_chronicle_index_snapshot(conn, &f.runtime, &original)?,
                NirQualifiedRead::Unavailable { .. }
            ),
            "new publication cannot replace the first snapshot"
        );
        let NirQualifiedRead::Qualified(next) =
            qualify_chronicle_index_snapshot(conn, &f.runtime, &current)?
        else {
            panic!("new query qualifies after rebuild")
        };
        assert_eq!(next.documents().len(), 1);
        assert!(!validate_chronicle_bound_batch(
            conn, &f.runtime, &original, &next
        )?);
        assert!(!validate_chronicle_bound_batch(
            conn, &f.runtime, &current, &batch
        )?);
        Ok(())
    })
    .expect("generation binding");
}

#[test]
fn nir1_bound_scoring_rechecks_source_and_runtime_before_lending_vectors() {
    for change in ["source", "runtime"] {
        let f = Fixture::new();
        publish(&f);
        let s2 = f.manifest["s2"].as_str().expect("S2");
        let original = captured(&f, s2);
        if change == "runtime" {
            f.runtime.pause().expect("pause");
        } else {
            f.db.with_conn(|conn| {
                conn.execute(
                    "UPDATE tree_nodes SET content='changed query body' WHERE id=?1",
                    [s2],
                )?;
                Ok(())
            })
            .expect("private missing-writer negative");
        }
        f.db.with_read_transaction(|conn| {
            assert!(
                matches!(
                    qualify_chronicle_index_snapshot(conn, &f.runtime, &original)?,
                    NirQualifiedRead::Unavailable { .. }
                ),
                "{change}"
            );
            Ok(())
        })
        .expect("original capability revalidated");
    }
}

#[test]
fn nir1_native_query_admits_the_whole_material_before_lending_vectors_and_evidence() {
    let f = Fixture::new();
    publish(&f);
    let batch = batch(&f);
    assert_eq!(batch.documents().len(), 2);
    assert!(valid(&f, &batch));
    let NirQualifiedRead::Qualified(earlier) = query(&f, f.manifest["s1"].as_str().expect("S1"))
    else {
        panic!("usable empty earlier query");
    };
    assert!(
        earlier.documents().is_empty(),
        "forbidden material never reaches scoring"
    );
    for document in batch.documents() {
        assert_eq!(document.embedding().len(), 8);
        assert!(!document.evidence_handles().is_empty());
        for handle in document.evidence_handles() {
            f.db.with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                let NirEvidenceNavigationRead::Available(navigation) =
                    read_chronicle_evidence_navigation(&tx, &f.runtime, handle)?
                else {
                    panic!("current full Evidence");
                };
                assert_eq!(navigation.scene_id, f.manifest["s1"].as_str().expect("S1"));
                assert_eq!(
                    navigation.end_utf16 - navigation.start_utf16,
                    navigation.quote.encode_utf16().count()
                );
                assert!(!navigation.quote.is_empty());
                Ok(())
            })
            .expect("exact qualified Evidence range");
        }
    }
}

#[test]
fn nir1_human_withdrawal_invalidates_held_result_and_click_before_rebuild() {
    let f = Fixture::new();
    publish(&f);
    let batch = batch(&f);
    let handle = batch.documents()[0].evidence_handles()[0].clone();
    f.hold(batch.documents()[0].revision_id());
    assert!(!valid(&f, &batch));
    f.db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        assert!(matches!(
            read_chronicle_evidence_navigation(&tx, &f.runtime, &handle)?,
            NirEvidenceNavigationRead::Unavailable { .. }
        ));
        assert_eq!(
            reconcile_chronicle_index_runtime(&tx, &f.runtime)?,
            [f.project()]
        );
        assert!(reconcile_chronicle_index_runtime(&tx, &f.runtime)?.is_empty());
        Ok(())
    })
    .expect("one invalidation, no stale click");
}

#[test]
fn nir1_scene_scope_mutation_rejects_held_snapshot_batch_result_and_evidence_before_rebuild() {
    let f = Fixture::new();
    publish(&f);
    let s1 = f.manifest["s1"].as_str().expect("S1");
    let s2 = f.manifest["s2"].as_str().expect("S2");
    let snapshot = captured(&f, s2);
    let batch = f
        .db
        .with_read_transaction(|conn| {
            let NirQualifiedRead::Qualified(batch) =
                qualify_chronicle_index_snapshot(conn, &f.runtime, &snapshot)?
            else {
                panic!("baseline query snapshot qualifies");
            };
            assert_eq!(batch.documents().len(), 2);
            assert!(validate_chronicle_query_status_snapshot(
                conn, &f.runtime, &snapshot
            )?);
            assert!(validate_chronicle_query_snapshot(conn, &f.runtime, &batch)?);
            assert!(validate_chronicle_bound_batch(
                conn, &f.runtime, &snapshot, &batch
            )?);
            Ok(batch)
        })
        .expect("baseline held query result");
    let handle = batch.documents()[0].evidence_handles()[0].clone();
    assert!(!handle.excerpt().is_empty());
    assert!(!batch.documents()[0].embedding().is_empty());

    let current = f
        .db
        .with_read_transaction(|conn| read_narrative_scene_scope(conn, f.project(), s1))
        .expect("read Native scene scope before mutation");
    let mut scope = super::super::scene_scope::NarrativeSceneScopeUpdateV1 {
        schema_version: current.binding.schema_version,
        compatibility_marker: current.binding.compatibility_marker,
        query_identity: current.binding.query_identity.clone(),
        material_constraint: current.binding.material_constraint.clone(),
        knowledge_holder: current.binding.knowledge_holder.clone(),
        audience: current.binding.audience.clone(),
    };
    scope.material_constraint.worldline = NarrativeScopeConstraintV1::Exact {
        reference: "worldline:prime".to_owned(),
    };
    update_narrative_scene_scope(
        &f.db,
        NarrativeSceneScopeUpdatePayload {
            project_id: f.project().to_owned(),
            scene_id: s1.to_owned(),
            request_id: "nir1-held-scope-mutation".to_owned(),
            session_id: "nir1-query-test".to_owned(),
            event_uid: "nir1-held-scope-mutation-event".to_owned(),
            base_version: current.binding.version,
            updated_at: "2026-09-14T00:00:00.000Z".to_owned(),
            scope,
        },
    )
    .expect("Native material scope mutation");

    f.db
        .with_read_transaction(|conn| {
            assert!(matches!(
                qualify_chronicle_index_snapshot(conn, &f.runtime, &snapshot)?,
                NirQualifiedRead::Unavailable {
                    reason: NirIndexUnavailableReason::QueryUnavailable
                }
            ));
            assert!(!validate_chronicle_query_status_snapshot(
                conn, &f.runtime, &snapshot
            )?);
            assert!(!validate_chronicle_query_snapshot(conn, &f.runtime, &batch)?);
            assert!(!validate_chronicle_bound_batch(
                conn, &f.runtime, &snapshot, &batch
            )?);
            assert!(matches!(
                read_chronicle_evidence_navigation(conn, &f.runtime, &handle)?,
                NirEvidenceNavigationRead::Unavailable {
                    reason: NirIndexUnavailableReason::EvidenceUnavailable
                }
            ));
            Ok(())
        })
        .expect("held scope capability is rejected before rebuild");
}

#[test]
fn nir1_query_source_guard_detects_storage_change_even_if_a_token_was_incorrectly_reused() {
    let f = Fixture::new();
    publish(&f);
    let batch = batch(&f);
    f.db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET content='changed query body' WHERE id=?1",
            [f.manifest["s2"].as_str().expect("S2")],
        )?;
        Ok(())
    })
    .expect("private missing-writer negative");
    assert!(!valid(&f, &batch));
}

#[test]
fn nir1_source_observation_guard_does_not_trust_a_clean_cache_flag_alone() {
    let f = Fixture::new();
    publish(&f);
    let batch = batch(&f);
    f.db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET version=version+1 WHERE id=?1",
            [f.manifest["s1"].as_str().expect("S1")],
        )?;
        Ok(())
    })
    .expect("private missing-writer negative");
    assert!(!valid(&f, &batch));
}

#[test]
fn nir1_index_and_revision_canonical_rows_each_remain_mandatory() {
    for kind in ["semantic-index", "proposal-revision"] {
        let f = Fixture::new();
        publish(&f);
        let batch = batch(&f);
        f.db.with_conn(|conn| {
            conn.execute("UPDATE narrative_consumer_freshness SET build_action='revalidate-exact' WHERE consumer_kind=?1",[kind])?;
            Ok(())
        }).expect("private canonical negative");
        assert!(!valid(&f, &batch), "{kind}");
    }
}

#[test]
fn nir1_d1_v1_input_binding_change_cannot_borrow_the_unchanged_generation() {
    let f = Fixture::new();
    publish(&f);
    let batch = batch(&f);
    f.db.with_conn(|conn| {
        conn.execute("UPDATE narrative_dependency_edges SET owning_run_id='foreign-owner' WHERE consumer_kind='semantic-index' AND source_object_identity LIKE 'snapshot:%'",[])?;
        Ok(())
    }).expect("private Source owner corruption");
    assert!(!valid(&f, &batch));
}

#[test]
fn nir1_cold_or_paused_runtime_cannot_restore_authority_from_cached_vectors() {
    let f = Fixture::new();
    publish(&f);
    let batch = batch(&f);
    let cold = NirChronicleIndexRuntime::new(&f.db, 2);
    f.db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        assert!(matches!(
            qualify_chronicle_index_query(
                &tx,
                &cold,
                f.project(),
                f.manifest["s2"].as_str().expect("S2")
            )?,
            NirQualifiedRead::Unavailable { .. }
        ));
        assert!(!validate_chronicle_query_snapshot(&tx, &cold, &batch)?);
        Ok(())
    })
    .expect("cold proof absence");
    f.runtime.pause().expect("pause");
    f.runtime.resume().expect("resume");
    assert!(!valid(&f, &batch));
    assert_eq!(
        f.published_count(),
        2,
        "cache persistence alone grants no authority"
    );
}

#[test]
fn nir1_current_proof_suppresses_an_unnecessary_rebuild() {
    let f = Fixture::new();
    publish(&f);
    f.db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        assert!(matches!(
            prepare_chronicle_index_build(&tx, &f.runtime, f.project())?,
            NirIndexBuildRead::AlreadyUsable
        ));
        Ok(())
    })
    .expect("no generation churn");
}

#[test]
fn nir1_query_storage_errors_do_not_become_usable_empty_results() {
    let f = Fixture::new();
    publish(&f);
    let batch = batch(&f);
    f.db.with_conn(|conn| {
        conn.execute_batch("ALTER TABLE narrative_consumer_freshness RENAME TO missing_freshness")?;
        Ok(())
    })
    .expect("private storage failure");
    f.db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        assert!(validate_chronicle_query_snapshot(&tx, &f.runtime, &batch).is_err());
        Ok(())
    })
    .expect("SQL failure preserved");
}

#[test]
fn nir1_exact_evidence_range_preserves_utf16_and_rejects_partial_surrogates() {
    assert!(super::evidence::exact_utf16_quote("甲😀乙", "😀", 1, 3));
    assert!(!super::evidence::exact_utf16_quote("甲😀乙", "😀", 1, 2));
    assert!(!super::evidence::exact_utf16_quote("甲😀乙", "😀", 2, 4));
    assert!(!super::evidence::exact_utf16_quote(
        "甲😀乙",
        "甲",
        0,
        usize::MAX
    ));
}

#[test]
fn nir1_registered_binding_is_rebuildable_while_dirty_and_unknown_rows_remain_reserved() {
    let f = Fixture::new();
    publish(&f);
    let batch = batch(&f);
    f.hold(batch.documents()[0].revision_id());
    f.db.with_conn(|conn| {
        let (digest,generation) = super::super::verify_coverage::verify_semantic_index_checks(conn,f.project())?;
        assert!(digest.passed && generation.passed);
        assert!(digest.has_reserved_footprint_observation());
        conn.execute("INSERT INTO narrative_semantic_index_metadata
            (project_id,index_key,generation,built_at,source_digest,dependency_set_digest,dirty_cache_flag)
            VALUES (?1,'unknown-index',1,'unknown','unknown','unknown',0)",[f.project()])?;
        let (digest,generation) = super::super::verify_coverage::verify_semantic_index_checks(conn,f.project())?;
        assert!(!digest.completed && !generation.completed);
        assert_eq!(digest.observed_counts["metadataRows"],1,"only the coherent declared binding is excluded");
        Ok(())
    }).expect("four-surface reserved classification");
}

#[test]
fn nir1_corrupt_registered_generation_is_manual_and_cannot_be_rebuilt_silently() {
    let f = Fixture::new();
    publish(&f);
    f.db.with_conn(|conn| {
        conn.execute("UPDATE narrative_semantic_index_metadata SET generation=generation+1 WHERE project_id=?1",[f.project()])?;
        let tx = conn.unchecked_transaction()?;
        assert!(matches!(prepare_chronicle_index_build(&tx,&f.runtime,f.project())?,NirIndexBuildRead::Unavailable {reason:NirIndexUnavailableReason::ReservedBinding}));
        let (digest,generation) = super::super::verify_coverage::verify_semantic_index_checks(&tx,f.project())?;
        assert!(!digest.completed && !generation.completed);
        Ok(())
    }).expect("incoherent producer identity remains reserved");
}

#[test]
fn nir1_first_snapshot_cannot_adopt_a_later_usable_index_generation() {
    let f = Fixture::new();
    publish(&f);
    let snapshot =
        f.db.with_read_transaction(|conn| {
            let NirQueryStatusRead::Available {
                snapshot: Some(snapshot),
                ..
            } = read_chronicle_query_status(
                conn,
                &f.runtime,
                f.project(),
                f.manifest["s2"].as_str().expect("S2"),
            )?
            else {
                panic!("original snapshot");
            };
            assert!(validate_chronicle_query_status_snapshot(
                conn, &f.runtime, &snapshot
            )?);
            Ok(snapshot)
        })
        .expect("capture before capacity/admission/model");
    let old = batch(&f);
    f.hold(old.documents()[0].revision_id());
    publish(&f);
    assert!(valid(&f, &batch(&f)), "new generation is query usable");
    f.db.with_read_transaction(|conn| {
        assert!(
            !validate_chronicle_query_status_snapshot(conn, &f.runtime, &snapshot)?,
            "an in-flight old begin must not borrow the new generation"
        );
        Ok(())
    })
    .expect("first snapshot stays revoked");
}

#[test]
fn nir1_model_generation_change_clears_proofs_and_stale_request_cannot_roll_back() {
    let f = Fixture::new();
    f.runtime
        .bind_embedding_generation(4)
        .expect("actual semantic runtime");
    publish(&f);
    let old = batch(&f);
    f.runtime
        .bind_embedding_generation(4)
        .expect("same actual runtime no-op");
    assert!(valid(&f, &old));
    f.runtime
        .bind_embedding_generation(5)
        .expect("model cache reset");
    assert!(!valid(&f, &old));
    assert!(
        f.runtime.bind_embedding_generation(4).is_err(),
        "queued old request cannot resume it"
    );
    publish(&f);
    assert!(valid(&f, &batch(&f)));
}
