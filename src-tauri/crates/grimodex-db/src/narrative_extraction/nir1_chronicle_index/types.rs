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
    ConnectionChanged,
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
