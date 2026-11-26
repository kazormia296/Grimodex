//! Maintenance Inbox Read Model (Gate C2 Wave 2 Lane O).
//!
//! This module writes nothing. It assembles a display-ready view of "what
//! Maintenance work is currently outstanding" purely by reading rows other
//! Lanes already own:
//!
//! - [`semantic_epoch::get_current_epoch`] (Lane A) -- which Semantic Epoch
//!   is current, so stale (prior-epoch) diagnostic detail can be excluded.
//! - `narrative_consumer_freshness` (Lane J's `publish_runtime`, the sole
//!   durable Freshness authority) -- the current Freshness / Build Action
//!   per Consumer. [`list_consumer_freshness`] is this module's own read of
//!   that table; nothing else in this module writes to it.
//! - [`finding_observation::list_observations_for_epoch`] (Lane C) --
//!   diagnostic detail for *why* a Consumer is in its current state, scoped
//!   to the current Semantic Epoch only.
//! - [`attention::get_attention`] / [`attention::is_attention_applicable`]
//!   (Lane D) -- a human's durable disposition toward a finding, and the
//!   pure (no-DB) computation of whether that disposition still applies.
//!
//! ## `finding_key` convention
//!
//! Every Lane keyed off `finding_key` (`publish_runtime`'s diagnostic
//! Finding Observation writer, `attention`'s durable disposition store,
//! this Read Model) treats it as an opaque string, so they only agree if
//! they all derive it the same way. They do not derive it at all any more:
//! `consumer_identity::consumer_finding_key` is the single implementation
//! and this module imports it.
//!
//! ```text
//! finding_key = "{consumer_kind}:{consumer_key}"
//! ```
//!
//! The grain is the **Consumer** -- `narrative_consumer_freshness`'s own
//! primary-key grain, `(project_id, consumer_kind, consumer_key)`. A
//! Consumer may aggregate several Edges behind one rolled-up Freshness
//! value (`publish_runtime::freshness_severity_rank`), and the Inbox
//! surfaces that rolled-up unit, not individual Edges.
//!
//! This module used to mint its own copy, and `publish_runtime` used to
//! mint a *per-Edge* one (`edge:{edge_id}`). Nothing errored when they
//! disagreed -- the Observations simply failed to match, and every
//! diagnostic Finding became invisible to the Inbox. Gate C2-2 collapsed
//! both onto one function for that reason; see `consumer_identity.rs`.
//!
//! The key is stable across repeated evaluations of the same Consumer
//! (`consumer_kind`/`consumer_key` never change once a Consumer exists) and
//! is used as the lookup key against both `list_observations_for_epoch` and
//! `get_attention` in [`build_maintenance_inbox`] below.
//!
//! ## Snooze expiry ("resurfacing") rule
//!
//! An Attention row is never mutated or deleted by a read (`attention.rs`'s
//! own contract, enforced again by this module's
//! `build_maintenance_inbox_never_mutates_attention_rows` test below).
//! Instead, expiry is applied purely at read time, per entry:
//!
//! - `disposition == Snoozed` and still applicable for every currently active
//!   Finding identity under the Consumer
//!   ([`attention::is_attention_applicable`] returns `true`, i.e. the
//!   Attention row's `material_basis_digest` still matches the current
//!   evidence *and* `snoozed_until` is still in the future) -- the Consumer
//!   is **excluded** from the returned Vec entirely. A Consumer with another
//!   active Edge/Finding that the Attention row does not exactly cover stays
//!   visible; a snooze must not broaden from one Edge to its siblings.
//! - `disposition == Snoozed` but no longer applicable (`snoozed_until` has
//!   lapsed, or the material basis moved out from under it) -- the Consumer
//!   is **included**, `is_snoozed_and_active` is `false`, and `attention`
//!   still carries the (unmutated) row so the UI can show it was
//!   previously snoozed.
//! - `disposition` is `Dismissed` or `Flagged` -- these are *never* part of
//!   this hide/show decision. A human recording either of those is
//!   expressing a judgment about the finding (I've seen it, and I dismiss
//!   it / I'm flagging it), not asking to have it removed from view the way
//!   a snooze timer does; hiding it would erase that judgment from the
//!   Inbox instead of surfacing it as context. Both are always **included**
//!   with `is_snoozed_and_active: false` and `attention` set to the stored
//!   row, letting the UI layer decide how to render the disposition (e.g. a
//!   "dismissed" badge) rather than this Read Model silently omitting rows.
//!
//! The `current_material_basis_digest` fed into
//! `is_attention_applicable` for a Snoozed row is taken only from the current
//! epoch's Finding Observation whose `finding_identity` exactly matches the
//! Attention row's resolved identity. A later Observation for another Edge
//! under the same Consumer finding key is not evidence about this Attention.
//! If the row is unresolved or no identity-matching Observation exists in the
//! current epoch, applicability is false and the entry resurfaces; the read
//! model never falls back to comparing the Attention digest with itself.
//!
//! ## Epoch invalidation
//!
//! [`build_maintenance_inbox`] looks up the current Semantic Epoch once
//! ([`semantic_epoch::get_current_epoch`]) and passes only that epoch's id
//! into every [`finding_observation::list_observations_for_epoch`] call.
//! `list_observations_for_epoch` itself filters by
//! `semantic_epoch_id = ?2` (see `finding_observation.rs`), so a Finding
//! Observation recorded under a now-superseded epoch (e.g. before a
//! restore/migration rotated to a new one, `semantic_epoch.rs`'s
//! `VALID_REASONS`) is never returned once that rotation has happened --
//! this is the entire invalidation mechanism, no separate bookkeeping is
//! required. When a project has no Semantic Epoch at all yet (a project
//! that predates any Freshness evaluation), [`build_maintenance_inbox`]
//! returns an empty Vec rather than guessing: `narrative_consumer_freshness`
//! rows cannot exist without a Semantic Epoch anyway (`semantic_epoch_id`
//! is `NOT NULL REFERENCES narrative_semantic_epochs(id)`), so there is
//! nothing to show.

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

use super::attention::{
    get_attention, is_attention_applicable, AttentionDisposition, AttentionRow,
};
use super::consumer_identity::{
    consumer_finding_key, CONTRACT_CONSUMER_KINDS, PROPOSAL_REVISION_CONSUMER_KIND,
};
use super::evaluator::{BuildAction, EvidenceFreshness};
use super::finding_observation::{
    latest_finding_lifecycle_for_identity, latest_terminal_failure_lifecycle_for_identity,
    latest_terminal_failure_observation_order, list_observations_for_epoch,
    list_terminal_failure_finding_keys_for_epoch, FindingLifecycleState, FindingObservationRow,
};
use super::semantic_epoch::get_current_epoch;
use super::terminal_failure::TERMINAL_FAILURE_CONSUMER_KIND;

const STALE_PROPOSAL_CONSUMER_PREDICATE: &str = "f.consumer_kind = 'proposal-revision'
    AND f.evidence_freshness IN
        ('stale', 'source-missing', 'anchor-mismatch', 'read-set-drift', 'unknown')";
const EXCLUDED_PROPOSAL_REVISION_PREDICATE: &str = "EXISTS (
        SELECT 1
          FROM narrative_proposal_revisions r
          JOIN narrative_proposals p ON p.id = r.proposal_id
          JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
         WHERE r.id = f.consumer_key
           AND s.project_id = f.project_id
           AND (p.status = 'rejected'
                OR (p.current_revision_id IS NOT NULL AND p.current_revision_id <> r.id))
    )";
const STALE_PROPOSAL_SCENES_PAGE_DEFAULT: u64 = 50;
const STALE_PROPOSAL_SCENES_PAGE_MAX: u64 = 200;

/// Identifies which read authority produced an Inbox entry. Terminal failure
/// entries are Observation/lifecycle projections, not Consumer Freshness
/// rows, so they deliberately carry no freshness or build-action value.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InboxEntryKind {
    ConsumerFreshness,
    TerminalFailure,
}

/// One `narrative_consumer_freshness` row exactly as stored -- the current
/// Freshness authority (see module docs). A pure read; this function never
/// writes to the table.
#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) struct ConsumerFreshnessRow {
    pub consumer_kind: String,
    pub consumer_key: String,
    pub evidence_freshness: EvidenceFreshness,
    pub build_action: BuildAction,
    pub semantic_epoch_id: String,
    pub last_evaluated_run_id: Option<String>,
    pub updated_at: String,
}

/// Read every `narrative_consumer_freshness` row for `project_id`, ordered
/// deterministically by `(consumer_kind, consumer_key)`. This is a direct,
/// unfiltered read of the sole Freshness authority -- see the module doc
/// for why nothing else here reads Finding Observation snapshots as a
/// stand-in for current Freshness.
pub(crate) fn list_consumer_freshness(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Vec<ConsumerFreshnessRow>> {
    let mut statement = conn.prepare(
        "SELECT consumer_kind, consumer_key, evidence_freshness, build_action,
                semantic_epoch_id, last_evaluated_run_id, updated_at
           FROM narrative_consumer_freshness
          WHERE project_id = ?1
          ORDER BY consumer_kind ASC, consumer_key ASC",
    )?;
    let raw_rows = statement
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    raw_rows
        .into_iter()
        .map(
            |(
                consumer_kind,
                consumer_key,
                evidence_freshness,
                build_action,
                semantic_epoch_id,
                last_evaluated_run_id,
                updated_at,
            )| {
                Ok(ConsumerFreshnessRow {
                    consumer_kind,
                    consumer_key,
                    evidence_freshness: EvidenceFreshness::try_from(evidence_freshness.as_str())?,
                    build_action: BuildAction::try_from(build_action.as_str())?,
                    semantic_epoch_id,
                    last_evaluated_run_id,
                    updated_at,
                })
            },
        )
        .collect::<anyhow::Result<Vec<_>>>()
}

/// One assembled Maintenance Inbox row -- everything the Inbox UI needs for
/// a single Consumer, joined from four independently-owned tables at read
/// time. See the module doc for the `finding_key` convention and the
/// snooze-resurfacing rule that decides which Consumers make it into the
/// returned Vec at all.
///
/// `pub`: this is [`build_maintenance_inbox`]'s return type, called
/// directly from `grimodex-node`'s `narrative_maintenance_inbox_list`
/// N-API binding (C2-T1).
#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct InboxEntry {
    pub entry_kind: InboxEntryKind,
    pub consumer_kind: String,
    pub consumer_key: String,
    pub evidence_freshness: Option<String>,
    pub build_action: Option<String>,
    pub finding_key: String,
    pub latest_observation: Option<FindingObservationRow>,
    pub attention: Option<AttentionRow>,
    pub is_snoozed_and_active: bool,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleProposalSceneCount {
    pub scene_id: String,
    pub proposal_count: u64,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleProposalScenesPage {
    pub scenes: Vec<StaleProposalSceneCount>,
    pub without_scene_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub struct StaleProposalBreakdown {
    pub stale: u64,
    pub source_missing: u64,
    pub anchor_mismatch: u64,
    pub read_set_drift: u64,
    pub unknown: u64,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceHealthSummary {
    pub proposals_checked: u64,
    pub proposals_stale: u64,
    pub stale_breakdown: StaleProposalBreakdown,
    pub maintenance_stopped: u64,
    pub unrecognized: u64,
}

#[derive(Debug, Default)]
struct FreshnessSummaryCounts {
    fresh: u64,
    stale: u64,
    source_missing: u64,
    anchor_mismatch: u64,
    read_set_drift: u64,
    unknown: u64,
    unrecognized: u64,
}

impl FreshnessSummaryCounts {
    fn stale_total(&self) -> u64 {
        self.stale + self.source_missing + self.anchor_mismatch + self.read_set_drift + self.unknown
    }

    fn into_summary(self, maintenance_stopped: u64) -> MaintenanceHealthSummary {
        let proposals_stale = self.stale_total();
        MaintenanceHealthSummary {
            proposals_checked: self.fresh + proposals_stale,
            proposals_stale,
            stale_breakdown: StaleProposalBreakdown {
                stale: self.stale,
                source_missing: self.source_missing,
                anchor_mismatch: self.anchor_mismatch,
                read_set_drift: self.read_set_drift,
                unknown: self.unknown,
            },
            maintenance_stopped,
            unrecognized: self.unrecognized,
        }
    }
}

/// Return the latest current-epoch observation for each Finding identity that
/// is still active, plus the latest display candidate in the original
/// observation order. Finding Observations are append-only history, so an
/// older observation for an Edge must not keep a Consumer visible after its
/// latest lifecycle transition resolved that Finding. Resolution must belong
/// to the same Semantic Epoch and be at least as new as the Observation;
/// otherwise a newer Observation without its expected lifecycle row would be
/// hidden by stale evidence. A missing or stale lifecycle row is treated as
/// active (fail-open): the Inbox must not hide a Finding when the state needed
/// to prove resolution is absent. Legacy observations without an identity
/// remain display candidates and are reported separately for the same reason;
/// no exact Attention row can cover them.
fn active_finding_observations<'a>(
    conn: &Connection,
    project_id: &str,
    observations: &'a [FindingObservationRow],
) -> anyhow::Result<(
    Vec<&'a FindingObservationRow>,
    bool,
    Option<&'a FindingObservationRow>,
)> {
    let mut observations_by_identity: BTreeMap<String, Vec<&FindingObservationRow>> =
        BTreeMap::new();
    let mut has_unresolved_identity = false;

    for observation in observations {
        let Some(finding_identity) = observation.finding_identity.as_deref() else {
            has_unresolved_identity = true;
            continue;
        };
        observations_by_identity
            .entry(finding_identity.to_string())
            .or_default()
            .push(observation);
    }

    let mut active_observations = Vec::with_capacity(observations_by_identity.len());
    for (finding_identity, candidates) in observations_by_identity {
        let is_terminal = candidates.iter().any(|observation| {
            observation.rule_id == super::finding_identity::MAINTENANCE_FAILURE_FINDING_RULE_ID
        });
        let observation = if is_terminal {
            anyhow::ensure!(
                candidates.iter().all(|candidate| {
                    candidate.rule_id
                        == super::finding_identity::MAINTENANCE_FAILURE_FINDING_RULE_ID
                }),
                "NEX_FINDING_OBSERVATION_RULE_COLLISION: terminal identity has a non-terminal observation"
            );
            let candidate = candidates[0];
            let Some((latest_observed_at, latest_basis)) =
                latest_terminal_failure_observation_order(
                    conn,
                    project_id,
                    &candidate.semantic_epoch_id,
                    &finding_identity,
                    &candidate.finding_key,
                    &candidate.rule_id,
                    candidate.rule_version,
                )?
            else {
                anyhow::bail!(
                    "NEX_FINDING_OBSERVATION_ORDER_MISSING: terminal identity has no durable latest observation"
                );
            };
            candidates
                .into_iter()
                .find(|candidate| {
                    candidate.observed_at == latest_observed_at
                        && candidate.material_basis_digest == latest_basis
                })
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_FINDING_OBSERVATION_ORDER_MISSING: latest terminal observation is not in the read model"
                    )
                })?
        } else {
            // Edge-scoped observations retain the existing diagnostic ordering
            // contract; only terminal failures require strict timestamp
            // uniqueness because their code is a durable Inbox fact.
            candidates.last().copied().ok_or_else(|| {
                anyhow::anyhow!("NEX_FINDING_OBSERVATION_MISSING: identity has no observation")
            })?
        };
        let latest_lifecycle = if is_terminal {
            latest_terminal_failure_lifecycle_for_identity(
                conn,
                project_id,
                &finding_identity,
                &observation.finding_key,
                &observation.semantic_epoch_id,
            )?
        } else {
            latest_finding_lifecycle_for_identity(conn, project_id, &finding_identity)?
        };
        let is_proven_resolved = match latest_lifecycle.as_ref() {
            Some(row)
                if row.state == FindingLifecycleState::Resolved
                    && row.semantic_epoch_id == observation.semantic_epoch_id =>
            {
                if is_terminal {
                    terminal_resolution_is_strictly_newer(
                        conn,
                        &row.observed_at,
                        &observation.observed_at,
                    )?
                } else {
                    // Preserve the established edge-scoped diagnostic order;
                    // only terminal history needs instant-aware comparison.
                    row.observed_at >= observation.observed_at
                }
            }
            _ => false,
        };
        if !is_proven_resolved {
            active_observations.push(observation);
        }
    }

    // `observations` is oldest-first, so choose the last candidate by walking
    // the original slice backwards rather than by sorting the selected
    // identity representatives independently. An unresolved legacy row is a
    // fail-open display candidate even though it cannot join the exact
    // identity set used by Attention applicability.
    let latest_display_observation = observations.iter().rev().find(|observation| {
        observation.finding_identity.is_none()
            || active_observations
                .iter()
                .any(|candidate| candidate.id == observation.id)
    });

    Ok((
        active_observations,
        has_unresolved_identity,
        latest_display_observation,
    ))
}

fn snooze_hides_consumer(
    active_observations: &[&FindingObservationRow],
    has_unresolved_identity: bool,
    attention: Option<&AttentionRow>,
    now: &str,
) -> bool {
    match attention {
        Some(attention_row) if attention_row.disposition == AttentionDisposition::Snoozed => {
            !active_observations.is_empty()
                && !has_unresolved_identity
                && attention_row.identity_resolution_status == "resolved"
                && active_observations.iter().all(|observation| {
                    observation.finding_identity.as_deref()
                        == attention_row.finding_identity.as_deref()
                        && is_attention_applicable(
                            attention_row,
                            observation.material_basis_digest.as_str(),
                            now,
                        )
                })
        }
        _ => false,
    }
}

/// Compare a terminal lifecycle resolution with its Observation using
/// SQLite's instant parser. Restored rows may use different RFC3339 offsets,
/// so lexical comparison is not a valid chronology. Equal, older, or
/// malformed/null timestamps must not prove resolution; malformed values are
/// an Inbox read error rather than permission to hide durable failure history.
fn terminal_resolution_is_strictly_newer(
    conn: &Connection,
    resolution_observed_at: &str,
    observation_observed_at: &str,
) -> anyhow::Result<bool> {
    let comparison: i64 = conn.query_row(
        "SELECT CASE
                    WHEN julianday(?1) IS NULL OR julianday(?2) IS NULL THEN 2
                    WHEN julianday(?1) > julianday(?2) THEN 1
                    ELSE 0
                END",
        params![resolution_observed_at, observation_observed_at],
        |row| row.get(0),
    )?;
    match comparison {
        0 => Ok(false),
        1 => Ok(true),
        _ => anyhow::bail!(
            "NEX_FINDING_INBOX_TIMESTAMP_INVALID: terminal lifecycle or observation timestamp is not a valid instant"
        ),
    }
}

fn freshness_summary_counts(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<FreshnessSummaryCounts> {
    let sql = format!(
        "SELECT f.consumer_kind, f.evidence_freshness, f.build_action, COUNT(*),
                SUM(CASE WHEN f.consumer_kind = 'proposal-revision'
                              AND NOT ({EXCLUDED_PROPOSAL_REVISION_PREDICATE})
                         THEN 1 ELSE 0 END)
           FROM narrative_consumer_freshness f
          WHERE f.project_id = ?1
          GROUP BY f.consumer_kind, f.evidence_freshness, f.build_action"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
        ))
    })?;

    let mut counts = FreshnessSummaryCounts::default();
    for row in rows {
        let (consumer_kind, raw_freshness, raw_action, row_count, countable_proposals) = row?;
        let freshness = EvidenceFreshness::try_from(raw_freshness.as_str())?;
        BuildAction::try_from(raw_action.as_str())?;
        let row_count = u64::try_from(row_count)?;
        if !CONTRACT_CONSUMER_KINDS.contains(&consumer_kind.as_str()) {
            counts.unrecognized += row_count;
        }
        if consumer_kind == PROPOSAL_REVISION_CONSUMER_KIND {
            let count = u64::try_from(countable_proposals)?;
            match freshness {
                EvidenceFreshness::Fresh => counts.fresh += count,
                EvidenceFreshness::Stale => counts.stale += count,
                EvidenceFreshness::SourceMissing => counts.source_missing += count,
                EvidenceFreshness::AnchorMismatch => counts.anchor_mismatch += count,
                EvidenceFreshness::ReadSetDrift => counts.read_set_drift += count,
                EvidenceFreshness::Unknown => counts.unknown += count,
            }
        }
    }
    Ok(counts)
}

fn stale_proposal_candidate_count(conn: &Connection, project_id: &str) -> anyhow::Result<u64> {
    Ok(freshness_summary_counts(conn, project_id)?.stale_total())
}

fn hidden_consumers(
    conn: &Connection,
    project_id: &str,
    epoch_id: &str,
    now: &str,
    consumer_predicate: &str,
    include_unrecognized_consumers: bool,
) -> anyhow::Result<HashMap<(String, String), EvidenceFreshness>> {
    let sql = format!(
        "SELECT f.consumer_kind, f.consumer_key, f.evidence_freshness
           FROM narrative_consumer_freshness f
           JOIN narrative_maintenance_attention a
             ON a.project_id = f.project_id
            AND a.finding_key = f.consumer_kind || ':' || f.consumer_key
          WHERE f.project_id = ?1
            AND ({consumer_predicate})
            AND a.disposition = 'snoozed'
          ORDER BY f.consumer_kind, f.consumer_key"
    );
    let snoozed_consumers = conn
        .prepare(&sql)?
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut hidden = HashMap::new();
    for (consumer_kind, consumer_key, raw_freshness) in snoozed_consumers {
        // The summary counts proposal rows and unreadable kinds only.
        if include_unrecognized_consumers
            && consumer_kind != PROPOSAL_REVISION_CONSUMER_KIND
            && CONTRACT_CONSUMER_KINDS.contains(&consumer_kind.as_str())
        {
            continue;
        }
        let finding_key = consumer_finding_key(&consumer_kind, &consumer_key);
        let observations = list_observations_for_epoch(conn, project_id, epoch_id, &finding_key)?;
        let (active_observations, has_unresolved_identity, _) =
            active_finding_observations(conn, project_id, &observations)?;
        let attention = get_attention(conn, project_id, &finding_key)?;
        if snooze_hides_consumer(
            &active_observations,
            has_unresolved_identity,
            attention.as_ref(),
            now,
        ) {
            hidden.insert(
                (consumer_kind, consumer_key),
                EvidenceFreshness::try_from(raw_freshness.as_str())?,
            );
        }
    }
    Ok(hidden)
}

/// Count stale proposal Consumers without assembling the full Inbox.
/// Observation history and Attention are read only for matching Consumers
/// that actually have a Snoozed Attention row.
pub fn count_stale_proposals(
    conn: &Connection,
    project_id: &str,
    now: &str,
) -> anyhow::Result<u64> {
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(!now.trim().is_empty(), "now is required");

    let Some(current_epoch) = get_current_epoch(conn, project_id)? else {
        return Ok(0);
    };

    let count = stale_proposal_candidate_count(conn, project_id)?;
    let stale_predicate = format!(
        "{STALE_PROPOSAL_CONSUMER_PREDICATE} AND NOT ({EXCLUDED_PROPOSAL_REVISION_PREDICATE})"
    );
    let hidden = hidden_consumers(
        conn,
        project_id,
        &current_epoch.id,
        now,
        &stale_predicate,
        false,
    )?;
    Ok(count.saturating_sub(u64::try_from(hidden.len())?))
}

/// Read maintenance counts without assembling Consumer Freshness Inbox rows.
pub fn maintenance_health_summary(
    conn: &Connection,
    project_id: &str,
    now: &str,
) -> anyhow::Result<MaintenanceHealthSummary> {
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(!now.trim().is_empty(), "now is required");

    let Some(current_epoch) = get_current_epoch(conn, project_id)? else {
        return Ok(FreshnessSummaryCounts::default().into_summary(0));
    };

    let mut counts = freshness_summary_counts(conn, project_id)?;
    let summary_snooze_predicate = format!(
        "(f.consumer_kind <> '{PROPOSAL_REVISION_CONSUMER_KIND}'
         OR NOT ({EXCLUDED_PROPOSAL_REVISION_PREDICATE}))"
    );
    let hidden = hidden_consumers(
        conn,
        project_id,
        &current_epoch.id,
        now,
        &summary_snooze_predicate,
        true,
    )?;
    for ((consumer_kind, _), freshness) in hidden {
        if consumer_kind == PROPOSAL_REVISION_CONSUMER_KIND {
            match freshness {
                EvidenceFreshness::Fresh => counts.fresh = counts.fresh.saturating_sub(1),
                EvidenceFreshness::Stale => counts.stale = counts.stale.saturating_sub(1),
                EvidenceFreshness::SourceMissing => {
                    counts.source_missing = counts.source_missing.saturating_sub(1)
                }
                EvidenceFreshness::AnchorMismatch => {
                    counts.anchor_mismatch = counts.anchor_mismatch.saturating_sub(1)
                }
                EvidenceFreshness::ReadSetDrift => {
                    counts.read_set_drift = counts.read_set_drift.saturating_sub(1)
                }
                EvidenceFreshness::Unknown => counts.unknown = counts.unknown.saturating_sub(1),
            }
        } else {
            counts.unrecognized = counts.unrecognized.saturating_sub(1);
        }
    }

    let mut maintenance_stopped = 0;
    visit_visible_terminal_failures(conn, project_id, &current_epoch.id, now, |_, _, _, _| {
        maintenance_stopped += 1
    })?;
    Ok(counts.into_summary(maintenance_stopped))
}

fn scene_ids_from_envelope(envelope_json: &str) -> Option<HashSet<String>> {
    let envelope: Value = serde_json::from_str(envelope_json).ok()?;
    let entries = envelope
        .pointer("/effectiveMaterialBasis/evidenceSet")?
        .as_array()?;
    let mut scene_ids = HashSet::new();
    for entry in entries {
        // A quote without a source (the extractor allows it) names no Scene;
        // skip that entry only, as the Scene-side read does.
        let Some(source_key) = entry.get("sourceKey").and_then(Value::as_str) else {
            continue;
        };
        if let Some(scene_id) = source_key.strip_prefix("project:scene:") {
            if !scene_id.is_empty() {
                scene_ids.insert(scene_id.to_owned());
            }
        }
    }
    Some(scene_ids)
}

/// Read scene counts for the same stale proposal revisions as
/// [`count_stale_proposals`], paging only after the full project aggregation.
pub fn stale_proposal_scenes(
    conn: &Connection,
    project_id: &str,
    now: &str,
    cursor: Option<&str>,
    limit: Option<u64>,
) -> anyhow::Result<StaleProposalScenesPage> {
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(!now.trim().is_empty(), "now is required");
    anyhow::ensure!(
        cursor.is_none_or(|value| !value.is_empty() && value.len() <= 256),
        "cursor must be a non-empty string of at most 256 bytes"
    );
    anyhow::ensure!(
        limit.is_none_or(|value| value > 0),
        "limit must be positive"
    );

    let Some(current_epoch) = get_current_epoch(conn, project_id)? else {
        return Ok(StaleProposalScenesPage {
            scenes: Vec::new(),
            without_scene_count: 0,
            next_cursor: None,
        });
    };

    stale_proposal_candidate_count(conn, project_id)?;
    let stale_predicate = format!(
        "{STALE_PROPOSAL_CONSUMER_PREDICATE} AND NOT ({EXCLUDED_PROPOSAL_REVISION_PREDICATE})"
    );
    let hidden = hidden_consumers(
        conn,
        project_id,
        &current_epoch.id,
        now,
        &stale_predicate,
        false,
    )?;
    let sql = format!(
        "SELECT f.consumer_key, r.reconciliation_envelope_json
           FROM narrative_consumer_freshness f
           LEFT JOIN narrative_proposal_revisions r
             ON r.id = f.consumer_key
            AND EXISTS (SELECT 1
                          FROM narrative_proposals p
                          JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
                         WHERE p.id = r.proposal_id AND s.project_id = ?1)
          WHERE f.project_id = ?1
            AND ({stale_predicate})
          ORDER BY f.consumer_key"
    );
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params![project_id])?;

    // One envelope at a time: a large project has many stale revisions.
    let mut scene_counts = BTreeMap::<String, u64>::new();
    let mut without_scene_count = 0_u64;
    while let Some(row) = rows.next()? {
        let revision_id: String = row.get(0)?;
        if hidden.contains_key(&(
            PROPOSAL_REVISION_CONSUMER_KIND.to_owned(),
            revision_id.clone(),
        )) {
            continue;
        }
        let envelope_json: Option<String> = row.get(1)?;
        let scene_ids = envelope_json
            .as_deref()
            .and_then(scene_ids_from_envelope)
            .filter(|scene_ids| !scene_ids.is_empty());
        if let Some(scene_ids) = scene_ids {
            for scene_id in scene_ids {
                *scene_counts.entry(scene_id).or_default() += 1;
            }
        } else {
            without_scene_count += 1;
        }
    }

    let page_limit = limit
        .unwrap_or(STALE_PROPOSAL_SCENES_PAGE_DEFAULT)
        .min(STALE_PROPOSAL_SCENES_PAGE_MAX) as usize;
    let mut scenes: Vec<_> = scene_counts
        .into_iter()
        .filter(|(scene_id, _)| cursor.is_none_or(|cursor| scene_id.as_str() > cursor))
        .map(|(scene_id, proposal_count)| StaleProposalSceneCount {
            scene_id,
            proposal_count,
        })
        .collect();
    let next_cursor = if scenes.len() > page_limit {
        scenes.truncate(page_limit);
        scenes.last().map(|scene| scene.scene_id.clone())
    } else {
        None
    };

    Ok(StaleProposalScenesPage {
        scenes,
        without_scene_count,
        next_cursor,
    })
}

fn visit_visible_terminal_failures(
    conn: &Connection,
    project_id: &str,
    epoch_id: &str,
    now: &str,
    mut visit: impl FnMut(String, String, FindingObservationRow, Option<AttentionRow>),
) -> anyhow::Result<()> {
    let terminal_prefix = format!("{TERMINAL_FAILURE_CONSUMER_KIND}:");
    for finding_key in list_terminal_failure_finding_keys_for_epoch(conn, project_id, epoch_id)? {
        let observations = list_observations_for_epoch(conn, project_id, epoch_id, &finding_key)?;
        let (active_observations, has_unresolved_identity, latest_observation) =
            active_finding_observations(conn, project_id, &observations)?;
        let Some(latest_observation) = latest_observation.cloned() else {
            continue;
        };
        let attention = get_attention(conn, project_id, &finding_key)?;
        if snooze_hides_consumer(
            &active_observations,
            has_unresolved_identity,
            attention.as_ref(),
            now,
        ) {
            continue;
        }
        let consumer_key = finding_key
            .strip_prefix(terminal_prefix.as_str())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_FINDING_KEY_INVALID: terminal failure key '{finding_key}' has an invalid prefix"
                )
            })?
            .to_string();
        visit(finding_key, consumer_key, latest_observation, attention);
    }
    Ok(())
}

/// Assemble the Maintenance Inbox for `project_id` as of `now`. Read-only:
/// this function issues no `INSERT`/`UPDATE`/`DELETE` of its own, and calls
/// nothing that does -- see the module's `build_maintenance_inbox_never_mutates_attention_rows`
/// test for an explicit assertion of that on the one table (Attention) a
/// careless caller might expect a "read the Inbox" operation to update
/// (e.g. auto-clearing a lapsed snooze). It never does.
///
/// Returns entries ordered the same as [`list_consumer_freshness`]
/// (`consumer_kind`, `consumer_key`), minus any Consumer currently hidden by
/// an active, unexpired snooze that covers every active Finding identity (see
/// module doc). Returns an empty Vec when `project_id` has no current Semantic
/// Epoch yet.
///
/// `pub`: called directly from `grimodex-node`'s
/// `narrative_maintenance_inbox_list` N-API binding (C2-T1).
pub fn build_maintenance_inbox(
    conn: &Connection,
    project_id: &str,
    now: &str,
) -> anyhow::Result<Vec<InboxEntry>> {
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(!now.trim().is_empty(), "now is required");

    let Some(current_epoch) = get_current_epoch(conn, project_id)? else {
        return Ok(Vec::new());
    };

    let freshness_rows = list_consumer_freshness(conn, project_id)?;
    let mut entries = Vec::with_capacity(freshness_rows.len());

    for row in freshness_rows {
        let finding_key = consumer_finding_key(&row.consumer_kind, &row.consumer_key);

        // Only the *current* epoch's diagnostic history is relevant --
        // this is the entire epoch-rotation invalidation mechanism (see
        // module doc, "Epoch invalidation"). Keep the full diagnostic slice
        // here because the Attention identity may point at one Edge while a
        // Consumer has several Edges under the same finding key.
        let observations =
            list_observations_for_epoch(conn, project_id, &current_epoch.id, &finding_key)?;
        let (active_observations, has_unresolved_identity, latest_observation) =
            active_finding_observations(conn, project_id, &observations)?;
        let latest_observation = latest_observation.cloned();

        // Pure read; never mutates or clears a lapsed row (attention.rs's
        // own contract).
        let attention = get_attention(conn, project_id, &finding_key)?;

        let is_snoozed_and_active = snooze_hides_consumer(
            &active_observations,
            has_unresolved_identity,
            attention.as_ref(),
            now,
        );

        if is_snoozed_and_active {
            // Active, unexpired snooze: hidden from the Inbox entirely.
            continue;
        }

        entries.push(InboxEntry {
            entry_kind: InboxEntryKind::ConsumerFreshness,
            consumer_kind: row.consumer_kind,
            consumer_key: row.consumer_key,
            evidence_freshness: Some(row.evidence_freshness.as_str().to_string()),
            build_action: Some(row.build_action.as_str().to_string()),
            finding_key,
            latest_observation,
            attention,
            is_snoozed_and_active,
        });
    }

    // Terminal maintenance failures do not have a Consumer Freshness row.
    // Read their current-epoch Observation history directly, preserving the
    // same lifecycle/Attention/snooze semantics as ordinary Findings.
    visit_visible_terminal_failures(
        conn,
        project_id,
        &current_epoch.id,
        now,
        |finding_key, consumer_key, latest_observation, attention| {
            entries.push(InboxEntry {
                entry_kind: InboxEntryKind::TerminalFailure,
                consumer_kind: TERMINAL_FAILURE_CONSUMER_KIND.to_string(),
                consumer_key,
                evidence_freshness: None,
                build_action: None,
                finding_key,
                latest_observation: Some(latest_observation),
                attention,
                is_snoozed_and_active: false,
            });
        },
    )?;

    entries.sort_by(|left, right| {
        left.consumer_kind
            .cmp(&right.consumer_kind)
            .then_with(|| left.consumer_key.cmp(&right.consumer_key))
    });

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narrative_extraction::attention::AttentionWriteOutcome;
    use crate::narrative_extraction::attention::{
        get_attention, set_attention_in_tx, SetAttentionRequest,
    };
    use crate::narrative_extraction::evaluator::FindingReasonCode;
    use crate::narrative_extraction::finding_identity::stable_finding_identity;
    use crate::narrative_extraction::finding_observation::{
        record_finding_lifecycle_in_tx, record_finding_observation_in_tx, FindingLifecycleState,
        FindingLifecycleWrite,
    };
    use crate::narrative_extraction::semantic_epoch::create_epoch_in_tx;
    use crate::narrative_extraction::{
        material_basis_digest, MaterialBasisInput, BUNDLED_FINDING_RULE_ID,
        BUNDLED_FINDING_RULE_VERSION,
    };
    use crate::Database;

    /// Positional shim keeping these Inbox read-model tests focused on the
    /// read model rather than on Attention's OCC. Reads the current version
    /// so repeated sets on one finding still upsert the way they did before
    /// SCHEMA 25, and derives a fresh requestId per write so a second write
    /// is a new decision rather than a replay.
    ///
    /// The id is scoped by finding *and* version: a requestId identifies one
    /// request across the whole Attention domain, so two findings sharing
    /// one is a conflict, not two independent writes.
    #[allow(clippy::too_many_arguments)]
    fn set_attention_for_test(
        conn: &Connection,
        project_id: &str,
        finding_key: &str,
        disposition: AttentionDisposition,
        material_basis_digest: &str,
        snoozed_until: Option<&str>,
        set_at: &str,
        actor: Option<&str>,
    ) -> anyhow::Result<AttentionWriteOutcome> {
        let expected_version =
            get_attention(conn, project_id, finding_key)?.map_or(0, |row| row.version);
        let request_id = format!("req-test-{project_id}-{finding_key}-{expected_version}");
        set_attention_in_tx(
            conn,
            SetAttentionRequest {
                project_id,
                finding_key,
                disposition,
                material_basis_digest,
                snoozed_until,
                set_at,
                actor_id: actor.unwrap_or("test-actor"),
                request_id: &request_id,
                reason: None,
                expected_version,
            },
        )
    }

    fn test_db() -> Database {
        let db = crate::test_support::current_schema_memory().expect("current-schema fixture");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            Ok(())
        })
        .expect("seed project");
        db
    }

    fn test_material_basis(
        edge_id: &str,
        reason_code: FindingReasonCode,
        freshness: EvidenceFreshness,
    ) -> String {
        material_basis_digest(
            BUNDLED_FINDING_RULE_ID,
            BUNDLED_FINDING_RULE_VERSION,
            &MaterialBasisInput {
                stable_subject: edge_id,
                edge_id: Some(edge_id),
                failure_code: None,
                reason_code: reason_code.as_str(),
                evidence_freshness: freshness.as_str(),
                evidence_detail_digest: None,
            },
        )
        .expect("material basis")
    }

    #[allow(clippy::too_many_arguments)]
    fn seed_consumer_freshness(
        conn: &Connection,
        project_id: &str,
        consumer_kind: &str,
        consumer_key: &str,
        evidence_freshness: &str,
        build_action: &str,
        semantic_epoch_id: &str,
        updated_at: &str,
    ) {
        conn.execute(
            "INSERT INTO narrative_consumer_freshness
                (project_id, consumer_kind, consumer_key, evidence_freshness, build_action,
                 semantic_epoch_id, last_evaluated_run_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)",
            params![
                project_id,
                consumer_kind,
                consumer_key,
                evidence_freshness,
                build_action,
                semantic_epoch_id,
                updated_at,
            ],
        )
        .expect("seed consumer freshness row");
    }

    fn seed_proposal_revision_for_test(
        conn: &Connection,
        project_id: &str,
        revision_id: &str,
        envelope_json: Option<&str>,
    ) -> anyhow::Result<()> {
        let proposal_set_id = format!("set-{revision_id}");
        let proposal_id = format!("proposal-{revision_id}");
        conn.execute(
            "INSERT INTO narrative_proposal_sets
                (id, run_id, project_id, set_kind, status, summary_json,
                 created_at, updated_at, version)
             VALUES (?1, 'run-test', ?2, 'test', 'draft', '{}',
                     '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z', 0)",
            params![proposal_set_id, project_id],
        )?;
        conn.execute(
            "INSERT INTO narrative_proposals
                (id, proposal_set_id, proposal_key, kind, status, payload_json,
                 current_revision_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'test.proposal', 'unreviewed', '{}', ?4,
                     '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')",
            params![proposal_id, proposal_set_id, revision_id, revision_id],
        )?;
        conn.execute(
            "INSERT INTO narrative_proposal_revisions
                (id, proposal_id, revision_number, payload_json,
                 reconciliation_envelope_json, created_at, created_by)
             VALUES (?1, ?2, 1, '{}', ?3,
                     '2026-08-15T00:00:00.000Z', 'test')",
            params![revision_id, proposal_id, envelope_json],
        )?;
        Ok(())
    }

    fn seed_stale_proposal_revision_for_test(
        conn: &Connection,
        project_id: &str,
        epoch_id: &str,
        revision_id: &str,
        envelope_json: Option<&str>,
    ) -> anyhow::Result<()> {
        seed_consumer_freshness(
            conn,
            project_id,
            "proposal-revision",
            revision_id,
            "stale",
            "rebuild-required",
            epoch_id,
            "2026-08-15T00:00:00.000Z",
        );
        seed_proposal_revision_for_test(conn, project_id, revision_id, envelope_json)
    }

    fn seed_dependency_edge(
        conn: &Connection,
        edge_id: &str,
        project_id: &str,
        consumer_kind: &str,
        consumer_key: &str,
    ) {
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key, source_object_identity,
                 read_set_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, '[]', '2026-08-15T00:00:00.000Z')",
            params![
                edge_id,
                project_id,
                consumer_kind,
                consumer_key,
                format!("test-source:{edge_id}"),
            ],
        )
        .expect("seed dependency edge");
    }

    fn summarize_stale_proposals(entries: &[InboxEntry], excluded: &HashSet<String>) -> u64 {
        entries
            .iter()
            .filter(|entry| {
                entry.entry_kind == InboxEntryKind::ConsumerFreshness
                    && entry.consumer_kind == "proposal-revision"
                    && !excluded.contains(&entry.consumer_key)
                    && entry
                        .evidence_freshness
                        .as_deref()
                        .is_some_and(|freshness| {
                            freshness != "fresh" && freshness != "unrecognized"
                        })
            })
            .count() as u64
    }

    fn summarize_checked_proposals(entries: &[InboxEntry], excluded: &HashSet<String>) -> u64 {
        entries
            .iter()
            .filter(|entry| {
                entry.entry_kind == InboxEntryKind::ConsumerFreshness
                    && entry.consumer_kind == PROPOSAL_REVISION_CONSUMER_KIND
                    && !excluded.contains(&entry.consumer_key)
                    && entry
                        .evidence_freshness
                        .as_deref()
                        .is_some_and(|freshness| {
                            freshness == "fresh"
                                || matches!(
                                    freshness,
                                    "stale"
                                        | "source-missing"
                                        | "anchor-mismatch"
                                        | "read-set-drift"
                                        | "unknown"
                                )
                        })
            })
            .count() as u64
    }

    fn excluded_proposal_revision_ids_for_test(
        conn: &Connection,
        project_id: &str,
    ) -> anyhow::Result<HashSet<String>> {
        let mut statement = conn.prepare(
            "SELECT r.id
               FROM narrative_proposal_revisions r
               JOIN narrative_proposals p ON p.id = r.proposal_id
               JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
              WHERE s.project_id = ?1
                AND (p.status = 'rejected'
                     OR (p.current_revision_id IS NOT NULL AND p.current_revision_id <> r.id))",
        )?;
        let ids = statement
            .query_map(params![project_id], |row| row.get::<_, String>(0))?
            .collect::<Result<HashSet<_>, _>>()?;
        Ok(ids)
    }

    #[test]
    fn count_stale_proposals_matches_inbox_across_deterministic_combinations() {
        const FRESHNESS: [&str; 6] = [
            "fresh",
            "stale",
            "source-missing",
            "anchor-mismatch",
            "read-set-drift",
            "unknown",
        ];
        let mut seed = 0x00C0_FFEE_u64;
        let mut tested = 0;

        for kind_index in 0..2 {
            for freshness in FRESHNESS {
                for attention_case in 0..5 {
                    for observation_case in 0..4 {
                        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                        let db = test_db();
                        db.with_conn(|conn| {
                            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
                            let consumer_kind = if kind_index == 0 {
                                "proposal-revision"
                            } else {
                                "other-kind"
                            };
                            let consumer_key = format!("item-{:04x}-{:016x}", tested, seed);
                            let finding_key = consumer_finding_key(consumer_kind, &consumer_key);
                            seed_consumer_freshness(
                                conn,
                                "project-1",
                                consumer_kind,
                                &consumer_key,
                                freshness,
                                "none",
                                &epoch_id,
                                "2026-08-15T00:00:00.000Z",
                            );

                            let edge_count = if observation_case == 1 { 2 } else { 1 };
                            let mut first_basis = String::new();
                            for edge_index in 0..edge_count {
                                let edge_id = format!("edge-{tested}-{edge_index}");
                                seed_dependency_edge(
                                    conn,
                                    &edge_id,
                                    "project-1",
                                    consumer_kind,
                                    &consumer_key,
                                );
                                let basis = test_material_basis(
                                    &edge_id,
                                    FindingReasonCode::SourceRevisionChanged,
                                    EvidenceFreshness::Stale,
                                );
                                if edge_index == 0 {
                                    first_basis = basis.clone();
                                }
                                record_finding_observation_in_tx(
                                    conn,
                                    "project-1",
                                    &format!("run-{tested}-{edge_index}"),
                                    &epoch_id,
                                    Some(&edge_id),
                                    &finding_key,
                                    FindingReasonCode::SourceRevisionChanged,
                                    EvidenceFreshness::Stale,
                                    &basis,
                                    &format!("2026-08-15T00:00:0{edge_index}.000Z"),
                                )?;
                            }

                            match observation_case {
                                2 => {
                                    let identity = stable_finding_identity(
                                        BUNDLED_FINDING_RULE_ID,
                                        BUNDLED_FINDING_RULE_VERSION,
                                        &format!("edge-{tested}-0"),
                                    )?;
                                    record_finding_lifecycle_in_tx(
                                        conn,
                                        FindingLifecycleWrite {
                                            project_id: "project-1",
                                            finding_identity: &identity,
                                            finding_key: &finding_key,
                                            rule_id: BUNDLED_FINDING_RULE_ID,
                                            rule_version: BUNDLED_FINDING_RULE_VERSION,
                                            state: FindingLifecycleState::Resolved,
                                            observation_digest: None,
                                            material_basis_digest: Some(&first_basis),
                                            run_id: &format!("resolved-{tested}"),
                                            semantic_epoch_id: &epoch_id,
                                            observed_at: "2026-08-15T00:00:10.000Z",
                                        },
                                    )?;
                                }
                                3 => {
                                    conn.execute(
                                        "UPDATE narrative_maintenance_finding_observations
                                            SET finding_identity = NULL
                                          WHERE project_id = ?1 AND finding_key = ?2",
                                        params!["project-1", finding_key],
                                    )?;
                                }
                                _ => {}
                            }

                            let disposition = match attention_case {
                                1 => Some(AttentionDisposition::Flagged),
                                2 => Some(AttentionDisposition::Dismissed),
                                3 | 4 => Some(AttentionDisposition::Snoozed),
                                _ => None,
                            };
                            if let Some(disposition) = disposition {
                                let until = match attention_case {
                                    3 => Some("2026-08-15T02:00:00.000Z"),
                                    4 => Some("2026-08-15T00:30:00.000Z"),
                                    _ => None,
                                };
                                set_attention_for_test(
                                    conn,
                                    "project-1",
                                    &finding_key,
                                    disposition,
                                    &first_basis,
                                    until,
                                    "2026-08-15T00:00:00.000Z",
                                    Some("test-actor"),
                                )?;
                            }

                            let now = "2026-08-15T01:00:00.000Z";
                            let inbox = build_maintenance_inbox(conn, "project-1", now)?;
                            let excluded =
                                excluded_proposal_revision_ids_for_test(conn, "project-1")?;
                            let expected = summarize_stale_proposals(&inbox, &excluded);
                            let expected_from_seed = u64::from(
                                kind_index == 0
                                    && freshness != "fresh"
                                    && !(attention_case == 3 && observation_case == 0),
                            );
                            assert_eq!(expected, expected_from_seed, "Inbox oracle case {tested}");
                            assert_eq!(count_stale_proposals(conn, "project-1", now)?, expected,
                                "case {tested}: kind={consumer_kind}, freshness={freshness}, attention={attention_case}, observations={observation_case}");
                            let summary = maintenance_health_summary(conn, "project-1", now)?;
                            assert_eq!(summary.proposals_stale, expected,
                                "summary case {tested}: kind={consumer_kind}, freshness={freshness}, attention={attention_case}, observations={observation_case}");
                            assert_eq!(summary.proposals_checked, summarize_checked_proposals(&inbox, &excluded),
                                "checked count case {tested}");
                            Ok(())
                        })
                        .expect("with_conn");
                        tested += 1;
                    }
                }
            }
        }
        assert_eq!(tested, 240);
    }

    #[test]
    fn proposal_revision_exclusions_match_count_summary_scenes_and_filtered_inbox() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-2', 'Other Project')",
                [],
            )?;
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;

            for revision_id in [
                "revision-replaced",
                "revision-rejected",
                "revision-deferred",
                "revision-held",
                "revision-null-current",
                "revision-normal",
            ] {
                seed_stale_proposal_revision_for_test(
                    conn,
                    "project-1",
                    &epoch_id,
                    revision_id,
                    None,
                )?;
            }
            conn.execute(
                "INSERT INTO narrative_proposal_revisions
                    (id, proposal_id, revision_number, payload_json,
                     reconciliation_envelope_json, created_at, created_by)
                 VALUES ('revision-replacement-current', 'proposal-revision-replaced', 2,
                         '{}', NULL, '2026-08-15T00:00:00.000Z', 'test')",
                [],
            )?;
            conn.execute(
                "UPDATE narrative_proposals
                    SET current_revision_id = 'revision-replacement-current'
                  WHERE id = 'proposal-revision-replaced'",
                [],
            )?;
            conn.execute(
                "UPDATE narrative_proposals SET status = 'rejected'
                  WHERE id = 'proposal-revision-rejected'",
                [],
            )?;
            conn.execute(
                "UPDATE narrative_proposals SET status = 'deferred'
                  WHERE id = 'proposal-revision-deferred'",
                [],
            )?;
            conn.execute(
                "UPDATE narrative_proposals SET status = 'held'
                  WHERE id = 'proposal-revision-held'",
                [],
            )?;
            conn.execute(
                "UPDATE narrative_proposals SET current_revision_id = NULL
                  WHERE id = 'proposal-revision-null-current'",
                [],
            )?;
            for revision_id in ["revision-replaced", "revision-rejected"] {
                let edge_id = format!("edge-{revision_id}");
                let finding_key =
                    consumer_finding_key(PROPOSAL_REVISION_CONSUMER_KIND, revision_id);
                let basis = test_material_basis(
                    &edge_id,
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                );
                seed_dependency_edge(
                    conn,
                    &edge_id,
                    "project-1",
                    PROPOSAL_REVISION_CONSUMER_KIND,
                    revision_id,
                );
                record_finding_observation_in_tx(
                    conn,
                    "project-1",
                    &format!("run-{revision_id}"),
                    &epoch_id,
                    Some(&edge_id),
                    &finding_key,
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                    &basis,
                    "2026-08-15T00:00:01.000Z",
                )?;
                set_attention_for_test(
                    conn,
                    "project-1",
                    &finding_key,
                    AttentionDisposition::Snoozed,
                    &basis,
                    Some("2026-08-15T02:00:00.000Z"),
                    "2026-08-15T00:00:02.000Z",
                    Some("test-actor"),
                )?;
            }

            seed_consumer_freshness(
                conn,
                "project-1",
                PROPOSAL_REVISION_CONSUMER_KIND,
                "revision-missing",
                "stale",
                "rebuild-required",
                &epoch_id,
                "2026-08-15T00:00:00.000Z",
            );
            seed_consumer_freshness(
                conn,
                "project-1",
                PROPOSAL_REVISION_CONSUMER_KIND,
                "revision-missing-proposal",
                "stale",
                "rebuild-required",
                &epoch_id,
                "2026-08-15T00:00:00.000Z",
            );
            conn.execute(
                "INSERT INTO narrative_proposal_revisions
                    (id, proposal_id, revision_number, payload_json,
                     reconciliation_envelope_json, created_at, created_by)
                 VALUES ('revision-missing-proposal', 'proposal-does-not-exist', 1,
                         '{}', NULL, '2026-08-15T00:00:00.000Z', 'test')",
                [],
            )?;
            seed_consumer_freshness(
                conn,
                "project-1",
                PROPOSAL_REVISION_CONSUMER_KIND,
                "revision-other-project",
                "stale",
                "rebuild-required",
                &epoch_id,
                "2026-08-15T00:00:00.000Z",
            );
            seed_proposal_revision_for_test(conn, "project-2", "revision-other-project", None)?;

            let now = "2026-08-15T01:00:00.000Z";
            let inbox = build_maintenance_inbox(conn, "project-1", now)?;
            let excluded = excluded_proposal_revision_ids_for_test(conn, "project-1")?;
            let filtered_inbox: Vec<_> = inbox
                .iter()
                .filter(|entry| {
                    entry.consumer_kind == PROPOSAL_REVISION_CONSUMER_KIND
                        && !excluded.contains(&entry.consumer_key)
                })
                .collect();
            let expected_checked = filtered_inbox.len() as u64;
            let expected_stale = filtered_inbox
                .iter()
                .filter(|entry| entry.evidence_freshness.as_deref() != Some("fresh"))
                .count() as u64;
            let count = count_stale_proposals(conn, "project-1", now)?;
            let summary = maintenance_health_summary(conn, "project-1", now)?;
            let scenes = stale_proposal_scenes(conn, "project-1", now, None, None)?;

            assert_eq!(expected_checked, 7);
            assert_eq!(expected_stale, 7);
            assert_eq!(count, expected_stale);
            assert_eq!(summary.proposals_checked, expected_checked);
            assert_eq!(summary.proposals_stale, expected_stale);
            assert_eq!(summary.stale_breakdown.stale, expected_stale);
            assert_eq!(scenes.without_scene_count, expected_stale);
            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn count_stale_proposals_matches_inbox_error_for_invalid_freshness() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.pragma_update(None, "ignore_check_constraints", "ON")?;
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            seed_consumer_freshness(
                conn,
                "project-1",
                "proposal-revision",
                "item-0001",
                "stale",
                "none",
                &epoch_id,
                "2026-08-15T00:00:00.000Z",
            );
            conn.execute(
                "UPDATE narrative_consumer_freshness SET evidence_freshness = 'unreadable'
                  WHERE project_id = 'project-1' AND consumer_key = 'item-0001'",
                [],
            )?;
            assert!(
                build_maintenance_inbox(conn, "project-1", "2026-08-15T01:00:00.000Z").is_err()
            );
            assert!(count_stale_proposals(conn, "project-1", "2026-08-15T01:00:00.000Z").is_err());
            assert!(
                maintenance_health_summary(conn, "project-1", "2026-08-15T01:00:00.000Z").is_err()
            );
            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn health_summary_counts_unrecognized_kinds_and_rejects_unknown_vocabularies() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            seed_consumer_freshness(
                conn,
                "project-1",
                "future-kind",
                "visible",
                "stale",
                "manual",
                &epoch_id,
                "2026-08-15T00:00:00.000Z",
            );
            seed_consumer_freshness(
                conn,
                "project-1",
                "future-kind",
                "snoozed",
                "fresh",
                "none",
                &epoch_id,
                "2026-08-15T00:00:00.000Z",
            );
            // A reserved contract kind that Rust does not model is still known.
            seed_consumer_freshness(
                conn,
                "project-1",
                "semantic-index",
                "reserved",
                "stale",
                "manual",
                &epoch_id,
                "2026-08-15T00:00:00.000Z",
            );
            seed_dependency_edge(conn, "edge-future", "project-1", "future-kind", "snoozed");
            let finding_key = "future-kind:snoozed";
            let basis = test_material_basis(
                "edge-future",
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
            );
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-future",
                &epoch_id,
                Some("edge-future"),
                finding_key,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                &basis,
                "2026-08-15T00:00:01.000Z",
            )?;
            set_attention_for_test(
                conn,
                "project-1",
                finding_key,
                AttentionDisposition::Snoozed,
                &basis,
                Some("2026-08-15T02:00:00.000Z"),
                "2026-08-15T00:00:02.000Z",
                Some("test-actor"),
            )?;

            let now = "2026-08-15T01:00:00.000Z";
            let summary = maintenance_health_summary(conn, "project-1", now)?;
            assert_eq!(summary.unrecognized, 1);
            set_attention_for_test(
                conn,
                "project-1",
                finding_key,
                AttentionDisposition::Snoozed,
                &basis,
                Some("2026-08-15T00:30:00.000Z"),
                "2026-08-15T00:00:03.000Z",
                Some("test-actor"),
            )?;
            assert_eq!(
                maintenance_health_summary(conn, "project-1", now)?.unrecognized,
                2
            );

            conn.pragma_update(None, "ignore_check_constraints", "ON")?;
            conn.execute(
                "UPDATE narrative_consumer_freshness SET evidence_freshness = 'unreadable'
                  WHERE project_id = 'project-1' AND consumer_key = 'visible'",
                [],
            )?;
            assert!(maintenance_health_summary(conn, "project-1", now)
                .unwrap_err()
                .to_string()
                .contains("NEX_EVIDENCE_FRESHNESS_INVALID"));
            conn.execute(
                "UPDATE narrative_consumer_freshness SET evidence_freshness = 'stale',
                        build_action = 'unreadable'
                  WHERE project_id = 'project-1' AND consumer_key = 'visible'",
                [],
            )?;
            assert!(maintenance_health_summary(conn, "project-1", now)
                .unwrap_err()
                .to_string()
                .contains("NEX_BUILD_ACTION_INVALID"));
            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn stale_proposal_scenes_match_count_and_scope_revisions_to_project() {
        let db = test_db();
        let (count, page) = db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES ('project-2', 'Other Project')",
                    [],
                )?;
                let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
                let multi_scene = serde_json::json!({
                    "effectiveMaterialBasis": {"evidenceSet": [
                        {"sourceKey": "project:scene:scene-z"},
                        {"sourceKey": "project:scene:scene-a"},
                        {"sourceKey": "project:scene:scene-a"}
                    ]}
                })
                .to_string();
                let repeated_scene = serde_json::json!({
                    "effectiveMaterialBasis": {"evidenceSet": [
                        {"quote": "quote without a source"},
                        {"sourceKey": "project:scene:"},
                        {"sourceKey": "project:scene:scene-a"},
                        {"sourceKey": "project:scene:scene-a"},
                        {"sourceKey": "project:scene:scene-a"}
                    ]}
                })
                .to_string();
                let no_scene = serde_json::json!({
                    "effectiveMaterialBasis": {"evidenceSet": [
                        {"sourceKey": "project:codex-entry:entry-1"}
                    ]}
                })
                .to_string();
                seed_stale_proposal_revision_for_test(
                    conn,
                    "project-1",
                    &epoch_id,
                    "revision-multi",
                    Some(&multi_scene),
                )?;
                seed_stale_proposal_revision_for_test(
                    conn,
                    "project-1",
                    &epoch_id,
                    "revision-repeat",
                    Some(&repeated_scene),
                )?;
                seed_stale_proposal_revision_for_test(
                    conn,
                    "project-1",
                    &epoch_id,
                    "revision-no-scene",
                    Some(&no_scene),
                )?;
                seed_stale_proposal_revision_for_test(
                    conn,
                    "project-1",
                    &epoch_id,
                    "revision-broken",
                    Some("{"),
                )?;
                seed_consumer_freshness(
                    conn,
                    "project-1",
                    "proposal-revision",
                    "revision-missing",
                    "stale",
                    "rebuild-required",
                    &epoch_id,
                    "2026-08-15T00:00:00.000Z",
                );
                seed_consumer_freshness(
                    conn,
                    "project-1",
                    "proposal-revision",
                    "revision-other-project",
                    "stale",
                    "rebuild-required",
                    &epoch_id,
                    "2026-08-15T00:00:00.000Z",
                );
                seed_proposal_revision_for_test(
                    conn,
                    "project-2",
                    "revision-other-project",
                    Some(r#"{"effectiveMaterialBasis":{"evidenceSet":[{"sourceKey":"project:scene:foreign"}]}}"#),
                )?;
                seed_snoozed_proposal_for_test(
                    conn,
                    &epoch_id,
                    "revision-snoozed",
                    &["edge-snoozed"],
                    "2026-08-15T02:00:00.000Z",
                    None,
                )?;
                seed_proposal_revision_for_test(
                    conn,
                    "project-1",
                    "revision-snoozed",
                    Some(r#"{"effectiveMaterialBasis":{"evidenceSet":[{"sourceKey":"project:scene:scene-a"}]}}"#),
                )?;
                seed_consumer_freshness(
                    conn,
                    "project-1",
                    "proposal-revision",
                    "revision-fresh",
                    "fresh",
                    "none",
                    &epoch_id,
                    "2026-08-15T00:00:00.000Z",
                );
                seed_proposal_revision_for_test(
                    conn,
                    "project-1",
                    "revision-fresh",
                    Some(r#"{"effectiveMaterialBasis":{"evidenceSet":[{"sourceKey":"project:scene:ignored"}]}}"#),
                )?;

                let now = "2026-08-15T01:00:00.000Z";
                let count = count_stale_proposals(conn, "project-1", now)?;
                let page = stale_proposal_scenes(conn, "project-1", now, None, None)?;
                Ok((count, page))
            })
            .expect("seed and query");

        assert_eq!(count, 6);
        assert_eq!(
            page.scenes,
            vec![
                StaleProposalSceneCount {
                    scene_id: "scene-a".to_owned(),
                    proposal_count: 2,
                },
                StaleProposalSceneCount {
                    scene_id: "scene-z".to_owned(),
                    proposal_count: 1,
                },
            ]
        );
        assert_eq!(page.without_scene_count, 4);
        assert_eq!(page.without_scene_count + 2, count);
        assert_eq!(page.next_cursor, None);
    }

    #[test]
    fn stale_proposal_scenes_pages_after_aggregation_with_cursor_boundaries() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            for (index, scene_id) in ["scene-a", "scene-b", "scene-c", "scene-d"]
                .into_iter()
                .enumerate()
            {
                let revision_id = format!("page-revision-{index}");
                let envelope = serde_json::json!({
                    "effectiveMaterialBasis": {"evidenceSet": [
                        {"sourceKey": format!("project:scene:{scene_id}")}
                    ]}
                })
                .to_string();
                seed_stale_proposal_revision_for_test(
                    conn,
                    "project-1",
                    &epoch_id,
                    &revision_id,
                    Some(&envelope),
                )?;
            }
            let no_scene = r#"{"effectiveMaterialBasis":{"evidenceSet":[{"sourceKey":"project:codex-entry:entry-1"}]}}"#;
            seed_stale_proposal_revision_for_test(
                conn,
                "project-1",
                &epoch_id,
                "page-revision-without-scene",
                Some(no_scene),
            )?;

            let exact = stale_proposal_scenes(
                conn,
                "project-1",
                "2026-08-15T01:00:00.000Z",
                None,
                Some(4),
            )?;
            assert_eq!(exact.scenes.len(), 4);
            assert_eq!(exact.next_cursor, None);
            assert_eq!(exact.without_scene_count, 1);

            let first = stale_proposal_scenes(
                conn,
                "project-1",
                "2026-08-15T01:00:00.000Z",
                None,
                Some(3),
            )?;
            assert_eq!(
                first
                    .scenes
                    .iter()
                    .map(|scene| scene.scene_id.as_str())
                    .collect::<Vec<_>>(),
                vec!["scene-a", "scene-b", "scene-c"]
            );
            assert_eq!(first.next_cursor.as_deref(), Some("scene-c"));
            assert_eq!(first.without_scene_count, 1);

            let next = stale_proposal_scenes(
                conn,
                "project-1",
                "2026-08-15T01:00:00.000Z",
                first.next_cursor.as_deref(),
                Some(3),
            )?;
            assert_eq!(next.scenes.len(), 1);
            assert_eq!(next.scenes[0].scene_id, "scene-d");
            assert_eq!(next.next_cursor, None);
            assert_eq!(next.without_scene_count, 1);
            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn stale_proposal_scenes_default_and_maximum_limits_are_bounded() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            for index in 0..201 {
                let revision_id = format!("limit-revision-{index:03}");
                let envelope = serde_json::json!({
                    "effectiveMaterialBasis": {"evidenceSet": [
                        {"sourceKey": format!("project:scene:scene-{index:03}")}
                    ]}
                })
                .to_string();
                seed_stale_proposal_revision_for_test(
                    conn,
                    "project-1",
                    &epoch_id,
                    &revision_id,
                    Some(&envelope),
                )?;
            }

            let default_page =
                stale_proposal_scenes(conn, "project-1", "2026-08-15T01:00:00.000Z", None, None)?;
            assert_eq!(default_page.scenes.len(), 50);
            assert_eq!(default_page.next_cursor.as_deref(), Some("scene-049"));

            let max_page = stale_proposal_scenes(
                conn,
                "project-1",
                "2026-08-15T01:00:00.000Z",
                None,
                Some(250),
            )?;
            assert_eq!(max_page.scenes.len(), 200);
            assert_eq!(max_page.scenes[0].scene_id, "scene-000");
            assert_eq!(max_page.scenes[199].scene_id, "scene-199");
            assert_eq!(max_page.next_cursor.as_deref(), Some("scene-199"));
            assert!(stale_proposal_scenes(
                conn,
                "project-1",
                "2026-08-15T01:00:00.000Z",
                None,
                Some(0),
            )
            .is_err());
            Ok(())
        })
        .expect("with_conn");
    }

    fn seed_snoozed_proposal_for_test(
        conn: &Connection,
        epoch_id: &str,
        consumer_key: &str,
        edge_ids: &[&str],
        snoozed_until: &str,
        attention_basis_override: Option<&str>,
    ) -> anyhow::Result<String> {
        let finding_key = format!("proposal-revision:{consumer_key}");
        seed_consumer_freshness(
            conn,
            "project-1",
            "proposal-revision",
            consumer_key,
            "stale",
            "rebuild-required",
            epoch_id,
            "2026-08-15T00:00:00.000Z",
        );
        let mut first_basis = None;
        for (index, edge_id) in edge_ids.iter().enumerate() {
            let basis = test_material_basis(
                edge_id,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
            );
            seed_dependency_edge(
                conn,
                edge_id,
                "project-1",
                "proposal-revision",
                consumer_key,
            );
            record_finding_observation_in_tx(
                conn,
                "project-1",
                &format!("run-{consumer_key}-{index}"),
                epoch_id,
                Some(edge_id),
                &finding_key,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                &basis,
                &format!("2026-08-15T00:00:{:02}.000Z", index + 1),
            )?;
            if first_basis.is_none() {
                first_basis = Some(basis);
            }
        }
        let attention_basis = attention_basis_override
            .map(str::to_string)
            .or(first_basis)
            .unwrap_or_else(|| "sha256:unused-test-basis".to_string());
        set_attention_for_test(
            conn,
            "project-1",
            &finding_key,
            AttentionDisposition::Snoozed,
            &attention_basis,
            Some(snoozed_until),
            "2026-08-15T00:30:00.000Z",
            Some("test-actor"),
        )?;
        Ok(finding_key)
    }

    fn assert_snooze_test_outputs(
        conn: &Connection,
        expected_count: u64,
        expected_visible_keys: &[&str],
    ) -> anyhow::Result<()> {
        let now = "2026-08-15T01:00:00.000Z";
        assert_eq!(
            count_stale_proposals(conn, "project-1", now)?,
            expected_count
        );
        let entries = build_maintenance_inbox(conn, "project-1", now)?;
        let visible_keys: Vec<_> = entries
            .iter()
            .map(|entry| entry.consumer_key.as_str())
            .collect();
        assert_eq!(visible_keys, expected_visible_keys);
        assert!(entries.iter().all(|entry| !entry.is_snoozed_and_active));
        Ok(())
    }

    fn assert_proposal_is_hidden(conn: &Connection, finding_key: &str) -> anyhow::Result<()> {
        let observations = list_observations_for_epoch(
            conn,
            "project-1",
            &get_current_epoch(conn, "project-1")?
                .expect("current epoch")
                .id,
            finding_key,
        )?;
        let (active_observations, has_unresolved_identity, _) =
            active_finding_observations(conn, "project-1", &observations)?;
        let attention = get_attention(conn, "project-1", finding_key)?;
        assert!(snooze_hides_consumer(
            &active_observations,
            has_unresolved_identity,
            attention.as_ref(),
            "2026-08-15T01:00:00.000Z",
        ));
        let entries = build_maintenance_inbox(conn, "project-1", "2026-08-15T01:00:00.000Z")?;
        assert!(entries.iter().all(|entry| entry.finding_key != finding_key));
        Ok(())
    }

    #[test]
    fn snooze_hides_only_when_disposition_is_snoozed() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            let hidden = seed_snoozed_proposal_for_test(
                conn,
                &epoch_id,
                "item-0001",
                &["edge-0001"],
                "2026-09-01T00:00:00.000Z",
                None,
            )?;
            for (key, edge, disposition) in [
                ("item-0002", "edge-0002", AttentionDisposition::Dismissed),
                ("item-0003", "edge-0003", AttentionDisposition::Flagged),
            ] {
                let finding_key = seed_snoozed_proposal_for_test(
                    conn,
                    &epoch_id,
                    key,
                    &[edge],
                    "2026-09-01T00:00:00.000Z",
                    None,
                )?;
                let basis = test_material_basis(
                    edge,
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                );
                set_attention_for_test(
                    conn,
                    "project-1",
                    &finding_key,
                    disposition,
                    &basis,
                    None,
                    "2026-08-15T00:40:00.000Z",
                    Some("test-actor"),
                )?;
            }
            assert_proposal_is_hidden(conn, &hidden)?;
            assert_snooze_test_outputs(conn, 2, &["item-0002", "item-0003"])
        })
        .expect("with_conn");
    }

    #[test]
    fn snooze_requires_at_least_one_active_observation() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            let hidden = seed_snoozed_proposal_for_test(
                conn,
                &epoch_id,
                "item-0001",
                &["edge-0001"],
                "2026-09-01T00:00:00.000Z",
                None,
            )?;
            let empty = seed_snoozed_proposal_for_test(
                conn,
                &epoch_id,
                "item-0002",
                &[],
                "2026-09-01T00:00:00.000Z",
                None,
            )?;
            let identity = stable_finding_identity(
                BUNDLED_FINDING_RULE_ID,
                BUNDLED_FINDING_RULE_VERSION,
                "edge-0002",
            )?;
            conn.execute(
                "UPDATE narrative_maintenance_attention
                    SET finding_identity = ?1, identity_resolution_status = 'resolved'
                  WHERE project_id = 'project-1' AND finding_key = ?2",
                params![identity, empty],
            )?;
            assert_proposal_is_hidden(conn, &hidden)?;
            assert_snooze_test_outputs(conn, 1, &["item-0002"])
        })
        .expect("with_conn");
    }

    #[test]
    fn snooze_rejects_mixed_resolved_and_unresolved_identities() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            let hidden = seed_snoozed_proposal_for_test(
                conn,
                &epoch_id,
                "item-0001",
                &["edge-0001"],
                "2026-09-01T00:00:00.000Z",
                None,
            )?;
            let mixed = seed_snoozed_proposal_for_test(
                conn,
                &epoch_id,
                "item-0002",
                &["edge-0002"],
                "2026-09-01T00:00:00.000Z",
                None,
            )?;
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-item-0002-unresolved",
                &epoch_id,
                Some("edge-0002"),
                &mixed,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                &test_material_basis(
                    "edge-0002",
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                ),
                "2026-08-15T00:00:02.000Z",
            )?;
            conn.execute(
                "UPDATE narrative_maintenance_finding_observations
                    SET finding_identity = NULL
                  WHERE project_id = 'project-1' AND run_id = 'run-item-0002-unresolved'",
                [],
            )?;
            assert_proposal_is_hidden(conn, &hidden)?;
            assert_snooze_test_outputs(conn, 1, &["item-0002"])
        })
        .expect("with_conn");
    }

    #[test]
    fn snooze_requires_resolved_attention_identity_status() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            let hidden = seed_snoozed_proposal_for_test(
                conn,
                &epoch_id,
                "item-0001",
                &["edge-0001"],
                "2026-09-01T00:00:00.000Z",
                None,
            )?;
            let unresolved = seed_snoozed_proposal_for_test(
                conn,
                &epoch_id,
                "item-0002",
                &["edge-0002"],
                "2026-09-01T00:00:00.000Z",
                None,
            )?;
            conn.execute(
                "UPDATE narrative_maintenance_attention
                    SET identity_resolution_status = 'legacy-unresolved'
                  WHERE project_id = 'project-1' AND finding_key = ?1",
                params![unresolved],
            )?;
            assert_proposal_is_hidden(conn, &hidden)?;
            assert_snooze_test_outputs(conn, 1, &["item-0002"])
        })
        .expect("with_conn");
    }

    #[test]
    fn snooze_requires_matching_identity_and_applicable_material_basis() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            let hidden = seed_snoozed_proposal_for_test(
                conn,
                &epoch_id,
                "item-0001",
                &["edge-0001"],
                "2026-09-01T00:00:00.000Z",
                None,
            )?;
            let sibling = seed_snoozed_proposal_for_test(
                conn,
                &epoch_id,
                "item-0002",
                &["edge-0002", "edge-0003"],
                "2026-09-01T00:00:00.000Z",
                None,
            )?;
            let attention_basis = test_material_basis(
                "edge-0002",
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
            );
            conn.execute(
                "UPDATE narrative_maintenance_finding_observations
                    SET material_basis_digest = ?1
                  WHERE project_id = 'project-1' AND run_id = 'run-item-0002-1'",
                params![attention_basis],
            )?;
            let expired = seed_snoozed_proposal_for_test(
                conn,
                &epoch_id,
                "item-0003",
                &["edge-0004"],
                "2026-08-15T00:30:00.000Z",
                None,
            )?;
            let changed_basis = seed_snoozed_proposal_for_test(
                conn,
                &epoch_id,
                "item-0004",
                &["edge-0005"],
                "2026-09-01T00:00:00.000Z",
                Some("sha256:old-material-basis"),
            )?;
            assert_proposal_is_hidden(conn, &hidden)?;
            assert_snooze_test_outputs(conn, 3, &["item-0002", "item-0003", "item-0004"])?;
            for finding_key in [&sibling, &expired, &changed_basis] {
                let entry = build_maintenance_inbox(conn, "project-1", "2026-08-15T01:00:00.000Z")?
                    .into_iter()
                    .find(|entry| entry.finding_key == *finding_key)
                    .expect("inapplicable snooze remains visible");
                assert!(!entry.is_snoozed_and_active);
            }
            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn count_stale_proposals_handles_snoozes_siblings_expiry_and_missing_epoch() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            let consumer_kind = "proposal-revision";
            let consumer_key = "item-0001";
            let finding_key = "proposal-revision:item-0001";
            seed_consumer_freshness(
                conn,
                "project-1",
                consumer_kind,
                consumer_key,
                "stale",
                "rebuild-required",
                &epoch_id,
                "2026-08-15T00:00:00.000Z",
            );
            let first_basis = test_material_basis(
                "edge-a",
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
            );
            seed_dependency_edge(conn, "edge-a", "project-1", consumer_kind, consumer_key);
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-a",
                &epoch_id,
                Some("edge-a"),
                finding_key,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                &first_basis,
                "2026-08-15T00:00:01.000Z",
            )?;
            set_attention_for_test(
                conn,
                "project-1",
                finding_key,
                AttentionDisposition::Snoozed,
                &first_basis,
                Some("2026-08-15T02:00:00.000Z"),
                "2026-08-15T00:00:02.000Z",
                Some("test-actor"),
            )?;
            let now = "2026-08-15T01:00:00.000Z";
            assert_eq!(count_stale_proposals(conn, "project-1", now)?, 0);
            assert_eq!(
                maintenance_health_summary(conn, "project-1", now)?.proposals_checked,
                0
            );

            let sibling_basis = test_material_basis(
                "edge-b",
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
            );
            seed_dependency_edge(conn, "edge-b", "project-1", consumer_kind, consumer_key);
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-b",
                &epoch_id,
                Some("edge-b"),
                finding_key,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                &sibling_basis,
                "2026-08-15T00:00:03.000Z",
            )?;
            assert_eq!(count_stale_proposals(conn, "project-1", now)?, 1);
            let summary = maintenance_health_summary(conn, "project-1", now)?;
            assert_eq!(summary.proposals_checked, 1);
            assert_eq!(summary.proposals_stale, 1);

            set_attention_for_test(
                conn,
                "project-1",
                finding_key,
                AttentionDisposition::Snoozed,
                &first_basis,
                Some("2026-08-15T00:30:00.000Z"),
                "2026-08-15T00:00:04.000Z",
                Some("test-actor"),
            )?;
            assert_eq!(count_stale_proposals(conn, "project-1", now)?, 1);

            seed_snoozed_proposal_for_test(
                conn,
                &epoch_id,
                "item-fresh",
                &["edge-fresh"],
                "2026-08-15T02:00:00.000Z",
                None,
            )?;
            conn.execute(
                "UPDATE narrative_consumer_freshness SET evidence_freshness = 'fresh'
                  WHERE project_id = 'project-1' AND consumer_key = 'item-fresh'",
                [],
            )?;
            let summary = maintenance_health_summary(conn, "project-1", now)?;
            assert_eq!(summary.proposals_checked, 1);
            assert_eq!(summary.proposals_stale, 1);

            set_attention_for_test(
                conn,
                "project-1",
                "proposal-revision:item-fresh",
                AttentionDisposition::Snoozed,
                &test_material_basis(
                    "edge-fresh",
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                ),
                Some("2026-08-15T00:30:00.000Z"),
                "2026-08-15T00:00:05.000Z",
                Some("test-actor"),
            )?;
            assert_eq!(
                maintenance_health_summary(conn, "project-1", now)?.proposals_checked,
                2
            );
            Ok(())
        })
        .expect("with_conn");

        let no_epoch_db = test_db();
        no_epoch_db
            .with_conn(|conn| {
                assert_eq!(
                    count_stale_proposals(conn, "project-1", "2026-08-15T01:00:00.000Z")?,
                    0
                );
                assert_eq!(
                    maintenance_health_summary(conn, "project-1", "2026-08-15T01:00:00.000Z")?,
                    FreshnessSummaryCounts::default().into_summary(0)
                );
                Ok(())
            })
            .expect("with_conn");
    }

    #[test]
    #[ignore = "manual 50k-consumer file DB timing; run only below load average 4"]
    fn count_stale_proposals_scales_with_snoozed_consumers() {
        let load_average = std::fs::read_to_string("/proc/loadavg")
            .ok()
            .and_then(|value| value.split_whitespace().next()?.parse::<f64>().ok())
            .unwrap_or(f64::INFINITY);
        if load_average >= 4.0 {
            eprintln!("timing skipped: load average {load_average:.2} is not below 4");
            return;
        }

        let path = std::env::temp_dir().join(format!(
            "grimodex-inbox-count-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let db = Database::new(&path).expect("file DB");
        db.migrate().expect("migrate file DB");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            Ok(())
        })
        .expect("seed project");
        let epoch_id = db
            .with_conn(|conn| create_epoch_in_tx(conn, "project-1", "initial", None))
            .expect("seed epoch");
        db.with_conn_mut(|conn| {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            {
                let mut insert = conn.prepare(
                    "INSERT INTO narrative_consumer_freshness
                        (project_id, consumer_kind, consumer_key, evidence_freshness, build_action,
                         semantic_epoch_id, last_evaluated_run_id, updated_at)
                     VALUES ('project-1', ?1, ?2, ?3, 'rebuild-required', ?4, NULL,
                             '2026-08-15T00:00:00.000Z')",
                )?;
                for index in 0..50_000 {
                    let kind = if index % 10 < 7 {
                        "proposal-revision"
                    } else {
                        "other-kind"
                    };
                    let freshness = if index % 100 < 28 { "stale" } else { "fresh" };
                    insert.execute(params![
                        kind,
                        format!("item-{index:05}"),
                        freshness,
                        epoch_id
                    ])?;
                }
            }
            conn.execute_batch("COMMIT")?;
            Ok(())
        })
        .expect("seed 50k Consumers");
        // Give every proposal Consumer its proposal and revision, so the
        // rejected / replaced exclusion does real lookups. About one in forty
        // is rejected and one in forty is replaced; scenes cycle over 300.
        db.with_conn_mut(|conn| {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            for index in (0..50_000).filter(|index| index % 10 < 7) {
                let key = format!("item-{index:05}");
                let envelope = format!(
                    r#"{{"effectiveMaterialBasis":{{"evidenceSet":[{{"sourceKey":"project:scene:scene-{:03}"}}]}}}}"#,
                    index % 300
                );
                seed_proposal_revision_for_test(conn, "project-1", &key, Some(&envelope))?;
                let proposal_id = format!("proposal-{key}");
                match index % 40 {
                    3 => {
                        conn.execute(
                            "UPDATE narrative_proposals SET status = 'rejected' WHERE id = ?1",
                            params![proposal_id],
                        )?;
                    }
                    5 => {
                        conn.execute(
                            "UPDATE narrative_proposals SET current_revision_id = 'later'
                              WHERE id = ?1",
                            params![proposal_id],
                        )?;
                    }
                    _ => {}
                }
            }
            conn.execute_batch("COMMIT")?;
            Ok(())
        })
        .expect("seed proposals");
        for index in (0..50_000).step_by(10) {
            let finding_key = format!("proposal-revision:item-{index:05}");
            let disposition = if (index / 10) % 2 == 0 {
                AttentionDisposition::Snoozed
            } else {
                AttentionDisposition::Flagged
            };
            db.with_conn(|conn| {
                set_attention_for_test(
                    conn,
                    "project-1",
                    &finding_key,
                    disposition,
                    "benchmark-basis",
                    (disposition == AttentionDisposition::Snoozed)
                        .then_some("2026-08-15T02:00:00.000Z"),
                    "2026-08-15T00:00:00.000Z",
                    Some("benchmark"),
                )?;
                Ok(())
            })
            .expect("seed Attention");
        }

        let now = "2026-08-15T01:00:00.000Z";
        let started = std::time::Instant::now();
        let counted = db
            .with_conn(|conn| count_stale_proposals(conn, "project-1", now))
            .expect("count");
        let count_elapsed = started.elapsed();
        let started = std::time::Instant::now();
        let summary = db
            .with_conn(|conn| maintenance_health_summary(conn, "project-1", now))
            .expect("health summary");
        let summary_elapsed = started.elapsed();
        assert_eq!(summary.proposals_stale, counted);
        let started = std::time::Instant::now();
        let scenes = db
            .with_conn(|conn| stale_proposal_scenes(conn, "project-1", now, None, Some(200)))
            .expect("scene counts");
        let scenes_elapsed = started.elapsed();
        eprintln!(
            "stale_proposal_scenes first page={} without_scene={} in {} ms",
            scenes.scenes.len(),
            scenes.without_scene_count,
            scenes_elapsed.as_millis()
        );
        let started = std::time::Instant::now();
        let inbox_count = db
            .with_conn(|conn| build_maintenance_inbox(conn, "project-1", now))
            .expect("build Inbox")
            .len();
        let inbox_elapsed = started.elapsed();
        eprintln!(
            "count_stale_proposals={} in {} ms; maintenance_health_summary={} in {} ms; build_maintenance_inbox_rows={} in {} ms; summary_ratio={:.3}",
            counted,
            count_elapsed.as_millis(),
            summary.proposals_stale,
            summary_elapsed.as_millis(),
            inbox_count,
            inbox_elapsed.as_millis(),
            summary_elapsed.as_secs_f64() / inbox_elapsed.as_secs_f64()
        );
        drop(db);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn fresh_consumer_without_attention_is_visible_with_no_observation_or_attention() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            seed_consumer_freshness(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "fresh",
                "none",
                &epoch_id,
                "2026-08-15T00:00:00.000Z",
            );

            let entries = build_maintenance_inbox(conn, "project-1", "2026-08-15T01:00:00.000Z")?;
            assert_eq!(entries.len(), 1);
            let entry = &entries[0];
            assert_eq!(entry.consumer_kind, "proposal");
            assert_eq!(entry.consumer_key, "proposal-1");
            assert_eq!(entry.evidence_freshness.as_deref(), Some("fresh"));
            assert_eq!(entry.build_action.as_deref(), Some("none"));
            assert_eq!(entry.finding_key, "proposal:proposal-1");
            assert!(entry.latest_observation.is_none());
            assert!(entry.attention.is_none());
            assert!(!entry.is_snoozed_and_active);
            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn stale_consumer_surfaces_the_latest_finding_observation_content() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            seed_consumer_freshness(
                conn,
                "project-1",
                "codex-entry",
                "entry-1",
                "stale",
                "rebuild-required",
                &epoch_id,
                "2026-08-15T00:00:00.000Z",
            );
            let finding_key = "codex-entry:entry-1";
            seed_dependency_edge(conn, "edge-1", "project-1", "codex-entry", "entry-1");

            // Two observations recorded against the same finding_key; the
            // later one (by observed_at) must win as "latest".
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-1",
                &epoch_id,
                Some("edge-1"),
                finding_key,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                &test_material_basis(
                    "edge-1",
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                ),
                "2026-08-15T00:00:01.000Z",
            )?;
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-2",
                &epoch_id,
                Some("edge-1"),
                finding_key,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                &test_material_basis(
                    "edge-1",
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                ),
                "2026-08-15T00:00:02.000Z",
            )?;

            let entries = build_maintenance_inbox(conn, "project-1", "2026-08-15T01:00:00.000Z")?;
            assert_eq!(entries.len(), 1);
            let observation = entries[0]
                .latest_observation
                .as_ref()
                .expect("latest observation present");
            assert_eq!(
                observation.material_basis_digest,
                test_material_basis(
                    "edge-1",
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                )
            );
            assert_eq!(observation.run_id, "run-2");
            assert!(entries[0].attention.is_none());
            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn active_unexpired_snooze_excludes_the_consumer_from_the_inbox() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            seed_consumer_freshness(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "stale",
                "rebuild-required",
                &epoch_id,
                "2026-08-15T00:00:00.000Z",
            );
            let finding_key = "proposal:proposal-1";
            seed_dependency_edge(conn, "edge-1", "project-1", "proposal", "proposal-1");
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-1",
                &epoch_id,
                Some("edge-1"),
                finding_key,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                &test_material_basis(
                    "edge-1",
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                ),
                "2026-08-15T00:00:01.000Z",
            )?;
            set_attention_for_test(
                conn,
                "project-1",
                finding_key,
                AttentionDisposition::Snoozed,
                &test_material_basis(
                    "edge-1",
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                ),
                Some("2026-09-01T00:00:00.000Z"),
                "2026-08-15T00:30:00.000Z",
                Some("user-1"),
            )?;

            let entries = build_maintenance_inbox(conn, "project-1", "2026-08-15T01:00:00.000Z")?;
            assert!(
                entries.is_empty(),
                "an active, unexpired snooze must hide the consumer entirely"
            );
            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn active_snooze_leaves_an_uncovered_active_sibling_visible() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            seed_consumer_freshness(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "stale",
                "rebuild-required",
                &epoch_id,
                "2026-08-15T00:00:00.000Z",
            );
            let finding_key = "proposal:proposal-1";
            let edge_a_basis = test_material_basis(
                "edge-a",
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
            );
            let edge_b_basis = test_material_basis(
                "edge-b",
                FindingReasonCode::SourceMissing,
                EvidenceFreshness::SourceMissing,
            );
            seed_dependency_edge(conn, "edge-a", "project-1", "proposal", "proposal-1");
            seed_dependency_edge(conn, "edge-b", "project-1", "proposal", "proposal-1");
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-a",
                &epoch_id,
                Some("edge-a"),
                finding_key,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                &edge_a_basis,
                "2026-08-15T00:00:01.000Z",
            )?;
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-b",
                &epoch_id,
                Some("edge-b"),
                finding_key,
                FindingReasonCode::SourceMissing,
                EvidenceFreshness::SourceMissing,
                &edge_b_basis,
                "2026-08-15T00:00:02.000Z",
            )?;
            set_attention_for_test(
                conn,
                "project-1",
                finding_key,
                AttentionDisposition::Snoozed,
                &edge_a_basis,
                Some("2026-09-01T00:00:00.000Z"),
                "2026-08-15T00:30:00.000Z",
                Some("user-1"),
            )?;

            let entries = build_maintenance_inbox(conn, "project-1", "2026-08-15T01:00:00.000Z")?;
            assert_eq!(
                entries.len(),
                1,
                "Edge B's active Finding must remain visible"
            );
            assert_eq!(
                entries[0]
                    .latest_observation
                    .as_ref()
                    .and_then(|observation| observation.edge_id.as_deref()),
                Some("edge-b")
            );
            assert!(!entries[0].is_snoozed_and_active);

            // A historical sibling that has since been explicitly resolved
            // must not keep the Consumer visible forever.
            let edge_b_identity = stable_finding_identity(
                BUNDLED_FINDING_RULE_ID,
                BUNDLED_FINDING_RULE_VERSION,
                "edge-b",
            )?;
            record_finding_lifecycle_in_tx(
                conn,
                FindingLifecycleWrite {
                    project_id: "project-1",
                    finding_identity: &edge_b_identity,
                    finding_key,
                    rule_id: BUNDLED_FINDING_RULE_ID,
                    rule_version: BUNDLED_FINDING_RULE_VERSION,
                    state: FindingLifecycleState::Resolved,
                    observation_digest: None,
                    material_basis_digest: Some(&edge_b_basis),
                    run_id: "run-b-resolved",
                    semantic_epoch_id: &epoch_id,
                    observed_at: "2026-08-15T00:00:03.000Z",
                },
            )?;

            let entries = build_maintenance_inbox(conn, "project-1", "2026-08-15T01:00:00.000Z")?;
            assert!(
                entries.is_empty(),
                "a resolved sibling must not block an otherwise applicable snooze"
            );

            // With the snooze lapsed, the display-ready observation must be
            // the newest still-active Finding (Edge A), not the newer but
            // already-resolved Edge B observation.
            set_attention_for_test(
                conn,
                "project-1",
                finding_key,
                AttentionDisposition::Snoozed,
                &edge_a_basis,
                Some("2026-08-01T00:00:00.000Z"),
                "2026-08-15T00:00:03.500Z",
                Some("user-1"),
            )?;
            let entries = build_maintenance_inbox(conn, "project-1", "2026-08-15T01:00:00.000Z")?;
            assert_eq!(entries.len(), 1);
            assert_eq!(
                entries[0]
                    .latest_observation
                    .as_ref()
                    .and_then(|observation| observation.edge_id.as_deref()),
                Some("edge-a"),
                "resolved Edge B history must not be presented as the current observation"
            );

            // If a newer Observation appears without its corresponding
            // lifecycle transition, stale resolution evidence must not hide
            // it. This fail-open path also protects partially migrated or
            // otherwise incomplete diagnostic history.
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-b-reobserved",
                &epoch_id,
                Some("edge-b"),
                finding_key,
                FindingReasonCode::SourceMissing,
                EvidenceFreshness::SourceMissing,
                &edge_b_basis,
                "2026-08-15T00:00:04.000Z",
            )?;
            let entries = build_maintenance_inbox(conn, "project-1", "2026-08-15T01:00:00.000Z")?;
            assert_eq!(
                entries.len(),
                1,
                "a newer Observation without lifecycle proof must remain visible"
            );
            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn expired_snooze_resurfaces_the_consumer_and_keeps_the_attention_row() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            seed_consumer_freshness(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "stale",
                "rebuild-required",
                &epoch_id,
                "2026-08-15T00:00:00.000Z",
            );
            let finding_key = "proposal:proposal-1";
            seed_dependency_edge(conn, "edge-1", "project-1", "proposal", "proposal-1");
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-1",
                &epoch_id,
                Some("edge-1"),
                finding_key,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                &test_material_basis(
                    "edge-1",
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                ),
                "2026-08-15T00:00:01.000Z",
            )?;
            set_attention_for_test(
                conn,
                "project-1",
                finding_key,
                AttentionDisposition::Snoozed,
                &test_material_basis(
                    "edge-1",
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                ),
                Some("2026-08-01T00:00:00.000Z"), // already in the past
                "2026-07-01T00:00:00.000Z",
                Some("user-1"),
            )?;

            let now = "2026-08-15T01:00:00.000Z";
            let entries = build_maintenance_inbox(conn, "project-1", now)?;
            assert_eq!(
                entries.len(),
                1,
                "a lapsed snooze must resurface the consumer"
            );
            let entry = &entries[0];
            assert!(!entry.is_snoozed_and_active);
            let attention = entry.attention.as_ref().expect("attention row retained");
            assert_eq!(attention.disposition, AttentionDisposition::Snoozed);
            assert_eq!(
                attention.snoozed_until.as_deref(),
                Some("2026-08-01T00:00:00.000Z"),
                "the lapsed row must be surfaced exactly as stored, not rewritten"
            );
            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn snoozed_with_digest_mismatch_is_treated_as_inapplicable_and_resurfaces() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            seed_consumer_freshness(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "stale",
                "rebuild-required",
                &epoch_id,
                "2026-08-15T00:00:00.000Z",
            );
            let finding_key = "proposal:proposal-1";
            // The Attention row was set against an older observed digest;
            // a newer observation with a different digest has since landed
            // in the current epoch, so the finding is no longer the same
            // material basis the human dismissed via snooze.
            seed_dependency_edge(conn, "edge-1", "project-1", "proposal", "proposal-1");
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-1",
                &epoch_id,
                Some("edge-1"),
                finding_key,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                &test_material_basis(
                    "edge-1",
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                ),
                "2026-08-15T00:00:01.000Z",
            )?;
            set_attention_for_test(
                conn,
                "project-1",
                finding_key,
                AttentionDisposition::Snoozed,
                "sha256:digest-old",
                Some("2026-12-01T00:00:00.000Z"), // still far in the future
                "2026-07-01T00:00:00.000Z",
                None,
            )?;

            let entries = build_maintenance_inbox(conn, "project-1", "2026-08-15T01:00:00.000Z")?;
            assert_eq!(
                entries.len(),
                1,
                "a digest mismatch must resurface the consumer even with a future snoozed_until"
            );
            assert!(!entries[0].is_snoozed_and_active);
            assert!(entries[0].attention.is_some());
            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn prior_epoch_finding_observation_is_ignored_after_epoch_rotation() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_0 = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            let finding_key = "proposal:proposal-1";
            seed_dependency_edge(conn, "edge-1", "project-1", "proposal", "proposal-1");
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-1",
                &epoch_0,
                Some("edge-1"),
                finding_key,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                &test_material_basis(
                    "edge-1",
                    FindingReasonCode::SourceRevisionChanged,
                    EvidenceFreshness::Stale,
                ),
                "2026-08-01T00:00:00.000Z",
            )?;

            // Epoch rotates (e.g. a restore) -- a new epoch becomes current,
            // and the Consumer's Freshness row now points at it.
            let epoch_1 = create_epoch_in_tx(conn, "project-1", "restore", None)?;
            seed_consumer_freshness(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "unknown",
                "resolve-only",
                &epoch_1,
                "2026-08-15T00:00:00.000Z",
            );

            let entries = build_maintenance_inbox(conn, "project-1", "2026-08-15T01:00:00.000Z")?;
            assert_eq!(entries.len(), 1);
            assert!(
                entries[0].latest_observation.is_none(),
                "a Finding Observation recorded under a superseded epoch must not surface"
            );
            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn dismissed_and_flagged_attention_do_not_hide_the_consumer() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            seed_consumer_freshness(
                conn,
                "project-1",
                "proposal",
                "proposal-1",
                "stale",
                "rebuild-required",
                &epoch_id,
                "2026-08-15T00:00:00.000Z",
            );
            seed_consumer_freshness(
                conn,
                "project-1",
                "codex-entry",
                "entry-1",
                "stale",
                "rebuild-required",
                &epoch_id,
                "2026-08-15T00:00:00.000Z",
            );
            set_attention_for_test(
                conn,
                "project-1",
                "proposal:proposal-1",
                AttentionDisposition::Dismissed,
                "sha256:whatever-1",
                None,
                "2026-08-15T00:00:00.000Z",
                Some("user-1"),
            )?;
            set_attention_for_test(
                conn,
                "project-1",
                "codex-entry:entry-1",
                AttentionDisposition::Flagged,
                "sha256:whatever-2",
                None,
                "2026-08-15T00:00:00.000Z",
                Some("user-1"),
            )?;

            let entries = build_maintenance_inbox(conn, "project-1", "2026-08-15T01:00:00.000Z")?;
            assert_eq!(
                entries.len(),
                2,
                "dismissed and flagged dispositions must never hide a consumer"
            );
            assert!(entries.iter().all(|entry| !entry.is_snoozed_and_active));
            let dismissed_entry = entries
                .iter()
                .find(|entry| entry.consumer_kind == "proposal")
                .expect("proposal entry present");
            assert_eq!(
                dismissed_entry
                    .attention
                    .as_ref()
                    .expect("attention present")
                    .disposition,
                AttentionDisposition::Dismissed
            );
            let flagged_entry = entries
                .iter()
                .find(|entry| entry.consumer_kind == "codex-entry")
                .expect("codex-entry present");
            assert_eq!(
                flagged_entry
                    .attention
                    .as_ref()
                    .expect("attention present")
                    .disposition,
                AttentionDisposition::Flagged
            );
            Ok(())
        })
        .expect("with_conn");
    }

    #[test]
    fn no_current_epoch_returns_an_empty_inbox() {
        let db = test_db();
        let entries = db
            .with_conn(|conn| {
                build_maintenance_inbox(conn, "project-1", "2026-08-15T01:00:00.000Z")
            })
            .expect("build inbox with no epoch");
        assert!(entries.is_empty());
    }

    /// Direct verification of the "Read time にAttention rowを自動更新しない"
    /// contract: calling `build_maintenance_inbox` -- including in the
    /// snoozed-and-hidden path, the expired-and-resurfaced path, and the
    /// dismissed/flagged path all at once -- must leave every column of
    /// every `narrative_maintenance_attention` row byte-for-byte identical
    /// to what it was before the call.
    #[test]
    fn build_maintenance_inbox_never_mutates_attention_rows() {
        let db = test_db();
        db.with_conn(|conn| {
            let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
            for (kind, key) in [
                ("proposal", "proposal-1"),
                ("codex-entry", "entry-1"),
                ("codex-entry", "entry-2"),
            ] {
                seed_consumer_freshness(
                    conn,
                    "project-1",
                    kind,
                    key,
                    "stale",
                    "rebuild-required",
                    &epoch_id,
                    "2026-08-15T00:00:00.000Z",
                );
            }
            // Active, unexpired snooze -- would be hidden from the Inbox.
            set_attention_for_test(
                conn,
                "project-1",
                "proposal:proposal-1",
                AttentionDisposition::Snoozed,
                "sha256:digest-a",
                Some("2026-09-01T00:00:00.000Z"),
                "2026-08-15T00:00:00.000Z",
                Some("user-1"),
            )?;
            // Lapsed snooze -- would resurface.
            set_attention_for_test(
                conn,
                "project-1",
                "codex-entry:entry-1",
                AttentionDisposition::Snoozed,
                "sha256:digest-b",
                Some("2026-08-01T00:00:00.000Z"),
                "2026-07-01T00:00:00.000Z",
                Some("user-2"),
            )?;
            // Dismissed -- always surfaced.
            set_attention_for_test(
                conn,
                "project-1",
                "codex-entry:entry-2",
                AttentionDisposition::Dismissed,
                "sha256:digest-c",
                None,
                "2026-08-14T00:00:00.000Z",
                None,
            )?;

            // (project_id, finding_key, disposition, material_basis_digest,
            // snoozed_until, set_at, actor_id, version) --
            // clippy::type_complexity.
            type AttentionRow = (
                String,
                String,
                String,
                String,
                Option<String>,
                String,
                String,
                i64,
            );

            let snapshot_before: Vec<AttentionRow> = conn
                .prepare(
                    "SELECT project_id, finding_key, disposition, material_basis_digest,
                            snoozed_until, set_at, actor_id, version
                       FROM narrative_maintenance_attention
                      ORDER BY finding_key ASC",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            assert_eq!(snapshot_before.len(), 3, "sanity: all three rows seeded");

            let entries = build_maintenance_inbox(conn, "project-1", "2026-08-15T01:00:00.000Z")?;
            // Sanity on the read model's own visible-entries behavior,
            // alongside (not instead of) the no-mutation assertion below.
            assert_eq!(
                entries.len(),
                3,
                "unresolved Attention is never silently inherited, so all three consumers surface"
            );

            let snapshot_after: Vec<AttentionRow> = conn
                .prepare(
                    "SELECT project_id, finding_key, disposition, material_basis_digest,
                            snoozed_until, set_at, actor_id, version
                       FROM narrative_maintenance_attention
                      ORDER BY finding_key ASC",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;

            assert_eq!(
                snapshot_before, snapshot_after,
                "build_maintenance_inbox must not mutate narrative_maintenance_attention, \
                 including for hidden (active-snooze), resurfaced (lapsed-snooze), and \
                 dismissed rows"
            );
            Ok(())
        })
        .expect("with_conn");
    }
}
