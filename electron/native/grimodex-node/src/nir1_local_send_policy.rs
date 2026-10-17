//! AI usage policy check of the NIR-1 local send route (K5/3, B-2).
//!
//! A thin, internal module. It has no N-API entry, no IPC route and no caller
//! yet: DD-1 decides whether the check before an attempt runs before or after
//! `capture`, and DT-5 calls the check right before a send. It is not wired to
//! the DT-2 owner here.
//!
//! The Native side reads the conversation's project `projects.ai_policy` from
//! the pinned workspace's own database, fresh on every call (no cache, nothing
//! from the renderer or Main), and asks
//! `grimodex_core::nir1_local_send_policy::decide` whether the purpose may
//! proceed. Writing needs `chat` and `bodyWrite`; Review needs `chat` and
//! `analysis`. A row that is missing, a value that cannot be read, and a read
//! that failed (busy, timed out, cancelled, fenced) all refuse: the caller
//! sends nothing. The existing lenient parsers are not used.
//!
//! Two entries, so a caller cannot confuse them:
//!
//! - [`check_before_attempt`] runs before the attempt is created and returns an
//!   [`Nir1LocalSendPolicyOutcome`].
//! - [`read_before_send`] runs right before the send and returns a
//!   [`Nir1PreSendPolicy`]. It takes no lock and the value it returns holds no
//!   guard, no connection and no borrow: it is plain data. DT-5 calls it
//!   outside the lock that is shared with cancel, and inside that lock only
//!   [`Nir1PreSendPolicy::permits`] is evaluated, so a slow database read can
//!   never delay a cancel (K5/3 required defense 11).

#![cfg_attr(not(test), allow(dead_code))]

use grimodex_core::nir1_local_send_policy::{
    decide, Nir1LocalSendPolicyBasis, Nir1LocalSendPolicyDecision, Nir1LocalSendPolicyDenial,
    Nir1LocalSendPurpose,
};
use grimodex_db::nir1_generation::{
    read_project_ai_policy_bounded, Nir1AdmissionSqlBudget, Nir1ProjectAiPolicyRead,
    Nir1StoreFailure,
};
use grimodex_db::state::ActiveWorkspaceSnapshot;

/// Why a send is refused. Every variant means: no attempt, or no send.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub(crate) enum Nir1LocalSendPolicyRefusal {
    /// The stored value is unreadable, or this purpose's item is false.
    Policy(Nir1LocalSendPolicyDenial),
    /// No project row has this ID.
    ProjectMissing,
    /// The bounded read did not complete.
    ReadFailed(Nir1StoreFailure),
}

/// The result of one policy read and decision.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[must_use]
pub(crate) enum Nir1LocalSendPolicyOutcome {
    /// Allowed, with the basis the audit records. The basis explains the
    /// decision; it is not an authorization token.
    Allowed(Nir1LocalSendPolicyBasis),
    Refused(Nir1LocalSendPolicyRefusal),
}

impl Nir1LocalSendPolicyOutcome {
    pub(crate) fn is_allowed(&self) -> bool {
        matches!(self, Self::Allowed(_))
    }
}

/// The result of the read right before a send. Plain data: it owns no lock
/// guard, connection or borrowed value, and has no method that reads the
/// database, so it can be evaluated under a short lock.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[must_use]
pub(crate) struct Nir1PreSendPolicy(Nir1LocalSendPolicyOutcome);

impl Nir1PreSendPolicy {
    /// Pure: the policy allowed this purpose when it was read.
    pub(crate) fn permits(&self) -> bool {
        self.0.is_allowed()
    }

    pub(crate) fn basis(&self) -> Option<&Nir1LocalSendPolicyBasis> {
        match &self.0 {
            Nir1LocalSendPolicyOutcome::Allowed(basis) => Some(basis),
            Nir1LocalSendPolicyOutcome::Refused(_) => None,
        }
    }

    pub(crate) fn refusal(&self) -> Option<&Nir1LocalSendPolicyRefusal> {
        match &self.0 {
            Nir1LocalSendPolicyOutcome::Allowed(_) => None,
            Nir1LocalSendPolicyOutcome::Refused(refusal) => Some(refusal),
        }
    }

    pub(crate) fn outcome(&self) -> Nir1LocalSendPolicyOutcome {
        self.0
    }
}

// The pre-send value crosses threads and outlives every guard it was read
// beside.
const _: () = {
    const fn assert_plain_data<T: Send + Sync + Copy + 'static>() {}
    assert_plain_data::<Nir1PreSendPolicy>();
    assert_plain_data::<Nir1LocalSendPolicyOutcome>();
};

fn evaluate(
    workspace: &ActiveWorkspaceSnapshot,
    project_id: &str,
    purpose: Nir1LocalSendPurpose,
    budget: &Nir1AdmissionSqlBudget,
) -> Nir1LocalSendPolicyOutcome {
    use Nir1LocalSendPolicyOutcome::{Allowed, Refused};
    use Nir1LocalSendPolicyRefusal::{Policy, ProjectMissing, ReadFailed};
    match read_project_ai_policy_bounded(workspace, project_id, budget) {
        Err(error) => Refused(ReadFailed(error.failure())),
        Ok(Nir1ProjectAiPolicyRead::ProjectMissing) => Refused(ProjectMissing),
        Ok(Nir1ProjectAiPolicyRead::NotText) => Refused(Policy(Nir1LocalSendPolicyDenial::NotText)),
        Ok(Nir1ProjectAiPolicyRead::TooLarge) => {
            Refused(Policy(Nir1LocalSendPolicyDenial::TooLarge))
        }
        Ok(Nir1ProjectAiPolicyRead::Text(raw)) => match decide(Some(&raw), purpose) {
            Nir1LocalSendPolicyDecision::Allowed(basis) => Allowed(basis),
            Nir1LocalSendPolicyDecision::Denied(denial) => Refused(Policy(denial)),
        },
        // `Nir1ProjectAiPolicyRead` is non_exhaustive: anything new refuses.
        Ok(_) => Refused(Policy(Nir1LocalSendPolicyDenial::NotText)),
    }
}

/// The read before an attempt is created (before DT-2's claim). A refusal means
/// no attempt, no audit event and no send. `budget` is the admission budget of
/// the caller (its cancel flag and admission probe interrupt the read).
pub(crate) fn check_before_attempt(
    workspace: &ActiveWorkspaceSnapshot,
    project_id: &str,
    purpose: Nir1LocalSendPurpose,
    budget: &Nir1AdmissionSqlBudget,
) -> Nir1LocalSendPolicyOutcome {
    evaluate(workspace, project_id, purpose, budget)
}

/// The read right before the send (after the audit start, before the
/// connection). Call it outside the lock that cancel shares; evaluate only
/// [`Nir1PreSendPolicy::permits`] inside that lock.
pub(crate) fn read_before_send(
    workspace: &ActiveWorkspaceSnapshot,
    project_id: &str,
    purpose: Nir1LocalSendPurpose,
    budget: &Nir1AdmissionSqlBudget,
) -> Nir1PreSendPolicy {
    Nir1PreSendPolicy(evaluate(workspace, project_id, purpose, budget))
}
