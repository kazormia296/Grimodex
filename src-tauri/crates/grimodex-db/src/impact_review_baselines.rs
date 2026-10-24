//! Typed Native writer for the Impact Review baseline's visibility metadata
//! (NIR-1 DA-2b T, K3/2 "Codex の phase か entry の可視性"; DR-DA2-52).
//!
//! `impact_review_baselines` is a `read-open` table: restricted generic SQL
//! may read it but never update it. The renderer keeps its current rule
//! (`impactBaselineVisibility.ts`) for the new JSON and hash; this writer
//! accepts it only when
//!
//! 1. the hash is the renderer's `stableHash` (32-bit FNV-1a over UTF-16
//!    code units) of the exact JSON text,
//! 2. the new JSON equals the stored one except for the two visibility keys
//!    `restrictedPhaseIds` and `visibleDeletedPhaseIds` (string arrays), and
//! 3. the stored content hash still equals `expectedContentHash` (CAS).
//!
//! A lost CAS answers `updated: false` so the renderer's bounded retry stays
//! the same; it never returns the stored JSON.

use std::fmt;

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Database;

pub const IMPACT_BASELINE_WRITE_REFUSED: &str = "IMPACT_BASELINE_WRITE_REFUSED";

pub const MAX_ID_CHARS: usize = 256;
pub const MAX_HASH_CHARS: usize = 64;
/// Bytes of the snapshot JSON (Main re-validates the same bound).
pub const MAX_SNAPSHOT_JSON_BYTES: usize = 16 * 1024 * 1024;

/// The only keys the visibility writer may change.
pub const VISIBILITY_KEYS: [&str; 2] = ["restrictedPhaseIds", "visibleDeletedPhaseIds"];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImpactBaselineWriteRefusal {
    InvalidRequest,
    HashMismatch,
    NotVisibilityOnly,
    BaselineUnreadable,
}

impl ImpactBaselineWriteRefusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid-request",
            Self::HashMismatch => "hash-mismatch",
            Self::NotVisibilityOnly => "not-visibility-only",
            Self::BaselineUnreadable => "baseline-unreadable",
        }
    }
}

impl fmt::Display for ImpactBaselineWriteRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{IMPACT_BASELINE_WRITE_REFUSED}:{}", self.code())
    }
}

impl std::error::Error for ImpactBaselineWriteRefusal {}

fn refuse<T>(refusal: ImpactBaselineWriteRefusal) -> Result<T> {
    Err(anyhow::Error::new(refusal))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateVisibilityRequest {
    pub project_id: String,
    pub entry_id: String,
    pub expected_content_hash: String,
    pub snapshot_json: String,
    pub content_hash: String,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
pub struct VisibilityUpdate {
    pub updated: bool,
}

/// The renderer's `stableHash`: 32-bit FNV-1a over the UTF-16 code units,
/// as eight lowercase hex digits.
pub fn stable_hash(text: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in text.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

fn valid_id(value: &str, max: usize) -> bool {
    !value.is_empty() && value.chars().count() <= max
}

fn without_visibility(value: &Value) -> Option<serde_json::Map<String, Value>> {
    let mut object = value.as_object()?.clone();
    for key in VISIBILITY_KEYS {
        object.shift_remove(key);
    }
    Some(object)
}

fn visibility_values_are_string_arrays(value: &Value) -> bool {
    VISIBILITY_KEYS.iter().all(|key| match value.get(key) {
        None => true,
        Some(Value::Array(items)) => items.iter().all(Value::is_string),
        Some(_) => false,
    })
}

/// CAS-update the baseline's visibility metadata (see the module docs).
pub fn update_visibility(
    db: &Database,
    request: UpdateVisibilityRequest,
) -> Result<VisibilityUpdate> {
    if !valid_id(&request.project_id, MAX_ID_CHARS)
        || !valid_id(&request.entry_id, MAX_ID_CHARS)
        || !valid_id(&request.expected_content_hash, MAX_HASH_CHARS)
        || !valid_id(&request.content_hash, MAX_HASH_CHARS)
        || request.snapshot_json.len() > MAX_SNAPSHOT_JSON_BYTES
    {
        return refuse(ImpactBaselineWriteRefusal::InvalidRequest);
    }
    if stable_hash(&request.snapshot_json) != request.content_hash {
        return refuse(ImpactBaselineWriteRefusal::HashMismatch);
    }
    let Ok(next) = serde_json::from_str::<Value>(&request.snapshot_json) else {
        return refuse(ImpactBaselineWriteRefusal::InvalidRequest);
    };
    if !next.is_object() || !visibility_values_are_string_arrays(&next) {
        return refuse(ImpactBaselineWriteRefusal::InvalidRequest);
    }
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let stored: Option<String> = tx
            .query_row(
                "SELECT snapshot_json FROM impact_review_baselines
                  WHERE entry_id = ?1 AND project_id = ?2 AND content_hash = ?3",
                params![
                    request.entry_id,
                    request.project_id,
                    request.expected_content_hash
                ],
                |row| row.get(0),
            )
            .optional()?;
        let Some(stored) = stored else {
            // The row is gone or its hash moved on: the renderer re-reads.
            return Ok(VisibilityUpdate { updated: false });
        };
        let Some(stored_rest) = serde_json::from_str::<Value>(&stored)
            .ok()
            .as_ref()
            .and_then(without_visibility)
        else {
            return refuse(ImpactBaselineWriteRefusal::BaselineUnreadable);
        };
        if without_visibility(&next) != Some(stored_rest) {
            return refuse(ImpactBaselineWriteRefusal::NotVisibilityOnly);
        }
        let changed = tx.execute(
            "UPDATE impact_review_baselines
                SET snapshot_json = ?1, content_hash = ?2
              WHERE entry_id = ?3 AND project_id = ?4 AND content_hash = ?5",
            params![
                request.snapshot_json,
                request.content_hash,
                request.entry_id,
                request.project_id,
                request.expected_content_hash
            ],
        )?;
        tx.commit()?;
        Ok(VisibilityUpdate {
            updated: changed == 1,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::stable_hash;

    #[test]
    fn stable_hash_matches_the_renderer_fnv1a() {
        // Values from `stableHash` in impactBaselineVisibility.ts (node).
        assert_eq!(stable_hash(""), "811c9dc5");
        assert_eq!(stable_hash("{}"), "5465b825");
        // UTF-16 code units, including a surrogate pair.
        assert_eq!(
            stable_hash("{\"restrictedPhaseIds\":[\"p1\"],\"x\":\"日本語😀\"}"),
            "8201fb62"
        );
    }
}
