//! `project/term-consistency` — per-project style-guide term dictionary.
//!
//! Drives the Settings「Linter → 用語辞書」tab. Each row pairs a
//! preferred spelling with one or more variants; when a variant shows
//! up in the text we report it with a Quick Fix rewriting to the
//! preferred spelling.
//!
//! ## Matching semantics (設計書 §「マッチングのセマンティクス」)
//!
//! - Variants are treated as **literal strings** (regex-escaped).
//! - Case is significant: `web` and `Web` are independent variants.
//! - When every char of a variant is in `[A-Za-z0-9_]`, the engine
//!   wraps it with `(?-u:\b)` boundaries so `web` doesn't match inside
//!   `webhook`. Any symbol / space / Japanese char suppresses the
//!   boundary (`a.b` would otherwise trigger unexpected regex meta
//!   semantics).
//! - Japanese variants receive no boundary — Phase 1 has no morphology
//!   at the project-rule level, and false positives are expected to be
//!   handled via the per-entry note field.
//!
//! ## Severity
//!
//! **Entry-level severity is authoritative** — the standard
//! `RuleConfig.severity` override is intentionally ignored here. The
//! Settings UI disables the severity dropdown for `project/*` so the
//! two sources can't drift.
//!
//! ## Codex Alias との衝突
//!
//! The engine filters the dictionary before we see it; any entry whose
//! variants collide with a Codex alias is already removed and surfaced
//! via `RuleWarning::Skipped`. This rule therefore trusts
//! `ctx.term_dictionary` to be collision-free.

use regex::Regex;

use crate::offset::utf8_to_utf16;
use crate::rule::{
    BlockKind, Diagnostic, Fix, Language, LintContext, LintInput, LintRule, Severity, TermEntry,
    Utf16Range,
};

pub struct TermConsistencyRule;

pub const RULE_ID: &str = "project/term-consistency";

struct Compiled {
    regex: Regex,
    /// Per-variant metadata — entries are keyed by the matched surface.
    /// Multiple dictionary rows may register the same surface; the
    /// first one wins (deterministic, matches `codex/name-inconsistency`
    /// behaviour).
    by_variant: std::collections::HashMap<String, VariantMeta>,
}

struct VariantMeta {
    preferred: String,
    severity: Severity,
    note: Option<String>,
}

fn build_matcher(entries: &[TermEntry]) -> Option<Compiled> {
    let mut alt_parts: Vec<String> = Vec::new();
    let mut by_variant: std::collections::HashMap<String, VariantMeta> =
        std::collections::HashMap::new();
    for entry in entries {
        for variant in &entry.variants {
            if variant.is_empty() || variant == &entry.preferred {
                continue;
            }
            if by_variant.contains_key(variant) {
                // First dictionary row wins — deduplication happens at
                // save time but two UI inputs could race; staying
                // deterministic here avoids confusing diagnostics.
                continue;
            }
            let is_ascii_word = !variant.is_empty()
                && variant
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_');
            let escaped = regex::escape(variant);
            let part = if is_ascii_word {
                format!(r"(?-u:\b){}(?-u:\b)", escaped)
            } else {
                escaped
            };
            alt_parts.push(part);
            by_variant.insert(
                variant.clone(),
                VariantMeta {
                    preferred: entry.preferred.clone(),
                    severity: entry.severity,
                    note: entry.note.clone(),
                },
            );
        }
    }
    if alt_parts.is_empty() {
        return None;
    }
    let pattern = alt_parts.join("|");
    Regex::new(&pattern)
        .ok()
        .map(|regex| Compiled { regex, by_variant })
}

impl LintRule for TermConsistencyRule {
    fn id(&self) -> &'static str {
        RULE_ID
    }

    fn default_severity(&self) -> Severity {
        // Entry-level severity wins; this value is only used when a
        // diagnostic is produced for an entry with an unexpected state.
        Severity::Warning
    }

    fn supported_languages(&self) -> &'static [Language] {
        // Project term rules apply to every scene regardless of the
        // input language — they're culture-neutral style fixes.
        &[Language::Japanese, Language::English]
    }

    fn supported_block_kinds(&self) -> &'static [BlockKind] {
        &[
            BlockKind::Paragraph,
            BlockKind::Heading,
            BlockKind::Blockquote,
            BlockKind::ListItem,
            BlockKind::TableCell,
        ]
    }

    fn check(&self, input: &LintInput, ctx: &LintContext) -> Vec<Diagnostic> {
        if ctx.term_dictionary.is_empty() {
            return Vec::new();
        }
        let Some(compiled) = build_matcher(ctx.term_dictionary) else {
            return Vec::new();
        };

        let mut out = Vec::new();
        for block in input.blocks {
            if !self.supported_block_kinds().contains(&block.kind) {
                continue;
            }
            for m in compiled.regex.find_iter(&block.text) {
                let matched = m.as_str();
                let Some(meta) = compiled.by_variant.get(matched) else {
                    continue;
                };
                let start_u16 = block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                let end_u16 = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                let range = Utf16Range {
                    start: start_u16,
                    end: end_u16,
                };
                let message = match &meta.note {
                    Some(note) if !note.trim().is_empty() => {
                        format!("「{}」→「{}」に統一（{}）", matched, meta.preferred, note)
                    }
                    _ => format!("「{}」→「{}」に統一", matched, meta.preferred),
                };
                out.push(Diagnostic {
                    rule_id: self.id().to_string(),
                    severity: meta.severity,
                    message,
                    range,
                    fix: Some(Fix {
                        label: format!("「{}」に置換", meta.preferred),
                        replacement: meta.preferred.clone(),
                        range,
                    }),
                });
            }
        }
        out
    }
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
    use crate::rule::{
        BlockKind, Diagnostic, Language, LintBlock, LintConfig, LintScope, TermEntry,
    };

    fn run(text: &str, entries: Vec<TermEntry>) -> Vec<Diagnostic> {
        let cfg = LintConfig::default();
        let blocks = vec![LintBlock {
            id: 0,
            kind: BlockKind::Paragraph,
            text: text.to_string(),
            str_offset_start: 0,
        }];
        let ctx = LintContext {
            config: &cfg,
            block_tokens: None,
            term_dictionary: &entries,
        };
        let input = LintInput {
            blocks: &blocks,
            language: Language::Japanese,
            scope: LintScope::Scene {
                scene_id: "x".into(),
            },
        };
        TermConsistencyRule.check(&input, &ctx)
    }

    fn entry(preferred: &str, variants: &[&str], severity: Severity) -> TermEntry {
        TermEntry {
            id: "t1".into(),
            preferred: preferred.into(),
            variants: variants.iter().map(|s| s.to_string()).collect(),
            severity,
            note: None,
            enabled: true,
        }
    }

    #[test]
    fn flags_variant_and_suggests_preferred() {
        let ds = run(
            "Web と web は ウェブ と書く。",
            vec![entry("ウェブ", &["Web", "web"], Severity::Warning)],
        );
        assert_eq!(ds.len(), 2, "{ds:?}");
        assert!(ds.iter().all(|d| d.fix.is_some()));
        assert!(ds[0].message.contains("ウェブ"));
    }

    #[test]
    fn ascii_variant_respects_word_boundary() {
        let ds = run(
            "webhook と web",
            vec![entry("ウェブ", &["web"], Severity::Warning)],
        );
        assert_eq!(ds.len(), 1, "{ds:?}");
    }

    #[test]
    fn disabled_entry_does_not_fire() {
        let mut e = entry("ウェブ", &["web"], Severity::Warning);
        e.enabled = false;
        // Engine does the enabled filter; when we bypass the engine
        // (rule-level test) the rule itself still sees disabled
        // entries. Simulate the engine contract by not passing them.
        let filtered: Vec<_> = vec![e].into_iter().filter(|e| e.enabled).collect();
        let ds = run("web", filtered);
        assert!(ds.is_empty());
    }

    #[test]
    fn entry_severity_wins() {
        let ds = run(
            "サーバ",
            vec![entry("サーバー", &["サーバ"], Severity::Info)],
        );
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].severity, Severity::Info);
    }

    #[test]
    fn note_is_appended_to_message() {
        let mut e = entry("ウェブ", &["web"], Severity::Warning);
        e.note = Some("企画書 §3.2".into());
        let ds = run("web", vec![e]);
        assert_eq!(ds.len(), 1);
        assert!(ds[0].message.contains("企画書"));
    }

    #[test]
    fn preferred_equals_variant_is_skipped() {
        // The CRUD layer strips these, but the matcher stays safe
        // even if one leaks through.
        let ds = run(
            "ウェブ",
            vec![entry("ウェブ", &["ウェブ"], Severity::Warning)],
        );
        assert!(ds.is_empty());
    }

    #[test]
    fn japanese_variant_matches_literally() {
        let ds = run(
            "1人の男が歩いていた。",
            vec![entry("一人", &["1人"], Severity::Warning)],
        );
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].range.start, 0);
    }

    #[test]
    fn case_sensitive() {
        // "Web" variant must not match "web".
        let ds = run(
            "web と Web",
            vec![entry("ウェブ", &["Web"], Severity::Warning)],
        );
        assert_eq!(ds.len(), 1);
    }
}
