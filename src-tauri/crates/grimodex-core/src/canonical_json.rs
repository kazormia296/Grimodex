use std::cmp::Ordering;

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
}

fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn write_string(value: &str, output: &mut String) -> Result<(), CanonicalJsonError> {
    output.push_str(&serde_json::to_string(value)?);
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

fn write_number(value: &Number, output: &mut String) -> Result<(), CanonicalJsonError> {
    // Canonical JSON follows the JavaScript Number domain used by the
    // TypeScript writer. Converting through f64 also applies JavaScript's
    // rounding to integer-shaped JSON numbers outside its safe-integer range.
    let number = value.as_f64().ok_or(CanonicalJsonError::NonFiniteNumber)?;
    output.push_str(&format_ecmascript_number(number)?);
    Ok(())
}

fn write_object(value: &Map<String, Value>, output: &mut String) -> Result<(), CanonicalJsonError> {
    let mut keys: Vec<&str> = value.keys().map(String::as_str).collect();
    // JavaScript's stable JSON contract sorts UTF-16 code units. Rust's
    // default Unicode scalar ordering differs for astral characters, so use
    // an explicit UTF-16 comparator for cross-runtime byte parity.
    keys.sort_by(|left, right| compare_utf16(left, right));

    output.push('{');
    for (index, key) in keys.into_iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        write_string(key, output)?;
        output.push(':');
        write_value(&value[key], output)?;
    }
    output.push('}');
    Ok(())
}

fn write_value(value: &Value, output: &mut String) -> Result<(), CanonicalJsonError> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => write_number(value, output)?,
        Value::String(value) => write_string(value, output)?,
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_value(value, output)?;
            }
            output.push(']');
        }
        Value::Object(value) => write_object(value, output)?,
    }
    Ok(())
}

/// Returns sorted-object-key canonical JSON bytes.
pub fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, CanonicalJsonError> {
    let mut output = String::new();
    write_value(value, &mut output)?;
    Ok(output.into_bytes())
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

/// Returns the domain-prefixed SHA-256 digest of canonical JSON bytes.
pub fn canonical_json_digest(value: &Value) -> Result<String, CanonicalJsonError> {
    let bytes = canonical_json_bytes(value)?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
}

/// Descriptive alias for callers that prefer the algorithm in the name.
pub fn canonical_json_sha256(value: &Value) -> Result<String, CanonicalJsonError> {
    canonical_json_digest(value)
}
