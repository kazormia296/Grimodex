//! B group: the order of COMMIT and the lifecycle edges (CB-2 S1, DR-CB2-3).
#![cfg(feature = "native-current-human-capture")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use super::commit_outcome::test_hooks as reread_hooks;
use super::writer::{test_hooks as write_hooks, Stage};
use super::writer_support_tests::*;
use super::*;
use crate::nir1_generation::Nir1GenerationFailpoint;
use crate::workspace_lifecycle::{AdmissionKind, AdmissionOutcome, LifecycleError};

fn commit_probe(during: mpsc::Sender<()>, release: mpsc::Receiver<()>) -> Nir1GenerationFailpoint {
    let release = Mutex::new(release);
    Nir1GenerationFailpoint::ProbeDuringCommit(Arc::new(move || {
        during.send(()).expect("announce COMMIT");
        release
            .lock()
            .expect("release")
            .recv_timeout(Duration::from_secs(10))
            .expect("release COMMIT");
    }))
}

#[test]
fn restore_during_commit_waits_for_the_participant() {
    write_hooks::reset();
    reread_hooks::reset();
    let env = Env::new();
    let request = scene_request(&env);
    let consumed = consumed_for(&env, &request).unwrap();
    let snapshot = env.snapshot();
    let core = env.core();
    let (during_tx, during_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let budget = budget().with_failpoint(commit_probe(during_tx, release_rx));

    let ticket = thread::scope(|scope| {
        let writer = scope.spawn(|| declare_scene_body(&snapshot, consumed, request, &budget));
        during_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the writer reached COMMIT");
        // A Restore is admitted while the COMMIT is in progress. It cannot
        // take the workspace until the participant is released.
        let AdmissionOutcome::Admitted(ticket) = core
            .begin_transition(AdmissionKind::Restore)
            .expect("admission")
        else {
            panic!("restore must be admitted");
        };
        assert!(matches!(
            core.physical_exclusive_for_ticket(&ticket),
            Err(LifecycleError::ActiveOperations)
        ));
        release_tx.send(()).unwrap();
        let result = writer.join().unwrap();
        // The COMMIT applied (or is proven to have) even though the restore
        // had been admitted during it.
        let outcome = result.expect("the declaration committed");
        assert!(matches!(outcome.evidence.kind(), TerminalKind::Committed));
        ticket
    });
    // The caller still holds the participant (the evidence is in its hands):
    // the restore keeps waiting.
    assert!(matches!(
        core.physical_exclusive_for_ticket(&ticket),
        Err(LifecycleError::ActiveOperations)
    ));
    let db = Arc::clone(snapshot.db());
    drop(snapshot);
    let exclusive = core
        .physical_exclusive_for_ticket(&ticket)
        .expect("after the drain");
    // The restore's clear now runs after the declaration: it removes it, so
    // no declaration survives the restore and none was cleared before it.
    assert!(env_declaration_present(&db));
    clear_all_scene_body_declarations_for_staged_restore(db.db()).expect("clear");
    assert!(!env_declaration_present(&db));
    drop(exclusive);
}

fn env_declaration_present(db: &crate::state::PinnedWorkspaceDb) -> bool {
    db.db()
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT body_declaration_token IS NOT NULL FROM narrative_scene_scope_bindings
                  WHERE scene_id = ?1",
                [SCENE],
                |row| row.get(0),
            )?)
        })
        .unwrap()
}

type Edge = fn(&crate::workspace_lifecycle::WorkspaceLifecycleCore);

fn edges() -> Vec<(&'static str, Edge)> {
    vec![
        ("TransitionAdmitted", |core| {
            let _ = core
                .begin_transition(AdmissionKind::Restore)
                .expect("transition");
        }),
        ("Unavailable", |core| {
            // Ready -> RecoveryRequired while a participant is alive.
            core.mark_safe_mode_recovery_required()
                .expect("recovery required");
        }),
        ("ShutdownRequested", |core| {
            let _ = core.request_shutdown();
        }),
    ]
}

#[test]
fn edge_before_commit_rolls_back() {
    for (name, edge) in edges() {
        write_hooks::reset();
        reread_hooks::reset();
        let env = Env::new();
        let request = scene_request(&env);
        let consumed = consumed_for(&env, &request).unwrap();
        let core = env.core();
        // The edge happens inside the transaction, after the last write and
        // before the writer's own check that precedes COMMIT.
        write_hooks::at_stage(Stage::AfterIdempotency, Some(Box::new(move || edge(&core))));
        let snapshot = env.snapshot();
        let failure = declare_scene_body(&snapshot, consumed, request, &budget()).expect_err(name);
        write_hooks::reset();
        assert_eq!(
            failure.evidence.as_ref().expect("a transaction ran").kind(),
            TerminalKind::RolledBack,
            "{name}: {:?}",
            failure.refusal
        );
        drop(snapshot);
        assert_eq!(env.declaration_token(SCENE), None, "{name}: rolled back");
        let rows = env.with_conn(|conn| {
            Ok(count(conn, "SELECT count(*) FROM idempotency_requests WHERE domain = 'scene_body_declaration_declare'"))
        });
        assert_eq!(rows, 0, "{name}: no partial record");
    }
}

#[test]
fn an_edge_during_commit_does_not_undo_the_write() {
    for (name, edge) in edges() {
        write_hooks::reset();
        reread_hooks::reset();
        let env = Env::new();
        let request = scene_request(&env);
        let consumed = consumed_for(&env, &request).unwrap();
        let core = env.core();
        let probe = Nir1GenerationFailpoint::ProbeDuringCommit(Arc::new(move || edge(&core)));
        let snapshot = env.snapshot();
        let result = declare_scene_body(
            &snapshot,
            consumed,
            request,
            &budget().with_failpoint(probe),
        );
        let outcome = result.unwrap_or_else(|failure| panic!("{name}: {failure:?}"));
        assert!(
            matches!(outcome.evidence.kind(), TerminalKind::Committed),
            "{name}"
        );
        drop(snapshot);
        assert!(
            env.declaration_token(SCENE).is_some(),
            "{name}: the write stands"
        );
    }
}

#[test]
fn commit_is_not_inside_the_lifecycle_lock() {
    write_hooks::reset();
    reread_hooks::reset();
    let env = Env::new();
    let request = scene_request(&env);
    let consumed = consumed_for(&env, &request).unwrap();
    let snapshot = env.snapshot();
    let core = env.core();
    let (during_tx, during_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let budget = budget().with_failpoint(commit_probe(during_tx, release_rx));
    thread::scope(|scope| {
        let writer = scope.spawn(|| declare_scene_body(&snapshot, consumed, request, &budget));
        during_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("COMMIT started");
        // The Core is usable from other threads during COMMIT: a snapshot of
        // its state (what an observer takes) and a new participant.
        let (done_tx, done_rx) = mpsc::channel();
        let other_core = core.clone();
        scope.spawn(move || {
            other_core.snapshot().expect("Core snapshot during COMMIT");
            drop(
                other_core
                    .begin_workspace_participant()
                    .expect("participant during COMMIT"),
            );
            done_tx.send(()).unwrap();
        });
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("lifecycle use during COMMIT finished within 1 s");
        release_tx.send(()).unwrap();
        writer.join().unwrap().expect("committed");
    });
}

#[test]
fn commit_that_never_returns_waits_for_terminal() {
    write_hooks::reset();
    reread_hooks::reset();
    let env = Env::new();
    let request = scene_request(&env);
    let consumed = consumed_for(&env, &request).unwrap();
    let snapshot = env.snapshot();
    let core = env.core();
    let (during_tx, during_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let budget = budget().with_failpoint(commit_probe(during_tx, release_rx));
    let (finished_tx, finished_rx) = mpsc::channel();
    thread::scope(|scope| {
        scope.spawn(|| {
            let result = declare_scene_body(&snapshot, consumed, request, &budget);
            finished_tx.send(result.is_ok()).unwrap();
        });
        during_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("COMMIT started");
        // Shutdown is requested while COMMIT has not returned. No evidence is
        // produced and the writer does not return.
        let _ = core.request_shutdown();
        assert!(
            finished_rx
                .recv_timeout(Duration::from_millis(500))
                .is_err(),
            "the writer returned before its COMMIT did"
        );
        release_tx.send(()).unwrap();
        // The COMMIT ends; the writer settles (the write stands or is proven).
        assert!(finished_rx.recv_timeout(Duration::from_secs(10)).is_ok());
    });
}
