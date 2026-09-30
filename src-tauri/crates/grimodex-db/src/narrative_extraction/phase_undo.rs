//! Phase / Detail / Semantic Binding undo helpers for narrative apply commits.
//!
//! Reverse order is enforced by `undo.rs`. Sticky / authorship deps refuse with
//! `NEX_UNDO_EXTERNAL_DEPENDENCY`.

#![allow(unused_imports)]

pub(crate) use super::phase_snapshots::{
    ensure_no_external_phase_dependencies, reapply_detail_value_create_snapshot,
    reapply_phase_create_snapshot, reapply_semantic_binding_create_snapshot,
    restore_detail_value_patch, restore_phase_patch, restore_semantic_binding_patch,
    undo_created_detail_value, undo_created_phase, undo_created_semantic_binding,
};
