use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
};

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::{
    super::retrieval_admission::build::BuildCandidate, binding::StoredBinding,
    NirEmbeddingIdentity, NirIndexUnavailableReason,
};
use crate::{read_sqlite_source_revision, Database};

pub struct NirChronicleIndexRuntime {
    owner: u64,
    connection_epoch: Option<String>,
    state: Mutex<RuntimeState>,
}

pub(super) struct RuntimeState {
    pub epoch: u64,
    embedding_generation: Option<u64>,
    active: bool,
    stopped: bool,
    pub proofs: HashMap<String, Arc<IndexProof>>,
}

pub(super) struct IndexProof {
    pub validated_read: Mutex<Option<super::read_identity::ReadIdentity>>,
    pub project: String,
    pub runtime_epoch: u64,
    pub binding: StoredBinding,
    pub semantic_epoch: String,
    pub language: String,
    pub candidates: Vec<IndexedCandidate>,
    pub model: Option<NirEmbeddingIdentity>,
    pub input_edges: Vec<super::super::dependency_edges::DependencyEdge>,
}

pub(super) struct IndexedCandidate {
    pub verified: BuildCandidate,
    pub embedding: Option<Vec<u8>>,
    pub evidence: Vec<super::evidence::VerifiedEvidence>,
}

impl NirChronicleIndexRuntime {
    /// A scheduling hint, never a Freshness verdict or query capability.
    /// Complete admission and conditional publication remain mandatory.
    pub fn rebuild_requested(&self, conn: &Connection, project: &str) -> Result<Option<bool>> {
        anyhow::ensure!(
            !conn.is_autocommit(),
            "NIR1 rebuild hint requires a transaction"
        );
        if self.current_epoch(conn)?.is_err() {
            return Ok(None);
        }
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
            [project],
            |r| r.get(0),
        )?;
        if !exists {
            return Ok(None);
        }
        let row=conn.query_row("SELECT m.generation,m.dirty_cache_flag,m.source_digest,m.dependency_set_digest,
            m.producer_id,m.producer_version,f.evidence_freshness,f.build_action,f.semantic_epoch_id
            FROM narrative_semantic_index_metadata m LEFT JOIN narrative_consumer_freshness f
            ON f.project_id=m.project_id AND f.consumer_kind='semantic-index' AND f.consumer_key=m.index_key
            WHERE m.project_id=?1 AND m.index_key=?2",params![project,super::INDEX_KEY],|r|Ok((
                r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?,
                r.get::<_,Option<String>>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,Option<String>>(6)?,
                r.get::<_,Option<String>>(7)?,r.get::<_,Option<String>>(8)?))).optional()?;
        let Some((generation, dirty, source, d1, producer, version, freshness, action, epoch)) =
            row
        else {
            return Ok(Some(true));
        };
        if producer.as_deref() != Some(super::PRODUCER_ID)
            || version.as_deref() != Some(super::PRODUCER_VERSION)
        {
            return Ok(None);
        }
        let current_epoch = super::super::semantic_epoch::get_current_epoch(conn, project)?;
        let state = self.lock()?;
        let unchanged = state.proofs.get(project).is_some_and(|proof| {
            dirty == 0
                && generation == proof.binding.generation
                && source.as_deref() == Some(proof.binding.source_digest.as_str())
                && d1.as_deref() == Some(proof.binding.dependency_set_digest.as_str())
                && freshness.as_deref() == Some("fresh")
                && action.as_deref() == Some("none")
                && epoch.as_deref() == Some(proof.semantic_epoch.as_str())
                && current_epoch
                    .as_ref()
                    .is_some_and(|epoch| epoch.id == proof.semantic_epoch)
        });
        Ok(Some(!unchanged))
    }

    // WorkspaceAuthority is the only production constructor. A connection
    // metadata failure starts unavailable and cannot bind to another DB later.
    pub(crate) fn new(db: &Database, owner: u64) -> Self {
        let connection_epoch = db
            .with_conn(|conn| Ok(read_sqlite_source_revision(conn)?.connection_epoch))
            .ok();
        Self {
            owner,
            connection_epoch,
            state: Mutex::new(RuntimeState {
                epoch: 1,
                embedding_generation: None,
                active: true,
                stopped: false,
                proofs: HashMap::new(),
            }),
        }
    }

    pub(super) fn lock(&self) -> Result<MutexGuard<'_, RuntimeState>> {
        self.state
            .lock()
            .map_err(|_| anyhow!("NIR1 runtime lock poisoned"))
    }

    pub(super) fn current_epoch(
        &self,
        conn: &Connection,
    ) -> Result<std::result::Result<u64, NirIndexUnavailableReason>> {
        if self.connection_epoch.as_deref()
            != Some(read_sqlite_source_revision(conn)?.connection_epoch.as_str())
        {
            return Ok(Err(NirIndexUnavailableReason::ConnectionChanged));
        }
        let state = self.lock()?;
        Ok(if state.active && !state.stopped {
            Ok(state.epoch)
        } else {
            Err(NirIndexUnavailableReason::RuntimeUnavailable)
        })
    }

    pub(super) fn owner(&self) -> u64 {
        self.owner
    }

    /// The shell supplies its actual pinned SemanticRuntime generation, never
    /// a renderer field. A late request cannot roll this binding backwards.
    pub fn bind_embedding_generation(&self, generation: u64) -> Result<()> {
        anyhow::ensure!(generation > 0, "NIR1 embedding runtime unavailable");
        let mut state = self.lock()?;
        anyhow::ensure!(
            state
                .embedding_generation
                .is_none_or(|old| generation >= old),
            "NIR1 embedding runtime changed"
        );
        if state.embedding_generation != Some(generation) {
            state.epoch = state
                .epoch
                .checked_add(1)
                .ok_or_else(|| anyhow!("NIR1 runtime epoch exhausted"))?;
            state.proofs.clear();
            state.embedding_generation = Some(generation);
        }
        Ok(())
    }

    /// Returns projects whose old UI operations must be invalidated. No held
    /// proof is reused after either pause or resume, even without a DB write.
    pub fn pause(&self) -> Result<Vec<String>> {
        self.change_state(false, false)
    }
    pub fn resume(&self) -> Result<Vec<String>> {
        self.change_state(true, false)
    }
    pub fn stop(&self) -> Result<Vec<String>> {
        self.change_state(false, true)
    }

    fn change_state(&self, active: bool, stop: bool) -> Result<Vec<String>> {
        let mut state = self.lock()?;
        let mut projects = state.proofs.keys().cloned().collect::<Vec<_>>();
        projects.sort();
        state.epoch = state
            .epoch
            .checked_add(1)
            .ok_or_else(|| anyhow!("NIR1 runtime epoch exhausted"))?;
        state.proofs.clear();
        state.stopped |= stop;
        state.active = active && !state.stopped;
        Ok(projects)
    }

    pub(super) fn install(&self, epoch: u64, proof: IndexProof) -> Result<bool> {
        let mut state = self.lock()?;
        if !state.active || state.stopped || state.epoch != epoch {
            return Ok(false);
        }
        state.proofs.insert(proof.project.clone(), Arc::new(proof));
        Ok(true)
    }
}
