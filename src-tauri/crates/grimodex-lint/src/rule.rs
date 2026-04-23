//! Core types shared across the Lint engine and all rules.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Severity of a single Diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

/// Languages supported by the Linter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Japanese,
    English,
}

/// Block kind carried on the input side.
///
/// `codeBlock` / `image` / `horizontalRule` are excluded from LintBlock
/// entirely by the frontend position map, so they never appear here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlockKind {
    Paragraph,
    Heading,
    Blockquote,
    ListItem,
    TableCell,
}

/// Range in UTF-16 code units, anchored on the **scene-wide** text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Utf16Range {
    pub start: u32,
    pub end: u32,
}

impl Utf16Range {
    pub fn contains(&self, inner: &Utf16Range) -> bool {
        self.start <= inner.start && inner.end <= self.end
    }
}

/// A single automatic fix suggestion.
///
/// Invariant: `range` fully contains the owning `Diagnostic.range`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fix {
    pub label: String,
    pub replacement: String,
    pub range: Utf16Range,
}

/// One Diagnostic returned by a rule. `range` is in scene-wide UTF-16 units.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub rule_id: String,
    pub severity: Severity,
    pub message: String,
    pub range: Utf16Range,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<Fix>,
}

/// One unit of plain text handed to the linter. `str_offset_start` is the
/// scene-wide UTF-16 offset at which `text` begins.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LintBlock {
    pub id: u32,
    pub kind: BlockKind,
    pub text: String,
    pub str_offset_start: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LintScope {
    Scene { scene_id: String },
    Chapter { chapter_id: String },
    Project,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RuleConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<Severity>,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub options: serde_json::Value,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LintConfig {
    #[serde(default)]
    pub rules: HashMap<String, RuleConfig>,
}

impl LintConfig {
    pub fn rule(&self, id: &str) -> Option<&RuleConfig> {
        self.rules.get(id)
    }
}

/// Input payload for a single lint request.
pub struct LintInput<'a> {
    pub blocks: &'a [LintBlock],
    pub language: Language,
    pub scope: LintScope,
}

/// Runtime context exposed to rules.
///
/// Phase 2 adds an optional slice of per-block morpheme tokens. The
/// engine populates this only when at least one enabled rule declares
/// `requires_morphology()` — so the cost is paid once per request and
/// amortised across every morphology rule.
pub struct LintContext<'a> {
    pub config: &'a LintConfig,
    /// Tokenised blocks, index-aligned with `LintInput.blocks`. `None`
    /// means no enabled rule needed morphology for this request.
    pub block_tokens: Option<&'a [Vec<crate::morph::MorphToken>]>,
}

/// Non-fatal warning kinds emitted alongside the Diagnostic list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WarningKind {
    Skipped,
    InvalidOption,
    InitFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleWarning {
    pub rule_id: String,
    pub kind: WarningKind,
    pub message: String,
}

/// Trait every lint rule implements.
pub trait LintRule: Send + Sync {
    fn id(&self) -> &'static str;
    fn default_severity(&self) -> Severity;
    fn supported_languages(&self) -> &'static [Language];

    /// Whether this rule needs the per-block morpheme cache from
    /// `LintContext.block_tokens`. The engine tokenises every block
    /// exactly once per request if any enabled rule returns `true`.
    /// Default: `false` (regex-only rules).
    fn requires_morphology(&self) -> bool {
        false
    }

    /// Block kinds this rule applies to. The engine skips any block whose
    /// kind is not in this list. Default: all five block kinds.
    fn supported_block_kinds(&self) -> &'static [BlockKind] {
        &[
            BlockKind::Paragraph,
            BlockKind::Heading,
            BlockKind::Blockquote,
            BlockKind::ListItem,
            BlockKind::TableCell,
        ]
    }

    /// Run the rule.
    ///
    /// Invariant: returned `Diagnostic.range` values must fit inside the
    /// block that produced them (i.e. within `[str_offset_start,
    /// str_offset_start + utf16_len(text)]`).
    fn check(&self, input: &LintInput, ctx: &LintContext) -> Vec<Diagnostic>;
}
