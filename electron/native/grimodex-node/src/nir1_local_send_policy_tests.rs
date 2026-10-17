//! Tests of the NIR-1 local send AI policy check (DT-4 T2). They run on the
//! DT-2 owner fixture so the workspace, the project row and the real owner
//! cancel are the production ones; the check is not wired to the owner.

use super::*;
use crate::nir1_local_send_policy::{
    check_before_attempt, read_before_send, Nir1LocalSendPolicyOutcome as Outcome,
    Nir1LocalSendPolicyRefusal as Refusal, Nir1PreSendPolicy,
};
use grimodex_core::nir1_local_send_policy::{
    Nir1LocalSendPolicyDenial as Denial, Nir1LocalSendPolicySource as Source,
    Nir1LocalSendPurpose as Purpose,
};
use grimodex_db::state::active_workspace_snapshot;

const PURPOSES: [Purpose; 2] = [Purpose::Writing, Purpose::Review];

fn set_policy(fixture: &OwnerFixture, raw: &str) {
    fixture
        .authority
        .db()
        .with_conn(|conn| {
            conn.execute(
                "UPDATE projects SET ai_policy=?2 WHERE id=?1",
                [PROJECT, raw],
            )?;
            Ok(())
        })
        .expect("set the policy");
}

fn snapshot(fixture: &OwnerFixture) -> ActiveWorkspaceSnapshot {
    active_workspace_snapshot(&fixture.state.ws).expect("workspace snapshot")
}

/// Both entries, so a change in one is a change in the other.
fn both(
    workspace: &ActiveWorkspaceSnapshot,
    fixture: &OwnerFixture,
    purpose: Purpose,
) -> (Outcome, Nir1PreSendPolicy) {
    let budget = fixture.admission_budget();
    (
        check_before_attempt(workspace, PROJECT, purpose, &budget),
        read_before_send(workspace, PROJECT, purpose, &budget),
    )
}

fn assert_refused_with(outcome: Outcome, expected: Refusal, what: &str) {
    assert_eq!(outcome, Outcome::Refused(expected), "{what}");
}

/// The project row a fresh workspace creates has the schema default
/// (preset `custom`, chat, bodyWrite and analysis true), so both purposes are
/// allowed without anyone writing a policy.
#[test]
fn nir1_local_send_policy_the_default_project_allows_both_purposes() {
    let fixture = OwnerFixture::new();
    let workspace = snapshot(&fixture);
    for purpose in PURPOSES {
        let (before_attempt, before_send) = both(&workspace, &fixture, purpose);
        let Outcome::Allowed(basis) = before_attempt else {
            panic!("{purpose:?}: {before_attempt:?}");
        };
        assert_eq!(basis.purpose, purpose);
        assert_eq!(basis.source, Source::Stored);
        assert!(basis.items.iter().all(|item| item.value));
        assert!(before_send.permits());
        assert_eq!(before_send.basis(), Some(&basis));
        assert_eq!(before_send.refusal(), None);
    }
}

/// Every chat/bodyWrite/analysis combination of every preset, written to the
/// database immediately before each read: the answer follows the latest commit
/// at both entries (nothing is cached) and is exactly the draft's rule.
#[test]
fn nir1_local_send_policy_follows_the_latest_stored_policy_without_a_cache() {
    let fixture = OwnerFixture::new();
    let workspace = snapshot(&fixture);
    for preset in ["full", "assist-off", "review-only", "off", "custom"] {
        for bits in 0u8..8 {
            let (chat, body, analysis) = (bits & 1 != 0, bits & 2 != 0, bits & 4 != 0);
            set_policy(
                &fixture,
                &format!(
                    "{{\"preset\":\"{preset}\",\"toggles\":{{\"chat\":{chat},\"bodyWrite\":{body},\"analysis\":{analysis}}}}}"
                ),
            );
            for (purpose, expected) in [
                (Purpose::Writing, chat && body),
                (Purpose::Review, chat && analysis),
            ] {
                let (before_attempt, before_send) = both(&workspace, &fixture, purpose);
                assert_eq!(
                    before_attempt.is_allowed(),
                    expected,
                    "{preset} {bits:03b} {purpose:?} before attempt"
                );
                assert_eq!(
                    before_send.permits(),
                    expected,
                    "{preset} {bits:03b} {purpose:?} before send"
                );
                if !expected {
                    assert!(matches!(
                        before_attempt,
                        Outcome::Refused(Refusal::Policy(Denial::ItemDisabled(_)))
                    ));
                }
            }
        }
    }
}

/// The policy turning off between the two reads is seen by the second one,
/// which is what stops a send after an attempt was created.
#[test]
fn nir1_local_send_policy_a_policy_turned_off_after_the_attempt_check_stops_the_send() {
    let fixture = OwnerFixture::new();
    let workspace = snapshot(&fixture);
    let budget = fixture.admission_budget();
    assert!(check_before_attempt(&workspace, PROJECT, Purpose::Writing, &budget).is_allowed());
    set_policy(
        &fixture,
        r#"{"preset":"custom","toggles":{"chat":true,"bodyWrite":false,"analysis":true}}"#,
    );
    let pre_send = read_before_send(&workspace, PROJECT, Purpose::Writing, &budget);
    assert!(!pre_send.permits());
    assert_eq!(
        pre_send.refusal(),
        Some(&Refusal::Policy(Denial::ItemDisabled("bodyWrite")))
    );
    assert!(read_before_send(&workspace, PROJECT, Purpose::Review, &budget).permits());
}

/// Values the existing parsers turn into "full" are refused here, at both
/// entries and both purposes (fail-closed).
#[test]
fn nir1_local_send_policy_unreadable_values_refuse_instead_of_defaulting_to_full() {
    let fixture = OwnerFixture::new();
    let workspace = snapshot(&fixture);
    let cases: [(&str, Denial); 9] = [
        ("", Denial::Blank),
        ("  \n", Denial::Blank),
        ("not-json", Denial::NotJson),
        ("[]", Denial::NotObject),
        (
            r#"{"preset":"bogus","toggles":{"chat":true,"bodyWrite":true,"analysis":true}}"#,
            Denial::PresetInvalid,
        ),
        (
            r#"{"preset":"full","toggles":[]}"#,
            Denial::TogglesNotObject,
        ),
        (
            r#"{"preset":"full","toggles":{"chat":true,"bodyWrite":true}}"#,
            Denial::ToggleMissing("analysis"),
        ),
        (
            r#"{"preset":"full","toggles":{"chat":"true","bodyWrite":true,"analysis":true}}"#,
            Denial::ToggleNotBoolean("chat"),
        ),
        (
            r#"{"preset":"full","toggles":{"chat":true,"bodyWrite":null,"analysis":true}}"#,
            Denial::ToggleNotBoolean("bodyWrite"),
        ),
    ];
    for (raw, denial) in cases {
        set_policy(&fixture, raw);
        for purpose in PURPOSES {
            let (before_attempt, before_send) = both(&workspace, &fixture, purpose);
            assert_refused_with(before_attempt, Refusal::Policy(denial), raw);
            assert_eq!(before_send.outcome(), before_attempt, "{raw}");
            assert!(!before_send.permits(), "{raw}");
        }
    }
}

#[test]
fn nir1_local_send_policy_a_value_that_is_not_text_or_too_large_refuses() {
    let fixture = OwnerFixture::new();
    let workspace = snapshot(&fixture);
    fixture
        .authority
        .db()
        .with_conn(|conn| {
            conn.execute(
                "UPDATE projects SET ai_policy=X'7b7d' WHERE id=?1",
                [PROJECT],
            )?;
            Ok(())
        })
        .expect("blob policy");
    for purpose in PURPOSES {
        assert_refused_with(
            both(&workspace, &fixture, purpose).0,
            Refusal::Policy(Denial::NotText),
            "blob",
        );
    }
    set_policy(&fixture, &"x".repeat(100_000));
    for purpose in PURPOSES {
        let (before_attempt, before_send) = both(&workspace, &fixture, purpose);
        assert_refused_with(
            before_attempt,
            Refusal::Policy(Denial::TooLarge),
            "oversize",
        );
        assert!(!before_send.permits());
    }
}

#[test]
fn nir1_local_send_policy_a_missing_project_refuses() {
    let fixture = OwnerFixture::new();
    let workspace = snapshot(&fixture);
    let budget = fixture.admission_budget();
    for purpose in PURPOSES {
        assert_refused_with(
            check_before_attempt(&workspace, "no-such-project", purpose, &budget),
            Refusal::ProjectMissing,
            "before attempt",
        );
        let pre_send = read_before_send(&workspace, "no-such-project", purpose, &budget);
        assert_eq!(pre_send.refusal(), Some(&Refusal::ProjectMissing));
        assert!(!pre_send.permits());
    }
    // An ID that is not a valid identity never reaches the database.
    assert_refused_with(
        check_before_attempt(&workspace, "", Purpose::Writing, &budget),
        Refusal::ReadFailed(Nir1StoreFailure::Invalid),
        "empty project ID",
    );
}

/// A read that does not complete refuses: busy, cancelled, admission closed.
#[test]
fn nir1_local_send_policy_a_read_that_fails_refuses_at_both_entries() {
    let fixture = OwnerFixture::new();
    let workspace = snapshot(&fixture);

    // The connection mutex is held: the read ends at the mutex limit, typed.
    let (release, holder) = hold_connection(&fixture.authority);
    let production =
        Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), Arc::new(|| true));
    for purpose in PURPOSES {
        let started = Instant::now();
        let outcome = check_before_attempt(&workspace, PROJECT, purpose, &production);
        assert_refused_with(
            outcome,
            Refusal::ReadFailed(Nir1StoreFailure::ConnectionBusy),
            "held mutex before attempt",
        );
        assert!(started.elapsed() < Duration::from_millis(250));
        let pre_send = read_before_send(&workspace, PROJECT, purpose, &production);
        assert_eq!(
            pre_send.refusal(),
            Some(&Refusal::ReadFailed(Nir1StoreFailure::ConnectionBusy))
        );
        assert!(!pre_send.permits());
    }
    release.send(()).expect("release the mutex");
    holder.join().expect("holder");

    // The caller's cancel flag and a closed admission probe interrupt it.
    let cancelled = Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(true)), Arc::new(|| true));
    assert_refused_with(
        check_before_attempt(&workspace, PROJECT, Purpose::Writing, &cancelled),
        Refusal::ReadFailed(Nir1StoreFailure::Cancelled),
        "cancelled",
    );
    let closed = Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), Arc::new(|| false));
    assert_refused_with(
        check_before_attempt(&workspace, PROJECT, Purpose::Review, &closed),
        Refusal::ReadFailed(Nir1StoreFailure::Fenced),
        "admission closed",
    );

    // Nothing was left behind: a later read works.
    assert!(check_before_attempt(
        &workspace,
        PROJECT,
        Purpose::Writing,
        &fixture.admission_budget()
    )
    .is_allowed());
}

/// The read right before the send is made outside the lock that cancel shares,
/// so a slow database never delays a cancel. A real DT-2 owner's cancel handle
/// (stop flag and phase mutex only) returns while another thread is blocked in
/// the policy read on a held connection mutex; the read then ends as a refusal.
#[test]
fn nir1_local_send_policy_a_slow_pre_send_read_does_not_delay_the_owner_cancel() {
    let fixture = OwnerFixture::new();
    let prepared = fixture.prepared(0, "policy-cancel");
    let cancel = prepared.cancel_handle();
    let workspace = snapshot(&fixture);
    let (release, holder) = hold_connection(&fixture.authority);
    let production =
        Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), Arc::new(|| true));
    let read_done = Arc::new(AtomicBool::new(false));
    let (started_tx, started_rx) = mpsc::channel();
    thread::scope(|scope| {
        let reader = scope.spawn({
            let read_done = Arc::clone(&read_done);
            let workspace = &workspace;
            let production = &production;
            move || {
                started_tx.send(()).expect("announce the read");
                let pre_send = read_before_send(workspace, PROJECT, Purpose::Writing, production);
                read_done.store(true, Ordering::Release);
                pre_send
            }
        });
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the read started");
        let (cancel_tx, cancel_rx) = mpsc::channel();
        scope.spawn(move || {
            cancel.cancel();
            cancel_tx.send(()).expect("cancel done");
        });
        cancel_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("cancel returned without waiting for the database");
        let read_done_when_cancel_returned = read_done.load(Ordering::Acquire);
        let pre_send = reader.join().expect("reader");
        assert_eq!(
            pre_send.refusal(),
            Some(&Refusal::ReadFailed(Nir1StoreFailure::ConnectionBusy)),
            "the held database made the read fail closed"
        );
        assert!(
            !read_done_when_cancel_returned,
            "cancel returned while the policy read was still blocked on the database"
        );
    });
    release.send(()).expect("release the mutex");
    holder.join().expect("holder");
}

/// The module has no N-API or IPC entry and does not touch the owner.
#[test]
fn nir1_local_send_policy_has_no_napi_entry_and_is_not_wired_to_the_owner() {
    let source = include_str!("nir1_local_send_policy.rs");
    assert!(!source.contains(&format!("#[{}", "napi")));
    let owner = include_str!("nir1_generation_owner.rs");
    assert!(!owner.contains("nir1_local_send_policy"));
}
