//! Gate C2 Lane M -- pure Semantic Index "am I dirty" diagnostics.
//!
//! `policies/narrative/semantic-core-authorities.json` fixes the exact
//! metadata surface a Semantic Index is allowed to own
//! (`semanticIndexAllowedFields`):
//!
//! ```text
//! generation | builtAt | sourceDigest | dependencySetDigest | dirtyCacheFlag
//! ```
//!
//! `docs/adr/005-narrative-semantic-core-boundary.md`, "Authority matrix and
//! C2 start condition": "A Semantic Index may own only generation, build
//! timestamp, source digest, dependency-set digest, and a dirty-cache flag;
//! it may not assert that an Assertion is authoritative and fresh." This
//! module therefore never claims Freshness (`EvidenceFreshness` in
//! `evaluator.rs` is the only Freshness authority, persisted in the single
//! `narrative_consumer_freshness` table) -- it answers a narrower question a
//! Semantic Index *is* allowed to ask about itself: "does my own cached
//! generation still match what it was built from?"
//!
//! Like `evaluator.rs` (Lane F), this module contains no DB I/O. Every
//! function here is a deterministic transform from plain input to plain
//! output; the caller owns reading the stored Index metadata row, computing
//! the current dependency-set digest from a fresh Reverse Dependency Lookup
//! (`dependency_edges::find_edges_by_consumer`, Lane G), and deciding what to
//! do with the `bool` this module returns (e.g. schedule a rebuild). This
//! module never triggers a rebuild itself -- that trigger is a separate
//! caller's responsibility, out of scope for this Lane.

use sha2::Digest;

use super::dependency_edges::DependencyEdge;

/// The exact five-field metadata surface a Semantic Index may durably own,
/// per `policies/narrative/semantic-core-authorities.json`'s
/// `semanticIndexAllowedFields`. Field names mirror the contract 1:1 so this
/// struct can never silently grow a sixth field (e.g. an `is_fresh: bool`)
/// without visibly diverging from the policy file's fixed field list
/// validated by `scripts/quality/validate-semantic-core-boundary.mjs`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SemanticIndexMetadata {
    pub generation: i64,
    pub built_at: String,
    pub source_digest: String,
    pub dependency_set_digest: String,
    pub dirty_cache_flag: bool,
}

/// Deterministically decides whether a Semantic Index's cached metadata is
/// dirty relative to the dependency set it was last built from.
///
/// Dirty when either signal fires:
/// - the Index's own `dirty_cache_flag` was already set true by some earlier
///   caller (e.g. a Change Feed-driven invalidation this module does not
///   itself observe), or
/// - the dependency set the Index was built from no longer matches the
///   dependency set a fresh Reverse Dependency Lookup produces right now --
///   the caller-supplied `current_dependency_set_digest`.
///
/// This is a plain equality/OR check, not a Freshness verdict: it never
/// returns `EvidenceFreshness` and nothing here writes to
/// `narrative_consumer_freshness`. A `true` result means only "this Index's
/// own cached digest fields no longer match its current inputs", which is
/// the one self-assessment `semanticIndexAllowedFields` permits an Index to
/// make about itself.
pub(crate) fn is_semantic_index_dirty(
    index: &SemanticIndexMetadata,
    current_dependency_set_digest: &str,
) -> bool {
    index.dirty_cache_flag || index.dependency_set_digest != current_dependency_set_digest
}

/// Canonicalizes a dependency identity set into a single deterministic
/// string ahead of hashing: sort so caller-side ordering never changes the
/// digest, then length-prefix each identity (`"<len>:<identity>\n"`) so two
/// differently-split identity lists can never collide onto the same
/// concatenated bytes (e.g. `["ab", "c"]` vs `["a", "bc"]`).
fn canonical_dependency_set_string(source_object_identities: &[String]) -> String {
    let mut sorted: Vec<&str> = source_object_identities
        .iter()
        .map(String::as_str)
        .collect();
    sorted.sort_unstable();
    let mut canonical = String::new();
    for identity in sorted {
        canonical.push_str(&identity.len().to_string());
        canonical.push(':');
        canonical.push_str(identity);
        canonical.push('\n');
    }
    canonical
}

/// Computes a deterministic digest of a dependency identity set: sorts the
/// input (order-independent) and hashes the canonicalized form with
/// `sha2::Sha256`, the same digest primitive already used elsewhere in this
/// crate (`source_revision::digest_json`) and in
/// `grimodex-semantic::index::compute_content_hash`. Returns the lowercase
/// hex digest with no `sha256:` prefix -- callers that need a prefixed
/// revision token compose it themselves, the same convention
/// `source_revision.rs` follows for its own digest-shaped tokens.
pub(crate) fn compute_dependency_set_digest(source_object_identities: &[String]) -> String {
    let canonical = canonical_dependency_set_string(source_object_identities);
    hex::encode(sha2::Sha256::digest(canonical.as_bytes()))
}

/// Builds a fresh `SemanticIndexMetadata` from a Consumer's current
/// Dependency Edges (Lane G, `dependency_edges::DependencyEdge`) -- the
/// shape a caller has in hand right after a Reverse Dependency Lookup or a
/// Producer-time Edge declaration.
///
/// `dependency_set_digest` is `compute_dependency_set_digest` over every
/// Edge's `source_object_identity`. `DependencyEdge` carries no separate
/// source-content digest (only the identity and its `read_set_json`), so
/// `source_digest` is set to the same identity-set digest here: it is the
/// only source-derived signal this helper has available. A caller building
/// metadata from an actual content read (rather than from Edges alone) may
/// populate `source_digest` differently.
///
/// `dirty_cache_flag` is fixed `false`: this helper describes a just-built
/// Index, never a stale one. A later re-evaluation is what flips it `true`,
/// via a fresh call into `is_semantic_index_dirty`.
pub(crate) fn semantic_index_metadata_from_dependency_edges(
    edges: &[DependencyEdge],
    generation: i64,
    built_at: String,
) -> SemanticIndexMetadata {
    let source_object_identities: Vec<String> = edges
        .iter()
        .map(|edge| edge.source_object_identity.clone())
        .collect();
    let dependency_set_digest = compute_dependency_set_digest(&source_object_identities);
    SemanticIndexMetadata {
        generation,
        built_at,
        source_digest: dependency_set_digest.clone(),
        dependency_set_digest,
        dirty_cache_flag: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(source_object_identity: &str) -> DependencyEdge {
        DependencyEdge {
            id: format!("edge-{source_object_identity}"),
            project_id: "project-1".to_string(),
            consumer_kind: "semantic-index".to_string(),
            consumer_key: "index-1".to_string(),
            source_object_identity: source_object_identity.to_string(),
            read_set_json: r#"["/body"]"#.to_string(),
            generated_by_transaction_id: None,
            created_at: "2026-08-15T00:00:00.000Z".to_string(),
        }
    }

    fn metadata(dependency_set_digest: &str, dirty_cache_flag: bool) -> SemanticIndexMetadata {
        SemanticIndexMetadata {
            generation: 1,
            built_at: "2026-08-15T00:00:00.000Z".to_string(),
            source_digest: dependency_set_digest.to_string(),
            dependency_set_digest: dependency_set_digest.to_string(),
            dirty_cache_flag,
        }
    }

    // -- compute_dependency_set_digest ----------------------------------

    #[test]
    fn digest_is_deterministic_for_the_same_input() {
        let identities = vec![
            "project:scene:scene-1".to_string(),
            "project:scene:scene-2".to_string(),
        ];
        let first = compute_dependency_set_digest(&identities);
        let second = compute_dependency_set_digest(&identities);
        assert_eq!(first, second);
        // sha256 hex digest: 64 lowercase hex chars.
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn digest_is_order_independent_because_the_input_is_sorted_first() {
        let forward = vec![
            "project:scene:scene-1".to_string(),
            "project:scene:scene-2".to_string(),
            "project:scene:scene-3".to_string(),
        ];
        let mut shuffled = forward.clone();
        shuffled.reverse();

        assert_eq!(
            compute_dependency_set_digest(&forward),
            compute_dependency_set_digest(&shuffled)
        );
    }

    #[test]
    fn digest_differs_when_the_identity_set_actually_differs() {
        let a = vec!["project:scene:scene-1".to_string()];
        let b = vec!["project:scene:scene-2".to_string()];
        assert_ne!(
            compute_dependency_set_digest(&a),
            compute_dependency_set_digest(&b)
        );
    }

    #[test]
    fn digest_does_not_let_differently_split_identities_collide() {
        // Guards the length-prefixed canonicalization: naive concatenation
        // would make ["ab", "c"] and ["a", "bc"] hash identically.
        let split_ab_c = vec!["ab".to_string(), "c".to_string()];
        let split_a_bc = vec!["a".to_string(), "bc".to_string()];
        assert_ne!(
            compute_dependency_set_digest(&split_ab_c),
            compute_dependency_set_digest(&split_a_bc)
        );
    }

    #[test]
    fn digest_of_empty_set_is_stable() {
        let empty: Vec<String> = Vec::new();
        assert_eq!(
            compute_dependency_set_digest(&empty),
            compute_dependency_set_digest(&empty)
        );
    }

    // -- is_semantic_index_dirty -----------------------------------------

    #[test]
    fn clean_when_flag_false_and_digest_matches() {
        let index = metadata("digest-a", false);
        assert!(!is_semantic_index_dirty(&index, "digest-a"));
    }

    #[test]
    fn dirty_when_flag_is_already_true_even_if_digest_matches() {
        let index = metadata("digest-a", true);
        assert!(is_semantic_index_dirty(&index, "digest-a"));
    }

    #[test]
    fn dirty_when_digest_no_longer_matches_even_if_flag_is_false() {
        let index = metadata("digest-a", false);
        assert!(is_semantic_index_dirty(&index, "digest-b"));
    }

    #[test]
    fn dirty_when_both_flag_true_and_digest_mismatched() {
        let index = metadata("digest-a", true);
        assert!(is_semantic_index_dirty(&index, "digest-b"));
    }

    // -- semantic_index_metadata_from_dependency_edges --------------------

    #[test]
    fn built_metadata_starts_clean_with_flag_false() {
        let edges = vec![edge("project:scene:scene-1"), edge("project:scene:scene-2")];
        let built = semantic_index_metadata_from_dependency_edges(
            &edges,
            7,
            "2026-08-15T00:00:00.000Z".to_string(),
        );
        assert_eq!(built.generation, 7);
        assert_eq!(built.built_at, "2026-08-15T00:00:00.000Z");
        assert!(!built.dirty_cache_flag);
        assert_eq!(built.source_digest, built.dependency_set_digest);
    }

    #[test]
    fn built_metadata_dependency_set_digest_matches_direct_computation() {
        // Edges deliberately supplied out of sorted order.
        let edges = vec![edge("project:scene:scene-2"), edge("project:scene:scene-1")];
        let built = semantic_index_metadata_from_dependency_edges(
            &edges,
            1,
            "2026-08-15T00:00:00.000Z".to_string(),
        );
        let expected = compute_dependency_set_digest(&[
            "project:scene:scene-1".to_string(),
            "project:scene:scene-2".to_string(),
        ]);
        assert_eq!(built.dependency_set_digest, expected);
    }

    #[test]
    fn built_metadata_is_immediately_clean_against_its_own_current_digest() {
        let edges = vec![edge("project:scene:scene-1")];
        let built = semantic_index_metadata_from_dependency_edges(
            &edges,
            1,
            "2026-08-15T00:00:00.000Z".to_string(),
        );
        let current_digest = compute_dependency_set_digest(&["project:scene:scene-1".to_string()]);
        assert!(!is_semantic_index_dirty(&built, &current_digest));
    }

    #[test]
    fn built_metadata_becomes_dirty_once_the_dependency_set_changes() {
        let edges = vec![edge("project:scene:scene-1")];
        let built = semantic_index_metadata_from_dependency_edges(
            &edges,
            1,
            "2026-08-15T00:00:00.000Z".to_string(),
        );
        // A new Edge appears (Consumer now also reads scene-2): the current
        // dependency set digest moves, so the previously built metadata now
        // reads dirty.
        let current_digest = compute_dependency_set_digest(&[
            "project:scene:scene-1".to_string(),
            "project:scene:scene-2".to_string(),
        ]);
        assert!(is_semantic_index_dirty(&built, &current_digest));
    }
}
