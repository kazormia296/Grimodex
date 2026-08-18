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
//! - `disposition == Snoozed` and still applicable
//!   ([`attention::is_attention_applicable`] returns `true`, i.e. the
//!   Attention row's `material_basis_digest` still matches the current
//!   evidence *and* `snoozed_until` is still in the future) -- the Consumer
//!   is **excluded** from the returned Vec entirely. This is what "snoozed"
//!   means: temporarily hidden.
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
//! `is_attention_applicable` for a Snoozed row is the current epoch's
//! latest Finding Observation's `material_basis_digest` when one exists
//! (the freshest available evidence of what the finding actually is right
//! now), falling back to the Attention row's own stored digest when there
//! is no Finding Observation to compare against (e.g. a Consumer that has
//! never produced a diagnostic Finding in the current epoch) -- in that
//! fallback case the digest trivially matches itself, so the decision
//! collapses to `snooze-not-expired` alone, which is the only signal
//! available.
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

use super::attention::{
    get_attention, is_attention_applicable, AttentionDisposition, AttentionRow,
};
use super::consumer_identity::consumer_finding_key;
use super::evaluator::{BuildAction, EvidenceFreshness};
use super::finding_observation::{list_observations_for_epoch, FindingObservationRow};
use super::semantic_epoch::get_current_epoch;

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
    pub consumer_kind: String,
    pub consumer_key: String,
    pub evidence_freshness: String,
    pub build_action: String,
    pub finding_key: String,
    pub latest_observation: Option<FindingObservationRow>,
    pub attention: Option<AttentionRow>,
    pub is_snoozed_and_active: bool,
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
/// an active, unexpired snooze (see module doc). Returns an empty Vec when
/// `project_id` has no current Semantic Epoch yet.
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
        // module doc, "Epoch invalidation"). `list_observations_for_epoch`
        // returns oldest-first, so the last element is the latest.
        let latest_observation =
            list_observations_for_epoch(conn, project_id, &current_epoch.id, &finding_key)?.pop();

        // Pure read; never mutates or clears a lapsed row (attention.rs's
        // own contract).
        let attention = get_attention(conn, project_id, &finding_key)?;

        let is_snoozed_and_active = match &attention {
            Some(attention_row) if attention_row.disposition == AttentionDisposition::Snoozed => {
                // Prefer the freshest evidence's digest when one exists;
                // fall back to the Attention row's own digest otherwise
                // (module doc, "Snooze expiry" section).
                let current_material_basis_digest = latest_observation
                    .as_ref()
                    .map(|observation| observation.material_basis_digest.as_str())
                    .unwrap_or(attention_row.material_basis_digest.as_str());
                is_attention_applicable(attention_row, current_material_basis_digest, now)
            }
            // Dismissed/Flagged never hide the entry; no Attention row at
            // all obviously does not either.
            _ => false,
        };

        if is_snoozed_and_active {
            // Active, unexpired snooze: hidden from the Inbox entirely.
            continue;
        }

        entries.push(InboxEntry {
            consumer_kind: row.consumer_kind,
            consumer_key: row.consumer_key,
            evidence_freshness: row.evidence_freshness.as_str().to_string(),
            build_action: row.build_action.as_str().to_string(),
            finding_key,
            latest_observation,
            attention,
            is_snoozed_and_active,
        });
    }

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
    use crate::narrative_extraction::finding_observation::record_finding_observation_in_tx;
    use crate::narrative_extraction::semantic_epoch::create_epoch_in_tx;
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
    use std::path::Path;

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
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
            assert_eq!(entry.evidence_freshness, "fresh");
            assert_eq!(entry.build_action, "none");
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
                "sha256:first",
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
                "sha256:second",
                "2026-08-15T00:00:02.000Z",
            )?;

            let entries = build_maintenance_inbox(conn, "project-1", "2026-08-15T01:00:00.000Z")?;
            assert_eq!(entries.len(), 1);
            let observation = entries[0]
                .latest_observation
                .as_ref()
                .expect("latest observation present");
            assert_eq!(observation.material_basis_digest, "sha256:second");
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
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-1",
                &epoch_id,
                None,
                finding_key,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                "sha256:digest-a",
                "2026-08-15T00:00:01.000Z",
            )?;
            set_attention_for_test(
                conn,
                "project-1",
                finding_key,
                AttentionDisposition::Snoozed,
                "sha256:digest-a",
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
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-1",
                &epoch_id,
                None,
                finding_key,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                "sha256:digest-a",
                "2026-08-15T00:00:01.000Z",
            )?;
            set_attention_for_test(
                conn,
                "project-1",
                finding_key,
                AttentionDisposition::Snoozed,
                "sha256:digest-a",
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
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-1",
                &epoch_id,
                None,
                finding_key,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                "sha256:digest-new",
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
            record_finding_observation_in_tx(
                conn,
                "project-1",
                "run-1",
                &epoch_0,
                None,
                finding_key,
                FindingReasonCode::SourceRevisionChanged,
                EvidenceFreshness::Stale,
                "sha256:old-epoch",
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
                2,
                "one consumer hidden by an active snooze, two surfaced"
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
