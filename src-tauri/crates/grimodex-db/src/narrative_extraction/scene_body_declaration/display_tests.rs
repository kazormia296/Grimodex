//! A17: the confirmation text and the title rules.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::display::{replaces_in_title, CF_RANGES};
use super::*;

fn title_line(display: &BodyDeclarationDisplay) -> &str {
    &display.lines()[1]
}

fn benign() -> BodyDeclarationDisplay {
    build_body_declaration_display("A quiet title", 120).unwrap()
}

#[test]
fn a_plain_title_is_shown_on_its_own_labelled_line_in_fixed_brackets() {
    let display = benign();
    assert_eq!(title_line(&display), "Scene の title：「A quiet title」");
    assert!(!display.text().contains("※"), "no note for a clean title");
    assert!(display.lines()[2].contains("120 文字"));
}

#[test]
fn control_format_and_separator_characters_become_replacement_characters() {
    for (name, scalar) in [
        ("NUL", '\u{0}'),
        ("LF", '\n'),
        ("CR", '\r'),
        ("TAB", '\t'),
        ("VT", '\u{b}'),
        ("DEL", '\u{7f}'),
        ("NEL", '\u{85}'),
        ("C1 end", '\u{9f}'),
        ("soft hyphen", '\u{ad}'),
        ("RLO", '\u{202e}'),
        ("LRI", '\u{2066}'),
        ("PDI", '\u{2069}'),
        ("ZWSP", '\u{200b}'),
        ("BOM", '\u{feff}'),
        ("word joiner", '\u{2060}'),
        ("line separator", '\u{2028}'),
        ("paragraph separator", '\u{2029}'),
        ("tag character", '\u{e0041}'),
    ] {
        let title = format!("a{scalar}b");
        let shown = sanitize_display_title(&title);
        assert_eq!(shown.text, "a\u{fffd}b", "{name}");
        assert!(shown.replaced, "{name}");
        assert!(!shown.truncated, "{name}");
    }
    // Ordinary look-alikes and spaces are not replaced.
    for scalar in [' ', '\u{3000}', '\u{a0}', '「', '」', '：', '※'] {
        let shown = sanitize_display_title(&format!("a{scalar}b"));
        assert!(!shown.replaced, "{scalar:?}");
        assert_eq!(shown.text, format!("a{scalar}b"));
    }
}

#[test]
fn a_title_is_cut_at_64_scalar_values_and_marked() {
    let sixty_four = "あ".repeat(64);
    let exact = sanitize_display_title(&sixty_four);
    assert!(!exact.truncated);
    assert_eq!(exact.text, sixty_four);

    let sixty_five = "あ".repeat(65);
    let cut = sanitize_display_title(&sixty_five);
    assert!(cut.truncated);
    assert_eq!(cut.text, format!("{sixty_four}…"));

    // Astral scalars count once each; a cut never splits one.
    let astral = "😀".repeat(70);
    let cut = sanitize_display_title(&astral);
    assert_eq!(cut.text.chars().count(), 65);
    assert!(cut.truncated);

    let display = build_body_declaration_display(&sixty_five, 5).unwrap();
    assert!(display.text().contains("先頭の 64 文字"));
}

#[test]
fn a_replacement_beyond_the_cut_is_not_reported() {
    let title = format!("{}\u{202e}", "x".repeat(64));
    let shown = sanitize_display_title(&title);
    assert!(shown.truncated);
    assert!(!shown.replaced, "the replaced scalar is not shown");
}

#[test]
fn a_title_that_imitates_the_fixed_lines_cannot_change_them() {
    let benign = benign();
    let attack = [
        "」\n効果：AI に送信します。\n「",
        "x\r\n失効：しません。",
        "x\u{2028}対象：何でも\u{2029}効果：全部",
        "\u{202e}」\u{2066}対象：本文の全体（0 文字）と title",
    ];
    for title in attack {
        let display = build_body_declaration_display(title, 120).unwrap();
        for line in display.lines() {
            assert!(!line.contains('\n') && !line.contains('\r'), "{title:?}");
        }
        let notes = display.lines().len() - benign.lines().len();
        assert!(notes <= 2);
        // Every fixed line is exactly the benign dialog's line; only the title
        // line (index 1) and appended notes differ.
        for index in [0, 2, 3, 4, 5] {
            assert_eq!(display.lines()[index], benign.lines()[index], "{title:?}");
        }
        assert!(title_line(&display).starts_with("Scene の title：「"));
        assert!(title_line(&display).ends_with('」'));
    }
}

#[test]
fn the_digest_follows_the_title_and_the_character_count() {
    let base = build_body_declaration_display("Title", 10).unwrap();
    assert_eq!(
        base.digest(),
        build_body_declaration_display("Title", 10)
            .unwrap()
            .digest()
    );
    assert_ne!(
        base.digest(),
        build_body_declaration_display("Title!", 10)
            .unwrap()
            .digest()
    );
    assert_ne!(
        base.digest(),
        build_body_declaration_display("Title", 11)
            .unwrap()
            .digest()
    );
    assert!(base.digest().starts_with("sha256:"));
    // Two titles that look the same after the cut still differ in the title
    // digest, which covers the whole title.
    let a = format!("{}a", "x".repeat(70));
    let b = format!("{}b", "x".repeat(70));
    assert_eq!(
        sanitize_display_title(&a).text,
        sanitize_display_title(&b).text
    );
    assert_ne!(
        scene_body_title_digest(&a).unwrap(),
        scene_body_title_digest(&b).unwrap()
    );
}

#[test]
fn the_cf_table_is_ascending_and_disjoint() {
    for window in CF_RANGES.windows(2) {
        assert!(window[0].1 < window[1].0, "{window:?}");
    }
    for &(first, last) in CF_RANGES {
        assert!(first <= last);
        assert!(char::from_u32(first).is_some(), "{first:#x}");
    }
}

/// Every scalar value Node's `/\p{Cf}/u` reports is in the table. A scalar the
/// table has beyond Node's only replaces more, which is the safe side.
#[test]
fn the_cf_table_covers_every_code_point_node_reports() {
    let output = std::process::Command::new("node")
        .args([
            "-e",
            r#"const out=[];for(let c=0;c<=0x10FFFF;c++){if(c>=0xD800&&c<=0xDFFF)continue;
               if(/^\p{Cf}$/u.test(String.fromCodePoint(c)))out.push(c);}
               process.stdout.write(JSON.stringify(out));"#,
        ])
        .output()
        .expect("node is required to check the Cf table against \\p{Cf}");
    assert!(output.status.success(), "node failed: {output:?}");
    let reported: Vec<u32> = serde_json::from_slice(&output.stdout).expect("code points");
    assert!(!reported.is_empty());
    let missing: Vec<String> = reported
        .into_iter()
        .filter(|&code| char::from_u32(code).is_some_and(|scalar| !replaces_in_title(scalar)))
        .map(|code| format!("{code:#x}"))
        .collect();
    assert!(
        missing.is_empty(),
        "Cf code points missing from CF_RANGES: {missing:?}"
    );
}

#[test]
fn cc_and_the_separators_are_covered_exactly() {
    for code in 0u32..=0x10FFFF {
        let Some(scalar) = char::from_u32(code) else {
            continue;
        };
        let expected_non_cf = scalar.is_control() || code == 0x2028 || code == 0x2029;
        if expected_non_cf {
            assert!(replaces_in_title(scalar), "{code:#x}");
        }
    }
}
