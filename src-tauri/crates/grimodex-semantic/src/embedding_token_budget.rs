use std::borrow::Cow;
use std::fmt;

use anyhow::{anyhow, Result};
use tokenizers::{Encoding, Tokenizer};

use crate::spec::EmbeddingModelSpec;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocumentTokenLimit {
    pub actual_tokens: usize,
    pub maximum_tokens: usize,
}

impl fmt::Display for DocumentTokenLimit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "SEMANTIC_DOCUMENT_TOKEN_LIMIT: {} tokens exceed model maximum {}",
            self.actual_tokens, self.maximum_tokens
        )
    }
}

impl std::error::Error for DocumentTokenLimit {}

pub(super) fn encode_document_untruncated(
    tokenizer: &Tokenizer,
    text: &str,
    spec: &EmbeddingModelSpec,
) -> Result<Encoding> {
    let tokenizer = if tokenizer.get_truncation().is_some() {
        let mut complete = tokenizer.clone();
        complete
            .with_truncation(None)
            .map_err(|error| anyhow!("failed to disable document truncation: {error}"))?;
        Cow::Owned(complete)
    } else {
        Cow::Borrowed(tokenizer)
    };
    let prefixed = format!("{}{}", spec.document_prefix, text);
    let encoding = tokenizer
        .encode(prefixed, true)
        .map_err(|error| anyhow!("document tokenization failed: {error}"))?;
    let actual_tokens = encoding.len();
    if actual_tokens > spec.max_seq_len {
        return Err(DocumentTokenLimit {
            actual_tokens,
            maximum_tokens: spec.max_seq_len,
        }
        .into());
    }
    anyhow::ensure!(
        actual_tokens > 0,
        "document tokenizer returned an empty sequence"
    );
    Ok(encoding)
}
