//! The strict Server-Sent Events reader of K5/3 "wire と終端の規則" rules 1-8.
//!
//! Decoded body bytes in; [`WireEvent`]s out, in the order the observer must
//! see them. Anything the rules do not name fails (nothing is skipped), and the
//! outcome never depends on how the bytes were split: lines are decoded only
//! when complete, a CR at the end of one input and its LF at the start of the
//! next are one terminator, and events are dispatched only by their blank line.

use serde_json::{Map, Value};

use super::limits::Limits;
use super::WireFailure;
use crate::narrative_nir1_receipt::ProviderTerminal;

/// What the stream said, in observation order. Within one SSE event: thinking,
/// then text, then the terminal (never the JSON key order).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WireEvent {
    Thinking(String),
    Text(String),
    Terminal(ProviderTerminal),
    Done,
}

const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    /// No `finish_reason` yet.
    Streaming,
    /// `stop` seen: only `[DONE]` may follow.
    AfterStop,
    /// `[DONE]` seen: only blank lines and comments may follow.
    AfterDone,
}

pub struct SseParser {
    limits: Limits,
    phase: Phase,
    failed: Option<WireFailure>,
    at_stream_start: bool,
    after_cr: bool,
    line: Vec<u8>,
    event_bytes: usize,
    data: String,
    has_data: bool,
    text_bytes: usize,
    thinking_bytes: usize,
}

impl SseParser {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            phase: Phase::Streaming,
            failed: None,
            at_stream_start: true,
            after_cr: false,
            line: Vec::new(),
            event_bytes: 0,
            data: String::new(),
            has_data: false,
            text_bytes: 0,
            thinking_bytes: 0,
        }
    }

    /// Bytes held for the unfinished line and event (a test hook).
    #[cfg(test)]
    pub(crate) fn held_len(&self) -> usize {
        self.line.len() + self.data.len()
    }

    /// Feeds decoded body bytes. Events completed before a failing byte are in
    /// `out` even when this returns `Err`; afterwards the parser keeps
    /// returning that failure.
    pub fn push(&mut self, bytes: &[u8], out: &mut Vec<WireEvent>) -> Result<(), WireFailure> {
        if let Some(failure) = self.failed {
            return Err(failure);
        }
        for &byte in bytes {
            if let Err(failure) = self.byte(byte, out) {
                self.failed = Some(failure);
                return Err(failure);
            }
        }
        Ok(())
    }

    /// The body ended. Success needs `stop` and `[DONE]` once each and no
    /// unfinished line or event.
    pub fn finish(&mut self) -> Result<(), WireFailure> {
        if let Some(failure) = self.failed {
            return Err(failure);
        }
        let result = self.check_finished();
        if let Err(failure) = result {
            self.failed = Some(failure);
        }
        result
    }

    fn check_finished(&self) -> Result<(), WireFailure> {
        if !self.line.is_empty() {
            // Only a comment may be left unfinished, and only after `[DONE]`.
            let comment =
                self.line.first() == Some(&b':') && std::str::from_utf8(&self.line).is_ok();
            if self.phase != Phase::AfterDone || !comment {
                return Err(WireFailure::IncompleteLine);
            }
        }
        if self.has_data {
            return Err(WireFailure::IncompleteEvent);
        }
        match self.phase {
            Phase::Streaming => Err(WireFailure::MissingTerminal),
            Phase::AfterStop => Err(WireFailure::MissingDone),
            Phase::AfterDone => Ok(()),
        }
    }

    fn byte(&mut self, byte: u8, out: &mut Vec<WireEvent>) -> Result<(), WireFailure> {
        self.event_bytes += 1;
        if self.event_bytes > self.limits.max_event_bytes {
            return Err(WireFailure::EventTooLarge);
        }
        if self.after_cr {
            self.after_cr = false;
            if byte == b'\n' {
                return Ok(());
            }
        }
        match byte {
            b'\r' => {
                self.after_cr = true;
                self.end_line(out)
            }
            b'\n' => self.end_line(out),
            _ => {
                self.line.push(byte);
                Ok(())
            }
        }
    }

    fn end_line(&mut self, out: &mut Vec<WireEvent>) -> Result<(), WireFailure> {
        let line = std::mem::take(&mut self.line);
        let mut bytes: &[u8] = &line;
        if std::mem::take(&mut self.at_stream_start) && bytes.starts_with(&BOM) {
            bytes = &bytes[BOM.len()..];
        }
        let result = match std::str::from_utf8(bytes) {
            Err(_) => Err(WireFailure::InvalidUtf8),
            Ok("") => self.dispatch(out),
            Ok(text) => self.field_line(text),
        };
        // Keep the allocation for the next line.
        self.line = line;
        self.line.clear();
        result
    }

    fn field_line(&mut self, line: &str) -> Result<(), WireFailure> {
        if self.phase == Phase::AfterDone {
            return if line.starts_with(':') {
                Ok(())
            } else {
                Err(WireFailure::DataAfterDone)
            };
        }
        if line.starts_with(':') {
            return Ok(());
        }
        let (name, value) = match line.split_once(':') {
            Some((name, value)) => (name, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match name {
            "data" => {
                self.data.push_str(value);
                self.data.push('\n');
                self.has_data = true;
                Ok(())
            }
            "id" | "retry" => Ok(()),
            _ => Err(WireFailure::UnknownField),
        }
    }

    fn dispatch(&mut self, out: &mut Vec<WireEvent>) -> Result<(), WireFailure> {
        self.event_bytes = 0;
        if !std::mem::take(&mut self.has_data) {
            return Ok(());
        }
        let mut data = std::mem::take(&mut self.data);
        data.pop(); // the LF every `data` line appended
        if data.is_empty() {
            return Ok(());
        }
        match (self.phase, data.as_str()) {
            (Phase::AfterDone, _) => Err(WireFailure::DataAfterDone),
            (Phase::AfterStop, "[DONE]") => {
                self.phase = Phase::AfterDone;
                out.push(WireEvent::Done);
                Ok(())
            }
            (Phase::AfterStop, _) => Err(WireFailure::DataAfterTerminal),
            (Phase::Streaming, "[DONE]") => Err(WireFailure::DoneBeforeTerminal),
            (Phase::Streaming, json) => self.chunk_event(json, out),
        }
    }

    fn chunk_event(&mut self, json: &str, out: &mut Vec<WireEvent>) -> Result<(), WireFailure> {
        let value: Value = serde_json::from_str(json).map_err(|_| WireFailure::InvalidJson)?;
        let Value::Object(top) = value else {
            return Err(WireFailure::DataNotJsonObject);
        };
        if top.contains_key("error") {
            return Err(WireFailure::ErrorObject);
        }
        let choice = match top.get("choices") {
            Some(Value::Array(choices)) if choices.len() == 1 => match &choices[0] {
                Value::Object(choice) => choice,
                _ => return Err(WireFailure::ChoicesShape),
            },
            _ => return Err(WireFailure::ChoicesShape),
        };
        if choice.get("index").and_then(Value::as_u64) != Some(0) {
            return Err(WireFailure::ChoiceIndex);
        }
        for (key, value) in choice {
            match key.as_str() {
                "index" | "delta" | "finish_reason" => {}
                // Scalars and null (`logprobs: null`, `stop_reason: 2`) carry no
                // content; an object or array might (`message`), so it fails.
                _ if matches!(value, Value::Object(_) | Value::Array(_)) => {
                    return Err(WireFailure::ChoiceKeyNotAllowed);
                }
                _ => {}
            }
        }
        let (thinking, text) = match choice.get("delta") {
            None => (None, None),
            Some(Value::Object(delta)) => interpret_delta(delta)?,
            Some(_) => return Err(WireFailure::DeltaInvalid),
        };
        let terminal = match choice.get("finish_reason") {
            None | Some(Value::Null) => None,
            Some(Value::String(reason)) if reason == "stop" => Some(ProviderTerminal::Complete),
            Some(Value::String(reason)) if reason == "length" => {
                Some(ProviderTerminal::LengthLimit)
            }
            Some(_) => Some(ProviderTerminal::Ineligible),
        };

        // Nothing of this event is emitted unless all of it is acceptable.
        let thinking_len = thinking.map_or(0, str::len);
        let text_len = text.map_or(0, str::len);
        if self.thinking_bytes + thinking_len > self.limits.max_thinking_bytes {
            return Err(WireFailure::ThinkingLimit);
        }
        if self.text_bytes + text_len > self.limits.max_text_bytes {
            return Err(WireFailure::TextLimit);
        }
        self.thinking_bytes += thinking_len;
        self.text_bytes += text_len;
        if let Some(thinking) = thinking.filter(|value| !value.is_empty()) {
            out.push(WireEvent::Thinking(thinking.to_owned()));
        }
        if let Some(text) = text.filter(|value| !value.is_empty()) {
            out.push(WireEvent::Text(text.to_owned()));
        }
        if let Some(terminal) = terminal {
            out.push(WireEvent::Terminal(terminal));
            if terminal != ProviderTerminal::Complete {
                return Err(WireFailure::ProviderTerminalNotComplete(terminal));
            }
            self.phase = Phase::AfterStop;
        }
        Ok(())
    }
}

/// The `delta` allow-list: `role` (`assistant` or null), `content`, and the
/// thinking fields `reasoning_content` and `reasoning`. Any other key must be
/// null. Returns `(thinking, text)`.
fn interpret_delta(
    delta: &Map<String, Value>,
) -> Result<(Option<&str>, Option<&str>), WireFailure> {
    let mut text = None;
    let mut thinking: Option<&str> = None;
    for (key, value) in delta {
        match (key.as_str(), value) {
            (_, Value::Null) => {}
            ("role", Value::String(role)) if role == "assistant" => {}
            ("role", _) => return Err(WireFailure::DeltaInvalid),
            ("content", Value::String(content)) => text = Some(content.as_str()),
            ("reasoning_content" | "reasoning", Value::String(value)) => match thinking {
                // Two thinking fields in one delta: equal counts once.
                Some(previous) if previous != value => return Err(WireFailure::ThinkingConflict),
                _ => thinking = Some(value.as_str()),
            },
            ("content" | "reasoning_content" | "reasoning", _) => {
                return Err(WireFailure::DeltaInvalid);
            }
            _ => return Err(WireFailure::DeltaKeyNotAllowed),
        }
    }
    Ok((thinking, text))
}
