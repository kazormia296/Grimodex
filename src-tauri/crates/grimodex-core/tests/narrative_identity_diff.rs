use grimodex_core::narrative_identity_diff::{
    diff_identity_objects, IdentityDiffChange, IdentityDiffEntry, IdentityDiffObject,
    NarrativeIdentityDiffError,
};

fn object(identity: &str, content_token: &str) -> IdentityDiffObject {
    IdentityDiffObject {
        identity: identity.to_owned(),
        content_token: content_token.to_owned(),
    }
}

#[test]
fn classifies_added_removed_unchanged_and_content_changed_objects() {
    let previous = [
        object("codex:changed", "old"),
        object("codex:removed", "same"),
        object("codex:unchanged", "same"),
    ];
    let current = [
        object("codex:added", "same"),
        object("codex:changed", "new"),
        object("codex:unchanged", "same"),
    ];

    assert_eq!(
        diff_identity_objects(&previous, &current).unwrap(),
        vec![
            IdentityDiffEntry {
                identity: "codex:added".to_owned(),
                change: IdentityDiffChange::Added,
            },
            IdentityDiffEntry {
                identity: "codex:changed".to_owned(),
                change: IdentityDiffChange::ContentChanged,
            },
            IdentityDiffEntry {
                identity: "codex:removed".to_owned(),
                change: IdentityDiffChange::Removed,
            },
            IdentityDiffEntry {
                identity: "codex:unchanged".to_owned(),
                change: IdentityDiffChange::Unchanged,
            },
        ]
    );
}

#[test]
fn output_is_independent_of_input_order() {
    let previous = [object("codex:a", "1"), object("codex:b", "2")];
    let previous_reversed = [object("codex:b", "2"), object("codex:a", "1")];
    let current = [object("codex:b", "3"), object("codex:c", "4")];
    let current_reversed = [object("codex:c", "4"), object("codex:b", "3")];

    assert_eq!(
        diff_identity_objects(&previous, &current),
        diff_identity_objects(&previous_reversed, &current_reversed)
    );
}

#[test]
fn rejects_duplicate_identity_in_either_revision() {
    for (previous, current) in [
        (vec![object("codex:a", "1"), object("codex:a", "2")], vec![]),
        (vec![], vec![object("codex:a", "1"), object("codex:a", "2")]),
    ] {
        assert_eq!(
            diff_identity_objects(&previous, &current),
            Err(NarrativeIdentityDiffError::DuplicateIdentity {
                identity: "codex:a".to_owned(),
            })
        );
    }
}

#[test]
fn rejects_empty_identity_and_content_token() {
    assert_eq!(
        diff_identity_objects(&[object("", "token")], &[]),
        Err(NarrativeIdentityDiffError::EmptyIdentity)
    );
    assert_eq!(
        diff_identity_objects(&[], &[object("codex:a", "")]),
        Err(NarrativeIdentityDiffError::EmptyContentToken)
    );
}

#[test]
fn partial_identity_match_is_added_and_removed() {
    assert_eq!(
        diff_identity_objects(&[object("codex:a", "same")], &[object("codex:ab", "same")]).unwrap(),
        vec![
            IdentityDiffEntry {
                identity: "codex:a".to_owned(),
                change: IdentityDiffChange::Removed,
            },
            IdentityDiffEntry {
                identity: "codex:ab".to_owned(),
                change: IdentityDiffChange::Added,
            },
        ]
    );
}

#[test]
fn sorts_identities_by_utf16_code_units() {
    let supplementary = "codex:\u{10000}";
    let bmp = "codex:\u{e000}";
    let result =
        diff_identity_objects(&[], &[object(bmp, "1"), object(supplementary, "2")]).unwrap();

    assert_eq!(
        result
            .iter()
            .map(|entry| entry.identity.as_str())
            .collect::<Vec<_>>(),
        vec![supplementary, bmp]
    );
}
