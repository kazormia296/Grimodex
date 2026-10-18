//! B group: a COMMIT whose outcome is unknown (CB-2 S1).
#![cfg(feature = "native-current-human-capture")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::commit_outcome::test_hooks as reread_hooks;
use super::writer::test_hooks as write_hooks;
use super::writer_support_tests::*;
use super::*;
use crate::nir1_generation::Nir1GenerationFailpoint;

fn with_failpoint(
    failpoint: Nir1GenerationFailpoint,
) -> crate::nir1_generation::Nir1AdmissionSqlBudget {
    budget().with_failpoint(failpoint)
}

fn declare_with(
    env: &Env,
    budget: &crate::nir1_generation::Nir1AdmissionSqlBudget,
) -> Result<DeclareOutcome, DeclareFailure> {
    let request = scene_request(env);
    let consumed = consumed_for(env, &request).expect("preview");
    declare_scene_body(&env.snapshot(), consumed, request, budget)
}

fn table_names(env: &Env) -> Vec<String> {
    env.with_conn(|conn| {
        let mut statement =
            conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")?;
        let names = statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(names)
    })
}

#[test]
fn commit_unknown_but_applied_is_success() {
    write_hooks::reset();
    reread_hooks::reset();
    let env = Env::new();
    let outcome = declare_with(
        &env,
        &with_failpoint(Nir1GenerationFailpoint::ErrorAfterCommit),
    )
    .unwrap();
    assert_eq!(outcome.response, DeclareResponse::Declared);
    assert!(outcome.recovered_after_unknown_commit);
    assert!(!outcome.replayed);
    assert_eq!(outcome.evidence.kind(), TerminalKind::Committed);
    assert!(
        env.declaration_token(SCENE).is_some(),
        "the declaration is there"
    );
    assert_eq!(
        reread_hooks::rereads(),
        1,
        "the identifiers were reread once"
    );
    assert_eq!(
        write_hooks::transactions_opened(),
        1,
        "B4: no implicit retry"
    );
    assert!(!is_scene_body_declaration_quarantined(&env.identity()));
}

#[test]
fn commit_failed_before_write_is_failure_and_requires_new_confirmation() {
    write_hooks::reset();
    reread_hooks::reset();
    let env = Env::new();
    let request = scene_request(&env);
    let consumed = consumed_for(&env, &request).unwrap();
    let failure = declare_scene_body(
        &env.snapshot(),
        consumed,
        request.clone(),
        &with_failpoint(Nir1GenerationFailpoint::VetoCommit),
    )
    .unwrap_err();
    assert_eq!(failure.refusal, DeclareRefusal::CommitFailed);
    assert_eq!(failure.refusal.code(), "commit-failed");
    assert_eq!(
        failure.evidence.as_ref().unwrap().kind(),
        TerminalKind::RolledBack
    );
    assert_eq!(env.declaration_token(SCENE), None, "nothing was written");
    assert_eq!(reread_hooks::rereads(), 1);
    assert_eq!(
        write_hooks::transactions_opened(),
        1,
        "B4: no implicit retry"
    );
    assert!(!is_scene_body_declaration_quarantined(&env.identity()));
    // The consumed confirmation is gone (it was moved into the call); a new
    // preview and a new confirmation write the declaration.
    declare(&env, request).expect("a new confirmation");
}

#[test]
fn commit_unknown_and_unreadable_quarantines_until_restart() {
    for variant in ["reread fails", "identifiers disagree"] {
        write_hooks::reset();
        reread_hooks::reset();
        let mut env = Env::new();
        let tables_before = table_names(&env);
        let counts_before = env.with_conn(|conn| {
            Ok((
                count(conn, "SELECT count(*) FROM idempotency_requests"),
                count(conn, "SELECT count(*) FROM change_events"),
            ))
        });
        if variant == "reread fails" {
            reread_hooks::fail_reread(true);
        } else {
            // The COMMIT applied, but the record is gone when it is reread:
            // the three identifiers disagree.
            let db = env.db();
            reread_hooks::set_before_reread(Some(Box::new(move || {
                db.db()
                    .with_conn(|conn| {
                        conn.execute("DELETE FROM idempotency_requests", [])?;
                        Ok(())
                    })
                    .unwrap();
            })));
        }
        let failure = declare_with(
            &env,
            &with_failpoint(Nir1GenerationFailpoint::ErrorAfterCommit),
        )
        .unwrap_err();
        assert_eq!(
            failure.refusal,
            DeclareRefusal::RestartRequired,
            "{variant}"
        );
        assert_eq!(failure.refusal.code(), "restart-required");
        assert_eq!(
            failure.evidence.as_ref().unwrap().kind(),
            TerminalKind::QuarantinedUnknown,
            "{variant}"
        );
        reread_hooks::reset();
        let identity = env.identity();
        assert!(
            is_scene_body_declaration_quarantined(&identity),
            "{variant}"
        );

        // Writes are refused without opening a transaction, for declare and
        // revoke alike; other operations still work.
        write_hooks::reset();
        let again = declare(&env, scene_request(&env)).unwrap_err();
        assert_eq!(again.refusal, DeclareRefusal::RestartRequired);
        assert!(again.evidence.is_none());
        let revoke = revoke_scene_body(
            &env.snapshot(),
            revoke_request(PROJECT, SCENE, "sha256:x"),
            &budget(),
        )
        .unwrap_err();
        assert_eq!(revoke.refusal, DeclareRefusal::RestartRequired);
        assert_eq!(write_hooks::transactions_opened(), 0);
        assert_eq!(
            preview_scene_body_declaration(&env.snapshot(), &scene_request(&env), &budget())
                .unwrap_err(),
            DeclareRefusal::RestartRequired
        );
        env.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes SET title = 'still editable' WHERE id = 's2'",
                [],
            )?;
            Ok(())
        });

        // It survives Close and Open of the workspace.
        env.reopen();
        assert!(
            is_scene_body_declaration_quarantined(&env.identity()),
            "{variant}: after reopen"
        );
        assert_eq!(
            declare(&env, scene_request(&env)).unwrap_err().refusal,
            DeclareRefusal::RestartRequired
        );

        // No marker and no new row kind was written.
        assert_eq!(table_names(&env), tables_before, "{variant}: no new table");
        let counts_after = env.with_conn(|conn| {
            Ok((
                count(conn, "SELECT count(*) FROM idempotency_requests"),
                count(conn, "SELECT count(*) FROM change_events"),
            ))
        });
        assert!(counts_after.0 <= counts_before.0 + 1 && counts_after.1 <= counts_before.1 + 1);

        // A restart (here: releasing the registry entry) lifts it. The state is
        // decided by the database alone.
        clear_scene_body_declaration_quarantine_for_test(&env.identity());
        assert!(!is_scene_body_declaration_quarantined(&env.identity()));
        declare(&env, scene_request(&env)).expect("after the restart");
    }
}

#[test]
fn quarantine_is_per_workspace() {
    write_hooks::reset();
    reread_hooks::reset();
    let env = Env::new();
    let other = Env::new();
    reread_hooks::fail_reread(true);
    declare_with(
        &env,
        &with_failpoint(Nir1GenerationFailpoint::ErrorAfterCommit),
    )
    .unwrap_err();
    reread_hooks::reset();
    assert!(is_scene_body_declaration_quarantined(&env.identity()));
    assert!(!is_scene_body_declaration_quarantined(&other.identity()));
    assert!(is_workspace_scene_body_declaration_quarantined(
        &env.snapshot()
    ));
    assert!(!is_workspace_scene_body_declaration_quarantined(
        &other.snapshot()
    ));
    declare(&other, scene_request(&other)).expect("another workspace is not affected");
    clear_scene_body_declaration_quarantine_for_test(&env.identity());
}

#[test]
fn commit_panic_is_unknown() {
    write_hooks::reset();
    reread_hooks::reset();
    let env = Env::new();
    write_hooks::panic_after_ready(true);
    let failure = declare_with(&env, &budget()).unwrap_err();
    write_hooks::panic_after_ready(false);
    // The panic after the transaction was ready to COMMIT is treated as an
    // unknown outcome: the identifiers were reread. The scope rolled the
    // transaction back, so the reread proves nothing was written.
    assert_eq!(reread_hooks::rereads(), 1);
    assert_eq!(failure.refusal, DeclareRefusal::CommitFailed);
    assert_eq!(
        failure.evidence.as_ref().unwrap().kind(),
        TerminalKind::RolledBack
    );
    assert_eq!(env.declaration_token(SCENE), None);
    assert!(!is_scene_body_declaration_quarantined(&env.identity()));
    // The connection is still usable.
    declare(&env, scene_request(&env)).expect("after the panic");
}

#[test]
fn a_failure_before_commit_is_not_reread() {
    write_hooks::reset();
    reread_hooks::reset();
    let env = Env::new();
    write_hooks::fail_at(Some(super::writer::Stage::AfterFeed));
    let failure = declare_with(&env, &budget()).unwrap_err();
    write_hooks::reset();
    assert_eq!(
        reread_hooks::rereads(),
        0,
        "a rolled-back write needs no reread"
    );
    assert_eq!(failure.evidence.unwrap().kind(), TerminalKind::RolledBack);
}

#[test]
fn terminal_evidence_is_unforgeable() {
    let evidence = include_str!("commit_outcome.rs");
    let struct_start = evidence
        .find("pub struct DeclarationTerminalEvidence")
        .unwrap();
    let struct_body =
        &evidence[struct_start..evidence[struct_start..].find('}').unwrap() + struct_start];
    assert!(
        !struct_body.contains("pub kind")
            && !struct_body.contains("pub(crate)")
            && !struct_body.contains("pub(super)"),
        "the field is private: {struct_body}"
    );
    assert!(
        evidence.contains("    fn new(kind: TerminalKind) -> Self {"),
        "the constructor is private to commit_outcome"
    );
    assert!(!evidence.contains("pub fn new(kind: TerminalKind)"));
    assert!(!evidence.contains("pub(super) fn new(kind: TerminalKind)"));
    assert!(!evidence.contains("pub(crate) fn new(kind: TerminalKind)"));
    assert!(!evidence.contains("impl Default for DeclarationTerminalEvidence"));
    // No other module builds one.
    for (name, source) in [
        ("writer.rs", include_str!("writer.rs")),
        ("revoke.rs", include_str!("revoke.rs")),
        ("facts.rs", include_str!("facts.rs")),
        ("binding.rs", include_str!("binding.rs")),
    ] {
        assert!(
            !source.contains("DeclarationTerminalEvidence {")
                && !source.contains("DeclarationTerminalEvidence::new")
                && !source.contains("TerminalKind::"),
            "{name} must not build terminal evidence"
        );
    }
    // Every success and every refusal that ran a transaction carries evidence.
    let _: fn(&DeclareOutcome) -> &DeclarationTerminalEvidence = |outcome| &outcome.evidence;
    let _: fn(&RevokeOutcome) -> &DeclarationTerminalEvidence = |outcome| &outcome.evidence;
}

#[test]
fn a_replay_whose_empty_commit_is_unknown_does_not_quarantine() {
    write_hooks::reset();
    reread_hooks::reset();
    let env = Env::new();
    let request = scene_request(&env);
    let consumed = consumed_for(&env, &request).expect("preview");
    let stale = consumed.binding().clone();
    declare_scene_body(&env.snapshot(), consumed, request.clone(), &budget()).unwrap();
    let token = env.declaration_token(SCENE);
    assert!(token.is_some());

    // The same request again: the recorded response is found, nothing is
    // written, and COMMIT of that empty transaction reports Unknown.
    let again = declare_scene_body(
        &env.snapshot(),
        ConsumedBodyDeclarationBinding::from_consumed_grant(stale),
        request.clone(),
        &with_failpoint(Nir1GenerationFailpoint::ErrorAfterCommit),
    )
    .unwrap();
    assert!(again.replayed);
    assert_eq!(again.response, DeclareResponse::Declared);
    assert_eq!(again.evidence.kind(), TerminalKind::Committed);
    assert_eq!(reread_hooks::rereads(), 0, "nothing to reread");
    assert!(!is_scene_body_declaration_quarantined(&env.identity()));
    assert_eq!(env.declaration_token(SCENE), token);

    // The same holds for a revoke replay.
    let token = token.unwrap();
    let revoke = revoke_request(PROJECT, SCENE, &token);
    revoke_scene_body(&env.snapshot(), revoke.clone(), &budget()).unwrap();
    let again = revoke_scene_body(
        &env.snapshot(),
        revoke,
        &with_failpoint(Nir1GenerationFailpoint::ErrorAfterCommit),
    )
    .unwrap();
    assert!(again.replayed);
    assert_eq!(again.response, RevokeResponse::Revoked);
    assert!(!is_scene_body_declaration_quarantined(&env.identity()));
}
