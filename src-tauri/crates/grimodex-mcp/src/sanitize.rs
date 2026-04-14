//! Input sanitization helpers for Phase 3 write tools.

use anyhow::{bail, Result};

const MAX_CONTENT_BYTES: usize = 1_048_576; // 1 MB
const MAX_ALIAS_LEN: usize = 100;
const MAX_ALIAS_COUNT: usize = 50;
const MAX_NAME_LEN: usize = 255;
const MAX_SUMMARY_LEN: usize = 2000;

/// Strip NUL bytes and C0/C1 control characters (excluding tab, newline, carriage return).
fn strip_control_chars(s: &str) -> String {
    s.chars()
        .filter(|&c| c >= ' ' || c == '\t' || c == '\n' || c == '\r')
        .collect()
}

/// Validate and sanitize a name field (non-empty, max 255 chars).
pub fn sanitize_name(name: &str) -> Result<String> {
    let cleaned = strip_control_chars(name).trim().to_string();
    if cleaned.is_empty() {
        bail!("Name must not be empty");
    }
    if cleaned.len() > MAX_NAME_LEN {
        bail!("Name too long (max {} characters)", MAX_NAME_LEN);
    }
    Ok(cleaned)
}

/// Validate and sanitize a summary string.
pub fn sanitize_summary(summary: &str) -> Result<String> {
    let cleaned = strip_control_chars(summary).trim().to_string();
    if cleaned.len() > MAX_SUMMARY_LEN {
        bail!("Summary too long (max {} characters)", MAX_SUMMARY_LEN);
    }
    Ok(cleaned)
}

/// Validate a list of aliases: max 50, each max 100 chars, no empty strings.
pub fn sanitize_aliases(aliases: &[String]) -> Result<Vec<String>> {
    if aliases.len() > MAX_ALIAS_COUNT {
        bail!("Too many aliases (max {} allowed)", MAX_ALIAS_COUNT);
    }
    let mut result = Vec::with_capacity(aliases.len());
    for (i, alias) in aliases.iter().enumerate() {
        let cleaned = strip_control_chars(alias).trim().to_string();
        if cleaned.is_empty() {
            bail!("Alias #{} must not be empty", i + 1);
        }
        if cleaned.len() > MAX_ALIAS_LEN {
            bail!(
                "Alias #{} too long (max {} characters)",
                i + 1,
                MAX_ALIAS_LEN
            );
        }
        result.push(cleaned);
    }
    Ok(result)
}

/// Validate content size limit (1 MB).
pub fn validate_content_size(content: &str) -> Result<()> {
    if content.len() > MAX_CONTENT_BYTES {
        bail!("Content too large (max {} bytes)", MAX_CONTENT_BYTES);
    }
    Ok(())
}

/// Wrap Markdown text as minimal ProseMirror JSON for storage.
///
/// Splits by blank lines into paragraph nodes. Grimodex's TipTap is configured
/// with tiptap-markdown so it can re-parse this format.
pub fn markdown_to_prosemirror(md: &str) -> String {
    if md.trim().is_empty() {
        return r#"{"type":"doc","content":[]}"#.to_string();
    }

    let paragraphs: Vec<serde_json::Value> = md
        .split("\n\n")
        .map(|para| para.trim())
        .filter(|para| !para.is_empty())
        .map(|para| {
            serde_json::json!({
                "type": "paragraph",
                "content": [{"type": "text", "text": para}]
            })
        })
        .collect();

    serde_json::json!({
        "type": "doc",
        "content": paragraphs
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_name_ok() {
        assert_eq!(sanitize_name("  Alice  ").unwrap(), "Alice");
    }

    #[test]
    fn test_sanitize_name_empty() {
        assert!(sanitize_name("   ").is_err());
    }

    #[test]
    fn test_sanitize_name_too_long() {
        let s: String = "a".repeat(256);
        assert!(sanitize_name(&s).is_err());
    }

    #[test]
    fn test_sanitize_name_strips_control_chars() {
        let result = sanitize_name("Ali\0ce").unwrap();
        assert_eq!(result, "Alice");
    }

    #[test]
    fn test_sanitize_aliases_ok() {
        let aliases = vec!["Al".to_string(), "Alicia".to_string()];
        let result = sanitize_aliases(&aliases).unwrap();
        assert_eq!(result, aliases);
    }

    #[test]
    fn test_sanitize_aliases_too_many() {
        let aliases: Vec<String> = (0..51).map(|i| format!("alias{i}")).collect();
        assert!(sanitize_aliases(&aliases).is_err());
    }

    #[test]
    fn test_sanitize_aliases_too_long() {
        let aliases = vec!["a".repeat(101)];
        assert!(sanitize_aliases(&aliases).is_err());
    }

    #[test]
    fn test_validate_content_size_ok() {
        assert!(validate_content_size("hello").is_ok());
    }

    #[test]
    fn test_validate_content_size_too_large() {
        let big: String = "x".repeat(MAX_CONTENT_BYTES + 1);
        assert!(validate_content_size(&big).is_err());
    }

    #[test]
    fn test_markdown_to_prosemirror_empty() {
        let pm = markdown_to_prosemirror("   ");
        assert!(pm.contains("\"content\":[]"));
    }

    #[test]
    fn test_markdown_to_prosemirror_single_para() {
        let pm = markdown_to_prosemirror("Hello world");
        assert!(pm.contains("Hello world"));
        assert!(pm.contains("\"type\":\"doc\""));
        assert!(pm.contains("\"type\":\"paragraph\""));
    }

    #[test]
    fn test_markdown_to_prosemirror_multi_para() {
        let pm = markdown_to_prosemirror("First\n\nSecond");
        let v: serde_json::Value = serde_json::from_str(&pm).unwrap();
        assert_eq!(v["content"].as_array().unwrap().len(), 2);
    }
}
