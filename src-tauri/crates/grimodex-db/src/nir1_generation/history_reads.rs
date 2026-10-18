//! Typed history reads of the snapshot reader (HC-1, K4/3 section 6).
//!
//! These reads add to `GenerationHistorySnapshotReader` what the lineage
//! assembly needs and nothing else: the attempts of one chat session in a
//! total order, the capture row of a message version, and the attempts that
//! hold a Human version at ordinal 0. They read only existing columns and
//! indexes (`idx_nir1_generation_attempts_session`, the UNIQUE
//! `message_version_id`), never write, and draw from the caller's one
//! whole-turn ledger: attempt rows and reference rows are debited from
//! `GenerationHistoryReadBudget`, and every statement is counted by the
//! turn's SQL ledger installed on the connection. Nothing is refunded per
//! attempt, and a repeated call for the same key is served from the
//! snapshot's cache without a second debit.
//!
//! A legacy (version 1) binding and a binding of an unknown `bindingVersion`
//! are returned as a closed-reason header ([`ExcludedHistoryAttempt`]) and
//! never fail the snapshot. A malformed binding or reference row is still an
//! error, as before.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the lineage assembly and the run entry (HC1-4) are the first callers of the enumeration, capture and ordinal-0 reads"
    )
)]

use super::history_context::HistoryContextGateReason;
use super::{
    bounded_sqlite_length, identity, parse_versioned_reference, read_stored_binding_lenient,
    GenerationHistoryReadBudget, GenerationHistorySnapshotReader, GenerationPurpose,
    InputReference, InputTarget, LegacyInputReferenceV1, LenientAttemptBinding, StoredAttempt,
    VersionedAttemptBinding, VersionedReference, MAX_BINDING_JSON_BYTES, MAX_ID_BYTES,
};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, OptionalExtension};
use std::collections::BTreeMap;
use std::sync::Arc;

pub(super) type EnumerationCache =
    BTreeMap<(String, String), Arc<[GenerationHistoryAttemptHeader]>>;
pub(super) type CaptureCache = BTreeMap<String, Option<GenerationHistoryCapture>>;
pub(super) type OrdinalZeroCache = BTreeMap<(String, String), OrdinalZeroIndex>;

/// The per-session ordinal-0 index: attempt ids by Human version, and whether
/// some attempt of the session could not be counted.
#[derive(Debug, Default)]
pub(super) struct OrdinalZeroIndex {
    by_version: BTreeMap<String, Vec<String>>,
    ambiguous: bool,
}

const ENUMERATION_CANDIDATE_LIMIT_ERROR: &str = "NIR1_GENERATION_HISTORY_CANDIDATE_LIMIT";
const ENUMERATION_ATTEMPT_LIMIT_ERROR: &str = "NIR1_GENERATION_HISTORY_LIMIT";
const ENUMERATION_CHANGED_ERROR: &str = "NIR1_GENERATION_HISTORY_ENUMERATION_CHANGED";
const REFERENCE_LIMIT_ERROR: &str = "NIR1_GENERATION_REF_LIMIT";
const CAPTURE_LIMIT_ERROR: &str = "NIR1_GENERATION_CAPTURE_LIMIT";
const CAPTURE_STATE_INVALID_ERROR: &str = "NIR1_GENERATION_CAPTURE_STATE_INVALID";

/// An attempt row the history snapshot reader does not use: only its header
/// and the closed reason. No reference row was read, so neither the
/// reference budget nor the body-byte reservation was debited.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ExcludedHistoryAttempt {
    pub id: String,
    /// The attempt row's `project_id` and `session_id` columns.
    pub project_id: String,
    pub chat_session_id: String,
    pub created_at_ms: i64,
    pub reason: HistoryContextGateReason,
}

impl ExcludedHistoryAttempt {
    pub(super) fn new(
        id: &str,
        project_id: &str,
        chat_session_id: &str,
        created_at_ms: i64,
        reason: HistoryContextGateReason,
    ) -> Self {
        Self {
            id: id.to_owned(),
            project_id: project_id.to_owned(),
            chat_session_id: chat_session_id.to_owned(),
            created_at_ms,
            reason,
        }
    }
}

/// What the history snapshot reader returns for one attempt id: the stored
/// attempt (possibly the slot-gated header form), or the closed-reason header
/// of a legacy or unknown-version binding.
#[derive(Clone, Debug, PartialEq)]
#[expect(
    clippy::large_enum_variant,
    reason = "the stored variant is the common case and is moved once; boxing it would touch every history reader for no gain"
)]
pub(crate) enum GenerationHistoryAttempt {
    Stored(StoredAttempt),
    Excluded(ExcludedHistoryAttempt),
}

impl GenerationHistoryAttempt {
    pub(crate) fn id(&self) -> &str {
        match self {
            Self::Stored(stored) => &stored.id,
            Self::Excluded(excluded) => &excluded.id,
        }
    }

    /// Why a history reader does not use this attempt, from its binding
    /// version and its history slot alone.
    pub(crate) fn history_gate(&self) -> Option<HistoryContextGateReason> {
        match self {
            Self::Stored(stored) => stored.history_gate(),
            Self::Excluded(excluded) => Some(excluded.reason),
        }
    }

    /// The stored attempt, or an error for an excluded one. For callers that
    /// have already ruled out a legacy or unknown-version row.
    pub(crate) fn into_stored(self) -> Result<StoredAttempt> {
        match self {
            Self::Stored(stored) => Ok(stored),
            Self::Excluded(_) => anyhow::bail!("NIR1_GENERATION_HISTORY_ATTEMPT_UNUSABLE"),
        }
    }
}

/// The binding part of an enumerated attempt's header.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum HistoryHeaderBinding {
    /// A version 2 binding. `gate` is the slot's state: `None` is a context
    /// of the known version.
    Current {
        scene_id: String,
        scene_incarnation_id: String,
        purpose: GenerationPurpose,
        gate: Option<HistoryContextGateReason>,
    },
    /// A legacy or unknown-version binding. Nothing else of it is read.
    Excluded(HistoryContextGateReason),
}

/// One attempt of an enumerated session: the row's identity and the parts of
/// the binding a candidate needs before any reference row is read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GenerationHistoryAttemptHeader {
    pub id: String,
    pub created_at_ms: i64,
    pub project_id: String,
    pub chat_session_id: String,
    pub binding: HistoryHeaderBinding,
}

impl GenerationHistoryAttemptHeader {
    /// Why a history reader does not use this attempt, from the header alone.
    pub(crate) fn gate(&self) -> Option<HistoryContextGateReason> {
        match &self.binding {
            HistoryHeaderBinding::Current { gate, .. } => *gate,
            HistoryHeaderBinding::Excluded(reason) => Some(*reason),
        }
    }
}

/// The state of a Human input capture (`nir1_chat_input_captures.state`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HistoryCaptureState {
    Current,
    Superseded,
    Cancelled,
    Closed,
}

impl HistoryCaptureState {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "current" => Ok(Self::Current),
            "superseded" => Ok(Self::Superseded),
            "cancelled" => Ok(Self::Cancelled),
            "closed" => Ok(Self::Closed),
            _ => anyhow::bail!(CAPTURE_STATE_INVALID_ERROR),
        }
    }
}

/// The capture row of a message version: where it was captured and its
/// state. The owner and submission columns are not read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GenerationHistoryCapture {
    pub project_id: String,
    pub chat_session_id: String,
    pub scene_id: String,
    pub state: HistoryCaptureState,
}

/// The attempts of an enumerated session that hold one message version at
/// ordinal 0 (K4/3 section 6, the exactly-one rule). The caller applies the
/// rule; this only counts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OrdinalZeroAttempts {
    pub count: usize,
    /// The attempt ids in the enumeration's total order.
    pub attempt_ids: Vec<String>,
    /// True when an attempt of the session could not be counted: a row of an
    /// unknown `bindingVersion` (its reference format is unknown), or a
    /// gated or legacy row whose ordinal 0 input row is unreadable. The
    /// count is then only a lower bound for every Human of the session, and
    /// the exactly-one rule must not hold (fail closed).
    pub ambiguous: bool,
}

impl GenerationHistorySnapshotReader<'_> {
    /// Enumerate the attempts of one chat session of one project in the total
    /// order of K4/3 section 6: `created_at_ms` descending, then the attempt
    /// id's bytes ascending.
    ///
    /// The rows are found by the `session_id` column and the existing
    /// `idx_nir1_generation_attempts_session` only; `binding_json` is never
    /// searched across the project. `chat_session_id` is the DB chat session,
    /// not a caller's claim. The count is bounded by `max_candidates` and
    /// `max_attempts` before any row is materialized, and the whole count is
    /// debited once from `max_attempts`.
    pub(crate) fn list_session_attempts(
        &mut self,
        budget: &mut GenerationHistoryReadBudget,
        project_id: &str,
        chat_session_id: &str,
    ) -> Result<Arc<[GenerationHistoryAttemptHeader]>> {
        identity(project_id)?;
        identity(chat_session_id)?;
        self.checkpoint()?;
        let key = (project_id.to_owned(), chat_session_id.to_owned());
        if let Some(cached) = self.enumerations.get(&key) {
            return Ok(Arc::clone(cached));
        }
        let headers = match self.enumerate_session_attempts(budget, project_id, chat_session_id) {
            Ok(headers) => headers,
            Err(error) => {
                self.checkpoint()?;
                return Err(error);
            }
        };
        self.checkpoint()?;
        self.enumerations.insert(key, Arc::clone(&headers));
        Ok(headers)
    }

    fn enumerate_session_attempts(
        &mut self,
        budget: &mut GenerationHistoryReadBudget,
        project_id: &str,
        chat_session_id: &str,
    ) -> Result<Arc<[GenerationHistoryAttemptHeader]>> {
        // Count at most one past the smaller limit, so a session far over the
        // limit costs one bounded index scan, not a full one.
        let limit = budget.max_candidates.min(budget.max_attempts);
        let probe = i64::try_from(limit)?
            .checked_add(1)
            .context(ENUMERATION_ATTEMPT_LIMIT_ERROR)?;
        let counted: i64 = self.connection.query_row(
            "SELECT count(*) FROM (
                 SELECT 1 FROM nir1_generation_attempts
                 WHERE project_id=?1 AND session_id=?2 LIMIT ?3)",
            params![project_id, chat_session_id, probe],
            |row| row.get(0),
        )?;
        let counted = usize::try_from(counted)?;
        if counted > limit {
            // The candidate limit is checked first: it is the smaller or
            // equal one exactly when it is the one that was exceeded.
            ensure!(
                counted <= budget.max_candidates,
                "{}",
                ENUMERATION_CANDIDATE_LIMIT_ERROR
            );
            anyhow::bail!(ENUMERATION_ATTEMPT_LIMIT_ERROR);
        }
        self.checkpoint()?;
        budget.consume_attempts(counted)?;

        // Scalar-only admission: the row position and the lengths first, so
        // no identifier or binding String is materialized before its length
        // is bounded. The identifier is compared as bytes (BINARY collation).
        let locations = {
            let mut statement = self.connection.prepare(
                "SELECT rowid,octet_length(id),octet_length(binding_json),created_at_ms
                 FROM nir1_generation_attempts
                 WHERE project_id=?1 AND session_id=?2
                 ORDER BY created_at_ms DESC, id ASC LIMIT ?3",
            )?;
            let mut rows = statement.query(params![
                project_id,
                chat_session_id,
                i64::try_from(counted)?
            ])?;
            let mut locations = Vec::with_capacity(counted);
            while let Some(row) = rows.next()? {
                let id_bytes = bounded_sqlite_length(
                    row.get(1)?,
                    MAX_ID_BYTES,
                    "NIR1_GENERATION_ATTEMPT_METADATA_LIMIT",
                )?;
                let binding_bytes = bounded_sqlite_length(
                    row.get(2)?,
                    MAX_BINDING_JSON_BYTES,
                    "NIR1_GENERATION_BINDING_LIMIT",
                )?;
                locations.push((
                    row.get::<_, i64>(0)?,
                    id_bytes,
                    binding_bytes,
                    row.get::<_, i64>(3)?,
                ));
            }
            locations
        };
        ensure!(locations.len() == counted, "{}", ENUMERATION_CHANGED_ERROR);

        let mut headers = Vec::with_capacity(locations.len());
        for (rowid, id_bytes, binding_bytes, created_at_ms) in locations {
            self.checkpoint()?;
            let (id, binding_json): (String, String) = self.connection.query_row(
                "SELECT id,binding_json FROM nir1_generation_attempts WHERE rowid=?1",
                [rowid],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            ensure!(
                id.len() == id_bytes && binding_json.len() == binding_bytes,
                "{}",
                ENUMERATION_CHANGED_ERROR
            );
            identity(&id)?;
            let binding =
                match read_stored_binding_lenient(&binding_json, project_id, chat_session_id)? {
                    LenientAttemptBinding::UnsupportedVersion => HistoryHeaderBinding::Excluded(
                        HistoryContextGateReason::UnsupportedBindingVersion,
                    ),
                    LenientAttemptBinding::Versioned(VersionedAttemptBinding::LegacyV1(_)) => {
                        HistoryHeaderBinding::Excluded(HistoryContextGateReason::LegacyBinding)
                    }
                    LenientAttemptBinding::Versioned(VersionedAttemptBinding::Current(current)) => {
                        HistoryHeaderBinding::Current {
                            gate: super::history_gate_reason(&current),
                            purpose: current.purpose,
                            scene_id: current.scene.scene_id,
                            scene_incarnation_id: current.scene.scene_incarnation_id,
                        }
                    }
                };
            headers.push(GenerationHistoryAttemptHeader {
                id,
                created_at_ms,
                project_id: project_id.to_owned(),
                chat_session_id: chat_session_id.to_owned(),
                binding,
            });
        }
        Ok(headers.into())
    }

    /// The capture row of a message version, found by the UNIQUE
    /// `message_version_id` column. `None` is a version with no capture (a
    /// legacy row, a version bound by `bind_human_message`, a generated
    /// output): not an error. The scalar lengths are bounded before any
    /// identifier is materialized; the statements are counted by the turn's
    /// SQL ledger.
    pub(crate) fn read_capture_by_message_version(
        &mut self,
        message_version_id: &str,
    ) -> Result<Option<GenerationHistoryCapture>> {
        identity(message_version_id)?;
        self.checkpoint()?;
        if let Some(cached) = self.captures.get(message_version_id) {
            return Ok(cached.clone());
        }
        let value = match self.read_capture_uncached(message_version_id) {
            Ok(value) => value,
            Err(error) => {
                self.checkpoint()?;
                return Err(error);
            }
        };
        self.checkpoint()?;
        self.captures
            .insert(message_version_id.to_owned(), value.clone());
        Ok(value)
    }

    fn read_capture_uncached(
        &self,
        message_version_id: &str,
    ) -> Result<Option<GenerationHistoryCapture>> {
        let lengths: Option<(i64, i64, i64)> = self
            .connection
            .query_row(
                "SELECT octet_length(project_id),octet_length(chat_session_id),
                        octet_length(scene_id)
                 FROM nir1_chat_input_captures WHERE message_version_id=?1",
                [message_version_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some(lengths) = lengths else {
            return Ok(None);
        };
        let lengths = [
            bounded_sqlite_length(lengths.0, MAX_ID_BYTES, CAPTURE_LIMIT_ERROR)?,
            bounded_sqlite_length(lengths.1, MAX_ID_BYTES, CAPTURE_LIMIT_ERROR)?,
            bounded_sqlite_length(lengths.2, MAX_ID_BYTES, CAPTURE_LIMIT_ERROR)?,
        ];
        let (project_id, chat_session_id, scene_id, state): (String, String, String, String) =
            self.connection.query_row(
                "SELECT project_id,chat_session_id,scene_id,state
                 FROM nir1_chat_input_captures WHERE message_version_id=?1",
                [message_version_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
        ensure!(
            project_id.len() == lengths[0]
                && chat_session_id.len() == lengths[1]
                && scene_id.len() == lengths[2],
            "NIR1_GENERATION_CAPTURE_CHANGED"
        );
        Ok(Some(GenerationHistoryCapture {
            project_id,
            chat_session_id,
            scene_id,
            state: HistoryCaptureState::parse(&state)?,
        }))
    }

    /// The attempts of the enumerated session that hold `human_version_id` as
    /// their ordinal 0 input (K4/3 section 6: "the attempts read for the
    /// candidate enumeration"). The index is built once per session for the
    /// snapshot, from the enumeration, by reading each usable attempt's
    /// ordinal 0 input row; the schema gets no index.
    ///
    /// Every listed attempt counts, including one whose history slot is not
    /// a known context (null, unavailable, binding-limit) and one with a
    /// legacy binding: the exactly-one rule exists to fail closed on a second
    /// attempt, and a second attempt that this build would not use is still a
    /// second attempt. Their ordinal 0 input row is read by primary key (a
    /// version 2 binding's references parse as current, a legacy binding's
    /// as legacy); this is a different path from `read_attempt`, whose gate
    /// keeps the traversal from reading a gated attempt's rows. A row of an
    /// unknown `bindingVersion` cannot be counted without reading a
    /// reference of an unknown format, and a gated or legacy row whose
    /// ordinal 0 row is unreadable cannot be counted either: both set
    /// `ambiguous`, which the caller treats as "not exactly one" for every
    /// Human of the session. The ordinal 0 rows are debited from the
    /// reference ledger once per turn. Counting looks at the row's target
    /// only: whether ordinal 0 is a current-turn use is the
    /// requalification's rule, and counting more is the fail-closed side.
    pub(crate) fn ordinal_zero_attempts(
        &mut self,
        budget: &mut GenerationHistoryReadBudget,
        project_id: &str,
        chat_session_id: &str,
        human_version_id: &str,
    ) -> Result<OrdinalZeroAttempts> {
        identity(human_version_id)?;
        let headers = self.list_session_attempts(budget, project_id, chat_session_id)?;
        let key = (project_id.to_owned(), chat_session_id.to_owned());
        if !self.ordinal_zero.contains_key(&key) {
            let index = match self.build_ordinal_zero_index(budget, &headers) {
                Ok(index) => index,
                Err(error) => {
                    self.checkpoint()?;
                    return Err(error);
                }
            };
            self.checkpoint()?;
            self.ordinal_zero.insert(key.clone(), index);
        }
        let index = self.ordinal_zero.get(&key);
        let attempt_ids = index
            .and_then(|index| index.by_version.get(human_version_id))
            .cloned()
            .unwrap_or_default();
        Ok(OrdinalZeroAttempts {
            count: attempt_ids.len(),
            attempt_ids,
            ambiguous: index.is_some_and(|index| index.ambiguous),
        })
    }

    fn build_ordinal_zero_index(
        &mut self,
        budget: &mut GenerationHistoryReadBudget,
        headers: &[GenerationHistoryAttemptHeader],
    ) -> Result<OrdinalZeroIndex> {
        let mut index = OrdinalZeroIndex::default();
        for header in headers {
            self.checkpoint()?;
            // A binding of an unknown version has references of an unknown
            // format: not counted, so the session is ambiguous.
            if header.binding
                == HistoryHeaderBinding::Excluded(
                    HistoryContextGateReason::UnsupportedBindingVersion,
                )
            {
                index.ambiguous = true;
                continue;
            }
            let known = header.gate().is_none();
            let bytes: Option<i64> = self
                .connection
                .query_row(
                    "SELECT octet_length(reference_json) FROM nir1_generation_input_refs
                     WHERE attempt_id=?1 AND ordinal=0",
                    [&header.id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(bytes) = bytes else {
                continue;
            };
            let bytes =
                bounded_sqlite_length(bytes, budget.max_reference_bytes, REFERENCE_LIMIT_ERROR)?;
            ensure!(budget.max_reference_count > 0, "{}", REFERENCE_LIMIT_ERROR);
            budget.max_reference_count -= 1;
            budget.max_reference_bytes -= bytes;
            let raw: String = self.connection.query_row(
                "SELECT reference_json FROM nir1_generation_input_refs
                 WHERE attempt_id=?1 AND ordinal=0",
                [&header.id],
                |row| row.get(0),
            )?;
            ensure!(raw.len() == bytes, "NIR1_GENERATION_REF_LENGTH_CHANGED");
            let parsed = parse_versioned_reference::<InputReference, LegacyInputReferenceV1>(&raw);
            let target = match parsed {
                Ok(VersionedReference::Current(reference)) => reference.target,
                Ok(VersionedReference::Legacy(reference)) => reference.target,
                // A usable attempt's malformed row aborts the read, as
                // before. A gated or legacy attempt is not used anyway, so
                // its unreadable row must not stop the turn: it only makes
                // the count unknown.
                Err(_) if !known => {
                    index.ambiguous = true;
                    continue;
                }
                Err(error) => return Err(error),
            };
            if let InputTarget::Message { version_id, .. } = target {
                index
                    .by_version
                    .entry(version_id)
                    .or_default()
                    .push(header.id.clone());
            }
        }
        Ok(index)
    }
}
