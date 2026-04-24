//! Public entry point. Converts request payloads into Diagnostics by
//! invoking each enabled rule and merging their output.

use serde::{Deserialize, Serialize};

use crate::error::LintError;
use crate::morph::tokenize_blocks;
use crate::rule::{
    Diagnostic, DisableDirective, Language, LintBlock, LintConfig, LintContext, LintInput,
    LintScope, RuleWarning, SelectorKind, Utf16Range, WarningKind,
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
    disables: &[DisableDirective],
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

    // Resolve incoming directives. Invalid ones are dropped with a
    // warning so the author knows their directive had no effect — the
    // lint run itself still succeeds.
    let resolved_disables = resolve_disables(disables, &mut warnings);

    // Decide whether to run the tokenizer. Filter out rules that don't
    // apply to this language / are disabled so we don't tokenise blocks
    // for a feature the user has turned off.
    let needs_morph = rules.iter().any(|r| {
        let enabled = config.rule(r.id()).map(|r| r.enabled).unwrap_or(true);
        enabled && r.supported_languages().contains(&language) && r.requires_morphology()
    });
    let block_tokens = if needs_morph {
        match tokenize_blocks(blocks) {
            Ok(v) => Some(v),
            Err(msg) => {
                tracing::warn!(error = %msg, "morphological analysis failed; morphology rules skipped");
                warnings.push(RuleWarning {
                    rule_id: "core/morphology".to_string(),
                    kind: WarningKind::InitFailed,
                    message: msg,
                });
                None
            }
        }
    } else {
        None
    };

    let ctx = LintContext {
        config,
        block_tokens: block_tokens.as_deref(),
    };
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
        // Morphology-dependent rules are silently skipped when tokenisation
        // failed — the warning above tells the user why.
        if rule.requires_morphology() && ctx.block_tokens.is_none() {
            continue;
        }
        let produced = rule.check(&input, &ctx);
        // Discard diagnostics shadowed by a matching disable directive.
        // Design: directives run **pre-emit**, so disabled diagnostics
        // never reach the Linter panel, editor decoration or status bar.
        for d in produced {
            if !is_disabled(&d, &resolved_disables) {
                diagnostics.push(d);
            }
        }
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

/// Internal struct holding a validated disable directive paired with
/// its target range. Produced once per request and reused by
/// `is_disabled` for every diagnostic.
struct ResolvedDirective {
    kind: SelectorKind,
    range: Utf16Range,
}

fn resolve_disables(
    disables: &[DisableDirective],
    warnings: &mut Vec<RuleWarning>,
) -> Vec<ResolvedDirective> {
    let mut out = Vec::with_capacity(disables.len());
    for d in disables {
        match d.rules.validate() {
            Ok(kind) => out.push(ResolvedDirective {
                kind,
                range: d.range,
            }),
            Err(reason) => {
                warnings.push(RuleWarning {
                    rule_id: "core/disables".to_string(),
                    kind: WarningKind::InvalidOption,
                    message: reason,
                });
            }
        }
    }
    out
}

fn is_disabled(diag: &Diagnostic, resolved: &[ResolvedDirective]) -> bool {
    resolved.iter().any(|d| {
        if !d.range.contains(&diag.range) {
            return false;
        }
        match &d.kind {
            SelectorKind::All => true,
            SelectorKind::Ids(ids) => ids.iter().any(|id| id == &diag.rule_id),
        }
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

    use crate::rule::{DisableDirective, RuleSelector};

    fn scene_scope() -> LintScope {
        LintScope::Scene {
            scene_id: "x".into(),
        }
    }

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
            scene_scope(),
            &LintConfig::default(),
            &[],
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
            scene_scope(),
            &LintConfig::default(),
            &[],
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
        let r = lint(&blocks, Language::Japanese, scene_scope(), &cfg, &[]).expect("ok");
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
            scene_scope(),
            &LintConfig::default(),
            &[],
        )
        .expect("ok");
        assert_eq!(r.diagnostics.len(), 2);
        assert!(r.diagnostics[0].range.start < r.diagnostics[1].range.start);
    }

    // ── disable directive filtering ─────────────────────────────────

    #[test]
    fn disable_all_silences_matching_range() {
        let blocks = [LintBlock {
            id: 0,
            kind: BlockKind::Paragraph,
            text: "。。あ、、".into(),
            str_offset_start: 0,
        }];
        // Range 0..6 covers both "。。" (0..2) and "、、" (3..5) diagnostics.
        let disables = [DisableDirective {
            rules: RuleSelector(vec!["*".into()]),
            range: Utf16Range { start: 0, end: 6 },
        }];
        let r = lint(
            &blocks,
            Language::Japanese,
            scene_scope(),
            &LintConfig::default(),
            &disables,
        )
        .expect("ok");
        assert!(r.diagnostics.is_empty(), "{:?}", r.diagnostics);
    }

    #[test]
    fn disable_specific_rule_leaves_others() {
        let blocks = [LintBlock {
            id: 0,
            kind: BlockKind::Paragraph,
            text: "。。あ、、".into(),
            str_offset_start: 0,
        }];
        // Disable only the first run ("。。" at 0..2) for its specific rule.
        let disables = [DisableDirective {
            rules: RuleSelector(vec!["ja/consecutive-punct".into()]),
            range: Utf16Range { start: 0, end: 2 },
        }];
        let r = lint(
            &blocks,
            Language::Japanese,
            scene_scope(),
            &LintConfig::default(),
            &disables,
        )
        .expect("ok");
        // The "、、" diagnostic remains because its range is outside the
        // directive.
        assert_eq!(r.diagnostics.len(), 1);
        assert_eq!(r.diagnostics[0].range.start, 3);
    }

    #[test]
    fn disable_range_must_contain_diagnostic_fully() {
        let blocks = [LintBlock {
            id: 0,
            kind: BlockKind::Paragraph,
            text: "。。あ、、".into(),
            str_offset_start: 0,
        }];
        // Range 0..1 only covers half of the "。。" diagnostic (which is
        // 0..2) — containment fails, diagnostic should still fire.
        let disables = [DisableDirective {
            rules: RuleSelector(vec!["*".into()]),
            range: Utf16Range { start: 0, end: 1 },
        }];
        let r = lint(
            &blocks,
            Language::Japanese,
            scene_scope(),
            &LintConfig::default(),
            &disables,
        )
        .expect("ok");
        assert_eq!(r.diagnostics.len(), 2);
    }

    #[test]
    fn invalid_selector_surfaces_warning_and_is_skipped() {
        let blocks = [LintBlock {
            id: 0,
            kind: BlockKind::Paragraph,
            text: "。。".into(),
            str_offset_start: 0,
        }];
        let disables = [
            // Invalid: empty
            DisableDirective {
                rules: RuleSelector(vec![]),
                range: Utf16Range { start: 0, end: 2 },
            },
            // Invalid: "*" mixed with another id
            DisableDirective {
                rules: RuleSelector(vec!["*".into(), "ja/consecutive-punct".into()]),
                range: Utf16Range { start: 0, end: 2 },
            },
        ];
        let r = lint(
            &blocks,
            Language::Japanese,
            scene_scope(),
            &LintConfig::default(),
            &disables,
        )
        .expect("ok");
        // Both directives skipped → diagnostic still fires.
        assert_eq!(r.diagnostics.len(), 1);
        // Both invalidities surfaced as separate warnings.
        let disable_warns = r
            .warnings
            .iter()
            .filter(|w| w.rule_id == "core/disables")
            .count();
        assert_eq!(disable_warns, 2);
    }
}
