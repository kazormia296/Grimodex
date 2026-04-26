//! Linter MCP types (frozen in Phase 1) and command stubs.
//!
//! The actual MCP commands (`list_lint_diagnostics`, `run_lint`,
//! `list_lint_rules`, `apply_lint_fix`) ship in MCP v2 / v4 — see
//! `docs/Grimodex_Linter設計書.md` §「MCP サーバー連携」.
//!
//! The DTOs in this module are **frozen** in Phase 1 so external clients
//! can be coded against the schema before MCP v2 lands. After v2 ships,
//! breaking changes to these types require a new MCP API version.
//!
//! ## Coordinate convention (per design doc)
//!
//! - `line`: 1-origin line number inside the Markdown source
//! - `column`: 0-origin **UTF-16 code unit** offset on that line
//! - `length`: span length in UTF-16 code units
//!
//! UTF-16 is chosen for column/length to match LSP and to avoid an extra
//! conversion step when bridging from `grimodex-lint`'s scene-wide UTF-16
//! offsets. The line/column conversion itself is `grimodex-mcp`'s
//! responsibility (see design doc §「座標変換の責務分担」).

// MCP v2 hasn't wired these into commands yet; the types are only exposed
// so external clients can be coded against the schema before then.
#![allow(dead_code)]

use schemars;
use serde::{Deserialize, Serialize};

/// Severity classification, identical to `grimodex_lint::Severity`.
/// Lower-case wire format keeps the JSON ergonomic for non-Rust clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LintSeverity {
    Error,
    Warning,
    Info,
}

/// Single Quick Fix proposal attached to a diagnostic.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct LintFixDto {
    /// Human-readable label (e.g. "「……」に置き換える").
    pub label: String,
    /// Replacement text inserted in place of the source span.
    pub replacement: String,
    /// 1-origin line number where the replacement starts.
    pub line: u32,
    /// 0-origin UTF-16 column where the replacement starts.
    pub column: u32,
    /// Replacement length in UTF-16 code units.
    pub length: u32,
}

/// Diagnostic as exposed over MCP (line/column form).
///
/// Distinct from `grimodex_lint::Diagnostic`, which uses scene-wide
/// UTF-16 offsets. The conversion lives in `grimodex-mcp`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct LintDiagnosticDto {
    /// Stable rule identifier (e.g. `"ja/sentence-length"`).
    pub rule_id: String,
    pub severity: LintSeverity,
    /// Scene UUID this diagnostic belongs to.
    pub scene_id: String,
    /// Scene title for display (denormalised; clients should not rely on
    /// this for joins).
    pub scene_title: String,
    /// 1-origin line number of the diagnostic span start.
    pub line: u32,
    /// 0-origin UTF-16 column of the diagnostic span start.
    pub column: u32,
    /// Diagnostic span length in UTF-16 code units.
    pub length: u32,
    /// Human-facing message localised on the server side.
    pub message: String,
    /// Verbatim text from the diagnostic span (for tooling that wants
    /// to display context without re-reading the file).
    pub text_snippet: String,
    /// Available Quick Fixes; empty if none.
    #[serde(default)]
    pub fixes: Vec<LintFixDto>,
}

/// Rule descriptor returned by `list_lint_rules` (MCP v2).
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct LintRuleDto {
    pub id: String,
    pub default_severity: LintSeverity,
    /// Effective severity after project-level overrides.
    pub severity: LintSeverity,
    pub enabled: bool,
    /// `["ja"]`, `["en"]`, or both.
    pub languages: Vec<String>,
}

/// Optional warning channel surfaced in MCP responses (mirrors
/// `grimodex_lint::RuleWarning`).
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct LintWarningDto {
    pub rule_id: String,
    pub kind: LintWarningKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LintWarningKind {
    Skipped,
    InvalidOption,
    InitFailed,
}

/// Wrapper response shape for `run_lint` and `list_lint_diagnostics`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct LintResponseDto {
    pub diagnostics: Vec<LintDiagnosticDto>,
    #[serde(default)]
    pub warnings: Vec<LintWarningDto>,
    /// Epoch milliseconds when the scan completed; useful for caches.
    pub computed_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire shape of `LintDiagnosticDto` is frozen in Phase 1.
    /// Adding fields is fine (clients ignore unknowns); renaming or
    /// removing is a breaking change that requires an MCP API version
    /// bump.
    #[test]
    fn diagnostic_serialises_with_documented_keys() {
        let diag = LintDiagnosticDto {
            rule_id: "ja/sentence-length".into(),
            severity: LintSeverity::Warning,
            scene_id: "scene-uuid".into(),
            scene_title: "The tower".into(),
            line: 23,
            column: 5,
            length: 120,
            message: "一文が 120 文字を超えています".into(),
            text_snippet: "扉の前に立った...".into(),
            fixes: vec![],
        };
        let json = serde_json::to_value(&diag).expect("serialise");
        for key in [
            "rule_id",
            "severity",
            "scene_id",
            "scene_title",
            "line",
            "column",
            "length",
            "message",
            "text_snippet",
            "fixes",
        ] {
            assert!(json.get(key).is_some(), "missing key in MCP DTO: {key}");
        }
    }

    #[test]
    fn severity_serialises_lowercase() {
        let json = serde_json::to_string(&LintSeverity::Warning).expect("serialise");
        assert_eq!(json, "\"warning\"");
    }
}
