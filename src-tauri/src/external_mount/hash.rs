use sha2::{Digest, Sha256};

/// Normalize line endings to LF before hashing so CRLF/LF differences don't
/// cause false mismatches during rename reconciliation.
pub fn normalize_content(content: &str) -> String {
    content.replace("\r\n", "\n")
}

/// SHA-256 hex digest of normalized file content.
pub fn content_hash(content: &str) -> String {
    let normalized = normalize_content(content);
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crlf_and_lf_produce_same_hash() {
        assert_eq!(content_hash("hello\r\nworld"), content_hash("hello\nworld"));
    }
}
