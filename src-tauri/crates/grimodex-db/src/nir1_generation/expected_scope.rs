//! What a product create and claim re-read inside their own transaction
//! beyond the capture: the target Scene's Scope binding and the project's
//! restore epoch (K4/3 Mandatory defenses (2)(3), DI-1c R-5), and the request
//! of a product create, whose clock is Native's (R-6).
//!
//! The expectation is a value read once, in the D-final snapshot, by
//! [`read_expected_scope_in_tx`]. A create and a claim read the same two rows
//! with the same function and refuse (`NotCurrent`) when the value differs.
//! The expectation does not depend on the history slot: an attempt that stores
//! no context (`binding-limit`, any unavailable reason) is checked the same
//! way. Both values are digests under the history digest domains, so they are
//! the values that a context records (`target.bindingTokenDigest`,
//! `restoreEpoch.idDigest`), without a second encoding.
//!
//! The reader takes the two raw rows and validates nothing: a corrupt Scope
//! row is a value like another one, and a later write that repairs or changes
//! it is a different value. That keeps the check one indexed lookup each, and
//! a turn whose Scope was unreadable when it was prepared is not refused for
//! it (it is refused only when the state changes after the snapshot).

use super::history_context::{HistoryDigest, HistoryDigestDomain};
use super::*;

/// The longest lifetime a product create accepts (5 minutes). It bounds the
/// stages after the create: the re-observation of the adopted inputs, the
/// claim and the start decision, each of which is itself bounded by the
/// per-operation limit (250 ms) or by the participant read budget. A longer
/// lifetime would let a request that was prepared against an old state wait
/// for its claim; the claim also refuses at `expires_at_ms`.
pub const NIR1_ATTEMPT_MAX_LIFETIME_MS: i64 = 5 * 60 * 1000;

const LIFETIME_INVALID_ERROR: &str = "NIR1_GENERATION_LIFETIME_INVALID";
#[cfg_attr(not(feature = "native-current-human-capture"), allow(dead_code))]
const SCOPE_NOT_CURRENT_ERROR: &str = "NIR1_GENERATION_SCOPE_BINDING_NOT_CURRENT";
#[cfg_attr(not(feature = "native-current-human-capture"), allow(dead_code))]
const EPOCH_NOT_CURRENT_ERROR: &str = "NIR1_GENERATION_RESTORE_EPOCH_NOT_CURRENT";

/// The target Scene's Scope binding as the row holds it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Nir1ScopeBindingState {
    /// `ScopeBindingToken` digest of `narrative_scene_scope_bindings.source_token`.
    pub token_digest: HistoryDigest,
    pub version: i64,
}

/// The project's latest Semantic Epoch as the row holds it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Nir1RestoreEpochState {
    /// `RestoreEpochId` digest of the epoch id.
    pub id_digest: HistoryDigest,
    pub number: i64,
}

/// The two values a create and a claim compare. `None` is an absent row, and
/// an absent row at the snapshot must still be absent when it is checked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Nir1ExpectedScope {
    pub scope_binding: Option<Nir1ScopeBindingState>,
    pub restore_epoch: Option<Nir1RestoreEpochState>,
}

/// Read the Scope binding of `scene_id` and the restore epoch of `project_id`
/// in the caller's transaction. Used both for the D-final snapshot's
/// expectation and for the re-read of a create and a claim, so the compared
/// values never come from two different readers.
pub fn read_expected_scope_in_tx(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> Result<Nir1ExpectedScope> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1_GENERATION_TRANSACTION_REQUIRED"
    );
    identity(project_id)?;
    identity(scene_id)?;
    let scope: Option<(i64, String)> = conn
        .query_row(
            "SELECT version, source_token FROM narrative_scene_scope_bindings
              WHERE project_id=?1 AND scene_id=?2",
            params![project_id, scene_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let scope_binding = match scope {
        Some((version, token)) => Some(Nir1ScopeBindingState {
            token_digest: HistoryDigest::of(HistoryDigestDomain::ScopeBindingToken, &token)?,
            version,
        }),
        None => None,
    };
    let restore_epoch = match crate::narrative_extraction::get_current_epoch(conn, project_id)? {
        Some(epoch) => Some(Nir1RestoreEpochState {
            id_digest: HistoryDigest::of(HistoryDigestDomain::RestoreEpochId, &epoch.id)?,
            number: epoch.epoch_number,
        }),
        None => None,
    };
    Ok(Nir1ExpectedScope {
        scope_binding,
        restore_epoch,
    })
}

impl Nir1ExpectedScope {
    /// Re-read both values and refuse a difference as `NotCurrent`.
    #[cfg_attr(not(feature = "native-current-human-capture"), allow(dead_code))]
    pub(super) fn require_current_in_tx(
        &self,
        conn: &Connection,
        project_id: &str,
        scene_id: &str,
    ) -> Result<()> {
        let current = read_expected_scope_in_tx(conn, project_id, scene_id)?;
        if current.scope_binding != self.scope_binding {
            return Err(domain_failure(
                Nir1StoreFailure::NotCurrent,
                SCOPE_NOT_CURRENT_ERROR,
            ));
        }
        if current.restore_epoch != self.restore_epoch {
            return Err(domain_failure(
                Nir1StoreFailure::NotCurrent,
                EPOCH_NOT_CURRENT_ERROR,
            ));
        }
        Ok(())
    }
}

/// A product create. It carries the lifetime, never an absolute time: the
/// create transaction reads Native's clock once and derives `created_at_ms`,
/// `expires_at_ms` and the history `eligibleUntilMs` from that single value.
/// The caller cannot supply, back-date or post-date any of them.
#[derive(Clone, Debug)]
pub struct NewCaptureAttempt {
    pub binding: AttemptBinding,
    pub payload_digest: String,
    pub inputs: Vec<InputReference>,
    pub qualifications: Vec<QualificationReference>,
    /// `1..=NIR1_ATTEMPT_MAX_LIFETIME_MS` milliseconds.
    pub lifetime_ms: i64,
    /// The Scope binding and restore epoch the D-final snapshot read.
    pub expected_scope: Nir1ExpectedScope,
    pub budget: ReadBudget,
}

impl NewCaptureAttempt {
    /// The same request with the times a clock reading of `created_at_ms`
    /// gives.
    pub(super) fn at(&self, created_at_ms: i64) -> Result<NewAttempt> {
        let expires_at_ms = created_at_ms
            .checked_add(self.lifetime_ms)
            .context(LIFETIME_INVALID_ERROR)?;
        Ok(NewAttempt {
            binding: self.binding.clone(),
            payload_digest: self.payload_digest.clone(),
            inputs: self.inputs.clone(),
            qualifications: self.qualifications.clone(),
            created_at_ms,
            expires_at_ms,
            budget: self.budget,
        })
    }

    /// Shape checks that need no clock.
    #[cfg_attr(not(feature = "native-current-human-capture"), allow(dead_code))]
    pub(super) fn validate(&self) -> Result<()> {
        ensure!(
            (1..=NIR1_ATTEMPT_MAX_LIFETIME_MS).contains(&self.lifetime_ms),
            "{LIFETIME_INVALID_ERROR}"
        );
        validate_new_attempt(&self.at(0)?)
    }

    /// The binding the storage writer stores when this request is created at
    /// `created_at_ms` (the history slot may be downgraded, and its
    /// `eligibleUntilMs` follows the creation time).
    pub fn effective_binding_at(&self, created_at_ms: i64) -> Result<AttemptBinding> {
        effective_attempt_binding(&self.at(created_at_ms)?)
    }

    /// Whether a re-read row is this request's attempt: the creation time is
    /// whatever the transaction decided, so the binding is compared with the
    /// one the stored time gives, and the lifetime must be exactly the
    /// requested one. Used after a COMMIT whose result is unknown.
    pub fn matches_stored(&self, stored: &StoredAttempt) -> bool {
        let Ok(expected_binding) = self.effective_binding_at(stored.created_at_ms) else {
            return false;
        };
        let Ok(expected_input_digest) = input_digest(&self.inputs, &self.qualifications) else {
            return false;
        };
        stored.created_at_ms >= 0
            && stored.expires_at_ms.checked_sub(stored.created_at_ms) == Some(self.lifetime_ms)
            && stored.binding == expected_binding
            && stored.payload_digest == self.payload_digest
            && stored.input_digest == expected_input_digest
            && stored.inputs == self.inputs
            && stored.qualifications == self.qualifications
            && stored.reference_format == ReferenceFormat::V2
    }
}
