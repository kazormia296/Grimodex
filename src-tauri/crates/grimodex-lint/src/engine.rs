//! Public entry point. Converts request payloads into Diagnostics by
//! invoking each enabled rule and merging their output.

use serde::{Deserialize, Serialize};

use crate::error::LintError;
use crate::rule::{
    Diagnostic, Language, LintBlock, LintConfig, LintContext, LintInput, LintScope, RuleWarning,
};
use crate::rules::build_ruleset;

/// Hard cap on the combined UTF-8 byte size of `blocks[*].text`.
pub const MAX_INPUT_BYTES: usize = 500 * 1024;

#[derive(Debug, Serialize, Deserialize)]
pub struct LintResponse {
    pub diagnostics: Vec<Diagnostic>,
    pub warnings: Vec<RuleWarning>,
    /// Wall-clock epoch milliseconds when the response was produced. Phase
    /// 1 uses this only for debug logging; UI does not surface it.
    pub computed_at: i64,
}

/// Run the linter once.
///
/// Returns `Err(LintError)` only for unrecoverable problems (size caps,
/// language/config validation). Per-rule failures are reported in
/// `LintResponse.warnings` and never abort the full run.
pub fn lint(
    blocks: &[LintBlock],
    language: Language,
    scope: LintScope,
    config: &LintConfig,
) -> Result<LintResponse, LintError> {
    let total_bytes: usize = blocks.iter().map(|b| b.text.len()).sum();
    if total_bytes > MAX_INPUT_BYTES {
        tracing::warn!(
            actual = total_bytes,
            max = MAX_INPUT_BYTES,
            "lint request rejected: text too large"
        );
        return Err(LintError::TextTooLarge {
            actual: total_bytes,
            max: MAX_INPUT_BYTES,
        });
    }

    let (rules, mut warnings) = build_ruleset(language);
    let ctx = LintContext { config };
    let input = LintInput {
        blocks,
        language,
        scope,
    };

    let mut diagnostics = Vec::new();
    for rule in &rules {
        // Enabled check: explicit `enabled: false` in config silences; all
        // other cases (missing entry, `enabled: true`) run the rule.
        let enabled = config.rule(rule.id()).map(|r| r.enabled).unwrap_or(true);
        if !enabled {
            continue;
        }
        if !rule.supported_languages().contains(&language) {
            continue;
        }
        let produced = rule.check(&input, &ctx);
        diagnostics.extend(produced);
    }

    // Deterministic ordering: by (range.start, range.end, rule_id).
    diagnostics.sort_by(|a, b| {
        a.range
            .start
            .cmp(&b.range.start)
            .then(a.range.end.cmp(&b.range.end))
            .then_with(|| a.rule_id.cmp(&b.rule_id))
    });

    // Keep the warnings list deterministic too for fixture comparison.
    warnings.sort_by(|a, b| a.rule_id.cmp(&b.rule_id));

    if !warnings.is_empty() {
        for w in &warnings {
            tracing::warn!(rule_id = %w.rule_id, ?w.kind, message = %w.message, "lint rule warning");
        }
    }

    Ok(LintResponse {
        diagnostics,
        warnings,
        computed_at: now_millis(),
    })
}

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;
    use crate::rule::BlockKind;

    #[test]
    fn rejects_oversize_input() {
        let big = "a".repeat(MAX_INPUT_BYTES + 1);
        let blocks = vec![LintBlock {
            id: 0,
            kind: BlockKind::Paragraph,
            text: big,
            str_offset_start: 0,
        }];
        let err = lint(
            &blocks,
            Language::Japanese,
            LintScope::Scene {
                scene_id: "x".into(),
            },
            &LintConfig::default(),
        )
        .unwrap_err();
        match err {
            LintError::TextTooLarge { .. } => {}
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn empty_input_ok() {
        let r = lint(
            &[],
            Language::Japanese,
            LintScope::Scene {
                scene_id: "x".into(),
            },
            &LintConfig::default(),
        )
        .expect("ok");
        assert!(r.diagnostics.is_empty());
    }

    #[test]
    fn disabled_rule_respected() {
        let mut cfg = LintConfig::default();
        cfg.rules.insert(
            "ja/consecutive-punct".into(),
            crate::rule::RuleConfig {
                enabled: false,
                severity: None,
                options: serde_json::Value::Null,
            },
        );
        let blocks = [LintBlock {
            id: 0,
            kind: BlockKind::Paragraph,
            text: "、、".into(),
            str_offset_start: 0,
        }];
        let r = lint(
            &blocks,
            Language::Japanese,
            LintScope::Scene {
                scene_id: "x".into(),
            },
            &cfg,
        )
        .expect("ok");
        assert!(r.diagnostics.is_empty());
    }

    #[test]
    fn diagnostics_sorted_by_range() {
        let blocks = [LintBlock {
            id: 0,
            kind: BlockKind::Paragraph,
            text: "。。あ、、".into(),
            str_offset_start: 0,
        }];
        let r = lint(
            &blocks,
            Language::Japanese,
            LintScope::Scene {
                scene_id: "x".into(),
            },
            &LintConfig::default(),
        )
        .expect("ok");
        assert_eq!(r.diagnostics.len(), 2);
        assert!(r.diagnostics[0].range.start < r.diagnostics[1].range.start);
    }
}
