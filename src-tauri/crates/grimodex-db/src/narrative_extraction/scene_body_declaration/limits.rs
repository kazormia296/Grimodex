//! K1b limits of the declaration preview, writer and (CB-4) reader. Every value
//! is checked before the thing it bounds is allocated (DR-CB2-7).

/// Largest `octet_length` of the saved body (and of the canonical text) that
/// the declaration reads at all, checked before the body is read into memory.
/// CB-4's reader uses the same constant, so a body that was declarable stays
/// readable. The shared canonical-text reader refuses a saved body above 32 KiB
/// on its own (`CANONICAL_PARSE_INPUT_LIMIT`), so that smaller value is the
/// effective limit; this one is the early, cheap check in front of it.
pub const SCENE_BODY_READ_MAX_BYTES: usize = 64 * 1024;

/// Largest conservative estimate of the working memory of one body read. The
/// shared reader charges every JSON string twice the size of the saved body
/// before it parses it, so the estimate grows with the number of strings; the
/// real allocation stays small because the parse is a stream. The estimate is
/// checked before the work it describes. 64 MiB is the existing approved scope
/// of one Native query's working memory (K1's S); it is reused, not a new value
/// (DR-CB2-7).
pub const SCENE_BODY_READ_PEAK_MAX_BYTES: usize = 64 * 1024 * 1024;

/// Largest `octet_length` of a Scene title that is read at all. The dialog
/// shows 64 scalar values, so this only bounds the title digest's input.
pub const SCENE_BODY_TITLE_MAX_BYTES: usize = 8192;

/// Most rows the veto looks at, over all its sources together. One more row
/// than this is an error, never a verdict (`veto-limit`).
pub const SCENE_BODY_VETO_MAX_ROWS: usize = 512;

/// Marker of the error the veto raises when it would have to look at more than
/// its row limit.
pub const VETO_ROW_LIMIT_MARKER: &str = "NEX_BODY_DECLARATION_VETO_ROW_LIMIT";
/// Marker of the error the veto raises when the saved body is above its limit.
pub const VETO_CONTENT_LIMIT_MARKER: &str = "NEX_BODY_DECLARATION_VETO_CONTENT_LIMIT";
