//! The closed status set of a chat IR call (DR-CHATIR-S1-25) and the one place
//! that turns an internal failure into it.
//!
//! A failure is never a "0 items" success: `none-above-threshold` is a success
//! (`is_success`), every other non-`available` value is an unavailable IR. The
//! `match` expressions below have no wildcard on purpose: a new variant of an
//! upstream enum must be classified here at compile time.

use grimodex_db::narrative_extraction::{ValidationTerminated, ValidationTerminationReason};
use grimodex_semantic::runtime::ChatIrUnavailable;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChatIrStatus {
    Available,
    NoneAboveThreshold,
    Timeout,
    ConnectionBusy,
    EmbedderCold,
    Busy,
    LedgerFull,
    IndexUnavailable,
    Unsupported,
    NoCurrentScene,
    ProjectUnavailable,
    ProjectChanged,
    WorkspaceUnavailable,
    WorkspaceChanged,
    QueryInvalid,
    InferenceFailed,
    Internal,
}

impl ChatIrStatus {
    #[cfg(test)]
    pub(crate) const ALL: [Self; 17] = [
        Self::Available,
        Self::NoneAboveThreshold,
        Self::Timeout,
        Self::ConnectionBusy,
        Self::EmbedderCold,
        Self::Busy,
        Self::LedgerFull,
        Self::IndexUnavailable,
        Self::Unsupported,
        Self::NoCurrentScene,
        Self::ProjectUnavailable,
        Self::ProjectChanged,
        Self::WorkspaceUnavailable,
        Self::WorkspaceChanged,
        Self::QueryInvalid,
        Self::InferenceFailed,
        Self::Internal,
    ];

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::NoneAboveThreshold => "none-above-threshold",
            Self::Timeout => "timeout",
            Self::ConnectionBusy => "connection-busy",
            Self::EmbedderCold => "embedder-cold",
            Self::Busy => "busy",
            Self::LedgerFull => "ledger-full",
            Self::IndexUnavailable => "index-unavailable",
            Self::Unsupported => "unsupported",
            Self::NoCurrentScene => "no-current-scene",
            Self::ProjectUnavailable => "project-unavailable",
            Self::ProjectChanged => "project-changed",
            Self::WorkspaceUnavailable => "workspace-unavailable",
            Self::WorkspaceChanged => "workspace-changed",
            Self::QueryInvalid => "query-invalid",
            Self::InferenceFailed => "inference-failed",
            Self::Internal => "internal",
        }
    }

    /// `available` and `none-above-threshold` are successes. Everything else is
    /// an IR that could not be answered, which a caller must not count as
    /// "no relevant scene".
    pub(crate) const fn is_success(self) -> bool {
        matches!(self, Self::Available | Self::NoneAboveThreshold)
    }
}

/// `ChatIrUnavailable` of the shared crate, exhaustively.
pub(crate) const fn from_unavailable(reason: ChatIrUnavailable) -> ChatIrStatus {
    match reason {
        ChatIrUnavailable::EmbedderCold => ChatIrStatus::EmbedderCold,
        ChatIrUnavailable::ConnectionBusy => ChatIrStatus::ConnectionBusy,
        ChatIrUnavailable::Timeout => ChatIrStatus::Timeout,
        ChatIrUnavailable::InferenceFailed => ChatIrStatus::InferenceFailed,
    }
}

/// The typed termination of a participant read, exhaustively. Close,
/// transition and an expired deadline are ordinary and must not become
/// `internal`.
pub(crate) const fn from_termination(reason: ValidationTerminationReason) -> ChatIrStatus {
    match reason {
        ValidationTerminationReason::TimedOut => ChatIrStatus::Timeout,
        ValidationTerminationReason::Cancelled
        | ValidationTerminationReason::Closed
        | ValidationTerminationReason::ContextUnavailable => ChatIrStatus::WorkspaceUnavailable,
        ValidationTerminationReason::WorkspaceGenerationChanged => ChatIrStatus::WorkspaceChanged,
        ValidationTerminationReason::ForegroundPreempted
        | ValidationTerminationReason::CleanupFailed
        | ValidationTerminationReason::CapacityExceeded => ChatIrStatus::Internal,
    }
}

/// The string codes the shared crate puts in an `anyhow` error. One table, kept
/// in step with the source by a test that reads the source text.
///
/// * the epoch of the semantic runtime turned while the call ran (a cancelled
///   close or a quiescence does this without changing the authority), either
///   before `prepare` (`IPC_DERIVED_CANCELLED`) or after it
///   (`SEMANTIC_QUERY_STALE`): `workspace-changed`;
/// * the index was built with another model than the query's:
///   `index-unavailable`;
/// * the resident embedder no longer matches the spec: `internal`.
pub(crate) const STRING_CODES: [(&str, ChatIrStatus); 4] = [
    ("SEMANTIC_QUERY_STALE", ChatIrStatus::WorkspaceChanged),
    ("IPC_DERIVED_CANCELLED", ChatIrStatus::WorkspaceChanged),
    (
        "SEMANTIC_QUERY_MODEL_MISMATCH",
        ChatIrStatus::IndexUnavailable,
    ),
    ("SEMANTIC_QUERY_MODEL_CHANGED", ChatIrStatus::Internal),
];

/// Any failure of a step. The message is never logged or returned; only the
/// closed status leaves this function.
pub(crate) fn from_error(error: &anyhow::Error) -> ChatIrStatus {
    if let Some(terminated) = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<ValidationTerminated>())
    {
        return from_termination(terminated.reason);
    }
    let message = format!("{error:#}");
    STRING_CODES
        .iter()
        .find(|(code, _)| message.contains(code))
        .map_or(ChatIrStatus::Internal, |(_, status)| *status)
}
