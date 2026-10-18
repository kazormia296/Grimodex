//! HTTP/1.1 for one loopback `POST` (K5/3 "client の規則"): the request head
//! that can only carry allow-listed headers, and incremental decoders for the
//! response head and the body framing. No I/O; input may be split anywhere.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use super::limits::Limits;
use super::WireFailure;

pub const REQUEST_PATH: &str = "/v1/chat/completions";

/// The fixed `User-Agent` (DR-DT5-10). It names the feature, not the version
/// or the machine, so the request leaks neither.
pub const USER_AGENT: &str = "Grimodex-NIR1-LocalSend/1";

/// The only headers a request carries, in the order they are written. The
/// request builder has no way to add another: there is no header list to
/// extend, so `Authorization`, `X-API-Key`, `Cookie`, `Proxy-*`, `Expect` and
/// `Transfer-Encoding` cannot be produced.
pub const REQUEST_HEADER_ALLOWLIST: [&str; 6] = [
    "Host",
    "User-Agent",
    "Accept",
    "Content-Type",
    "Content-Length",
    "Connection",
];

/// A connection target the transport may use: exactly `127.0.0.1` or `::1`
/// (no zone, no flow label) and a non-zero port. The route layer decides what
/// a configured URL means; this type only refuses anything it could not have
/// produced, so a socket address cannot be smuggled around that decision.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RequestTarget(SocketAddr);

impl RequestTarget {
    pub fn new(address: SocketAddr) -> Result<Self, WireFailure> {
        let literal_ok = match address.ip() {
            IpAddr::V4(ip) => ip == Ipv4Addr::LOCALHOST,
            IpAddr::V6(ip) => {
                ip == Ipv6Addr::LOCALHOST
                    && matches!(address, SocketAddr::V6(v6) if v6.scope_id() == 0 && v6.flowinfo() == 0)
            }
        };
        if !literal_ok || address.port() == 0 {
            return Err(WireFailure::TargetNotLoopbackLiteral);
        }
        Ok(Self(address))
    }

    pub fn socket_addr(&self) -> SocketAddr {
        self.0
    }

    fn host_header_value(&self) -> String {
        match self.0 {
            SocketAddr::V4(v4) => format!("{}:{}", v4.ip(), v4.port()),
            SocketAddr::V6(v6) => format!("[{}]:{}", v6.ip(), v6.port()),
        }
    }
}

/// The request line and headers, ending with the blank line. The caller writes
/// the body (the attempt's canonical payload, unchanged) right after it.
pub fn build_request_head(target: &RequestTarget, content_length: usize) -> Vec<u8> {
    let lines = [
        ("Host", target.host_header_value()),
        ("User-Agent", USER_AGENT.to_owned()),
        ("Accept", "text/event-stream".to_owned()),
        ("Content-Type", "application/json".to_owned()),
        ("Content-Length", content_length.to_string()),
        ("Connection", "close".to_owned()),
    ];
    let mut head = format!("POST {REQUEST_PATH} HTTP/1.1\r\n");
    for (name, value) in lines {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(&value);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    head.into_bytes()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HttpVersion {
    Http10,
    Http11,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Framing {
    Chunked,
    ContentLength(u64),
    UntilClose,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResponseHead {
    pub version: HttpVersion,
    pub framing: Framing,
    /// Bytes of the head as received (status line to the final blank line).
    pub head_bytes: usize,
}

#[derive(Debug, Eq, PartialEq)]
pub enum HeadProgress {
    NeedMore,
    /// The head ended; `consumed` bytes of the last input belong to it, the
    /// rest is already body.
    Complete {
        head: ResponseHead,
        consumed: usize,
    },
}

/// Collects the head up to the first blank line, never storing more than
/// `Limits::max_header_bytes`, then validates it as a whole.
pub struct HeadParser {
    limits: Limits,
    buf: Vec<u8>,
}

impl HeadParser {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            buf: Vec::new(),
        }
    }

    /// Bytes stored so far (a test hook: it never exceeds the header limit).
    #[cfg(test)]
    pub(crate) fn buffered_len(&self) -> usize {
        self.buf.len()
    }

    pub fn push(&mut self, input: &[u8]) -> Result<HeadProgress, WireFailure> {
        let before = self.buf.len();
        let room = self.limits.max_header_bytes.saturating_sub(before);
        let take = input.len().min(room);
        self.buf.extend_from_slice(&input[..take]);
        let search_from = before.saturating_sub(3);
        if let Some(position) = find_subsequence(&self.buf[search_from..], b"\r\n\r\n") {
            let end = search_from + position + 4;
            let head = parse_head(&self.buf[..end], self.limits)?;
            return Ok(HeadProgress::Complete {
                head,
                consumed: end - before,
            });
        }
        if take < input.len() || self.buf.len() >= self.limits.max_header_bytes {
            return Err(WireFailure::HeaderTooLarge);
        }
        Ok(HeadProgress::NeedMore)
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
}

/// Header values and reason phrases: no control byte but HTAB, no DEL. Bytes
/// from 0x80 are obs-text and pass.
fn is_field_byte(byte: u8) -> bool {
    byte == b'\t' || (byte >= 0x20 && byte != 0x7f)
}

fn trim_ows(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|byte| !matches!(byte, b' ' | b'\t'))
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|byte| !matches!(byte, b' ' | b'\t'))
        .map_or(start, |index| index + 1);
    &bytes[start..end]
}

fn parse_head(head: &[u8], limits: Limits) -> Result<ResponseHead, WireFailure> {
    // `head` ends with CRLFCRLF and contains no earlier one.
    let text = &head[..head.len() - 4];
    // Split on LF, then require every line but the last to end with CR and
    // no line to hold another CR: only CRLF separates lines.
    let mut cleaned: Vec<&[u8]> = Vec::new();
    let all: Vec<&[u8]> = text.split(|byte| *byte == b'\n').collect();
    for (index, line) in all.iter().enumerate() {
        let line = if index + 1 == all.len() {
            *line
        } else {
            line.strip_suffix(b"\r").ok_or(WireFailure::HeaderInvalid)?
        };
        if line.contains(&b'\r') || line.contains(&0) {
            return Err(WireFailure::HeaderInvalid);
        }
        cleaned.push(line);
    }
    let status_line = cleaned.first().copied().unwrap_or_default();
    let version = parse_status_line(status_line)?;

    let mut content_length: Option<&[u8]> = None;
    let mut transfer_encoding: Option<&[u8]> = None;
    let mut content_type: Option<&[u8]> = None;
    let mut content_encoding: Option<&[u8]> = None;
    for line in &cleaned[1..] {
        if matches!(line.first(), Some(b' ' | b'\t') | None) {
            // Obsolete line folding, or an empty line inside the head.
            return Err(WireFailure::HeaderInvalid);
        }
        let colon = line
            .iter()
            .position(|byte| *byte == b':')
            .ok_or(WireFailure::HeaderInvalid)?;
        let (name, value) = (&line[..colon], &line[colon + 1..]);
        if name.is_empty() || !name.iter().all(|byte| is_token_byte(*byte)) {
            return Err(WireFailure::HeaderInvalid);
        }
        if !value.iter().all(|byte| is_field_byte(*byte)) {
            return Err(WireFailure::HeaderInvalid);
        }
        let value = trim_ows(value);
        let slot = if name.eq_ignore_ascii_case(b"content-length") {
            &mut content_length
        } else if name.eq_ignore_ascii_case(b"transfer-encoding") {
            &mut transfer_encoding
        } else if name.eq_ignore_ascii_case(b"content-type") {
            &mut content_type
        } else if name.eq_ignore_ascii_case(b"content-encoding") {
            &mut content_encoding
        } else {
            continue;
        };
        if slot.replace(value).is_some() {
            return Err(WireFailure::DuplicateHeader);
        }
    }

    if transfer_encoding.is_some() && (version == HttpVersion::Http10 || content_length.is_some()) {
        return Err(WireFailure::AmbiguousFraming);
    }
    let content_type = content_type.ok_or(WireFailure::ContentTypeMissing)?;
    let media = content_type
        .split(|byte| *byte == b';')
        .next()
        .map(trim_ows)
        .unwrap_or_default();
    if !media.eq_ignore_ascii_case(b"text/event-stream") {
        return Err(WireFailure::ContentTypeNotEventStream);
    }
    if let Some(encoding) = content_encoding {
        if !encoding.eq_ignore_ascii_case(b"identity") {
            return Err(WireFailure::ContentEncodingUnsupported);
        }
    }
    let framing = if let Some(encoding) = transfer_encoding {
        if !encoding.eq_ignore_ascii_case(b"chunked") {
            return Err(WireFailure::TransferEncodingUnsupported);
        }
        Framing::Chunked
    } else if let Some(length) = content_length {
        Framing::ContentLength(parse_content_length(length, limits)?)
    } else {
        Framing::UntilClose
    };
    Ok(ResponseHead {
        version,
        framing,
        head_bytes: head.len(),
    })
}

fn parse_status_line(line: &[u8]) -> Result<HttpVersion, WireFailure> {
    let rest = line
        .strip_prefix(b"HTTP/")
        .ok_or(WireFailure::StatusLineInvalid)?;
    let version = match rest.get(..3) {
        Some(b"1.1") => HttpVersion::Http11,
        Some(b"1.0") => HttpVersion::Http10,
        Some(other)
            if other[0].is_ascii_digit() && other[1] == b'.' && other[2].is_ascii_digit() =>
        {
            return Err(WireFailure::HttpVersionUnsupported);
        }
        _ => return Err(WireFailure::StatusLineInvalid),
    };
    let rest = rest[3..]
        .strip_prefix(b" ")
        .ok_or(WireFailure::StatusLineInvalid)?;
    let (status, reason) = match rest.get(3) {
        None => (rest, &rest[rest.len()..]),
        Some(b' ') => (&rest[..3], &rest[4..]),
        Some(_) => return Err(WireFailure::StatusLineInvalid),
    };
    if status.len() != 3 || !status.iter().all(u8::is_ascii_digit) {
        return Err(WireFailure::StatusLineInvalid);
    }
    if !reason.iter().all(|byte| is_field_byte(*byte)) {
        return Err(WireFailure::StatusLineInvalid);
    }
    if status != b"200" {
        return Err(WireFailure::StatusNotOk);
    }
    Ok(version)
}

fn parse_content_length(value: &[u8], limits: Limits) -> Result<u64, WireFailure> {
    if value.is_empty() || !value.iter().all(u8::is_ascii_digit) {
        return Err(WireFailure::ContentLengthInvalid);
    }
    // 19 digits always fit in u64; anything longer is over any limit anyway.
    if value.len() > 19 {
        return Err(WireFailure::ContentLengthTooLarge);
    }
    let parsed = value
        .iter()
        .fold(0u64, |acc, digit| acc * 10 + u64::from(digit - b'0'));
    if parsed > limits.max_body_bytes as u64 {
        return Err(WireFailure::ContentLengthTooLarge);
    }
    Ok(parsed)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BodyState {
    Length { remaining: u64 },
    Close,
    ChunkSize,
    ChunkData { remaining: u64 },
    ChunkDataEnd { seen_cr: bool },
    Trailer,
    Done,
}

/// Turns the framed body into plain bytes. The count of everything received is
/// checked against `Limits::max_body_bytes` before the bytes are used; chunk
/// sizes are checked before any data of the chunk is read.
pub struct BodyDecoder {
    limits: Limits,
    state: BodyState,
    received: usize,
    header_bytes: usize,
    trailer_bytes: usize,
    line: Vec<u8>,
}

impl BodyDecoder {
    pub fn new(framing: Framing, limits: Limits, head_bytes: usize) -> Self {
        let state = match framing {
            Framing::Chunked => BodyState::ChunkSize,
            Framing::ContentLength(0) => BodyState::Done,
            Framing::ContentLength(remaining) => BodyState::Length { remaining },
            Framing::UntilClose => BodyState::Close,
        };
        Self {
            limits,
            state,
            received: 0,
            header_bytes: head_bytes,
            trailer_bytes: 0,
            line: Vec::new(),
        }
    }

    /// The framing itself ended (never true for a close-delimited body).
    pub fn is_complete(&self) -> bool {
        self.state == BodyState::Done
    }

    /// Appends the decoded bytes of `input` to `out` (never more than
    /// `input.len()`). Bytes decoded before an error stay in `out`.
    pub fn push(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), WireFailure> {
        if input.is_empty() {
            return Ok(());
        }
        if self.state == BodyState::Done {
            return Err(WireFailure::BytesAfterBodyEnd);
        }
        let allowed = self.limits.max_body_bytes.saturating_sub(self.received);
        let take = input.len().min(allowed);
        self.received += take;
        self.consume(&input[..take], out)?;
        if take < input.len() {
            return Err(WireFailure::BodyTooLarge);
        }
        Ok(())
    }

    /// The peer closed: fine for a close-delimited body or a finished one.
    pub fn finish_eof(&mut self) -> Result<(), WireFailure> {
        match self.state {
            BodyState::Close | BodyState::Done => Ok(()),
            _ => Err(WireFailure::TruncatedBody),
        }
    }

    fn consume(&mut self, mut data: &[u8], out: &mut Vec<u8>) -> Result<(), WireFailure> {
        while !data.is_empty() {
            match self.state {
                BodyState::Done => return Err(WireFailure::BytesAfterBodyEnd),
                BodyState::Close => {
                    out.extend_from_slice(data);
                    return Ok(());
                }
                BodyState::Length { remaining } => {
                    let take = (data.len() as u64).min(remaining) as usize;
                    out.extend_from_slice(&data[..take]);
                    data = &data[take..];
                    let remaining = remaining - take as u64;
                    self.state = if remaining == 0 {
                        BodyState::Done
                    } else {
                        BodyState::Length { remaining }
                    };
                }
                BodyState::ChunkData { remaining } => {
                    let take = (data.len() as u64).min(remaining) as usize;
                    out.extend_from_slice(&data[..take]);
                    data = &data[take..];
                    let remaining = remaining - take as u64;
                    self.state = if remaining == 0 {
                        BodyState::ChunkDataEnd { seen_cr: false }
                    } else {
                        BodyState::ChunkData { remaining }
                    };
                }
                BodyState::ChunkDataEnd { seen_cr } => {
                    let byte = data[0];
                    data = &data[1..];
                    self.state = match (seen_cr, byte) {
                        (false, b'\r') => BodyState::ChunkDataEnd { seen_cr: true },
                        (true, b'\n') => BodyState::ChunkSize,
                        _ => return Err(WireFailure::ChunkFramingInvalid),
                    };
                }
                BodyState::ChunkSize => {
                    let byte = data[0];
                    data = &data[1..];
                    if self.line_byte(byte, false)? {
                        let size = parse_chunk_size(&self.line, self.limits)?;
                        self.line.clear();
                        self.state = if size == 0 {
                            BodyState::Trailer
                        } else {
                            BodyState::ChunkData { remaining: size }
                        };
                    }
                }
                BodyState::Trailer => {
                    let byte = data[0];
                    data = &data[1..];
                    self.trailer_bytes += 1;
                    if self.header_bytes + self.trailer_bytes > self.limits.max_header_bytes {
                        return Err(WireFailure::HeaderTooLarge);
                    }
                    if self.line_byte(byte, true)? {
                        let empty = self.line.is_empty();
                        self.line.clear();
                        if empty {
                            self.state = BodyState::Done;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Adds one byte to the current CRLF-terminated line. `true` when the line
    /// is complete (CRLF removed). A lone CR or LF is a framing error.
    fn line_byte(&mut self, byte: u8, trailer: bool) -> Result<bool, WireFailure> {
        if byte == b'\n' {
            return match self.line.pop() {
                Some(b'\r') => Ok(true),
                _ => Err(WireFailure::ChunkFramingInvalid),
            };
        }
        if self.line.last() == Some(&b'\r') || byte == 0 {
            return Err(WireFailure::ChunkFramingInvalid);
        }
        // The line proper (without CRLF) is bounded; one CR may follow it.
        if !trailer {
            let content = self.line.len();
            if (byte != b'\r' && content >= self.limits.max_chunk_line_bytes)
                || content > self.limits.max_chunk_line_bytes
            {
                return Err(WireFailure::ChunkLineTooLong);
            }
        }
        self.line.push(byte);
        Ok(false)
    }
}

fn parse_chunk_size(line: &[u8], limits: Limits) -> Result<u64, WireFailure> {
    // Everything after the first `;` is a chunk extension and is ignored.
    let digits = line.split(|byte| *byte == b';').next().unwrap_or_default();
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_hexdigit) {
        return Err(WireFailure::ChunkSizeInvalid);
    }
    if digits.len() > limits.max_chunk_size_digits || digits.len() > 16 {
        return Err(WireFailure::ChunkSizeTooLong);
    }
    let value = digits.iter().fold(0u64, |acc, digit| {
        acc * 16 + u64::from((*digit as char).to_digit(16).unwrap_or(0))
    });
    if value > limits.max_chunk_bytes as u64 {
        return Err(WireFailure::ChunkTooLarge);
    }
    Ok(value)
}
