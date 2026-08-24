//! Lightweight shared primitives for Grimodex AI writes (no ort/lindera).

pub const SCHEMA_VERSION: i32 = 34;
/// Last *published* workspace schema (v2.0.10). Gate A2 release fixtures must
/// stamp this marker — not [`PREVIOUS_COMPATIBLE_SCHEMA_VERSION`], which tracks
/// the in-tree previous marker for open fast-path / Schema bump bookkeeping and
/// can diverge from the physical seed after intermediate bumps (e.g. 3→4).
pub const LAST_PUBLIC_RELEASE_SCHEMA_VERSION: i32 = 2;
pub const PREVIOUS_COMPATIBLE_SCHEMA_VERSION: i32 = 33;
pub const PREVIOUS_COMPATIBLE_TARGET_SCHEMA_VERSION: i32 = 34;

/// Commit a manually-opened transaction, rolling back if the COMMIT itself
/// fails. On the shared single connection a failed COMMIT (deferred FK check,
/// SQLITE_BUSY, disk-full, ...) otherwise leaves the transaction open, so the
/// next caller inherits a zombie transaction and its writes silently ride on or
/// get rolled back with it. Always leaves the connection in autocommit state on
/// return.
pub fn commit_or_rollback(conn: &rusqlite::Connection) -> anyhow::Result<()> {
    if let Err(e) = conn.execute_batch("COMMIT") {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(e.into());
    }
    Ok(())
}

/// Millisecond-precision, `Z`-suffixed RFC3339 timestamp for the current
/// instant. Centralizes the `chrono` dependency for crates (e.g.
/// `grimodex-node`) that need a wall-clock stamp but don't otherwise pull in
/// `chrono` directly.
pub fn now_rfc3339_millis() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub mod canonical_json;
pub mod change_events;
pub mod chronicle_time;
pub mod codex_matching;
pub mod contract_string;
pub mod license;
pub mod narrative_dependency;
pub mod narrative_ir;
pub mod narrative_scope_authority_basis;
pub mod pm_text;
pub mod policy;
pub mod snapshots;
pub mod undo_journal;
pub mod workspace_schema;
pub mod writes;

pub use canonical_json::{
    canonical_json_bytes, canonical_json_digest, canonical_json_sha256, canonical_json_string,
    CanonicalJsonError,
};
