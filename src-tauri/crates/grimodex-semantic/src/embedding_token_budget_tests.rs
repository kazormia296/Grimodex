use super::token_budget::{encode_document_untruncated, DocumentTokenLimit};
use crate::audit::load_tokenizer_with_identity;
use crate::spec::{EmbeddingModelSpec, SPEC_EN, SPEC_JA};
use std::path::PathBuf;
use tokenizers::{Tokenizer, TruncationParams};

fn tokenizer(spec: &EmbeddingModelSpec) -> Tokenizer {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../resources/semantic")
        .join(spec.dir_name)
        .join("tokenizer.json");
    load_tokenizer_with_identity(&path)
        .expect("required checked-in production tokenizer")
        .0
}

#[test]
fn document_budget_counts_prefix_and_special_tokens_for_both_production_tokenizers() {
    for spec in [&SPEC_JA, &SPEC_EN] {
        let tokenizer = tokenizer(spec);
        let text = r#"{"summary":"The bridge collapsed.","actuality":"actual","attribution":"narrator","narrativeFrame":"story-world"}"#;
        let expected = tokenizer
            .encode(format!("{}{text}", spec.document_prefix), true)
            .expect("full prefixed encoding");
        let actual = encode_document_untruncated(&tokenizer, text, spec)
            .expect("short exact semantic payload fits");
        assert_eq!(actual.get_ids(), expected.get_ids());
        assert_eq!(actual.get_attention_mask(), expected.get_attention_mask());
        assert!(actual.get_special_tokens_mask().contains(&1));
    }
}

#[test]
fn document_budget_accepts_exact_boundary_and_rejects_one_token_over() {
    for original in [&SPEC_JA, &SPEC_EN] {
        let tokenizer = tokenizer(original);
        let text = r#"{"summary":"橋が崩れた。","actuality":"actual","attribution":"narrator","narrativeFrame":"story-world"}"#;
        let count = tokenizer
            .encode(format!("{}{text}", original.document_prefix), true)
            .expect("boundary encoding")
            .len();
        let exact = EmbeddingModelSpec {
            max_seq_len: count,
            ..*original
        };
        assert_eq!(
            encode_document_untruncated(&tokenizer, text, &exact)
                .expect("exact inclusive limit")
                .len(),
            count,
        );
        let overflow = EmbeddingModelSpec {
            max_seq_len: count - 1,
            ..*original
        };
        let error = encode_document_untruncated(&tokenizer, text, &overflow)
            .expect_err("one token beyond model capacity must be rejected");
        assert_eq!(
            error.downcast_ref::<DocumentTokenLimit>(),
            Some(&DocumentTokenLimit {
                actual_tokens: count,
                maximum_tokens: count - 1,
            })
        );
    }
}

#[test]
fn document_budget_removes_preexisting_truncation_without_mutating_raw_tokenizer() {
    let mut tokenizer = tokenizer(&SPEC_EN);
    tokenizer
        .with_truncation(Some(TruncationParams {
            max_length: SPEC_EN.max_seq_len,
            ..Default::default()
        }))
        .expect("production truncation configuration");
    let text = format!(
        "{{\"summary\":\"{}\",\"actuality\":\"actual\",\"attribution\":\"narrator\",\"narrativeFrame\":\"story-world\"}}",
        "洪水".repeat(600),
    );
    assert_eq!(
        tokenizer
            .encode(text.as_str(), true)
            .expect("Raw truncates")
            .len(),
        SPEC_EN.max_seq_len
    );
    let error = encode_document_untruncated(&tokenizer, &text, &SPEC_EN)
        .expect_err("IR must not discard final modality fields");
    assert!(
        error
            .downcast_ref::<DocumentTokenLimit>()
            .expect("typed token limit")
            .actual_tokens
            > SPEC_EN.max_seq_len
    );
    assert_eq!(
        tokenizer
            .encode(text.as_str(), true)
            .expect("Raw is unchanged")
            .len(),
        SPEC_EN.max_seq_len
    );
}

#[test]
fn document_budget_limit_error_does_not_include_the_semantic_payload() {
    let tokenizer = tokenizer(&SPEC_EN);
    let spec = EmbeddingModelSpec {
        max_seq_len: 5,
        ..SPEC_EN
    };
    let text = "private-canary-interpretation-would-exceed-capacity";
    let error = encode_document_untruncated(&tokenizer, text, &spec).expect_err("too long");
    assert!(error
        .to_string()
        .starts_with("SEMANTIC_DOCUMENT_TOKEN_LIMIT:"));
    assert!(!error.to_string().contains("private-canary"));
}
