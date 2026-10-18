//! Every byte limit of the wire layer, in one value.
//!
//! Each limit is checked before the bytes it bounds are stored, so a hostile
//! `Content-Length`, chunk size or endless line never makes the parser
//! allocate. Tests inject small values through [`Limits`]; the product uses
//! [`Limits::DEFAULT`].
//!
//! Durations (connect, first byte, event gap, total, body end after `[DONE]`,
//! cancel-to-join) are not here: this layer has no clock. The transport owns
//! them (DT-5b, DR-DT5-9).

/// The largest text (and, separately, thinking) stream one attempt may carry.
/// It equals the stored-message body limit (`MAX_MESSAGE_BODY_BYTES`, 2 MiB in
/// grimodex-db), so a body the wire accepted can always be stored.
pub const MAX_OUTPUT_CHANNEL_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Limits {
    /// Status line, headers and the blank line that ends them, plus any chunked
    /// trailer. Checked per byte received; a head of exactly this size is
    /// accepted, one byte more fails.
    pub max_header_bytes: usize,
    /// One SSE event: every byte from the event's first byte through the
    /// terminator of the blank line that ends it, comments included. A line
    /// (decoded only when complete) counts against this too.
    pub max_event_bytes: usize,
    /// Everything received after the head (chunk framing and trailer
    /// included). A declared `Content-Length` above it fails at the head.
    pub max_body_bytes: usize,
    /// Sum of `delta.content` bytes.
    pub max_text_bytes: usize,
    /// Sum of thinking bytes (allow-listed reasoning fields).
    pub max_thinking_bytes: usize,
    /// Hex digits of one chunk size (leading zeros count).
    pub max_chunk_size_digits: usize,
    /// Value of one chunk size.
    pub max_chunk_bytes: usize,
    /// A chunk-size line: digits and an ignored extension, without the CRLF.
    pub max_chunk_line_bytes: usize,
}

impl Limits {
    /// Initial values (DR-DT5-9; the body limit is finalized by the
    /// measurement of T4): header 16 KiB, event 256 KiB, body 64 MiB, text and
    /// thinking 2 MiB each, chunk size 8 hex digits and 4 MiB, chunk line 1 KiB.
    pub const DEFAULT: Limits = Limits {
        max_header_bytes: 16 * 1024,
        max_event_bytes: 256 * 1024,
        max_body_bytes: 64 * 1024 * 1024,
        max_text_bytes: MAX_OUTPUT_CHANNEL_BYTES,
        max_thinking_bytes: MAX_OUTPUT_CHANNEL_BYTES,
        max_chunk_size_digits: 8,
        max_chunk_bytes: 4 * 1024 * 1024,
        max_chunk_line_bytes: 1024,
    };
}

impl Default for Limits {
    fn default() -> Self {
        Self::DEFAULT
    }
}
