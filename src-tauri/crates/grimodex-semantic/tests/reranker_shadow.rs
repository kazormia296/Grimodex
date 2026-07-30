use grimodex_semantic::reranker::{
    model_spec_for_language, sha256_domain_value, RerankerCandidate, RerankerRequest,
};

#[test]
fn selected_language_specs_are_pinned_to_gate2_models() {
    let ja = model_spec_for_language("ja").expect("Japanese spec");
    assert_eq!(
        ja.model_id,
        "hotchpotch/japanese-reranker-xsmall-v2"
    );
    assert_eq!(
        ja.revision,
        "de99fd2f16c7b5df1df1bcc1d9ad2c16d88ce93a"
    );
    assert_eq!(ja.batch_size, 4);
    assert_eq!(ja.max_pair_tokens, 512);

    let en = model_spec_for_language("en").expect("English spec");
    assert_eq!(en.model_id, "cross-encoder/ms-marco-MiniLM-L4-v2");
    assert_eq!(
        en.revision,
        "777b2f369bc1c2f850df8bd367ed1654bda4497b"
    );
    assert!(en.needs_token_type_ids);
}

#[test]
fn request_rejects_unsupported_languages_empty_text_and_more_than_top30() {
    let candidate = || RerankerCandidate {
        candidate_id: "scene:0:10".to_string(),
        text: "candidate".to_string(),
    };

    let unsupported = RerankerRequest {
        language: "fr".to_string(),
        user_message: "question".to_string(),
        scene_tail: String::new(),
        candidates: vec![candidate()],
    };
    assert!(unsupported.validate().is_err());

    let empty_query = RerankerRequest {
        language: "ja".to_string(),
        user_message: " ".to_string(),
        scene_tail: String::new(),
        candidates: vec![candidate()],
    };
    assert!(empty_query.validate().is_err());

    let too_many = RerankerRequest {
        language: "en".to_string(),
        user_message: "question".to_string(),
        scene_tail: String::new(),
        candidates: (0..31)
            .map(|index| RerankerCandidate {
                candidate_id: format!("scene:{index}:{}", index + 1),
                text: "candidate".to_string(),
            })
            .collect(),
    };
    assert!(too_many.validate().is_err());
}

#[test]
fn privacy_hashes_are_stable_and_domain_separated() {
    let query = sha256_domain_value("query", "same-value");
    assert_eq!(query, sha256_domain_value("query", "same-value"));
    assert_ne!(query, sha256_domain_value("candidate", "same-value"));
    assert_eq!(query.len(), 64);
}
