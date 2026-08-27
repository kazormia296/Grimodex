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
use serde::{Deserialize, Serialize};

use super::c2z_preparation::inspect_legacy_generic_freshness_parity;
use super::consumer_identity::APPLICATION_CONSUMER_KIND;
use super::declaration_storage::{
    read_active_dependency_declaration_set_in_tx, ActiveDependencyDeclarationSetRead,
};
use super::dependency_edges::{canonical_source_object_identity, PROPOSAL_REVISION_CONSUMER_KIND};
use super::semantic_index_diagnostics::{compute_dependency_set_digest, SemanticIndexMetadata};
use super::source_revision::resolve_source_revision;
use super::INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID;

/// The typed evidence for one of the six Verify checks that was previously
/// outside the production report.  `incomplete` means the database did not
/// contain enough trustworthy rows to perform the check; `issues` means the
/// check completed and found a concrete inconsistency.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyCoverageCheck {
    pub completed: bool,
    pub passed: bool,
    pub issues: Vec<String>,
    pub incomplete: Vec<String>,
}

impl VerifyCoverageCheck {
    fn finish(mut self) -> Self {
        self.completed = self.incomplete.is_empty();
        self.passed = self.completed && self.issues.is_empty();
        self
    }

    pub(crate) fn is_consistent(&self) -> bool {
        self.issues.is_empty()
    }

    pub(crate) fn is_complete(&self) -> bool {
        self.incomplete.is_empty()
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
    let mut check = VerifyCoverageCheck::default();
    let mut applications = Vec::new();
    let mut statement = conn.prepare(
        "SELECT a.id, a.proposal_id, a.revision_id, r.origin_kind,
                r.proposal_id, p.proposal_set_id, c.proposal_set_id,
                ps.project_id
           FROM narrative_proposal_applications a
           JOIN narrative_apply_commits c ON c.id = a.commit_id
           LEFT JOIN narrative_proposals p ON p.id = a.proposal_id
           LEFT JOIN narrative_proposal_sets ps ON ps.id = p.proposal_set_id
           LEFT JOIN narrative_proposal_revisions r ON r.id = a.revision_id
          WHERE c.project_id = ?1
          ORDER BY a.id ASC",
    )?;
    let rows = statement.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<String>>(7)?,
        ))
    })?;
    for row in rows {
        let (
            application_id,
            proposal_id,
            revision_id,
            origin_kind,
            revision_proposal_id,
            proposal_set_id,
            commit_proposal_set_id,
            proposal_set_project_id,
        ) = row?;
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
                    match resolve_source_revision(
                        conn,
                        project_id,
                        "",
                        &source_kind,
                        &source_key,
                    ) {
                        Ok(current) if current.revision_token == revision_token => {}
                        Ok(current) => check.issues.push(format!(
                            "application:{application_id}:revision:{revision_id}:artifact-revision-token-mismatch:{artifact_id}:recorded={revision_token}:current={}",
                            current.revision_token
                        )),
                        Err(error) => check.issues.push(format!(
                            "application:{application_id}:revision:{revision_id}:artifact-resolution-failed:{artifact_id}:{error}"
                        )),
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

/// Run both Semantic Index halves of the Verify contract.  V1 Edge identities
/// are the current digest input until a sealed D1 head is active.  Once a D1
/// head is active, ADR 010 makes that V2 set authoritative and V1 is only a
/// comparison surface; the legacy metadata digest must not be silently
/// compared to the differently-defined V2 declaration digest.  Generation
/// correspondence is only claimed when the active D1 head provides an
/// explicit producer generation; no Semantic Epoch or content generation is
/// guessed from `built_at`.
pub(crate) fn verify_semantic_index_checks(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<(VerifyCoverageCheck, VerifyCoverageCheck)> {
    let mut digest_check = VerifyCoverageCheck::default();
    let mut generation_check = VerifyCoverageCheck::default();
    let mut metadata_by_key = std::collections::BTreeMap::new();
    let mut statement = conn.prepare(
        "SELECT index_key, generation, built_at, source_digest,
                dependency_set_digest, dirty_cache_flag
           FROM narrative_semantic_index_metadata
          WHERE project_id = ?1
          ORDER BY index_key ASC",
    )?;
    let metadata_rows = statement
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut index_keys = metadata_rows
        .iter()
        .map(|row| row.0.clone())
        .collect::<BTreeSet<_>>();
    for (index_key, generation, built_at, source_digest, dependency_set_digest, dirty_flag) in
        metadata_rows
    {
        metadata_by_key.insert(
            index_key,
            (
                generation,
                built_at,
                source_digest,
                dependency_set_digest,
                dirty_flag,
            ),
        );
    }
    {
        let mut edge_keys = conn.prepare(
            "SELECT DISTINCT consumer_key
               FROM narrative_dependency_edges
              WHERE project_id = ?1 AND consumer_kind = 'semantic-index'",
        )?;
        for key in edge_keys.query_map(params![project_id], |row| row.get::<_, String>(0))? {
            index_keys.insert(key?);
        }
    }
    {
        // D1 is not the V1 Semantic Index authority, but an active D1 head is
        // still an explicit producer/generation claim. Include it in the
        // expected-key set so a metadata row cannot disappear while its
        // generation binding remains apparently healthy.
        let mut head_keys = conn.prepare(
            "SELECT consumer_key
               FROM narrative_dependency_declaration_heads
              WHERE project_id = ?1 AND consumer_kind = 'semantic-index'",
        )?;
        for key in head_keys.query_map(params![project_id], |row| row.get::<_, String>(0))? {
            index_keys.insert(key?);
        }
    }

    for index_key in index_keys {
        let index_label = format!("semantic-index:{index_key}");
        let Some((generation, built_at, source_digest, dependency_set_digest, dirty_flag)) =
            metadata_by_key.remove(&index_key)
        else {
            digest_check
                .incomplete
                .push(format!("{index_label}:metadata-missing"));
            generation_check
                .incomplete
                .push(format!("{index_label}:generation-cache-missing"));
            continue;
        };
        if generation < 0 {
            generation_check
                .issues
                .push(format!("{index_label}:generation-negative:{generation}"));
        }
        if !is_canonical_instant(&built_at) {
            digest_check
                .issues
                .push(format!("{index_label}:built-at-invalid:{built_at}"));
        }
        if source_digest.trim().is_empty() || dependency_set_digest.trim().is_empty() {
            digest_check
                .incomplete
                .push(format!("{index_label}:metadata-digest-missing"));
        }
        if dirty_flag != 0 && dirty_flag != 1 {
            digest_check.issues.push(format!(
                "{index_label}:dirty-cache-flag-invalid:{dirty_flag}"
            ));
        }

        let metadata = SemanticIndexMetadata {
            generation,
            built_at,
            source_digest,
            dependency_set_digest,
            dirty_cache_flag: dirty_flag == 1,
        };

        let mut edge_identities = Vec::new();
        let mut edge_statement = conn.prepare(
            "SELECT source_object_identity
               FROM narrative_dependency_edges
              WHERE project_id = ?1
                AND consumer_kind = 'semantic-index'
                AND consumer_key = ?2
              ORDER BY source_object_identity ASC",
        )?;
        let edge_rows = edge_statement.query_map(params![project_id, index_key], |row| {
            row.get::<_, String>(0)
        })?;
        for edge_row in edge_rows {
            edge_identities.push(edge_row?);
        }

        let d1 = read_active_dependency_declaration_set_in_tx(
            conn,
            project_id,
            "semantic-index",
            &index_key,
        )?;
        let active_v2 = matches!(&d1, ActiveDependencyDeclarationSetRead::Active(_));
        let (declared_generation, declaration_identities) = match d1 {
            ActiveDependencyDeclarationSetRead::Active(active) => (
                Some(active.producer_generation),
                active
                    .entries
                    .into_iter()
                    .map(|entry| entry.source_object_identity)
                    .collect::<Vec<_>>(),
            ),
            ActiveDependencyDeclarationSetRead::Missing => {
                generation_check
                    .incomplete
                    .push(format!("{index_label}:generation-binding-missing"));
                (None, Vec::new())
            }
            ActiveDependencyDeclarationSetRead::Corrupt => {
                generation_check
                    .incomplete
                    .push(format!("{index_label}:generation-binding-corrupt"));
                digest_check
                    .incomplete
                    .push(format!("{index_label}:dependency-declaration-corrupt"));
                (None, Vec::new())
            }
        };

        if let Some(current_generation) = declared_generation {
            if metadata.generation != current_generation {
                generation_check.issues.push(format!(
                    "{index_label}:generation-mismatch:metadata={}:current={current_generation}",
                    metadata.generation
                ));
            }
        }

        if metadata.dirty_cache_flag {
            digest_check
                .issues
                .push(format!("{index_label}:dirty-cache-flag-set"));
        }

        if active_v2 {
            // ADR 010 §14: an active V2 head selects only its sealed set;
            // V1 is retained for comparison and may not become the hidden
            // source of truth.  The Semantic Index metadata table predates
            // that cutover and stores the V1 identity-set digest, while D1's
            // digest includes dependency key and selector digest.  There is
            // no writer/migration binding those two meanings yet, so the
            // check remains explicitly incomplete instead of comparing
            // unlike values or treating equality as proof.
            if !edge_identities.is_empty() {
                let mut declaration_identities = declaration_identities.clone();
                let mut edge_identities = edge_identities.clone();
                declaration_identities.sort();
                edge_identities.sort();
                declaration_identities.dedup();
                edge_identities.dedup();
                if declaration_identities != edge_identities {
                    digest_check
                        .issues
                        .push(format!("{index_label}:v1-v2-dependency-set-mismatch"));
                }
            }
            let binding_missing =
                format!("{index_label}:v2-semantic-index-metadata-binding-missing");
            // The metadata row may happen to contain the same numeric
            // generation as the D1 head, but without a production Index
            // writer that equality is not an owned binding. Keep both
            // halves incomplete until one transaction records the cache
            // generation and the declaration digest together.
            digest_check.incomplete.push(binding_missing.clone());
            generation_check.incomplete.push(binding_missing);
            continue;
        }

        // An empty V1 Edge set is still a known set: the canonical digest
        // helper defines a stable digest for zero identities.  Do not turn a
        // valid empty index into an evidence hole; the missing production
        // Index owner is represented by the static two-check coverage gap
        // and, when a D1 head exists, the explicit binding diagnostic above.
        let current_digest = compute_dependency_set_digest(&edge_identities);
        if metadata.dependency_set_digest != current_digest {
            digest_check.issues.push(format!(
                "{index_label}:dependency-set-digest-mismatch:metadata={}:current={current_digest}",
                metadata.dependency_set_digest
            ));
        }
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
    let mut check = VerifyCoverageCheck::default();
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
