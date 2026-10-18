//! Pure wire layer of the NIR-1 local generation transport (K5/3, DT-5a).
//!
//! No I/O, no clock, no thread, no database. The functions here only turn
//! bytes into typed values:
//!
//! - [`http`]: the allow-listed request head, and an incremental HTTP/1.1
//!   response head and body-framing decoder (chunked, `Content-Length`,
//!   close);
//! - [`sse`]: the strict Server-Sent Events reader of K5/3 "wire と終端の規則"
//!   rules 1-8, which turns decoded body bytes into text/thinking deltas, a
//!   provider terminal and `[DONE]`;
//! - [`limits`]: every byte limit, in one injectable struct, checked before the
//!   bytes are stored.
//!
//! [`ResponseParser`] chains the three for the transport thread. The result
//! never depends on where the input is split (DG-4): TCP reads and SSE events
//! may be cut at any byte position, including inside a UTF-8 character or a
//! CRLF. Authority stays elsewhere: the transport owns the socket, the
//! supervisor owns the attempt and the audit, and [`TransportEnd`] only maps
//! what was observed to one of the five approved terminal rows.

pub mod http;
pub mod limits;
pub mod sse;

#[cfg(test)]
mod tests;

use thiserror::Error;

use crate::narrative_nir1_receipt::{Completion, ProviderTerminal};

pub use http::{
    build_request_head, BodyDecoder, Framing, HeadParser, HeadProgress, HttpVersion, RequestTarget,
    ResponseHead, REQUEST_HEADER_ALLOWLIST, REQUEST_PATH, USER_AGENT,
};
pub use limits::{Limits, MAX_OUTPUT_CHANNEL_BYTES};
pub use sse::{SseParser, WireEvent};

/// Why the wire layer refused a request target or a response. Every variant is
/// a failure of the response (or of the target before anything is sent); none
/// is retried by this layer.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum WireFailure {
    // Target and response head.
    #[error("NIR1_WIRE_TARGET_NOT_LOOPBACK_LITERAL")]
    TargetNotLoopbackLiteral,
    #[error("NIR1_WIRE_STATUS_LINE_INVALID")]
    StatusLineInvalid,
    #[error("NIR1_WIRE_HTTP_VERSION_UNSUPPORTED")]
    HttpVersionUnsupported,
    #[error("NIR1_WIRE_STATUS_NOT_OK")]
    StatusNotOk,
    #[error("NIR1_WIRE_HEADER_INVALID")]
    HeaderInvalid,
    #[error("NIR1_WIRE_HEADER_TOO_LARGE")]
    HeaderTooLarge,
    #[error("NIR1_WIRE_DUPLICATE_HEADER")]
    DuplicateHeader,
    #[error("NIR1_WIRE_CONTENT_TYPE_MISSING")]
    ContentTypeMissing,
    #[error("NIR1_WIRE_CONTENT_TYPE_NOT_EVENT_STREAM")]
    ContentTypeNotEventStream,
    #[error("NIR1_WIRE_CONTENT_ENCODING_UNSUPPORTED")]
    ContentEncodingUnsupported,
    #[error("NIR1_WIRE_TRANSFER_ENCODING_UNSUPPORTED")]
    TransferEncodingUnsupported,
    #[error("NIR1_WIRE_AMBIGUOUS_FRAMING")]
    AmbiguousFraming,
    #[error("NIR1_WIRE_CONTENT_LENGTH_INVALID")]
    ContentLengthInvalid,
    #[error("NIR1_WIRE_CONTENT_LENGTH_TOO_LARGE")]
    ContentLengthTooLarge,
    #[error("NIR1_WIRE_TRUNCATED_HEAD")]
    TruncatedHead,
    // Body framing.
    #[error("NIR1_WIRE_CHUNK_SIZE_INVALID")]
    ChunkSizeInvalid,
    #[error("NIR1_WIRE_CHUNK_SIZE_TOO_LONG")]
    ChunkSizeTooLong,
    #[error("NIR1_WIRE_CHUNK_TOO_LARGE")]
    ChunkTooLarge,
    #[error("NIR1_WIRE_CHUNK_LINE_TOO_LONG")]
    ChunkLineTooLong,
    #[error("NIR1_WIRE_CHUNK_FRAMING_INVALID")]
    ChunkFramingInvalid,
    #[error("NIR1_WIRE_BODY_TOO_LARGE")]
    BodyTooLarge,
    #[error("NIR1_WIRE_BYTES_AFTER_BODY_END")]
    BytesAfterBodyEnd,
    #[error("NIR1_WIRE_TRUNCATED_BODY")]
    TruncatedBody,
    // SSE.
    #[error("NIR1_WIRE_INVALID_UTF8")]
    InvalidUtf8,
    #[error("NIR1_WIRE_EVENT_TOO_LARGE")]
    EventTooLarge,
    #[error("NIR1_WIRE_UNKNOWN_FIELD")]
    UnknownField,
    #[error("NIR1_WIRE_INVALID_JSON")]
    InvalidJson,
    #[error("NIR1_WIRE_DATA_NOT_JSON_OBJECT")]
    DataNotJsonObject,
    #[error("NIR1_WIRE_ERROR_OBJECT")]
    ErrorObject,
    #[error("NIR1_WIRE_CHOICES_SHAPE")]
    ChoicesShape,
    #[error("NIR1_WIRE_CHOICE_INDEX")]
    ChoiceIndex,
    #[error("NIR1_WIRE_CHOICE_KEY_NOT_ALLOWED")]
    ChoiceKeyNotAllowed,
    #[error("NIR1_WIRE_DELTA_INVALID")]
    DeltaInvalid,
    #[error("NIR1_WIRE_DELTA_KEY_NOT_ALLOWED")]
    DeltaKeyNotAllowed,
    #[error("NIR1_WIRE_THINKING_CONFLICT")]
    ThinkingConflict,
    #[error("NIR1_WIRE_TEXT_LIMIT")]
    TextLimit,
    #[error("NIR1_WIRE_THINKING_LIMIT")]
    ThinkingLimit,
    /// A non-null `finish_reason` other than `stop` (the terminal is carried so
    /// the observer sees the same category the wire saw).
    #[error("NIR1_WIRE_PROVIDER_TERMINAL_NOT_COMPLETE")]
    ProviderTerminalNotComplete(ProviderTerminal),
    #[error("NIR1_WIRE_DATA_AFTER_TERMINAL")]
    DataAfterTerminal,
    #[error("NIR1_WIRE_DONE_BEFORE_TERMINAL")]
    DoneBeforeTerminal,
    #[error("NIR1_WIRE_DATA_AFTER_DONE")]
    DataAfterDone,
    #[error("NIR1_WIRE_MISSING_TERMINAL")]
    MissingTerminal,
    #[error("NIR1_WIRE_MISSING_DONE")]
    MissingDone,
    #[error("NIR1_WIRE_INCOMPLETE_LINE")]
    IncompleteLine,
    #[error("NIR1_WIRE_INCOMPLETE_EVENT")]
    IncompleteEvent,
}

impl WireFailure {
    /// The observer completion for a failure seen after the request was sent.
    /// Every one of them closes the attempt as `failed + invalid`; the three
    /// spellings only keep the reason visible to the observer's caller.
    pub fn completion(self) -> Completion {
        match self {
            WireFailure::TruncatedHead
            | WireFailure::TruncatedBody
            | WireFailure::MissingTerminal
            | WireFailure::MissingDone
            | WireFailure::IncompleteLine
            | WireFailure::IncompleteEvent => Completion::UnexpectedEof,
            WireFailure::ProviderTerminalNotComplete(ProviderTerminal::LengthLimit) => {
                Completion::Truncated
            }
            _ => Completion::ParseFailure,
        }
    }
}

/// How one attempt ended, as far as the wire can tell. Maps to the five rows
/// of the K5/3 terminal matrix; the fifth (a sweep after a crash) and
/// `Skipped` are not wire outcomes and cannot be built here.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransportEnd {
    /// `stop` and `[DONE]` once each: `succeeded + parsed`.
    Parsed,
    /// Anything wrong after the first byte was sent: `failed + invalid`.
    FailedAfterSend(WireFailure),
    /// Closed or refused before the first byte: `failed + not-attempted`
    /// (`DispatchUnavailable`).
    FailedBeforeSend,
    /// A cancellation, before or after sending: `cancelled + not-attempted`.
    Cancelled,
}

impl TransportEnd {
    pub fn completion(self) -> Completion {
        match self {
            TransportEnd::Parsed => Completion::Parsed,
            TransportEnd::FailedAfterSend(failure) => failure.completion(),
            TransportEnd::FailedBeforeSend => Completion::DispatchFailure,
            TransportEnd::Cancelled => Completion::Cancelled,
        }
    }
}

/// What a [`ResponseParser`] needs next.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Progress {
    /// More bytes (or the peer's close) are needed.
    NeedMore,
    /// The framed body ended and the stream satisfied every SSE rule: the
    /// response is a success. Nothing further may arrive.
    Finished,
}

enum Stage {
    Head(HeadParser),
    Body {
        decoder: BodyDecoder,
        sse: Box<SseParser>,
        scratch: Vec<u8>,
    },
    Finished,
    Failed(WireFailure),
}

/// Bytes in, [`WireEvent`]s out: the head, the body framing and the SSE rules
/// as one incremental pure state machine. After any `Err` the parser stays
/// failed and returns the same failure; events emitted before the failing byte
/// are still appended to `out`.
pub struct ResponseParser {
    limits: Limits,
    head: Option<ResponseHead>,
    stage: Stage,
}

impl ResponseParser {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            head: None,
            stage: Stage::Head(HeadParser::new(limits)),
        }
    }

    /// The response head, once it was accepted.
    pub fn head(&self) -> Option<&ResponseHead> {
        self.head.as_ref()
    }

    /// True once the framing itself reached its end (not for close-delimited
    /// bodies, which only end with the peer's close).
    pub fn body_framing_complete(&self) -> bool {
        match &self.stage {
            Stage::Body { decoder, .. } => decoder.is_complete(),
            Stage::Finished => true,
            _ => false,
        }
    }

    pub fn push(
        &mut self,
        bytes: &[u8],
        out: &mut Vec<WireEvent>,
    ) -> Result<Progress, WireFailure> {
        match &self.stage {
            Stage::Failed(failure) => return Err(*failure),
            Stage::Finished => {
                return if bytes.is_empty() {
                    Ok(Progress::Finished)
                } else {
                    self.fail(WireFailure::BytesAfterBodyEnd)
                };
            }
            _ => {}
        }
        let mut rest = bytes;
        if let Stage::Head(parser) = &mut self.stage {
            match parser.push(rest) {
                Err(failure) => return self.fail(failure),
                Ok(HeadProgress::NeedMore) => return Ok(Progress::NeedMore),
                Ok(HeadProgress::Complete { head, consumed }) => {
                    rest = &rest[consumed..];
                    let decoder = BodyDecoder::new(head.framing, self.limits, head.head_bytes);
                    self.head = Some(head);
                    self.stage = Stage::Body {
                        decoder,
                        sse: Box::new(SseParser::new(self.limits)),
                        scratch: Vec::new(),
                    };
                }
            }
        }
        // Whatever was decoded before a framing error is read first: an
        // earlier SSE failure outranks a later framing one, wherever the input
        // happened to be split. A zero-length body ends right here.
        let Stage::Body {
            decoder,
            sse,
            scratch,
        } = &mut self.stage
        else {
            return Ok(Progress::NeedMore);
        };
        scratch.clear();
        let decoded = decoder.push(rest, scratch);
        let outcome = match sse.push(scratch, out) {
            Err(failure) => Err(failure),
            Ok(()) => match decoded {
                Err(failure) => Err(failure),
                Ok(()) if decoder.is_complete() => sse.finish().map(|()| Progress::Finished),
                Ok(()) => Ok(Progress::NeedMore),
            },
        };
        match outcome {
            Ok(Progress::Finished) => {
                self.stage = Stage::Finished;
                Ok(Progress::Finished)
            }
            Ok(progress) => Ok(progress),
            Err(failure) => self.fail(failure),
        }
    }

    /// The peer closed the connection.
    pub fn finish_eof(&mut self) -> Result<(), WireFailure> {
        let outcome = match &mut self.stage {
            Stage::Failed(failure) => return Err(*failure),
            Stage::Finished => return Ok(()),
            Stage::Head(_) => Err(WireFailure::TruncatedHead),
            Stage::Body { decoder, sse, .. } => decoder.finish_eof().and_then(|()| sse.finish()),
        };
        match outcome {
            Ok(()) => {
                self.stage = Stage::Finished;
                Ok(())
            }
            Err(failure) => self.fail(failure).map(|_| ()),
        }
    }

    fn fail(&mut self, failure: WireFailure) -> Result<Progress, WireFailure> {
        self.stage = Stage::Failed(failure);
        Err(failure)
    }
}
