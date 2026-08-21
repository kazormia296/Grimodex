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
}

fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn write_string(value: &str, output: &mut String) -> Result<(), CanonicalJsonError> {
    output.push_str(&serde_json::to_string(value)?);
    Ok(())
}

fn write_number(value: &Number, output: &mut String) -> Result<(), CanonicalJsonError> {
    // serde_json::Number cannot normally contain NaN or Infinity. Keep the
    // check explicit so this primitive remains fail-closed if its feature set
    // changes, and normalize negative zero to JSON.stringify's "0".
    let encoded = value.to_string();
    if encoded == "-0" || encoded == "-0.0" {
        output.push('0');
        return Ok(());
    }
    if value.as_f64().is_some_and(|number| !number.is_finite()) {
        return Err(CanonicalJsonError::NonFiniteNumber);
    }
    output.push_str(&encoded);
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
