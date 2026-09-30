//! Consumer identity (Gate C2-2 foundation): the one place that owns what a
//! `(consumer_kind, consumer_key)` pair means.
//!
//! `narrative_dependency_edges` and `narrative_consumer_freshness` identify a
//! Consumer by those two columns and nothing else -- there is no `run_id`
//! column, no foreign key, and the `CHECK` constraints only require
//! non-empty strings. Every semantic rule about the pair therefore has to
//! live in code, and before this module it lived in four different places
//! that could drift apart independently:
//!
//! - the `RUN_CONSUMER_KIND` literal (`dependency_edges.rs`),
//! - `publish_runtime.rs`'s `consumer_finding_key`,
//! - `inbox_read_model.rs`'s *separate copy* of `consumer_finding_key`,
//! - `restore_rebuild.rs`'s two unnamed `consumer_key`-is-a-`run_id` casts.
//!
//! The last of those is the reason this module exists rather than a pair of
//! free functions. Historically every Edge was declared under
//! `(RUN_CONSUMER_KIND, run_id)`, so passing `consumer_key` where a
//! `run_id` is wanted was accidentally correct. Proposal Revision and
//! Application Consumers now use their own durable keys; their Edge-level
//! `owning_run_id` is the explicit provenance for Source evaluation. The
//! dangerous failure mode remains the same: `source_revision::resolve_snapshot_document`
//! requires a `snapshot:<runId>` Source's key to equal the `run_id` it is
//! handed, and `restore_rebuild::build_edge_comparison_input` turns *every*
//! resolver error into `current_source_exists = false`. A Consumer key that
//! is no longer a Run id must therefore never be guessed as one, or the
//! Maintenance Inbox would show a plausible, entirely fabricated problem.
//!
//! So [`owning_run_id_for_consumer`] is the single seam, and it returns
//! `Option`: callers must decide what to do when a Consumer has no owning
//! Run instead of inheriting a wrong answer by construction. Both current
//! callers fail closed and say so. At C2-ZB, Application Consumers are
//! declared/evaluable, but their Edge-level `owning_run_id` remains the
//! required provenance for Source evaluation.
//!
//! The vocabulary itself is ratified in
//! `policies/narrative/narrative-consumer-contract.json`. That contract also
//! lists Consumer kinds this crate does *not* implement yet (Gate C2-2's
//! remaining classes); [`ConsumerKind`] deliberately carries only the kinds
//! the deterministic core can actually reason about today, so a variant here
//! is a promise backed by code rather than by a plan.

/// The Dependency Edge Consumer identity a Run's own declared Edges are
/// stored under: `consumer_kind = RUN_CONSUMER_KIND`, `consumer_key =
/// run_id`.
///
/// Moved here from `dependency_edges` (its original home) with the rest of
/// the Consumer vocabulary, and re-exported from there so the ~40 existing
/// `use super::dependency_edges::RUN_CONSUMER_KIND` call sites did not have
/// to churn. `migrate.rs` keeps a frozen SCHEMA 28 copy of this literal
/// pinned against this constant by
/// `run_consumer_kind_v28_matches_the_live_constant`; the value must not
/// change without revisiting that migration.
pub(crate) const RUN_CONSUMER_KIND: &str = ConsumerKind::Run.as_str();

/// The Consumer identity a Proposal Revision's own declared Edges are stored
/// under: `consumer_key = narrative_proposal_revisions.id`.
pub(crate) const PROPOSAL_REVISION_CONSUMER_KIND: &str = ConsumerKind::ProposalRevision.as_str();

/// The Consumer identity of one applied Projection. Its durable key is the
/// `narrative_proposal_applications.id`; the Run that declared an Edge is
/// carried separately in `narrative_dependency_edges.owning_run_id`.
pub(crate) const APPLICATION_CONSUMER_KIND: &str = ConsumerKind::Application.as_str();

/// The Semantic Index owns its metadata/D1/V1 surface and is not a Generic
/// Freshness Consumer. Keep the exact reserved literal here so every
/// production writer applies the same narrow guard without changing the
/// compatibility behavior for other unknown or forward-version kinds.
pub(crate) const RESERVED_SEMANTIC_INDEX_CONSUMER_KIND: &str = "semantic-index";

pub(crate) fn is_reserved_semantic_index_consumer_kind(consumer_kind: &str) -> bool {
    consumer_kind == RESERVED_SEMANTIC_INDEX_CONSUMER_KIND
}

/// The Consumer kinds this crate declares and reads today.
///
/// A variant here is a promise backed by code: something writes it, and
/// something can evaluate, publish and resolve a Source for it. Application
/// is declared/evaluable at C2-ZB; its owning Run is Edge provenance rather
/// than part of the Consumer identity. The remaining reserved kinds stay
/// absent until they have a complete evaluator path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConsumerKind {
    /// One Narrative Extraction Run. `consumer_key` is
    /// `narrative_extraction_runs.id`.
    ///
    /// Still declared after the Proposal Revision re-key, and not a legacy
    /// value: a Run remains a legitimate Consumer of its own Run-wide
    /// Sources. C2-ZB's Legacy Backfill writer uses Application Consumers
    /// instead, because its durable projection dependency belongs to the
    /// applied Application while the fresh Backfill Run supplies Edge owner
    /// provenance.
    Run,
    /// One immutable Revision of one Proposal. `consumer_key` is
    /// `narrative_proposal_revisions.id`.
    ///
    /// The grain Gate C2-2 exists to reach: editing one Scene stales the
    /// Revisions that actually read it, instead of every Proposal the same
    /// Run produced.
    ProposalRevision,
    /// One applied Projection. `consumer_key` is
    /// `narrative_proposal_applications.id`; unlike a Run Consumer, the key
    /// does not itself name the Run that declared its Edges.
    Application,
}

impl ConsumerKind {
    /// `const` so [`RUN_CONSUMER_KIND`] can be defined *from* it. That
    /// direction matters: it makes the enum the single source of the
    /// persisted literal, rather than a second place that has to be kept
    /// agreeing with a free-standing constant.
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Run => "narrative-extraction-run",
            Self::ProposalRevision => "proposal-revision",
            Self::Application => "application",
        }
    }
}

impl TryFrom<&str> for ConsumerKind {
    type Error = anyhow::Error;

    /// Fail closed on anything outside the declared vocabulary, matching
    /// `evaluator.rs`'s `EvidenceFreshness`/`BuildAction`/`FindingReasonCode`
    /// conversions. A stored row under a reserved-but-unimplemented kind is
    /// a real possibility (a newer build wrote it, then the workspace was
    /// opened by an older one), and guessing at it is worse than refusing.
    fn try_from(value: &str) -> anyhow::Result<Self> {
        match value {
            RUN_CONSUMER_KIND => Ok(Self::Run),
            PROPOSAL_REVISION_CONSUMER_KIND => Ok(Self::ProposalRevision),
            APPLICATION_CONSUMER_KIND => Ok(Self::Application),
            other => Err(anyhow::anyhow!(
                "NEX_CONSUMER_KIND_INVALID: unknown consumer kind '{other}'"
            )),
        }
    }
}

/// The `finding_key` separator. `narrative-consumer-contract.json` fixes
/// `finding_key` as `"{consumerKind}:{consumerKey}"`, forbids `:` in a
/// `consumer_kind`, and permits it in a `consumer_key` -- so the pair is
/// recoverable by splitting on the *first* separator and only the first.
/// A `consumer_key` is a durable identity and may be a compound one; the
/// contract's own negative fixture is the `semantic-index` key
/// `embeddings:v2`, which last-colon parsing would mis-split into the
/// unregistered kind `semantic-index:embeddings`. A `consumer_kind` never
/// needs an inner colon, which is what makes the first one unambiguous.
const FINDING_KEY_SEPARATOR: char = ':';

/// Rejects a `(consumer_kind, consumer_key)` pair that cannot round-trip
/// through a `finding_key`.
///
/// Called by the typed writers rather than left to the table's `CHECK`
/// constraints: SQLite can enforce `length(consumer_kind) > 0`, but it
/// cannot express "and it must not contain the character the Attention key
/// is split on". Without this, a `consumer_kind` of `"a:b"` would produce
/// the same `finding_key` as `("a", "b:...")` and two unrelated Consumers
/// would share one human disposition row.
pub(crate) fn validate_consumer_identity(
    consumer_kind: &str,
    consumer_key: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !consumer_kind.trim().is_empty(),
        "NEX_CONSUMER_KIND_INVALID: consumerKind is required"
    );
    anyhow::ensure!(
        !consumer_key.trim().is_empty(),
        "NEX_CONSUMER_KEY_INVALID: consumerKey is required"
    );
    anyhow::ensure!(
        consumer_kind.trim() == consumer_kind,
        "NEX_CONSUMER_KIND_INVALID: consumerKind must not have leading or trailing whitespace"
    );
    anyhow::ensure!(
        consumer_key.trim() == consumer_key,
        "NEX_CONSUMER_KEY_INVALID: consumerKey must not have leading or trailing whitespace"
    );
    anyhow::ensure!(
        !consumer_kind.contains(FINDING_KEY_SEPARATOR),
        "NEX_CONSUMER_KIND_INVALID: consumerKind must not contain '{FINDING_KEY_SEPARATOR}' \
         (finding_key is parsed by splitting on the first separator)"
    );
    Ok(())
}

/// The Consumer-grained Attention / Finding key.
///
/// **This is the only implementation.** An earlier revision had one copy in
/// `publish_runtime.rs` (which at one point keyed per-Edge as
/// `edge:{edge_id}`) and a second in `inbox_read_model.rs` (which keyed
/// `{consumer_kind}:{consumer_key}`), and the disagreement made every
/// diagnostic Finding Observation invisible to the Maintenance Inbox --
/// caught only by a cross-Lane adversarial test, because neither side
/// errors when the other side's rows simply fail to match. Both modules now
/// call this function.
///
/// The grain is the Consumer, not the Edge, because the Inbox is what a
/// human acts on: a person snoozes or dismisses "this Consumer's freshness
/// problem", never an individual internal Dependency Edge they never see.
/// Per-Edge attribution is still recorded in
/// `narrative_maintenance_finding_observations.edge_id`; it is de-emphasised
/// as the lookup key, not lost.
///
/// A third implementation exists as raw SQL in `migrate.rs`
/// (`?2 || ':' || ?3`, SCHEMA 28's `invalidate_derived_freshness_for_consumers_v28`).
/// It cannot import this function -- migrations run against schemas older
/// than the code around them and must stay frozen -- so it is pinned to this
/// convention by test instead (`finding_key_convention_matches_the_v28_migration_sql`).
pub(crate) fn consumer_finding_key(consumer_kind: &str, consumer_key: &str) -> String {
    format!("{consumer_kind}{FINDING_KEY_SEPARATOR}{consumer_key}")
}

/// Recovers `(consumer_kind, consumer_key)` from a `finding_key`.
///
/// Splits on the *first* separator only, per
/// `narrative-consumer-contract.json`'s `findingKeyParseRule`. Returns
/// `None` for a key with no separator at all, which is not a shape any
/// writer in this crate produces.
#[allow(dead_code)]
pub(crate) fn parse_finding_key(finding_key: &str) -> Option<(&str, &str)> {
    finding_key.split_once(FINDING_KEY_SEPARATOR)
}

/// Whether `consumer_kind` names a Consumer class this build implements.
///
/// Separate from [`owning_run_id_for_consumer`] because they answer different
/// questions and, since the Proposal Revision re-key, have different answers:
/// a `proposal-revision` Consumer is fully evaluable and has no Run id in its
/// key. Collapsing the two would skip every Revision Consumer.
pub(crate) fn is_declared_consumer_kind(consumer_kind: &str) -> bool {
    ConsumerKind::try_from(consumer_kind).is_ok()
}

/// The Run this Consumer's key names, when the key *is* a Run id.
///
/// The compatibility half of the "which Run is this Edge's `snapshot:<runId>`
/// Source expected to name?" question. Since SCHEMA 30 the primary answer is
/// `narrative_dependency_edges.owning_run_id`, recorded by the Producer that
/// declared the Edge; this is what `restore_rebuild` falls back to for a row
/// written before that column existed and never re-declared since.
///
/// It stays a function rather than being deleted because it is also the
/// vocabulary check: an unrecognised `consumer_kind` returns `None`, and the
/// callers report that Consumer rather than evaluating it.
///
/// `ProposalRevision` returns `None` deliberately -- its key is a Revision
/// id, and a Revision id is not a Run id. Returning the key here would
/// reintroduce exactly the silent mis-resolution SCHEMA 30 removed:
/// `resolve_snapshot_document` would compare a Revision id against a
/// `snapshot:<runId>` key, fail, and have that failure collapsed into
/// `source-missing` for a Source that is present.
pub(crate) fn owning_run_id_for_consumer<'a>(
    consumer_kind: &str,
    consumer_key: &'a str,
) -> Option<&'a str> {
    match ConsumerKind::try_from(consumer_kind) {
        Ok(ConsumerKind::Run) => Some(consumer_key),
        Ok(ConsumerKind::ProposalRevision | ConsumerKind::Application) => None,
        // An unrecognised kind has no owning Run either. Reported as
        // "unknown", never guessed at.
        Err(_) => None,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    /// `as_str()` must match the literal actually persisted in
    /// `narrative_dependency_edges.consumer_kind` /
    /// `narrative_consumer_freshness.consumer_kind`, and the frozen copy
    /// SCHEMA 28's migration compares against.
    #[test]
    fn consumer_kind_as_str_matches_the_persisted_literal() {
        assert_eq!(ConsumerKind::Run.as_str(), "narrative-extraction-run");
        assert_eq!(ConsumerKind::Run.as_str(), RUN_CONSUMER_KIND);
    }

    #[test]
    fn consumer_kind_round_trips_and_fails_closed() {
        assert_eq!(
            ConsumerKind::try_from(RUN_CONSUMER_KIND).unwrap(),
            ConsumerKind::Run
        );
        assert_eq!(
            ConsumerKind::try_from(PROPOSAL_REVISION_CONSUMER_KIND).unwrap(),
            ConsumerKind::ProposalRevision
        );
        assert_eq!(
            ConsumerKind::try_from(APPLICATION_CONSUMER_KIND).unwrap(),
            ConsumerKind::Application
        );
        // Reserved in the policy contract, deliberately not implemented here.
        let error = ConsumerKind::try_from("application-contribution").unwrap_err();
        assert!(
            error.to_string().contains("NEX_CONSUMER_KIND_INVALID"),
            "unexpected error: {error}"
        );
        assert!(ConsumerKind::try_from("").is_err());
    }

    /// The two questions are separate, and since the re-key they have
    /// different answers for the same Consumer. Collapsing them would skip
    /// every Revision Consumer in Rebuild-Derived and Verify.
    #[test]
    fn a_proposal_revision_is_declared_but_has_no_run_in_its_key() {
        assert!(is_declared_consumer_kind(PROPOSAL_REVISION_CONSUMER_KIND));
        assert_eq!(
            owning_run_id_for_consumer(PROPOSAL_REVISION_CONSUMER_KIND, "revision-1"),
            None,
            "a Revision id is not a Run id; the Edge's own owning_run_id is the answer"
        );
        assert!(is_declared_consumer_kind(RUN_CONSUMER_KIND));
        assert!(is_declared_consumer_kind(APPLICATION_CONSUMER_KIND));
        assert_eq!(
            owning_run_id_for_consumer(APPLICATION_CONSUMER_KIND, "application-1"),
            None,
            "an Application id is not a Run id; the Edge's own owning_run_id is the answer"
        );
        assert!(!is_declared_consumer_kind("application-contribution"));
    }

    #[test]
    fn finding_key_round_trips_through_a_key_containing_colons() {
        // narrative-consumer-contract.json's own `negativeFixture`.
        let key = consumer_finding_key("semantic-index", "embeddings:v2");
        assert_eq!(
            key, "semantic-index:embeddings:v2",
            "finding_key is a plain first-separator join, not an escaped encoding"
        );
        assert_eq!(
            parse_finding_key(&key),
            Some(("semantic-index", "embeddings:v2")),
            "splitting on the first separator must recover both halves intact"
        );
        assert_ne!(
            key.rsplit_once(':').map(|(kind, _)| kind),
            Some("semantic-index"),
            "this is the fixture's point: last-colon parsing does not recover the kind"
        );
    }

    #[test]
    fn finding_key_matches_todays_stored_convention() {
        assert_eq!(
            consumer_finding_key(RUN_CONSUMER_KIND, "run-1"),
            "narrative-extraction-run:run-1"
        );
    }

    #[test]
    fn parse_finding_key_returns_none_without_a_separator() {
        assert_eq!(parse_finding_key("no-separator-here"), None);
    }

    #[test]
    fn validate_consumer_identity_rejects_a_kind_that_would_break_the_finding_key() {
        assert!(validate_consumer_identity(RUN_CONSUMER_KIND, "run-1").is_ok());
        // A key may carry separators; a kind may not.
        assert!(validate_consumer_identity(RUN_CONSUMER_KIND, "a:b:c").is_ok());

        for (kind, key) in [
            ("", "run-1"),
            ("   ", "run-1"),
            (RUN_CONSUMER_KIND, ""),
            (RUN_CONSUMER_KIND, "  "),
            (" leading-space", "run-1"),
            (RUN_CONSUMER_KIND, "trailing-space "),
            ("has:colon", "run-1"),
        ] {
            assert!(
                validate_consumer_identity(kind, key).is_err(),
                "expected ({kind:?}, {key:?}) to be rejected"
            );
        }
    }

    /// The ratified registry, read the same way `protected_writers.rs` reads
    /// its own policy file: by `include_str!`, so the check runs against the
    /// committed contract rather than a copy of it.
    const CONSUMER_CONTRACT_JSON: &str =
        include_str!("../../../../../policies/narrative/narrative-consumer-contract.json");

    fn contract_kinds_with_status(status: &str) -> Vec<String> {
        let contract: serde_json::Value = serde_json::from_str(CONSUMER_CONTRACT_JSON)
            .expect("policies/narrative/narrative-consumer-contract.json must parse");
        contract["consumerKinds"]
            .as_array()
            .expect("consumerKinds must be an array")
            .iter()
            .filter(|entry| entry["status"] == status)
            .map(|entry| {
                entry["kind"]
                    .as_str()
                    .expect("every consumerKinds entry needs a kind")
                    .to_string()
            })
            .collect()
    }

    /// The registry and this enum have to mean the same thing in both
    /// directions, and neither the JSON Schema nor the `.mjs` validator can
    /// see Rust. Without this, renaming `ConsumerKind::as_str()`'s literal or
    /// adding a `declared` entry to the contract leaves
    /// `pnpm test:narrative:semantic-contract` green while the "single owner
    /// of the Consumer vocabulary" claim quietly stops being true.
    /// Every variant of `ConsumerKind`, so the cross-check below compares two
    /// full sets rather than a set against a hand-written list that silently
    /// stops being complete.
    const ALL_CONSUMER_KINDS: &[ConsumerKind] = &[
        ConsumerKind::Run,
        ConsumerKind::ProposalRevision,
        ConsumerKind::Application,
    ];

    /// `ALL_CONSUMER_KINDS` is hand-maintained, so it needs its own guard: a
    /// variant added without extending it would silently drop out of the
    /// contract cross-check.
    #[test]
    fn all_consumer_kinds_covers_every_variant() {
        // Exhaustive match -- a new variant fails to compile here first.
        for kind in ALL_CONSUMER_KINDS {
            match kind {
                ConsumerKind::Run | ConsumerKind::ProposalRevision | ConsumerKind::Application => {}
            }
        }
        assert_eq!(
            ALL_CONSUMER_KINDS.len(),
            3,
            "extend ALL_CONSUMER_KINDS when a variant is added"
        );
    }

    #[test]
    fn every_declared_contract_kind_has_a_consumer_kind_variant_and_vice_versa() {
        let mut declared = contract_kinds_with_status("declared");
        declared.sort();
        let mut implemented: Vec<String> = ALL_CONSUMER_KINDS
            .iter()
            .map(|kind| kind.as_str().to_string())
            .collect();
        implemented.sort();
        assert_eq!(
            declared, implemented,
            "the contract's `declared` set and this enum must name the same kinds; add the \
             variant in the same change that declares the kind"
        );
        for kind in &declared {
            ConsumerKind::try_from(kind.as_str())
                .unwrap_or_else(|error| panic!("declared kind '{kind}' is unknown here: {error}"));
        }
    }

    /// A `reserved` kind is a promise the contract makes and this crate has
    /// deliberately not kept yet. If one ever starts converting, it stopped
    /// being reserved and the contract has to say so.
    #[test]
    fn no_reserved_contract_kind_is_accepted_as_a_consumer_kind() {
        let reserved = contract_kinds_with_status("reserved");
        assert!(
            !reserved.is_empty(),
            "the contract should still reserve the finer Consumer classes C2-2 will introduce"
        );
        for kind in reserved {
            assert!(
                ConsumerKind::try_from(kind.as_str()).is_err(),
                "'{kind}' is reserved in the contract but accepted here; a variant with no                  Producer and no reader is a promise nothing keeps"
            );
            assert_eq!(
                owning_run_id_for_consumer(&kind, "any-key"),
                None,
                "a reserved kind has no owning Run to resolve"
            );
        }
    }

    /// `migrate.rs`'s SCHEMA 28 `invalidate_derived_freshness_for_consumers_v28`
    /// builds the same key in raw SQL (`?2 || ':' || ?3`) and cannot import
    /// this function -- a migration has to keep working against the schema
    /// it was written for, so it stays frozen while this module moves. The
    /// convention is pinned behaviourally instead: SQLite's own
    /// concatenation, run here, must produce byte-identical output.
    #[test]
    fn finding_key_convention_matches_the_v28_migration_sql() {
        let conn = rusqlite::Connection::open_in_memory().expect("open scratch connection");
        for (kind, key) in [
            (RUN_CONSUMER_KIND, "run-1"),
            ("proposal", "proposal-1"),
            (RUN_CONSUMER_KIND, "run:with:colons"),
        ] {
            let from_sql: String = conn
                .query_row(
                    "SELECT ?1 || ':' || ?2",
                    rusqlite::params![kind, key],
                    |row| row.get(0),
                )
                .expect("concatenate in sqlite");
            assert_eq!(
                from_sql,
                consumer_finding_key(kind, key),
                "the SCHEMA 28 migration and this module must agree on ({kind:?}, {key:?})"
            );
        }
    }

    #[test]
    fn owning_run_id_is_the_consumer_key_only_for_a_run_consumer() {
        assert_eq!(
            owning_run_id_for_consumer(RUN_CONSUMER_KIND, "run-1"),
            Some("run-1")
        );
        assert_eq!(
            owning_run_id_for_consumer("proposal-revision", "rev-1"),
            None
        );
        assert_eq!(
            owning_run_id_for_consumer(APPLICATION_CONSUMER_KIND, "application-1"),
            None
        );
        assert_eq!(owning_run_id_for_consumer("not-a-kind", "whatever"), None);
    }
}
