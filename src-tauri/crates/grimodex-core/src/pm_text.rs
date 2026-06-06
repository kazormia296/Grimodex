//! ProseMirror document text-length helpers (UTF-16 code units, matching in-app walkPm).

/// UTF-16 code-unit length (matches in-app `String.length` / walkPm positions).
pub fn utf16_text_len(s: &str) -> i64 {
    s.chars().map(|c| c.len_utf16() as i64).sum()
}

fn utf16_len(s: &str) -> i64 {
    utf16_text_len(s)
}

fn walk_pm_text_len(node: &serde_json::Value) -> i64 {
    if node.get("type").and_then(|v| v.as_str()) == Some("text") {
        return node
            .get("text")
            .and_then(|v| v.as_str())
            .map(utf16_len)
            .unwrap_or(0);
    }
    let mut len = 0i64;
    if let Some(content) = node.get("content").and_then(|v| v.as_array()) {
        for child in content {
            len += walk_pm_text_len(child);
        }
    }
    len
}

/// Total rendered text length of a ProseMirror JSON document (UTF-16 code units).
pub fn pm_doc_text_len(pm_json: &str) -> i64 {
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(pm_json) else {
        return utf16_len(pm_json);
    };
    walk_pm_text_len(&doc)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn empty_doc_has_zero_len() {
        assert_eq!(pm_doc_text_len(r#"{"type":"doc","content":[]}"#), 0);
    }

    #[test]
    fn counts_text_node_chars() {
        let pm = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}]}"#;
        assert_eq!(pm_doc_text_len(pm), 5);
    }
}
