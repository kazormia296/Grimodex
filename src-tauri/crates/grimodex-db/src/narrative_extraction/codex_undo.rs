//! Codex-specific undo helpers for narrative apply commits.
//!
//! Reverse order is enforced by `undo.rs`: relation delete → entry delete/patch
//! restore. External dependency refusal uses `NEX_UNDO_EXTERNAL_DEPENDENCY`.

#![allow(unused_imports)]

pub(crate) use super::codex_snapshots::{
    delete_codex_relation_checked, ensure_no_external_codex_dependencies,
    ensure_patch_pre_redo_matches_before, reapply_codex_entry_create_snapshot,
    reapply_codex_relation_snapshot, restore_codex_entry_patch, undo_created_codex_entry,
};
