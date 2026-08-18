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
//! free functions. Today every Edge is declared under
//! `(RUN_CONSUMER_KIND, run_id)`, so passing `consumer_key` where a
//! `run_id` is wanted is accidentally correct. Under Gate C2-2's finer
//! Consumer grain it stops being correct, and the way it stops is the
//! dangerous part: `source_revision::resolve_snapshot_document` requires a
//! `snapshot:<runId>` Source's key to equal the `run_id` it is handed, and
//! `restore_rebuild::build_edge_comparison_input` turns *every* resolver
//! error into `current_source_exists = false`. A Consumer key that is no
//! longer a Run id would therefore not raise anything -- it would quietly
//! report `source-missing` for Sources that are present and healthy, and
//! the Maintenance Inbox would show a plausible, entirely fabricated
//! problem.
//!
//! So [`owning_run_id_for_consumer`] is the single seam, and it returns
//! `Option`: callers must decide what to do when a Consumer has no owning
//! Run instead of inheriting a wrong answer by construction. Both current
//! callers fail closed and say so.
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

/// The Consumer kinds this crate declares and reads today.
///
/// One variant, because one variant is what has a writer:
/// `repository.rs`'s `record_run_dependency_edges_in_tx` and
/// `legacy_backfill.rs`'s `record_legacy_dependency_edges_in_tx` both key
/// every Edge under `(RUN_CONSUMER_KIND, run_id)`.
/// `policies/narrative/narrative-consumer-contract.json` additionally
/// *reserves* the finer-grained kinds Gate C2-2 will introduce
/// (`proposal-revision`, `application`, `application-contribution`, ...).
/// They are intentionally absent here: adding a variant with no Producer
/// and no reader would make `TryFrom` accept a kind that nothing in this
/// crate can evaluate, publish, or resolve a Source for -- which is exactly
/// the silent-wrong-answer failure this module exists to prevent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConsumerKind {
    /// One Narrative Extraction Run. `consumer_key` is
    /// `narrative_extraction_runs.id`.
    Run,
}

impl ConsumerKind {
    /// `const` so [`RUN_CONSUMER_KIND`] can be defined *from* it. That
    /// direction matters: it makes the enum the single source of the
    /// persisted literal, rather than a second place that has to be kept
    /// agreeing with a free-standing constant.
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Run => "narrative-extraction-run",
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

/// The Run that owns this Consumer, when the Consumer *is* a Run.
///
/// The single seam replacing `restore_rebuild.rs`'s two unnamed casts. It
/// answers a question only the Consumer vocabulary can answer -- "which Run
/// is this Consumer's `snapshot:<runId>` Source expected to name?" -- and
/// returns `None` rather than a plausible-looking wrong id when the
/// Consumer is not a Run.
///
/// `None` is unreachable today (`ConsumerKind` has one variant, and both
/// Producers use it). It becomes reachable the moment Gate C2-2 declares an
/// Edge under a finer Consumer, which is the point: the callers below fail
/// closed on it, so that change surfaces as a named error attributable to
/// this seam instead of as a fabricated `source-missing` Finding.
pub(crate) fn owning_run_id_for_consumer<'a>(
    consumer_kind: &str,
    consumer_key: &'a str,
) -> Option<&'a str> {
    match ConsumerKind::try_from(consumer_kind) {
        Ok(ConsumerKind::Run) => Some(consumer_key),
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
        // Reserved in the policy contract, deliberately not implemented here.
        let error = ConsumerKind::try_from("proposal-revision").unwrap_err();
        assert!(
            error.to_string().contains("NEX_CONSUMER_KIND_INVALID"),
            "unexpected error: {error}"
        );
        assert!(ConsumerKind::try_from("").is_err());
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
                .query_row("SELECT ?1 || ':' || ?2", rusqlite::params![kind, key], |row| {
                    row.get(0)
                })
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
        assert_eq!(owning_run_id_for_consumer("not-a-kind", "whatever"), None);
    }
}
