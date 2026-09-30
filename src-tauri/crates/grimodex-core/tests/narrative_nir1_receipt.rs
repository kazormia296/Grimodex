use grimodex_core::narrative_nir1_receipt::{
    validate_terminal_matrix, Completion, OutputChannel, OutputObservationError, OutputObserver,
    ParseStatus, ProviderTerminal, TerminalObservation, TerminalStatus, OUTPUT_DIGEST_VERSION,
};

fn parsed(chunks: &[(OutputChannel, &[u8])]) -> TerminalObservation {
    let mut observer = OutputObserver::new();
    for (channel, bytes) in chunks {
        observer.observe(*channel, bytes).expect("valid chunk");
    }
    observer
        .observe_terminal(ProviderTerminal::Complete)
        .expect("complete provider terminal");
    let result = observer.finish(Completion::Parsed);
    assert_eq!(result.terminal_status, TerminalStatus::Succeeded);
    assert_eq!(result.parse_status, ParseStatus::Parsed);
    assert_eq!(result.digest_version, OUTPUT_DIGEST_VERSION);
    result
}

fn assert_invalid(result: TerminalObservation) {
    assert_eq!(result.terminal_status, TerminalStatus::Failed);
    assert_eq!(result.parse_status, ParseStatus::Invalid);
    assert!(result.response_digest.is_some());
    assert!(validate_terminal_matrix(
        result.terminal_status,
        result.parse_status,
        result.response_digest.is_some()
    )
    .is_ok());
}

#[test]
fn digest_format_has_a_stable_versioned_domain_separated_vector() {
    let result = parsed(&[(OutputChannel::Text, b"a"), (OutputChannel::Thinking, b"b")]);
    assert_eq!(
        result.text_digest,
        "sha256:5dad8d6c986e60f39b5a337628c47f817ff450127c506afe261c075ae4e81cc7"
    );
    assert_eq!(
        result.thinking_digest,
        "sha256:dedd65e605b346fc9e4a5a71ea0f2b0246c50f1aa1443ce28f1f62fd00e1f78d"
    );
    assert_eq!(
        result.response_digest.as_deref(),
        Some("sha256:a2e6e867fcb159fe2b670e457d6910796813e2a836a6f50710b2fd296b37b10f")
    );
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["digestVersion"], "nir1-native-output@1");
    assert_eq!(value["providerTerminal"], "complete");
    assert_eq!(value["terminalStatus"], "succeeded");
    assert_eq!(value["parseStatus"], "parsed");
    let cancelled =
        serde_json::to_value(OutputObserver::new().finish(Completion::Cancelled)).unwrap();
    assert_eq!(cancelled["parseStatus"], "not-attempted");
    assert_eq!(cancelled["responseDigest"], serde_json::Value::Null);
}

#[test]
fn malformed_bytes_keep_chunk_invariant_failed_digests() {
    let bytes = [b'a', 0xc0, 0x80, b'b'];
    let mut whole = OutputObserver::new();
    assert!(whole.observe(OutputChannel::Text, &bytes).is_err());
    let whole = whole.finish(Completion::ParseFailure);
    for split in 0..=bytes.len() {
        let mut split_observer = OutputObserver::new();
        let _ = split_observer.observe(OutputChannel::Text, &bytes[..split]);
        let _ = split_observer.observe(OutputChannel::Text, &bytes[split..]);
        assert_eq!(split_observer.finish(Completion::ParseFailure), whole);
    }
}

#[test]
fn every_utf8_split_preserves_the_same_channel_and_response_digests() {
    let text = " \0éあ😀e\u{301}\n\t".as_bytes();
    let thinking =
        "\u{7f}\u{80}\u{7ff}\u{800}\u{d7ff}\u{e000}\u{ffff}\u{10000}\u{10ffff}".as_bytes();
    let expected = parsed(&[
        (OutputChannel::Text, text),
        (OutputChannel::Thinking, thinking),
    ]);
    for text_split in 0..=text.len() {
        for thinking_split in 0..=thinking.len() {
            assert_eq!(
                parsed(&[
                    (OutputChannel::Text, &text[..text_split]),
                    (OutputChannel::Text, &text[text_split..]),
                    (OutputChannel::Thinking, &thinking[..thinking_split]),
                    (OutputChannel::Thinking, &thinking[thinking_split..]),
                ]),
                expected
            );
        }
    }
    let chunks: Vec<_> = text
        .chunks(1)
        .map(|bytes| (OutputChannel::Text, bytes))
        .chain(
            thinking
                .chunks(1)
                .map(|bytes| (OutputChannel::Thinking, bytes)),
        )
        .collect();
    assert_eq!(parsed(&chunks), expected);
}

#[test]
fn channel_identity_and_interleaving_are_bound_without_changing_channel_digests() {
    let interleaved = parsed(&[
        (OutputChannel::Text, b"a"),
        (OutputChannel::Thinking, b"x"),
        (OutputChannel::Text, b"b"),
    ]);
    let grouped = parsed(&[
        (OutputChannel::Text, b"ab"),
        (OutputChannel::Thinking, b"x"),
    ]);
    assert_eq!(interleaved.text_digest, grouped.text_digest);
    assert_eq!(interleaved.thinking_digest, grouped.thinking_digest);
    assert_ne!(interleaved.response_digest, grouped.response_digest);

    let text = parsed(&[(OutputChannel::Text, b"same")]);
    let thinking = parsed(&[(OutputChannel::Thinking, b"same")]);
    assert_ne!(text.text_digest, thinking.thinking_digest);
    assert_ne!(text.response_digest, thinking.response_digest);

    let reversed = parsed(&[
        (OutputChannel::Text, b"ba"),
        (OutputChannel::Thinking, b"x"),
    ]);
    assert_ne!(reversed.text_digest, grouped.text_digest);
    assert_ne!(reversed.response_digest, grouped.response_digest);
}

#[test]
fn independent_utf8_channel_states_preserve_interleaved_partial_characters() {
    let mut observer = OutputObserver::new();
    let text = "あ".as_bytes();
    let thinking = "😀".as_bytes();
    observer.observe(OutputChannel::Text, &text[..1]).unwrap();
    observer
        .observe(OutputChannel::Thinking, &thinking[..2])
        .unwrap();
    observer.observe(OutputChannel::Text, &text[1..]).unwrap();
    observer
        .observe(OutputChannel::Thinking, &thinking[2..])
        .unwrap();
    observer
        .observe_terminal(ProviderTerminal::Complete)
        .unwrap();
    let result = observer.finish(Completion::Parsed);
    let grouped = parsed(&[
        (OutputChannel::Text, text),
        (OutputChannel::Thinking, thinking),
    ]);
    assert_eq!(result.terminal_status, TerminalStatus::Succeeded);
    assert_eq!(result.text_digest, grouped.text_digest);
    assert_eq!(result.thinking_digest, grouped.thinking_digest);
    assert_ne!(result.response_digest, grouped.response_digest);
}

#[test]
fn whitespace_and_unicode_normalization_are_not_applied() {
    for (left, right) in [(" value\n", "value"), ("é", "e\u{301}"), ("Ａ", "A")] {
        let left = parsed(&[(OutputChannel::Text, left.as_bytes())]);
        let right = parsed(&[(OutputChannel::Text, right.as_bytes())]);
        assert_ne!(left.text_digest, right.text_digest);
        assert_ne!(left.response_digest, right.response_digest);
    }
}

#[test]
fn terminal_matrix_accepts_exactly_the_five_approved_rows() {
    let allowed = [
        (TerminalStatus::Succeeded, ParseStatus::Parsed, true),
        (TerminalStatus::Failed, ParseStatus::Invalid, true),
        (TerminalStatus::Failed, ParseStatus::NotAttempted, false),
        (TerminalStatus::Cancelled, ParseStatus::NotAttempted, false),
        (TerminalStatus::Skipped, ParseStatus::NotAttempted, false),
    ];
    for terminal in [
        TerminalStatus::Succeeded,
        TerminalStatus::Failed,
        TerminalStatus::Cancelled,
        TerminalStatus::Skipped,
    ] {
        for parse in [
            ParseStatus::Parsed,
            ParseStatus::Invalid,
            ParseStatus::NotAttempted,
        ] {
            for has_digest in [false, true] {
                assert_eq!(
                    validate_terminal_matrix(terminal, parse, has_digest).is_ok(),
                    allowed.contains(&(terminal, parse, has_digest)),
                    "{terminal:?} / {parse:?} / digest={has_digest}"
                );
            }
        }
    }
}

#[test]
fn eof_parse_failure_and_truncation_never_promote_a_provider_terminal() {
    for completion in [
        Completion::Parsed,
        Completion::UnexpectedEof,
        Completion::ParseFailure,
        Completion::Truncated,
    ] {
        let mut observer = OutputObserver::new();
        observer.observe(OutputChannel::Text, b"partial").unwrap();
        let result = observer.finish(completion);
        assert_eq!(result.provider_terminal, None);
        assert_invalid(result);
    }
    for completion in [
        Completion::UnexpectedEof,
        Completion::ParseFailure,
        Completion::Truncated,
    ] {
        let mut observer = OutputObserver::new();
        observer
            .observe_terminal(ProviderTerminal::Complete)
            .unwrap();
        assert_invalid(observer.finish(completion));
    }
    for terminal in [ProviderTerminal::LengthLimit, ProviderTerminal::Ineligible] {
        let mut observer = OutputObserver::new();
        observer.observe_terminal(terminal).unwrap();
        let result = observer.finish(Completion::Parsed);
        assert_eq!(result.provider_terminal, Some(terminal));
        assert_invalid(result);
    }
}

#[test]
fn cancel_skip_and_dispatch_failure_have_null_response_digest() {
    for (completion, expected) in [
        (Completion::Cancelled, TerminalStatus::Cancelled),
        (Completion::Skipped, TerminalStatus::Skipped),
        (Completion::DispatchFailure, TerminalStatus::Failed),
    ] {
        for observed in [false, true] {
            let mut observer = OutputObserver::new();
            if observed {
                observer.observe(OutputChannel::Text, b"observed").unwrap();
                observer
                    .observe_terminal(ProviderTerminal::Complete)
                    .unwrap();
            }
            let result = observer.finish(completion);
            assert_eq!(result.terminal_status, expected);
            assert_eq!(result.parse_status, ParseStatus::NotAttempted);
            assert_eq!(result.response_digest, None);
            assert_eq!(
                result.provider_terminal,
                observed.then_some(ProviderTerminal::Complete)
            );
            assert!(validate_terminal_matrix(expected, result.parse_status, false).is_ok());
        }
    }
}

#[test]
fn duplicate_terminal_or_post_terminal_data_permanently_prevent_success() {
    for duplicate in [
        ProviderTerminal::Complete,
        ProviderTerminal::LengthLimit,
        ProviderTerminal::Ineligible,
    ] {
        let mut observer = OutputObserver::new();
        observer
            .observe_terminal(ProviderTerminal::Complete)
            .unwrap();
        assert_eq!(
            observer.observe_terminal(duplicate),
            Err(OutputObservationError::DuplicateTerminal)
        );
        let result = observer.finish(Completion::Parsed);
        assert_eq!(result.provider_terminal, Some(ProviderTerminal::Complete));
        assert_invalid(result);
    }
    for channel in [OutputChannel::Text, OutputChannel::Thinking] {
        for bytes in [b"".as_slice(), b"late".as_slice()] {
            let mut observer = OutputObserver::new();
            observer
                .observe_terminal(ProviderTerminal::Complete)
                .unwrap();
            assert_eq!(
                observer.observe(channel, bytes),
                Err(OutputObservationError::DataAfterTerminal)
            );
            assert_invalid(observer.finish(Completion::Parsed));
        }
    }
}

#[test]
fn malformed_and_incomplete_utf8_fail_closed_for_either_channel() {
    let malformed: &[&[u8]] = &[
        &[0x80],
        &[0xc0, 0x80],
        &[0xc1, 0xbf],
        &[0xc2, b'a'],
        &[0xe0, 0x9f, 0xbf],
        &[0xed, 0xa0, 0x80],
        &[0xf0, 0x8f, 0xbf, 0xbf],
        &[0xf4, 0x90, 0x80, 0x80],
        &[0xf5, 0x80, 0x80, 0x80],
        &[0xff],
    ];
    for channel in [OutputChannel::Text, OutputChannel::Thinking] {
        for bytes in malformed {
            for split in 0..=bytes.len() {
                let mut observer = OutputObserver::new();
                let first = observer.observe(channel, &bytes[..split]);
                let second = observer.observe(channel, &bytes[split..]);
                assert!(first.is_err() || second.is_err());
                assert_eq!(
                    observer.observe(channel, b"valid"),
                    Err(OutputObservationError::AlreadyInvalid)
                );
                assert_eq!(
                    observer.observe_terminal(ProviderTerminal::Complete),
                    Err(OutputObservationError::AlreadyInvalid)
                );
                assert_invalid(observer.finish(Completion::Parsed));
            }
        }
        for bytes in [&[0xc2][..], &[0xe0, 0xa0][..], &[0xf4, 0x8f, 0xbf][..]] {
            let mut observer = OutputObserver::new();
            observer.observe(channel, bytes).unwrap();
            assert_eq!(
                observer.observe_terminal(ProviderTerminal::Complete),
                Err(OutputObservationError::InvalidUtf8)
            );
            assert_invalid(observer.finish(Completion::Parsed));
        }
    }
}
