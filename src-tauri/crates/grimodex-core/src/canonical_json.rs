use std::cmp::Ordering;
use std::io::{self, Write};

use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Errors returned by the shared sorted-object-key JSON canonicalizer.
#[derive(Debug, Error)]
pub enum CanonicalJsonError {
    #[error("failed to serialize canonical JSON string: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("canonical JSON number is not finite")]
    NonFiniteNumber,
    #[error("canonical JSON number formatter returned an invalid representation")]
    InvalidNumberFormat,
    #[error("canonical JSON stream keys are not strictly increasing in UTF-16 order")]
    KeyOrder,
    #[error("canonical JSON stream was used out of order")]
    StreamState,
}

fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn io_error(error: io::Error) -> CanonicalJsonError {
    CanonicalJsonError::Serialize(serde_json::Error::io(error))
}

/// Writes `value` as a JSON string with exactly the escaping of
/// `serde_json::to_string`, but straight into `sink`: serde_json hands the
/// unescaped runs over as slices of `value`, so a large string never gets a
/// temporary copy.
fn write_string<W: Write + ?Sized>(value: &str, sink: &mut W) -> Result<(), CanonicalJsonError> {
    serde_json::to_writer(sink, value)?;
    Ok(())
}

/// Format a finite Rust `f64` using ECMAScript's JSON number spelling.
///
/// The pinned `zmij` Schubfach formatter supplies shortest correctly-rounded
/// digits for the binary64 value. This function then applies ECMAScript's
/// `10^-6 <= abs(x) < 10^21` fixed/scientific cutover and exponent spelling.
fn format_ecmascript_number(number: f64) -> Result<String, CanonicalJsonError> {
    if !number.is_finite() {
        return Err(CanonicalJsonError::NonFiniteNumber);
    }
    if number == 0.0 {
        return Ok("0".to_owned());
    }

    let negative = number.is_sign_negative();
    // serde_json's pinned Number formatter uses the Schubfach implementation
    // already present in this checkout and provides shortest correctly-rounded
    // decimal digits for every finite f64. Rust's Display formatter is not
    // ECMAScript-compatible for all binary64 values, so it must not be used as
    // the digit source.
    let representation = Number::from_f64(number.abs())
        .ok_or(CanonicalJsonError::NonFiniteNumber)?
        .to_string();
    let (mantissa, exponent_part) = representation
        .as_bytes()
        .iter()
        .position(|byte| *byte == b'e' || *byte == b'E')
        .map(|index| (&representation[..index], Some(&representation[index + 1..])))
        .unwrap_or((representation.as_str(), None));
    let representation_exponent = if let Some(exponent_part) = exponent_part {
        let (negative_exponent, digits) = match exponent_part.as_bytes().first() {
            Some(b'-') => (true, &exponent_part[1..]),
            Some(b'+') => (false, &exponent_part[1..]),
            _ => (false, exponent_part),
        };
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(CanonicalJsonError::InvalidNumberFormat);
        }
        let mut parsed = 0_i32;
        for byte in digits.bytes() {
            parsed = parsed
                .checked_mul(10)
                .and_then(|value| value.checked_add(i32::from(byte - b'0')))
                .ok_or(CanonicalJsonError::InvalidNumberFormat)?;
        }
        if negative_exponent {
            -parsed
        } else {
            parsed
        }
    } else {
        0
    };
    let (integer, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    if integer.bytes().any(|byte| !byte.is_ascii_digit())
        || fraction.bytes().any(|byte| !byte.is_ascii_digit())
        || (integer.is_empty() && fraction.is_empty())
    {
        return Err(CanonicalJsonError::InvalidNumberFormat);
    }
    let mut digits = String::with_capacity(integer.len() + fraction.len());
    digits.push_str(integer);
    digits.push_str(fraction);
    let mut decimal_position = integer.len() as i32 + representation_exponent;

    let leading_zero_count = digits.bytes().take_while(|byte| *byte == b'0').count();
    if leading_zero_count > 0 {
        digits.drain(..leading_zero_count);
        decimal_position -= leading_zero_count as i32;
    }
    while digits.ends_with('0') {
        digits.pop();
    }
    if digits.is_empty() {
        return Ok("0".to_owned());
    }

    let exponent = decimal_position - 1;
    let mut encoded = if (-6..=20).contains(&exponent) {
        if decimal_position <= 0 {
            format!("0.{}{}", "0".repeat((-decimal_position) as usize), digits)
        } else if decimal_position as usize >= digits.len() {
            format!(
                "{}{}",
                digits,
                "0".repeat(decimal_position as usize - digits.len())
            )
        } else {
            let split = decimal_position as usize;
            format!("{}.{}", &digits[..split], &digits[split..])
        }
    } else {
        let coefficient = if digits.len() == 1 {
            digits.clone()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        if exponent >= 0 {
            format!("{coefficient}e+{exponent}")
        } else {
            format!("{coefficient}e{exponent}")
        }
    };
    if negative {
        encoded.insert(0, '-');
    }
    Ok(encoded)
}

fn write_number<W: Write + ?Sized>(value: &Number, sink: &mut W) -> Result<(), CanonicalJsonError> {
    // Canonical JSON follows the JavaScript Number domain used by the
    // TypeScript writer. Converting through f64 also applies JavaScript's
    // rounding to integer-shaped JSON numbers outside its safe-integer range.
    let number = value.as_f64().ok_or(CanonicalJsonError::NonFiniteNumber)?;
    sink.write_all(format_ecmascript_number(number)?.as_bytes())
        .map_err(io_error)
}

fn write_object<W: Write + ?Sized>(
    value: &Map<String, Value>,
    sink: &mut W,
) -> Result<(), CanonicalJsonError> {
    let mut keys: Vec<&str> = value.keys().map(String::as_str).collect();
    // JavaScript's stable JSON contract sorts UTF-16 code units. Rust's
    // default Unicode scalar ordering differs for astral characters, so use
    // an explicit UTF-16 comparator for cross-runtime byte parity.
    keys.sort_by(|left, right| compare_utf16(left, right));

    sink.write_all(b"{").map_err(io_error)?;
    for (index, key) in keys.into_iter().enumerate() {
        if index > 0 {
            sink.write_all(b",").map_err(io_error)?;
        }
        write_string(key, sink)?;
        sink.write_all(b":").map_err(io_error)?;
        write_value(&value[key], sink)?;
    }
    sink.write_all(b"}").map_err(io_error)
}

fn write_value<W: Write + ?Sized>(value: &Value, sink: &mut W) -> Result<(), CanonicalJsonError> {
    match value {
        Value::Null => sink.write_all(b"null").map_err(io_error)?,
        Value::Bool(value) => sink
            .write_all(if *value { b"true" } else { b"false" })
            .map_err(io_error)?,
        Value::Number(value) => write_number(value, sink)?,
        Value::String(value) => write_string(value, sink)?,
        Value::Array(values) => {
            sink.write_all(b"[").map_err(io_error)?;
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    sink.write_all(b",").map_err(io_error)?;
                }
                write_value(value, sink)?;
            }
            sink.write_all(b"]").map_err(io_error)?;
        }
        Value::Object(value) => write_object(value, sink)?,
    }
    Ok(())
}

/// Returns sorted-object-key canonical JSON bytes.
pub fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, CanonicalJsonError> {
    let mut output = Vec::new();
    write_value(value, &mut output)?;
    Ok(output)
}

/// Returns sorted-object-key canonical JSON text.
pub fn canonical_json_string(value: &Value) -> Result<String, CanonicalJsonError> {
    let bytes = canonical_json_bytes(value)?;
    String::from_utf8(bytes).map_err(|_| {
        CanonicalJsonError::Serialize(serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "canonical JSON is not UTF-8",
        )))
    })
}

/// A [`Write`] sink that hashes what it is given. It keeps no copy of the
/// bytes, so a digest costs the hasher's block buffer, not the canonical text.
#[derive(Default)]
pub struct CanonicalDigestSink(Sha256);

impl Write for CanonicalDigestSink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl CanonicalDigestSink {
    fn finish(self) -> String {
        format!("sha256:{}", hex::encode(self.0.finalize()))
    }
}

/// Returns the domain-prefixed SHA-256 digest of canonical JSON bytes.
///
/// The canonical bytes are streamed into the hasher; they are never held as one
/// buffer. The digest equals the hash of [`canonical_json_bytes`].
pub fn canonical_json_digest(value: &Value) -> Result<String, CanonicalJsonError> {
    let mut sink = CanonicalDigestSink::default();
    write_value(value, &mut sink)?;
    Ok(sink.finish())
}

/// One open container of a [`CanonicalJsonStream`].
enum StreamFrame {
    Array {
        first: bool,
    },
    Object {
        first: bool,
        value_pending: bool,
        previous_key: Option<String>,
    },
}

/// Writes canonical JSON straight from borrowed values, without building a
/// [`Value`] tree and without a temporary string per value.
///
/// The caller supplies object keys already in canonical order (strictly
/// increasing UTF-16 code units, the order [`canonical_json_bytes`] sorts
/// into). The stream checks that order and refuses anything else with
/// [`CanonicalJsonError::KeyOrder`], so its output is byte-identical to the
/// canonical form of the same document or it is an error. Strings are escaped
/// as `serde_json::to_string` does, as slices of the borrowed text.
pub struct CanonicalJsonStream<W: Write> {
    sink: W,
    frames: Vec<StreamFrame>,
    done: bool,
}

impl<W: Write> CanonicalJsonStream<W> {
    pub fn new(sink: W) -> Self {
        Self {
            sink,
            frames: Vec::new(),
            done: false,
        }
    }

    /// Account for the start of a value: the separator the container needs,
    /// and the check that a value is expected here at all.
    fn begin_value(&mut self) -> Result<(), CanonicalJsonError> {
        match self.frames.last_mut() {
            None if self.done => return Err(CanonicalJsonError::StreamState),
            None => {}
            Some(StreamFrame::Array { first }) => {
                if !std::mem::replace(first, false) {
                    self.sink.write_all(b",").map_err(io_error)?;
                }
            }
            Some(StreamFrame::Object { value_pending, .. }) => {
                if !std::mem::replace(value_pending, false) {
                    return Err(CanonicalJsonError::StreamState);
                }
            }
        }
        Ok(())
    }

    fn end_value(&mut self) {
        if self.frames.is_empty() {
            self.done = true;
        }
    }

    pub fn begin_object(&mut self) -> Result<(), CanonicalJsonError> {
        self.begin_value()?;
        self.sink.write_all(b"{").map_err(io_error)?;
        self.frames.push(StreamFrame::Object {
            first: true,
            value_pending: false,
            previous_key: None,
        });
        Ok(())
    }

    pub fn end_object(&mut self) -> Result<(), CanonicalJsonError> {
        match self.frames.pop() {
            Some(StreamFrame::Object {
                value_pending: false,
                ..
            }) => {}
            _ => return Err(CanonicalJsonError::StreamState),
        }
        self.sink.write_all(b"}").map_err(io_error)?;
        self.end_value();
        Ok(())
    }

    pub fn begin_array(&mut self) -> Result<(), CanonicalJsonError> {
        self.begin_value()?;
        self.sink.write_all(b"[").map_err(io_error)?;
        self.frames.push(StreamFrame::Array { first: true });
        Ok(())
    }

    pub fn end_array(&mut self) -> Result<(), CanonicalJsonError> {
        match self.frames.pop() {
            Some(StreamFrame::Array { .. }) => {}
            _ => return Err(CanonicalJsonError::StreamState),
        }
        self.sink.write_all(b"]").map_err(io_error)?;
        self.end_value();
        Ok(())
    }

    /// The next key of the current object. Keys must be strictly increasing in
    /// UTF-16 code-unit order; each must be followed by exactly one value.
    pub fn key(&mut self, key: &str) -> Result<(), CanonicalJsonError> {
        let Some(StreamFrame::Object {
            first,
            value_pending,
            previous_key,
        }) = self.frames.last_mut()
        else {
            return Err(CanonicalJsonError::StreamState);
        };
        if *value_pending {
            return Err(CanonicalJsonError::StreamState);
        }
        if let Some(previous) = previous_key.as_deref() {
            if compare_utf16(previous, key) != Ordering::Less {
                return Err(CanonicalJsonError::KeyOrder);
            }
        }
        match previous_key {
            Some(previous) => {
                previous.clear();
                previous.push_str(key);
            }
            None => *previous_key = Some(key.to_owned()),
        }
        if !std::mem::replace(first, false) {
            self.sink.write_all(b",").map_err(io_error)?;
        }
        *value_pending = true;
        write_string(key, &mut self.sink)?;
        self.sink.write_all(b":").map_err(io_error)
    }

    /// A string value, escaped and written without a temporary copy.
    pub fn string(&mut self, value: &str) -> Result<(), CanonicalJsonError> {
        self.begin_value()?;
        write_string(value, &mut self.sink)?;
        self.end_value();
        Ok(())
    }

    /// A complete value that is already a [`Value`] tree.
    pub fn value(&mut self, value: &Value) -> Result<(), CanonicalJsonError> {
        self.begin_value()?;
        write_value(value, &mut self.sink)?;
        self.end_value();
        Ok(())
    }

    /// The sink, once exactly one complete value has been written.
    pub fn finish(self) -> Result<W, CanonicalJsonError> {
        if !self.frames.is_empty() || !self.done {
            return Err(CanonicalJsonError::StreamState);
        }
        Ok(self.sink)
    }
}

impl CanonicalJsonStream<CanonicalDigestSink> {
    /// A stream that hashes what it writes.
    pub fn digest() -> Self {
        Self::new(CanonicalDigestSink::default())
    }

    /// The domain-prefixed SHA-256 digest of the canonical JSON written so far;
    /// equal to [`canonical_json_digest`] of the same document.
    pub fn finish_digest(self) -> Result<String, CanonicalJsonError> {
        Ok(self.finish()?.finish())
    }
}

/// Descriptive alias for callers that prefer the algorithm in the name.
pub fn canonical_json_sha256(value: &Value) -> Result<String, CanonicalJsonError> {
    canonical_json_digest(value)
}
