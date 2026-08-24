//! Native Chronicle Human Derivation writer (NIR-0 C2A).
//!
//! This is intentionally a dormant persistence writer: it validates a typed
//! request, consumes the D1 sealed declaration head, and appends an immutable
//! revision.  It does not promote `current_revision_id`, create a child D1
//! declaration, or initialize Semantic Epoch/Freshness state (those are C2B
//! responsibilities).

use anyhow::{anyhow, Context};
use grimodex_core::narrative_ir::{
    classify_chronicle_scene_event_changes, derive_chronicle_scene_event_scope,
    validate_chronicle_scene_event_proposal_payload, validate_chronicle_scene_event_v2,
    ChronicleChangeDisposition, CHRONICLE_EVENT_PROPOSAL_KIND,
};
use grimodex_core::{canonical_json_digest, canonical_json_string};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

use super::declaration_storage::{
    read_active_dependency_declaration_set_in_tx, ActiveDependencyDeclarationSetRead,
};
use super::models::{
    CreateHumanDerivedRevisionRequest, NarrativeAdapterIdentity, TrustedHumanDerivationScope,
    TrustedRevealBasis, TrustedScopeBoundary, TrustedScopeInterval, TrustedUnresolvedConstraint,
};
use super::reconciliation_envelope::{
    ensure_v2_proposal_payload_digest, validate_reconciliation_envelope, ORIGIN_ENVELOPED,
};
use super::repository::{
    ensure_proposal_not_applied, ensure_v2_proposal_evidence_binding, insert_source_basis_rows,
};
use super::task_leases::with_immediate_transaction;
use crate::narrative_runtime_policy::require_narrative_extraction_allowed;
use crate::Database;

const ADAPTER_ID: &str = "chronicle.scene-event";
const ADAPTER_VERSION: &str = "1";
const SURFACE_ID: &str = "chronicle-review";
const HUMAN_ORIGIN: &str = "enveloped";
const HUMAN_CREATED_BY: &str = "native-human";

/// Persist a Native-verified Human-derived Chronicle revision in one SQLite
/// transaction.  `trusted_project_id` is an authority boundary rather than a
/// field decoded from the request.
pub(crate) fn create_human_derived_revision(
    db: &Database,
    trusted_project_id: &str,
    request: CreateHumanDerivedRevisionRequest,
) -> anyhow::Result<Value> {
    create_human_derived_revision_with_scope(db, trusted_project_id, None, request)
}

/// Native-only scope-aware entry point.  The scope context is deliberately a
/// separate, non-Serde argument: only a trusted Native resolver may construct
/// it, and it is bound to the project, parent CAS, edited document, and the
/// stable source observation before Core derives the child Scope.
pub(crate) fn create_human_derived_revision_with_scope(
    db: &Database,
    trusted_project_id: &str,
    trusted_scope: Option<TrustedHumanDerivationScope>,
    request: CreateHumanDerivedRevisionRequest,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_extraction_allowed(conn)?;
            create_human_derived_revision_in_tx(
                conn,
                trusted_project_id,
                trusted_scope.as_ref(),
                &request,
            )
        })
    })
}

pub(super) fn create_human_derived_revision_in_tx(
    conn: &Connection,
    trusted_project_id: &str,
    trusted_scope: Option<&TrustedHumanDerivationScope>,
    request: &CreateHumanDerivedRevisionRequest,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "NEX_HUMAN_DERIVATION_TRANSACTION_REQUIRED: Human derivation requires a caller-owned transaction"
    );
    ensure_proposal_not_applied(conn, &request.proposal_id)?;

    let proposal_project: Option<String> = conn
        .query_row(
            "SELECT s.project_id
               FROM narrative_proposals p
               JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
              WHERE p.id = ?1",
            params![request.proposal_id],
            |row| row.get(0),
        )
        .optional()?;
    anyhow::ensure!(
        proposal_project.as_deref() == Some(trusted_project_id),
        "NEX_HUMAN_DERIVATION_PROJECT_MISMATCH: proposal is not owned by trusted project"
    );

    let (
        proposal_kind,
        run_id,
        current_revision_id,
        current_origin_kind,
        current_envelope_json,
        current_envelope_digest,
        current_payload_json,
    ): (
        String,
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        String,
    ) = conn.query_row(
        "SELECT p.kind, s.run_id, p.current_revision_id,
                r.origin_kind, r.reconciliation_envelope_json,
                r.reconciliation_envelope_digest, r.payload_json
           FROM narrative_proposals p
           JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
           LEFT JOIN narrative_proposal_revisions r
             ON r.id = p.current_revision_id
            AND r.proposal_id = p.id
          WHERE p.id = ?1 AND s.project_id = ?2",
        params![request.proposal_id, trusted_project_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        },
    )?;

    let current_revision_id = current_revision_id.ok_or_else(|| {
        anyhow!("NEX_PROPOSAL_REVISION_CONFLICT: proposal has no current revision")
    })?;
    anyhow::ensure!(
        current_revision_id == request.expected_current_revision_id,
        "NEX_PROPOSAL_REVISION_CONFLICT: expected current revision '{}', found '{}'",
        request.expected_current_revision_id,
        current_revision_id
    );
    anyhow::ensure!(
        request.parent_revision_id == current_revision_id,
        "NEX_REVISION_PARENT_ENVELOPE_DIGEST_CONFLICT: parent revision must be the current revision"
    );

    ensure_adapter(&request.adapter)?;
    anyhow::ensure!(
        request.surface_id == SURFACE_ID,
        "NEX_HUMAN_DERIVATION_SURFACE_UNSUPPORTED: unsupported Human review surface"
    );
    anyhow::ensure!(
        current_origin_kind == ORIGIN_ENVELOPED,
        "NEX_REVISION_PARENT_ENVELOPE_DIGEST_CONFLICT: parent revision is not enveloped"
    );

    let envelope_json = current_envelope_json.ok_or_else(|| {
        anyhow!("NEX_REVISION_PARENT_ENVELOPE_DIGEST_CONFLICT: parent envelope is missing")
    })?;
    let parent_envelope: Value = serde_json::from_str(&envelope_json)
        .context("NEX_REVISION_PARENT_ENVELOPE_DIGEST_CONFLICT: parent envelope is invalid")?;
    let envelope_kind = parent_envelope
        .pointer("/projectionBinding/proposalKind")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow!(
                "NEX_HUMAN_DERIVATION_PROPOSAL_KIND_MISMATCH: parent projectionBinding.proposalKind is missing"
            )
        })?;
    anyhow::ensure!(
        proposal_kind == envelope_kind && envelope_kind == CHRONICLE_EVENT_PROPOSAL_KIND,
        "NEX_HUMAN_DERIVATION_PROPOSAL_KIND_MISMATCH: proposal kind does not match the Chronicle Envelope"
    );
    let parent_validation = validate_reconciliation_envelope(
        conn,
        trusted_project_id,
        &run_id,
        Some(&parent_envelope),
    )?
    .ok_or_else(|| {
        anyhow!("NEX_REVISION_PARENT_ENVELOPE_DIGEST_CONFLICT: parent envelope is not V2")
    })?;
    let persisted_parent_digest = current_envelope_digest.ok_or_else(|| {
        anyhow!("NEX_REVISION_PARENT_ENVELOPE_DIGEST_CONFLICT: parent digest is missing")
    })?;
    anyhow::ensure!(
        persisted_parent_digest == request.expected_parent_envelope_digest
            && persisted_parent_digest == parent_validation.digest,
        "NEX_REVISION_PARENT_ENVELOPE_DIGEST_CONFLICT: expected parent Envelope digest does not match persisted parent"
    );

    let parent_payload: Value = serde_json::from_str(&current_payload_json)
        .context("NEX_HUMAN_DERIVATION_PAYLOAD_INVALID: parent proposal payload is invalid")?;
    validate_chronicle_scene_event_proposal_payload(&parent_payload).map_err(|error| {
        anyhow::anyhow!("NEX_HUMAN_DERIVATION_PAYLOAD_INVALID: parent payload: {error}")
    })?;
    ensure_v2_proposal_evidence_binding(&parent_envelope, &parent_payload)?;
    ensure_v2_proposal_payload_digest(&parent_envelope, &parent_payload)?;
    ensure_sealed_declaration_head(conn, trusted_project_id, &request.parent_revision_id)?;
    ensure_parent_has_dependency_edge(conn, trusted_project_id, &request.parent_revision_id)?;

    validate_chronicle_scene_event_proposal_payload(&request.proposal_payload).map_err(
        |error| anyhow::anyhow!("NEX_HUMAN_DERIVATION_PAYLOAD_INVALID: edited payload: {error}"),
    )?;

    let classification =
        classify_chronicle_scene_event_changes(&parent_payload, &request.proposal_payload)
            .map_err(|error| anyhow!("NEX_HUMAN_DERIVATION_PAYLOAD_INVALID: {error}"))?;
    anyhow::ensure!(
        classification.disposition == ChronicleChangeDisposition::Accept,
        "NEX_HUMAN_DERIVATION_UNSUPPORTED_PATH: proposal payload contains an unsupported changed path"
    );
    let derivation_kind = classification
        .derivation_kind
        .as_deref()
        .unwrap_or("projection-only");
    let changed_paths = canonical_human_changed_paths(&classification.changed_paths);

    let child_envelope = build_human_envelope(
        &parent_envelope,
        &request.proposal_payload,
        &request.adapter,
        &request.surface_id,
        &request.parent_revision_id,
        &request.expected_parent_envelope_digest,
        derivation_kind,
        &changed_paths,
        trusted_project_id,
        trusted_scope,
    )?;
    validate_chronicle_scene_event_v2(&child_envelope)
        .map_err(|error| anyhow!("NEX_HUMAN_DERIVATION_ENVELOPE_INVALID: {error}"))?;
    let validated_child =
        validate_reconciliation_envelope(conn, trusted_project_id, &run_id, Some(&child_envelope))?
            .ok_or_else(|| {
                anyhow!("NEX_HUMAN_DERIVATION_ENVELOPE_INVALID: child envelope is not V2")
            })?;
    ensure_v2_proposal_payload_digest(&child_envelope, &request.proposal_payload)?;
    ensure_v2_proposal_evidence_binding(&child_envelope, &request.proposal_payload)?;

    let revision_id = Uuid::new_v4().to_string();
    let next_revision_number: i64 = conn.query_row(
        "SELECT COALESCE(MAX(revision_number), 0) + 1
           FROM narrative_proposal_revisions
          WHERE proposal_id = ?1",
        params![request.proposal_id],
        |row| row.get(0),
    )?;
    let created_at = grimodex_core::now_rfc3339_millis();
    let payload_json = canonical_json_string(&request.proposal_payload)?;

    conn.execute(
        "INSERT INTO narrative_proposal_revisions
            (id, proposal_id, revision_number, payload_json, origin_kind,
             reconciliation_envelope_json, reconciliation_envelope_digest,
             created_at, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            revision_id,
            request.proposal_id,
            next_revision_number,
            payload_json,
            HUMAN_ORIGIN,
            validated_child.canonical_json,
            validated_child.digest,
            created_at,
            HUMAN_CREATED_BY,
        ],
    )?;
    insert_source_basis_rows(conn, &revision_id, &validated_child.source_basis)?;

    // C2A deliberately leaves the proposal's current pointer untouched.  A
    // later C2B promotion journey owns current_revision_id, child declaration
    // publication, and current-Epoch Freshness initialization.
    Ok(json!({
        "proposalId": request.proposal_id,
        "revisionId": revision_id,
        "revisionNumber": next_revision_number,
        "originKind": HUMAN_ORIGIN,
        "createdBy": HUMAN_CREATED_BY,
        "reconciliationEnvelopeDigest": validated_child.digest,
        "currentRevisionId": current_revision_id,
        "status": "unreviewed"
    }))
}

fn canonical_human_changed_paths(paths: &[String]) -> Vec<String> {
    let mut paths = paths.to_vec();
    paths.sort_by_key(|path| match path.as_str() {
        "/title" => 0,
        "/note" => 1,
        "/disclosure/secret" => 2,
        "/disclosure/revealDocumentRef" => 3,
        _ => 4,
    });
    paths
}

fn ensure_adapter(adapter: &NarrativeAdapterIdentity) -> anyhow::Result<()> {
    anyhow::ensure!(
        adapter.id == ADAPTER_ID && adapter.version == ADAPTER_VERSION,
        "NEX_HUMAN_DERIVATION_ADAPTER_UNSUPPORTED: expected {ADAPTER_ID}@{ADAPTER_VERSION}"
    );
    Ok(())
}

fn ensure_sealed_declaration_head(
    conn: &Connection,
    project_id: &str,
    parent_revision_id: &str,
) -> anyhow::Result<()> {
    let active = read_active_dependency_declaration_set_in_tx(
        conn,
        project_id,
        "proposal-revision",
        parent_revision_id,
    )?;
    anyhow::ensure!(
        matches!(active, ActiveDependencyDeclarationSetRead::Active(_)),
        "NEX_HUMAN_DERIVATION_DECLARATION_HEAD_UNAVAILABLE: parent has no sealed D1 declaration head"
    );
    Ok(())
}

fn ensure_parent_has_dependency_edge(
    conn: &Connection,
    project_id: &str,
    parent_revision_id: &str,
) -> anyhow::Result<()> {
    let edge_count: i64 = conn.query_row(
        "SELECT COUNT(*)
           FROM narrative_dependency_edges
          WHERE project_id = ?1
            AND consumer_kind = 'proposal-revision'
            AND consumer_key = ?2",
        params![project_id, parent_revision_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        edge_count > 0,
        "NEX_HUMAN_DERIVATION_ZERO_EDGE: parent has no dependency edge"
    );
    Ok(())
}

fn build_human_envelope(
    parent: &Value,
    proposal_payload: &Value,
    adapter: &NarrativeAdapterIdentity,
    surface_id: &str,
    parent_revision_id: &str,
    expected_parent_digest: &str,
    derivation_kind: &str,
    changed_paths: &[String],
    trusted_project_id: &str,
    trusted_scope: Option<&TrustedHumanDerivationScope>,
) -> anyhow::Result<Value> {
    let mut child = parent.clone();
    let assertion_digest = child
        .pointer("/assertionDigests/assertionDigest")
        .cloned()
        .ok_or_else(|| {
            anyhow!("NEX_HUMAN_DERIVATION_ENVELOPE_INVALID: parent assertion digest missing")
        })?;
    let parent_basis = child
        .get("revisionBasis")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| {
            anyhow!("NEX_HUMAN_DERIVATION_ENVELOPE_INVALID: parent revision basis missing")
        })?;
    let object = child
        .as_object_mut()
        .ok_or_else(|| anyhow!("NEX_HUMAN_DERIVATION_ENVELOPE_INVALID: parent is not an object"))?;
    let root_interpretation_revision_id =
        if parent_basis.get("kind").and_then(Value::as_str) == Some("interpretation") {
            parent_revision_id.to_owned()
        } else {
            parent_basis
                .get("rootInterpretationRevisionId")
                .and_then(Value::as_str)
                .unwrap_or(parent_revision_id)
                .to_owned()
        };
    let parent_context = parent_basis
        .get("contextSet")
        .or_else(|| parent_basis.get("derivationContextSet"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let derivation_context = parent_context
        .into_iter()
        .map(|mut entry| {
            if let Some(entry) = entry.as_object_mut() {
                // Inherited parent Context entries are copied verbatim with
                // their true exposure (model-visible included) and an explicit
                // lineage marker to the immediate parent. Rewriting exposure
                // would alter audit provenance; the marker is what allows the
                // inherited Dependency Set to keep resolving its contextIds.
                entry.insert(
                    "inheritedFromRevisionId".to_owned(),
                    Value::String(parent_revision_id.to_owned()),
                );
            }
            entry
        })
        .collect::<Vec<_>>();
    let proposal_payload_digest = canonical_json_digest(proposal_payload)?;

    let parent_scope = parent
        .pointer("/assertion/scope")
        .ok_or_else(|| anyhow!("NEX_HUMAN_DERIVATION_SCOPE_INVALID: parent scope is missing"))?;
    let parent_scene_ref = parent_scope
        .pointer("/scene/ref")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow!("NEX_HUMAN_DERIVATION_SCOPE_INVALID: parent scene scope is missing")
        })?;
    let secret = proposal_payload
        .pointer("/disclosure/secret")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            anyhow!("NEX_HUMAN_DERIVATION_SCOPE_INVALID: disclosure.secret is invalid")
        })?;
    let trusted_scope_for_scope = if derivation_kind == "scope-override" && secret {
        let trusted_scope = trusted_scope.ok_or_else(|| {
            anyhow!(
                "NEX_HUMAN_DERIVATION_REVEAL_BASIS_UNAVAILABLE: secret scope override requires a trusted Native reveal basis"
            )
        })?;
        ensure_trusted_scope_context(
            trusted_scope,
            parent_scene_ref,
            proposal_payload,
            parent,
            parent_revision_id,
            expected_parent_digest,
            trusted_project_id,
        )?;
        Some(trusted_scope)
    } else {
        None
    };
    // C2A cannot yet materialize a scope-override child faithfully: §6.3
    // requires the child to add the scope-resolution Dependency for the
    // resolver input, refresh Scope/Registry/Oracle inputs, drop obsolete
    // Scope Dependencies, and recompute dependencySetDigest and
    // materialBasisDigest — none of which this parent-cloned Envelope does.
    // Until that materialization is wired, fail closed (after the trusted
    // scope authority-binding checks above, so a forged sidecar still
    // surfaces its specific mismatch code) instead of persisting an
    // immutable child whose Material Basis omits its own Scope inputs.
    if derivation_kind == "scope-override" {
        anyhow::bail!(
            "NEX_C2B_SCOPE_AUTHORITY_UNAVAILABLE: Native scope authority cannot yet rebuild a scope-override Material Basis; C2A persistence is rejected"
        );
    }
    let mut derivation_context = derivation_context;
    if let Some(trusted_scope) = trusted_scope_for_scope {
        derivation_context.push(json!({
            "contextId": "context:chronicle-scope-resolver",
            "inputRef": trusted_scope.source_key.clone(),
            "stageId": "chronicle_scene_event_scope_resolver",
            "exposure": "deterministic-stage",
            "selector": {"kind": "whole-source"}
        }));
    }
    let derivation_context_value = Value::Array(derivation_context);
    let derivation_context_digest = canonical_json_digest(&json!({
        "version": "chronicle.context-set/1",
        "entries": derivation_context_value.clone()
    }))?;

    let basis = json!({
        "kind": "human-derived",
        "parentRevisionId": parent_revision_id,
        "expectedParentEnvelopeDigest": expected_parent_digest,
        "parentAssertionDigest": assertion_digest,
        "rootInterpretationRevisionId": root_interpretation_revision_id,
        "derivation": {
            "adapterId": adapter.id,
            "adapterVersion": adapter.version,
            "kind": derivation_kind,
            "proposalPayloadChangedPaths": changed_paths
        },
        "revisionActor": {
            "kind": "human",
            "surfaceId": surface_id
        },
        "derivationContextSet": derivation_context_value,
        "derivationContextSetDigest": derivation_context_digest
    });
    object.insert("revisionBasis".to_owned(), basis);

    if derivation_kind == "scope-override" {
        let scene_ref = parent_scene_ref;
        let reveal_basis = if !secret {
            // Returning to a non-secret event is deterministic and does not
            // require a trusted reveal resolver or persisted authority.
            json!({"status": "not-secret"})
        } else {
            let trusted_scope = trusted_scope_for_scope.ok_or_else(|| {
                anyhow!(
                    "NEX_HUMAN_DERIVATION_REVEAL_BASIS_UNAVAILABLE: secret scope override requires a trusted Native reveal basis"
                )
            })?;
            trusted_reveal_basis_value(&trusted_scope.reveal_basis)
        };
        let derived_scope =
            derive_chronicle_scene_event_scope(scene_ref, proposal_payload, &reveal_basis)
                .map_err(|error| anyhow!("NEX_HUMAN_DERIVATION_SCOPE_INVALID: {error}"))?;
        let assertion = object
            .get_mut("assertion")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| {
                anyhow!("NEX_HUMAN_DERIVATION_SCOPE_INVALID: child assertion is missing")
            })?;
        assertion.insert("scope".to_owned(), derived_scope.scope);
        let digests = object
            .get_mut("assertionDigests")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| {
                anyhow!("NEX_HUMAN_DERIVATION_SCOPE_INVALID: child assertion digests are missing")
            })?;
        digests.insert(
            "scopeDigest".to_owned(),
            Value::String(derived_scope.digest.clone()),
        );
        let assertion_core_digest =
            digests.get("assertionCoreDigest").cloned().ok_or_else(|| {
                anyhow!("NEX_HUMAN_DERIVATION_SCOPE_INVALID: assertion core digest is missing")
            })?;
        digests.insert(
            "assertionDigest".to_owned(),
            Value::String(canonical_json_digest(&json!({
                "assertionCoreDigest": assertion_core_digest,
                "scopeDigest": derived_scope.digest
            }))?),
        );
    }
    if let Some(binding) = object
        .get_mut("projectionBinding")
        .and_then(Value::as_object_mut)
    {
        binding.insert(
            "proposalPayloadDigest".to_owned(),
            Value::String(proposal_payload_digest),
        );
    }
    Ok(child)
}

fn ensure_trusted_scope_context(
    trusted_scope: &TrustedHumanDerivationScope,
    parent_scene_ref: &str,
    proposal_payload: &Value,
    parent_envelope: &Value,
    parent_revision_id: &str,
    expected_parent_digest: &str,
    trusted_project_id: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        trusted_scope.project_id == trusted_project_id,
        "NEX_HUMAN_DERIVATION_REVEAL_BASIS_MISMATCH: trusted reveal basis project does not match the trusted project"
    );
    anyhow::ensure!(
        trusted_scope.parent_revision_id == parent_revision_id
            && trusted_scope.expected_parent_envelope_digest == expected_parent_digest,
        "NEX_HUMAN_DERIVATION_REVEAL_BASIS_MISMATCH: trusted reveal basis is bound to another parent CAS"
    );
    anyhow::ensure!(
        trusted_scope.scene_ref == parent_scene_ref,
        "NEX_HUMAN_DERIVATION_REVEAL_BASIS_MISMATCH: trusted reveal basis scene does not match the parent"
    );
    let edited_document_ref = proposal_payload
        .pointer("/disclosure/revealDocumentRef")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            anyhow!(
                "NEX_HUMAN_DERIVATION_REVEAL_BASIS_MISMATCH: edited disclosure document is missing"
            )
        })?;
    anyhow::ensure!(
        trusted_scope.edited_document_ref == edited_document_ref,
        "NEX_HUMAN_DERIVATION_REVEAL_BASIS_MISMATCH: trusted reveal basis document does not match the edited proposal"
    );
    anyhow::ensure!(
        reveal_basis_document_ref(&trusted_scope.reveal_basis) == edited_document_ref,
        "NEX_HUMAN_DERIVATION_REVEAL_BASIS_MISMATCH: reveal basis document does not match the edited proposal"
    );

    let source_basis = parent_envelope
        .pointer("/effectiveMaterialBasis/sourceBasis")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow!("NEX_HUMAN_DERIVATION_REVEAL_BASIS_MISMATCH: parent source basis is missing")
        })?;
    let source = source_basis
        .iter()
        .find(|entry| {
            entry.pointer("/sourceKey").and_then(Value::as_str)
                == Some(trusted_scope.source_key.as_str())
        })
        .ok_or_else(|| {
            anyhow!(
                "NEX_HUMAN_DERIVATION_REVEAL_BASIS_MISMATCH: trusted source is not in the parent source basis"
            )
        })?;
    let source_revision_token = source
        .get("revisionToken")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow!(
                "NEX_HUMAN_DERIVATION_REVEAL_BASIS_MISMATCH: parent source revision token is missing"
            )
        })?;
    anyhow::ensure!(
        trusted_scope.source_revision_token == source_revision_token,
        "NEX_HUMAN_DERIVATION_REVEAL_BASIS_MISMATCH: trusted source revision token differs from the parent observation"
    );
    let source_digest = canonical_json_digest(source)?;
    anyhow::ensure!(
        trusted_scope.source_revision_digest == source_digest,
        "NEX_HUMAN_DERIVATION_REVEAL_BASIS_MISMATCH: trusted source revision digest differs from the parent observation"
    );
    Ok(())
}

fn reveal_basis_document_ref(basis: &TrustedRevealBasis) -> &str {
    match basis {
        TrustedRevealBasis::NotSecret => "",
        TrustedRevealBasis::Resolved { document_ref, .. }
        | TrustedRevealBasis::Unresolved { document_ref, .. } => document_ref,
    }
}

fn trusted_reveal_basis_value(basis: &TrustedRevealBasis) -> Value {
    match basis {
        TrustedRevealBasis::NotSecret => json!({"status": "not-secret"}),
        TrustedRevealBasis::Resolved {
            document_ref,
            audience_ref,
            reading_order,
            story_time,
        } => json!({
            "status": "resolved",
            "documentRef": document_ref,
            "audienceRef": audience_ref,
            "readingOrder": trusted_interval_value(reading_order),
            "storyTime": trusted_interval_value(story_time)
        }),
        TrustedRevealBasis::Unresolved {
            document_ref,
            audience,
            reading_order,
        } => json!({
            "status": "unresolved",
            "documentRef": document_ref,
            "audience": trusted_unresolved_value(audience),
            "readingOrder": trusted_unresolved_value(reading_order)
        }),
    }
}

fn trusted_interval_value(interval: &TrustedScopeInterval) -> Value {
    let mut value = serde_json::Map::new();
    if let Some(boundary) = &interval.from {
        value.insert("from".to_owned(), trusted_boundary_value(boundary));
    }
    if let Some(boundary) = &interval.until {
        value.insert("until".to_owned(), trusted_boundary_value(boundary));
    }
    Value::Object(value)
}

fn trusted_boundary_value(boundary: &TrustedScopeBoundary) -> Value {
    json!({
        "ref": boundary.reference,
        "inclusive": boundary.inclusive
    })
}

fn trusted_unresolved_value(constraint: &TrustedUnresolvedConstraint) -> Value {
    json!({
        "reason": constraint.reason,
        "constraintId": constraint.constraint_id
    })
}
