//! The only diagnostic of the Graph-only Scene reader: how many times each
//! closed outcome happened.
//!
//! A count names an outcome, never a target. There is no Scene ID, title,
//! digest, range or length here, so the counters can be read by an operator or
//! a test without learning anything about a declared Scene (Mandatory defense
//! 2). The public result of the reader does not carry the outcome at all
//! (Mandatory defense 9); this is a process-local tally for the Native side.

use std::sync::atomic::{AtomicU64, Ordering};

/// What happened to one candidate, or to the whole scan. A closed set.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Count {
    /// The common slot is not free (IR uses it, or Raw has 8 or more).
    SlotUnavailable,
    /// No workspace ID or canonical locator digest could be taken.
    WorkspaceUnavailable,
    /// A previous declaration COMMIT of this workspace had an unknown outcome.
    Quarantined,
    /// The query context does not name a resolved reading query.
    QueryUnavailable,
    /// The Scope authority read now is not the one the query context names.
    AuthorityChanged,
    /// Not a live, non-archived Scene of the project.
    SceneNotLive,
    /// A1 is not explicit, not resolved, or does not match the query.
    ScopeRejected,
    /// The Scene is not strictly before the query in the reading order.
    ReadingNotBefore,
    /// No declaration, or one that cannot be used.
    DeclarationUnavailable,
    /// The declaration's binding does not hold now.
    BindingMismatch,
    /// A veto record contradicts the declaration.
    Veto,
    /// The frame's values differ from the parent's read.
    FrameMismatch,
    /// The pin moved, was deleted or was re-inserted.
    PinChanged,
    /// The caller's path revalidation said no.
    PathRejected,
    /// A K1b limit was exceeded; the scan stopped.
    ResourceLimit,
    /// A candidate passed every judgement that does not read the body.
    Adopted,
    /// The scan ended without a candidate.
    NoCandidate,
    /// The body could not be read as a Scene source (missing, unreadable, not
    /// JSON, empty), or the first non-empty line could not be taken.
    BodyUnreadable,
    /// A candidate passed the body step too: a Graph-only Scene was added.
    Disclosed,
    /// A click was revalidated and allowed.
    ClickAllowed,
    /// A click was refused.
    ClickRefused,
}

impl Count {
    const ALL: [Self; 21] = [
        Self::SlotUnavailable,
        Self::WorkspaceUnavailable,
        Self::Quarantined,
        Self::QueryUnavailable,
        Self::AuthorityChanged,
        Self::SceneNotLive,
        Self::ScopeRejected,
        Self::ReadingNotBefore,
        Self::DeclarationUnavailable,
        Self::BindingMismatch,
        Self::Veto,
        Self::FrameMismatch,
        Self::PinChanged,
        Self::PathRejected,
        Self::ResourceLimit,
        Self::Adopted,
        Self::NoCandidate,
        Self::BodyUnreadable,
        Self::Disclosed,
        Self::ClickAllowed,
        Self::ClickRefused,
    ];

    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::SlotUnavailable => "slot-unavailable",
            Self::WorkspaceUnavailable => "workspace-unavailable",
            Self::Quarantined => "quarantined",
            Self::QueryUnavailable => "query-unavailable",
            Self::AuthorityChanged => "authority-changed",
            Self::SceneNotLive => "scene-not-live",
            Self::ScopeRejected => "scope-rejected",
            Self::ReadingNotBefore => "reading-not-before",
            Self::DeclarationUnavailable => "declaration-unavailable",
            Self::BindingMismatch => "binding-mismatch",
            Self::Veto => "veto",
            Self::FrameMismatch => "frame-mismatch",
            Self::PinChanged => "pin-changed",
            Self::PathRejected => "path-rejected",
            Self::ResourceLimit => "resource-limit",
            Self::Adopted => "adopted",
            Self::NoCandidate => "no-candidate",
            Self::BodyUnreadable => "body-unreadable",
            Self::Disclosed => "disclosed",
            Self::ClickAllowed => "click-allowed",
            Self::ClickRefused => "click-refused",
        }
    }

    const fn index(self) -> usize {
        self as usize
    }
}

static COUNTS: [AtomicU64; Count::ALL.len()] = [const { AtomicU64::new(0) }; Count::ALL.len()];

#[cfg(test)]
thread_local! {
    // A per-thread copy, so tests that run in parallel read their own counts.
    static LOCAL: std::cell::RefCell<[u64; Count::ALL.len()]> =
        const { std::cell::RefCell::new([0; Count::ALL.len()]) };
}

pub(super) fn record(count: Count) {
    COUNTS[count.index()].fetch_add(1, Ordering::Relaxed);
    #[cfg(test)]
    LOCAL.with(|local| local.borrow_mut()[count.index()] += 1);
}

/// Every count since the process started, in a fixed order.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "read by the Native diagnostics of the caller (CP-3a); never sent to a renderer"
    )
)]
pub(crate) fn totals() -> Vec<(&'static str, u64)> {
    Count::ALL
        .iter()
        .map(|count| (count.code(), COUNTS[count.index()].load(Ordering::Relaxed)))
        .collect()
}

/// The counts recorded on this thread, as `(code, count)` for the non-zero ones.
#[cfg(test)]
pub(super) fn local_counts() -> Vec<(&'static str, u64)> {
    LOCAL.with(|local| {
        let local = local.borrow();
        Count::ALL
            .iter()
            .filter(|count| local[count.index()] > 0)
            .map(|count| (count.code(), local[count.index()]))
            .collect()
    })
}

#[cfg(test)]
pub(super) fn reset_local_counts() {
    LOCAL.with(|local| *local.borrow_mut() = [0; Count::ALL.len()]);
}
