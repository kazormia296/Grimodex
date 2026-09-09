use serde_json::Value;

const RAW_QUERY_TAIL_UTF16_UNITS: usize = 500;

fn legacy_prosemirror_text(node: &Value) -> Option<String> {
    if node.is_null() {
        return None;
    }
    if let Some(text) = node.get("text").and_then(Value::as_str) {
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }
    let Some(content) = node.get("content") else {
        return Some(String::new());
    };
    if content.is_null() || content == &Value::Bool(false) {
        return Some(String::new());
    }
    let parts = content
        .as_array()?
        .iter()
        .map(legacy_prosemirror_text)
        .collect::<Option<Vec<_>>>()?;
    let mut result = parts.concat();
    if matches!(
        node.get("type").and_then(Value::as_str),
        Some("paragraph" | "heading")
    ) {
        result.push('\n');
    }
    Some(result)
}

/// ECMAScript String.trim's WhiteSpace and LineTerminator set. Rust's
/// is_whitespace includes U+0085 and excludes U+FEFF, so it is not equivalent.
fn ecmascript_trim(character: char) -> bool {
    matches!(character,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// Preserve the existing Raw query, including its legacy ProseMirror text
/// extraction and UTF-16 slicing. The canonical Evidence normalizer is a
/// separate contract and must not replace this transformation.
pub(crate) fn saved_related_scene_query(saved_content: &str) -> String {
    let body = serde_json::from_str::<Value>(saved_content)
        .ok()
        .and_then(|node| legacy_prosemirror_text(&node))
        .unwrap_or_else(|| saved_content.to_string());
    let units = body
        .trim_matches(ecmascript_trim)
        .encode_utf16()
        .collect::<Vec<_>>();
    let start = units.len().saturating_sub(RAW_QUERY_TAIL_UTF16_UNITS);
    // JS slice may begin with the low half of a surrogate. napi-rs String
    // conversion exposes its UTF-8 replacement, matching the existing call.
    String::from_utf16_lossy(&units[start..])
}

#[cfg(test)]
#[path = "related_scenes_query_tests.rs"]
mod tests;
