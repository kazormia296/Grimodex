//! Vectors for the pure wire layer (DT-5a). Every positive vector is also run
//! through every split of its bytes (DG-4); every negative vector fails with
//! the same failure and the same prior events wherever it is split.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6};

use serde_json::json;

use super::http::{BodyDecoder, Framing, HeadParser, HeadProgress, HttpVersion};
use super::sse::SseParser;
use super::*;
use crate::narrative_nir1_receipt::{
    validate_terminal_matrix, OutputChannel, OutputObserver, ParseStatus, TerminalObservation,
    TerminalStatus,
};

// ---------------------------------------------------------------- builders

fn chunk_event(delta: serde_json::Value, finish: Option<&str>) -> String {
    let mut choice = json!({"index": 0, "delta": delta});
    if let Some(reason) = finish {
        choice["finish_reason"] = json!(reason);
    }
    event(&json!({"id": "c1", "object": "chat.completion.chunk", "choices": [choice]}).to_string())
}

fn event(json: &str) -> String {
    format!("data: {json}\n\n")
}

fn text(content: &str) -> String {
    chunk_event(json!({"content": content}), None)
}

fn thinking(content: &str) -> String {
    chunk_event(json!({"reasoning_content": content}), None)
}

fn stop() -> String {
    chunk_event(json!({}), Some("stop"))
}

const DONE: &str = "data: [DONE]\n\n";

fn good_stream() -> String {
    [
        chunk_event(json!({"role": "assistant", "content": ""}), None),
        thinking("hmm "),
        text("Hel"),
        thinking("ok"),
        text("lo e\u{301} \u{1F600}"),
        chunk_event(json!({"content": "!"}), Some("stop")),
        DONE.to_owned(),
    ]
    .concat()
}

/// A short stream (about 200 bytes on the wire) so that every pair of cut
/// points can be tried.
fn small_stream() -> String {
    [
        thinking("r"),
        chunk_event(json!({"content": "\u{e9}\u{1F600}"}), Some("stop")),
        DONE.to_owned(),
    ]
    .concat()
}

fn head_with(lines: &str) -> String {
    format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n{lines}\r\n")
}

fn chunked_body(body: &[u8], size: usize) -> Vec<u8> {
    let mut out = Vec::new();
    for chunk in body.chunks(size.max(1)) {
        out.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
        out.extend_from_slice(chunk);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"0\r\n\r\n");
    out
}

fn response_chunked(body: &str, size: usize) -> Vec<u8> {
    let mut out = head_with("Transfer-Encoding: chunked\r\n").into_bytes();
    out.extend(chunked_body(body.as_bytes(), size));
    out
}

fn response_length(body: &str) -> Vec<u8> {
    let mut out = head_with(&format!("Content-Length: {}\r\n", body.len())).into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}

fn response_close(body: &str) -> Vec<u8> {
    let mut out = head_with("").into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}

// ------------------------------------------------------------------ driver

#[derive(Debug, Eq, PartialEq)]
struct Outcome {
    events: Vec<WireEvent>,
    result: Result<(), WireFailure>,
}

/// Feeds `bytes` cut at the given sorted positions, then (if the response did
/// not end by itself) the peer's close.
fn feed(bytes: &[u8], cuts: &[usize], limits: Limits) -> Outcome {
    let mut parser = ResponseParser::new(limits);
    let mut events = Vec::new();
    let mut start = 0;
    let mut progress = Progress::NeedMore;
    let mut boundaries = cuts.to_vec();
    boundaries.push(bytes.len());
    for end in boundaries {
        match parser.push(&bytes[start..end], &mut events) {
            Ok(next) => progress = next,
            Err(failure) => {
                return Outcome {
                    events,
                    result: Err(failure),
                }
            }
        }
        start = end;
    }
    let result = match progress {
        Progress::Finished => Ok(()),
        Progress::NeedMore => parser.finish_eof(),
    };
    Outcome { events, result }
}

fn run(bytes: &[u8]) -> Outcome {
    feed(bytes, &[], Limits::DEFAULT)
}

fn failure_of(bytes: &[u8]) -> WireFailure {
    run(bytes).result.expect_err("expected a failure")
}

/// The outcome is the same for every single cut and for byte-at-a-time.
fn assert_split_invariant(label: &str, bytes: &[u8], limits: Limits) -> Outcome {
    let whole = feed(bytes, &[], limits);
    for cut in 1..bytes.len() {
        assert_eq!(
            feed(bytes, &[cut], limits),
            whole,
            "{label}: one cut at {cut}"
        );
    }
    let every: Vec<usize> = (1..bytes.len()).collect();
    assert_eq!(
        feed(bytes, &every, limits),
        whole,
        "{label}: byte at a time"
    );
    whole
}

fn observe(outcome: &Outcome) -> TerminalObservation {
    let mut observer = OutputObserver::new();
    for event in &outcome.events {
        let _ = match event {
            WireEvent::Text(text) => observer.observe(OutputChannel::Text, text.as_bytes()),
            WireEvent::Thinking(text) => observer.observe(OutputChannel::Thinking, text.as_bytes()),
            WireEvent::Terminal(terminal) => observer.observe_terminal(*terminal),
            WireEvent::Done => Ok(()),
        };
    }
    let end = match outcome.result {
        Ok(()) => TransportEnd::Parsed,
        Err(failure) => TransportEnd::FailedAfterSend(failure),
    };
    observer.finish(end.completion())
}

fn texts(outcome: &Outcome) -> (String, String) {
    let mut text = String::new();
    let mut thinking = String::new();
    for event in &outcome.events {
        match event {
            WireEvent::Text(piece) => text.push_str(piece),
            WireEvent::Thinking(piece) => thinking.push_str(piece),
            _ => {}
        }
    }
    (text, thinking)
}

fn assert_success(label: &str, bytes: &[u8]) -> Outcome {
    let outcome = assert_split_invariant(label, bytes, Limits::DEFAULT);
    assert_eq!(outcome.result, Ok(()), "{label}");
    assert_eq!(observe(&outcome).terminal_status, TerminalStatus::Succeeded);
    outcome
}

/// A body (SSE bytes) that must fail with exactly `want`, in all three
/// framings and under every cut.
fn assert_sse_failure(label: &str, body: &str, want: WireFailure) {
    for (framing, bytes) in [
        ("chunked", response_chunked(body, 7)),
        ("length", response_length(body)),
        ("close", response_close(body)),
    ] {
        let outcome =
            assert_split_invariant(&format!("{label}/{framing}"), &bytes, Limits::DEFAULT);
        assert_eq!(outcome.result, Err(want), "{label}/{framing}");
        let observed = observe(&outcome);
        assert_eq!(observed.terminal_status, TerminalStatus::Failed);
        assert_eq!(observed.parse_status, ParseStatus::Invalid);
    }
}

// -------------------------------------------------------------------- W1-W4

#[test]
fn w1_digest_does_not_depend_on_how_the_bytes_are_split() {
    let body = good_stream();
    let mut reference: Option<TerminalObservation> = None;
    for (label, bytes) in [
        ("chunked 1", response_chunked(&body, 1)),
        ("chunked 5", response_chunked(&body, 5)),
        ("chunked 64", response_chunked(&body, 64)),
        ("chunked whole", response_chunked(&body, body.len())),
        ("length", response_length(&body)),
        ("close", response_close(&body)),
    ] {
        let outcome = assert_success(label, &bytes);
        let observed = observe(&outcome);
        assert_eq!(observed.parse_status, ParseStatus::Parsed, "{label}");
        assert!(observed.response_digest.is_some());
        match &reference {
            None => reference = Some(observed),
            Some(first) => assert_eq!(&observed, first, "{label}"),
        }
        let (text, thinking) = texts(&outcome);
        assert_eq!(text, "Hello e\u{301} \u{1F600}!");
        assert_eq!(thinking, "hmm ok");
        assert_eq!(
            outcome.events.last(),
            Some(&WireEvent::Done),
            "[DONE] is the last event"
        );
    }
}

#[test]
fn w1_every_pair_of_cuts_of_a_small_stream() {
    let body = small_stream();
    for (label, bytes) in [
        ("chunked", response_chunked(&body, 9)),
        ("length", response_length(&body)),
        ("close", response_close(&body)),
    ] {
        let whole = feed(&bytes, &[], Limits::DEFAULT);
        assert_eq!(whole.result, Ok(()), "{label}");
        for first in 1..bytes.len() {
            for second in first + 1..bytes.len() {
                let split = feed(&bytes, &[first, second], Limits::DEFAULT);
                assert_eq!(split, whole, "{label}: cuts {first},{second}");
            }
        }
    }
}

#[test]
fn w1_the_digest_does_not_depend_on_how_the_server_cut_its_events() {
    // The same output in the same interleaving, cut into events in different
    // ways (the last text shares an event with `stop` in one of them).
    let variants: [Vec<String>; 4] = [
        vec![text("ab"), thinking("xy"), text("cd"), stop()],
        vec![
            text("a"),
            text("b"),
            thinking("x"),
            thinking("y"),
            text("c"),
            text("d"),
            stop(),
        ],
        vec![
            text("ab"),
            thinking("xy"),
            text("c"),
            chunk_event(json!({"content": "d"}), Some("stop")),
        ],
        // Empty deltas, null content and a keep-alive comment change nothing.
        vec![
            chunk_event(json!({"content": ""}), None),
            ": keep-alive\n\n".to_owned(),
            text("ab"),
            chunk_event(json!({}), None),
            thinking("xy"),
            text("cd"),
            chunk_event(json!({"content": null}), Some("stop")),
        ],
    ];
    let mut digests = Vec::new();
    for (index, events) in variants.iter().enumerate() {
        let body = [events.concat(), DONE.to_owned()].concat();
        let outcome = assert_success(&format!("variant {index}"), &response_chunked(&body, 3));
        digests.push(observe(&outcome));
    }
    for pair in digests.windows(2) {
        assert_eq!(pair[0], pair[1]);
    }
}

#[test]
fn w2_accepted_variations() {
    let finish = [stop(), DONE.to_owned()].concat();

    // HTTP/1.0 with a close-delimited body.
    let body = [text("hi"), finish.clone()].concat();
    let mut http10 = b"HTTP/1.0 200 OK\r\nContent-Type: text/event-stream\r\n\r\n".to_vec();
    http10.extend_from_slice(body.as_bytes());
    let outcome = assert_success("http/1.0", &http10);
    assert_eq!(texts(&outcome).0, "hi");

    // Media type spelling, parameters, an explicit identity encoding, a status
    // line without a reason phrase, and header name case.
    let mut odd = b"HTTP/1.1 200\r\ncontent-type:  Text/Event-Stream ; charset=utf-8\r\nCONTENT-ENCODING: Identity\r\nX-Anything: a\tb\r\nContent-Length: ".to_vec();
    odd.extend_from_slice(format!("{}\r\n\r\n{body}", body.len()).as_bytes());
    assert_success("media type spelling", &odd);

    // Unknown choice keys that are null or scalars, extra top-level keys, a
    // non-terminal event without `finish_reason`, a null `role`.
    let rich = event(
        &json!({
            "id": "x", "model": "m", "created": 1, "system_fingerprint": "fp",
            "usage": null, "timings": {"predicted_n": 3},
            "choices": [{
                "index": 0, "logprobs": null, "stop_reason": null,
                "matched_stop": 151645, "native_finish_reason": "x", "flag": true,
                "delta": {"role": null, "content": "a", "refusal": null, "tool_calls": null}
            }]
        })
        .to_string(),
    );
    let outcome = assert_success(
        "rich",
        &response_chunked(&[rich, finish.clone()].concat(), 11),
    );
    assert_eq!(texts(&outcome).0, "a");

    // The last text and `stop` in one event.
    let outcome = assert_success(
        "text with stop",
        &response_length(
            &[
                chunk_event(json!({"content": "z"}), Some("stop")),
                DONE.to_owned(),
            ]
            .concat(),
        ),
    );
    assert_eq!(
        outcome.events,
        vec![
            WireEvent::Text("z".into()),
            WireEvent::Terminal(ProviderTerminal::Complete),
            WireEvent::Done
        ]
    );

    // `data:` with and without the space; two spaces keep one.
    let json_a = json!({"choices": [{"index": 0, "delta": {"content": "a"}}]}).to_string();
    let stop_json =
        json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}).to_string();
    for body in [
        format!("data:{json_a}\n\ndata:{stop_json}\n\ndata:[DONE]\n\n"),
        format!("data: {json_a}\n\ndata:  {stop_json}\n\ndata: [DONE]\n\n"),
    ] {
        assert_success("data spacing", &response_chunked(&body, 4));
    }

    // A JSON value split over several `data` lines is joined with LF.
    let multi = format!(
        "data: {{\"choices\":\ndata: [{{\"index\":0,\ndata: \"delta\":{{\"content\":\"m\"}}}}]}}\n\n{}{DONE}",
        stop()
    );
    let outcome = assert_success("multi-line data", &response_length(&multi));
    assert_eq!(texts(&outcome).0, "m");

    // A single BOM at the start; comments, `id` and `retry`, empty `data`
    // events, and extra blank lines.
    let noisy = format!(
        "\u{feff}: hello\n\nid: 7\nretry: 100\ndata\n\ndata:\n\n{}\n\n{}{DONE}\n\n: bye\n\n",
        text("b").trim_end(),
        stop()
    );
    let outcome = assert_success("bom and noise", &response_chunked(&noisy, 5));
    assert_eq!(texts(&outcome).0, "b");

    // Line endings: CR only, CRLF, and a mixture (CR only for blank lines, so
    // that no CR is accidentally joined to an LF).
    let lines = [text("c"), stop(), DONE.to_owned()].concat();
    let mixed = {
        let mut mixed = String::new();
        let mut counter = 0;
        for line in lines.split_inclusive('\n') {
            if line == "\n" {
                mixed.push('\r');
            } else {
                mixed.push_str(line.trim_end_matches('\n'));
                mixed.push_str(if counter % 2 == 0 { "\r\n" } else { "\n" });
                counter += 1;
            }
        }
        mixed
    };
    for (label, body) in [
        ("cr", lines.replace('\n', "\r")),
        ("crlf", lines.replace('\n', "\r\n")),
        ("mixed", mixed),
    ] {
        let outcome = assert_success(label, &response_chunked(&body, 2));
        assert_eq!(texts(&outcome).0, "c", "{label}");
    }

    // Chunk extensions and trailers.
    let body = [text("t"), finish.clone()].concat();
    let (first, second) = body.as_bytes().split_at(body.len() / 2);
    let mut ext = head_with("Transfer-Encoding: chunked\r\n").into_bytes();
    ext.extend_from_slice(format!("{:X};name=value\r\n", first.len()).as_bytes());
    ext.extend_from_slice(first);
    ext.extend_from_slice(b"\r\n");
    ext.extend_from_slice(format!("{:x};\r\n", second.len()).as_bytes());
    ext.extend_from_slice(second);
    ext.extend_from_slice(b"\r\n0;last=1\r\nX-Trailer: a\r\nX-Other: b\r\n\r\n");
    assert_success("chunk extension and trailer", &ext);

    // Two thinking fields in one delta count once when they agree.
    let both = chunk_event(
        json!({"reasoning_content": "same", "reasoning": "same"}),
        None,
    );
    let outcome = assert_success(
        "two thinking fields",
        &response_length(&[both, finish.clone()].concat()),
    );
    assert_eq!(texts(&outcome).1, "same");
    let only_reasoning = chunk_event(json!({"reasoning": "r"}), None);
    let outcome = assert_success(
        "reasoning field",
        &response_length(&[only_reasoning, finish].concat()),
    );
    assert_eq!(texts(&outcome).1, "r");
}

#[test]
fn w3_utf8_split_at_every_boundary_gives_one_digest() {
    let body = [
        text("e\u{301}"),
        text("\u{1F600}\u{1F4A9}"),
        text("\u{3042}\u{3044}"),
        stop(),
        DONE.to_owned(),
    ]
    .concat();
    let mut seen = Vec::new();
    for chunk_size in [1usize, 2, 3, 4, 5, 7] {
        let outcome = assert_success("utf-8", &response_chunked(&body, chunk_size));
        assert_eq!(
            texts(&outcome).0,
            "e\u{301}\u{1F600}\u{1F4A9}\u{3042}\u{3044}"
        );
        seen.push(observe(&outcome));
    }
    assert!(seen.windows(2).all(|pair| pair[0] == pair[1]));

    // The raw `data` line cut inside a character: the line is decoded only
    // when complete.
    let raw = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"\u{1F600}\"}}]}\n\n";
    let bytes = raw.as_bytes();
    let position = raw.find('\u{1F600}').unwrap();
    for cut in position + 1..position + 4 {
        let mut parser = SseParser::new(Limits::DEFAULT);
        let mut events = Vec::new();
        parser.push(&bytes[..cut], &mut events).unwrap();
        parser.push(&bytes[cut..], &mut events).unwrap();
        assert_eq!(events, vec![WireEvent::Text("\u{1F600}".into())]);
    }
}

#[test]
fn w3_invalid_utf8_fails() {
    for (label, bad) in [
        (
            "data line",
            b"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"\xff\"}}]}\n\n".to_vec(),
        ),
        ("comment line", b": \xc3\n\n".to_vec()),
        ("truncated character", b"data: \xe3\x81\n\n".to_vec()),
        ("overlong", b"data: \xc0\xaf\n\n".to_vec()),
        ("surrogate", b"data: \xed\xa0\x80\n\n".to_vec()),
    ] {
        let mut bytes = head_with("").into_bytes();
        bytes.extend_from_slice(&bad);
        let outcome = assert_split_invariant(label, &bytes, Limits::DEFAULT);
        assert_eq!(outcome.result, Err(WireFailure::InvalidUtf8), "{label}");
    }
    // An invalid byte inside an ignored comment after `[DONE]` also fails.
    let mut bytes = response_close(&[text("a"), stop(), DONE.to_owned()].concat());
    bytes.extend_from_slice(b": \xff\n");
    assert_eq!(failure_of(&bytes), WireFailure::InvalidUtf8);
}

#[test]
fn w4_the_response_digest_follows_arrival_order_but_not_chunk_boundaries() {
    let order_a = [thinking("ab"), text("cd"), stop(), DONE.to_owned()].concat();
    let order_b = [text("cd"), thinking("ab"), stop(), DONE.to_owned()].concat();
    let a = observe(&assert_success("a", &response_length(&order_a)));
    let b = observe(&assert_success("b", &response_length(&order_b)));
    assert_eq!(a.text_digest, b.text_digest);
    assert_eq!(a.thinking_digest, b.thinking_digest);
    assert_ne!(a.response_digest, b.response_digest);

    // Boundaries do not matter: "ab" as one delta or two, thinking likewise.
    let order_a_cut = [
        thinking("a"),
        thinking("b"),
        text("c"),
        text("d"),
        stop(),
        DONE.to_owned(),
    ]
    .concat();
    assert_eq!(
        observe(&assert_success("a cut", &response_chunked(&order_a_cut, 6))),
        a
    );

    // Two thinking fields with different values in one delta fail.
    let conflict = chunk_event(json!({"reasoning_content": "x", "reasoning": "y"}), None);
    assert_sse_failure(
        "thinking conflict",
        &conflict,
        WireFailure::ThinkingConflict,
    );
}

// ----------------------------------------------------------------------- N1

fn head_failure(head: &str) -> WireFailure {
    let mut bytes = head.as_bytes().to_vec();
    bytes.extend_from_slice(good_stream().as_bytes());
    let outcome = assert_split_invariant(head, &bytes, Limits::DEFAULT);
    outcome.result.expect_err(head)
}

#[test]
fn n1_status_and_version() {
    for status in [
        "100 Continue",
        "201 Created",
        "204 No Content",
        "301 Moved",
        "302 Found",
        "307 Temporary Redirect",
        "401 Unauthorized",
        "404 Not Found",
        "429 Too Many Requests",
        "500 Internal Server Error",
        "503 Service Unavailable",
    ] {
        let head = format!("HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\n\r\n");
        assert_eq!(head_failure(&head), WireFailure::StatusNotOk, "{status}");
    }
    for (line, want) in [
        ("HTTP/2 200 OK", WireFailure::StatusLineInvalid),
        ("HTTP/2.0 200 OK", WireFailure::HttpVersionUnsupported),
        ("HTTP/1.2 200 OK", WireFailure::HttpVersionUnsupported),
        ("HTTP/0.9 200 OK", WireFailure::HttpVersionUnsupported),
        ("http/1.1 200 OK", WireFailure::StatusLineInvalid),
        ("HTTP/1.1  200 OK", WireFailure::StatusLineInvalid),
        ("HTTP/1.1 200OK", WireFailure::StatusLineInvalid),
        ("HTTP/1.1 2000 OK", WireFailure::StatusLineInvalid),
        ("HTTP/1.1 20 OK", WireFailure::StatusLineInvalid),
        ("HTTP/1.1 +200 OK", WireFailure::StatusLineInvalid),
        ("HTTP/1.1", WireFailure::StatusLineInvalid),
        ("ICY 200 OK", WireFailure::StatusLineInvalid),
        ("HTTP/1.1 200 O\u{1}K", WireFailure::StatusLineInvalid),
        ("", WireFailure::StatusLineInvalid),
    ] {
        let head = format!("{line}\r\nContent-Type: text/event-stream\r\n\r\n");
        assert_eq!(head_failure(&head), want, "{line:?}");
    }
}

#[test]
fn n1_content_type_and_encoding() {
    for (lines, want) in [
        ("", WireFailure::ContentTypeMissing),
        ("X-Other: 1\r\n", WireFailure::ContentTypeMissing),
        (
            "Content-Type: application/json\r\n",
            WireFailure::ContentTypeNotEventStream,
        ),
        (
            "Content-Type: text/plain\r\n",
            WireFailure::ContentTypeNotEventStream,
        ),
        (
            "Content-Type: text/event-streams\r\n",
            WireFailure::ContentTypeNotEventStream,
        ),
        (
            "Content-Type: xtext/event-stream\r\n",
            WireFailure::ContentTypeNotEventStream,
        ),
        ("Content-Type: \r\n", WireFailure::ContentTypeNotEventStream),
        (
            "Content-Type: application/x-ndjson; charset=utf-8\r\n",
            WireFailure::ContentTypeNotEventStream,
        ),
    ] {
        let head = format!("HTTP/1.1 200 OK\r\n{lines}\r\n");
        assert_eq!(head_failure(&head), want, "{lines:?}");
    }
    for encoding in [
        "gzip",
        "br",
        "deflate",
        "compress",
        "zstd",
        "identity, gzip",
        "gzip, identity",
        "",
    ] {
        let head = head_with(&format!("Content-Encoding: {encoding}\r\n"));
        assert_eq!(
            head_failure(&head),
            WireFailure::ContentEncodingUnsupported,
            "{encoding:?}"
        );
    }
}

#[test]
fn n1_framing_ambiguity_and_duplicates() {
    // Chunked together with Content-Length, in either order; HTTP/1.0 chunked.
    for lines in [
        "Transfer-Encoding: chunked\r\nContent-Length: 5\r\n",
        "Content-Length: 5\r\nTransfer-Encoding: chunked\r\n",
    ] {
        assert_eq!(
            head_failure(&head_with(lines)),
            WireFailure::AmbiguousFraming
        );
    }
    let http10 =
        "HTTP/1.0 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n";
    assert_eq!(head_failure(http10), WireFailure::AmbiguousFraming);
    for encoding in [
        "gzip",
        "identity",
        "chunked, chunked",
        "chunked, gzip",
        "gzip, chunked",
        "chunk",
        "",
    ] {
        let head = head_with(&format!("Transfer-Encoding: {encoding}\r\n"));
        assert_eq!(
            head_failure(&head),
            WireFailure::TransferEncodingUnsupported,
            "{encoding:?}"
        );
    }
    // Duplicates, whatever the case and whether or not the values agree.
    for lines in [
        "Content-Length: 5\r\nContent-Length: 5\r\n",
        "Content-Length: 5\r\ncontent-length: 6\r\n",
        "Transfer-Encoding: chunked\r\ntransfer-encoding: chunked\r\n",
        "Content-Type: text/event-stream\r\n",
        "Content-Type: application/json\r\n",
        "Content-Encoding: identity\r\nContent-Encoding: identity\r\n",
    ] {
        assert_eq!(
            head_failure(&head_with(lines)),
            WireFailure::DuplicateHeader,
            "{lines:?}"
        );
    }
    // Content-Length syntax and size (the default body limit is 64 MiB).
    for (value, want) in [
        ("", WireFailure::ContentLengthInvalid),
        ("+5", WireFailure::ContentLengthInvalid),
        ("-1", WireFailure::ContentLengthInvalid),
        ("5, 5", WireFailure::ContentLengthInvalid),
        ("0x5", WireFailure::ContentLengthInvalid),
        ("5.0", WireFailure::ContentLengthInvalid),
        ("1 2", WireFailure::ContentLengthInvalid),
        ("67108865", WireFailure::ContentLengthTooLarge),
        ("99999999999999999999", WireFailure::ContentLengthTooLarge),
        ("18446744073709551616", WireFailure::ContentLengthTooLarge),
    ] {
        let head = head_with(&format!("Content-Length: {value}\r\n"));
        assert_eq!(head_failure(&head), want, "{value:?}");
    }
}

#[test]
fn n1_malformed_head_lines() {
    for (label, head) in [
        ("obs-fold", head_with("X-A: b\r\n c\r\n")),
        ("space before colon", head_with("X-A : b\r\n")),
        ("no colon", head_with("X-A\r\n")),
        ("empty name", head_with(": b\r\n")),
        ("bad name byte", head_with("X(A): b\r\n")),
        ("control byte", head_with("X-A: b\u{1}\r\n")),
        ("DEL byte", head_with("X-A: b\u{7f}\r\n")),
        ("NUL byte", head_with("X-A: b\u{0}\r\n")),
        ("bare CR", head_with("X-A: b\rc\r\n")),
        ("bare LF", head_with("X-A: b\nX-B: c\r\n")),
    ] {
        assert_eq!(head_failure(&head), WireFailure::HeaderInvalid, "{label}");
    }
}

#[test]
fn n1_head_size_n_and_n_plus_1() {
    let limits = Limits {
        max_header_bytes: 160,
        ..Limits::DEFAULT
    };
    let base = head_with("Content-Length: 0\r\n");
    let padded = |total: usize| {
        let fixed = base.len() + "X-Pad: \r\n".len();
        head_with(&format!(
            "Content-Length: 0\r\nX-Pad: {}\r\n",
            "a".repeat(total - fixed)
        ))
    };
    let exactly = padded(160);
    assert_eq!(exactly.len(), 160);
    // At the limit the head is accepted (the body is empty, so the stream is
    // then missing its terminal, which is a different failure).
    let outcome = assert_split_invariant("N", exactly.as_bytes(), limits);
    assert_eq!(outcome.result, Err(WireFailure::MissingTerminal));
    let over = padded(161);
    let outcome = assert_split_invariant("N+1", over.as_bytes(), limits);
    assert_eq!(outcome.result, Err(WireFailure::HeaderTooLarge));
    // A head that never ends, fed in one huge push, is refused without storing
    // more than the limit.
    let mut parser = HeadParser::new(limits);
    let mut flood = b"HTTP/1.1 200 OK\r\nX: ".to_vec();
    flood.resize(10 * 1024 * 1024, b'a');
    assert_eq!(parser.push(&flood), Err(WireFailure::HeaderTooLarge));
    assert!(parser.buffered_len() <= limits.max_header_bytes);
    // Bare LF line ends never terminate a head.
    let mut parser = HeadParser::new(limits);
    let lf_only = format!(
        "HTTP/1.1 200 OK\nContent-Type: text/event-stream\n\n{}",
        "a".repeat(400)
    );
    assert_eq!(
        parser.push(lf_only.as_bytes()),
        Err(WireFailure::HeaderTooLarge)
    );
}

#[test]
fn head_parser_reports_where_the_body_starts() {
    let head = head_with("Content-Length: 3\r\n");
    let mut input = head.clone().into_bytes();
    input.extend_from_slice(b"abc");
    let mut parser = HeadParser::new(Limits::DEFAULT);
    let HeadProgress::Complete {
        head: parsed,
        consumed,
    } = parser.push(&input).unwrap()
    else {
        panic!("head incomplete");
    };
    assert_eq!(consumed, head.len());
    assert_eq!(parsed.version, HttpVersion::Http11);
    assert_eq!(parsed.framing, Framing::ContentLength(3));
    assert_eq!(parsed.head_bytes, head.len());
}

// ----------------------------------------------------------------------- N2

#[test]
fn n2_terminal_rules() {
    let content = text("a");
    let done = DONE;
    // finish_reason: length, tool_calls, unknown values, and non-strings.
    let ineligible = WireFailure::ProviderTerminalNotComplete(ProviderTerminal::Ineligible);
    for (reason, want) in [
        (
            "length",
            WireFailure::ProviderTerminalNotComplete(ProviderTerminal::LengthLimit),
        ),
        ("tool_calls", ineligible),
        ("content_filter", ineligible),
        ("function_call", ineligible),
        ("STOP", ineligible),
        ("", ineligible),
    ] {
        let body = [
            content.clone(),
            chunk_event(json!({}), Some(reason)),
            done.to_owned(),
        ]
        .concat();
        assert_sse_failure(reason, &body, want);
    }
    let numeric = event(r#"{"choices":[{"index":0,"delta":{},"finish_reason":1}]}"#);
    assert_sse_failure(
        "numeric finish_reason",
        &[content.clone(), numeric, done.to_owned()].concat(),
        ineligible,
    );
    // A length stop still delivers what was seen, and the terminal.
    let outcome = run(&response_length(
        &[
            content.clone(),
            chunk_event(json!({}), Some("length")),
            done.to_owned(),
        ]
        .concat(),
    ));
    assert_eq!(
        outcome.events,
        vec![
            WireEvent::Text("a".into()),
            WireEvent::Terminal(ProviderTerminal::LengthLimit)
        ]
    );
    assert_eq!(
        WireFailure::ProviderTerminalNotComplete(ProviderTerminal::LengthLimit).completion(),
        Completion::Truncated
    );

    // A second non-null finish_reason.
    assert_sse_failure(
        "two stops",
        &[content.clone(), stop(), stop(), done.to_owned()].concat(),
        WireFailure::DataAfterTerminal,
    );
    // [DONE] before any non-null finish_reason.
    assert_sse_failure(
        "done before stop",
        &[content.clone(), done.to_owned()].concat(),
        WireFailure::DoneBeforeTerminal,
    );
    assert_sse_failure("done only", done, WireFailure::DoneBeforeTerminal);
    // [DONE] or `stop` missing at the body's end.
    assert_sse_failure(
        "no done",
        &[content.clone(), stop()].concat(),
        WireFailure::MissingDone,
    );
    assert_sse_failure("no stop, no done", &content, WireFailure::MissingTerminal);
    assert_sse_failure("empty body", "", WireFailure::MissingTerminal);
    // [DONE] twice.
    assert_sse_failure(
        "two dones",
        &[content.clone(), stop(), done.to_owned(), done.to_owned()].concat(),
        WireFailure::DataAfterDone,
    );
    // Data between `stop` and [DONE], and after [DONE].
    assert_sse_failure(
        "usage after stop",
        &[
            content.clone(),
            stop(),
            event(r#"{"choices":[],"usage":{"total_tokens":3}}"#),
            done.to_owned(),
        ]
        .concat(),
        WireFailure::DataAfterTerminal,
    );
    assert_sse_failure(
        "text after stop",
        &[content.clone(), stop(), text("b"), done.to_owned()].concat(),
        WireFailure::DataAfterTerminal,
    );
    assert_sse_failure(
        "data after done",
        &[content.clone(), stop(), done.to_owned(), text("c")].concat(),
        WireFailure::DataAfterDone,
    );
    assert_sse_failure(
        "usage after done",
        &[
            content.clone(),
            stop(),
            done.to_owned(),
            event(r#"{"choices":[],"usage":{}}"#),
        ]
        .concat(),
        WireFailure::DataAfterDone,
    );
    assert_sse_failure(
        "event field after done",
        &[
            content.clone(),
            stop(),
            done.to_owned(),
            "event: x\n\n".to_owned(),
        ]
        .concat(),
        WireFailure::DataAfterDone,
    );
    // An event is not dispatched without its blank line; a line without its
    // terminator is not a line.
    assert_sse_failure(
        "done without blank line",
        &[content.clone(), stop(), "data: [DONE]\n".to_owned()].concat(),
        WireFailure::IncompleteEvent,
    );
    assert_sse_failure(
        "done without terminator",
        &[content.clone(), stop(), "data: [DONE]".to_owned()].concat(),
        WireFailure::IncompleteLine,
    );
    assert_sse_failure(
        "unfinished data line after done",
        &[content, stop(), done.to_owned(), "data: x".to_owned()].concat(),
        WireFailure::IncompleteLine,
    );
}

#[test]
fn n2_the_body_must_end() {
    let body = [text("a"), stop(), DONE.to_owned()].concat();
    // A truncated Content-Length body, a missing last chunk, a chunk cut in
    // the middle: the peer closed early.
    let mut short = response_length(&body);
    short.truncate(short.len() - 1);
    assert_eq!(failure_of(&short), WireFailure::TruncatedBody);
    let mut no_last_chunk = response_chunked(&body, 10);
    no_last_chunk.truncate(no_last_chunk.len() - 5);
    assert_eq!(failure_of(&no_last_chunk), WireFailure::TruncatedBody);
    let mut half_chunk = response_chunked(&body, 10);
    half_chunk.truncate(half_chunk.len() - 12);
    assert_eq!(failure_of(&half_chunk), WireFailure::TruncatedBody);
    // The connection closes in the head.
    assert_eq!(
        failure_of(b"HTTP/1.1 200 OK\r\nContent-Ty"),
        WireFailure::TruncatedHead
    );
    assert_eq!(failure_of(b""), WireFailure::TruncatedHead);
    // Bytes after the framed end of the body.
    let mut extra = response_length(&body);
    extra.push(b'\n');
    assert_eq!(failure_of(&extra), WireFailure::BytesAfterBodyEnd);
    let mut extra_chunked = response_chunked(&body, 10);
    extra_chunked.extend_from_slice(b"x");
    assert_eq!(failure_of(&extra_chunked), WireFailure::BytesAfterBodyEnd);
    // A close-delimited stream that is cut off mid-line.
    let mut cut = response_close(&body);
    cut.truncate(cut.len() - 4);
    assert_eq!(failure_of(&cut), WireFailure::IncompleteLine);
    for (label, bytes) in [
        ("short", &short),
        ("no last chunk", &no_last_chunk),
        ("half chunk", &half_chunk),
        ("extra", &extra),
        ("extra chunked", &extra_chunked),
        ("cut", &cut),
    ] {
        assert_split_invariant(label, bytes, Limits::DEFAULT);
    }
}

// ----------------------------------------------------------------------- N3

#[test]
fn n3_event_shapes() {
    let cases: Vec<(&str, &str, WireFailure)> = vec![
        (
            "two choices",
            r#"{"choices":[{"index":0,"delta":{}},{"index":1,"delta":{}}]}"#,
            WireFailure::ChoicesShape,
        ),
        ("no choices", r#"{"choices":[]}"#, WireFailure::ChoicesShape),
        (
            "choices missing",
            r#"{"id":"x"}"#,
            WireFailure::ChoicesShape,
        ),
        (
            "choices object",
            r#"{"choices":{"index":0}}"#,
            WireFailure::ChoicesShape,
        ),
        (
            "choice not object",
            r#"{"choices":[1]}"#,
            WireFailure::ChoicesShape,
        ),
        (
            "index 1",
            r#"{"choices":[{"index":1,"delta":{}}]}"#,
            WireFailure::ChoiceIndex,
        ),
        (
            "index missing",
            r#"{"choices":[{"delta":{}}]}"#,
            WireFailure::ChoiceIndex,
        ),
        (
            "index string",
            r#"{"choices":[{"index":"0","delta":{}}]}"#,
            WireFailure::ChoiceIndex,
        ),
        (
            "index float",
            r#"{"choices":[{"index":0.0,"delta":{}}]}"#,
            WireFailure::ChoiceIndex,
        ),
        (
            "message object",
            r#"{"choices":[{"index":0,"message":{"role":"assistant","content":"x"}}]}"#,
            WireFailure::ChoiceKeyNotAllowed,
        ),
        (
            "logprobs object",
            r#"{"choices":[{"index":0,"delta":{},"logprobs":{"content":[]}}]}"#,
            WireFailure::ChoiceKeyNotAllowed,
        ),
        (
            "unknown array",
            r#"{"choices":[{"index":0,"delta":{},"extra":[]}]}"#,
            WireFailure::ChoiceKeyNotAllowed,
        ),
        (
            "text key",
            r#"{"choices":[{"index":0,"text":{"a":1}}]}"#,
            WireFailure::ChoiceKeyNotAllowed,
        ),
        (
            "delta null",
            r#"{"choices":[{"index":0,"delta":null}]}"#,
            WireFailure::DeltaInvalid,
        ),
        (
            "delta string",
            r#"{"choices":[{"index":0,"delta":"x"}]}"#,
            WireFailure::DeltaInvalid,
        ),
        (
            "delta array",
            r#"{"choices":[{"index":0,"delta":[]}]}"#,
            WireFailure::DeltaInvalid,
        ),
        (
            "tool_calls",
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0}]}}]}"#,
            WireFailure::DeltaKeyNotAllowed,
        ),
        (
            "function_call",
            r#"{"choices":[{"index":0,"delta":{"function_call":{"name":"f"}}}]}"#,
            WireFailure::DeltaKeyNotAllowed,
        ),
        (
            "refusal",
            r#"{"choices":[{"index":0,"delta":{"refusal":"no"}}]}"#,
            WireFailure::DeltaKeyNotAllowed,
        ),
        (
            "audio",
            r#"{"choices":[{"index":0,"delta":{"audio":{}}}]}"#,
            WireFailure::DeltaKeyNotAllowed,
        ),
        (
            "unknown scalar",
            r#"{"choices":[{"index":0,"delta":{"extra":"x"}}]}"#,
            WireFailure::DeltaKeyNotAllowed,
        ),
        (
            "unknown number",
            r#"{"choices":[{"index":0,"delta":{"extra":0}}]}"#,
            WireFailure::DeltaKeyNotAllowed,
        ),
        (
            "thinking alias",
            r#"{"choices":[{"index":0,"delta":{"thinking":"x"}}]}"#,
            WireFailure::DeltaKeyNotAllowed,
        ),
        (
            "role user",
            r#"{"choices":[{"index":0,"delta":{"role":"user"}}]}"#,
            WireFailure::DeltaInvalid,
        ),
        (
            "role number",
            r#"{"choices":[{"index":0,"delta":{"role":1}}]}"#,
            WireFailure::DeltaInvalid,
        ),
        (
            "content number",
            r#"{"choices":[{"index":0,"delta":{"content":1}}]}"#,
            WireFailure::DeltaInvalid,
        ),
        (
            "content array",
            r#"{"choices":[{"index":0,"delta":{"content":[{"type":"text"}]}}]}"#,
            WireFailure::DeltaInvalid,
        ),
        (
            "reasoning object",
            r#"{"choices":[{"index":0,"delta":{"reasoning":{"a":"b"}}}]}"#,
            WireFailure::DeltaInvalid,
        ),
        (
            "top-level error",
            r#"{"error":{"message":"boom"},"choices":[{"index":0,"delta":{}}]}"#,
            WireFailure::ErrorObject,
        ),
        (
            "error only",
            r#"{"error":"boom"}"#,
            WireFailure::ErrorObject,
        ),
        (
            "error null",
            r#"{"error":null,"choices":[{"index":0,"delta":{}}]}"#,
            WireFailure::ErrorObject,
        ),
        (
            "invalid json",
            r#"{"choices":[{"index":0,"delta":{"content":"x"}"#,
            WireFailure::InvalidJson,
        ),
        (
            "trailing garbage",
            r#"{"choices":[{"index":0,"delta":{}}]} x"#,
            WireFailure::InvalidJson,
        ),
        ("single quotes", "{'choices':[]}", WireFailure::InvalidJson),
        ("trailing comma", "{},", WireFailure::InvalidJson),
        (
            "array",
            r#"[{"choices":[]}]"#,
            WireFailure::DataNotJsonObject,
        ),
        ("string", r#""[DONE]""#, WireFailure::DataNotJsonObject),
        ("number", "42", WireFailure::DataNotJsonObject),
        ("null", "null", WireFailure::DataNotJsonObject),
        ("bare text", "hello", WireFailure::InvalidJson),
        ("done lower case", "[done]", WireFailure::InvalidJson),
        (
            "done with trailing space",
            "[DONE] ",
            WireFailure::InvalidJson,
        ),
        (
            "done with leading space",
            " [DONE]",
            WireFailure::InvalidJson,
        ),
    ];
    for (label, json, want) in cases {
        let body = [text("seen "), event(json), stop(), DONE.to_owned()].concat();
        assert_sse_failure(label, &body, want);
    }
}

#[test]
fn n3_fields_other_than_data_fail() {
    for (label, line) in [
        ("event", "event: message"),
        ("event no space", "event:message"),
        ("event name only", "event"),
        ("unknown", "foo: bar"),
        ("capitalised", "Data: x"),
        ("data prefix", "database: x"),
        ("no colon", "garbage"),
        ("leading space", " data: x"),
        ("double BOM", "\u{feff}\u{feff}data: x"),
    ] {
        let body = format!("{line}\n\n");
        assert_sse_failure(label, &body, WireFailure::UnknownField);
    }
    // The first line may start with one BOM; the same BOM later is not one.
    let body = format!("{}\u{feff}: not a comment?\n\n", text("x"));
    assert_sse_failure("BOM mid-stream", &body, WireFailure::UnknownField);
}

#[test]
fn events_before_a_failure_are_delivered() {
    let body = [
        thinking("t"),
        text("a"),
        chunk_event(json!({"tool_calls": [{"index": 0}]}), None),
        text("never"),
    ]
    .concat();
    let outcome = run(&response_length(&body));
    assert_eq!(outcome.result, Err(WireFailure::DeltaKeyNotAllowed));
    assert_eq!(
        outcome.events,
        vec![WireEvent::Thinking("t".into()), WireEvent::Text("a".into())]
    );
    let observed = observe(&outcome);
    assert_eq!(observed.terminal_status, TerminalStatus::Failed);
    assert_eq!(observed.parse_status, ParseStatus::Invalid);
    assert!(observed.response_digest.is_some());
    // A failed parser stays failed.
    let mut parser = ResponseParser::new(Limits::DEFAULT);
    let mut events = Vec::new();
    assert!(parser.push(b"HTTP/1.1 404 x\r\n\r\n", &mut events).is_err());
    assert_eq!(
        parser.push(b"more", &mut events),
        Err(WireFailure::StatusNotOk)
    );
    assert_eq!(parser.finish_eof(), Err(WireFailure::StatusNotOk));
}

// ----------------------------------------------------------------------- N4

fn small(limits: impl FnOnce(&mut Limits)) -> Limits {
    let mut value = Limits::DEFAULT;
    limits(&mut value);
    value
}

#[test]
fn n4_event_size_n_and_n_plus_1() {
    // A comment event of exactly `n` bytes (LF ends): ": " + padding + "\n\n".
    let comment_event = |n: usize| format!(": {}\n\n", "x".repeat(n - ": \n\n".len()));
    let limits = small(|l| l.max_event_bytes = 300);
    let build = |event: &str| {
        let mut bytes = head_with("").into_bytes();
        bytes.extend_from_slice(event.as_bytes());
        bytes
    };
    let outcome = assert_split_invariant("N", &build(&comment_event(300)), limits);
    assert_eq!(outcome.result, Err(WireFailure::MissingTerminal));
    let outcome = assert_split_invariant("N+1", &build(&comment_event(301)), limits);
    assert_eq!(outcome.result, Err(WireFailure::EventTooLarge));
    // A data event of N bytes is read; N+1 is refused.
    let json_event = |n: usize| {
        let base = event(r#"{"choices":[{"index":0,"delta":{"content":""}}]}"#).len();
        let content = "y".repeat(n - base);
        event(&format!(
            r#"{{"choices":[{{"index":0,"delta":{{"content":"{content}"}}}}]}}"#
        ))
    };
    let at_limit = build(&[json_event(300), stop(), DONE.to_owned()].concat());
    let limits_large = small(|l| l.max_event_bytes = 300.max(stop().len()));
    let outcome = assert_split_invariant("data N", &at_limit, limits_large);
    assert_eq!(outcome.result, Ok(()));
    let over = build(&[json_event(301), stop(), DONE.to_owned()].concat());
    let outcome = assert_split_invariant("data N+1", &over, limits_large);
    assert_eq!(outcome.result, Err(WireFailure::EventTooLarge));
    // An endless line (or run of comments without a blank line) is bounded.
    let mut endless = build(": ");
    endless.extend_from_slice(&vec![b'c'; 100_000]);
    assert_eq!(
        feed(&endless, &[], limits).result,
        Err(WireFailure::EventTooLarge)
    );
    // The held bytes never exceed the limit, whatever the input.
    let mut parser = SseParser::new(limits);
    let flood = vec![b'a'; 10 * 1024 * 1024];
    assert_eq!(
        parser.push(&flood, &mut Vec::new()),
        Err(WireFailure::EventTooLarge)
    );
    assert!(parser.held_len() <= limits.max_event_bytes);
    // Blank lines end the event: many small events are not one big one.
    let many = format!(
        "{}{}",
        ": c\n\n".repeat(1000),
        [text("x"), stop(), DONE.to_owned()].concat()
    );
    let limits_many = small(|l| l.max_event_bytes = 200);
    assert_eq!(
        feed(&response_length(&many), &[], limits_many).result,
        Ok(())
    );
}

#[test]
fn n4_body_size_n_and_n_plus_1() {
    let body = [text("abc"), stop(), DONE.to_owned()].concat();
    // Content-Length and close-delimited: the body is exactly `limit` bytes.
    let limits = small(|l| l.max_body_bytes = body.len());
    for (label, bytes) in [
        ("length", response_length(&body)),
        ("close", response_close(&body)),
    ] {
        let outcome = assert_split_invariant(&format!("N {label}"), &bytes, limits);
        assert_eq!(outcome.result, Ok(()), "{label}");
    }
    let limits = small(|l| l.max_body_bytes = body.len() - 1);
    let outcome = assert_split_invariant("N+1 length", &response_length(&body), limits);
    assert_eq!(outcome.result, Err(WireFailure::ContentLengthTooLarge));
    let outcome = assert_split_invariant("N+1 close", &response_close(&body), limits);
    assert_eq!(outcome.result, Err(WireFailure::BodyTooLarge));
    // Chunked bodies count the framing too (size lines and CRLFs).
    let chunked = response_chunked(&body, 1000);
    let head_len = head_with("Transfer-Encoding: chunked\r\n").len();
    let wire_body = chunked.len() - head_len;
    let limits = small(|l| l.max_body_bytes = wire_body);
    assert_eq!(
        assert_split_invariant("N chunked", &chunked, limits).result,
        Ok(())
    );
    let limits = small(|l| l.max_body_bytes = wire_body - 1);
    assert_eq!(
        assert_split_invariant("N+1 chunked", &chunked, limits).result,
        Err(WireFailure::BodyTooLarge)
    );
    // Events completed before the limit are delivered.
    let limits = small(|l| l.max_body_bytes = text("abc").len());
    let outcome = feed(&response_close(&body), &[], limits);
    assert_eq!(outcome.events, vec![WireEvent::Text("abc".into())]);
    assert_eq!(outcome.result, Err(WireFailure::BodyTooLarge));
}

#[test]
fn n4_text_and_thinking_limits_n_and_n_plus_1() {
    let limits = small(|l| {
        l.max_text_bytes = 6;
        l.max_thinking_bytes = 4;
    });
    let ok = [
        text("abc"),
        text("def"),
        thinking("wxyz"),
        stop(),
        DONE.to_owned(),
    ]
    .concat();
    let outcome = assert_split_invariant("N", &response_chunked(&ok, 5), limits);
    assert_eq!(outcome.result, Ok(()));
    let text_over = [text("abc"), text("defg"), stop(), DONE.to_owned()].concat();
    let outcome = assert_split_invariant("text N+1", &response_length(&text_over), limits);
    assert_eq!(outcome.result, Err(WireFailure::TextLimit));
    // The event that crosses the limit delivers nothing.
    assert_eq!(outcome.events, vec![WireEvent::Text("abc".into())]);
    let thinking_over = [thinking("abc"), thinking("de"), stop(), DONE.to_owned()].concat();
    let outcome = assert_split_invariant("thinking N+1", &response_length(&thinking_over), limits);
    assert_eq!(outcome.result, Err(WireFailure::ThinkingLimit));
    // Multi-byte characters count as bytes.
    let wide = [text("\u{3042}\u{3044}"), text("a"), stop(), DONE.to_owned()].concat();
    assert_eq!(
        feed(&response_length(&wide), &[], limits).result,
        Err(WireFailure::TextLimit)
    );
    assert_eq!(MAX_OUTPUT_CHANNEL_BYTES, 2 * 1024 * 1024);
    assert_eq!(Limits::DEFAULT.max_text_bytes, MAX_OUTPUT_CHANNEL_BYTES);
    assert_eq!(Limits::DEFAULT.max_thinking_bytes, MAX_OUTPUT_CHANNEL_BYTES);
}

#[test]
fn n4_chunk_size_digits_value_and_lines() {
    let limits = small(|l| {
        l.max_chunk_size_digits = 3;
        l.max_chunk_bytes = 0x100;
        l.max_chunk_line_bytes = 12;
    });
    let head = head_with("Transfer-Encoding: chunked\r\n");
    let run_chunk = |line: &str| {
        let mut bytes = head.clone().into_bytes();
        bytes.extend_from_slice(line.as_bytes());
        assert_split_invariant(line, &bytes, limits).result
    };
    // Digits: 3 allowed, 4 not (leading zeros count); value 0x100 allowed.
    assert_eq!(run_chunk("100\r\n"), Err(WireFailure::TruncatedBody));
    assert_eq!(run_chunk("0100\r\n"), Err(WireFailure::ChunkSizeTooLong));
    assert_eq!(
        run_chunk("00000001\r\n"),
        Err(WireFailure::ChunkSizeTooLong)
    );
    assert_eq!(run_chunk("101\r\n"), Err(WireFailure::ChunkTooLarge));
    assert_eq!(run_chunk("FFF\r\n"), Err(WireFailure::ChunkTooLarge));
    // Syntax.
    for bad in [
        "\r\n", "g\r\n", "-1\r\n", "+1\r\n", "0x1\r\n", " 1\r\n", "1 \r\n", "1 ;x\r\n", ";x\r\n",
    ] {
        assert_eq!(
            run_chunk(bad),
            Err(WireFailure::ChunkSizeInvalid),
            "{bad:?}"
        );
    }
    // Line length: 12 bytes of line (digits plus extension) allowed, 13 not.
    assert_eq!(
        run_chunk("0;123456789a\r\n"),
        Err(WireFailure::TruncatedBody)
    );
    assert_eq!(
        run_chunk("0;123456789ab\r\n"),
        Err(WireFailure::ChunkLineTooLong)
    );
    assert_eq!(
        run_chunk(&format!("0;{}", "x".repeat(100_000))),
        Err(WireFailure::ChunkLineTooLong)
    );
    // Framing errors: bare LF, bare CR, NUL, data not followed by CRLF.
    assert_eq!(run_chunk("1\nx\r\n"), Err(WireFailure::ChunkFramingInvalid));
    assert_eq!(run_chunk("1\rx\r\n"), Err(WireFailure::ChunkFramingInvalid));
    assert_eq!(run_chunk("1;\0\r\n"), Err(WireFailure::ChunkFramingInvalid));
    assert_eq!(
        run_chunk("1\r\nxy\r\n"),
        Err(WireFailure::ChunkFramingInvalid)
    );
    assert_eq!(run_chunk("1\r\nx\n"), Err(WireFailure::ChunkFramingInvalid));
    // A huge declared chunk is refused before any data is read or reserved.
    let mut decoder = BodyDecoder::new(Framing::Chunked, Limits::DEFAULT, 0);
    let mut out = Vec::new();
    assert_eq!(
        decoder.push(b"FFFFFFFF\r\n", &mut out),
        Err(WireFailure::ChunkTooLarge)
    );
    assert!(out.is_empty());
    assert_eq!(
        BodyDecoder::new(Framing::Chunked, Limits::DEFAULT, 0)
            .push(b"FFFFFFFFFFFFFFFFF\r\n", &mut out),
        Err(WireFailure::ChunkSizeTooLong)
    );
}

#[test]
fn n4_trailers_count_toward_the_header_limit() {
    let body = [text("a"), stop(), DONE.to_owned()].concat();
    let head = head_with("Transfer-Encoding: chunked\r\n");
    let trailer = "X-T: abcdef\r\n";
    let mut bytes = head.clone().into_bytes();
    bytes.extend_from_slice(format!("{:x}\r\n", body.len()).as_bytes());
    bytes.extend_from_slice(body.as_bytes());
    bytes.extend_from_slice(b"\r\n0\r\n");
    let before_trailer = bytes.len();
    bytes.extend_from_slice(trailer.as_bytes());
    bytes.extend_from_slice(b"\r\n");
    let trailer_total = trailer.len() + 2;
    let limits = small(|l| l.max_header_bytes = head.len() + trailer_total);
    assert_eq!(assert_split_invariant("N", &bytes, limits).result, Ok(()));
    let limits = small(|l| l.max_header_bytes = head.len() + trailer_total - 1);
    assert_eq!(
        assert_split_invariant("N+1", &bytes, limits).result,
        Err(WireFailure::HeaderTooLarge)
    );
    // A trailer that never ends.
    let mut endless = bytes[..before_trailer].to_vec();
    endless.extend_from_slice(&vec![b'x'; 1_000_000]);
    assert_eq!(
        feed(&endless, &[], Limits::DEFAULT).result,
        Err(WireFailure::HeaderTooLarge)
    );
}

#[test]
fn n4_default_limits_are_the_documented_initial_values() {
    let limits = Limits::DEFAULT;
    assert_eq!(limits.max_header_bytes, 16 * 1024);
    assert_eq!(limits.max_event_bytes, 256 * 1024);
    assert_eq!(limits.max_body_bytes, 64 * 1024 * 1024);
    assert_eq!(limits.max_chunk_size_digits, 8);
    assert_eq!(limits.max_chunk_bytes, 4 * 1024 * 1024);
    assert_eq!(limits.max_chunk_line_bytes, 1024);
    assert_eq!(Limits::default(), limits);
}

// ----------------------------------------------------------------------- N5

fn loopback_v4(port: u16) -> RequestTarget {
    RequestTarget::new(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)).unwrap()
}

fn loopback_v6(port: u16) -> RequestTarget {
    RequestTarget::new(SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port)).unwrap()
}

fn header_lines(head: &[u8]) -> (String, Vec<(String, String)>) {
    let text = std::str::from_utf8(head).unwrap();
    assert!(text.ends_with("\r\n\r\n"));
    let mut lines = text[..text.len() - 4].split("\r\n");
    let request_line = lines.next().unwrap().to_owned();
    let headers = lines
        .map(|line| {
            let (name, value) = line.split_once(": ").expect("name: value");
            (name.to_owned(), value.to_owned())
        })
        .collect();
    (request_line, headers)
}

#[test]
fn n5_request_head_is_the_allowlist_and_nothing_else() {
    for (target, host) in [
        (loopback_v4(1234), "127.0.0.1:1234"),
        (loopback_v6(65535), "[::1]:65535"),
        (loopback_v4(1), "127.0.0.1:1"),
    ] {
        let head = build_request_head(&target, 98765);
        let (request_line, headers) = header_lines(&head);
        assert_eq!(request_line, "POST /v1/chat/completions HTTP/1.1");
        let names: Vec<&str> = headers.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, REQUEST_HEADER_ALLOWLIST.to_vec());
        let value = |wanted: &str| {
            headers
                .iter()
                .find(|(name, _)| name == wanted)
                .map(|(_, value)| value.as_str())
                .unwrap()
        };
        assert_eq!(value("Host"), host);
        assert_eq!(value("User-Agent"), USER_AGENT);
        assert_eq!(value("Accept"), "text/event-stream");
        assert_eq!(value("Content-Type"), "application/json");
        assert_eq!(value("Content-Length"), "98765");
        assert_eq!(value("Connection"), "close");
        for forbidden in [
            "authorization",
            "x-api-key",
            "api-key",
            "cookie",
            "proxy-authorization",
            "proxy-connection",
            "expect",
            "transfer-encoding",
            "upgrade",
            "accept-encoding",
            "origin",
            "referer",
        ] {
            assert!(
                !names
                    .iter()
                    .any(|name| name.eq_ignore_ascii_case(forbidden)),
                "{forbidden}"
            );
        }
    }
    assert_eq!(
        REQUEST_HEADER_ALLOWLIST,
        [
            "Host",
            "User-Agent",
            "Accept",
            "Content-Type",
            "Content-Length",
            "Connection"
        ]
    );
    assert!(USER_AGENT.is_ascii() && !USER_AGENT.contains(char::is_whitespace));
}

#[test]
fn n5_only_loopback_literals_are_targets() {
    let v4 = |a: u8, b: u8, c: u8, d: u8, port: u16| {
        SocketAddr::new(Ipv4Addr::new(a, b, c, d).into(), port)
    };
    for rejected in [
        v4(127, 0, 0, 2, 1234),
        v4(127, 1, 1, 1, 1234),
        v4(0, 0, 0, 0, 1234),
        v4(192, 168, 1, 25, 1234),
        v4(10, 0, 0, 1, 1234),
        v4(127, 0, 0, 1, 0),
        SocketAddr::new(Ipv6Addr::UNSPECIFIED.into(), 1234),
        SocketAddr::new(Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0x7f00, 1).into(), 1234),
        SocketAddr::new(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1).into(), 1234),
        SocketAddr::new(Ipv6Addr::LOCALHOST.into(), 0),
        SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, 1234, 0, 1)),
        SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, 1234, 7, 0)),
    ] {
        assert_eq!(
            RequestTarget::new(rejected),
            Err(WireFailure::TargetNotLoopbackLiteral),
            "{rejected}"
        );
    }
    for accepted in [
        v4(127, 0, 0, 1, 1),
        v4(127, 0, 0, 1, 65535),
        SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, 8080, 0, 0)),
    ] {
        assert_eq!(
            RequestTarget::new(accepted).unwrap().socket_addr(),
            accepted
        );
    }
}

// ----------------------------------------------------------- terminal matrix

#[test]
fn terminal_ends_map_to_the_approved_rows() {
    // (end, terminal, parse, has response digest)
    let rows = [
        (
            TransportEnd::Parsed,
            TerminalStatus::Succeeded,
            ParseStatus::Parsed,
            true,
        ),
        (
            TransportEnd::FailedAfterSend(WireFailure::InvalidJson),
            TerminalStatus::Failed,
            ParseStatus::Invalid,
            true,
        ),
        (
            TransportEnd::FailedAfterSend(WireFailure::TruncatedBody),
            TerminalStatus::Failed,
            ParseStatus::Invalid,
            true,
        ),
        (
            TransportEnd::FailedAfterSend(WireFailure::ProviderTerminalNotComplete(
                ProviderTerminal::LengthLimit,
            )),
            TerminalStatus::Failed,
            ParseStatus::Invalid,
            true,
        ),
        (
            TransportEnd::FailedBeforeSend,
            TerminalStatus::Failed,
            ParseStatus::NotAttempted,
            false,
        ),
        (
            TransportEnd::Cancelled,
            TerminalStatus::Cancelled,
            ParseStatus::NotAttempted,
            false,
        ),
    ];
    for (end, terminal, parse, digest) in rows {
        let mut observer = OutputObserver::new();
        if end == TransportEnd::Parsed {
            observer.observe(OutputChannel::Text, b"ok").unwrap();
            observer
                .observe_terminal(ProviderTerminal::Complete)
                .unwrap();
        }
        let observed = observer.finish(end.completion());
        assert_eq!(observed.terminal_status, terminal, "{end:?}");
        assert_eq!(observed.parse_status, parse, "{end:?}");
        assert_eq!(observed.response_digest.is_some(), digest, "{end:?}");
        assert!(validate_terminal_matrix(terminal, parse, digest).is_ok());
        assert_ne!(observed.terminal_status, TerminalStatus::Skipped);
    }
    // A success cannot be claimed without the provider's `stop`.
    let observed = OutputObserver::new().finish(TransportEnd::Parsed.completion());
    assert_eq!(observed.terminal_status, TerminalStatus::Failed);
    // Every failure completion lands on failed + invalid.
    for failure in [
        WireFailure::StatusNotOk,
        WireFailure::MissingDone,
        WireFailure::IncompleteLine,
        WireFailure::DataAfterTerminal,
    ] {
        let observed = OutputObserver::new().finish(failure.completion());
        assert_eq!(
            (observed.terminal_status, observed.parse_status),
            (TerminalStatus::Failed, ParseStatus::Invalid)
        );
    }
}

#[test]
fn failure_codes_are_stable_and_distinct() {
    let all = [
        WireFailure::TargetNotLoopbackLiteral,
        WireFailure::StatusLineInvalid,
        WireFailure::HttpVersionUnsupported,
        WireFailure::StatusNotOk,
        WireFailure::HeaderInvalid,
        WireFailure::HeaderTooLarge,
        WireFailure::DuplicateHeader,
        WireFailure::ContentTypeMissing,
        WireFailure::ContentTypeNotEventStream,
        WireFailure::ContentEncodingUnsupported,
        WireFailure::TransferEncodingUnsupported,
        WireFailure::AmbiguousFraming,
        WireFailure::ContentLengthInvalid,
        WireFailure::ContentLengthTooLarge,
        WireFailure::TruncatedHead,
        WireFailure::ChunkSizeInvalid,
        WireFailure::ChunkSizeTooLong,
        WireFailure::ChunkTooLarge,
        WireFailure::ChunkLineTooLong,
        WireFailure::ChunkFramingInvalid,
        WireFailure::BodyTooLarge,
        WireFailure::BytesAfterBodyEnd,
        WireFailure::TruncatedBody,
        WireFailure::InvalidUtf8,
        WireFailure::EventTooLarge,
        WireFailure::UnknownField,
        WireFailure::InvalidJson,
        WireFailure::DataNotJsonObject,
        WireFailure::ErrorObject,
        WireFailure::ChoicesShape,
        WireFailure::ChoiceIndex,
        WireFailure::ChoiceKeyNotAllowed,
        WireFailure::DeltaInvalid,
        WireFailure::DeltaKeyNotAllowed,
        WireFailure::ThinkingConflict,
        WireFailure::TextLimit,
        WireFailure::ThinkingLimit,
        WireFailure::ProviderTerminalNotComplete(ProviderTerminal::Ineligible),
        WireFailure::DataAfterTerminal,
        WireFailure::DoneBeforeTerminal,
        WireFailure::DataAfterDone,
        WireFailure::MissingTerminal,
        WireFailure::MissingDone,
        WireFailure::IncompleteLine,
        WireFailure::IncompleteEvent,
    ];
    let mut codes: Vec<String> = all.iter().map(ToString::to_string).collect();
    assert!(codes.iter().all(|code| code.starts_with("NIR1_WIRE_")));
    codes.sort();
    codes.dedup();
    assert_eq!(codes.len(), all.len());
}

#[test]
fn the_wire_layer_has_no_io_and_no_clock() {
    // This module must stay pure: no sockets, files, threads, clocks, clients
    // or environment. (`std::net` is used for the address value type only.)
    let sources = [
        include_str!("../nir1_local_wire.rs"),
        include_str!("http.rs"),
        include_str!("sse.rs"),
        include_str!("limits.rs"),
    ];
    for source in sources {
        let code = source.split("#[cfg(test)]").next().unwrap();
        for banned in [
            "TcpStream",
            "TcpListener",
            "UdpSocket",
            "ToSocketAddrs",
            "std::fs",
            "std::thread",
            "std::process",
            "std::env",
            "Instant",
            "SystemTime",
            "tokio",
            "reqwest",
            "rusqlite",
        ] {
            assert!(!code.contains(banned), "{banned}");
        }
    }
}
