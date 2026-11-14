//! DR-GRW-4 (a-2): the Graph registration reads the project-level facts every
//! Revision's A2 read needs (the live Scope authority, the latest Semantic
//! Epoch, the C2-ZC marker) once, at the first Revision that needs them, and
//! keeps what it read for the rest of its Revisions. Only a read that succeeded
//! is kept; a read that failed is made again by the next Revision.
//!
//! The tests fix that the memo changes no answer (result, seal, failure kind,
//! error text, stage), that it makes each shared read once instead of once per
//! Revision (three times for the Epoch), that it reaches no reader but the
//! registration, that a failed read is not remembered, that an owner stop at any
//! point ends both forms alike, and that the shared reads are made inside the
//! scratch scope. The oracle is `with_unshared_project_reads`: the registration
//! without the memo, which runs the typed reader's unshared branch, the code
//! every other caller still runs.

use super::registration_pinned::{scope_is_closed, CountingOwner};
use super::registration_statements::{
    add_decided, execute, live_statements, multi_fixture, scan_order, OVER_6_MIB_PAD,
};
use super::*;
use crate::narrative_extraction::nir1_capacity::active_work_probe;
use crate::narrative_extraction::nir1_capacity::project_read_probe::{self, Read};
use crate::narrative_extraction::nir1_entity_relation_index::{
    self as index, with_unshared_project_reads,
};
use crate::narrative_extraction::{
    is_validation_terminated, validation_terminated, ValidationTerminationReason,
};
use std::collections::BTreeMap;
use std::sync::atomic::AtomicUsize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Form {
    /// The registration as it is: the shared reads are made once.
    Shared,
    /// The registration with every Revision reading them itself.
    Unshared,
}

/// Everything a registration attempt shows from the outside.
#[derive(Debug, PartialEq)]
struct Outcome {
    result: std::result::Result<bool, String>,
    stage: Nir1GraphRegistrationStage,
    terminated: bool,
    seal: Option<Seal>,
    scope_closed: bool,
}

struct Run {
    outcome: Outcome,
    /// The project-level reads the registration made.
    reads: BTreeMap<Read, usize>,
    callbacks: u64,
    checks: usize,
    /// The Rust-side `check_active_work` calls, apart from the SQLite progress
    /// callbacks (which `callbacks` mixes them with).
    active_checks: usize,
    live_before: usize,
    live_after: usize,
}

impl Run {
    fn reads(&self, read: Read) -> usize {
        self.reads.get(&read).copied().unwrap_or(0)
    }
}

/// Something to do to the registration's connection before it runs, with the
/// flag that is set while the registration is inside its scratch scope.
type Setup<'a> = &'a dyn Fn(&mut Connection, &Arc<AtomicBool>);

fn register_with(
    fixture: &Fixture,
    mut owner: impl GraphWorkControl,
    form: Form,
    setup: Setup<'_>,
) -> Result<(Run, usize)> {
    let mut reader = fixture.reader()?;
    let mut conn = reader.take_owned_connection()?;
    let in_scope = Arc::new(AtomicBool::new(false));
    setup(&mut conn, &in_scope);
    let mut stage = Nir1GraphRegistrationStage::Maintenance;
    let scopes = Arc::new(AtomicUsize::new(0));
    let mut scratch_scope = {
        let in_scope = Arc::clone(&in_scope);
        let scopes = Arc::clone(&scopes);
        move |operation: &mut dyn FnMut()| {
            assert!(
                !in_scope.swap(true, Ordering::SeqCst),
                "scratch scopes must not nest"
            );
            scopes.fetch_add(1, Ordering::SeqCst);
            operation();
            in_scope.store(false, Ordering::SeqCst);
            true
        }
    };
    let live_before = live_statements(&conn);
    let mut run = || {
        reader.register_with_control_observed(
            &mut conn,
            PROJECT,
            &mut owner,
            Some(&mut stage),
            &mut scratch_scope,
        )
    };
    let ((result, active_checks), reads) = project_read_probe::recording(|| {
        active_work_probe::recording(|| match form {
            Form::Shared => run(),
            Form::Unshared => with_unshared_project_reads(&mut run),
        })
    });
    let live_after = live_statements(&conn);
    assert!(conn.is_autocommit(), "the registration's read was ended");
    assert!(
        !in_scope.load(Ordering::SeqCst),
        "the registration ended inside its scratch scope"
    );
    let scope_closed = scope_is_closed(&conn)?;
    let seal = reader
        .pending_registration
        .as_ref()
        .map(|pending| pending.seal.clone());
    let terminated = result.as_ref().is_err_and(is_validation_terminated);
    Ok((
        Run {
            outcome: Outcome {
                result: result.map_err(|error| format!("{error:#}")),
                terminated,
                stage,
                seal,
                scope_closed,
            },
            reads,
            callbacks: 0,
            checks: 0,
            active_checks,
            live_before,
            live_after,
        },
        scopes.load(Ordering::SeqCst),
    ))
}

fn nothing(_: &mut Connection, _: &Arc<AtomicBool>) {}

fn register(fixture: &Fixture, owner: CountingOwner, form: Form) -> Result<Run> {
    let callbacks = Arc::clone(&owner.callbacks);
    let checks = Arc::new(AtomicUsize::new(0));
    struct Counting(CountingOwner, Arc<AtomicUsize>);
    impl GraphWorkControl for Counting {
        fn check(&mut self, stage: GraphWorkStage) -> Result<()> {
            self.1.store(self.0.checks + 1, Ordering::SeqCst);
            self.0.check(stage)
        }
        fn progress_callback(&self) -> Option<GraphProgressCallback> {
            self.0.progress_callback()
        }
        fn allows_full_eligibility(&self) -> bool {
            true
        }
    }
    let (mut run, _) = register_with(
        fixture,
        Counting(owner, Arc::clone(&checks)),
        form,
        &nothing,
    )?;
    run.callbacks = callbacks.load(Ordering::Relaxed);
    run.checks = checks.load(Ordering::SeqCst);
    Ok(run)
}

/// The registration's source read (the roster and its digest) in one form: what
/// the seal is made of, which an outcome that ends in `Ok(false)` does not show.
fn source_in(
    fixture: &Fixture,
    form: Form,
) -> std::result::Result<index::GraphEligibilitySource, String> {
    let read = || {
        fixture.authority.with_read_transaction(|conn| {
            let mut scope = |operation: &mut dyn FnMut()| {
                operation();
                true
            };
            Ok(index::read_eligibility_source_with_control_and_scratch(
                conn,
                PROJECT,
                &mut RegistrationOwner,
                &mut scope,
                Some(REGISTRATION_A2_LIMIT),
            ))
        })
    };
    let read = match form {
        Form::Shared => read(),
        Form::Unshared => with_unshared_project_reads(read),
    };
    read.expect("the read transaction")
        .map_err(|error| format!("{error:#}"))
}

/// Both forms on one fixture. Asserts what must hold for every shape: the
/// outcomes are the same, the registration's source read (roster and digest) is
/// the same, the same owner checks and the same Rust-side active-work checks ran,
/// the memo never made a read the oracle did not make or more of one, the memo
/// never ran more progress callbacks, and neither form left a statement behind.
fn alike(name: &str, fixture: &Fixture) -> Result<(Run, Run)> {
    let shared = register(fixture, CountingOwner::new(None), Form::Shared)?;
    let unshared = register(fixture, CountingOwner::new(None), Form::Unshared)?;
    assert_eq!(shared.outcome, unshared.outcome, "{name}");
    assert!(shared.outcome.scope_closed, "{name}");
    // An outcome that ends in `Ok(false)` shows neither the roster nor its digest,
    // so a memo that remembered a wrong answer would pass the line above.
    assert_eq!(
        source_in(fixture, Form::Shared),
        source_in(fixture, Form::Unshared),
        "{name}: the source read (roster and digest)"
    );
    assert_eq!(
        shared.checks, unshared.checks,
        "{name}: the same owner checks ran"
    );
    assert_eq!(
        shared.active_checks, unshared.active_checks,
        "{name}: the same Rust-side active-work checks ran"
    );
    assert!(
        shared.callbacks <= unshared.callbacks,
        "{name}: callbacks {} vs {}",
        shared.callbacks,
        unshared.callbacks
    );
    for (read, count) in &shared.reads {
        assert!(
            *count <= unshared.reads(*read),
            "{name}: the memo made more {read:?} reads ({count}) than the oracle ({})",
            unshared.reads(*read)
        );
    }
    for (form, run) in [("shared", &shared), ("unshared", &unshared)] {
        assert_eq!(
            run.live_after, run.live_before,
            "{name} ({form}): the registration left a statement behind"
        );
    }
    Ok((shared, unshared))
}

/// The reads that make up the Scope authority's load, one load each.
const SCOPE_READS: [Read; 4] = [
    Read::AuthorityTree,
    Read::ScopeExtension,
    Read::RegistryFull,
    Read::RegistryRow,
];

/// An approved typed Revision of the seed Entities, anchored at `anchor`
/// instead of the seed Scene.
fn add_anchored(fixture: &Fixture, serial: usize, anchor: &str) -> Result<String> {
    let db = fixture.authority.db();
    let mut payload = request(db);
    payload.proposal_key = format!("nir1:review:anchored-{serial:04}");
    for entity in &mut payload.bundle.entities {
        entity.scope.reading = ScopeValue::Exact {
            value: format!("scene:{anchor}"),
        };
        entity.scope.phase = "draft".into();
    }
    crate::narrative_extraction::nir1_entity_relation::tests::rebind_scope_tokens(
        db,
        &mut payload,
    )?;
    let created = create_nir1_entity_relation_revision(db, payload)?;
    let revision = created["revisionId"].as_str().unwrap().to_owned();
    narrative_extraction_append_human_decision(
        db,
        AppendDecisionPayload {
            run_id: "nir1-run".into(),
            project_id: PROJECT.into(),
            proposal_id: created["proposalId"].as_str().unwrap().into(),
            revision_id: revision.clone(),
            decision: "approved".into(),
            decision_json: None,
            created_by: Some("renderer-reviewer".into()),
        },
    )?;
    Ok(revision)
}

/// The seed Revision and `revisions` more, anchored at Scenes spread over
/// `scenes` bound Scenes (a tree node and a Scope binding each), all registered.
fn scenes_fixture(scenes: usize, revisions: usize) -> Result<Fixture> {
    let fixture = Fixture::new()?;
    fixture.authority.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for index in 0..scenes {
            let scene_id = format!("x{index:05}");
            tx.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, node_type, title, content, sort_order, updated_at)
                 VALUES (?1, ?2, 'scene', ?1, '{}', ?3, '2026-10-13T00:00:00.000Z')",
                params![scene_id, PROJECT, format!("y{index:05}")],
            )?;
            crate::narrative_extraction::ensure_scene_scope_binding_in_tx(
                &tx,
                PROJECT,
                &scene_id,
                "2026-09-17T00:00:00.000Z",
                crate::narrative_extraction::SceneScopeInit::UnknownRepairOrRestore,
            )?;
        }
        tx.commit()?;
        Ok(())
    })?;
    let stride = (scenes / revisions.max(1)).max(1);
    for serial in 0..revisions {
        add_anchored(
            &fixture,
            serial,
            &format!("x{:05}", (serial * stride) % scenes.max(1)),
        )?;
    }
    fixture.republish_graph_index()?;
    Ok(fixture)
}

// ---------------------------------------------------------------------------
// (1) Equivalence.
// ---------------------------------------------------------------------------

// Four eligible Revisions: every project-level read is made once instead of
// once per Revision (the Epoch's three per Revision, once), and the registration
// ends in the same seal either way.
#[test]
fn shared_reads_are_made_once_and_the_oracle_makes_them_per_revision() -> Result<()> {
    let fixture = multi_fixture()?;
    let (shared, unshared) = alike("healthy", &fixture)?;
    assert_eq!(
        shared.outcome.result,
        Ok(true),
        "{:?}",
        shared.outcome.result
    );
    assert!(shared.outcome.seal.is_some());
    assert_eq!(
        shared.outcome.stage,
        Nir1GraphRegistrationStage::PostflightIdentity
    );
    for read in SCOPE_READS {
        assert_eq!(shared.reads(read), 1, "shared {read:?}");
        assert_eq!(unshared.reads(read), 4, "unshared {read:?}");
    }
    assert_eq!(shared.reads(Read::C2zcMarker), 1);
    assert_eq!(unshared.reads(Read::C2zcMarker), 4);
    assert_eq!(shared.reads(Read::CurrentEpoch), 1);
    assert_eq!(unshared.reads(Read::CurrentEpoch), 12);
    eprintln!(
        "registration of 4 Revisions: reads shared {:?}, unshared {:?}; callbacks {} -> {}",
        shared.reads, unshared.reads, unshared.callbacks, shared.callbacks
    );
    Ok(())
}

// Every shape of Revision the loop can meet ends alike in both forms. The
// Revision that breaks is the third in the order the roster reads, so the two
// before it have already filled the memo when it fails or is skipped.
#[test]
fn registration_answers_alike_for_each_shape_of_revision() -> Result<()> {
    type Break = fn(&Fixture, &str) -> Result<()>;
    let breaks: [(&str, Break); 4] = [
        // The sealed basis no longer carries the Revision's token.
        ("basis mismatch", |fixture, revision| {
            fixture.authority.with_conn(|conn| {
                conn.execute_batch("DROP TRIGGER narrative_source_basis_immutable_update")?;
                conn.execute(
                    "UPDATE narrative_revision_source_basis SET revision_token = 'tampered'
                      WHERE revision_id = ?1 AND source_kind = 'codex-entry'",
                    [revision],
                )?;
                Ok(())
            })
        }),
        // An approved Revision over the registration's A2 limit.
        ("A2 limit", |fixture, revision| {
            fixture.authority.with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_proposal_decisions
                        SET decision_json = '{\"pad\":\"' || replace(hex(zeroblob(1100000)), '0', 'p') || '\"}'
                      WHERE revision_id = ?1",
                    [revision],
                )?;
                Ok(())
            })
        }),
        // An approved Revision with a component over 6 MiB.
        ("component over 6 MiB", |fixture, revision| {
            fixture.authority.with_conn(|conn| {
                conn.execute_batch(
                    "DROP TRIGGER narrative_proposal_revisions_v2_immutable_update_guard",
                )?;
                conn.execute(
                    &format!(
                        "UPDATE narrative_proposal_revisions
                            SET payload_json = payload_json || {OVER_6_MIB_PAD}
                          WHERE id = ?1"
                    ),
                    [revision],
                )?;
                Ok(())
            })
        }),
        // The live Source of every Entity is hidden.
        ("live lengths None", |fixture, _| {
            execute(fixture, "UPDATE codex_entries SET context_mode = 'hidden'")
        }),
    ];
    for (name, apply) in breaks {
        let fixture = multi_fixture()?;
        let order = scan_order(&fixture)?;
        assert_eq!(order.len(), 4);
        apply(&fixture, &order[2])?;
        let (shared, unshared) = alike(name, &fixture)?;
        assert_ne!(
            shared.outcome.result,
            Ok(true),
            "{name}: the break must bite ({:?})",
            shared.outcome.result
        );
        eprintln!(
            "{name}: {:?}; scope loads shared {} / unshared {}",
            shared.outcome.result,
            shared.reads(Read::AuthorityTree),
            unshared.reads(Read::AuthorityTree)
        );
    }
    Ok(())
}

// A Revision that is not approved is skipped whatever its size, so the typed
// reader never meets it; the approved ones around it read through the memo.
#[test]
fn registration_answers_alike_when_ineligible_revisions_are_mixed_in() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.add_candidate_revision(1, 0)?;
    add_decided(&fixture, 2, Some("rejected"))?;
    add_decided(&fixture, 3, None)?;
    let oversized = add_decided(&fixture, 4, Some("rejected"))?;
    fixture.add_candidate_revision(5, 0)?;
    fixture.republish_graph_index()?;
    execute(
        &fixture,
        &format!(
            "DROP TRIGGER narrative_proposal_revisions_v2_immutable_update_guard;
             UPDATE narrative_proposal_revisions
                SET payload_json = payload_json || {OVER_6_MIB_PAD}
              WHERE id = '{oversized}'"
        ),
    )?;
    let (shared, unshared) = alike("ineligible mix", &fixture)?;
    eprintln!("ineligible mix: {:?}", shared.outcome.result);
    // The Revisions that reach the typed reader read the authority once each in
    // the oracle, and once in all in the memo.
    assert_eq!(shared.reads(Read::AuthorityTree), 1);
    assert!(
        unshared.reads(Read::AuthorityTree) >= 3,
        "{:?}",
        unshared.reads
    );
    Ok(())
}

// The first Revision the loop reads is unavailable before the epoch check, so it
// reads none of the shared facts: the first read happens at the second Revision,
// and the answer is the same as when each Revision reads for itself.
#[test]
fn registration_answers_alike_when_the_first_revision_ends_before_the_first_shared_read(
) -> Result<()> {
    let fixture = multi_fixture()?;
    let order = scan_order(&fixture)?;
    // The proposal's status is no longer one the typed reader accepts while the
    // Revision still has its approving Decision, so the roster and the first
    // two steps pass it and the reader ends with `revision-not-human-approved`,
    // ahead of every project-level read.
    execute(
        &fixture,
        &format!(
            "UPDATE narrative_proposals SET status = 'rejected' WHERE current_revision_id = '{}'",
            order[0]
        ),
    )?;
    let (shared, unshared) = alike("first revision unavailable", &fixture)?;
    assert_ne!(shared.outcome.result, Ok(true));
    // Three Revisions read; the first read is the second Revision's. The oracle
    // read the Epoch three times each and the shared reads once each.
    assert_eq!(shared.reads(Read::AuthorityTree), 1);
    assert_eq!(shared.reads(Read::CurrentEpoch), 1);
    assert_eq!(unshared.reads(Read::AuthorityTree), 3);
    assert_eq!(unshared.reads(Read::CurrentEpoch), 9);
    assert_eq!(unshared.reads(Read::C2zcMarker), 3);
    Ok(())
}

// The Semantic-stage failures answer alike, wherever they fall relative to the
// Revision loop.
#[test]
fn registration_semantic_failures_answer_alike() -> Result<()> {
    let marker = crate::Database::C2_ZC_CUTOVER_MIGRATION_ID;
    let breaks: [(&str, String); 5] = [
        (
            "declaration set table missing",
            "ALTER TABLE narrative_dependency_declaration_sets RENAME TO grw_bak".into(),
        ),
        (
            "scope registries table missing",
            "ALTER TABLE narrative_scope_registries RENAME TO grw_bak".into(),
        ),
        (
            "scene scope bindings table missing",
            "ALTER TABLE narrative_scene_scope_bindings RENAME TO grw_bak".into(),
        ),
        (
            "C2-ZC marker row missing",
            format!("DELETE FROM schema_data_migrations WHERE migration_id = '{marker}'"),
        ),
        (
            "migration table missing",
            "ALTER TABLE schema_data_migrations RENAME TO grw_bak".into(),
        ),
    ];
    for (name, ddl) in breaks {
        let fixture = multi_fixture()?;
        execute(&fixture, &ddl)?;
        let (shared, unshared) = alike(name, &fixture)?;
        assert_ne!(shared.outcome.result, Ok(true), "{name}");
        eprintln!(
            "{name}: {:?}; scope loads shared {} / unshared {}",
            shared.outcome.result,
            shared.reads(Read::AuthorityTree),
            unshared.reads(Read::AuthorityTree)
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// (2) The memo reaches the registration and nothing else.
// ---------------------------------------------------------------------------

// Every other reader of the typed Revisions keeps reading the project-level
// facts per Revision, with or without the oracle: the registration's own source
// read is the only one that shares.
#[test]
fn only_the_registration_shares_its_reads() -> Result<()> {
    let fixture = multi_fixture()?;
    let revisions = 4;
    for oracle in [false, true] {
        // Control (Apply, Freshness, Verify, Restore): the source read without a
        // registration limit.
        let (source, reads) = project_read_probe::recording(|| {
            let read = || {
                fixture.authority.with_read_transaction(|conn| {
                    index::read_eligibility_source_with_control(
                        conn,
                        PROJECT,
                        &mut RegistrationOwner,
                    )
                })
            };
            if oracle {
                with_unshared_project_reads(read)
            } else {
                read()
            }
        });
        source?;
        for read in SCOPE_READS {
            assert_eq!(
                reads.get(&read).copied().unwrap_or(0),
                revisions,
                "source read (oracle {oracle}): {read:?}"
            );
        }
        assert_eq!(reads.get(&Read::CurrentEpoch).copied(), Some(3 * revisions));
        assert_eq!(reads.get(&Read::C2zcMarker).copied(), Some(revisions));

        // B's build: the same read under the native build's admission.
        let runtime = fixture.authority.nir_chronicle_index_runtime();
        let (snapshot, reads) = project_read_probe::recording(|| {
            let build = || {
                fixture.authority.with_read_transaction(|conn| {
                    index::prepare_graph_index_build(conn, runtime, PROJECT)
                })
            };
            if oracle {
                with_unshared_project_reads(build)
            } else {
                build()
            }
        });
        snapshot?;
        for read in SCOPE_READS {
            assert_eq!(
                reads.get(&read).copied().unwrap_or(0),
                revisions,
                "build (oracle {oracle}): {read:?}"
            );
        }
        assert_eq!(reads.get(&Read::CurrentEpoch).copied(), Some(3 * revisions));
    }
    // And the registration's own entry with no limit is the unshared form.
    let (source, reads) = project_read_probe::recording(|| {
        fixture.authority.with_read_transaction(|conn| {
            let mut scope = |operation: &mut dyn FnMut()| {
                operation();
                true
            };
            index::read_eligibility_source_with_control_and_scratch(
                conn,
                PROJECT,
                &mut RegistrationOwner,
                &mut scope,
                None,
            )
        })
    });
    source?;
    assert_eq!(reads.get(&Read::AuthorityTree).copied(), Some(revisions));
    // With the limit it shares, which is the registration's entry.
    let (source, reads) = project_read_probe::recording(|| {
        fixture.authority.with_read_transaction(|conn| {
            let mut scope = |operation: &mut dyn FnMut()| {
                operation();
                true
            };
            index::read_eligibility_source_with_control_and_scratch(
                conn,
                PROJECT,
                &mut RegistrationOwner,
                &mut scope,
                Some(REGISTRATION_A2_LIMIT),
            )
        })
    });
    source?;
    assert_eq!(reads.get(&Read::AuthorityTree).copied(), Some(1));
    Ok(())
}

// ---------------------------------------------------------------------------
// (3) A failed read is not remembered.
// ---------------------------------------------------------------------------

// The Scope registry is gone: no Revision can load the authority. Every Revision
// reads it again and meets the same failure, in both forms, so the memo kept
// nothing of the failure.
#[test]
fn a_deterministic_failure_of_the_scope_read_is_read_again_by_every_revision() -> Result<()> {
    for (name, ddl) in [
        (
            "registry rows gone",
            "DELETE FROM narrative_scope_registries",
        ),
        (
            "registry table missing",
            "ALTER TABLE narrative_scope_registries RENAME TO grw_bak",
        ),
    ] {
        let fixture = multi_fixture()?;
        execute(&fixture, ddl)?;
        let (shared, unshared) = alike(name, &fixture)?;
        assert_ne!(shared.outcome.result, Ok(true), "{name}");
        // One read per Revision in both forms: a failed load is made again.
        for run in [&shared, &unshared] {
            assert_eq!(run.reads(Read::AuthorityTree), 4, "{name}");
        }
        eprintln!("{name}: {:?}", shared.outcome.result);
    }
    // The same on a project of many Scenes.
    let fixture = scenes_fixture(40, 4)?;
    execute(&fixture, "DELETE FROM narrative_scope_registries")?;
    let (shared, unshared) = alike("registry rows gone, many scenes", &fixture)?;
    assert_ne!(shared.outcome.result, Ok(true));
    assert_eq!(shared.reads(Read::AuthorityTree), 5);
    assert_eq!(unshared.reads(Read::AuthorityTree), 5);
    Ok(())
}

/// Refuses the first read of `table` that is prepared inside the scratch scope,
/// once: a transient failure of one read.
fn refuse_first_read_of(table: &'static str) -> impl Fn(&mut Connection, &Arc<AtomicBool>) {
    move |conn, in_scope| {
        let in_scope = Arc::clone(in_scope);
        let refused = Arc::new(AtomicBool::new(false));
        conn.authorizer(Some(
            move |context: rusqlite::hooks::AuthContext<'_>| match context.action {
                rusqlite::hooks::AuthAction::Read { table_name, .. }
                    if table_name == table
                        && in_scope.load(Ordering::SeqCst)
                        && !refused.swap(true, Ordering::SeqCst) =>
                {
                    rusqlite::hooks::Authorization::Deny
                }
                _ => rusqlite::hooks::Authorization::Allow,
            },
        ))
        .expect("authorizer");
    }
}

// One read of the Scope authority fails once, at the first Revision. That
// Revision is skipped (`source-revision-changed`) and the second Revision reads
// the authority successfully and keeps it: a failure at the first read is neither
// kept nor turned into a skip of the Revisions after it.
#[test]
fn a_transient_failure_of_the_scope_read_skips_one_revision_only() -> Result<()> {
    let fixture = multi_fixture()?;
    let refuse = refuse_first_read_of("tree_nodes");
    let (shared, _) = register_with(&fixture, CountingOwner::new(None), Form::Shared, &refuse)?;
    let (unshared, _) = register_with(&fixture, CountingOwner::new(None), Form::Unshared, &refuse)?;
    assert_eq!(shared.outcome, unshared.outcome);
    // The first Revision is not in the roster, so the registered digest no
    // longer matches: the registration answers false, not an error.
    assert_eq!(shared.outcome.result, Ok(false));
    // The failed attempt, then one successful load that is kept (the oracle: one
    // per Revision, the first of them the failed one).
    assert_eq!(shared.reads(Read::AuthorityTree), 2);
    assert_eq!(unshared.reads(Read::AuthorityTree), 4);
    Ok(())
}

// A failure of the Epoch read is the registration's own failure and ends the
// whole registration, so there is no later read that could show the failure was
// not kept. What this fixes: both forms end in the same error at the same stage,
// and both made exactly one Epoch read, the one that failed (the memo neither
// read ahead of the first use nor read again after the failure).
#[test]
fn a_failure_of_the_epoch_read_ends_both_forms_alike_at_its_first_read() -> Result<()> {
    let fixture = multi_fixture()?;
    let refuse = refuse_first_read_of("narrative_semantic_epochs");
    let (shared, _) = register_with(&fixture, CountingOwner::new(None), Form::Shared, &refuse)?;
    let (unshared, _) = register_with(&fixture, CountingOwner::new(None), Form::Unshared, &refuse)?;
    assert_eq!(shared.outcome, unshared.outcome);
    assert!(
        shared.outcome.result.is_err(),
        "{:?}",
        shared.outcome.result
    );
    assert!(shared.outcome.seal.is_none());
    assert!(shared.outcome.scope_closed);
    assert_eq!(shared.reads(Read::CurrentEpoch), 1);
    assert_eq!(unshared.reads(Read::CurrentEpoch), 1);
    eprintln!(
        "epoch read refused: {:?} at {:?}",
        shared.outcome.result, shared.outcome.stage
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// (4) The stop sweeps.
// ---------------------------------------------------------------------------

// An owner that stops at its n-th `check` ends both forms alike at every check a
// healthy registration makes (the memo moves no owner check), and no handle
// outlives the early return.
#[test]
fn owner_check_stops_end_alike_at_every_check_and_leave_no_statement() -> Result<()> {
    let fixture = multi_fixture()?;
    let checks = register(&fixture, CountingOwner::new(None), Form::Shared)?.checks;
    assert!(checks > 8, "{checks}");
    let points =
        (1..=checks + 1).filter(|point| *point <= 100 || point % 13 == 0 || *point + 30 > checks);
    for stop_at in points {
        let shared = register(&fixture, CountingOwner::new(Some(stop_at)), Form::Shared)?;
        let unshared = register(&fixture, CountingOwner::new(Some(stop_at)), Form::Unshared)?;
        assert_eq!(shared.outcome, unshared.outcome, "stop at check {stop_at}");
        assert_eq!(
            shared.live_after, shared.live_before,
            "stop at check {stop_at}"
        );
        assert_eq!(
            unshared.live_after, unshared.live_before,
            "stop at check {stop_at}"
        );
        if stop_at <= checks {
            let error = shared
                .outcome
                .result
                .as_ref()
                .expect_err("the owner stops it");
            assert!(error.contains("TEST_OWNER_STOP"), "{stop_at}: {error}");
        } else {
            assert_eq!(shared.outcome.result, Ok(true));
        }
    }
    eprintln!("owner check stops: {checks} checks; both forms alike at each point swept");
    Ok(())
}

// A stop that is a state (SQLite's progress callback sees it, as does every later
// `check`) ends both forms in the typed stop, with no seal and no handle left,
// wherever it lands. The memo runs fewer callbacks, so a stop at the k-th
// callback is not at the same point in the two; only the end is compared.
#[test]
fn state_stops_end_in_the_typed_stop_in_both_forms_and_leave_no_statement() -> Result<()> {
    let fixture = multi_fixture()?;
    let shared_callbacks = register(&fixture, CountingOwner::new(None), Form::Shared)?.callbacks;
    let unshared_callbacks =
        register(&fixture, CountingOwner::new(None), Form::Unshared)?.callbacks;
    assert!(shared_callbacks <= unshared_callbacks);
    assert!(shared_callbacks >= 8, "{shared_callbacks}");
    let mut points: Vec<u64> = (1..=shared_callbacks).collect();
    points.retain(|point| *point <= 40 || point % 7 == 0 || *point == shared_callbacks);
    for stop_at in points {
        for form in [Form::Shared, Form::Unshared] {
            let run = register(&fixture, CountingOwner::stopping_at_callback(stop_at), form)?;
            assert!(
                run.outcome.terminated,
                "stop at callback {stop_at} ({form:?}): {:?}",
                run.outcome.result
            );
            assert!(run.outcome.seal.is_none());
            assert!(run.outcome.scope_closed);
            assert_eq!(
                run.live_after, run.live_before,
                "stop at callback {stop_at} ({form:?}) left a statement"
            );
        }
    }
    if shared_callbacks < unshared_callbacks {
        let stop_at = shared_callbacks + 1;
        let run = register(
            &fixture,
            CountingOwner::stopping_at_callback(stop_at),
            Form::Unshared,
        )?;
        assert!(run.outcome.terminated, "{:?}", run.outcome.result);
        let run = register(
            &fixture,
            CountingOwner::stopping_at_callback(stop_at),
            Form::Shared,
        )?;
        assert_eq!(run.outcome.result, Ok(true));
    }
    eprintln!(
        "state stops: {shared_callbacks} callbacks (oracle {unshared_callbacks}), all end typed"
    );
    Ok(())
}

/// Raises its stop when told to (by an authorizer, as a statement is prepared)
/// and stops at every check and progress callback after that.
struct StopWhenTold(Arc<AtomicBool>);

impl GraphWorkControl for StopWhenTold {
    fn check(&mut self, _: GraphWorkStage) -> Result<()> {
        if self.0.load(Ordering::Acquire) {
            return Err(validation_terminated(
                ValidationTerminationReason::Cancelled,
                "TEST_CALLBACK_STOP",
            ));
        }
        Ok(())
    }
    fn progress_callback(&self) -> Option<GraphProgressCallback> {
        let stopped = Arc::clone(&self.0);
        Some(Arc::new(move || stopped.load(Ordering::Acquire)))
    }
    fn allows_full_eligibility(&self) -> bool {
        true
    }
}

// The stop is raised as the first load of the Scope authority is prepared: it
// ends in the typed stop in both forms, with no seal, and the memo is not left
// holding a half-made authority (the registration ends, so the next one starts
// empty).
#[test]
fn a_stop_in_the_first_scope_load_ends_typed_in_both_forms() -> Result<()> {
    let fixture = multi_fixture()?;
    for form in [Form::Shared, Form::Unshared] {
        let stop = Arc::new(AtomicBool::new(false));
        let raise = {
            let stop = Arc::clone(&stop);
            move |conn: &mut Connection, in_scope: &Arc<AtomicBool>| {
                let stop = Arc::clone(&stop);
                let in_scope = Arc::clone(in_scope);
                conn.authorizer(Some(move |context: rusqlite::hooks::AuthContext<'_>| {
                    if let rusqlite::hooks::AuthAction::Read {
                        table_name: "tree_nodes",
                        ..
                    } = context.action
                    {
                        if in_scope.load(Ordering::SeqCst) {
                            stop.store(true, Ordering::Release);
                        }
                    }
                    rusqlite::hooks::Authorization::Allow
                }))
                .expect("authorizer");
            }
        };
        let (run, _) = register_with(&fixture, StopWhenTold(Arc::clone(&stop)), form, &raise)?;
        assert!(stop.load(Ordering::Acquire), "the stop was raised");
        assert!(run.outcome.terminated, "{form:?}: {:?}", run.outcome.result);
        assert!(run.outcome.seal.is_none());
        assert!(run.outcome.scope_closed);
        assert_eq!(run.live_after, run.live_before);
    }
    // The memo is gone with the registration: the next one reads and registers.
    let again = register(&fixture, CountingOwner::new(None), Form::Shared)?;
    assert_eq!(again.outcome.result, Ok(true));
    Ok(())
}

// ---------------------------------------------------------------------------
// (5) The memo is filled inside the scratch scope.
// ---------------------------------------------------------------------------

// The shared reads are prepared inside the registration's scratch scope: the
// values the memo keeps are allocated in S, and nothing grows them after. The
// authorizer is asked once per column of a prepared read, so the number of
// events a read makes is fixed, and the events inside the scope are the reads'
// count times that: the memo's inside count is the oracle's divided by the
// number of times the oracle reads. What the registration reads outside the
// scope is the same in both forms.
#[test]
fn the_shared_reads_are_made_inside_the_scratch_scope() -> Result<()> {
    const TABLES: [&str; 4] = [
        "tree_nodes",
        "narrative_semantic_epochs",
        "schema_data_migrations",
        "narrative_scene_scope_bindings",
    ];
    let fixture = multi_fixture()?;
    let seen = Arc::new(std::sync::Mutex::new(Vec::<(String, bool)>::new()));
    // Per form: (outside, inside) authorizer events of each table, and the run.
    let mut counted = Vec::new();
    for form in [Form::Shared, Form::Unshared] {
        seen.lock().unwrap().clear();
        let record = {
            let seen = Arc::clone(&seen);
            move |conn: &mut Connection, in_scope: &Arc<AtomicBool>| {
                let seen = Arc::clone(&seen);
                let in_scope = Arc::clone(in_scope);
                conn.authorizer(Some(move |context: rusqlite::hooks::AuthContext<'_>| {
                    if let rusqlite::hooks::AuthAction::Read { table_name, .. } = context.action {
                        if TABLES.contains(&table_name) {
                            seen.lock()
                                .unwrap()
                                .push((table_name.to_owned(), in_scope.load(Ordering::SeqCst)));
                        }
                    }
                    rusqlite::hooks::Authorization::Allow
                }))
                .expect("authorizer");
            }
        };
        let (run, scopes) = register_with(&fixture, CountingOwner::new(None), form, &record)?;
        assert_eq!(run.outcome.result, Ok(true));
        assert!(scopes > 0);
        let seen = seen.lock().unwrap();
        let events = TABLES.map(|table| {
            let count = |inside: bool| {
                seen.iter()
                    .filter(|(name, scoped)| name == table && *scoped == inside)
                    .count()
            };
            (count(false), count(true))
        });
        let loads = if form == Form::Shared { 1 } else { 4 };
        assert_eq!(run.reads(Read::AuthorityTree), loads, "{form:?}");
        assert_eq!(
            run.reads(Read::CurrentEpoch),
            if form == Form::Shared { 1 } else { 12 }
        );
        counted.push((events, run));
    }
    let (shared, unshared) = (&counted[0], &counted[1]);
    // How many times the oracle reads what the memo reads once.
    let times = [
        unshared.1.reads(Read::AuthorityTree),
        unshared.1.reads(Read::CurrentEpoch),
        unshared.1.reads(Read::C2zcMarker),
        unshared.1.reads(Read::ScopeExtension),
    ];
    for (index, table) in TABLES.iter().enumerate() {
        let ((shared_out, shared_in), (unshared_out, unshared_in)) =
            (shared.0[index], unshared.0[index]);
        // Nothing is read outside the scope but what both forms read there.
        assert_eq!(
            shared_out, unshared_out,
            "{table}: events outside the scope"
        );
        // The memo's one read is inside the scope, and the oracle's N are the same
        // read made N times.
        assert!(shared_in >= 1, "{table}: no event inside the scope");
        assert_eq!(
            unshared_in,
            shared_in * times[index],
            "{table}: events inside the scope (memo {shared_in}, oracle {unshared_in}, \
             oracle reads {})",
            times[index]
        );
    }
    // The tree is read only by the Scope authority's load.
    assert_eq!(shared.0[0].0, 0);
    Ok(())
}

// ---------------------------------------------------------------------------
// (6) Many Scenes.
// ---------------------------------------------------------------------------

/// How many bound Scenes the many-Scenes fixture has by default. The measured
/// cost of an unshared load is about 34 microseconds a Scene, so the default stays
/// small; set `GRW_SCENES` to widen it by hand.
fn scene_count() -> usize {
    std::env::var("GRW_SCENES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(100)
}

// A project of many bound Scenes and Revisions anchored across them: the answer
// is the same, each shared read is made once, and the stops land alike.
#[test]
fn many_scenes_register_alike_and_read_the_project_once() -> Result<()> {
    let scenes = scene_count();
    let revisions = 6;
    let fixture = scenes_fixture(scenes, revisions)?;
    let (shared, unshared) = alike("many scenes", &fixture)?;
    assert_eq!(
        shared.outcome.result,
        Ok(true),
        "{:?}",
        shared.outcome.result
    );
    let eligible = revisions + 1;
    for read in SCOPE_READS {
        assert_eq!(shared.reads(read), 1, "{read:?}");
        assert_eq!(unshared.reads(read), eligible, "{read:?}");
    }
    assert_eq!(shared.reads(Read::CurrentEpoch), 1);
    assert_eq!(unshared.reads(Read::CurrentEpoch), 3 * eligible);
    assert_eq!(shared.reads(Read::C2zcMarker), 1);
    assert_eq!(unshared.reads(Read::C2zcMarker), eligible);
    // The memo runs strictly fewer progress callbacks: the load of the Scenes
    // is far above the 1,000-step cadence.
    assert!(
        shared.callbacks < unshared.callbacks,
        "callbacks {} vs {}",
        shared.callbacks,
        unshared.callbacks
    );
    // Stops at a stride of owner checks and of progress callbacks.
    let checks = shared.checks;
    for stop_at in (1..=checks + 1).filter(|point| point % 97 == 0 || *point + 4 > checks) {
        let a = register(&fixture, CountingOwner::new(Some(stop_at)), Form::Shared)?;
        let b = register(&fixture, CountingOwner::new(Some(stop_at)), Form::Unshared)?;
        assert_eq!(a.outcome, b.outcome, "stop at check {stop_at}");
    }
    for stop_at in (1..=shared.callbacks).filter(|point| point % 61 == 0 || *point <= 3) {
        for form in [Form::Shared, Form::Unshared] {
            let run = register(&fixture, CountingOwner::stopping_at_callback(stop_at), form)?;
            assert!(
                run.outcome.terminated,
                "stop at callback {stop_at} ({form:?}): {:?}",
                run.outcome.result
            );
            assert!(run.outcome.seal.is_none());
            assert_eq!(run.live_after, run.live_before);
        }
    }
    eprintln!(
        "{scenes} Scenes, {eligible} Revisions: callbacks {} -> {}, reads shared {:?}, unshared {:?}",
        unshared.callbacks, shared.callbacks, shared.reads, unshared.reads
    );
    Ok(())
}

// A Revision whose anchor Scene is gone from the project fails its own check in
// both forms, with the authority still read once by the memo.
#[test]
fn many_scenes_with_a_vanished_anchor_answer_alike() -> Result<()> {
    let fixture = scenes_fixture(scene_count().min(60), 4)?;
    let order = scan_order(&fixture)?;
    assert!(order.len() >= 4);
    // The Scene one Revision is anchored at is no longer in the project.
    execute(&fixture, "DELETE FROM tree_nodes WHERE id = 'x00000'")?;
    let (shared, _unshared) = alike("anchor gone", &fixture)?;
    assert_ne!(shared.outcome.result, Ok(true));
    Ok(())
}

// The registration publishes the same seal as the oracle on the many-Scenes
// fixture (the seal carries the digest of the whole roster).
#[test]
fn many_scenes_seals_are_equal() -> Result<()> {
    let fixture = scenes_fixture(scene_count().min(80), 4)?;
    let shared = register(&fixture, CountingOwner::new(None), Form::Shared)?;
    let unshared = register(&fixture, CountingOwner::new(None), Form::Unshared)?;
    assert_eq!(shared.outcome.result, Ok(true));
    assert_eq!(shared.outcome.seal, unshared.outcome.seal);
    assert!(shared.outcome.seal.is_some());
    Ok(())
}

// The real worker's registration reads the project once and reaches READY: its
// scratch region is sealed with no allocation live, which the memo, dropped
// before the seal, must not break. The project has many bound Scenes and several
// Revisions anchored across them, so the shared Scope authority is large.
#[test]
#[ignore = "requires a built normal worker binary (NIR1_C_QUERY_WORKER_BIN); builds its own project"]
fn native_worker_registers_a_project_of_many_bound_scenes() -> Result<()> {
    let scenes = std::env::var("GRW_WORKER_SCENES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1000);
    let fixture = scenes_fixture(scenes, 12)?;
    with_real_worker(&fixture, |owner| {
        owner.prepare(PROJECT)?;
        eprintln!("{scenes} Scenes, 13 Revisions: READY");
        // The query that follows is the 100 ms production lease; the verdict
        // here is the registration (READY), so what the query got is printed.
        match owner.query_once(&graph_request("nir1-alice")) {
            Ok(lease) => {
                let frame = lease.frame()?;
                let graph = frame
                    .graph()
                    .map(|graph| (graph.node_count(), graph.edge_count()));
                eprintln!("seed nir1-alice answered {graph:?}");
                drop(lease);
            }
            Err(error) => eprintln!("seed nir1-alice refused: {error:#}"),
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// The capacity fixtures: ineligible candidates of every kind among qualified ones.
// ---------------------------------------------------------------------------

// A project whose candidates are mostly ineligible (decisionless, rejected, a
// drifted Source, a stale Freshness, a drifted Scope, or a report case) reads to
// the same roster and digest through the registration's entry in both forms,
// and the memo never reads more than the oracle does. (The fixture builder is a
// diagnostics feature.)
#[cfg(feature = "nir1-material-diagnostics")]
#[test]
fn the_registration_source_read_is_alike_over_ineligible_candidates_of_every_kind() -> Result<()> {
    use crate::narrative_extraction::nir1_capacity_fixtures::{
        build_fixture_from_manifest, NIR1_CAPACITY_FIXTURE_PROJECT_ID,
    };
    use crate::narrative_extraction::source_revision::ForegroundValidationControl;

    let directory = std::env::temp_dir().join(format!("nir1-grw4-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory)?;
    let manifest = directory.join("manifest.json");
    std::fs::write(
        &manifest,
        r#"{
            "schemaVersion": "nir1-capacity/1",
            "diagnosticOnly": true,
            "fixtures": [
                {"id": "Q513/R3/D10", "qualifiedMaterials": 513, "qualifiedRevisions": 3, "ineligibleCandidates": 10},
                {"id": "D2064/report-heavy", "ineligibleCandidates": 10}
            ]
        }"#,
    )?;
    let result = (|| -> Result<()> {
        for case in ["Q513/R3/D10", "D2064/report-heavy"] {
            let path = directory.join(format!("{}.db", case.replace('/', "-")));
            build_fixture_from_manifest(&manifest, case, &path)?;
            let db = crate::Database::new(&path)?;
            let mut reads = Vec::new();
            for oracle in [false, true] {
                let (read, counts) = project_read_probe::recording(|| {
                    db.with_read_transaction(|conn| {
                        let before = live_statements(conn);
                        let mut run = || {
                            let mut scope = |operation: &mut dyn FnMut()| {
                                operation();
                                true
                            };
                            index::read_eligibility_source_with_control_and_scratch(
                                conn,
                                NIR1_CAPACITY_FIXTURE_PROJECT_ID,
                                &mut ForegroundValidationControl,
                                &mut scope,
                                Some(REGISTRATION_A2_LIMIT),
                            )
                        };
                        let read = if oracle {
                            with_unshared_project_reads(run)
                        } else {
                            run()
                        };
                        assert_eq!(live_statements(conn), before, "{case} (oracle {oracle})");
                        Ok(read)
                    })
                });
                reads.push((read?.map_err(|error| format!("{error:#}")), counts));
            }
            let (shared, shared_reads) = &reads[0];
            let (unshared, unshared_reads) = &reads[1];
            assert_eq!(shared, unshared, "{case}");
            for (read, count) in shared_reads {
                assert!(*count <= 1, "{case}: {read:?} read {count} times");
                assert!(*count <= unshared_reads.get(read).copied().unwrap_or(0));
            }
            eprintln!(
                "{case}: roster {}; reads shared {shared_reads:?}, unshared {unshared_reads:?}",
                shared.as_ref().map_or(0, |source| source.roster.len())
            );
        }
        Ok(())
    })();
    std::fs::remove_dir_all(&directory)?;
    result
}
