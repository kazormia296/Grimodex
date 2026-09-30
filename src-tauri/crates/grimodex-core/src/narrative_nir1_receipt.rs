//! Synchronous NIR-1 generation-output observations for a trusted transport adapter.
//!
//! These public values are observations, never authority or durable receipts. The
//! Native coordinator must bind them to the immutable attempt, message version,
//! existing body/artifact storage and current input authorities, and persist one
//! terminal receipt before considering publication. This module owns no transport,
//! storage, lifecycle task, retry or history eligibility.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const OUTPUT_DIGEST_VERSION: &str = "nir1-native-output@1";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutputChannel {
    Text,
    Thinking,
}

/// A category observed by the trusted provider-specific transport parser.
/// Constructing this value does not prove that a provider terminal was observed.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderTerminal {
    Complete,
    LengthLimit,
    Ineligible,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalStatus {
    Succeeded,
    Failed,
    Cancelled,
    Skipped,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ParseStatus {
    Parsed,
    Invalid,
    NotAttempted,
}

/// The coordinator's observed reason for closing this attempt. `Parsed` alone
/// cannot succeed without a complete provider terminal and a valid byte stream.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Completion {
    Parsed,
    ParseFailure,
    UnexpectedEof,
    Truncated,
    DispatchFailure,
    Cancelled,
    Skipped,
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum OutputObservationError {
    #[error("NIR1_OUTPUT_INVALID_UTF8")]
    InvalidUtf8,
    #[error("NIR1_OUTPUT_DUPLICATE_TERMINAL")]
    DuplicateTerminal,
    #[error("NIR1_OUTPUT_DATA_AFTER_TERMINAL")]
    DataAfterTerminal,
    #[error("NIR1_OUTPUT_ALREADY_INVALID")]
    AlreadyInvalid,
    #[error("NIR1_OUTPUT_INVALID_TERMINAL_MATRIX")]
    InvalidTerminalMatrix,
}

/// Checks only the five approved terminal/parse/digest-presence combinations.
/// It does not authenticate observations, validate digest contents or qualify
/// publication. In particular, `NotAttempted` is not proof of no provider work.
pub fn validate_terminal_matrix(
    terminal_status: TerminalStatus,
    parse_status: ParseStatus,
    has_response_digest: bool,
) -> Result<(), OutputObservationError> {
    match (terminal_status, parse_status, has_response_digest) {
        (TerminalStatus::Succeeded, ParseStatus::Parsed, true)
        | (TerminalStatus::Failed, ParseStatus::Invalid, true)
        | (TerminalStatus::Failed, ParseStatus::NotAttempted, false)
        | (TerminalStatus::Cancelled, ParseStatus::NotAttempted, false)
        | (TerminalStatus::Skipped, ParseStatus::NotAttempted, false) => Ok(()),
        _ => Err(OutputObservationError::InvalidTerminalMatrix),
    }
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalObservation {
    pub digest_version: &'static str,
    pub provider_terminal: Option<ProviderTerminal>,
    pub terminal_status: TerminalStatus,
    pub parse_status: ParseStatus,
    pub text_digest: String,
    pub thinking_digest: String,
    pub response_digest: Option<String>,
}

/// Constant-memory observation of already-separated transport text/thinking.
///
/// Channel hashes consume the exact raw bytes. The response hash consumes
/// `(channel tag, byte)` pairs in arrival order: text = 0, thinking = 1. Fixed
/// pairs preserve channel identity and interleaving without encoding chunk
/// boundaries. Every hash starts with `OUTPUT_DIGEST_VERSION`, NUL, its domain
/// (`text`, `thinking` or `response`), NUL. There is no trimming, normalization,
/// decoding/re-encoding or retained plaintext buffer.
///
/// All pre-terminal bytes are hashed, including malformed UTF-8 and subsequent
/// rejected chunks, so invalid output still has a chunk-invariant digest.
/// Duplicate/post-terminal events are rejected without ingestion. Any error
/// permanently prevents success.
pub struct OutputObserver {
    text: Sha256,
    thinking: Sha256,
    response: Sha256,
    text_utf8: Utf8State,
    thinking_utf8: Utf8State,
    provider_terminal: Option<ProviderTerminal>,
    invalid: bool,
}

impl Default for OutputObserver {
    fn default() -> Self {
        Self::new()
    }
}

impl OutputObserver {
    pub fn new() -> Self {
        Self {
            text: domain_digest(b"text"),
            thinking: domain_digest(b"thinking"),
            response: domain_digest(b"response"),
            text_utf8: Utf8State::default(),
            thinking_utf8: Utf8State::default(),
            provider_terminal: None,
            invalid: false,
        }
    }

    pub fn observe(
        &mut self,
        channel: OutputChannel,
        bytes: &[u8],
    ) -> Result<(), OutputObservationError> {
        if self.provider_terminal.is_some() {
            self.invalid = true;
            return Err(OutputObservationError::DataAfterTerminal);
        }
        let (digest, utf8, tag) = match channel {
            OutputChannel::Text => (&mut self.text, &mut self.text_utf8, 0),
            OutputChannel::Thinking => (&mut self.thinking, &mut self.thinking_utf8, 1),
        };
        digest.update(bytes);
        for byte in bytes {
            self.response.update([tag, *byte]);
        }
        if self.invalid {
            return Err(OutputObservationError::AlreadyInvalid);
        }
        if !bytes.iter().all(|byte| utf8.observe(*byte)) {
            self.invalid = true;
            return Err(OutputObservationError::InvalidUtf8);
        }
        Ok(())
    }

    pub fn observe_terminal(
        &mut self,
        terminal: ProviderTerminal,
    ) -> Result<(), OutputObservationError> {
        if self.provider_terminal.is_some() {
            self.invalid = true;
            return Err(OutputObservationError::DuplicateTerminal);
        }
        // Retain the actual first terminal even when prior data was invalid.
        self.provider_terminal = Some(terminal);
        if self.invalid {
            return Err(OutputObservationError::AlreadyInvalid);
        }
        if !self.text_utf8.complete() || !self.thinking_utf8.complete() {
            self.invalid = true;
            return Err(OutputObservationError::InvalidUtf8);
        }
        Ok(())
    }

    /// Consumes the observation, so this instance can produce at most one result.
    /// Durable exactly-once persistence remains the coordinator's responsibility.
    pub fn finish(self, completion: Completion) -> TerminalObservation {
        let (terminal_status, parse_status, has_response_digest) = match completion {
            Completion::Cancelled => (TerminalStatus::Cancelled, ParseStatus::NotAttempted, false),
            Completion::Skipped => (TerminalStatus::Skipped, ParseStatus::NotAttempted, false),
            Completion::DispatchFailure => {
                (TerminalStatus::Failed, ParseStatus::NotAttempted, false)
            }
            Completion::Parsed
                if !self.invalid
                    && self.text_utf8.complete()
                    && self.thinking_utf8.complete()
                    && self.provider_terminal == Some(ProviderTerminal::Complete) =>
            {
                (TerminalStatus::Succeeded, ParseStatus::Parsed, true)
            }
            _ => (TerminalStatus::Failed, ParseStatus::Invalid, true),
        };
        TerminalObservation {
            digest_version: OUTPUT_DIGEST_VERSION,
            provider_terminal: self.provider_terminal,
            terminal_status,
            parse_status,
            text_digest: format_digest(self.text),
            thinking_digest: format_digest(self.thinking),
            response_digest: has_response_digest.then(|| format_digest(self.response)),
        }
    }
}

fn domain_digest(domain: &[u8]) -> Sha256 {
    let mut digest = Sha256::new();
    digest.update(OUTPUT_DIGEST_VERSION.as_bytes());
    digest.update([0]);
    digest.update(domain);
    digest.update([0]);
    digest
}

fn format_digest(digest: Sha256) -> String {
    format!("sha256:{}", hex::encode(digest.finalize()))
}

/// Incremental UTF-8 validation without retaining any source bytes. The next
/// continuation range rejects overlong encodings, surrogates and > U+10FFFF.
#[derive(Default)]
struct Utf8State {
    remaining: u8,
    min: u8,
    max: u8,
}

impl Utf8State {
    fn complete(&self) -> bool {
        self.remaining == 0
    }

    fn observe(&mut self, byte: u8) -> bool {
        if self.remaining != 0 {
            if !(self.min..=self.max).contains(&byte) {
                return false;
            }
            self.remaining -= 1;
            self.min = 0x80;
            self.max = 0xbf;
            return true;
        }
        (self.remaining, self.min, self.max) = match byte {
            0x00..=0x7f => (0, 0, 0),
            0xc2..=0xdf => (1, 0x80, 0xbf),
            0xe0 => (2, 0xa0, 0xbf),
            0xe1..=0xec | 0xee..=0xef => (2, 0x80, 0xbf),
            0xed => (2, 0x80, 0x9f),
            0xf0 => (3, 0x90, 0xbf),
            0xf1..=0xf3 => (3, 0x80, 0xbf),
            0xf4 => (3, 0x80, 0x8f),
            _ => return false,
        };
        true
    }
}
