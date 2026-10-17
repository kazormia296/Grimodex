//! The canonical JSON writer streams: bytes and digests are the ones the
//! string-building canonicalizer produced, and a digest of a large document does
//! not need a buffer the size of its text.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::cmp::Ordering;

use grimodex_core::{
    canonical_json_bytes, canonical_json_digest, canonical_json_string, CanonicalJsonError,
    CanonicalJsonStream,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Per-thread allocation accounting. Only this test binary installs it, and each
// thread counts its own allocations, so tests running in parallel do not see
// each other.

struct CountingAllocator;

thread_local! {
    static LIVE: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
}

fn note_alloc(size: usize) {
    let _ = LIVE.try_with(|live| {
        let now = live.get() + size;
        live.set(now);
        let _ = PEAK.try_with(|peak| {
            if now > peak.get() {
                peak.set(now);
            }
        });
    });
}

fn note_dealloc(size: usize) {
    let _ = LIVE.try_with(|live| live.set(live.get().saturating_sub(size)));
}

// SAFETY: every method forwards to `System` unchanged; the counters are plain
// thread-local cells.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = System.alloc(layout);
        if !pointer.is_null() {
            note_alloc(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        System.dealloc(pointer, layout);
        note_dealloc(layout.size());
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let moved = System.realloc(pointer, layout, new_size);
        if !moved.is_null() {
            note_dealloc(layout.size());
            note_alloc(new_size);
        }
        moved
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

/// The most this thread held above what it held on entry while `operation` ran.
fn peak_growth<T>(operation: impl FnOnce() -> T) -> (T, usize) {
    let before = LIVE.with(Cell::get);
    PEAK.with(|peak| peak.set(before));
    let result = operation();
    let peak = PEAK.with(Cell::get);
    (result, peak.saturating_sub(before))
}

// ---------------------------------------------------------------------------
// The canonicalizer as it was before streaming: one `String`, one temporary
// string per JSON string, the hash taken over the finished bytes. Numbers in the
// corpus are integers, whose spelling needs no formatter.

fn legacy_compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn legacy_write_value(value: &Value, output: &mut String) {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => {
            assert!(
                value.is_i64() || value.is_u64(),
                "corpus numbers are integers"
            );
            output.push_str(&value.to_string());
        }
        Value::String(value) => output.push_str(&serde_json::to_string(value).expect("string")),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                legacy_write_value(value, output);
            }
            output.push(']');
        }
        Value::Object(value) => {
            let mut keys: Vec<&str> = value.keys().map(String::as_str).collect();
            keys.sort_by(|left, right| legacy_compare_utf16(left, right));
            output.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).expect("key"));
                output.push(':');
                legacy_write_value(&value[key], output);
            }
            output.push('}');
        }
    }
}

fn legacy_bytes(value: &Value) -> Vec<u8> {
    let mut output = String::new();
    legacy_write_value(value, &mut output);
    output.into_bytes()
}

fn legacy_digest(value: &Value) -> String {
    format!(
        "sha256:{}",
        hex::encode(Sha256::digest(legacy_bytes(value)))
    )
}

// ---------------------------------------------------------------------------

/// Every scalar that JSON escapes or that a naive escaper could get wrong.
fn awkward_string() -> String {
    let mut text = String::new();
    for code in 0u32..0x20 {
        text.push(char::from_u32(code).expect("control character"));
    }
    text.push_str("\"\\/ \u{7f}\u{80}\u{ff}\u{2028}\u{2029}\u{fffe}\u{ffff}");
    text.push_str("日本語 \u{1F600} \u{10FFFF} é e\u{301}");
    text
}

fn corpus() -> Vec<Value> {
    let awkward = awkward_string();
    let mut object = Map::new();
    for key in [
        "z",
        "a",
        "日本語",
        "\u{1F600}",
        "\u{FF5E}",
        "",
        "A",
        "ab",
        "a\"b",
        &awkward,
    ] {
        object.insert(key.to_owned(), json!([key, {"inner": key.len()}]));
    }
    vec![
        json!(null),
        json!(true),
        json!(false),
        json!(0),
        json!(-7),
        json!(1_000_000),
        json!(""),
        json!([]),
        json!({}),
        json!([[], {}, [[]], {"a": {}}]),
        json!(awkward),
        json!({"k": awkward, awkward.as_str(): "v"}),
        Value::Object(object),
        json!({
            "z": 1,
            "nested": { "日本語": "値", "a": true, "b": null },
            "array": [{ "b": 2, "a": 1 }, "x", [1, [2, [3]]]],
        }),
    ]
}

#[test]
fn digests_and_bytes_are_those_of_the_string_building_canonicalizer() {
    for (index, value) in corpus().iter().enumerate() {
        let expected = legacy_bytes(value);
        assert_eq!(
            canonical_json_bytes(value).expect("canonical bytes"),
            expected,
            "bytes of corpus value {index}"
        );
        assert_eq!(
            canonical_json_string(value)
                .expect("canonical string")
                .as_bytes(),
            expected.as_slice(),
            "string of corpus value {index}"
        );
        assert_eq!(
            canonical_json_digest(value).expect("canonical digest"),
            legacy_digest(value),
            "digest of corpus value {index}"
        );
    }
}

#[test]
fn a_large_escape_heavy_string_digests_like_the_string_building_canonicalizer() {
    // About 3 MiB, one quote or backslash or control character in six bytes.
    let mut text = String::new();
    while text.len() < 3 * 1024 * 1024 {
        text.push_str("ab\"cd\\\n日");
    }
    let value = json!({"decisionJson": text, "id": "d-1"});
    assert_eq!(
        canonical_json_digest(&value).expect("canonical digest"),
        legacy_digest(&value)
    );
}

#[test]
fn the_stream_writes_the_canonical_form_of_the_same_document() {
    let awkward = awkward_string();
    let mut stream = CanonicalJsonStream::new(Vec::new());
    stream.begin_object().unwrap();
    stream.key("array").unwrap();
    stream.begin_array().unwrap();
    stream.begin_object().unwrap();
    stream.key("a").unwrap();
    stream.value(&json!(1)).unwrap();
    stream.key("b").unwrap();
    stream.value(&json!(2)).unwrap();
    stream.end_object().unwrap();
    stream.string(&awkward).unwrap();
    stream.value(&json!([null, true])).unwrap();
    stream.end_array().unwrap();
    stream.key("nested").unwrap();
    stream.begin_object().unwrap();
    stream.key("a").unwrap();
    stream.value(&json!(true)).unwrap();
    stream.key("日本語").unwrap();
    stream.string("値").unwrap();
    stream.end_object().unwrap();
    stream.key("z").unwrap();
    stream.value(&json!(1)).unwrap();
    stream.end_object().unwrap();
    let streamed = stream.finish().expect("one complete document");

    let value = json!({
        "z": 1,
        "nested": { "日本語": "値", "a": true },
        "array": [{ "b": 2, "a": 1 }, awkward, [null, true]],
    });
    assert_eq!(streamed, canonical_json_bytes(&value).unwrap());
    assert_eq!(streamed, legacy_bytes(&value));
}

#[test]
fn the_stream_digest_equals_the_digest_of_the_same_value() {
    let value = json!({
        "decisions": [
            {"actorId": "electron:human-review", "decisionJson": awkward_string(), "id": "d-1"},
            {"actorId": "x", "decisionJson": "{}", "id": "d-2"},
        ],
        "proposalId": "p-1",
        "revisionId": "r-1",
    });
    let mut stream = CanonicalJsonStream::digest();
    stream.begin_object().unwrap();
    stream.key("decisions").unwrap();
    stream.begin_array().unwrap();
    for (actor, decision_json, id) in [
        ("electron:human-review", awkward_string(), "d-1"),
        ("x", "{}".to_owned(), "d-2"),
    ] {
        stream.begin_object().unwrap();
        stream.key("actorId").unwrap();
        stream.string(actor).unwrap();
        stream.key("decisionJson").unwrap();
        stream.string(&decision_json).unwrap();
        stream.key("id").unwrap();
        stream.string(id).unwrap();
        stream.end_object().unwrap();
    }
    stream.end_array().unwrap();
    stream.key("proposalId").unwrap();
    stream.string("p-1").unwrap();
    stream.key("revisionId").unwrap();
    stream.string("r-1").unwrap();
    stream.end_object().unwrap();
    let digest = stream.finish_digest().unwrap();
    assert_eq!(digest, canonical_json_digest(&value).unwrap());
    assert_eq!(digest, legacy_digest(&value));
}

#[test]
fn stream_keys_follow_utf16_code_unit_order_not_scalar_order() {
    // U+1F600 is the surrogate pair D83D DE00, which sorts before U+FF5E in
    // UTF-16 even though its scalar value is larger.
    let mut stream = CanonicalJsonStream::new(Vec::new());
    stream.begin_object().unwrap();
    stream.key("\u{1F600}").unwrap();
    stream.string("emoji").unwrap();
    stream.key("\u{FF5E}").unwrap();
    stream.string("tilde").unwrap();
    stream.end_object().unwrap();
    let streamed = stream.finish().unwrap();
    assert_eq!(
        streamed,
        canonical_json_bytes(&json!({"\u{FF5E}": "tilde", "\u{1F600}": "emoji"})).unwrap()
    );

    let mut reversed = CanonicalJsonStream::new(Vec::new());
    reversed.begin_object().unwrap();
    reversed.key("\u{FF5E}").unwrap();
    reversed.string("tilde").unwrap();
    assert!(matches!(
        reversed.key("\u{1F600}"),
        Err(CanonicalJsonError::KeyOrder)
    ));
}

#[test]
fn the_stream_refuses_keys_out_of_order_and_misuse() {
    fn open_object() -> CanonicalJsonStream<Vec<u8>> {
        let mut stream = CanonicalJsonStream::new(Vec::new());
        stream.begin_object().unwrap();
        stream
    }

    // Unsorted, equal, and prefix-after-longer keys.
    let mut stream = open_object();
    stream.key("b").unwrap();
    stream.string("1").unwrap();
    assert!(matches!(stream.key("a"), Err(CanonicalJsonError::KeyOrder)));

    let mut stream = open_object();
    stream.key("a").unwrap();
    stream.string("1").unwrap();
    assert!(matches!(stream.key("a"), Err(CanonicalJsonError::KeyOrder)));

    let mut stream = open_object();
    stream.key("ab").unwrap();
    stream.string("1").unwrap();
    assert!(matches!(stream.key("a"), Err(CanonicalJsonError::KeyOrder)));

    // A key needs exactly one value; a value needs a key inside an object.
    let mut stream = open_object();
    stream.key("a").unwrap();
    assert!(matches!(
        stream.key("b"),
        Err(CanonicalJsonError::StreamState)
    ));

    let mut stream = open_object();
    stream.key("a").unwrap();
    assert!(matches!(
        stream.end_object(),
        Err(CanonicalJsonError::StreamState)
    ));

    let mut stream = open_object();
    assert!(matches!(
        stream.string("x"),
        Err(CanonicalJsonError::StreamState)
    ));

    // Keys only inside an object, and the right container must be closed.
    let mut stream = CanonicalJsonStream::new(Vec::new());
    stream.begin_array().unwrap();
    assert!(matches!(
        stream.key("a"),
        Err(CanonicalJsonError::StreamState)
    ));
    assert!(matches!(
        stream.end_object(),
        Err(CanonicalJsonError::StreamState)
    ));

    // Exactly one document, finished.
    let mut stream = CanonicalJsonStream::new(Vec::new());
    stream.string("a").unwrap();
    assert!(matches!(
        stream.string("b"),
        Err(CanonicalJsonError::StreamState)
    ));

    let stream = open_object();
    assert!(matches!(
        stream.finish(),
        Err(CanonicalJsonError::StreamState)
    ));

    let stream = CanonicalJsonStream::new(Vec::new());
    assert!(matches!(
        stream.finish(),
        Err(CanonicalJsonError::StreamState)
    ));
}

#[test]
fn a_digest_of_a_large_string_needs_no_buffer_the_size_of_its_text() {
    const TEXT_BYTES: usize = 4 * 1024 * 1024;
    let mut text = String::with_capacity(TEXT_BYTES + 16);
    while text.len() < TEXT_BYTES {
        text.push_str("{\"k\":\"v\\\\\"}\n");
    }
    let value = json!({"decisionJson": text, "id": "d-1"});

    let (digest, growth) = peak_growth(|| canonical_json_digest(&value).expect("digest"));
    assert_eq!(digest, legacy_digest(&value));
    assert!(
        growth < 128 * 1024,
        "digest grew the heap by {growth} B for a {TEXT_BYTES} B string"
    );

    // The control: building the canonical bytes does need the whole text, so the
    // measurement above would notice a regression to a buffered digest.
    let (bytes, growth) = peak_growth(|| canonical_json_bytes(&value).expect("bytes"));
    assert!(bytes.len() > TEXT_BYTES);
    assert!(growth >= TEXT_BYTES, "control grew the heap by {growth} B");

    // The same through the borrowed-value stream: no Value, no copy.
    let (stream_digest, growth) = peak_growth(|| {
        let mut stream = CanonicalJsonStream::digest();
        stream.begin_object().unwrap();
        stream.key("decisionJson").unwrap();
        stream.string(&text).unwrap();
        stream.key("id").unwrap();
        stream.string("d-1").unwrap();
        stream.end_object().unwrap();
        stream.finish_digest().unwrap()
    });
    assert_eq!(stream_digest, digest);
    assert!(
        growth < 128 * 1024,
        "stream grew the heap by {growth} B for a {TEXT_BYTES} B string"
    );
}
