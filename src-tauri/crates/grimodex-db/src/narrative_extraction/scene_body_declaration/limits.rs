//! K1b limits of the declaration preview, writer and (CB-4) reader. Every value
//! is checked before the thing it bounds is allocated (DR-CB2-7).

// The three K1b limits the Graph reader also uses moved to `nir1_graph` (K25P2-2);
// they are re-exported here until the declaration module is removed (PR-2, 2b2).
pub use crate::narrative_extraction::nir1_graph::{
    SCENE_BODY_READ_MAX_BYTES, SCENE_BODY_READ_PEAK_MAX_BYTES, SCENE_BODY_TITLE_MAX_BYTES,
};

/// Most rows the veto looks at, over all its sources together. One more row
/// than this is an error, never a verdict (`veto-limit`).
pub const SCENE_BODY_VETO_MAX_ROWS: usize = 512;

/// Marker of the error the veto raises when it would have to look at more than
/// its row limit.
pub const VETO_ROW_LIMIT_MARKER: &str = "NEX_BODY_DECLARATION_VETO_ROW_LIMIT";
/// Marker of the error the veto raises when the saved body is above its limit.
pub const VETO_CONTENT_LIMIT_MARKER: &str = "NEX_BODY_DECLARATION_VETO_CONTENT_LIMIT";
