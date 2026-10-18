//! The confirmation text of a body declaration, built by Native.
//!
//! The text is a fixed allowlist of strings (including three lines that state
//! the meaning of the values the author declares: non-secret reveal, and
//! independent POV, story, auto and phase) plus two values Native itself
//! prepared: the Scene's title, made safe to show, and the body's character
//! count. Nothing from the renderer and nothing derived from the body is
//! used. The title is the only author-controlled text, and it can come from
//! AI Apply or a Codex rename (C12), so it is shown on one fixed-label line
//! inside fixed brackets after every control, format, line-separator and
//! paragraph-separator character was replaced and the length was cut. A title
//! that imitates the fixed lines cannot change them.
//!
//! The digest of the whole text goes into the grant's binding. The writer
//! rebuilds the text in its own transaction from the title and the body it
//! reads there and compares the digest, so the text the author confirmed is
//! the text the writer would have shown (DR-CB2-5).

use anyhow::Result;
use grimodex_core::canonical_json_digest;
use serde_json::json;

/// Most Unicode scalar values of the title that are shown.
pub const DISPLAY_TITLE_MAX_SCALARS: usize = 64;

const REPLACEMENT: char = '\u{FFFD}';
const TRUNCATION_MARK: char = '…';
const DISPLAY_DIGEST_DOMAIN: &str = "grimodex/body-declaration-display/1";
const TITLE_DIGEST_DOMAIN: &str = "grimodex/narrative-scene-body-title/1";

const LINE_HEADING: &str =
    "この Scene の本文全体を、関連シーン（Related Scenes）に表示してよいと宣言します。";
const LINE_TITLE_LABEL: &str = "Scene の title：";
const LINE_TITLE_OPEN: char = '「';
const LINE_TITLE_CLOSE: char = '」';
const LINE_TARGET_PREFIX: &str = "対象：本文の全体（";
const LINE_TARGET_SUFFIX: &str = " 文字）と title";
const LINE_VALUE_REVEAL: &str =
    "宣言する値：本文の全体に、まだ明かしていない秘密を含まないこと（reveal：non-secret）。";
const LINE_VALUE_POV: &str =
    "宣言する値：視点（POV）に限られず、どの視点の query にも表示してよいこと（POV：independent）。";
const LINE_VALUE_STORY: &str =
    "宣言する値：story time と phase に限られず表示してよいこと（story・auto・phase：independent）。";
const LINE_EFFECT: &str = "効果：関連シーンでの本文の先頭の行（excerpt）の表示と、その位置への移動だけです。AI には送りません。";
const LINE_EXPIRY_SCENE: &str = "失効：本文、title、シーンの範囲設定（A1）の変更、restore、workspace の移動、この Scene を含む章（folder）の移動や archive で、この宣言は無効になります。";
const LINE_EXPIRY_REGISTRY: &str =
    "timeline、worldline、layer の registry を変えると、project のすべての宣言が無効になります。";
const LINE_NOTE_REPLACED: &str =
    "※ title に含まれていた制御文字や見えない文字を「\u{FFFD}」に置き換えて表示しています。";
const LINE_NOTE_TRUNCATED: &str = "※ title は先頭の 64 文字までを表示しています。";

/// A title made safe to show.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisplayTitle {
    pub text: String,
    /// At least one shown scalar was a Cc, Cf, Zl or Zp character.
    pub replaced: bool,
    /// The title had more than [`DISPLAY_TITLE_MAX_SCALARS`] scalars.
    pub truncated: bool,
}

/// The text the dialog shows, and its digest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BodyDeclarationDisplay {
    lines: Vec<String>,
    digest: String,
}

impl BodyDeclarationDisplay {
    pub fn lines(&self) -> &[String] {
        &self.lines
    }

    /// The whole text, one line per `\n`. Safe to show: only the title line
    /// carries author text and it holds no line break.
    pub fn text(&self) -> String {
        self.lines.join("\n")
    }

    /// `sha256:` digest of the lines, domain separated.
    pub fn digest(&self) -> &str {
        &self.digest
    }
}

/// Digest of a Scene title, domain separated, over the whole title (not the
/// shortened one). The declaration's `titleDigest` is this value; CB-4's
/// reader computes the same.
pub fn scene_body_title_digest(title: &str) -> Result<String> {
    Ok(canonical_json_digest(&json!({
        "domain": TITLE_DIGEST_DOMAIN,
        "value": title,
    }))?)
}

/// Makes a title safe to show: replaces Cc, Cf, Zl and Zp characters with
/// U+FFFD and keeps at most [`DISPLAY_TITLE_MAX_SCALARS`] Unicode scalar
/// values (a cut ends with `…`).
pub fn sanitize_display_title(title: &str) -> DisplayTitle {
    let mut text = String::new();
    let mut replaced = false;
    let mut truncated = false;
    for (index, scalar) in title.chars().enumerate() {
        if index == DISPLAY_TITLE_MAX_SCALARS {
            truncated = true;
            break;
        }
        if replaces_in_title(scalar) {
            replaced = true;
            text.push(REPLACEMENT);
        } else {
            text.push(scalar);
        }
    }
    if truncated {
        text.push(TRUNCATION_MARK);
    }
    DisplayTitle {
        text,
        replaced,
        truncated,
    }
}

/// Builds the confirmation text. `body_chars` is the number of Unicode scalar
/// values of the Scene's canonical body text.
pub fn build_body_declaration_display(
    title: &str,
    body_chars: u64,
) -> Result<BodyDeclarationDisplay> {
    let shown = sanitize_display_title(title);
    let mut lines = vec![
        LINE_HEADING.to_owned(),
        format!(
            "{LINE_TITLE_LABEL}{LINE_TITLE_OPEN}{}{LINE_TITLE_CLOSE}",
            shown.text
        ),
        format!("{LINE_TARGET_PREFIX}{body_chars}{LINE_TARGET_SUFFIX}"),
        LINE_VALUE_REVEAL.to_owned(),
        LINE_VALUE_POV.to_owned(),
        LINE_VALUE_STORY.to_owned(),
        LINE_EFFECT.to_owned(),
        LINE_EXPIRY_SCENE.to_owned(),
        LINE_EXPIRY_REGISTRY.to_owned(),
    ];
    if shown.replaced {
        lines.push(LINE_NOTE_REPLACED.to_owned());
    }
    if shown.truncated {
        lines.push(LINE_NOTE_TRUNCATED.to_owned());
    }
    let digest = canonical_json_digest(&json!({
        "domain": DISPLAY_DIGEST_DOMAIN,
        "lines": lines,
    }))?;
    Ok(BodyDeclarationDisplay { lines, digest })
}

/// General categories Cc, Cf, Zl and Zp.
pub(crate) fn replaces_in_title(scalar: char) -> bool {
    let code = u32::from(scalar);
    // Cc
    if code <= 0x1F || (0x7F..=0x9F).contains(&code) {
        return true;
    }
    // Zl, Zp
    if code == 0x2028 || code == 0x2029 {
        return true;
    }
    // Cf
    CF_RANGES
        .binary_search_by(|&(first, last)| {
            if code < first {
                std::cmp::Ordering::Greater
            } else if code > last {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// Unicode general category Cf (format) as of Unicode 17, ascending. Written by
/// hand because the crate takes no new dependency for this (DR-CB2-5). A test
/// compares it with every code point Node's `/\p{Cf}/u` reports, so a missing
/// range is caught; a range this table has beyond Node's is only safer.
pub(crate) const CF_RANGES: &[(u32, u32)] = &[
    (0xAD, 0xAD),
    (0x600, 0x605),
    (0x61C, 0x61C),
    (0x6DD, 0x6DD),
    (0x70F, 0x70F),
    (0x890, 0x891),
    (0x8E2, 0x8E2),
    (0x180E, 0x180E),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x2064),
    (0x2066, 0x206F),
    (0xFEFF, 0xFEFF),
    (0xFFF9, 0xFFFB),
    (0x110BD, 0x110BD),
    (0x110CD, 0x110CD),
    (0x13430, 0x1343F),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0001, 0xE0001),
    (0xE0020, 0xE007F),
];
