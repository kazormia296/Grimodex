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

/// One Codex entry surfaced to the Linter.
///
/// Used by F-group rules (`codex/*`) to detect in-text usage of
/// non-canonical variants. The Lint engine does not know about the
/// Codex database — the frontend is expected to serialise the subset
/// of entries relevant to the current scene/project and attach it to
/// `LintConfig.codex_entries` on every lint request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexEntry {
    /// Primary key — carried back in Diagnostic metadata for linking
    /// back to the entry in the UI (future work).
    pub entry_id: String,
    /// The preferred written form. Diagnostics suggest rewriting
    /// non-canonical matches to this value.
    pub canonical: String,
    /// Alternative spellings / aliases known to the author. Matches on
    /// any of these (excluding the canonical) trigger a Diagnostic.
    #[serde(default)]
    pub aliases: Vec<String>,
}

/// One entry of the project-level term dictionary.
///
/// Used by `project/term-consistency`. Unlike Codex entries, these are
/// pure prescriptive style rules (e.g. "use 『ウェブ』, not 『Web』") with
/// **entry-level severity** that takes precedence over the usual
/// rule-level override.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TermEntry {
    /// Stable identifier used to link diagnostics back to the dictionary
    /// row in the Settings UI.
    pub id: String,
    /// Canonical / preferred written form.
    pub preferred: String,
    /// Spellings that should trigger a warning. Matched literally
    /// (regex-escaped at build time). ASCII-word variants receive an
    /// automatic `\b` boundary so `web` does not match inside `webhook`.
    #[serde(default)]
    pub variants: Vec<String>,
    /// Per-entry severity (design: warn or info only — entry-level
    /// severity beats the rule-level override).
    pub severity: Severity,
    /// Optional free-form note surfaced in Diagnostic messages.
    #[serde(default)]
    pub note: Option<String>,
    /// Whether the row contributes to the compiled matcher. Disabled
    /// rows are skipped before collision detection.
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LintConfig {
    #[serde(default)]
    pub rules: HashMap<String, RuleConfig>,
    /// Codex entries available for F-group (codex/*) rule matching.
    /// Empty list is equivalent to "no Codex data" — F-group rules
    /// become no-ops.
    #[serde(default)]
    pub codex_entries: Vec<CodexEntry>,
    /// Project term dictionary entries for `project/term-consistency`.
    /// The engine filters out entries whose variants collide with a
    /// Codex alias (Codex wins) before invoking the rule, so the rule
    /// never sees a colliding entry.
    #[serde(default)]
    pub term_dictionary: Vec<TermEntry>,
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

/// Rule-selection payload for a disable directive.
///
/// Wire format is `Vec<String>`. Valid values:
///   - `["*"]` → disable every rule (call this "All")
///   - Non-empty array of rule IDs not containing `"*"` (call this "Ids")
///
/// Empty arrays and `"*"` mixed with other IDs are rejected at the
/// engine boundary — the directive is skipped and a
/// `RuleWarning::InvalidOption` is surfaced so the author sees why
/// their disable had no effect.
///
/// Phase 3 design:
/// > `"*"` を明示することで意図を型レベルで表現し、空配列は「不正値」として弾く
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RuleSelector(pub Vec<String>);

/// Parsed view of `RuleSelector` after validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectorKind {
    All,
    Ids(Vec<String>),
}

impl RuleSelector {
    pub fn validate(&self) -> Result<SelectorKind, String> {
        if self.0.is_empty() {
            return Err("rules must not be empty (use [\"*\"] for all)".into());
        }
        let has_wildcard = self.0.iter().any(|s| s == "*");
        if has_wildcard && self.0.len() > 1 {
            return Err("\"*\" must not be mixed with other rule IDs".into());
        }
        if has_wildcard {
            Ok(SelectorKind::All)
        } else {
            Ok(SelectorKind::Ids(self.0.clone()))
        }
    }
}

/// One disable directive.
///
/// The engine treats every directive as a `(range, rules)` pair. The UI
/// distinguishes "Span" (TipTap Mark) vs "Block" (node attribute) so
/// users can reason about scope, but from Rust's perspective they're
/// identical: the client has already resolved the block's full extent
/// into a `Utf16Range` before sending it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisableDirective {
    pub rules: RuleSelector,
    pub range: Utf16Range,
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
    /// Collision-filtered term dictionary (Codex-aliased entries
    /// already dropped and surfaced via `RuleWarning::Skipped`). The
    /// engine constructs this once per request so `project/*` rules
    /// don't have to re-run the check.
    pub term_dictionary: &'a [TermEntry],
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
