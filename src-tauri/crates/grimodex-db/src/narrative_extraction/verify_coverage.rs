//! Production Verify coverage for the C2-Z durable and derived contracts.
//!
//! The checks in this module are intentionally read-only.  They inspect the
//! rows that the production writers already own and return explicit
//! incomplete evidence when a required relationship cannot be proved.  A
//! missing relationship is never repaired, inferred from payload text, or
//! silently treated as a clean result.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, SecondsFormat};
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};

use super::c2z_preparation::inspect_legacy_generic_freshness_parity;
use super::consumer_identity::APPLICATION_CONSUMER_KIND;
use super::dependency_edges::{canonical_source_object_identity, PROPOSAL_REVISION_CONSUMER_KIND};
use super::nir1_entity_relation_index::{
    GraphWorkControl, GraphWorkStage, NeverStopGraphWorkControl,
};
use super::source_revision::resolve_source_revision_with_control;
use super::source_revision::is_validation_terminated;
use super::INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID;

fn check_control(
    control: &mut dyn GraphWorkControl,
    stage: GraphWorkStage,
) -> anyhow::Result<()> {
    control.check(stage)
}

const RESERVED_SEMANTIC_INDEX_OBSERVED_COUNT_KEYS: [&str; 4] = [
    "metadataRows",
    "activeD1HeadRows",
    "v1EdgeRows",
    "consumerFreshnessRows",
];

/// The typed evidence for one of the six Verify checks that was previously
/// outside the production report.  `incomplete` means the database did not
/// contain enough trustworthy rows to perform the check; `issues` means the
/// check completed and found a concrete inconsistency.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyCoverageCheck {
    pub completed: bool,
    pub passed: bool,
    pub issues: Vec<String>,
    pub incomplete: Vec<String>,
    /// Read-only diagnostics for the reserved Semantic Index authority
    /// footprint.  The map is populated only by the two Semantic checks;
    /// keeping it optional on the shared check shape lets older persisted
    /// reports deserialize without inventing observations for unrelated
    /// checks.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub observed_counts: BTreeMap<String, usize>,
}

impl VerifyCoverageCheck {
    fn finish(mut self) -> Self {
        self.completed = self.incomplete.is_empty();
        self.passed = self.completed && self.issues.is_empty();
        self
    }

    fn truth_table_is_valid(&self) -> bool {
        match (self.incomplete.is_empty(), self.issues.is_empty()) {
            // Missing evidence is never a completed or passing check.
            (false, _) => !self.completed && !self.passed,
            // A completed check with a concrete finding is not passing.
            (true, false) => self.completed && !self.passed,
            // Only a complete, issue-free check may be marked passing.
            (true, true) => self.completed && self.passed,
        }
    }

    pub(crate) fn is_consistent(&self) -> bool {
        self.truth_table_is_valid() && self.passed && self.issues.is_empty()
    }

    pub(crate) fn is_complete(&self) -> bool {
        self.truth_table_is_valid() && self.completed && self.incomplete.is_empty()
    }

    /// Reserved Semantic Index checks are only complete when the production
    /// reader recorded every one of its four authoritative surface counts.
    /// A missing or extra key is not an empty footprint: it is missing
    /// evidence and must fail closed when a persisted report is re-read.
    pub(crate) fn has_reserved_footprint_observation(&self) -> bool {
        self.observed_counts.len() == RESERVED_SEMANTIC_INDEX_OBSERVED_COUNT_KEYS.len()
            && RESERVED_SEMANTIC_INDEX_OBSERVED_COUNT_KEYS
                .iter()
                .all(|key| self.observed_counts.get(*key) == Some(&0))
    }
}

impl<'de> Deserialize<'de> for VerifyCoverageCheck {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire {
            completed: bool,
            passed: bool,
            issues: Vec<String>,
            incomplete: Vec<String>,
            #[serde(default)]
            observed_counts: BTreeMap<String, usize>,
        }

        let wire = Wire::deserialize(deserializer)?;
        let check = Self {
            completed: wire.completed,
            passed: wire.passed,
            issues: wire.issues,
            incomplete: wire.incomplete,
            observed_counts: wire.observed_counts,
        };
        if !check.truth_table_is_valid() {
            return Err(de::Error::custom(
                "VerifyCoverageCheck completed/passed flags do not match issues/incomplete evidence",
            ));
        }
        Ok(check)
    }
}

/// Run the typed Application -> Revision -> Artifact reference check.
///
/// Artifact references are read only from the persisted Revision Source Basis
/// and the Revision's declared dependency Edges.  Arbitrary proposal payload
/// JSON is deliberately not inspected: an inferred reference would have no
/// durable identity or writer contract to bind it to.
pub(crate) fn verify_application_revision_artifact_references(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<VerifyCoverageCheck> {
    let mut control = NeverStopGraphWorkControl;
    verify_application_revision_artifact_references_with_control(conn, project_id, &mut control)
}

pub(crate) fn verify_application_revision_artifact_references_with_control(
    conn: &Connection,
    project_id: &str,
    control: &mut dyn GraphWorkControl,
) -> anyhow::Result<VerifyCoverageCheck> {
    check_control(control, GraphWorkStage::Coverage)?;
    let mut check = VerifyCoverageCheck::default();
    let mut applications = Vec::new();
    let mut statement = conn.prepare(
        "SELECT a.id, a.commit_id, a.proposal_id, a.revision_id, r.origin_kind,
                r.proposal_id, p.proposal_set_id, c.proposal_set_id,
                ps.project_id, c.project_id
           FROM narrative_proposal_applications a
           LEFT JOIN narrative_apply_commits c ON c.id = a.commit_id
           LEFT JOIN narrative_proposals p ON p.id = a.proposal_id
           LEFT JOIN narrative_proposal_sets ps ON ps.id = p.proposal_set_id
           LEFT JOIN narrative_proposal_revisions r ON r.id = a.revision_id
          WHERE c.project_id = ?1
             OR (c.id IS NULL AND ps.project_id = ?1)
          ORDER BY a.id ASC",
    )?;
    let rows = statement.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<String>>(7)?,
            row.get::<_, Option<String>>(8)?,
            row.get::<_, Option<String>>(9)?,
        ))
    })?;
    for row in rows {
        check_control(control, GraphWorkStage::Coverage)?;
        let (
            application_id,
            commit_id,
            proposal_id,
            revision_id,
            origin_kind,
            revision_proposal_id,
            proposal_set_id,
            commit_proposal_set_id,
            proposal_set_project_id,
            commit_project_id,
        ) = row?;
        if commit_project_id.is_none() {
            check.incomplete.push(format!(
                "application:{application_id}:commit:{commit_id}:missing"
            ));
            continue;
        }
        match (proposal_set_id.as_deref(), proposal_set_project_id.as_deref()) {
            (None, _) => check.incomplete.push(format!(
                "application:{application_id}:proposal:{proposal_id}:proposal-set-missing"
            )),
            (Some(_), None) => check.incomplete.push(format!(
                "application:{application_id}:proposal:{proposal_id}:proposal-set-row-missing"
            )),
            (Some(_), Some(owner)) if owner != project_id => check.issues.push(format!(
                "application:{application_id}:proposal:{proposal_id}:proposal-set-cross-project:{owner}"
            )),
            (Some(_), Some(_)) => {}
        }
        if let (Some(commit_set), Some(proposal_set)) = (
            commit_proposal_set_id.as_deref(),
            proposal_set_id.as_deref(),
        ) {
            if commit_set != proposal_set {
                check.issues.push(format!(
                    "application:{application_id}:proposal:{proposal_id}:commit-proposal-set-mismatch:{commit_set}:{proposal_set}"
                ));
            }
        }
        if let Some(revision_proposal_id) = revision_proposal_id.as_deref() {
            if revision_proposal_id != proposal_id {
                check.issues.push(format!(
                    "application:{application_id}:revision:{revision_id}:proposal-mismatch:{revision_proposal_id}:{proposal_id}"
                ));
            }
        }
        let Some(origin_kind) = origin_kind else {
            check.incomplete.push(format!(
                "application:{application_id}:revision:{revision_id}:missing"
            ));
            continue;
        };
        if !matches!(origin_kind.as_str(), "enveloped" | "legacy-unbound") {
            check.issues.push(format!(
                "application:{application_id}:revision:{revision_id}:origin-kind-invalid:{origin_kind}"
            ));
        }
        if origin_kind == "legacy-unbound" {
            // An applied Revision that still carries the legacy-unbound
            // origin has no durable envelope proving the source set that was
            // actually committed.  Treat it as an evidence hole even when a
            // caller happened to add a basis row later; the legacy origin is
            // itself the production writer's admission that the binding was
            // not sealed.
            check.incomplete.push(format!(
                "application:{application_id}:revision:{revision_id}:legacy-unbound-applied"
            ));
        }
        applications.push((application_id, revision_id, origin_kind));
    }

    for (application_id, revision_id, origin_kind) in applications {
        let mut basis_rows = Vec::new();
        let mut basis_statement = conn.prepare(
            "SELECT ordinal, source_kind, source_key, revision_token
               FROM narrative_revision_source_basis
              WHERE revision_id = ?1
              ORDER BY ordinal ASC",
        )?;
        let rows = basis_statement.query_map(params![revision_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        for row in rows {
            check_control(control, GraphWorkStage::Coverage)?;
            basis_rows.push(row?);
        }

        if origin_kind == "enveloped" && basis_rows.is_empty() {
            check.incomplete.push(format!(
                "application:{application_id}:revision:{revision_id}:source-basis-missing"
            ));
        }

        let mut basis_identities = BTreeSet::new();
        let mut expected_ordinals = 0_i64;
        for (ordinal, source_kind, source_key, revision_token) in basis_rows {
            check_control(control, GraphWorkStage::Coverage)?;
            if ordinal != expected_ordinals {
                check.issues.push(format!(
                    "application:{application_id}:revision:{revision_id}:source-basis-ordinal:{ordinal}"
                ));
            }
            expected_ordinals = expected_ordinals.saturating_add(1);
            let identity = match canonical_source_object_identity(&source_kind, &source_key) {
                Ok(identity) => identity,
                Err(error) => {
                    check.issues.push(format!(
                        "application:{application_id}:revision:{revision_id}:source-basis-invalid:{source_kind}:{source_key}:{error}"
                    ));
                    continue;
                }
            };
            if !basis_identities.insert(identity.clone()) {
                check.issues.push(format!(
                    "application:{application_id}:revision:{revision_id}:source-basis-duplicate:{identity}"
                ));
            }

            let has_edge: bool = conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM narrative_dependency_edges
                     WHERE project_id = ?1
                       AND consumer_kind = ?2
                       AND consumer_key = ?3
                       AND source_object_identity = ?4
                )",
                params![
                    project_id,
                    PROPOSAL_REVISION_CONSUMER_KIND,
                    revision_id,
                    identity
                ],
                |row| row.get(0),
            )?;
            if !has_edge {
                check.issues.push(format!(
                    "application:{application_id}:revision:{revision_id}:source-basis-edge-missing:{identity}"
                ));
            }

            if let Some(artifact_id) = identity.strip_prefix("artifact:") {
                let artifact_project: Option<Option<String>> = conn
                    .query_row(
                        "SELECT run.project_id
                           FROM narrative_extraction_artifacts artifact
                           LEFT JOIN narrative_extraction_runs run
                             ON run.id = artifact.run_id
                          WHERE artifact.id = ?1",
                        params![artifact_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                match artifact_project {
                    None => check.issues.push(format!(
                        "application:{application_id}:revision:{revision_id}:artifact-missing:{artifact_id}"
                    )),
                    Some(None) => check.issues.push(format!(
                        "application:{application_id}:revision:{revision_id}:artifact-run-missing:{artifact_id}"
                    )),
                    Some(Some(owner_project)) if owner_project != project_id => check.issues.push(
                        format!(
                            "application:{application_id}:revision:{revision_id}:artifact-cross-project:{artifact_id}:{owner_project}"
                        ),
                    ),
                    Some(Some(_)) => {}
                }
                if source_kind == "narrative-artifact" {
                    // Artifact resolution is project-scoped and does not
                    // consume a prepared-run owner.  The shared resolver
                    // still takes a run id for snapshot sources; pass the
                    // intentionally unused empty value here rather than
                    // inventing a Run binding for an artifact.
                    check_control(control, GraphWorkStage::Source)?;
                    match resolve_source_revision_with_control(
                        conn,
                        project_id,
                        "",
                        &source_kind,
                        &source_key,
                        control,
                    ) {
                        Ok(current) if current.revision_token == revision_token => {}
                        Ok(current) => check.issues.push(format!(
                            "application:{application_id}:revision:{revision_id}:artifact-revision-token-mismatch:{artifact_id}:recorded={revision_token}:current={}",
                            current.revision_token
                        )),
                        Err(error) if is_validation_terminated(&error) => return Err(error),
                        Err(error) => {
                            // A generic read error may be SQLite interruption
                            // from the same controlled owner. Re-check before
                            // classifying it as an artifact issue.
                            check_control(control, GraphWorkStage::Source)?;
                            check.issues.push(format!(
                                "application:{application_id}:revision:{revision_id}:artifact-resolution-failed:{artifact_id}:{error}"
                            ));
                        }
                    }
                }
            }
        }

        let mut edge_statement = conn.prepare(
            "SELECT id, source_object_identity
               FROM narrative_dependency_edges
              WHERE project_id = ?1
                AND consumer_kind = ?2
                AND consumer_key = ?3
              ORDER BY id ASC",
        )?;
        let edge_rows = edge_statement.query_map(
            params![project_id, PROPOSAL_REVISION_CONSUMER_KIND, revision_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        for edge_row in edge_rows {
            check_control(control, GraphWorkStage::Coverage)?;
            let (edge_id, source_identity) = edge_row?;
            if source_identity.starts_with("artifact:")
                && !basis_identities.contains(&source_identity)
            {
                check.issues.push(format!(
                    "application:{application_id}:revision:{revision_id}:artifact-edge-without-source-basis:{edge_id}:{source_identity}"
                ));
            }
        }
    }

    Ok(check.finish())
}

/// Run both Semantic Index halves of the Verify contract while the Semantic
/// Index producer remains reserved.  C2-ZC does not add a metadata writer,
/// D1 declaration owner, migration, or activation path, so it must not infer
/// a generation or digest from scene/codex/event/chat chunks.  Instead, both
/// checks inspect the four authoritative surfaces that would constitute a
/// reserved-consumer footprint.  A completely empty footprint is the only
/// passing result; any row is explicit incomplete evidence and remains a
/// manual/terminal repair condition (never a Rebuild-derived condition).
///
/// The approved NIR-1 owner has one explicit binding: the
/// metadata `index_key` must equal the D1 `consumer_key` and freshness
/// `consumer_key`; metadata `generation` must equal the active sealed D1
/// head's `producer_generation`; and metadata `dependency_set_digest` must
/// equal the active sealed D1 declaration set's digest. Only a complete,
/// whole-project Graph registration is removed from reserved counts; a dirty
/// or otherwise stale binding remains visible as incomplete evidence. Live
/// usability remains a separate producer check.
pub(crate) fn verify_semantic_index_checks(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<(VerifyCoverageCheck, VerifyCoverageCheck)> {
    let mut control = NeverStopGraphWorkControl;
    verify_semantic_index_checks_with_control(conn, project_id, &mut control)
}

pub(crate) fn verify_semantic_index_checks_with_control(
    conn: &Connection,
    project_id: &str,
    control: &mut dyn GraphWorkControl,
) -> anyhow::Result<(VerifyCoverageCheck, VerifyCoverageCheck)> {
    check_control(control, GraphWorkStage::Coverage)?;
    if conn.is_autocommit() {
        let tx = conn.unchecked_transaction()?;
        return verify_semantic_index_checks_with_control(&tx, project_id, control);
    }
    let mut observed_counts = BTreeMap::new();
    let reserved_surfaces = [
        (
            "metadataRows",
            "SELECT COUNT(*) FROM narrative_semantic_index_metadata
              WHERE project_id = ?1",
        ),
        (
            "activeD1HeadRows",
            "SELECT COUNT(*) FROM narrative_dependency_declaration_heads
              WHERE project_id = ?1 AND consumer_kind = 'semantic-index'",
        ),
        (
            "v1EdgeRows",
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE project_id = ?1 AND consumer_kind = 'semantic-index'",
        ),
        (
            "consumerFreshnessRows",
            "SELECT COUNT(*) FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind = 'semantic-index'",
        ),
    ];
    for (surface, query) in reserved_surfaces {
        check_control(control, GraphWorkStage::Coverage)?;
        let raw_count = conn.query_row(query, params![project_id], |row| row.get::<_, i64>(0))?;
        anyhow::ensure!(
            raw_count >= 0,
            "reserved Semantic Index footprint count cannot be negative: {surface}={raw_count}"
        );
        let count = usize::try_from(raw_count).map_err(|_| {
            anyhow::anyhow!(
                "reserved Semantic Index footprint count cannot fit usize: {surface}={raw_count}"
            )
        })?;
        observed_counts.insert(surface.to_string(), count);
    }

    let mut reserved_counts = observed_counts.clone();
    check_control(control, GraphWorkStage::Coverage)?;
    if super::nir1_chronicle_index::is_complete_registered_chronicle_index(
        conn,
        project_id,
        super::nir1_chronicle_index::INDEX_KEY,
    )? {
        let known_edge_count: i64 = conn.query_row("SELECT COUNT(*) FROM narrative_dependency_edges WHERE project_id=?1 AND consumer_kind='semantic-index' AND consumer_key=?2",
            params![project_id,super::nir1_chronicle_index::INDEX_KEY],|row|row.get(0))?;
        for (surface, known) in [
            ("metadataRows", 1),
            ("activeD1HeadRows", 1),
            ("v1EdgeRows", usize::try_from(known_edge_count)?),
            ("consumerFreshnessRows", 1),
        ] {
            let raw = reserved_counts
                .get_mut(surface)
                .ok_or_else(|| anyhow::anyhow!("missing semantic index surface"))?;
            *raw = raw.checked_sub(known).ok_or_else(|| {
                anyhow::anyhow!("declared semantic index count exceeds observed count")
            })?;
        }
    }
    check_control(control, GraphWorkStage::Coverage)?;
    if super::nir1_entity_relation_index::is_complete_registered_with_control(
        conn,
        project_id,
        super::nir1_entity_relation_index::INDEX_KEY,
        control,
    )? {
        let known_edge_count: i64 = conn.query_row("SELECT COUNT(*) FROM narrative_dependency_edges WHERE project_id=?1 AND consumer_kind='semantic-index' AND consumer_key=?2",
            params![project_id,super::nir1_entity_relation_index::INDEX_KEY],|row|row.get(0))?;
        for (surface, known) in [
            ("metadataRows", 1),
            ("activeD1HeadRows", 1),
            ("v1EdgeRows", usize::try_from(known_edge_count)?),
            ("consumerFreshnessRows", 1),
        ] {
            let raw = reserved_counts
                .get_mut(surface)
                .ok_or_else(|| anyhow::anyhow!("missing semantic index surface"))?;
            *raw = raw.checked_sub(known).ok_or_else(|| {
                anyhow::anyhow!("declared semantic index count exceeds observed count")
            })?;
        }
    }
    check_control(control, GraphWorkStage::Coverage)?;
    let footprint_is_empty = reserved_counts.values().all(|count| *count == 0);
    observed_counts = reserved_counts.clone();
    let mut digest_check = VerifyCoverageCheck {
        observed_counts: observed_counts.clone(),
        ..VerifyCoverageCheck::default()
    };
    let mut generation_check = VerifyCoverageCheck {
        observed_counts,
        ..VerifyCoverageCheck::default()
    };
    if !footprint_is_empty {
        let summary = format!(
            "reserved-consumer-kind-footprint:metadataRows={}:activeD1HeadRows={}:v1EdgeRows={}:consumerFreshnessRows={}",
            reserved_counts["metadataRows"],
            reserved_counts["activeD1HeadRows"],
            reserved_counts["v1EdgeRows"],
            reserved_counts["consumerFreshnessRows"],
        );
        // No declared writer owns the remaining reserved surfaces. Keep the
        // finding incomplete (rather than `issues`) so downstream repair
        // classification remains ManualRepair/TerminalIncomplete.
        digest_check.incomplete.push(summary.clone());
        generation_check.incomplete.push(summary);
    }

    Ok((digest_check.finish(), generation_check.finish()))
}

/// Verify that every durable Application Contribution still points to the
/// exact Application, Apply Commit, Proposal, Revision and optional Operation
/// provenance recorded by the production apply writer.
pub(crate) fn verify_contribution_to_application_commit_correspondence(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<VerifyCoverageCheck> {
    let mut control = NeverStopGraphWorkControl;
    verify_contribution_to_application_commit_correspondence_with_control(
        conn,
        project_id,
        &mut control,
    )
}

pub(crate) fn verify_contribution_to_application_commit_correspondence_with_control(
    conn: &Connection,
    project_id: &str,
    control: &mut dyn GraphWorkControl,
) -> anyhow::Result<VerifyCoverageCheck> {
    check_control(control, GraphWorkStage::Coverage)?;
    let mut check = VerifyCoverageCheck::default();
    let mut statement = conn.prepare(
        "SELECT id, application_id, commit_id, proposal_id, revision_id, operation_id
           FROM narrative_application_contributions
          WHERE project_id = ?1
          ORDER BY id ASC",
    )?;
    let rows = statement.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    })?;
    for row in rows {
        check_control(control, GraphWorkStage::Coverage)?;
        let (contribution_id, application_id, commit_id, proposal_id, revision_id, operation_id) =
            row?;
        let label = format!("contribution:{contribution_id}");
        let application: Option<(String, String, String)> = conn
            .query_row(
                "SELECT commit_id, proposal_id, revision_id
                   FROM narrative_proposal_applications WHERE id = ?1",
                params![application_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((application_commit, application_proposal, application_revision)) = application
        else {
            check
                .incomplete
                .push(format!("{label}:application-missing:{application_id}"));
            continue;
        };
        if application_commit != commit_id {
            check.issues.push(format!(
                "{label}:application-commit-mismatch:recorded={commit_id}:application={application_commit}"
            ));
        }
        if application_proposal != proposal_id {
            check.issues.push(format!(
                "{label}:application-proposal-mismatch:recorded={proposal_id}:application={application_proposal}"
            ));
        }
        if application_revision != revision_id {
            check.issues.push(format!(
                "{label}:application-revision-mismatch:recorded={revision_id}:application={application_revision}"
            ));
        }

        let commit: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT project_id, proposal_set_id
                   FROM narrative_apply_commits WHERE id = ?1",
                params![commit_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match commit {
            None => check
                .incomplete
                .push(format!("{label}:commit-missing:{commit_id}")),
            Some((owner, commit_proposal_set)) => {
                if owner != project_id {
                    check
                        .issues
                        .push(format!("{label}:commit-cross-project:{owner}"));
                }
                if let Some(commit_proposal_set) = commit_proposal_set {
                    // A prepared Apply Commit may legally omit this optional
                    // lineage field for legacy rows, but once present it must
                    // name the same Proposal Set as the Contribution's
                    // Proposal.  Otherwise the commit can be made to look
                    // like it applied a different review set.
                    if let Some((proposal_set_id,)) = conn
                        .query_row(
                            "SELECT proposal_set_id FROM narrative_proposals WHERE id = ?1",
                            params![proposal_id],
                            |row| Ok((row.get::<_, String>(0)?,)),
                        )
                        .optional()?
                    {
                        if commit_proposal_set != proposal_set_id {
                            check.issues.push(format!(
                                "{label}:commit-proposal-set-mismatch:recorded={commit_proposal_set}:proposal={proposal_set_id}"
                            ));
                        }
                    }
                }
            }
        }

        let proposal_set: Option<(String,)> = conn
            .query_row(
                "SELECT proposal_set_id FROM narrative_proposals WHERE id = ?1",
                params![proposal_id],
                |row| Ok((row.get(0)?,)),
            )
            .optional()?;
        let Some((proposal_set_id,)) = proposal_set else {
            check
                .incomplete
                .push(format!("{label}:proposal-missing:{proposal_id}"));
            continue;
        };
        let proposal_project: Option<String> = conn
            .query_row(
                "SELECT project_id FROM narrative_proposal_sets WHERE id = ?1",
                params![proposal_set_id],
                |row| row.get(0),
            )
            .optional()?;
        match proposal_project {
            None => check
                .incomplete
                .push(format!("{label}:proposal-set-missing:{proposal_set_id}")),
            Some(owner) if owner != project_id => check
                .issues
                .push(format!("{label}:proposal-cross-project:{owner}")),
            Some(_) => {}
        }

        let revision_proposal: Option<String> = conn
            .query_row(
                "SELECT proposal_id FROM narrative_proposal_revisions WHERE id = ?1",
                params![revision_id],
                |row| row.get(0),
            )
            .optional()?;
        match revision_proposal {
            None => check
                .incomplete
                .push(format!("{label}:revision-missing:{revision_id}")),
            Some(owner) if owner != proposal_id => check.issues.push(format!(
                "{label}:revision-proposal-mismatch:recorded={proposal_id}:revision={owner}"
            )),
            Some(_) => {}
        }

        if let Some(operation_id) = operation_id {
            let operation_commit: Option<String> = conn
                .query_row(
                    "SELECT commit_id FROM narrative_apply_operations WHERE id = ?1",
                    params![operation_id],
                    |row| row.get(0),
                )
                .optional()?;
            match operation_commit {
                None => check
                    .incomplete
                    .push(format!("{label}:operation-missing:{operation_id}")),
                Some(owner) if owner != commit_id => check.issues.push(format!(
                    "{label}:operation-commit-mismatch:recorded={commit_id}:operation={owner}"
                )),
                Some(_) => {}
            }
        }
    }
    Ok(check.finish())
}

/// Reuse the canonical Legacy/Generic parity reader and add the current
/// Semantic Epoch binding that belongs to production Verify rather than the
/// pre-cutover readiness report.
pub(crate) fn verify_legacy_mirror_migration_parity(
    conn: &Connection,
    project_id: &str,
    current_epoch_id: Option<&str>,
) -> anyhow::Result<VerifyCoverageCheck> {
    let mut control = NeverStopGraphWorkControl;
    verify_legacy_mirror_migration_parity_with_control(
        conn,
        project_id,
        current_epoch_id,
        &mut control,
    )
}

pub(crate) fn verify_legacy_mirror_migration_parity_with_control(
    conn: &Connection,
    project_id: &str,
    current_epoch_id: Option<&str>,
    control: &mut dyn GraphWorkControl,
) -> anyhow::Result<VerifyCoverageCheck> {
    check_control(control, GraphWorkStage::Coverage)?;
    let mut check = VerifyCoverageCheck::default();
    match inspect_legacy_generic_freshness_parity(conn, project_id) {
        Ok(parity) => {
            check.incomplete.extend(
                parity
                    .missing_legacy_application_ids
                    .into_iter()
                    .map(|id| format!("application:{id}:legacy-freshness-missing")),
            );
            check.incomplete.extend(
                parity
                    .missing_generic_application_ids
                    .into_iter()
                    .map(|id| format!("application:{id}:generic-freshness-missing")),
            );
            check.issues.extend(
                parity
                    .status_mismatches
                    .into_iter()
                    .map(|item| format!("application:{}:status-mismatch", item.application_id)),
            );
            check
                .issues
                .extend(parity.dependency_mismatches.into_iter().map(|item| {
                    format!(
                        "application:{}:dependency-set-mismatch",
                        item.application_id
                    )
                }));
            check
                .issues
                .extend(parity.unsupported_generic_values.into_iter().map(|item| {
                    format!(
                        "application:{}:generic-status-invalid:{}",
                        item.application_id, item.value
                    )
                }));
            check
                .issues
                .extend(parity.invalid_legacy_dependencies.into_iter().map(|item| {
                    format!(
                        "application:{}:legacy-dependency-invalid:{}",
                        item.application_id, item.reason
                    )
                }));
        }
        Err(error) => check
            .incomplete
            .push(format!("parity-reader-failed:{error}")),
    }

    let mut statement = conn.prepare(
        "SELECT a.id, f.semantic_epoch_id
           FROM narrative_proposal_applications a
           JOIN narrative_apply_commits c ON c.id = a.commit_id
           LEFT JOIN narrative_consumer_freshness f
             ON f.project_id = c.project_id
            AND f.consumer_kind = ?2
            AND f.consumer_key = a.id
          WHERE c.project_id = ?1
          ORDER BY a.id ASC",
    )?;
    let rows = statement.query_map(params![project_id, APPLICATION_CONSUMER_KIND], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    for row in rows {
        check_control(control, GraphWorkStage::Coverage)?;
        let (application_id, generic_epoch) = row?;
        let Some(generic_epoch) = generic_epoch else {
            continue;
        };
        match current_epoch_id {
            None => check.incomplete.push(format!(
                "application:{application_id}:generic-freshness-epoch-unbound:{generic_epoch}"
            )),
            Some(current) if generic_epoch != current => check.issues.push(format!(
                "application:{application_id}:generic-freshness-epoch-mismatch:{generic_epoch}:{current}"
            )),
            Some(_) => {}
        }
    }
    Ok(check.finish())
}

/// Verify cursor bounds, reservations, and the parent/child/source identity
/// correspondence of the canonical Change Feed.  A cursor may legitimately
/// lag the feed head; the check proves only that it never acknowledges or
/// reserves beyond the head and that every Feed row has one coherent source.
pub(crate) fn verify_cursor_and_feed_head_consistency(
    conn: &Connection,
    project_id: &str,
    current_epoch_id: Option<&str>,
) -> anyhow::Result<VerifyCoverageCheck> {
    let mut control = NeverStopGraphWorkControl;
    verify_cursor_and_feed_head_consistency_with_control(
        conn,
        project_id,
        current_epoch_id,
        &mut control,
    )
}

pub(crate) fn verify_cursor_and_feed_head_consistency_with_control(
    conn: &Connection,
    project_id: &str,
    current_epoch_id: Option<&str>,
    control: &mut dyn GraphWorkControl,
) -> anyhow::Result<VerifyCoverageCheck> {
    let mut check = VerifyCoverageCheck::default();
    check_control(control, GraphWorkStage::Coverage)?;
    let (feed_head, feed_count): (i64, i64) = conn.query_row(
        "SELECT COALESCE(MAX(canonical_sequence), 0), COUNT(*)
           FROM narrative_change_events WHERE project_id = ?1",
        params![project_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    let mut cursor_statement = conn.prepare(
        "SELECT consumer_id, acknowledged_through_sequence, lease_owner,
                semantic_epoch_id, active_run_id, reserved_through_sequence,
                lease_expires_at
           FROM narrative_change_cursors
          WHERE project_id = ?1
          ORDER BY consumer_id ASC",
    )?;
    let cursor_rows = cursor_statement.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<i64>>(5)?,
            row.get::<_, Option<String>>(6)?,
        ))
    })?;
    let mut has_incremental_cursor = false;
    for row in cursor_rows {
        check_control(control, GraphWorkStage::Coverage)?;
        let (consumer_id, acknowledged, lease_owner, cursor_epoch, active_run_id, reserved, lease) =
            row?;
        has_incremental_cursor |= consumer_id == INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID;
        let label = format!("cursor:{consumer_id}");
        if acknowledged < 0 {
            check
                .issues
                .push(format!("{label}:acknowledged-negative:{acknowledged}"));
        }
        if acknowledged > feed_head {
            check.issues.push(format!(
                "{label}:acknowledges-past-feed-head:{acknowledged}:{feed_head}"
            ));
        }
        // The pre-reservation cursor contract allowed a legacy lease to be
        // held with only lease_owner/lease_expires_at populated.  Preserve
        // that valid shape while still rejecting a half-populated lease or
        // malformed legacy values.  Reservation columns are checked below.
        match (lease_owner.as_deref(), lease.as_deref()) {
            (None, None) => {}
            (Some(owner), Some(lease)) => {
                if owner.trim().is_empty() {
                    check
                        .issues
                        .push(format!("{label}:legacy-lease-owner-invalid"));
                }
                if !is_canonical_instant(lease) {
                    check
                        .issues
                        .push(format!("{label}:legacy-lease-invalid:{lease}"));
                }
            }
            _ => check
                .issues
                .push(format!("{label}:legacy-lease-shape-invalid")),
        }
        match (
            active_run_id.as_deref(),
            reserved,
            cursor_epoch.as_deref(),
            lease.as_deref(),
        ) {
            (None, None, None, None) => {}
            (Some(run_id), Some(reserved), Some(cursor_epoch), Some(lease)) => {
                if lease_owner
                    .as_deref()
                    .is_none_or(|owner| owner.trim().is_empty())
                {
                    check
                        .issues
                        .push(format!("{label}:reservation-owner-invalid"));
                }
                if reserved < acknowledged || reserved > feed_head {
                    check.issues.push(format!(
                        "{label}:reservation-range-invalid:{acknowledged}:{reserved}:{feed_head}"
                    ));
                }
                if current_epoch_id.is_none() || current_epoch_id != Some(cursor_epoch) {
                    check
                        .issues
                        .push(format!("{label}:reservation-epoch-invalid:{cursor_epoch}"));
                }
                if !is_canonical_instant(lease) {
                    check.issues.push(format!("{label}:lease-invalid:{lease}"));
                }
                let run: Option<(String, Option<String>, String, String)> = conn
                    .query_row(
                        "SELECT project_id, semantic_epoch_id, run_kind, status
                           FROM narrative_extraction_runs WHERE id = ?1",
                        params![run_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?;
                match run {
                    None => check
                        .issues
                        .push(format!("{label}:active-run-missing:{run_id}")),
                    Some((owner_project, run_epoch, run_kind, status)) => {
                        if owner_project != project_id
                            || run_epoch.as_deref() != Some(cursor_epoch)
                            || run_kind != "freshness-evaluation"
                        {
                            check
                                .issues
                                .push(format!("{label}:active-run-binding-invalid:{run_id}"));
                        }
                        if !matches!(status.as_str(), "pending" | "running") {
                            check
                                .issues
                                .push(format!("{label}:active-run-terminal:{run_id}:{status}"));
                        }
                    }
                }
            }
            _ => check
                .issues
                .push(format!("{label}:reservation-shape-invalid")),
        }
    }
    if feed_count > 0 && !has_incremental_cursor {
        check
            .incomplete
            .push("incremental-cursor-missing-with-feed-events".to_string());
    }

    let mut transaction_statement = conn.prepare(
        "SELECT t.id, t.source_domain, t.source_change_event_uid,
                t.source_change_event_sequence, c.event_uid, c.sequence,
                c.op_type
           FROM narrative_change_transactions t
           LEFT JOIN change_events c
             ON c.project_id = t.project_id
            AND c.event_uid = t.source_change_event_uid
          WHERE t.project_id = ?1
          ORDER BY t.id ASC",
    )?;
    let transaction_rows = transaction_statement.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<i64>>(5)?,
            row.get::<_, Option<String>>(6)?,
        ))
    })?;
    let mut transaction_ids = BTreeSet::new();
    for row in transaction_rows {
        let (
            transaction_id,
            source_domain,
            source_uid,
            source_sequence,
            canonical_uid,
            canonical_sequence,
            canonical_operation,
        ) = row?;
        transaction_ids.insert(transaction_id.clone());
        let label = format!("transaction:{transaction_id}");
        if source_sequence <= 0 {
            check
                .issues
                .push(format!("{label}:source-sequence-invalid:{source_sequence}"));
        }
        match (canonical_uid, canonical_sequence, canonical_operation) {
            (Some(uid), Some(sequence), Some(operation))
                if uid == source_uid
                    && sequence == source_sequence
                    && operation == source_domain => {}
            (Some(uid), Some(sequence), Some(operation))
                if uid == source_uid && sequence == source_sequence =>
            {
                check.issues.push(format!(
                    "{label}:source-domain-mismatch:{source_domain}:{operation}"
                ));
            }
            (Some(uid), Some(sequence), _) => check.issues.push(format!(
                "{label}:source-event-mismatch:{source_uid}:{source_sequence}:{uid}:{sequence}"
            )),
            _ => check
                .issues
                .push(format!("{label}:source-event-missing:{source_uid}")),
        }
    }

    let mut event_statement = conn.prepare(
        "SELECT e.id, e.transaction_id, e.canonical_change_event_uid,
                e.canonical_sequence, e.event_ordinal, t.source_change_event_uid,
                t.source_change_event_sequence
           FROM narrative_change_events e
           LEFT JOIN narrative_change_transactions t
             ON t.id = e.transaction_id AND t.project_id = e.project_id
          WHERE e.project_id = ?1
          ORDER BY e.id ASC",
    )?;
    let event_rows = event_statement.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<i64>>(6)?,
        ))
    })?;
    let mut event_ordinals_by_transaction = BTreeMap::<String, Vec<i64>>::new();
    for row in event_rows {
        let (
            event_id,
            transaction_id,
            event_uid,
            event_sequence,
            event_ordinal,
            source_uid,
            source_sequence,
        ) = row?;
        event_ordinals_by_transaction
            .entry(transaction_id.clone())
            .or_default()
            .push(event_ordinal);
        let label = format!("event:{event_id}");
        if event_sequence <= 0 {
            check.issues.push(format!(
                "{label}:canonical-sequence-invalid:{event_sequence}"
            ));
        }
        if event_ordinal < 0 {
            check
                .issues
                .push(format!("{label}:event-ordinal-invalid:{event_ordinal}"));
        }
        match (source_uid, source_sequence) {
            (Some(uid), Some(sequence)) if uid == event_uid && sequence == event_sequence => {}
            (Some(uid), Some(sequence)) => check.issues.push(format!(
                "{label}:transaction-sequence-mismatch:{transaction_id}:{event_uid}:{event_sequence}:{uid}:{sequence}"
            )),
            _ => check
                .issues
                .push(format!("{label}:transaction-missing:{transaction_id}")),
        }
    }

    for transaction_id in transaction_ids {
        let label = format!("transaction:{transaction_id}");
        let Some(mut ordinals) = event_ordinals_by_transaction.remove(&transaction_id) else {
            check.issues.push(format!("{label}:feed-events-missing"));
            continue;
        };
        ordinals.sort_unstable();
        for (expected, actual) in ordinals.into_iter().enumerate() {
            if actual != i64::try_from(expected)? {
                check.issues.push(format!(
                    "{label}:event-ordinal-gap:{actual}:expected={expected}"
                ));
            }
        }
    }

    for (column, label) in [
        ("source_change_event_uid", "source-event-uid"),
        ("source_change_event_sequence", "source-event-sequence"),
    ] {
        let sql = format!(
            "SELECT {column}, COUNT(*) FROM narrative_change_transactions
              WHERE project_id = ?1 GROUP BY {column} HAVING COUNT(*) > 1"
        );
        let mut duplicate_statement = conn.prepare(&sql)?;
        let duplicate_rows = duplicate_statement.query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in duplicate_rows {
            let (value, count) = row?;
            check
                .issues
                .push(format!("feed:{label}-duplicate:{value}:{count}"));
        }
    }

    let (transaction_head, event_head): (i64, i64) = conn.query_row(
        "SELECT
            (SELECT COALESCE(MAX(source_change_event_sequence), 0)
               FROM narrative_change_transactions WHERE project_id = ?1),
            (SELECT COALESCE(MAX(canonical_sequence), 0)
               FROM narrative_change_events WHERE project_id = ?1)",
        params![project_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if transaction_head != event_head {
        check.issues.push(format!(
            "feed:head-mismatch:transactions={transaction_head}:events={event_head}"
        ));
    }

    Ok(check.finish())
}

fn is_canonical_instant(value: &str) -> bool {
    let Ok(parsed) = DateTime::parse_from_rfc3339(value) else {
        return false;
    };
    parsed.to_rfc3339_opts(SecondsFormat::Millis, true) == value
}

#[cfg(test)]
mod tests {
    use super::VerifyCoverageCheck;
    use serde_json::json;

    #[test]
    fn coverage_check_truth_table_is_fail_closed() {
        let cases = [
            (
                json!({
                    "completed": false,
                    "passed": false,
                    "issues": [],
                    "incomplete": ["metadata-missing"]
                }),
                false,
                false,
            ),
            (
                json!({
                    "completed": true,
                    "passed": false,
                    "issues": ["digest-mismatch"],
                    "incomplete": []
                }),
                false,
                true,
            ),
            (
                json!({
                    "completed": true,
                    "passed": true,
                    "issues": [],
                    "incomplete": []
                }),
                true,
                true,
            ),
        ];

        for (value, expected_consistent, expected_complete) in cases {
            let check: VerifyCoverageCheck =
                serde_json::from_value(value).expect("canonical coverage truth-table row");
            assert_eq!(check.is_consistent(), expected_consistent);
            assert_eq!(check.is_complete(), expected_complete);
        }
    }

    #[test]
    fn coverage_check_rejects_serialized_flag_mismatches() {
        for value in [
            json!({
                "completed": true,
                "passed": true,
                "issues": [],
                "incomplete": ["metadata-missing"]
            }),
            json!({
                "completed": false,
                "passed": false,
                "issues": ["digest-mismatch"],
                "incomplete": []
            }),
            json!({
                "completed": false,
                "passed": true,
                "issues": [],
                "incomplete": []
            }),
        ] {
            assert!(
                serde_json::from_value::<VerifyCoverageCheck>(value).is_err(),
                "serialized coverage flags must agree with evidence"
            );
        }
    }
}
