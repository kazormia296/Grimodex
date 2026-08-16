//! Gate C2 Lane F -- pure Dependency Edge Freshness evaluator.
//!
//! This module contains no DB I/O. It is a deterministic function from a
//! plain input struct (comparison signals about one Dependency Edge's
//! Source) to a plain output struct (`EvidenceFreshness` / `FindingReasonCode`
//! / `BuildAction`). Callers own reading the stored Edge State row, computing
//! the comparison signals, and writing the result back into
//! `narrative_dependency_edge_states` / `narrative_consumer_freshness` --
//! none of that happens here.
//!
//! Maintenance Attention (`narrative_maintenance_attention`, ADR 005's
//! durable, non-epoch-bound, no-backflow user state) is out of scope for
//! this evaluator: it is not read as an input and it is never derived as an
//! output. Only the three orthogonal Build Graph axes ratified in
//! `docs/adr/005-narrative-semantic-core-boundary.md`'s "Amendment -- Gate
//! C1.5 Semantic Contract Ratification" / "Orthogonal state vocabulary" are
//! produced here.
//!
//! Enum values mirror two things byte-for-byte and must be kept in lock step
//! with both:
//!
//! - the `evidence_freshness` / `build_action` CHECK constraints on
//!   `narrative_dependency_edge_states` and `narrative_consumer_freshness`
//!   (SCHEMA_VERSION 23, `grimodex-db::migrate`);
//! - the `reasonCodes` registry in
//!   `policies/narrative/narrative-finding-contract.json` (fail-closed on
//!   unknown, per that contract's `unknownReasonCodePolicy`).

use serde::{Deserialize, Serialize};

/// Evidence Freshness axis. ADR 005 Amendment, "Orthogonal state vocabulary":
/// `fresh | stale | source-missing | anchor-mismatch | read-set-drift | unknown`.
/// This is a Consumer/Edge *state*, never a truth value -- `fresh` is not
/// `accepted`, and `stale` is not retracted.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceFreshness {
    Fresh,
    Stale,
    SourceMissing,
    AnchorMismatch,
    ReadSetDrift,
    Unknown,
}

impl EvidenceFreshness {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Stale => "stale",
            Self::SourceMissing => "source-missing",
            Self::AnchorMismatch => "anchor-mismatch",
            Self::ReadSetDrift => "read-set-drift",
            Self::Unknown => "unknown",
        }
    }
}

impl TryFrom<&str> for EvidenceFreshness {
    type Error = anyhow::Error;

    fn try_from(value: &str) -> anyhow::Result<Self> {
        match value {
            "fresh" => Ok(Self::Fresh),
            "stale" => Ok(Self::Stale),
            "source-missing" => Ok(Self::SourceMissing),
            "anchor-mismatch" => Ok(Self::AnchorMismatch),
            "read-set-drift" => Ok(Self::ReadSetDrift),
            "unknown" => Ok(Self::Unknown),
            other => Err(anyhow::anyhow!(
                "NEX_EVIDENCE_FRESHNESS_INVALID: unknown evidence freshness '{other}'"
            )),
        }
    }
}

/// Build Action axis. ADR 005 Amendment: `none | revalidate-exact |
/// reanchor-candidate | resolve-only | recompile-only | rebuild-required |
/// refresh-available | manual`. This is a downstream work description, not a
/// Freshness or Review state -- it must never be merged into the same
/// column or enum as `EvidenceFreshness`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuildAction {
    None,
    RevalidateExact,
    ReanchorCandidate,
    ResolveOnly,
    RecompileOnly,
    RebuildRequired,
    RefreshAvailable,
    Manual,
}

impl BuildAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::RevalidateExact => "revalidate-exact",
            Self::ReanchorCandidate => "reanchor-candidate",
            Self::ResolveOnly => "resolve-only",
            Self::RecompileOnly => "recompile-only",
            Self::RebuildRequired => "rebuild-required",
            Self::RefreshAvailable => "refresh-available",
            Self::Manual => "manual",
        }
    }
}

impl TryFrom<&str> for BuildAction {
    type Error = anyhow::Error;

    fn try_from(value: &str) -> anyhow::Result<Self> {
        match value {
            "none" => Ok(Self::None),
            "revalidate-exact" => Ok(Self::RevalidateExact),
            "reanchor-candidate" => Ok(Self::ReanchorCandidate),
            "resolve-only" => Ok(Self::ResolveOnly),
            "recompile-only" => Ok(Self::RecompileOnly),
            "rebuild-required" => Ok(Self::RebuildRequired),
            "refresh-available" => Ok(Self::RefreshAvailable),
            "manual" => Ok(Self::Manual),
            other => Err(anyhow::anyhow!(
                "NEX_BUILD_ACTION_INVALID: unknown build action '{other}'"
            )),
        }
    }
}

/// Finding reason code registry, `policies/narrative/narrative-finding-contract.json`
/// `reasonCodes` (11 values, `unknownReasonCodePolicy: fail-closed`). Not
/// every reason code is reachable from this evaluator alone (e.g.
/// `evidence-overlap` / `context-overlap` / `quote-not-found` /
/// `quote-ambiguous` / `target-modified` describe anchor-level comparisons a
/// future Reanchor evaluator produces); the full 11-value set is defined
/// here so a `reason_code` column typed against this enum can hold any
/// registry value without a second, drifting definition.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FindingReasonCode {
    SourceRevisionChanged,
    SourceMissing,
    EvidenceOverlap,
    ContextOverlap,
    ExactContentRelocated,
    QuoteNotFound,
    QuoteAmbiguous,
    ReadSetDrift,
    NormalizerIncompatible,
    ComponentIncompatible,
    TargetModified,
}

impl FindingReasonCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SourceRevisionChanged => "source-revision-changed",
            Self::SourceMissing => "source-missing",
            Self::EvidenceOverlap => "evidence-overlap",
            Self::ContextOverlap => "context-overlap",
            Self::ExactContentRelocated => "exact-content-relocated",
            Self::QuoteNotFound => "quote-not-found",
            Self::QuoteAmbiguous => "quote-ambiguous",
            Self::ReadSetDrift => "read-set-drift",
            Self::NormalizerIncompatible => "normalizer-incompatible",
            Self::ComponentIncompatible => "component-incompatible",
            Self::TargetModified => "target-modified",
        }
    }
}

impl TryFrom<&str> for FindingReasonCode {
    type Error = anyhow::Error;

    fn try_from(value: &str) -> anyhow::Result<Self> {
        match value {
            "source-revision-changed" => Ok(Self::SourceRevisionChanged),
            "source-missing" => Ok(Self::SourceMissing),
            "evidence-overlap" => Ok(Self::EvidenceOverlap),
            "context-overlap" => Ok(Self::ContextOverlap),
            "exact-content-relocated" => Ok(Self::ExactContentRelocated),
            "quote-not-found" => Ok(Self::QuoteNotFound),
            "quote-ambiguous" => Ok(Self::QuoteAmbiguous),
            "read-set-drift" => Ok(Self::ReadSetDrift),
            "normalizer-incompatible" => Ok(Self::NormalizerIncompatible),
            "component-incompatible" => Ok(Self::ComponentIncompatible),
            "target-modified" => Ok(Self::TargetModified),
            other => Err(anyhow::anyhow!(
                "NEX_FINDING_REASON_CODE_INVALID: unknown reason code '{other}'"
            )),
        }
    }
}

/// One evaluated Dependency Edge outcome: the three orthogonal axes this
/// module is allowed to produce. `reason_code` is `None` exactly when the
/// Edge is Fresh with an unchanged revision token -- a Finding row is only
/// worth recording when there is something to explain.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EdgeObservation {
    pub freshness: EvidenceFreshness,
    pub reason_code: Option<FindingReasonCode>,
    pub build_action: BuildAction,
}

/// Plain comparison signals for one Dependency Edge, gathered by the caller
/// from the stored Edge row and a fresh read of the current Source. No field
/// here is DB-shaped (no connection, no row id): everything the evaluator
/// needs is already resolved into values.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EdgeComparisonInput {
    /// Revision token recorded on the Edge the last time it was evaluated
    /// Fresh (or first declared). `None` when the Edge has never observed a
    /// stored token (e.g. brand-new Edge with only a digest baseline).
    pub stored_revision_token: Option<String>,
    /// Revision token read from the Source right now. `None` when the
    /// current Source exposes no revision token (some Source kinds only
    /// expose a digest).
    pub current_revision_token: Option<String>,
    /// Content digest recorded on the Edge at last Fresh evaluation.
    pub stored_digest: Option<String>,
    /// Content digest read from the Source right now.
    pub current_digest: Option<String>,
    /// Whether the current Source resolves at all (a deleted Scene, a
    /// deleted Codex field, a removed Import Package member, ...).
    pub current_source_exists: bool,
    /// Whether the Consumer's declared Read Set still overlaps the current
    /// Source's addressable range/identity. `false` reads as drift in what
    /// the Consumer actually depends on, not a plain content edit.
    pub read_set_overlaps: bool,
    /// Whether the text normalizer version the stored comparison basis was
    /// computed under still matches the current normalizer version.
    pub normalizer_version_matches: bool,
    /// Whether the interpreting component (Extractor/Model/Parser) version
    /// recorded on the Edge still matches the current component version.
    pub component_version_matches: bool,
}

impl Default for EdgeComparisonInput {
    /// A source that exists, is normalizer/component-compatible, and whose
    /// Read Set overlaps -- i.e. every non-token/digest signal reads
    /// "healthy". Tests build the token/digest scenario they want on top of
    /// this baseline instead of restating all eight fields every time.
    fn default() -> Self {
        Self {
            stored_revision_token: None,
            current_revision_token: None,
            stored_digest: None,
            current_digest: None,
            current_source_exists: true,
            read_set_overlaps: true,
            normalizer_version_matches: true,
            component_version_matches: true,
        }
    }
}

/// `Some(a) == Some(b)` only when both sides are present and equal. Absence
/// on either side is never treated as a match: an Edge with no stored
/// baseline yet (or a Source with no current token/digest) must fall
/// through to the drift/stale branches below rather than being assumed
/// Fresh by default.
fn matches_when_both_present(stored: &Option<String>, current: &Option<String>) -> bool {
    matches!((stored, current), (Some(a), Some(b)) if a == b)
}

/// Deterministically evaluate one Dependency Edge's Freshness, reason, and
/// Build Action from plain comparison signals. No DB I/O, no Attention.
///
/// Branch order is itself a design decision (ADR 005 fixes the six
/// Freshness values and eight Build Actions, not their precedence), documented
/// inline at each branch:
pub fn evaluate_edge(input: &EdgeComparisonInput) -> EdgeObservation {
    // 1. A Source that no longer resolves at all is not "changed", it is
    //    unrecoverable without a human decision: there is nothing left to
    //    diff, reanchor against, or recompile from, so this must win over
    //    every other signal (a normalizer or component mismatch on a
    //    since-deleted Source is moot).
    if !input.current_source_exists {
        return EdgeObservation {
            freshness: EvidenceFreshness::SourceMissing,
            reason_code: Some(FindingReasonCode::SourceMissing),
            build_action: BuildAction::Manual,
        };
    }

    // 2. A normalizer version mismatch means the stored revision
    //    token/digest were computed under a different text normalization
    //    rule than the one used to read the Source just now. Comparing them
    //    would be an apples-to-oranges byte comparison, so Freshness must be
    //    Unknown (not Fresh, not Stale) until the Consumer is recompiled
    //    under the current normalizer. This is checked before the component
    //    check because a normalizer mismatch invalidates the *comparison
    //    basis itself*, independent of which component produced it.
    if !input.normalizer_version_matches {
        return EdgeObservation {
            freshness: EvidenceFreshness::Unknown,
            reason_code: Some(FindingReasonCode::NormalizerIncompatible),
            build_action: BuildAction::RecompileOnly,
        };
    }

    // 3. A component (Extractor/Model/Parser) version mismatch does not by
    //    itself mean the Source changed (ADR 005: component compatibility is
    //    a separate axis from Freshness truth -- a new component version
    //    existing does not invalidate prior Accepted data). But it does mean
    //    an automatic content compare cannot certify Freshness under the
    //    *current* component, so Freshness is Unknown and the corrective
    //    action is the cheaper ResolveOnly (re-resolve identity/compat
    //    metadata) rather than RecompileOnly, since no normalizer-level
    //    re-read is required.
    if !input.component_version_matches {
        return EdgeObservation {
            freshness: EvidenceFreshness::Unknown,
            reason_code: Some(FindingReasonCode::ComponentIncompatible),
            build_action: BuildAction::ResolveOnly,
        };
    }

    let revision_token_matches =
        matches_when_both_present(&input.stored_revision_token, &input.current_revision_token);
    let digest_matches = matches_when_both_present(&input.stored_digest, &input.current_digest);

    // 4. An unchanged revision token, present on both sides, is the
    //    cheapest and strongest Freshness signal available: the Source's
    //    own version marker did not move, so there is nothing to
    //    reconcile and no Finding worth recording (`reason_code: None`).
    if revision_token_matches {
        return EdgeObservation {
            freshness: EvidenceFreshness::Fresh,
            reason_code: None,
            build_action: BuildAction::None,
        };
    }

    // 5. The revision token moved but the content digest, present on both
    //    sides, did not: a harmless revision bump (metadata-only save,
    //    relocation, re-serialization) over byte-identical content.
    //    Evidence is still Fresh, but the Edge's stored token is now
    //    outdated, so this is surfaced as a Finding
    //    (`exact-content-relocated`) with a cheap RevalidateExact action to
    //    adopt the new token -- never a full Rebuild for unchanged content.
    if digest_matches {
        return EdgeObservation {
            freshness: EvidenceFreshness::Fresh,
            reason_code: Some(FindingReasonCode::ExactContentRelocated),
            build_action: BuildAction::RevalidateExact,
        };
    }

    // 6. Token and digest both failed to match (including "never observed
    //    on one side", e.g. a brand-new Edge's first evaluation), and the
    //    Consumer's Read Set no longer overlaps the current Source at all.
    //    This reads as drift in *what the Consumer depends on* (its anchor
    //    or read range moved out from under it) rather than a plain content
    //    edit, so it gets its own Freshness value and the cheaper Reanchor
    //    action instead of a full content Rebuild.
    if !input.read_set_overlaps {
        return EdgeObservation {
            freshness: EvidenceFreshness::ReadSetDrift,
            reason_code: Some(FindingReasonCode::ReadSetDrift),
            build_action: BuildAction::ReanchorCandidate,
        };
    }

    // 7. Default case: token and digest both failed to match and the Read
    //    Set still overlaps the Source. This is the ordinary "the Source
    //    materially changed under the Consumer" case with no cheaper
    //    recovery path available, so Freshness is Stale and the Build
    //    Action is a full RebuildRequired.
    EdgeObservation {
        freshness: EvidenceFreshness::Stale,
        reason_code: Some(FindingReasonCode::SourceRevisionChanged),
        build_action: BuildAction::RebuildRequired,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "Everything healthy, token and digest both unchanged" baseline.
    /// Individual tests override only the fields their branch cares about.
    fn base_input() -> EdgeComparisonInput {
        EdgeComparisonInput {
            stored_revision_token: Some("rev-1".to_string()),
            current_revision_token: Some("rev-1".to_string()),
            stored_digest: Some("digest-1".to_string()),
            current_digest: Some("digest-1".to_string()),
            ..EdgeComparisonInput::default()
        }
    }

    // Branch 1: source missing wins over every other broken signal.
    #[test]
    fn source_missing_wins_over_every_other_broken_signal() {
        let input = EdgeComparisonInput {
            current_source_exists: false,
            normalizer_version_matches: false,
            component_version_matches: false,
            read_set_overlaps: false,
            ..base_input()
        };
        let observation = evaluate_edge(&input);
        assert_eq!(
            observation,
            EdgeObservation {
                freshness: EvidenceFreshness::SourceMissing,
                reason_code: Some(FindingReasonCode::SourceMissing),
                build_action: BuildAction::Manual,
            }
        );
    }

    // Branch 1 again, isolated: source missing overrides what would
    // otherwise be an exact Fresh token match, proving priority order (not
    // just "no other signal is broken").
    #[test]
    fn source_missing_overrides_a_would_be_fresh_token_match() {
        let input = EdgeComparisonInput {
            current_source_exists: false,
            ..base_input()
        };
        let observation = evaluate_edge(&input);
        assert_eq!(observation.freshness, EvidenceFreshness::SourceMissing);
        assert_eq!(
            observation.reason_code,
            Some(FindingReasonCode::SourceMissing)
        );
        assert_eq!(observation.build_action, BuildAction::Manual);
    }

    // Branch 2: normalizer mismatch forces Unknown/RecompileOnly, and takes
    // priority over a simultaneous component mismatch.
    #[test]
    fn normalizer_mismatch_forces_unknown_recompile_only_over_component_mismatch() {
        let input = EdgeComparisonInput {
            normalizer_version_matches: false,
            component_version_matches: false,
            ..base_input()
        };
        let observation = evaluate_edge(&input);
        assert_eq!(
            observation,
            EdgeObservation {
                freshness: EvidenceFreshness::Unknown,
                reason_code: Some(FindingReasonCode::NormalizerIncompatible),
                build_action: BuildAction::RecompileOnly,
            }
        );
    }

    // Branch 3: component mismatch alone forces Unknown/ResolveOnly.
    #[test]
    fn component_mismatch_forces_unknown_resolve_only() {
        let input = EdgeComparisonInput {
            component_version_matches: false,
            ..base_input()
        };
        let observation = evaluate_edge(&input);
        assert_eq!(
            observation,
            EdgeObservation {
                freshness: EvidenceFreshness::Unknown,
                reason_code: Some(FindingReasonCode::ComponentIncompatible),
                build_action: BuildAction::ResolveOnly,
            }
        );
    }

    // Branch 4: matching revision token short-circuits to Fresh with no
    // Finding at all.
    #[test]
    fn matching_revision_token_short_circuits_fresh_with_no_reason_code() {
        let observation = evaluate_edge(&base_input());
        assert_eq!(
            observation,
            EdgeObservation {
                freshness: EvidenceFreshness::Fresh,
                reason_code: None,
                build_action: BuildAction::None,
            }
        );
    }

    // Branch 5: token changed but digest is byte-identical -- harmless
    // relocation, still Fresh, but surfaced for token adoption.
    #[test]
    fn token_changed_but_digest_unchanged_is_exact_content_relocated() {
        let input = EdgeComparisonInput {
            current_revision_token: Some("rev-2".to_string()),
            ..base_input()
        };
        let observation = evaluate_edge(&input);
        assert_eq!(
            observation,
            EdgeObservation {
                freshness: EvidenceFreshness::Fresh,
                reason_code: Some(FindingReasonCode::ExactContentRelocated),
                build_action: BuildAction::RevalidateExact,
            }
        );
    }

    // Branch 6: token and digest both changed, and the Read Set no longer
    // overlaps -- Read Set drift, not a plain content edit.
    #[test]
    fn token_and_digest_changed_with_no_read_set_overlap_is_read_set_drift() {
        let input = EdgeComparisonInput {
            current_revision_token: Some("rev-2".to_string()),
            current_digest: Some("digest-2".to_string()),
            read_set_overlaps: false,
            ..base_input()
        };
        let observation = evaluate_edge(&input);
        assert_eq!(
            observation,
            EdgeObservation {
                freshness: EvidenceFreshness::ReadSetDrift,
                reason_code: Some(FindingReasonCode::ReadSetDrift),
                build_action: BuildAction::ReanchorCandidate,
            }
        );
    }

    // Branch 7: token and digest both changed, Read Set still overlaps --
    // ordinary Stale/RebuildRequired.
    #[test]
    fn token_and_digest_changed_with_overlapping_read_set_is_stale() {
        let input = EdgeComparisonInput {
            current_revision_token: Some("rev-2".to_string()),
            current_digest: Some("digest-2".to_string()),
            read_set_overlaps: true,
            ..base_input()
        };
        let observation = evaluate_edge(&input);
        assert_eq!(
            observation,
            EdgeObservation {
                freshness: EvidenceFreshness::Stale,
                reason_code: Some(FindingReasonCode::SourceRevisionChanged),
                build_action: BuildAction::RebuildRequired,
            }
        );
    }

    // Edge case guarding `matches_when_both_present`: a brand-new Edge with
    // no stored token/digest yet must not be treated as a Fresh match just
    // because one side is absent. It falls through to the ordinary
    // token/digest-changed branches (here: Stale, since Read Set overlaps).
    #[test]
    fn missing_stored_baseline_on_first_observation_does_not_default_to_fresh() {
        let input = EdgeComparisonInput {
            stored_revision_token: None,
            current_revision_token: Some("rev-1".to_string()),
            stored_digest: None,
            current_digest: Some("digest-1".to_string()),
            ..EdgeComparisonInput::default()
        };
        let observation = evaluate_edge(&input);
        assert_eq!(
            observation,
            EdgeObservation {
                freshness: EvidenceFreshness::Stale,
                reason_code: Some(FindingReasonCode::SourceRevisionChanged),
                build_action: BuildAction::RebuildRequired,
            }
        );
    }

    // as_str() must match the CHECK constraint literals in migrate.rs
    // (SCHEMA_VERSION 23) and the reasonCodes registry in
    // policies/narrative/narrative-finding-contract.json byte-for-byte,
    // since these strings are what actually gets persisted.
    #[test]
    fn as_str_matches_the_check_constraint_and_registry_literals() {
        assert_eq!(EvidenceFreshness::Fresh.as_str(), "fresh");
        assert_eq!(EvidenceFreshness::Stale.as_str(), "stale");
        assert_eq!(EvidenceFreshness::SourceMissing.as_str(), "source-missing");
        assert_eq!(
            EvidenceFreshness::AnchorMismatch.as_str(),
            "anchor-mismatch"
        );
        assert_eq!(EvidenceFreshness::ReadSetDrift.as_str(), "read-set-drift");
        assert_eq!(EvidenceFreshness::Unknown.as_str(), "unknown");

        assert_eq!(BuildAction::None.as_str(), "none");
        assert_eq!(BuildAction::RevalidateExact.as_str(), "revalidate-exact");
        assert_eq!(
            BuildAction::ReanchorCandidate.as_str(),
            "reanchor-candidate"
        );
        assert_eq!(BuildAction::ResolveOnly.as_str(), "resolve-only");
        assert_eq!(BuildAction::RecompileOnly.as_str(), "recompile-only");
        assert_eq!(BuildAction::RebuildRequired.as_str(), "rebuild-required");
        assert_eq!(BuildAction::RefreshAvailable.as_str(), "refresh-available");
        assert_eq!(BuildAction::Manual.as_str(), "manual");

        assert_eq!(
            FindingReasonCode::SourceRevisionChanged.as_str(),
            "source-revision-changed"
        );
        assert_eq!(FindingReasonCode::SourceMissing.as_str(), "source-missing");
        assert_eq!(
            FindingReasonCode::EvidenceOverlap.as_str(),
            "evidence-overlap"
        );
        assert_eq!(
            FindingReasonCode::ContextOverlap.as_str(),
            "context-overlap"
        );
        assert_eq!(
            FindingReasonCode::ExactContentRelocated.as_str(),
            "exact-content-relocated"
        );
        assert_eq!(FindingReasonCode::QuoteNotFound.as_str(), "quote-not-found");
        assert_eq!(
            FindingReasonCode::QuoteAmbiguous.as_str(),
            "quote-ambiguous"
        );
        assert_eq!(FindingReasonCode::ReadSetDrift.as_str(), "read-set-drift");
        assert_eq!(
            FindingReasonCode::NormalizerIncompatible.as_str(),
            "normalizer-incompatible"
        );
        assert_eq!(
            FindingReasonCode::ComponentIncompatible.as_str(),
            "component-incompatible"
        );
        assert_eq!(
            FindingReasonCode::TargetModified.as_str(),
            "target-modified"
        );
    }
}
