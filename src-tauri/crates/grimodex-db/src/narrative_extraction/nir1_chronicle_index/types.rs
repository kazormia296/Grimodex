use super::super::retrieval_admission::ChronicleRetrievalDocument;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NirEmbeddingIdentity {
    pub model_id: String,
    pub artifact_sha256: String,
    pub tokenizer_sha256: String,
    pub embedding_dim: usize,
    pub chunker_version: String,
}

#[derive(Debug)]
pub struct NirEmbeddingAuditBinding {
    pub operation_id: String,
    pub execution_id: String,
}

#[derive(Debug)]
pub enum NirEmbeddedDocument {
    Indexed {
        document: ChronicleRetrievalDocument,
        embedding: Vec<u8>,
        identity: NirEmbeddingIdentity,
        audit_binding: NirEmbeddingAuditBinding,
    },
    SkippedTokenLimit {
        document: ChronicleRetrievalDocument,
        identity: NirEmbeddingIdentity,
        audit_binding: NirEmbeddingAuditBinding,
        actual_tokens: usize,
        maximum_tokens: usize,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NirIndexUnavailableReason {
    RuntimeUnavailable,
    DatabaseLineageChanged,
    CanonicalAuthorityUnavailable,
    ReservedBinding,
    ScopeUnavailable,
    CurrentEpochUnavailable,
    PendingChange,
    ColdIndex,
    DirtyIndex,
    BindingChanged,
    QueryUnavailable,
    EvidenceUnavailable,
    /// DR-IRB-3 reader reasons below. They are internal (never a wire value).
    /// The dedicated reader could not be opened (file missing, permission, IO).
    /// Transient: the native caller maps it to `Retry`.
    ReaderOpenFailed,
    /// The reader hit `SQLITE_BUSY`/`SQLITE_LOCKED` (busy timeout 0). Transient:
    /// the native caller maps it to `Retry`.
    ReaderBusy,
    /// The authority already has a reader in flight (one slot per authority).
    /// No database was touched: the native caller maps it to `Retry`.
    ReaderSlotBusy,
    /// The reader's main database file is not the file the authority admitted
    /// (the authority was replaced). The native caller maps it to `Stopped`.
    ReaderIdentityMismatch,
    /// The reader's `sqlite3_close` was not proven. The slot is never given
    /// back (fail-closed); the native caller maps it to `Retry`, which becomes
    /// `Stopped` after the consecutive-retry bound.
    ReaderCloseUnproven,
    /// An in-memory or unnamed main database cannot be opened by a second
    /// connection. The native caller maps it to `Stopped` and must not fall
    /// back silently.
    ReaderUnavailableForMemoryDatabase,
}

/// Typed failure of the DR-IRB-3 dedicated Chronicle reader. It travels inside
/// an `anyhow::Error` and is recovered with `chronicle_reader_error_reason`.
#[derive(Debug)]
pub enum ChronicleReaderError {
    SlotBusy,
    UnsupportedDatabase,
    OpenFailed(String),
    Busy(String),
    IdentityMismatch,
    CloseUnproven(String),
}

impl ChronicleReaderError {
    pub fn reason(&self) -> NirIndexUnavailableReason {
        match self {
            Self::SlotBusy => NirIndexUnavailableReason::ReaderSlotBusy,
            Self::UnsupportedDatabase => {
                NirIndexUnavailableReason::ReaderUnavailableForMemoryDatabase
            }
            Self::OpenFailed(_) => NirIndexUnavailableReason::ReaderOpenFailed,
            Self::Busy(_) => NirIndexUnavailableReason::ReaderBusy,
            Self::IdentityMismatch => NirIndexUnavailableReason::ReaderIdentityMismatch,
            Self::CloseUnproven(_) => NirIndexUnavailableReason::ReaderCloseUnproven,
        }
    }
}

impl std::fmt::Display for ChronicleReaderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SlotBusy => f.write_str("NIR1_CHRONICLE_READER_SLOT_BUSY"),
            Self::UnsupportedDatabase => f.write_str("NIR1_CHRONICLE_READER_UNSUPPORTED_DATABASE"),
            Self::OpenFailed(detail) => write!(f, "NIR1_CHRONICLE_READER_OPEN_FAILED: {detail}"),
            Self::Busy(detail) => write!(f, "NIR1_CHRONICLE_READER_BUSY: {detail}"),
            Self::IdentityMismatch => f.write_str("NIR1_CHRONICLE_READER_IDENTITY_MISMATCH"),
            Self::CloseUnproven(detail) => {
                write!(f, "NIR1_CHRONICLE_READER_CLOSE_UNPROVEN: {detail}")
            }
        }
    }
}

impl std::error::Error for ChronicleReaderError {}

/// The reader reason of an error returned by the reader entry points. A raw
/// `SQLITE_BUSY`/`SQLITE_LOCKED` from inside the reader's operation is also
/// `ReaderBusy`. `None` for everything else, including a typed validation
/// termination, which the caller keeps as an error (stop / generation change).
pub fn chronicle_reader_error_reason(error: &anyhow::Error) -> Option<NirIndexUnavailableReason> {
    if let Some(typed) = error.downcast_ref::<ChronicleReaderError>() {
        return Some(typed.reason());
    }
    if super::super::is_validation_terminated(error) {
        return None;
    }
    match error.downcast_ref::<rusqlite::Error>() {
        Some(rusqlite::Error::SqliteFailure(failure, _))
            if matches!(
                failure.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            Some(NirIndexUnavailableReason::ReaderBusy)
        }
        _ => None,
    }
}

#[derive(Debug)]
pub enum NirIndexPublishRead {
    Published {
        generation: i64,
        candidate_count: usize,
        newly_usable_published: bool,
    },
    Stale,
    Unavailable {
        reason: NirIndexUnavailableReason,
    },
}

impl NirEmbeddedDocument {
    pub fn document(&self) -> &ChronicleRetrievalDocument {
        match self {
            Self::Indexed { document, .. } | Self::SkippedTokenLimit { document, .. } => document,
        }
    }

    pub(super) fn identity(&self) -> &NirEmbeddingIdentity {
        match self {
            Self::Indexed { identity, .. } | Self::SkippedTokenLimit { identity, .. } => identity,
        }
    }

    pub(super) fn audit_binding(&self) -> &NirEmbeddingAuditBinding {
        match self {
            Self::Indexed { audit_binding, .. } | Self::SkippedTokenLimit { audit_binding, .. } => {
                audit_binding
            }
        }
    }
}
