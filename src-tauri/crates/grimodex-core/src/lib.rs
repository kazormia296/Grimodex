//! Lightweight shared primitives for Grimodex AI writes (no ort/lindera).

pub const SCHEMA_VERSION: i32 = 1;

pub mod change_events;
pub mod policy;
pub mod undo_journal;
