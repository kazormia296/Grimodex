//! Scalar admission before the A2 reader materializes a whole typed Revision.
//! This bounds stored input bytes, not serde expansion or exact heap usage.
//! The caller separately admits project scope authority and current epoch data.
#[cfg(feature = "nir1-material-diagnostics")]
use std::time::Instant;

use rusqlite::{params, Connection, OptionalExtension};

use grimodex_core::narrative_nir1::MAX_GRAPH_RECORDS;

use super::super::nir1_entity_relation::{
    NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH, NIR1_ENTITY_RELATION_SET_KIND,
};

const INPUT_LIMIT: &str = "NIR1_GRAPH_REVISION_INPUT_LIMIT";
const ROW_LIMIT: &str = "NIR1_GRAPH_REVISION_RECORD_LIMIT";
const DISCLOSURE_ROW_LIMIT: &str = "NIR1_GRAPH_DISCLOSURE_RECORD_LIMIT";
const INPUT_BYTES: usize = 2 * 1024 * 1024;

#[cfg(feature = "nir1-material-diagnostics")]
const A2_RELATED_QUERY_COUNT: usize = 10;
#[cfg(feature = "nir1-material-diagnostics")]
const A2_SQL_QUERY_COUNT: usize = A2_RELATED_QUERY_COUNT + 2;
#[cfg(feature = "nir1-material-diagnostics")]
const A2_RELATED_SLOT_BASE: u8 = 2;

#[cfg(feature = "nir1-material-diagnostics")]
#[derive(Debug, Default, Eq, PartialEq)]
pub(crate) struct A2SqlObservation {
    pub(crate) length_ns: Option<u64>,
    pub(crate) count_ns: Option<u64>,
    pub(crate) related_ns: [Option<u64>; A2_RELATED_QUERY_COUNT],
    pub(crate) error_slot: Option<u8>,
    pub(crate) overflow_mask: u16,
    pub(crate) unattributed: bool,
}

#[cfg(feature = "nir1-material-diagnostics")]
impl A2SqlObservation {
    fn slot_mut(&mut self, ordinal: u8) -> Option<&mut Option<u64>> {
        match ordinal {
            0 => Some(&mut self.length_ns),
            1 => Some(&mut self.count_ns),
            ordinal if usize::from(ordinal) < A2_SQL_QUERY_COUNT => {
                Some(&mut self.related_ns[usize::from(ordinal - A2_RELATED_SLOT_BASE)])
            }
            _ => None,
        }
    }

    fn record_elapsed_nanos(&mut self, ordinal: u8, elapsed_nanos: u128) {
        if usize::from(ordinal) >= A2_SQL_QUERY_COUNT {
            return;
        }
        let Some(bit) = 1_u16.checked_shl(u32::from(ordinal)) else {
            return;
        };
        if self.overflow_mask & bit != 0 {
            return;
        }

        let elapsed_nanos = u64::try_from(elapsed_nanos).ok();
        let Some(slot) = self.slot_mut(ordinal) else {
            return;
        };
        let total = match (*slot, elapsed_nanos) {
            (Some(previous), Some(elapsed)) => previous.checked_add(elapsed),
            (None, Some(elapsed)) => Some(elapsed),
            (_, None) => None,
        };
        *slot = total;
        if total.is_none() {
            self.overflow_mask |= bit;
            self.unattributed = true;
        }
    }

    fn record_error(&mut self, ordinal: u8) {
        if usize::from(ordinal) < A2_SQL_QUERY_COUNT && self.error_slot.is_none() {
            self.error_slot = Some(ordinal);
        }
    }
}

#[cfg(feature = "nir1-material-diagnostics")]
const _: () = assert!(RELATED_BYTES_SQL.len() == A2_RELATED_QUERY_COUNT);

#[cfg(feature = "nir1-material-diagnostics")]
const A3_SQL_QUERY_COUNT: usize = 23;
#[cfg(feature = "nir1-material-diagnostics")]
const _: () = {
    assert!(DISCLOSURE_GLOBAL_ROWS_SQL.len() == 8);
    assert!(DISCLOSURE_GLOBAL_BYTES_SQL.len() == 8);
    assert!(DISCLOSURE_MATERIAL_BYTES_SQL.len() == 5);
};

#[cfg(feature = "nir1-material-diagnostics")]
#[derive(Debug, Default)]
pub(crate) struct A3SqlObservation {
    pub(crate) timings_ns: [Option<u64>; A3_SQL_QUERY_COUNT],
    pub(crate) error_slot: Option<u8>,
    pub(crate) overflow_mask: u32,
    pub(crate) unattributed: bool,
}

#[cfg(feature = "nir1-material-diagnostics")]
impl A3SqlObservation {
    fn record(&mut self, ordinal: u8, elapsed_nanos: u128, failed: bool) {
        if let Some(slot) = self.timings_ns.get_mut(usize::from(ordinal)) {
            let bit = 1_u32 << ordinal;
            if self.overflow_mask & bit == 0 {
                *slot = elapsed_nanos
                    .try_into()
                    .ok()
                    .and_then(|elapsed: u64| slot.unwrap_or(0).checked_add(elapsed));
                if slot.is_none() {
                    self.overflow_mask |= bit;
                    self.unattributed = true;
                }
            }
            if failed && self.error_slot.is_none() {
                self.error_slot = Some(ordinal);
            }
        }
    }
}

#[cfg(feature = "nir1-material-diagnostics")]
fn start_a3_sql_timer(observation: &Option<&mut A3SqlObservation>) -> Option<Instant> {
    observation.as_ref().map(|_| Instant::now())
}

#[cfg(feature = "nir1-material-diagnostics")]
fn record_a3_sql_query(
    observation: &mut Option<&mut A3SqlObservation>,
    ordinal: u8,
    started: Option<Instant>,
    failed: bool,
) {
    if let (Some(observation), Some(started)) = (observation.as_deref_mut(), started) {
        observation.record(ordinal, started.elapsed().as_nanos(), failed);
    }
}

#[derive(Debug)]
pub(super) struct RevisionAdmission {
    pub rows: usize,
    pub bytes: usize,
    /// The A2 scalar payload length is reused by the A3 preflight. Keeping
    /// this value avoids a second octet_length query while preserving the
    /// JSON1 entity-count query after the length gate.
    pub payload_bytes: usize,
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct DisclosureAdmission {
    pub rows: usize,
    pub bytes: usize,
}

/// None is reserved for a missing or wrong-family Revision. All resource
/// failures abort the query, including ineligible or malformed candidates.
pub(super) fn preflight_revision(
    conn: &Connection,
    project: &str,
    revision_id: &str,
    remaining_rows: usize,
    remaining_bytes: usize,
) -> anyhow::Result<Option<RevisionAdmission>> {
    preflight_revision_inner(
        conn,
        project,
        revision_id,
        remaining_rows,
        remaining_bytes,
        #[cfg(feature = "nir1-material-diagnostics")]
        None,
    )
}

#[cfg(feature = "nir1-material-diagnostics")]
pub(super) fn preflight_revision_observed(
    conn: &Connection,
    project: &str,
    revision_id: &str,
    remaining_rows: usize,
    remaining_bytes: usize,
    observation: Option<&mut A2SqlObservation>,
) -> anyhow::Result<Option<RevisionAdmission>> {
    preflight_revision_inner(
        conn,
        project,
        revision_id,
        remaining_rows,
        remaining_bytes,
        observation,
    )
}

fn preflight_revision_inner(
    conn: &Connection,
    project: &str,
    revision_id: &str,
    remaining_rows: usize,
    remaining_bytes: usize,
    #[cfg(feature = "nir1-material-diagnostics")] mut observation: Option<&mut A2SqlObservation>,
) -> anyhow::Result<Option<RevisionAdmission>> {
    #[cfg(feature = "nir1-material-diagnostics")]
    let lengths_started = start_a2_sql_timer(&observation);
    let lengths_query = conn.query_row(
        LENGTH_SQL,
        params![
            revision_id,
            project,
            NIR1_ENTITY_RELATION_SET_KIND,
            NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH
        ],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    );
    let lengths = lengths_query.optional();
    #[cfg(feature = "nir1-material-diagnostics")]
    record_a2_sql_query(&mut observation, 0, lengths_started, lengths.is_err());
    let Some((payload, envelope, metadata)) = lengths? else {
        return Ok(None);
    };
    let payload_bytes = usize::try_from(payload).map_err(|_| anyhow::anyhow!(INPUT_LIMIT))?;
    let mut bytes = 0;
    for value in [payload, envelope, metadata] {
        admit_bytes(&mut bytes, value, remaining_bytes)?;
    }
    // No JSON SQL operation occurs until both persisted documents fit.
    #[cfg(feature = "nir1-material-diagnostics")]
    let counts_started = start_a2_sql_timer(&observation);
    let counts_query: rusqlite::Result<(i64, i64, i64)> = conn.query_row(
        COUNT_SQL,
        params![
            revision_id,
            project,
            NIR1_ENTITY_RELATION_SET_KIND,
            NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH
        ],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    );
    #[cfg(feature = "nir1-material-diagnostics")]
    record_a2_sql_query(&mut observation, 1, counts_started, counts_query.is_err());
    let counts = counts_query?;
    let mut rows = 0usize;
    for value in [counts.0, counts.1, counts.2] {
        rows = rows
            .checked_add(usize::try_from(value).map_err(|_| anyhow::anyhow!(ROW_LIMIT))?)
            .filter(|value| *value <= remaining_rows)
            .ok_or_else(|| anyhow::anyhow!(ROW_LIMIT))?;
    }
    // Include persisted authorities even if A2 will later reject them. Live
    // bodies are joined from payload IDs, not potentially tampered basis IDs.
    #[cfg(feature = "nir1-material-diagnostics")]
    let related_queries = related_bytes_sql().iter().enumerate();
    #[cfg(not(feature = "nir1-material-diagnostics"))]
    let related_queries = related_bytes_sql().iter().map(|sql| ((), sql));
    for (_related_index, sql) in related_queries {
        #[cfg(feature = "nir1-material-diagnostics")]
        let related_started = start_a2_sql_timer(&observation);
        let value_query = conn.query_row(sql, params![project, revision_id], |row| row.get(0));
        #[cfg(feature = "nir1-material-diagnostics")]
        record_a2_sql_query(
            &mut observation,
            A2_RELATED_SLOT_BASE + _related_index as u8,
            related_started,
            value_query.is_err(),
        );
        let value = value_query?;
        admit_bytes(&mut bytes, value, remaining_bytes)?;
    }
    Ok(Some(RevisionAdmission {
        rows,
        bytes,
        payload_bytes,
    }))
}

#[cfg(feature = "nir1-material-diagnostics")]
fn start_a2_sql_timer(observation: &Option<&mut A2SqlObservation>) -> Option<Instant> {
    observation.as_ref().map(|_| Instant::now())
}

#[cfg(feature = "nir1-material-diagnostics")]
fn record_a2_sql_query(
    observation: &mut Option<&mut A2SqlObservation>,
    ordinal: u8,
    started: Option<Instant>,
    failed: bool,
) {
    let Some(observation) = observation.as_deref_mut() else {
        return;
    };
    if let Some(started) = started {
        observation.record_elapsed_nanos(ordinal, started.elapsed().as_nanos());
    }
    if failed {
        observation.record_error(ordinal);
    }
}

fn admit_bytes(total: &mut usize, value: i64, remaining: usize) -> anyhow::Result<()> {
    *total = total
        .checked_add(usize::try_from(value).map_err(|_| anyhow::anyhow!(INPUT_LIMIT))?)
        .filter(|value| *value <= remaining.min(INPUT_BYTES))
        .ok_or_else(|| anyhow::anyhow!(INPUT_LIMIT))?;
    Ok(())
}

fn admit_rows(
    total: &mut usize,
    value: i64,
    multiplier: usize,
    remaining: usize,
) -> anyhow::Result<()> {
    let value = usize::try_from(value).map_err(|_| anyhow::anyhow!(DISCLOSURE_ROW_LIMIT))?;
    let additional = value
        .checked_mul(multiplier)
        .ok_or_else(|| anyhow::anyhow!(DISCLOSURE_ROW_LIMIT))?;
    *total = total
        .checked_add(additional)
        .filter(|value| *value <= remaining.min(MAX_GRAPH_RECORDS))
        .ok_or_else(|| anyhow::anyhow!(DISCLOSURE_ROW_LIMIT))?;
    Ok(())
}

const LENGTH_SQL: &str = "SELECT COALESCE(octet_length(revision.payload_json), 0),
                    COALESCE(octet_length(revision.reconciliation_envelope_json), 0),
                    COALESCE(octet_length(proposal_set.id), 0) +
                    COALESCE(octet_length(proposal_set.run_id), 0) +
                    COALESCE(octet_length(proposal.id), 0) +
                    COALESCE(octet_length(proposal.current_revision_id), 0) +
                    COALESCE(octet_length(proposal.status), 0) +
                    COALESCE(octet_length(revision.origin_kind), 0) +
                    COALESCE(octet_length(revision.reconciliation_envelope_digest), 0) +
                    COALESCE(octet_length(revision.created_at), 0) +
                    COALESCE((SELECT SUM(COALESCE(octet_length(d.id), 0) + COALESCE(octet_length(d.revision_id), 0) + COALESCE(octet_length(d.decision), 0) + COALESCE(octet_length(d.decision_json), 0) + COALESCE(octet_length(d.created_at), 0) + COALESCE(octet_length(d.created_by), 0) + COALESCE(octet_length(d.actor_kind), 0) + COALESCE(octet_length(d.actor_id), 0) + COALESCE(octet_length(d.authority_scope), 0) + COALESCE(octet_length(d.override_field_paths_json), 0))
                        FROM narrative_proposal_decisions d WHERE d.proposal_id=proposal.id AND d.revision_id=revision.id), 0)
               FROM narrative_proposal_revisions revision
               JOIN narrative_proposals proposal
                 ON proposal.id = revision.proposal_id
               JOIN narrative_proposal_sets proposal_set
                 ON proposal_set.id = proposal.proposal_set_id
               JOIN narrative_extraction_runs extraction_run
                 ON extraction_run.id = proposal_set.run_id
                AND extraction_run.project_id = proposal_set.project_id
              WHERE revision.id = ?1
                AND proposal_set.project_id = ?2
                AND proposal_set.set_kind = ?3
                AND extraction_run.surface_path_id = ?4";

const COUNT_SQL: &str = "SELECT CASE WHEN json_valid(revision.payload_json)
                         THEN COALESCE(json_array_length(
                                  json_extract(revision.payload_json, '$.bundle.entities')
                              ), 0)
                         ELSE 0 END,
                    CASE WHEN json_valid(revision.payload_json)
                         THEN COALESCE(json_array_length(
                                  json_extract(revision.payload_json, '$.bundle.relations')
                              ), 0)
                         ELSE 0 END,
                    CASE WHEN json_valid(revision.payload_json)
                         THEN COALESCE((
                              SELECT SUM(
                                  CASE WHEN json_valid(entity.value)
                                       THEN COALESCE(json_array_length(
                                            json_extract(entity.value, '$.evidence')
                                        ), 0)
                                       ELSE 0 END
                              )
                                FROM json_each(
                                    CASE WHEN json_valid(revision.payload_json)
                                              AND json_type(
                                               revision.payload_json,
                                               '$.bundle.entities'
                                         ) = 'array'
                                         THEN json_extract(
                                               revision.payload_json,
                                               '$.bundle.entities'
                                         )
                                         ELSE '[]' END
                                ) AS entity
                         ), 0)
                         ELSE 0 END
               FROM narrative_proposal_revisions revision
               JOIN narrative_proposals proposal
                 ON proposal.id = revision.proposal_id
               JOIN narrative_proposal_sets proposal_set
                 ON proposal_set.id = proposal.proposal_set_id
               JOIN narrative_extraction_runs extraction_run
                 ON extraction_run.id = proposal_set.run_id
                AND extraction_run.project_id = proposal_set.project_id
              WHERE revision.id = ?1
                AND proposal_set.project_id = ?2
                AND proposal_set.set_kind = ?3
                AND extraction_run.surface_path_id = ?4";

const RELATED_BYTES_SQL: &[&str] = &[
    "SELECT COALESCE(SUM(COALESCE(octet_length(b.source_kind), 0) +
                    COALESCE(octet_length(b.source_key), 0) +
                    COALESCE(octet_length(b.revision_token), 0) +
                    COALESCE(octet_length(b.observed_at), 0)), 0) FROM narrative_revision_source_basis b
             WHERE b.revision_id=?2",
    "SELECT COALESCE(SUM(COALESCE(octet_length(e.id), 0) +
                    COALESCE(octet_length(e.project_id), 0) +
                    COALESCE(octet_length(e.consumer_kind), 0) +
                    COALESCE(octet_length(e.consumer_key), 0) +
                    COALESCE(octet_length(e.source_object_identity), 0) +
                    COALESCE(octet_length(e.read_set_json), 0) +
                    COALESCE(octet_length(e.generated_by_transaction_id), 0) +
                    COALESCE(octet_length(e.created_at), 0) +
                    COALESCE(octet_length(e.owning_run_id), 0)), 0) FROM narrative_dependency_edges e
             WHERE e.project_id=?1 AND e.consumer_kind='proposal-revision' AND e.consumer_key=?2",
    "SELECT COALESCE(SUM(COALESCE(octet_length(s.evidence_freshness), 0) +
                    COALESCE(octet_length(s.reason_code), 0) +
                    COALESCE(octet_length(s.build_action), 0) +
                    COALESCE(octet_length(s.evaluated_at_epoch_id), 0) +
                    COALESCE(octet_length(s.evaluated_at), 0)), 0) FROM narrative_dependency_edge_states s
             JOIN narrative_dependency_edges e ON e.id=s.edge_id WHERE e.project_id=?1 AND e.consumer_kind='proposal-revision' AND e.consumer_key=?2",
    "SELECT COALESCE(SUM(COALESCE(octet_length(h.project_id), 0) +
                    COALESCE(octet_length(h.consumer_kind), 0) +
                    COALESCE(octet_length(h.consumer_key), 0) +
                    COALESCE(octet_length(h.active_declaration_set_id), 0) +
                    COALESCE(octet_length(h.producer_id), 0) +
                    COALESCE(octet_length(h.updated_at), 0)), 0) FROM narrative_dependency_declaration_heads h
             WHERE h.project_id=?1 AND h.consumer_kind='proposal-revision' AND h.consumer_key=?2",
    "SELECT COALESCE(SUM(COALESCE(octet_length(d.id), 0) +
                    COALESCE(octet_length(d.project_id), 0) +
                    COALESCE(octet_length(d.consumer_kind), 0) +
                    COALESCE(octet_length(d.consumer_key), 0) +
                    COALESCE(octet_length(d.producer_id), 0) +
                    COALESCE(octet_length(d.dependency_set_digest), 0) +
                    COALESCE(octet_length(d.state), 0) +
                    COALESCE(octet_length(d.created_at), 0)), 0) FROM narrative_dependency_declaration_sets d
             JOIN narrative_dependency_declaration_heads h ON h.active_declaration_set_id=d.id WHERE h.project_id=?1 AND h.consumer_kind='proposal-revision' AND h.consumer_key=?2",
    "SELECT COALESCE(SUM(COALESCE(octet_length(d.id), 0) +
                    COALESCE(octet_length(d.declaration_set_id), 0) +
                    COALESCE(octet_length(d.source_object_identity), 0) +
                    COALESCE(octet_length(d.dependency_key), 0) +
                    COALESCE(octet_length(d.dependency_role), 0) +
                    COALESCE(octet_length(d.role_contract_version), 0) +
                    COALESCE(octet_length(d.selector_json), 0) +
                    COALESCE(octet_length(d.selector_digest), 0) +
                    COALESCE(octet_length(d.created_at), 0)), 0) FROM narrative_dependency_declaration_entries d
             JOIN narrative_dependency_declaration_heads h ON h.active_declaration_set_id=d.declaration_set_id WHERE h.project_id=?1 AND h.consumer_kind='proposal-revision' AND h.consumer_key=?2",
    "SELECT COALESCE(SUM(COALESCE(octet_length(f.evidence_freshness), 0) +
                    COALESCE(octet_length(f.build_action), 0) +
                    COALESCE(octet_length(f.semantic_epoch_id), 0) +
                    COALESCE(octet_length(f.last_evaluated_run_id), 0) +
                    COALESCE(octet_length(f.dependency_set_digest), 0) +
                    COALESCE(octet_length(f.updated_at), 0)), 0) FROM narrative_consumer_freshness f
             WHERE f.project_id=?1 AND f.consumer_kind='proposal-revision' AND f.consumer_key=?2",
    "SELECT COALESCE(SUM(COALESCE(octet_length(r.semantic_epoch_id), 0)), 0) FROM narrative_extraction_runs r
             JOIN narrative_proposal_sets s ON s.run_id=r.id JOIN narrative_proposals p ON p.proposal_set_id=s.id JOIN narrative_proposal_revisions v ON v.proposal_id=p.id WHERE r.project_id=?1 AND v.id=?2",
    "SELECT COALESCE(SUM(COALESCE(octet_length(e.id), 0) +
                    COALESCE(octet_length(e.type), 0) +
                    COALESCE(octet_length(e.name), 0) +
                    COALESCE(octet_length(e.summary), 0) +
                    COALESCE(octet_length(e.updated_at), 0)), 0) FROM narrative_proposal_revisions v
             CROSS JOIN json_each(CASE WHEN json_valid(v.payload_json)
                  THEN CASE WHEN json_type(v.payload_json, '$.bundle.entities')='array'
                       THEN json_extract(v.payload_json, '$.bundle.entities') ELSE '[]' END
                  ELSE '[]' END) material
             CROSS JOIN codex_entries e
             WHERE v.id=?2 AND e.project_id=?1
               AND e.id=CASE WHEN material.type='object'
                    THEN json_extract(material.value, '$.entityId') END",
    RELATION_BYTES_SQL,
];

/// Live Relation bodies named by the Revision's payload, each counted once per
/// payload entry that names it. The Revision's own `json_each` drives primary
/// key lookups of `codex_relations`: the planner would otherwise put the
/// project's Relations in the outer loop and expand the payload once per
/// Relation, so the cost followed the product of the two counts. `CROSS JOIN`
/// fixes the order, as in the Entity statement above.
const RELATION_BYTES_SQL: &str = "SELECT COALESCE(SUM(COALESCE(octet_length(e.id), 0) +
                    COALESCE(octet_length(e.from_codex_id), 0) +
                    COALESCE(octet_length(e.to_codex_id), 0) +
                    COALESCE(octet_length(e.relation_type), 0) +
                    COALESCE(octet_length(e.directionality), 0) +
                    COALESCE(octet_length(e.version), 0) +
                    COALESCE(octet_length(e.updated_at), 0)), 0) FROM narrative_proposal_revisions v
             CROSS JOIN json_each(CASE WHEN json_valid(v.payload_json)
                  THEN CASE WHEN json_type(v.payload_json, '$.bundle.relations')='array'
                       THEN json_extract(v.payload_json, '$.bundle.relations') ELSE '[]' END
                  ELSE '[]' END) material
             CROSS JOIN codex_relations e
             WHERE v.id=?2 AND e.project_id=?1
               AND e.id=CASE WHEN material.type='object'
                    THEN json_extract(material.value, '$.edgeId') END";

/// The statement above before CQ-OPT: the same (Relation, payload entry) pairs,
/// joined with the project's Relations outermost. Test oracle only.
#[cfg(test)]
const LEGACY_RELATION_BYTES_SQL: &str = "SELECT COALESCE(SUM(COALESCE(octet_length(e.id), 0) +
                    COALESCE(octet_length(e.from_codex_id), 0) +
                    COALESCE(octet_length(e.to_codex_id), 0) +
                    COALESCE(octet_length(e.relation_type), 0) +
                    COALESCE(octet_length(e.directionality), 0) +
                    COALESCE(octet_length(e.version), 0) +
                    COALESCE(octet_length(e.updated_at), 0)), 0) FROM codex_relations e
             JOIN narrative_proposal_revisions v ON v.id=?2
             JOIN json_each(CASE WHEN json_valid(v.payload_json)
                  THEN CASE WHEN json_type(v.payload_json, '$.bundle.relations')='array'
                       THEN json_extract(v.payload_json, '$.bundle.relations') ELSE '[]' END
                  ELSE '[]' END) material
               ON e.id=CASE WHEN material.type='object'
                    THEN json_extract(material.value, '$.edgeId') END
             WHERE e.project_id=?1";

/// [`RELATED_BYTES_SQL`] as it was before CQ-OPT: the same statements with the
/// Relation byte count put back. Test oracle only.
#[cfg(test)]
const LEGACY_RELATED_BYTES_SQL: [&str; RELATED_BYTES_SQL.len()] = {
    let mut statements = [""; RELATED_BYTES_SQL.len()];
    let mut index = 0;
    while index < RELATED_BYTES_SQL.len() {
        statements[index] = RELATED_BYTES_SQL[index];
        index += 1;
    }
    statements[RELATED_BYTES_SQL.len() - 1] = LEGACY_RELATION_BYTES_SQL;
    statements
};

#[cfg(test)]
thread_local! {
    /// Test-only: the preflight counts Relation bytes with
    /// [`LEGACY_RELATION_BYTES_SQL`], to compare responses and steps with the
    /// statement before CQ-OPT.
    static LEGACY_RELATION_BYTES: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// The statements the preflight runs for the authorities a Revision names.
fn related_bytes_sql() -> &'static [&'static str] {
    #[cfg(test)]
    if LEGACY_RELATION_BYTES.get() {
        return &LEGACY_RELATED_BYTES_SQL;
    }
    RELATED_BYTES_SQL
}

/// Run `operation` with the preflight counting Relation bytes by
/// [`LEGACY_RELATION_BYTES_SQL`] (J put back to its statement before CQ-OPT).
#[cfg(test)]
pub(super) fn with_legacy_relation_bytes<T>(operation: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            LEGACY_RELATION_BYTES.set(self.0);
        }
    }
    let _restore = Restore(LEGACY_RELATION_BYTES.replace(true));
    operation()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Related-authority tables are intentionally absent: early admission must
    // reject before attempting to read them or decode an oversized document.
    fn fixture(payload: &str, envelope: &str, family: &str) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE narrative_proposal_revisions (
                id TEXT, proposal_id TEXT, payload_json TEXT,
                reconciliation_envelope_json TEXT, origin_kind TEXT,
                reconciliation_envelope_digest TEXT, created_at TEXT);
             CREATE TABLE narrative_proposals (
                id TEXT, proposal_set_id TEXT, current_revision_id TEXT, status TEXT);
             CREATE TABLE narrative_proposal_sets (
                id TEXT, run_id TEXT, project_id TEXT, set_kind TEXT);
             CREATE TABLE narrative_extraction_runs (
                id TEXT, project_id TEXT, surface_path_id TEXT);
             CREATE TABLE narrative_proposal_decisions (
                id TEXT, proposal_id TEXT, revision_id TEXT, decision TEXT,
                decision_json TEXT, created_at TEXT, created_by TEXT,
                actor_kind TEXT, actor_id TEXT, authority_scope TEXT,
                override_field_paths_json TEXT);
             INSERT INTO narrative_proposals VALUES ('proposal','set','revision','draft');",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO narrative_proposal_sets VALUES ('set','run','project',?1)",
            [family],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO narrative_extraction_runs VALUES ('run','project',?1)",
            [NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH],
        )
        .unwrap();
        conn.execute("INSERT INTO narrative_proposal_revisions VALUES ('revision','proposal',?1,?2,'test','digest','now')", params![payload,envelope]).unwrap();
        conn
    }

    #[cfg(feature = "nir1-material-diagnostics")]
    fn complete_a2_fixture(payload: &str) -> Connection {
        let conn = fixture(payload, "{}", NIR1_ENTITY_RELATION_SET_KIND);
        conn.execute_batch(
            "ALTER TABLE narrative_extraction_runs ADD COLUMN semantic_epoch_id TEXT;
             CREATE TABLE narrative_revision_source_basis (
                 revision_id TEXT, source_kind TEXT, source_key TEXT,
                 revision_token TEXT, observed_at TEXT);
             CREATE TABLE narrative_dependency_edges (
                 id TEXT, project_id TEXT, consumer_kind TEXT, consumer_key TEXT,
                 source_object_identity TEXT, read_set_json TEXT,
                 generated_by_transaction_id TEXT, created_at TEXT, owning_run_id TEXT);
             CREATE TABLE narrative_dependency_edge_states (
                 edge_id TEXT, evidence_freshness TEXT, reason_code TEXT,
                 build_action TEXT, evaluated_at_epoch_id TEXT, evaluated_at TEXT);
             CREATE TABLE narrative_dependency_declaration_heads (
                 project_id TEXT, consumer_kind TEXT, consumer_key TEXT,
                 active_declaration_set_id TEXT, producer_id TEXT, updated_at TEXT);
             CREATE TABLE narrative_dependency_declaration_sets (
                 id TEXT, project_id TEXT, consumer_kind TEXT, consumer_key TEXT,
                 producer_id TEXT, dependency_set_digest TEXT, state TEXT, created_at TEXT);
             CREATE TABLE narrative_dependency_declaration_entries (
                 id TEXT, declaration_set_id TEXT, source_object_identity TEXT,
                 dependency_key TEXT, dependency_role TEXT, role_contract_version TEXT,
                 selector_json TEXT, selector_digest TEXT, created_at TEXT);
             CREATE TABLE narrative_consumer_freshness (
                 project_id TEXT, consumer_kind TEXT, consumer_key TEXT,
                 evidence_freshness TEXT, build_action TEXT, semantic_epoch_id TEXT,
                 last_evaluated_run_id TEXT, dependency_set_digest TEXT, updated_at TEXT);
             CREATE TABLE codex_entries (
                 id TEXT, project_id TEXT, type TEXT, name TEXT, summary TEXT, updated_at TEXT);
             CREATE TABLE codex_relations (
                 id TEXT, project_id TEXT, from_codex_id TEXT, to_codex_id TEXT,
                 relation_type TEXT, directionality TEXT, version TEXT, updated_at TEXT);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn oversized_documents_abort_before_json_or_related_authority_reads() {
        for (payload, envelope) in [
            ("[".repeat(INPUT_BYTES + 1), "{}".into()),
            ("{}".into(), "[".repeat(INPUT_BYTES + 1)),
        ] {
            let conn = fixture(&payload, &envelope, NIR1_ENTITY_RELATION_SET_KIND);
            assert_eq!(
                preflight_revision(&conn, "project", "revision", 500, usize::MAX)
                    .unwrap_err()
                    .to_string(),
                INPUT_LIMIT
            );
        }
        let conn = fixture("{}", "{}", "different-family");
        assert!(preflight_revision(&conn, "project", "revision", 0, 0)
            .unwrap()
            .is_none());
        assert!(preflight_revision(&conn, "project", "missing", 0, 0)
            .unwrap()
            .is_none());
    }

    #[test]
    fn mixed_material_and_decision_bytes_consume_the_callers_budget() {
        let payload =
            r#"{"bundle":{"entities":[{"evidence":[{},{}]},{"evidence":[{}]}],"relations":[{}]}}"#;
        let conn = fixture(payload, "{}", NIR1_ENTITY_RELATION_SET_KIND);
        assert_eq!(
            preflight_revision(&conn, "project", "revision", 5, INPUT_BYTES)
                .unwrap_err()
                .to_string(),
            ROW_LIMIT
        );
        conn.execute("INSERT INTO narrative_proposal_decisions (proposal_id,revision_id,decision_json) VALUES ('proposal','revision',?1)", ["x".repeat(1024)]).unwrap();
        assert_eq!(
            preflight_revision(&conn, "project", "revision", 500, 1024)
                .unwrap_err()
                .to_string(),
            INPUT_LIMIT
        );
    }

    #[test]
    fn codex_entry_bytes_preserve_duplicate_and_project_joins() {
        let conn = fixture(
            r#"{"bundle":{"entities":[{"entityId":"entry"},{"entityId":"entry"},{"entityId":"foreign"},"entry"]}}"#,
            "{}",
            NIR1_ENTITY_RELATION_SET_KIND,
        );
        conn.execute_batch(
            "CREATE TABLE codex_entries (id TEXT PRIMARY KEY, project_id TEXT, type TEXT,
                name TEXT, summary TEXT, updated_at TEXT);
             INSERT INTO codex_entries VALUES ('entry','project','character','name','summary','now');
             INSERT INTO codex_entries VALUES ('foreign','other','character','name','summary','now');",
        )
        .unwrap();
        let bytes: i64 = conn
            .query_row(
                RELATED_BYTES_SQL[8],
                params!["project", "revision"],
                |row| row.get(0),
            )
            .unwrap();
        let one_entry = ["entry", "character", "name", "summary", "now"]
            .iter()
            .map(|value| value.len() as i64)
            .sum::<i64>();
        assert_eq!(bytes, 2 * one_entry);
    }

    #[cfg(feature = "nir1-material-diagnostics")]
    #[test]
    fn a2_observation_records_all_twelve_fixed_ordinals() {
        assert_eq!(RELATED_BYTES_SQL.len(), A2_RELATED_QUERY_COUNT);
        for (sql, source) in RELATED_BYTES_SQL.iter().zip([
            "FROM narrative_revision_source_basis b",
            "FROM narrative_dependency_edges e",
            "FROM narrative_dependency_edge_states s",
            "FROM narrative_dependency_declaration_heads h",
            "FROM narrative_dependency_declaration_sets d",
            "FROM narrative_dependency_declaration_entries d",
            "FROM narrative_consumer_freshness f",
            "FROM narrative_extraction_runs r",
            "CROSS JOIN codex_entries e",
            "CROSS JOIN codex_relations e",
        ]) {
            assert!(
                sql.contains(source),
                "A2 diagnostic SQL slot changed: {source}"
            );
        }
        let mut observation = A2SqlObservation::default();
        for ordinal in 0..A2_SQL_QUERY_COUNT as u8 {
            observation.record_elapsed_nanos(ordinal, u128::from(ordinal) + 1);
        }
        assert_eq!(observation.length_ns, Some(1));
        assert_eq!(observation.count_ns, Some(2));
        assert_eq!(
            observation.related_ns,
            std::array::from_fn(|index| Some(index as u64 + 3))
        );
        assert_eq!(observation.error_slot, None);
        assert_eq!(observation.overflow_mask, 0);
        assert!(!observation.unattributed);
    }

    #[cfg(feature = "nir1-material-diagnostics")]
    #[test]
    fn a2_observation_uses_checked_accumulation_and_tracks_overflow() {
        let mut observation = A2SqlObservation::default();
        observation.record_elapsed_nanos(0, 4);
        observation.record_elapsed_nanos(0, 5);
        observation.record_elapsed_nanos(1, u128::from(u64::MAX));
        observation.record_elapsed_nanos(1, 1);
        observation.record_elapsed_nanos(11, u128::from(u64::MAX) + 1);
        observation.record_error(9);
        observation.record_error(2);

        assert_eq!(observation.length_ns, Some(9));
        assert_eq!(observation.count_ns, None);
        assert_eq!(observation.related_ns[9], None);
        assert_eq!(observation.error_slot, Some(9));
        assert_eq!(observation.overflow_mask, (1 << 1) | (1 << 11));
        assert!(observation.unattributed);
    }

    #[cfg(feature = "nir1-material-diagnostics")]
    #[test]
    fn observed_a2_preserves_absent_malformed_and_oversized_results() {
        let absent = complete_a2_fixture("{}");
        let mut absent_observation = A2SqlObservation::default();
        assert!(
            preflight_revision(&absent, "project", "missing", 500, INPUT_BYTES)
                .unwrap()
                .is_none()
        );
        assert!(preflight_revision_observed(
            &absent,
            "project",
            "missing",
            500,
            INPUT_BYTES,
            Some(&mut absent_observation),
        )
        .unwrap()
        .is_none());
        assert!(absent_observation.length_ns.is_some());
        assert_eq!(absent_observation.count_ns, None);
        assert_eq!(
            absent_observation.related_ns,
            [None; A2_RELATED_QUERY_COUNT]
        );
        assert_eq!(absent_observation.error_slot, None);

        let malformed_payload = "{malformed";
        let malformed_plain = complete_a2_fixture(malformed_payload);
        let malformed_observed = complete_a2_fixture(malformed_payload);
        let plain = preflight_revision(&malformed_plain, "project", "revision", 500, INPUT_BYTES)
            .unwrap()
            .unwrap();
        let mut malformed_observation = A2SqlObservation::default();
        let observed = preflight_revision_observed(
            &malformed_observed,
            "project",
            "revision",
            500,
            INPUT_BYTES,
            Some(&mut malformed_observation),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            (observed.rows, observed.bytes, observed.payload_bytes),
            (plain.rows, plain.bytes, plain.payload_bytes)
        );
        assert_eq!(observed.rows, 0);
        assert!(malformed_observation.length_ns.is_some());
        assert!(malformed_observation.count_ns.is_some());
        assert!(malformed_observation.related_ns.iter().all(Option::is_some));
        assert_eq!(malformed_observation.error_slot, None);

        let oversized_payload = "[".repeat(INPUT_BYTES + 1);
        let oversized_plain = fixture(&oversized_payload, "{}", NIR1_ENTITY_RELATION_SET_KIND);
        let oversized_observed = fixture(&oversized_payload, "{}", NIR1_ENTITY_RELATION_SET_KIND);
        let plain_error =
            preflight_revision(&oversized_plain, "project", "revision", 500, INPUT_BYTES)
                .unwrap_err()
                .to_string();
        let mut oversized_observation = A2SqlObservation::default();
        let observed_error = preflight_revision_observed(
            &oversized_observed,
            "project",
            "revision",
            500,
            INPUT_BYTES,
            Some(&mut oversized_observation),
        )
        .unwrap_err()
        .to_string();
        assert_eq!(observed_error, plain_error);
        assert_eq!(observed_error, INPUT_LIMIT);
        assert!(oversized_observation.length_ns.is_some());
        assert_eq!(oversized_observation.count_ns, None);
        assert_eq!(
            oversized_observation.related_ns,
            [None; A2_RELATED_QUERY_COUNT]
        );
        assert_eq!(oversized_observation.error_slot, None);
    }

    #[cfg(feature = "nir1-material-diagnostics")]
    #[test]
    fn observed_a2_records_first_sql_error_before_returning_the_same_error() {
        let plain_conn = complete_a2_fixture("{}");
        let observed_conn = complete_a2_fixture("{}");
        plain_conn
            .execute_batch("DROP TABLE narrative_revision_source_basis")
            .unwrap();
        observed_conn
            .execute_batch("DROP TABLE narrative_revision_source_basis")
            .unwrap();

        let plain_error = preflight_revision(&plain_conn, "project", "revision", 500, INPUT_BYTES)
            .unwrap_err()
            .to_string();
        let mut observation = A2SqlObservation::default();
        let observed_error = preflight_revision_observed(
            &observed_conn,
            "project",
            "revision",
            500,
            INPUT_BYTES,
            Some(&mut observation),
        )
        .unwrap_err()
        .to_string();

        assert_eq!(observed_error, plain_error);
        assert!(observation.length_ns.is_some());
        assert!(observation.count_ns.is_some());
        assert!(observation.related_ns[0].is_some());
        assert_eq!(observation.error_slot, Some(2));
        assert!(observation.related_ns[1..].iter().all(Option::is_none));
    }
}

/// How many times the shared read of the Scope authority reads the registry:
/// its Scene-scope extension makes two statements (the whole registry, then
/// its version row), once for the query however many Revisions it evaluates.
/// Reading is counted, not estimated: before CQ-AVAIL each Revision's check
/// was charged `entities + 2` reads of the registry.
pub(super) const SHARED_REGISTRY_READS: usize = 2;

/// The stored inputs an A3 disclosure check reads, charged in two parts
/// (post-B 6.2: read/admission is one budget per query, "同一query/snapshot/
/// Scopeの同じRevisionはrequest-localで重複検証を抑える").
///
/// Shared by every Revision of a query: the project's tree, Scene bindings and
/// registry (the Scope authority), its phase mode, the latest Semantic Epoch,
/// and the query Scene's source and POV. They are read once in the pinned
/// snapshot (`Nir1ProjectReads`), so [`preflight_project_reads`] counts them
/// once, before that first read.
///
/// Bound to one Revision: its Decision, and the Codex rows its Entities name.
/// [`preflight_disclosure_revision`] counts those for each Revision. Neither
/// part re-charges A2, which the caller admits first.
///
/// This is scalar input/cardinality accounting, not a bound on JSON/PM
/// expansion or heap size.
#[derive(Clone, Copy, PartialEq, Eq)]
enum DisclosureReads {
    Shared,
    PerRevision,
}

/// A single Revision alone: the shared reads and its own, as a query that
/// evaluates only this Revision charges them. Tests only.
#[cfg(test)]
pub(super) fn preflight_disclosure(
    conn: &Connection,
    project: &str,
    revision_id: &str,
    query_scene_id: &str,
    remaining_rows: usize,
    remaining_bytes: usize,
) -> anyhow::Result<DisclosureAdmission> {
    const ERROR: &str = "NIR1_GRAPH_DISCLOSURE_INPUT_LIMIT";
    let payload_bytes: i64 = conn.query_row(
        "SELECT COALESCE(octet_length(payload_json),0)
           FROM narrative_proposal_revisions WHERE id=?1",
        [revision_id],
        |row| row.get(0),
    )?;
    let payload_bytes = usize::try_from(payload_bytes).map_err(|_| anyhow::anyhow!(ERROR))?;
    let shared = preflight_project_reads(
        conn,
        project,
        query_scene_id,
        remaining_rows,
        remaining_bytes,
    )?;
    let own = preflight_disclosure_revision(
        conn,
        project,
        revision_id,
        payload_bytes,
        shared.bytes,
        remaining_rows - shared.rows,
        remaining_bytes - shared.bytes,
    )?;
    Ok(DisclosureAdmission {
        rows: shared.rows + own.rows,
        bytes: shared.bytes + own.bytes,
    })
}

/// The shared project-level reads of A3 (see [`DisclosureReads`]), admitted
/// once per query before the first of them.
pub(super) fn preflight_project_reads(
    conn: &Connection,
    project: &str,
    query_scene_id: &str,
    remaining_rows: usize,
    remaining_bytes: usize,
) -> anyhow::Result<DisclosureAdmission> {
    preflight_project_reads_inner(
        conn,
        project,
        query_scene_id,
        remaining_rows,
        remaining_bytes,
        #[cfg(feature = "nir1-material-diagnostics")]
        None,
    )
}

#[cfg(feature = "nir1-material-diagnostics")]
pub(super) fn preflight_project_reads_observed(
    conn: &Connection,
    project: &str,
    query_scene_id: &str,
    remaining_rows: usize,
    remaining_bytes: usize,
    observation: Option<&mut A3SqlObservation>,
) -> anyhow::Result<DisclosureAdmission> {
    preflight_project_reads_inner(
        conn,
        project,
        query_scene_id,
        remaining_rows,
        remaining_bytes,
        observation,
    )
}

fn preflight_project_reads_inner(
    conn: &Connection,
    project: &str,
    query_scene_id: &str,
    remaining_rows: usize,
    remaining_bytes: usize,
    #[cfg(feature = "nir1-material-diagnostics")] mut observation: Option<&mut A3SqlObservation>,
) -> anyhow::Result<DisclosureAdmission> {
    const ERROR: &str = "NIR1_GRAPH_DISCLOSURE_INPUT_LIMIT";
    let mut rows = 0usize;
    #[cfg(feature = "nir1-material-diagnostics")]
    let global_row_queries = DISCLOSURE_GLOBAL_ROWS_SQL.iter().enumerate();
    #[cfg(not(feature = "nir1-material-diagnostics"))]
    let global_row_queries = DISCLOSURE_GLOBAL_ROWS_SQL.iter().map(|query| ((), query));
    for (_index, &(sql, multiplier, parameters)) in global_row_queries {
        if parameters == DisclosureGlobalRowsParams::Revision {
            continue;
        }
        #[cfg(feature = "nir1-material-diagnostics")]
        let started = start_a3_sql_timer(&observation);
        let value_query: rusqlite::Result<i64> = match parameters {
            DisclosureGlobalRowsParams::Project => conn.query_row(sql, [project], |row| row.get(0)),
            DisclosureGlobalRowsParams::ProjectScene => {
                conn.query_row(sql, params![project, query_scene_id], |row| row.get(0))
            }
            DisclosureGlobalRowsParams::Revision => continue,
        };
        #[cfg(feature = "nir1-material-diagnostics")]
        record_a3_sql_query(
            &mut observation,
            1 + _index as u8,
            started,
            value_query.is_err(),
        );
        let value = value_query?;
        let multiplier = if multiplier == 0 {
            SHARED_REGISTRY_READS
        } else {
            multiplier
        };
        admit_rows(&mut rows, value, multiplier, remaining_rows)?;
    }
    let mut bytes = 0usize;
    #[cfg(feature = "nir1-material-diagnostics")]
    let global_byte_queries = DISCLOSURE_GLOBAL_BYTES_SQL.iter().enumerate();
    #[cfg(not(feature = "nir1-material-diagnostics"))]
    let global_byte_queries = DISCLOSURE_GLOBAL_BYTES_SQL.iter().map(|query| ((), query));
    for (_index, &(sql, multiplier, reads)) in global_byte_queries {
        if reads != DisclosureReads::Shared {
            continue;
        }
        #[cfg(feature = "nir1-material-diagnostics")]
        let started = start_a3_sql_timer(&observation);
        // The statements bind a Revision slot only as a non-null guard.
        let value_query: rusqlite::Result<i64> =
            conn.query_row(sql, params![project, "", query_scene_id], |row| row.get(0));
        #[cfg(feature = "nir1-material-diagnostics")]
        record_a3_sql_query(
            &mut observation,
            10 + _index as u8,
            started,
            value_query.is_err(),
        );
        let value = value_query?;
        let multiplier = if multiplier == 0 {
            SHARED_REGISTRY_READS
        } else {
            multiplier
        };
        let additional = usize::try_from(value)
            .ok()
            .and_then(|value| value.checked_mul(multiplier))
            .ok_or_else(|| anyhow::anyhow!(ERROR))?;
        bytes = bytes
            .checked_add(additional)
            .filter(|value| *value <= remaining_bytes.min(INPUT_BYTES))
            .ok_or_else(|| anyhow::anyhow!(ERROR))?;
    }
    Ok(DisclosureAdmission { rows, bytes })
}

/// The A3 reads bound to one Revision (see [`DisclosureReads`]). A2 has
/// already admitted the payload's scalar byte length before any JSON1 work;
/// `payload_bytes` reuses it. `shared_bytes` are the bytes
/// [`preflight_project_reads`] admitted: the check of one Revision still sees
/// the shared reads it evaluates against, so shared and own bytes together
/// stay within the per-Revision preflight (2 MiB), as before CQ-AVAIL.
pub(super) fn preflight_disclosure_revision(
    conn: &Connection,
    project: &str,
    revision_id: &str,
    payload_bytes: usize,
    shared_bytes: usize,
    remaining_rows: usize,
    remaining_bytes: usize,
) -> anyhow::Result<DisclosureAdmission> {
    preflight_disclosure_revision_inner(
        conn,
        project,
        revision_id,
        payload_bytes,
        shared_bytes,
        remaining_rows,
        remaining_bytes,
        #[cfg(feature = "nir1-material-diagnostics")]
        None,
    )
}

#[cfg(feature = "nir1-material-diagnostics")]
pub(super) fn preflight_disclosure_revision_observed(
    conn: &Connection,
    project: &str,
    revision_id: &str,
    payload_bytes: usize,
    shared_bytes: usize,
    remaining_rows: usize,
    remaining_bytes: usize,
    observation: Option<&mut A3SqlObservation>,
) -> anyhow::Result<DisclosureAdmission> {
    preflight_disclosure_revision_inner(
        conn,
        project,
        revision_id,
        payload_bytes,
        shared_bytes,
        remaining_rows,
        remaining_bytes,
        observation,
    )
}

fn preflight_disclosure_revision_inner(
    conn: &Connection,
    project: &str,
    revision_id: &str,
    payload_bytes: usize,
    shared_bytes: usize,
    remaining_rows: usize,
    remaining_bytes: usize,
    #[cfg(feature = "nir1-material-diagnostics")] mut observation: Option<&mut A3SqlObservation>,
) -> anyhow::Result<DisclosureAdmission> {
    const ERROR: &str = "NIR1_GRAPH_DISCLOSURE_INPUT_LIMIT";
    anyhow::ensure!(payload_bytes <= INPUT_BYTES, ERROR);
    // The Revision's own bytes may use what the query's budget has left (the
    // shared bytes were admitted from it already) and what the shared reads
    // leave of the per-Revision preflight.
    let byte_limit = remaining_bytes.min(
        INPUT_BYTES
            .checked_sub(shared_bytes)
            .ok_or_else(|| anyhow::anyhow!(ERROR))?,
    );
    let mut rows = 0usize;
    #[cfg(feature = "nir1-material-diagnostics")]
    let global_row_queries = DISCLOSURE_GLOBAL_ROWS_SQL.iter().enumerate();
    #[cfg(not(feature = "nir1-material-diagnostics"))]
    let global_row_queries = DISCLOSURE_GLOBAL_ROWS_SQL.iter().map(|query| ((), query));
    for (_index, &(sql, multiplier, parameters)) in global_row_queries {
        if parameters != DisclosureGlobalRowsParams::Revision {
            continue;
        }
        #[cfg(feature = "nir1-material-diagnostics")]
        let started = start_a3_sql_timer(&observation);
        let value_query: rusqlite::Result<i64> =
            conn.query_row(sql, [revision_id], |row| row.get(0));
        #[cfg(feature = "nir1-material-diagnostics")]
        record_a3_sql_query(
            &mut observation,
            1 + _index as u8,
            started,
            value_query.is_err(),
        );
        admit_rows(&mut rows, value_query?, multiplier, remaining_rows)?;
    }
    #[cfg(feature = "nir1-material-diagnostics")]
    let started = start_a3_sql_timer(&observation);
    let material_rows_query: rusqlite::Result<(i64, i64, i64, i64)> = conn.query_row(
        DISCLOSURE_MATERIAL_ROWS_SQL,
        params![project, revision_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    );
    #[cfg(feature = "nir1-material-diagnostics")]
    record_a3_sql_query(&mut observation, 9, started, material_rows_query.is_err());
    let material_rows = material_rows_query?;
    for value in [
        material_rows.0,
        material_rows.1,
        material_rows.2,
        material_rows.3,
    ] {
        admit_rows(&mut rows, value, 1, remaining_rows)?;
    }
    let mut bytes = 0usize;
    #[cfg(feature = "nir1-material-diagnostics")]
    let global_byte_queries = DISCLOSURE_GLOBAL_BYTES_SQL.iter().enumerate();
    #[cfg(not(feature = "nir1-material-diagnostics"))]
    let global_byte_queries = DISCLOSURE_GLOBAL_BYTES_SQL.iter().map(|query| ((), query));
    for (_index, &(sql, multiplier, reads)) in global_byte_queries {
        if reads != DisclosureReads::PerRevision {
            continue;
        }
        #[cfg(feature = "nir1-material-diagnostics")]
        let started = start_a3_sql_timer(&observation);
        let value_query: rusqlite::Result<i64> =
            conn.query_row(sql, params![project, revision_id, ""], |row| row.get(0));
        #[cfg(feature = "nir1-material-diagnostics")]
        record_a3_sql_query(
            &mut observation,
            10 + _index as u8,
            started,
            value_query.is_err(),
        );
        let additional = usize::try_from(value_query?)
            .ok()
            .and_then(|value| value.checked_mul(multiplier))
            .ok_or_else(|| anyhow::anyhow!(ERROR))?;
        bytes = bytes
            .checked_add(additional)
            .filter(|value| *value <= byte_limit)
            .ok_or_else(|| anyhow::anyhow!(ERROR))?;
    }
    #[cfg(feature = "nir1-material-diagnostics")]
    let material_byte_queries = DISCLOSURE_MATERIAL_BYTES_SQL.iter().enumerate();
    #[cfg(not(feature = "nir1-material-diagnostics"))]
    let material_byte_queries = DISCLOSURE_MATERIAL_BYTES_SQL.iter().map(|sql| ((), sql));
    for (_index, sql) in material_byte_queries {
        #[cfg(feature = "nir1-material-diagnostics")]
        let started = start_a3_sql_timer(&observation);
        let value_query: rusqlite::Result<i64> =
            conn.query_row(sql, params![project, revision_id], |row| row.get(0));
        #[cfg(feature = "nir1-material-diagnostics")]
        record_a3_sql_query(
            &mut observation,
            18 + _index as u8,
            started,
            value_query.is_err(),
        );
        let value = value_query?;
        bytes = bytes
            .checked_add(usize::try_from(value).map_err(|_| anyhow::anyhow!(ERROR))?)
            .filter(|value| *value <= byte_limit)
            .ok_or_else(|| anyhow::anyhow!(ERROR))?;
    }
    Ok(DisclosureAdmission { rows, bytes })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DisclosureGlobalRowsParams {
    Project,
    ProjectScene,
    Revision,
}

const DISCLOSURE_GLOBAL_ROWS_SQL: &[(&str, usize, DisclosureGlobalRowsParams)] = &[
    (
        "SELECT COUNT(*) FROM tree_nodes WHERE project_id=?1",
        2,
        DisclosureGlobalRowsParams::Project,
    ),
    (
        "SELECT COALESCE(SUM(
                    1
                    + CASE WHEN json_valid(r.timeline_refs_json)
                           THEN COALESCE(json_array_length(r.timeline_refs_json), 0)
                           ELSE 0 END
                    + CASE WHEN json_valid(r.worldline_refs_json)
                           THEN COALESCE(json_array_length(r.worldline_refs_json), 0)
                           ELSE 0 END
                    + CASE WHEN json_valid(r.narrative_layer_refs_json)
                           THEN COALESCE(json_array_length(r.narrative_layer_refs_json), 0)
                           ELSE 0 END), 0)
           FROM narrative_scope_registries r WHERE r.project_id=?1",
        0,
        DisclosureGlobalRowsParams::Project,
    ),
    (
        "SELECT COUNT(*) FROM narrative_scene_scope_bindings
          WHERE project_id=?1",
        2,
        DisclosureGlobalRowsParams::Project,
    ),
    (
        "SELECT COUNT(*) FROM projects WHERE id=?1",
        1,
        DisclosureGlobalRowsParams::Project,
    ),
    (
        "SELECT COUNT(*) FROM tree_nodes
          WHERE project_id=?1 AND id=?2 AND node_type='scene'",
        1,
        DisclosureGlobalRowsParams::ProjectScene,
    ),
    (
        "SELECT COUNT(*) FROM codex_entries c
          JOIN tree_nodes t ON t.pov_character_id=c.id AND t.project_id=c.project_id
         WHERE t.project_id=?1 AND t.id=?2 AND t.node_type='scene'",
        1,
        DisclosureGlobalRowsParams::ProjectScene,
    ),
    (
        "SELECT COUNT(*) FROM (
             SELECT id FROM narrative_semantic_epochs
              WHERE project_id=?1 ORDER BY epoch_number DESC LIMIT 1
         )",
        1,
        DisclosureGlobalRowsParams::Project,
    ),
    (
        "SELECT COUNT(*) FROM narrative_proposal_decisions d
          JOIN narrative_proposal_revisions r
            ON r.id=d.revision_id AND r.proposal_id=d.proposal_id
         WHERE r.id=?1",
        1,
        DisclosureGlobalRowsParams::Revision,
    ),
];

// Materialize the admitted entity list once. Four independent json_each calls
// would repeatedly decode the same bounded Revision before A3 can run.
const DISCLOSURE_MATERIAL_ROWS_SQL: &str = "WITH material AS MATERIALIZED (
         SELECT json_extract(entity.value,'$.entityId') AS entity_id,
                json_extract(entity.value,'$.scope.pov') AS pov_id
           FROM narrative_proposal_revisions revision,
                json_each(CASE WHEN json_valid(revision.payload_json)
                     THEN CASE WHEN json_type(revision.payload_json, '$.bundle.entities')='array'
                          THEN json_extract(revision.payload_json, '$.bundle.entities') ELSE '[]' END
                     ELSE '[]' END) entity
          WHERE revision.id=?2 AND entity.type='object'
     ) SELECT
         (SELECT COUNT(*) FROM codex_entries c JOIN material m ON c.id=m.entity_id
           WHERE c.project_id=?1),
         (SELECT COUNT(*) FROM codex_entry_phases p JOIN codex_entries c ON c.id=p.entry_id
           JOIN material m ON c.id=m.entity_id WHERE c.project_id=?1),
         (SELECT COUNT(*) FROM foreshadow_codex_links link
           JOIN foreshadows f ON f.id=link.foreshadow_id
           JOIN material m ON m.entity_id=link.codex_entry_id WHERE f.project_id=?1),
         (SELECT COUNT(*) FROM codex_entries c JOIN material m ON c.id=m.pov_id
           WHERE c.project_id=?1)";

const DISCLOSURE_GLOBAL_BYTES_SQL: &[(&str, usize, DisclosureReads)] = &[
    ("WITH admission(value) AS (SELECT COALESCE(SUM(COALESCE(octet_length(t.id), 0) +
                COALESCE(octet_length(t.parent_id), 0) +
                COALESCE(octet_length(t.node_type), 0) +
                COALESCE(octet_length(t.sort_order), 0) +
                COALESCE(octet_length(t.story_time_order), 0) +
                COALESCE(octet_length(t.archived_at), 0) +
                COALESCE(octet_length(t.version), 0) +
                COALESCE(octet_length(t.updated_at), 0)), 0)
         FROM tree_nodes t WHERE t.project_id=?1) SELECT value FROM admission WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL", 2, DisclosureReads::Shared),
    ("WITH admission(value) AS (SELECT COALESCE(SUM(COALESCE(octet_length(r.registry_version), 0) +
                COALESCE(octet_length(r.timeline_refs_json), 0) +
                COALESCE(octet_length(r.worldline_refs_json), 0) +
                COALESCE(octet_length(r.narrative_layer_refs_json), 0) +
                2 * COALESCE(octet_length(r.source_token), 0) +
                COALESCE(octet_length(r.updated_at), 0)), 0)
         FROM narrative_scope_registries r WHERE r.project_id=?1) SELECT value FROM admission WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL", 0, DisclosureReads::Shared),
    ("WITH admission(value) AS (SELECT COALESCE(SUM(COALESCE(octet_length(b.scene_id), 0) +
                COALESCE(octet_length(b.scene_incarnation_id), 0) +
                COALESCE(octet_length(b.compatibility_marker), 0) +
                COALESCE(octet_length(b.query_identity_json), 0) +
                COALESCE(octet_length(b.material_constraint_json), 0) +
                COALESCE(octet_length(b.knowledge_holder_json), 0) +
                COALESCE(octet_length(b.audience_json), 0) +
                COALESCE(octet_length(b.source_token), 0) +
                COALESCE(octet_length(b.updated_at), 0)), 0)
         FROM narrative_scene_scope_bindings b WHERE b.project_id=?1) SELECT value FROM admission WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL", 2, DisclosureReads::Shared),
    ("WITH admission(value) AS (SELECT COALESCE(SUM(COALESCE(octet_length(p.phase_resolution_mode), 0)), 0)
         FROM projects p WHERE p.id=?1) SELECT value FROM admission WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL", 1, DisclosureReads::Shared),
    ("WITH admission(value) AS (SELECT COALESCE(SUM(COALESCE(octet_length(t.content), 0) +
                COALESCE(octet_length(t.updated_at), 0) +
                COALESCE(octet_length(t.archived_at), 0) +
                COALESCE(octet_length(t.pov_character_id), 0)), 0)
         FROM tree_nodes t WHERE t.project_id=?1 AND t.id=?3 AND t.node_type='scene') SELECT value FROM admission WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL", 1, DisclosureReads::Shared),
    ("WITH admission(value) AS (SELECT COALESCE(SUM(COALESCE(octet_length(c.type), 0)), 0)
         FROM codex_entries c JOIN tree_nodes t ON t.pov_character_id=c.id AND t.project_id=c.project_id WHERE t.project_id=?1 AND t.id=?3 AND t.node_type='scene') SELECT value FROM admission WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL", 1, DisclosureReads::Shared),
    ("WITH admission(value) AS (SELECT COALESCE(SUM(COALESCE(octet_length(e.id), 0) +
                COALESCE(octet_length(e.reason), 0) +
                COALESCE(octet_length(e.created_at), 0)), 0)
         FROM (SELECT id, reason, created_at FROM narrative_semantic_epochs WHERE project_id=?1 ORDER BY epoch_number DESC LIMIT 1) e ) SELECT value FROM admission WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL", 1, DisclosureReads::Shared),
    ("WITH admission(value) AS (SELECT COALESCE(SUM(COALESCE(octet_length(d.id), 0) +
                COALESCE(octet_length(d.decision), 0) +
                COALESCE(octet_length(d.decision_json), 0) +
                COALESCE(octet_length(d.created_at), 0) +
                COALESCE(octet_length(d.created_by), 0) +
                COALESCE(octet_length(d.actor_kind), 0) +
                COALESCE(octet_length(d.actor_id), 0) +
                COALESCE(octet_length(d.authority_scope), 0) +
                COALESCE(octet_length(d.override_field_paths_json), 0)), 0)
         FROM narrative_proposal_decisions d JOIN narrative_proposal_revisions r ON r.id=d.revision_id AND r.proposal_id=d.proposal_id WHERE r.id=?2) SELECT value FROM admission WHERE ?2 IS NOT NULL AND ?3 IS NOT NULL", 1, DisclosureReads::PerRevision),
];

const DISCLOSURE_MATERIAL_BYTES_SQL: &[&str] = &[
    "WITH material AS (
         SELECT entity.value FROM narrative_proposal_revisions revision,
              json_each(CASE WHEN json_valid(revision.payload_json)
                   THEN CASE WHEN json_type(revision.payload_json, '$.bundle.entities')='array'
                        THEN json_extract(revision.payload_json, '$.bundle.entities') ELSE '[]' END
                   ELSE '[]' END) entity
          WHERE revision.id=?2 AND entity.type='object') SELECT COALESCE(SUM(COALESCE(octet_length(c.context_mode), 0)), 0)
         FROM material m CROSS JOIN codex_entries c
         WHERE c.id=json_extract(m.value,'$.entityId') AND c.project_id=?1",
    "WITH material AS (
         SELECT entity.value FROM narrative_proposal_revisions revision,
              json_each(CASE WHEN json_valid(revision.payload_json)
                   THEN CASE WHEN json_type(revision.payload_json, '$.bundle.entities')='array'
                        THEN json_extract(revision.payload_json, '$.bundle.entities') ELSE '[]' END
                   ELSE '[]' END) entity
          WHERE revision.id=?2 AND entity.type='object') SELECT COALESCE(SUM(COALESCE(octet_length(p.id), 0) +
                COALESCE(octet_length(p.anchor_node_id), 0) +
                COALESCE(octet_length(p.label), 0) +
                COALESCE(octet_length(p.created_at), 0) +
                COALESCE(octet_length(p.context_mode_override), 0) +
                COALESCE(octet_length(p.version), 0)), 0)
         FROM codex_entry_phases p JOIN codex_entries c ON c.id=p.entry_id JOIN material m ON c.id=json_extract(m.value,'$.entityId') WHERE c.project_id=?1",
    "WITH material AS (
         SELECT entity.value FROM narrative_proposal_revisions revision,
              json_each(CASE WHEN json_valid(revision.payload_json)
                   THEN CASE WHEN json_type(revision.payload_json, '$.bundle.entities')='array'
                        THEN json_extract(revision.payload_json, '$.bundle.entities') ELSE '[]' END
                   ELSE '[]' END) entity
          WHERE revision.id=?2 AND entity.type='object') SELECT COALESCE(SUM(COALESCE(octet_length(c.context_mode), 0)), 0)
         FROM material m CROSS JOIN codex_entries c
         LEFT JOIN codex_entry_phases p ON p.entry_id=c.id
         WHERE c.id=json_extract(m.value,'$.entityId') AND c.project_id=?1",
    "WITH material AS (
         SELECT entity.value FROM narrative_proposal_revisions revision,
              json_each(CASE WHEN json_valid(revision.payload_json)
                   THEN CASE WHEN json_type(revision.payload_json, '$.bundle.entities')='array'
                        THEN json_extract(revision.payload_json, '$.bundle.entities') ELSE '[]' END
                   ELSE '[]' END) entity
          WHERE revision.id=?2 AND entity.type='object') SELECT COALESCE(SUM(COALESCE(octet_length(f.id), 0) +
                COALESCE(octet_length(f.payoff_scene_id), 0)), 0)
         FROM foreshadows f JOIN foreshadow_codex_links link ON link.foreshadow_id=f.id JOIN material m ON link.codex_entry_id=json_extract(m.value,'$.entityId') WHERE f.project_id=?1",
    "WITH material AS (
         SELECT entity.value FROM narrative_proposal_revisions revision,
              json_each(CASE WHEN json_valid(revision.payload_json)
                   THEN CASE WHEN json_type(revision.payload_json, '$.bundle.entities')='array'
                        THEN json_extract(revision.payload_json, '$.bundle.entities') ELSE '[]' END
                   ELSE '[]' END) entity
          WHERE revision.id=?2 AND entity.type='object') SELECT COALESCE(SUM(COALESCE(octet_length(c.type), 0)), 0)
         FROM material m CROSS JOIN codex_entries c
         WHERE c.id=json_extract(m.value,'$.scope.pov') AND c.project_id=?1"
];

#[cfg(test)]
mod disclosure_tests {
    use super::*;

    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE narrative_proposal_revisions (id TEXT, proposal_id TEXT, payload_json TEXT);
             INSERT INTO narrative_proposal_revisions VALUES ('r','p','{\"bundle\":{\"entities\":[{\"entityId\":\"entity\"}]}}');
             CREATE TABLE tree_nodes (id TEXT, project_id TEXT, parent_id TEXT, node_type TEXT,
                sort_order TEXT, story_time_order TEXT, archived_at TEXT, version INTEGER,
                updated_at TEXT, content TEXT, pov_character_id TEXT);
             INSERT INTO tree_nodes (id,project_id,node_type,content) VALUES ('scene','project','scene','{}');
             CREATE TABLE projects (id TEXT, phase_resolution_mode TEXT);
             INSERT INTO projects VALUES ('project','reading');
             CREATE TABLE narrative_scope_registries (project_id TEXT,registry_version TEXT,
                timeline_refs_json TEXT,worldline_refs_json TEXT,narrative_layer_refs_json TEXT,
                source_token TEXT,updated_at TEXT);
             INSERT INTO narrative_scope_registries (project_id,timeline_refs_json) VALUES ('project','[]');
             CREATE TABLE narrative_scene_scope_bindings (project_id TEXT,scene_id TEXT,
                scene_incarnation_id TEXT,compatibility_marker TEXT,query_identity_json TEXT,
                material_constraint_json TEXT,knowledge_holder_json TEXT,audience_json TEXT,
                source_token TEXT,updated_at TEXT);
             INSERT INTO narrative_scene_scope_bindings (project_id,scene_id,query_identity_json)
                VALUES ('project','scene','{}');
             CREATE TABLE codex_entries (id TEXT,project_id TEXT,type TEXT,context_mode TEXT);
             INSERT INTO codex_entries VALUES ('entity','project','character','auto');
             CREATE TABLE codex_entry_phases (id TEXT,entry_id TEXT,anchor_node_id TEXT,label TEXT,
                created_at TEXT,context_mode_override TEXT,version INTEGER);
             INSERT INTO codex_entry_phases (id,entry_id,label) VALUES ('phase','entity','label');
             CREATE TABLE foreshadows (id TEXT,project_id TEXT,payoff_scene_id TEXT);
             CREATE TABLE foreshadow_codex_links (foreshadow_id TEXT,codex_entry_id TEXT);
             CREATE TABLE narrative_semantic_epochs (id TEXT,project_id TEXT,epoch_number INTEGER,
                reason TEXT,created_at TEXT);
             CREATE TABLE narrative_proposal_decisions (id TEXT,proposal_id TEXT,revision_id TEXT,
                decision TEXT,decision_json TEXT,created_at TEXT,created_by TEXT,actor_kind TEXT,
                actor_id TEXT,authority_scope TEXT,override_field_paths_json TEXT);",
        ).unwrap();
        conn
    }

    #[test]
    fn material_context_bytes_preserve_duplicate_and_project_joins() {
        let conn = fixture();
        conn.execute(
            "UPDATE narrative_proposal_revisions SET payload_json=?1 WHERE id='r'",
            [r#"{"bundle":{"entities":[{"entityId":"entity"},{"entityId":"entity"},{"entityId":"foreign"},"entity"]}}"#],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO codex_entries VALUES ('foreign','other','character','hidden')",
            [],
        )
        .unwrap();
        let bytes: i64 = conn
            .query_row(
                DISCLOSURE_MATERIAL_BYTES_SQL[0],
                params!["project", "r"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(bytes, 2 * "auto".len() as i64);
    }

    #[test]
    fn material_context_bytes_preserve_left_join_phase_multiplicity() {
        let conn = fixture();
        conn.execute(
            "UPDATE narrative_proposal_revisions SET payload_json=?1 WHERE id='r'",
            [r#"{"bundle":{"entities":[{"entityId":"entity"},{"entityId":"entity"},{"entityId":"foreign"},"entity"]}}"#],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO codex_entry_phases (id,entry_id,label) VALUES ('phase2','entity','label');
             INSERT INTO codex_entries VALUES ('foreign','other','character','hidden');",
        )
        .unwrap();
        let counted = || -> i64 {
            conn.query_row(
                DISCLOSURE_MATERIAL_BYTES_SQL[2],
                params!["project", "r"],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(counted(), 4 * "auto".len() as i64); // 2 objects × 2 phases
        conn.execute("DELETE FROM codex_entry_phases", []).unwrap();
        assert_eq!(counted(), 2 * "auto".len() as i64); // LEFT JOIN retains unphased entries
        conn.execute(
            "UPDATE narrative_proposal_revisions SET payload_json='{bad' WHERE id='r'",
            [],
        )
        .unwrap();
        assert_eq!(counted(), 0);
    }

    #[test]
    fn material_pov_bytes_preserve_duplicate_and_project_joins() {
        let conn = fixture();
        conn.execute(
            "UPDATE narrative_proposal_revisions SET payload_json=?1 WHERE id='r'",
            [r#"{"bundle":{"entities":[{"scope":{"pov":"pov"}},{"scope":{"pov":"pov"}},{"scope":{"pov":"foreign"}},"pov"]}}"#],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO codex_entries VALUES ('pov','project','character','auto');
             INSERT INTO codex_entries VALUES ('foreign','other','character','auto');",
        )
        .unwrap();
        let counted = || -> i64 {
            conn.query_row(
                DISCLOSURE_MATERIAL_BYTES_SQL[4],
                params!["project", "r"],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(counted(), 2 * "character".len() as i64);
        conn.execute(
            "UPDATE narrative_proposal_revisions SET payload_json='{bad' WHERE id='r'",
            [],
        )
        .unwrap();
        assert_eq!(counted(), 0);
    }

    #[cfg(feature = "nir1-material-diagnostics")]
    #[test]
    fn observed_a3_keeps_admission_and_fixed_sql_slots() {
        let conn = fixture();
        let expected = preflight_disclosure(
            &conn,
            "project",
            "r",
            "scene",
            MAX_GRAPH_RECORDS,
            INPUT_BYTES,
        )
        .unwrap();
        let payload_bytes = 0;
        let mut observation = A3SqlObservation::default();
        let shared = preflight_project_reads_observed(
            &conn,
            "project",
            "scene",
            MAX_GRAPH_RECORDS,
            INPUT_BYTES,
            Some(&mut observation),
        )
        .unwrap();
        let own = preflight_disclosure_revision_observed(
            &conn,
            "project",
            "r",
            payload_bytes,
            shared.bytes,
            MAX_GRAPH_RECORDS - shared.rows,
            INPUT_BYTES - shared.bytes,
            Some(&mut observation),
        )
        .unwrap();
        assert_eq!(
            DisclosureAdmission {
                rows: shared.rows + own.rows,
                bytes: shared.bytes + own.bytes,
            },
            expected
        );
        // Slot 0 was the entity count that scaled the registry reads; the
        // registry is now charged for the reads it gets, so nothing runs there.
        assert!(observation.timings_ns[0].is_none());
        assert!(observation.timings_ns[1..].iter().all(Option::is_some));
        assert_eq!(observation.error_slot, None);
        assert_eq!(observation.overflow_mask, 0);

        conn.execute_batch("DROP TABLE narrative_scope_registries")
            .unwrap();
        let mut failed = A3SqlObservation::default();
        assert!(preflight_project_reads_observed(
            &conn,
            "project",
            "scene",
            MAX_GRAPH_RECORDS,
            INPUT_BYTES,
            Some(&mut failed),
        )
        .is_err());
        assert_eq!(failed.error_slot, Some(2));
        assert!(failed.timings_ns[0].is_none());
        assert!(failed.timings_ns[1..=2].iter().all(Option::is_some));
        assert!(failed.timings_ns[3..].iter().all(Option::is_none));

        let mut overflow = A3SqlObservation::default();
        overflow.record(22, u128::from(u64::MAX) + 1, true);
        assert_eq!(overflow.timings_ns[22], None);
        assert_eq!(overflow.error_slot, Some(22));
        assert_eq!(overflow.overflow_mask, 1 << 22);
        assert!(overflow.unattributed);
    }

    #[test]
    fn disclosure_admits_cumulative_inputs_and_bounds_body_phase_and_scope() {
        let conn = fixture();
        let admission = preflight_disclosure(
            &conn,
            "project",
            "r",
            "scene",
            MAX_GRAPH_RECORDS,
            INPUT_BYTES,
        )
        .unwrap();
        let bytes = admission.bytes;
        // 8 shared (tree 2, registry 2, bindings 2, project 1, query Scene 1)
        // + 1 entity + 1 phase of the Revision
        assert_eq!(admission.rows, 10);
        assert!(bytes > 0);
        let payload_bytes: usize = conn
            .query_row(
                "SELECT octet_length(payload_json) FROM narrative_proposal_revisions WHERE id='r'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
            .try_into()
            .unwrap();
        // The two parts a query charges, shared once and own per Revision,
        // add up to the Revision alone.
        let shared =
            preflight_project_reads(&conn, "project", "scene", MAX_GRAPH_RECORDS, INPUT_BYTES)
                .unwrap();
        let own = preflight_disclosure_revision(
            &conn,
            "project",
            "r",
            payload_bytes,
            shared.bytes,
            MAX_GRAPH_RECORDS - shared.rows,
            INPUT_BYTES - shared.bytes,
        )
        .unwrap();
        assert_eq!(
            DisclosureAdmission {
                rows: shared.rows + own.rows,
                bytes: shared.bytes + own.bytes,
            },
            admission
        );
        assert_eq!(
            preflight_disclosure_revision(
                &conn,
                "project",
                "r",
                INPUT_BYTES + 1,
                shared.bytes,
                MAX_GRAPH_RECORDS,
                INPUT_BYTES,
            )
            .unwrap_err()
            .to_string(),
            "NIR1_GRAPH_DISCLOSURE_INPUT_LIMIT"
        );
        assert_eq!(
            preflight_disclosure(&conn, "project", "r", "scene", admission.rows, bytes).unwrap(),
            admission
        );
        assert_eq!(
            preflight_disclosure(&conn, "project", "r", "scene", admission.rows, bytes - 1)
                .unwrap_err()
                .to_string(),
            "NIR1_GRAPH_DISCLOSURE_INPUT_LIMIT"
        );
        for sql in [
            "UPDATE tree_nodes SET content=?1",
            "UPDATE codex_entry_phases SET label=?1",
            "UPDATE narrative_scene_scope_bindings SET query_identity_json=?1",
        ] {
            let conn = fixture();
            conn.execute(sql, ["x".repeat(INPUT_BYTES + 1)]).unwrap();
            assert_eq!(
                preflight_disclosure(
                    &conn,
                    "project",
                    "r",
                    "scene",
                    MAX_GRAPH_RECORDS,
                    usize::MAX,
                )
                .unwrap_err()
                .to_string(),
                "NIR1_GRAPH_DISCLOSURE_INPUT_LIMIT"
            );
        }
    }

    // The per-Revision preflight (2 MiB) still covers what a Revision's check
    // sees: the shared project-level bytes and its own together. The shared
    // bytes are admitted to the query once, but each Revision's own bytes are
    // held to what they leave.
    #[test]
    fn a_revisions_own_bytes_share_the_per_revision_preflight_with_the_shared_ones() {
        let conn = fixture();
        let own = preflight_disclosure_revision(
            &conn,
            "project",
            "r",
            0,
            0,
            MAX_GRAPH_RECORDS,
            INPUT_BYTES,
        )
        .unwrap()
        .bytes;
        assert!(own > 0);
        let shared_at_the_cap = INPUT_BYTES - own;
        // Shared bytes that leave exactly the Revision's own: admitted.
        let admitted = preflight_disclosure_revision(
            &conn,
            "project",
            "r",
            0,
            shared_at_the_cap,
            MAX_GRAPH_RECORDS,
            INPUT_BYTES,
        )
        .unwrap();
        assert_eq!(admitted.bytes, own);
        // One shared byte more, and the same Revision no longer fits.
        assert_eq!(
            preflight_disclosure_revision(
                &conn,
                "project",
                "r",
                0,
                shared_at_the_cap + 1,
                MAX_GRAPH_RECORDS,
                INPUT_BYTES,
            )
            .unwrap_err()
            .to_string(),
            "NIR1_GRAPH_DISCLOSURE_INPUT_LIMIT"
        );
        // The query's own remaining budget caps it as well, independently.
        assert!(preflight_disclosure_revision(
            &conn,
            "project",
            "r",
            0,
            0,
            MAX_GRAPH_RECORDS,
            own - 1,
        )
        .is_err());
        // Shared bytes alone above the cap leave nothing for any Revision.
        assert!(preflight_disclosure_revision(
            &conn,
            "project",
            "r",
            0,
            INPUT_BYTES + 1,
            MAX_GRAPH_RECORDS,
            INPUT_BYTES,
        )
        .is_err());
    }

    // The two parts are disjoint: the shared part does not read the Revision,
    // and a Revision's part does not read the project.
    #[test]
    fn shared_and_revision_parts_read_disjoint_statements() {
        let conn = fixture();
        let shared =
            preflight_project_reads(&conn, "project", "scene", MAX_GRAPH_RECORDS, INPUT_BYTES)
                .unwrap();
        let own = preflight_disclosure_revision(
            &conn,
            "project",
            "r",
            0,
            0,
            MAX_GRAPH_RECORDS,
            INPUT_BYTES,
        )
        .unwrap();
        // The Revision changes: the shared part does not.
        conn.execute_batch(
            "UPDATE narrative_proposal_revisions SET payload_json='{\"bundle\":{\"entities\":[]}}' WHERE id='r';
             INSERT INTO narrative_proposal_decisions (id,proposal_id,revision_id,decision_json)
                VALUES ('d','p','r','{}');",
        )
        .unwrap();
        assert_eq!(
            preflight_project_reads(&conn, "project", "scene", MAX_GRAPH_RECORDS, INPUT_BYTES)
                .unwrap(),
            shared
        );
        // The project changes: the Revision's part does not.
        let revision_part = |conn: &Connection| {
            preflight_disclosure_revision(
                conn,
                "project",
                "r",
                0,
                0,
                MAX_GRAPH_RECORDS,
                INPUT_BYTES,
            )
            .unwrap()
        };
        let before = revision_part(&conn);
        assert_ne!(before, own, "the Revision's own rows changed");
        for index in 0..20 {
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type) VALUES (?1, 'project', 'note')",
                [format!("more-{index}")],
            )
            .unwrap();
        }
        assert_eq!(revision_part(&conn), before);
        assert_ne!(
            preflight_project_reads(&conn, "project", "scene", MAX_GRAPH_RECORDS, INPUT_BYTES)
                .unwrap(),
            shared
        );
    }

    #[test]
    fn disclosure_rejects_auxiliary_row_cardinality_before_materialization() {
        let conn = fixture();
        for index in 0..256 {
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type) VALUES (?1, 'project', 'note')",
                [format!("node-{index}")],
            )
            .unwrap();
        }
        assert_eq!(
            preflight_disclosure(
                &conn,
                "project",
                "r",
                "scene",
                MAX_GRAPH_RECORDS,
                INPUT_BYTES,
            )
            .unwrap_err()
            .to_string(),
            DISCLOSURE_ROW_LIMIT
        );
    }

    #[test]
    fn disclosure_material_counts_preserve_duplicate_entity_and_pov_joins() {
        let conn = fixture();
        conn.execute("UPDATE narrative_proposal_revisions SET payload_json=?1 WHERE id='r'", [
            r#"{"bundle":{"entities":[{"entityId":"entity","scope":{"pov":"entity"}},{"entityId":"entity","scope":{"pov":"entity"}}]}}"#,
        ]).unwrap();
        conn.execute("INSERT INTO foreshadows VALUES ('f','project',NULL)", [])
            .unwrap();
        conn.execute(
            "INSERT INTO foreshadow_codex_links VALUES ('f','entity')",
            [],
        )
        .unwrap();
        let admission = preflight_disclosure(
            &conn,
            "project",
            "r",
            "scene",
            MAX_GRAPH_RECORDS,
            INPUT_BYTES,
        )
        .unwrap();
        // 8 shared (tree 2, registry 2, bindings 2, project 1, query Scene 1)
        // + 2 each for entity, phase, link, POV of the Revision
        assert_eq!(admission.rows, 16);
        assert_eq!(
            preflight_disclosure(&conn, "project", "r", "scene", 15, INPUT_BYTES)
                .unwrap_err()
                .to_string(),
            DISCLOSURE_ROW_LIMIT
        );
    }

    #[test]
    fn disclosure_rejects_unbounded_material_phase_rows() {
        let conn = fixture();
        for index in 0..512 {
            conn.execute(
                "INSERT INTO codex_entry_phases (id, entry_id, label) VALUES (?1, 'entity', 'label')",
                [format!("phase-{index}")],
            )
            .unwrap();
        }
        assert_eq!(
            preflight_disclosure(
                &conn,
                "project",
                "r",
                "scene",
                MAX_GRAPH_RECORDS,
                INPUT_BYTES,
            )
            .unwrap_err()
            .to_string(),
            DISCLOSURE_ROW_LIMIT
        );
    }
}

#[cfg(test)]
mod plan_tests {
    use super::*;

    // CQ-2: these charges read the seed Revision's Decisions. They must seek
    // SCHEMA 42's Revision index: a scan follows every workspace Decision, and
    // the Proposal index would also read the seed Proposal's other Revisions.
    const REVISION_DECISION_CHARGES: &[&str] =
        &["A2 length", "A3 global rows 7", "A3 global bytes 7"];
    const REVISION_DECISION_SEEK: &str =
        "INDEX idx_narrative_decisions_revision_proposal (revision_id=?";

    fn a2_a3_statements() -> Vec<(String, &'static str)> {
        let mut statements = vec![
            ("A2 length".to_owned(), LENGTH_SQL),
            ("A2 count".to_owned(), COUNT_SQL),
            ("A3 material rows".to_owned(), DISCLOSURE_MATERIAL_ROWS_SQL),
        ];
        statements.extend(
            RELATED_BYTES_SQL
                .iter()
                .enumerate()
                .map(|(index, sql)| (format!("A2 related {index}"), *sql)),
        );
        statements.extend(
            DISCLOSURE_GLOBAL_ROWS_SQL
                .iter()
                .enumerate()
                .map(|(index, query)| (format!("A3 global rows {index}"), query.0)),
        );
        statements.extend(
            DISCLOSURE_GLOBAL_BYTES_SQL
                .iter()
                .enumerate()
                .map(|(index, query)| (format!("A3 global bytes {index}"), query.0)),
        );
        statements.extend(
            DISCLOSURE_MATERIAL_BYTES_SQL
                .iter()
                .enumerate()
                .map(|(index, sql)| (format!("A3 material bytes {index}"), *sql)),
        );
        statements
    }

    fn query_plan(conn: &Connection, sql: &str) -> Vec<String> {
        let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let parameters = statement.parameter_count();
        statement
            .query_map(
                rusqlite::params_from_iter(std::iter::repeat_n("x", parameters)),
                |row| row.get::<_, String>(3),
            )
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    /// Plan lines that would let an unrelated workspace row change the cost.
    fn plan_violations(label: &str, sql: &str, plan: &[String]) -> Vec<String> {
        let mut violations = plan
            .iter()
            .filter(|line| line.contains("TEMP B-TREE") || line.contains("AUTOMATIC"))
            .cloned()
            .collect::<Vec<_>>();
        // Only one-row subqueries and the bounded Revision's json_each may be
        // scanned.
        let mut derived = plan
            .iter()
            .filter_map(|line| {
                line.strip_prefix("CO-ROUTINE ")
                    .or_else(|| line.strip_prefix("MATERIALIZE "))
            })
            .collect::<Vec<_>>();
        if derived.contains(&"material") {
            derived.push("m");
        }
        for line in plan {
            let Some(scanned) = line.strip_prefix("SCAN ") else {
                continue;
            };
            if !(scanned.contains(" VIRTUAL TABLE ")
                || scanned == "CONSTANT ROW"
                || derived.contains(&scanned.split(' ').next().unwrap()))
            {
                violations.push(line.clone());
            }
        }
        let decision_seeks = plan
            .iter()
            .filter(|line| {
                line.starts_with("SEARCH d USING ") && line.contains(REVISION_DECISION_SEEK)
            })
            .count();
        if decision_seeks != usize::from(REVISION_DECISION_CHARGES.contains(&label)) {
            violations.push(format!("Revision index Decision seeks: {decision_seeks}"));
        }
        // JSON1 expansion is only allowed over the one seed Revision.
        if sql.contains("narrative_proposal_revisions")
            && !plan
                .iter()
                .any(|line| line.contains("sqlite_autoindex_narrative_proposal_revisions_1 (id=?)"))
        {
            violations.push("Revision is not sought by id".to_owned());
        }
        violations
    }

    // Same method as candidates.rs: inspect the current-schema plan instead
    // of trusting row counts from a small fixture.
    #[test]
    fn a2_a3_plans_seek_the_seed_revision_without_table_scans_or_temp_sorts() {
        let db = crate::Database::new(std::path::Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db.with_conn(|conn| {
            let statements = a2_a3_statements();
            assert_eq!(statements.len(), 3 + 10 + 8 + 8 + 5);
            for (label, sql) in &statements {
                let plan = query_plan(conn, sql);
                let violations = plan_violations(label, sql, &plan);
                assert!(
                    violations.is_empty(),
                    "{label}: {violations:?}\n{}",
                    plan.join("\n")
                );
            }
            // Negative controls on the same schema: each regression is reported.
            for (label, sql, expected) in [
                (
                    "negative control",
                    "SELECT COUNT(*) FROM narrative_proposal_decisions d WHERE d.decision=?1",
                    vec!["SCAN d"],
                ),
                (
                    "A2 length",
                    "SELECT COUNT(*) FROM narrative_proposal_decisions d WHERE d.proposal_id=?1",
                    vec!["Revision index Decision seeks: 0"],
                ),
                (
                    "negative control",
                    "SELECT COUNT(*) FROM narrative_proposal_revisions v, json_each(v.payload_json)",
                    vec!["SCAN v", "Revision is not sought by id"],
                ),
                (
                    "negative control",
                    "SELECT t.id FROM tree_nodes t WHERE t.project_id=?1 ORDER BY t.content",
                    vec!["USE TEMP B-TREE FOR ORDER BY"],
                ),
            ] {
                assert_eq!(
                    plan_violations(label, sql, &query_plan(conn, sql)),
                    expected,
                    "{sql}"
                );
            }
            Ok(())
        })
        .unwrap();
    }
}

// CQ-OPT (J): the Relation byte count joins the Revision's payload entries to
// `codex_relations` by primary key. These tests fix that it counts exactly the
// pairs it counted before, and that its cost no longer follows the number of
// Relations in the project.
#[cfg(test)]
mod relation_bytes_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    const PROJECT: &str = "p1";
    const REVISION: &str = "revision";
    const UPDATED_AT: &str = "2026-09-12T00:00:00Z";

    /// The migrated schema, so the primary key and the project index are the
    /// production ones. Foreign keys are off: only the two tables the statement
    /// reads are filled.
    fn migrated() -> crate::Database {
        let db = crate::Database::new(std::path::Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db.with_conn(|conn| {
            conn.execute_batch("PRAGMA foreign_keys=OFF")?;
            Ok(())
        })
        .unwrap();
        db
    }

    /// Insert a Relation and return the bytes the statement counts for it.
    fn add_relation(conn: &Connection, project: &str, id: &str) -> i64 {
        let from = format!("from-of-{id}");
        let to = format!("to-of-{id}");
        conn.execute(
            "INSERT INTO codex_relations
                (id, project_id, from_codex_id, to_codex_id, relation_type,
                 directionality, version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'knows', 'directed', 7, ?5, ?5)",
            params![id, project, from, to, UPDATED_AT],
        )
        .unwrap();
        // `version` is the one-digit integer 7, counted by its text rendering.
        [id, &from, &to, "knows", "directed", "7", UPDATED_AT]
            .iter()
            .map(|value| value.len() as i64)
            .sum()
    }

    fn set_payload(conn: &Connection, payload: &str) {
        conn.execute(
            "INSERT OR REPLACE INTO narrative_proposal_revisions
                (id, proposal_id, revision_number, payload_json, created_at, created_by)
             VALUES (?1, 'proposal', 1, ?2, ?3, 'test')",
            params![REVISION, payload, UPDATED_AT],
        )
        .unwrap();
    }

    fn payload_naming(edge_ids: impl IntoIterator<Item = String>) -> String {
        serde_json::json!({
            "bundle": {
                "relations": edge_ids
                    .into_iter()
                    .map(|edge_id| serde_json::json!({ "edgeId": edge_id }))
                    .collect::<Vec<_>>(),
            }
        })
        .to_string()
    }

    fn relation_bytes(conn: &Connection, sql: &str, revision: &str) -> i64 {
        conn.query_row(sql, params![PROJECT, revision], |row| row.get(0))
            .unwrap()
    }

    /// VM steps of one statement, counted per instruction like the Graph budget.
    fn steps_of(conn: &Connection, sql: &str) -> (i64, u64) {
        let steps = Arc::new(AtomicU64::new(0));
        let counter = Arc::clone(&steps);
        crate::set_sqlite_progress_handler(
            conn,
            1,
            Some(move || {
                counter.fetch_add(1, Ordering::Relaxed);
                false
            }),
        )
        .unwrap();
        let value = relation_bytes(conn, sql, REVISION);
        crate::set_sqlite_progress_handler(conn, 0, None::<fn() -> bool>).unwrap();
        (value, steps.load(Ordering::Relaxed))
    }

    #[test]
    fn relation_bytes_count_the_same_pairs_as_the_project_wide_join() {
        let db = migrated();
        db.with_conn(|conn| {
            let mut sizes = std::collections::BTreeMap::new();
            for id in ["e1", "e2", "e3", "7", "日本", "kebab-case_ID"] {
                sizes.insert(id, add_relation(conn, PROJECT, id));
            }
            // Named by the payload but owned by another project.
            add_relation(conn, "other", "foreign");
            let many_e1 = payload_naming(std::iter::repeat_n("e1".to_owned(), 50));
            // (case, payload, the Relations counted, one per payload entry)
            let cases: Vec<(&str, String, Vec<&str>)> = vec![
                ("empty array", r#"{"bundle":{"relations":[]}}"#.into(), vec![]),
                (
                    "each Relation once",
                    r#"{"bundle":{"relations":[{"edgeId":"e1"},{"edgeId":"e2"},{"edgeId":"e3"}]}}"#
                        .into(),
                    vec!["e1", "e2", "e3"],
                ),
                (
                    "a repeated edge is counted once per entry",
                    r#"{"bundle":{"relations":[{"edgeId":"e1"},{"edgeId":"e2"},{"edgeId":"e1"}]}}"#
                        .into(),
                    vec!["e1", "e1", "e2"],
                ),
                (
                    "absent and foreign-project edges add nothing",
                    r#"{"bundle":{"relations":[{"edgeId":"missing"},{"edgeId":"foreign"},{"edgeId":"e3"}]}}"#
                        .into(),
                    vec!["e3"],
                ),
                (
                    "only object entries name an edge",
                    r#"{"bundle":{"relations":["e1",7,null,[],true,{"noEdge":"e1"},{"edgeId":null},{"edgeId":["e1"]},{"edgeId":{"id":"e1"}},{"edgeId":"e2","extra":1}]}}"#
                        .into(),
                    vec!["e2"],
                ),
                (
                    "a numeric edge id meets a TEXT id through column affinity",
                    r#"{"bundle":{"relations":[{"edgeId":7},{"edgeId":7.0},{"edgeId":"7"}]}}"#
                        .into(),
                    vec!["7", "7"],
                ),
                (
                    "non-ASCII edge ids",
                    r#"{"bundle":{"relations":[{"edgeId":"日本"},{"edgeId":"kebab-case_ID"}]}}"#
                        .into(),
                    vec!["日本", "kebab-case_ID"],
                ),
                ("fifty entries naming one Relation", many_e1, vec!["e1"; 50]),
                (
                    "relations is an object",
                    r#"{"bundle":{"relations":{"edgeId":"e1"}}}"#.into(),
                    vec![],
                ),
                (
                    "relations is a string",
                    r#"{"bundle":{"relations":"e1"}}"#.into(),
                    vec![],
                ),
                ("no relations", r#"{"bundle":{}}"#.into(), vec![]),
                ("no bundle", "{}".into(), vec![]),
                ("bundle is null", r#"{"bundle":null}"#.into(),
                 vec![]),
                ("not JSON", "not json".into(), vec![]),
                ("empty payload", String::new(), vec![]),
            ];
            for (case, payload, counted) in &cases {
                set_payload(conn, payload);
                let legacy = relation_bytes(conn, LEGACY_RELATION_BYTES_SQL, REVISION);
                let current = relation_bytes(conn, RELATION_BYTES_SQL, REVISION);
                let expected: i64 = counted.iter().map(|id| sizes[id]).sum();
                assert_eq!(legacy, expected, "{case}: the oracle counts the pairs");
                assert_eq!(current, legacy, "{case}");
            }
            // A Revision that does not exist adds nothing in either form.
            assert_eq!(relation_bytes(conn, LEGACY_RELATION_BYTES_SQL, "absent"), 0);
            assert_eq!(relation_bytes(conn, RELATION_BYTES_SQL, "absent"), 0);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn relation_bytes_cost_follows_the_payload_not_the_project() {
        const PAYLOAD: usize = 10;
        let db = migrated();
        db.with_conn(|conn| {
            set_payload(
                conn,
                &payload_naming((0..PAYLOAD).map(|index| format!("rel-{index:04}"))),
            );
            let mut project = 0;
            let mut measured = Vec::new();
            for size in [10usize, 100, 1_000] {
                while project < size {
                    add_relation(conn, PROJECT, &format!("rel-{project:04}"));
                    project += 1;
                }
                let (current, current_steps) = steps_of(conn, RELATION_BYTES_SQL);
                let (legacy, legacy_steps) = steps_of(conn, LEGACY_RELATION_BYTES_SQL);
                assert_eq!(current, legacy, "{size} project Relations");
                measured.push((size, current_steps, legacy_steps));
            }
            let [(_, small, legacy_small), (_, medium, _), (_, large, legacy_large)] =
                measured.as_slice()
            else {
                unreachable!("three sizes");
            };
            // The payload names the same ten Relations at every size.
            assert_eq!(small, medium);
            assert_eq!(small, large);
            // The oracle shows what the statement used to cost: its steps
            // follow the product of the project's and the payload's counts.
            assert!(legacy_large > &(legacy_small * 20), "{measured:?}");
            assert!(legacy_large > &(large * 20), "{measured:?}");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn relation_bytes_cost_is_linear_in_the_payload_relations() {
        let db = migrated();
        db.with_conn(|conn| {
            for index in 0..1_000 {
                add_relation(conn, PROJECT, &format!("rel-{index:04}"));
            }
            let mut steps = Vec::new();
            for count in [10usize, 70, 144] {
                set_payload(
                    conn,
                    &payload_naming((0..count).map(|index| format!("rel-{index:04}"))),
                );
                steps.push((count as u64, steps_of(conn, RELATION_BYTES_SQL).1));
            }
            let [(n10, s10), (n70, s70), (n144, s144)] = steps.as_slice() else {
                unreachable!("three sizes");
            };
            // The same cost per payload Relation across the whole range.
            assert_eq!(
                (s70 - s10) * (n144 - n70),
                (s144 - s70) * (n70 - n10),
                "{steps:?}"
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn the_test_switch_puts_back_only_the_relation_byte_count() {
        let current = related_bytes_sql();
        assert_eq!(current.last().copied(), Some(RELATION_BYTES_SQL));
        with_legacy_relation_bytes(|| {
            let legacy = related_bytes_sql();
            assert_eq!(legacy.len(), current.len());
            assert_eq!(legacy.last().copied(), Some(LEGACY_RELATION_BYTES_SQL));
            assert_eq!(legacy[..legacy.len() - 1], current[..current.len() - 1]);
        });
        assert_eq!(
            related_bytes_sql().last().copied(),
            Some(RELATION_BYTES_SQL)
        );
    }

    fn plan_of(conn: &Connection, sql: &str) -> Vec<String> {
        let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let parameters = statement.parameter_count();
        statement
            .query_map(
                rusqlite::params_from_iter(std::iter::repeat_n("x", parameters)),
                |row| row.get::<_, String>(3),
            )
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    #[test]
    fn relation_bytes_plan_looks_up_each_payload_edge_by_primary_key() {
        let db = migrated();
        db.with_conn(|conn| {
            let current = plan_of(conn, RELATION_BYTES_SQL);
            assert!(
                current
                    .iter()
                    .any(|line| line
                        == "SEARCH e USING INDEX sqlite_autoindex_codex_relations_1 (id=?)"),
                "{current:?}"
            );
            assert!(
                !current
                    .iter()
                    .any(|line| line.contains("idx_codex_relations_project")
                        || line.starts_with("SCAN e")),
                "{current:?}"
            );
            // Negative control: the statement before CQ-OPT put the project's
            // Relations in the outer loop.
            let legacy = plan_of(conn, LEGACY_RELATION_BYTES_SQL);
            assert!(
                legacy
                    .iter()
                    .any(|line| line.contains("idx_codex_relations_project")),
                "{legacy:?}"
            );
            Ok(())
        })
        .unwrap();
    }
}
