//! Attention Typed Writer for `narrative_maintenance_attention`.
//!
//! Gate C2 Lane D. Per
//! `policies/narrative/maintenance-attention-contract.json` this storage is
//! `durable-user-state`, `epochBinding: "none"`, and `backflowPolicy:
//! "forbid"` — this module is the sole typed writer for the table and must
//! never touch the Change Feed (`change_events`/`narrative_change_*`).
//! `narrative_maintenance_attention` is registered in
//! `policies/narrative/change-feed-writers.json`'s `EXCLUSION_REASONS` as
//! `non-backflow-invariant`: Run publish, Finding Observation writes, and
//! epoch rotation must never mutate these rows; only this writer sets or
//! clears them.
//!
//! Reads never mutate. [`get_attention`] returns the row exactly as stored,
//! even after a snooze has lapsed (`snoozed_until <= now`) — it is never
//! auto-deleted or rewritten on read. Snooze expiry is a pure computation
//! the caller performs via [`is_attention_applicable`]; deciding what to do
//! with an inapplicable row (e.g. resurfacing it in the Inbox) is a
//! different Lane's responsibility.

use rusqlite::{params, Connection, OptionalExtension};

/// Disposition a human or agent has recorded against a Maintenance finding.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum AttentionDisposition {
    Snoozed,
    Dismissed,
    Flagged,
}

impl AttentionDisposition {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Snoozed => "snoozed",
            Self::Dismissed => "dismissed",
            Self::Flagged => "flagged",
        }
    }
}

impl TryFrom<&str> for AttentionDisposition {
    type Error = anyhow::Error;

    fn try_from(value: &str) -> anyhow::Result<Self> {
        match value {
            "snoozed" => Ok(Self::Snoozed),
            "dismissed" => Ok(Self::Dismissed),
            "flagged" => Ok(Self::Flagged),
            other => anyhow::bail!("unknown attention disposition '{other}'"),
        }
    }
}

/// A `narrative_maintenance_attention` row exactly as stored. Rows are
/// returned as-is by [`get_attention`]; nothing here filters or mutates them.
#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) struct AttentionRow {
    pub project_id: String,
    pub finding_key: String,
    pub disposition: AttentionDisposition,
    pub material_basis_digest: String,
    pub snoozed_until: Option<String>,
    pub set_at: String,
    pub set_by: Option<String>,
}

fn row_to_attention_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AttentionRow> {
    let disposition_raw: String = row.get("disposition")?;
    let disposition =
        AttentionDisposition::try_from(disposition_raw.as_str()).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    error.to_string(),
                )),
            )
        })?;
    Ok(AttentionRow {
        project_id: row.get("project_id")?,
        finding_key: row.get("finding_key")?,
        disposition,
        material_basis_digest: row.get("material_basis_digest")?,
        snoozed_until: row.get("snoozed_until")?,
        set_at: row.get("set_at")?,
        set_by: row.get("set_by")?,
    })
}

/// Upsert a Maintenance Attention row. `snoozed_until` is required exactly
/// when `disposition` is [`AttentionDisposition::Snoozed`] and is stored as
/// `NULL` for every other disposition, even if the caller passed one in —
/// a stale snooze timestamp must not survive a disposition change.
///
/// This function never appends to the Change Feed: `narrative_maintenance_attention`
/// is `backflowPolicy: "forbid"` durable user state, not Change Feed output.
#[allow(clippy::too_many_arguments)]
pub(crate) fn set_attention_in_tx(
    conn: &Connection,
    project_id: &str,
    finding_key: &str,
    disposition: AttentionDisposition,
    material_basis_digest: &str,
    snoozed_until: Option<&str>,
    set_at: &str,
    set_by: Option<&str>,
) -> anyhow::Result<()> {
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(!finding_key.trim().is_empty(), "findingKey is required");
    anyhow::ensure!(
        !material_basis_digest.trim().is_empty(),
        "materialBasisDigest is required"
    );
    anyhow::ensure!(!set_at.trim().is_empty(), "setAt is required");

    let stored_snoozed_until = match disposition {
        AttentionDisposition::Snoozed => {
            let value = snoozed_until.filter(|value| !value.trim().is_empty());
            anyhow::ensure!(
                value.is_some(),
                "snoozedUntil is required when disposition is 'snoozed'"
            );
            value
        }
        AttentionDisposition::Dismissed | AttentionDisposition::Flagged => None,
    };

    conn.execute(
        "INSERT INTO narrative_maintenance_attention
            (project_id, finding_key, disposition, material_basis_digest,
             snoozed_until, set_at, set_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(project_id, finding_key) DO UPDATE SET
            disposition = excluded.disposition,
            material_basis_digest = excluded.material_basis_digest,
            snoozed_until = excluded.snoozed_until,
            set_at = excluded.set_at,
            set_by = excluded.set_by",
        params![
            project_id,
            finding_key,
            disposition.as_str(),
            material_basis_digest,
            stored_snoozed_until,
            set_at,
            set_by,
        ],
    )?;
    Ok(())
}

/// Clear (delete) a Maintenance Attention row. A no-op, not an error, when
/// no row exists for `(project_id, finding_key)`.
pub(crate) fn clear_attention_in_tx(
    conn: &Connection,
    project_id: &str,
    finding_key: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(!finding_key.trim().is_empty(), "findingKey is required");
    conn.execute(
        "DELETE FROM narrative_maintenance_attention
          WHERE project_id = ?1 AND finding_key = ?2",
        params![project_id, finding_key],
    )?;
    Ok(())
}

/// Read a Maintenance Attention row exactly as stored. Never mutates,
/// deletes, or filters on expiry — the row survives a lapsed snooze until
/// the typed writer above clears or resets it.
pub(crate) fn get_attention(
    conn: &Connection,
    project_id: &str,
    finding_key: &str,
) -> anyhow::Result<Option<AttentionRow>> {
    let row = conn
        .query_row(
            "SELECT project_id, finding_key, disposition, material_basis_digest,
                    snoozed_until, set_at, set_by
               FROM narrative_maintenance_attention
              WHERE project_id = ?1 AND finding_key = ?2",
            params![project_id, finding_key],
            row_to_attention_row,
        )
        .optional()?;
    Ok(row)
}

/// Pure computation of `applicationConditions` from
/// `maintenance-attention-contract.json`, minus `finding-key-match` (the
/// caller already looked the row up by finding key). No DB access.
///
/// - `material-basis-digest-match`: the row's `material_basis_digest` must
///   equal `current_material_basis_digest` — a stale finding no longer
///   applies once its underlying evidence has moved.
/// - `snooze-not-expired`: only meaningful for
///   [`AttentionDisposition::Snoozed`]; the row applies only while
///   `snoozed_until > now`. Dismissed/Flagged rows have no expiry and apply
///   as long as the digest matches.
pub(crate) fn is_attention_applicable(
    row: &AttentionRow,
    current_material_basis_digest: &str,
    now: &str,
) -> bool {
    if row.material_basis_digest != current_material_basis_digest {
        return false;
    }
    match row.disposition {
        AttentionDisposition::Snoozed => match row.snoozed_until.as_deref() {
            Some(snoozed_until) => snoozed_until > now,
            None => false,
        },
        AttentionDisposition::Dismissed | AttentionDisposition::Flagged => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use std::path::Path;

    fn fixture() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('proj-1', 'Project 1')",
                [],
            )?;
            Ok(())
        })
        .expect("seed project");
        db
    }

    #[test]
    fn set_get_clear_round_trip() {
        let db = fixture();
        db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                "proj-1",
                "finding-a",
                AttentionDisposition::Snoozed,
                "digest-1",
                Some("2026-09-01T00:00:00.000Z"),
                "2026-08-15T00:00:00.000Z",
                Some("user-1"),
            )
        })
        .expect("set attention");

        let row = db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("get attention")
            .expect("row exists");
        assert_eq!(row.disposition, AttentionDisposition::Snoozed);
        assert_eq!(row.material_basis_digest, "digest-1");
        assert_eq!(
            row.snoozed_until.as_deref(),
            Some("2026-09-01T00:00:00.000Z")
        );
        assert_eq!(row.set_by.as_deref(), Some("user-1"));

        db.with_conn(|conn| clear_attention_in_tx(conn, "proj-1", "finding-a"))
            .expect("clear attention");
        let cleared = db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("get attention after clear");
        assert!(cleared.is_none());
    }

    #[test]
    fn set_upserts_and_clears_stale_snoozed_until_on_disposition_change() {
        let db = fixture();
        db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                "proj-1",
                "finding-a",
                AttentionDisposition::Snoozed,
                "digest-1",
                Some("2026-09-01T00:00:00.000Z"),
                "2026-08-15T00:00:00.000Z",
                None,
            )
        })
        .expect("set snoozed");

        db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                "proj-1",
                "finding-a",
                AttentionDisposition::Dismissed,
                "digest-2",
                None,
                "2026-08-16T00:00:00.000Z",
                Some("user-2"),
            )
        })
        .expect("set dismissed");

        let row = db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("get attention")
            .expect("row exists");
        assert_eq!(row.disposition, AttentionDisposition::Dismissed);
        assert_eq!(row.material_basis_digest, "digest-2");
        assert_eq!(row.snoozed_until, None);
        assert_eq!(row.set_by.as_deref(), Some("user-2"));
    }

    #[test]
    fn snoozed_disposition_requires_snoozed_until() {
        let db = fixture();
        let result = db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                "proj-1",
                "finding-a",
                AttentionDisposition::Snoozed,
                "digest-1",
                None,
                "2026-08-15T00:00:00.000Z",
                None,
            )
        });
        assert!(result.is_err());
    }

    #[test]
    fn snoozed_disposition_rejects_blank_snoozed_until() {
        let db = fixture();
        let result = db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                "proj-1",
                "finding-a",
                AttentionDisposition::Snoozed,
                "digest-1",
                Some("   "),
                "2026-08-15T00:00:00.000Z",
                None,
            )
        });
        assert!(result.is_err());
    }

    #[test]
    fn disposition_round_trips_through_as_str_and_try_from() {
        for disposition in [
            AttentionDisposition::Snoozed,
            AttentionDisposition::Dismissed,
            AttentionDisposition::Flagged,
        ] {
            let parsed = AttentionDisposition::try_from(disposition.as_str()).expect("parse");
            assert_eq!(parsed, disposition);
        }
        assert!(AttentionDisposition::try_from("unknown-disposition").is_err());
    }

    fn dismissed_row(material_basis_digest: &str) -> AttentionRow {
        AttentionRow {
            project_id: "proj-1".to_string(),
            finding_key: "finding-a".to_string(),
            disposition: AttentionDisposition::Dismissed,
            material_basis_digest: material_basis_digest.to_string(),
            snoozed_until: None,
            set_at: "2026-08-15T00:00:00.000Z".to_string(),
            set_by: None,
        }
    }

    fn snoozed_row(snoozed_until: &str) -> AttentionRow {
        AttentionRow {
            project_id: "proj-1".to_string(),
            finding_key: "finding-a".to_string(),
            disposition: AttentionDisposition::Snoozed,
            material_basis_digest: "digest-1".to_string(),
            snoozed_until: Some(snoozed_until.to_string()),
            set_at: "2026-08-15T00:00:00.000Z".to_string(),
            set_by: None,
        }
    }

    #[test]
    fn applicable_is_false_on_material_basis_digest_mismatch() {
        let row = dismissed_row("digest-1");
        assert!(!is_attention_applicable(
            &row,
            "digest-2",
            "2026-08-15T00:00:00.000Z"
        ));
    }

    #[test]
    fn applicable_snoozed_row_is_false_once_snoozed_until_has_lapsed() {
        let row = snoozed_row("2026-08-15T00:00:00.000Z");
        // snoozed_until <= now: expired.
        assert!(!is_attention_applicable(
            &row,
            "digest-1",
            "2026-08-15T00:00:00.000Z"
        ));
        assert!(!is_attention_applicable(
            &row,
            "digest-1",
            "2026-08-16T00:00:00.000Z"
        ));
    }

    #[test]
    fn applicable_snoozed_row_is_true_while_snoozed_until_is_in_the_future() {
        let row = snoozed_row("2026-09-01T00:00:00.000Z");
        assert!(is_attention_applicable(
            &row,
            "digest-1",
            "2026-08-15T00:00:00.000Z"
        ));
    }

    #[test]
    fn applicable_dismissed_and_flagged_rows_have_no_expiry() {
        let dismissed = dismissed_row("digest-1");
        assert!(is_attention_applicable(
            &dismissed,
            "digest-1",
            "9999-01-01T00:00:00.000Z"
        ));
        let flagged = AttentionRow {
            disposition: AttentionDisposition::Flagged,
            ..dismissed_row("digest-1")
        };
        assert!(is_attention_applicable(
            &flagged,
            "digest-1",
            "9999-01-01T00:00:00.000Z"
        ));
    }

    #[test]
    fn get_attention_does_not_auto_delete_or_mutate_an_expired_snoozed_row() {
        let db = fixture();
        db.with_conn(|conn| {
            set_attention_in_tx(
                conn,
                "proj-1",
                "finding-a",
                AttentionDisposition::Snoozed,
                "digest-1",
                Some("2026-08-01T00:00:00.000Z"),
                "2026-07-01T00:00:00.000Z",
                None,
            )
        })
        .expect("set snoozed");

        // Read as of a time well after snoozed_until has lapsed.
        let now = "2026-08-15T00:00:00.000Z";
        let row = db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("get attention")
            .expect("row still present, unmutated");
        assert!(!is_attention_applicable(&row, "digest-1", now));

        // Reading again confirms the row was not deleted or rewritten by the
        // read above.
        let row_again = db
            .with_conn(|conn| get_attention(conn, "proj-1", "finding-a"))
            .expect("get attention again")
            .expect("row still present after prior read");
        assert_eq!(row_again, row);
    }
}
