//! DR-CP4-V-1 (P2): a query context read by a proof's validation is reused
//! only for the same proof, project, Scene and committed read identity, and
//! every verdict stays the one a fresh read gives.
use super::super::{
    publish_chronicle_index_build, read_identity::ReadIdentity, test_support::Fixture,
    NirIndexPublishRead,
};
use super::*;
use crate::narrative_extraction::nir1_capacity::project_read_probe::{self, Read};
use crate::narrative_extraction::{
    read_narrative_scene_scope, update_narrative_scene_scope,
    update_narrative_scene_scope_registry, NarrativeSceneScopeRegistryUpdatePayload,
    NarrativeSceneScopeUpdatePayload,
};
use grimodex_core::narrative_scene_scope::NarrativeScopeConstraintV1;

type Context = Arc<RetrievalQueryContext>;
/// A named change of the committed state between two validations.
type Change = (&'static str, fn(&Fixture));

fn published() -> Fixture {
    let f = Fixture::new();
    // The actual semantic runtime's generation, bound before the proof exists.
    f.runtime
        .bind_embedding_generation(1)
        .expect("bind the actual generation");
    let (plan, docs) = f.prepare();
    assert!(matches!(
        publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(docs)).expect("publish"),
        NirIndexPublishRead::Published {
            newly_usable_published: true,
            ..
        }
    ));
    f.db.with_conn(|conn| {
        conn.execute_batch("CREATE TABLE inv_unrelated_rows (value INTEGER)")?;
        Ok(())
    })
    .expect("a table no authority reads");
    f
}

fn s1(f: &Fixture) -> &str {
    f.manifest["s1"].as_str().expect("S1")
}

fn s2(f: &Fixture) -> &str {
    f.manifest["s2"].as_str().expect("S2")
}

fn snapshot(f: &Fixture, scene: &str) -> NirQuerySnapshot {
    f.db.with_read_transaction(|conn| {
        let NirQueryStatusRead::Available {
            snapshot: Some(snapshot),
            ..
        } = read_chronicle_query_status(conn, &f.runtime, f.project(), scene)?
        else {
            panic!("usable first snapshot of {scene}")
        };
        Ok(snapshot)
    })
    .expect("capture original query")
}

/// The validation every IR read runs (qualify, the title read, `current_operation`).
fn validate(conn: &Connection, f: &Fixture, snapshot: &NirQuerySnapshot) -> Option<Context> {
    let mut control = super::super::super::source_revision::ForegroundValidationControl;
    validate_binding_with_control(
        conn,
        &f.runtime,
        snapshot.owner,
        &snapshot.proof,
        &snapshot.query,
        &mut control,
    )
    .expect("validation")
}

/// One Read transaction's validation, with its Scope-authority reads counted.
fn read(f: &Fixture, snapshot: &NirQuerySnapshot) -> (Option<Context>, usize) {
    let (context, reads) = project_read_probe::recording(|| {
        f.db.with_read_transaction(|conn| Ok(validate(conn, f, snapshot)))
            .expect("read")
    });
    (
        context,
        reads.get(&Read::AuthorityTree).copied().unwrap_or(0),
    )
}

/// The verdict without any reuse: both of the proof's caches emptied first.
fn uncached(f: &Fixture, snapshot: &NirQuerySnapshot) -> Option<Context> {
    *snapshot.proof.validated_read.lock().expect("proof cache") = None;
    snapshot
        .proof
        .validated_query_contexts
        .lock()
        .expect("context cache")
        .clear();
    f.db.with_read_transaction(|conn| Ok(validate(conn, f, snapshot)))
        .expect("uncached read")
}

fn same(a: &Option<Context>, b: &Option<Context>) -> bool {
    matches!((a, b), (Some(a), Some(b)) if Arc::ptr_eq(a, b))
}

fn binding(context: &Option<Context>) -> Option<QueryBinding> {
    context.as_deref().map(QueryBinding::from)
}

#[test]
fn nir1_query_context_is_reused_for_the_same_committed_state_only() {
    let f = published();
    let snapshot = snapshot(&f, s2(&f));
    let (first, _) = read(&f, &snapshot);
    assert!(first.is_some(), "the original query is current");
    // A later Read transaction of the same committed state reads no Scope
    // authority: the proof's verdict and the context are both reused.
    let (second, authority_reads) = read(&f, &snapshot);
    assert!(same(&first, &second), "the same context is reused");
    assert_eq!(authority_reads, 0, "no Scope authority is read again");
    // Inside one transaction the three IR validations share it too.
    f.db.with_read_transaction(|conn| {
        let a = validate(conn, &f, &snapshot);
        let b = validate(conn, &f, &snapshot);
        assert!(same(&a, &b) && same(&a, &first));
        Ok(())
    })
    .expect("one snapshot");
    // The reused context is the one a fresh read gives, field for field.
    let fresh = uncached(&f, &snapshot);
    assert!(fresh.is_some() && !same(&fresh, &first));
    assert_eq!(binding(&fresh), binding(&first));
    assert_eq!(binding(&first), Some(snapshot.query.clone()));
}

#[test]
fn nir1_reused_query_context_keeps_the_batch_identical_to_a_fresh_qualification() {
    let f = published();
    let snapshot = snapshot(&f, s2(&f));
    let qualify = |f: &Fixture| {
        f.db.with_read_transaction(|conn| {
            let NirQualifiedRead::Qualified(batch) =
                qualify_chronicle_index_snapshot(conn, &f.runtime, &snapshot)?
            else {
                panic!("qualified");
            };
            assert!(validate_chronicle_bound_batch(
                conn, &f.runtime, &snapshot, &batch
            )?);
            Ok(batch)
        })
        .expect("qualify")
    };
    let shape = |batch: &NirQualifiedBatch| {
        batch
            .documents()
            .iter()
            .map(|document| {
                (
                    document.revision_id().to_owned(),
                    document.embedding().to_vec(),
                    document.document().serialized_statement.clone(),
                    document
                        .evidence_handles()
                        .iter()
                        .map(|handle| {
                            (
                                handle.scene_id().to_owned(),
                                handle.evidence_id().to_owned(),
                                handle.excerpt(),
                            )
                        })
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<Vec<_>>()
    };
    let reused = qualify(&f);
    *snapshot.proof.validated_read.lock().expect("proof cache") = None;
    snapshot
        .proof
        .validated_query_contexts
        .lock()
        .expect("context cache")
        .clear();
    let fresh = qualify(&f);
    assert!(!reused.documents().is_empty());
    assert_eq!(shape(&reused), shape(&fresh));
    assert_eq!(
        QueryBinding::from(reused.query_context()),
        QueryBinding::from(fresh.query_context())
    );
}

#[test]
fn nir1_query_context_reuse_is_keyed_by_scene() {
    let f = published();
    let first = snapshot(&f, s2(&f));
    let other = snapshot(&f, s1(&f));
    assert!(Arc::ptr_eq(&first.proof, &other.proof), "one project proof");
    f.db.with_read_transaction(|conn| {
        for snapshot in [&first, &other, &first, &other] {
            let context = validate(conn, &f, snapshot).expect("each Scene's query is current");
            assert_eq!(context.query_scene_id, snapshot.query.scene);
        }
        Ok(())
    })
    .expect("two Scenes in one snapshot");
}

#[test]
fn nir1_reused_query_context_is_still_compared_with_the_expected_binding() {
    let f = published();
    let snapshot = snapshot(&f, s2(&f));
    let mut changed = snapshot.query.clone();
    changed.scope_token.push_str(":changed");
    let tampered = NirQuerySnapshot {
        owner: snapshot.owner,
        proof: snapshot.proof.clone(),
        query: changed,
    };
    f.db.with_read_transaction(|conn| {
        assert!(
            validate(conn, &f, &snapshot).is_some(),
            "kept for this state"
        );
        assert!(
            validate(conn, &f, &tampered).is_none(),
            "a reused context never answers another binding"
        );
        assert!(validate(conn, &f, &snapshot).is_some());
        Ok(())
    })
    .expect("one snapshot");
}

/// Each change of the committed state takes a fresh read, whatever its
/// verdict; the verdict is the one without any reuse.
#[test]
fn nir1_any_change_of_the_read_identity_takes_a_fresh_query_context() {
    let changes: [Change; 5] = [
        ("own connection commit (total_changes)", |f| {
            f.db.with_conn(|conn| {
                conn.execute("INSERT INTO inv_unrelated_rows VALUES (1)", [])?;
                Ok(())
            })
            .expect("own write");
        }),
        ("another connection's commit (data_version)", |f| {
            let other = crate::Database::new(f.path()).expect("second connection");
            other
                .with_conn(|conn| {
                    conn.execute("INSERT INTO inv_unrelated_rows VALUES (2)", [])?;
                    Ok(())
                })
                .expect("other write");
        }),
        ("main schema change", |f| {
            f.db.with_conn(|conn| {
                conn.execute_batch("CREATE TABLE inv_schema_change (value INTEGER)")?;
                Ok(())
            })
            .expect("main schema");
        }),
        ("temp schema change", |f| {
            f.db.with_conn(|conn| {
                conn.execute_batch("CREATE TEMP TABLE inv_temp_change (value INTEGER)")?;
                Ok(())
            })
            .expect("temp schema");
        }),
        ("rolled-back write", |f| {
            f.db.with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                tx.execute("INSERT INTO inv_unrelated_rows VALUES (3)", [])?;
                tx.rollback()?;
                Ok(())
            })
            .expect("rolled back");
        }),
    ];
    for (name, change) in changes {
        let f = published();
        let snapshot = snapshot(&f, s2(&f));
        let (before, _) = read(&f, &snapshot);
        assert!(before.is_some(), "{name}: current before");
        let identity =
            f.db.with_read_transaction(ReadIdentity::read)
                .expect("identity");
        change(&f);
        let after_identity =
            f.db.with_read_transaction(ReadIdentity::read)
                .expect("identity");
        assert_ne!(identity, after_identity, "{name}: the identity moved");
        let (after, _) = read(&f, &snapshot);
        assert!(!same(&before, &after), "{name}: a fresh context");
        assert_eq!(
            binding(&after),
            binding(&uncached(&f, &snapshot)),
            "{name}: the verdict without reuse"
        );
    }
}

/// A Write transaction neither reuses nor keeps a context: a rolled-back
/// write leaves total_changes moved and data_version unchanged, so a context
/// kept under its state would be offered to the next Read transaction.
#[test]
fn nir1_write_transaction_keeps_no_query_context() {
    let f = published();
    let snapshot = snapshot(&f, s2(&f));
    let (before, _) = read(&f, &snapshot);
    let in_write =
        f.db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            tx.execute("INSERT INTO inv_unrelated_rows VALUES (4)", [])?;
            let context = validate(&tx, &f, &snapshot);
            tx.rollback()?;
            Ok(context)
        })
        .expect("write transaction");
    assert!(in_write.is_some() && !same(&in_write, &before));
    let (after, _) = read(&f, &snapshot);
    assert!(after.is_some());
    assert!(
        !same(&after, &in_write),
        "nothing kept from the Write state"
    );
    assert!(!same(&after, &before), "the identity moved with the write");
}

fn mutate_material_scope(f: &Fixture) {
    let scene = s1(f);
    let initial =
        f.db.with_read_transaction(|conn| read_narrative_scene_scope(conn, f.project(), scene))
            .expect("scope registry");
    let mut registry = initial.registry.clone();
    registry
        .worldline_refs
        .push("worldline:alternate".to_owned());
    update_narrative_scene_scope_registry(
        &f.db,
        NarrativeSceneScopeRegistryUpdatePayload {
            project_id: f.project().to_owned(),
            request_id: "v1-reuse-registry".into(),
            session_id: "v1-reuse-test".into(),
            event_uid: "v1-reuse-registry-event".into(),
            base_version: initial.registry_revision,
            updated_at: "2026-10-31T00:00:00.000Z".into(),
            registry,
        },
    )
    .expect("registry");
    let current =
        f.db.with_read_transaction(|conn| read_narrative_scene_scope(conn, f.project(), scene))
            .expect("scope");
    let mut scope = super::super::super::scene_scope::NarrativeSceneScopeUpdateV1 {
        schema_version: current.binding.schema_version,
        compatibility_marker: current.binding.compatibility_marker,
        query_identity: current.binding.query_identity.clone(),
        material_constraint: current.binding.material_constraint.clone(),
        knowledge_holder: current.binding.knowledge_holder.clone(),
        audience: current.binding.audience.clone(),
    };
    scope.material_constraint.worldline = NarrativeScopeConstraintV1::Exact {
        reference: "worldline:alternate".to_owned(),
    };
    update_narrative_scene_scope(
        &f.db,
        NarrativeSceneScopeUpdatePayload {
            project_id: f.project().to_owned(),
            scene_id: scene.to_owned(),
            request_id: "v1-reuse-scope".to_owned(),
            session_id: "v1-reuse-test".to_owned(),
            event_uid: "v1-reuse-scope-event".to_owned(),
            base_version: current.binding.version,
            updated_at: "2026-10-31T00:00:00.000Z".to_owned(),
            scope,
        },
    )
    .expect("material scope");
}

/// The changes between qualify and `continue` that invalidate the IR today
/// still do, with the contexts and the proof verdict kept beforehand.
#[test]
fn nir1_invalidating_changes_after_reuse_still_invalidate() {
    let changes: [Change; 6] = [
        ("own commit: material scope", mutate_material_scope),
        ("own commit: tree order of the query Scene", |f| {
            f.db.with_conn(|conn| {
                conn.execute(
                    "UPDATE tree_nodes SET sort_order = sort_order + 1000 WHERE id = ?1",
                    [s2(f)],
                )?;
                Ok(())
            })
            .expect("tree change");
        }),
        ("another connection: archive the query Scene", |f| {
            let other = crate::Database::new(f.path()).expect("second connection");
            other
                .with_conn(|conn| {
                    conn.execute(
                        "UPDATE tree_nodes SET archived_at = '2026-10-31T00:00:00.000Z' WHERE id = ?1",
                        [s2(f)],
                    )?;
                    Ok(())
                })
                .expect("archive");
        }),
        ("binding dirty", |f| {
            f.db.with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_semantic_index_metadata SET dirty_cache_flag = 1 WHERE project_id = ?1",
                    [f.project()],
                )?;
                Ok(())
            })
            .expect("dirty");
        }),
        ("held Human decision", |f| {
            let revision = f.db.with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT revision_id FROM narrative_nir1_chronicle_vectors ORDER BY revision_id LIMIT 1",
                    [],
                    |r| r.get::<_, String>(0),
                )?)
            });
            f.hold(&revision.expect("published revision"));
        }),
        ("runtime epoch: embedding generation", |f| {
            f.runtime
                .bind_embedding_generation(9)
                .expect("model change");
        }),
    ];
    for (name, change) in changes {
        let f = published();
        let snapshot = snapshot(&f, s2(&f));
        // Warm both caches as qualify and the title read do.
        assert!(read(&f, &snapshot).0.is_some(), "{name}: current before");
        assert!(read(&f, &snapshot).0.is_some(), "{name}: reused");
        change(&f);
        let (after, _) = read(&f, &snapshot);
        let fresh = uncached(&f, &snapshot);
        assert!(after.is_none(), "{name}: invalidated");
        assert_eq!(binding(&after), binding(&fresh), "{name}: as today");
    }
}
