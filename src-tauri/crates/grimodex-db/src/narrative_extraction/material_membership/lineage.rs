use std::collections::HashSet;

use anyhow::{anyhow, ensure, Context, Result};
use grimodex_core::canonical_json_digest;
use grimodex_core::narrative_ir::{
    classify_chronicle_scene_event_changes, derive_chronicle_scene_event_scope,
    validate_chronicle_scene_event_proposal_payload, ChronicleChangeDisposition,
    CHRONICLE_EVENT_PROPOSAL_KIND,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use super::super::declaration_storage::{
    read_active_dependency_declaration_set_in_tx, ActiveDependencyDeclarationSetRead,
};
use super::super::dependency_edges::find_edges_by_consumer;
use super::super::human_derivation::canonical_human_changed_paths;
use super::super::human_material_basis::{
    resolve_human_material_basis, validate_human_material_parent_bundle,
    HumanMaterialDerivationKind, HumanMaterialParentBundle, HumanMaterialResolutionContext,
    V1PersistedEdge,
};
use super::super::human_materialization::{
    build_scope_override_material_sidecar, build_scope_override_material_sidecar_for_kind,
};
use super::super::reconciliation_envelope::{
    ensure_v2_proposal_payload_digest, load_source_basis_rows, validate_reconciliation_envelope,
};
use super::super::repository::ensure_v2_proposal_evidence_binding;

pub(super) struct Revision {
    pub id: String,
    pub proposal_id: String,
    set_id: String,
    pub run_id: String,
    number: i64,
    pub digest: String,
    envelope: Value,
    payload: Value,
    pub material: HumanMaterialParentBundle,
}

impl Revision {
    pub fn parent_id(&self) -> Option<&str> {
        self.envelope
            .pointer("/revisionBasis/parentRevisionId")
            .and_then(Value::as_str)
    }

    fn context(&self, child_payload: &Value) -> Result<HumanMaterialResolutionContext> {
        ensure!(
            self.envelope.pointer("/assertion/scope/scene/kind") == Some(&json!("exact")),
            "exact Scene required"
        );
        Ok(HumanMaterialResolutionContext {
            project_id: self.material.project_id.clone(),
            parent_revision_id: self.id.clone(),
            expected_parent_owning_run_id: self.run_id.clone(),
            expected_parent_envelope_digest: self.digest.clone(),
            scene_ref: text(&self.envelope, "/assertion/scope/scene/ref")?.into(),
            edited_document_ref: text(child_payload, "/disclosure/revealDocumentRef")?.into(),
            secret_scope: child_payload
                .pointer("/disclosure/secret")
                .and_then(Value::as_bool)
                .context("secret required")?,
        })
    }
}

fn text<'a>(value: &'a Value, pointer: &str) -> Result<&'a str> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .with_context(|| format!("missing {pointer}"))
}

fn load(conn: &Connection, project: &str, id: &str) -> Result<Option<Revision>> {
    let row = conn
        .query_row(
            "SELECT p.id,s.id,s.run_id,r.revision_number,r.reconciliation_envelope_digest,
          r.reconciliation_envelope_json,r.payload_json,r.origin_kind,p.kind
         FROM narrative_proposal_revisions r JOIN narrative_proposals p ON p.id=r.proposal_id
         JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id
         JOIN narrative_extraction_runs run ON run.id=s.run_id AND run.project_id=s.project_id
         WHERE r.id=?1 AND s.project_id=?2",
            params![id, project],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?,
                ))
            },
        )
        .optional()?;
    let Some((proposal_id, set_id, run_id, number, digest, envelope, payload, origin, kind)) = row
    else {
        return Ok(None);
    };
    ensure!(
        origin == "enveloped" && kind == CHRONICLE_EVENT_PROPOSAL_KIND,
        "unsupported revision binding"
    );
    let digest = digest.context("envelope digest absent")?;
    let envelope: Value = serde_json::from_str(&envelope.context("envelope absent")?)?;
    let payload: Value = serde_json::from_str(&payload.context("payload absent")?)?;
    ensure!(envelope["schemaVersion"] == 2, "Envelope V2 required");
    let validated = validate_reconciliation_envelope(conn, project, &run_id, Some(&envelope))?
        .context("envelope absent")?;
    ensure!(validated.digest == digest, "envelope digest differs");
    validate_chronicle_scene_event_proposal_payload(&payload)
        .map_err(|e| anyhow!("proposal shape: {e}"))?;
    ensure_v2_proposal_payload_digest(&envelope, &payload)?;
    ensure_v2_proposal_evidence_binding(&envelope, &payload)?;
    let ActiveDependencyDeclarationSetRead::Active(active) =
        read_active_dependency_declaration_set_in_tx(conn, project, "proposal-revision", id)?
    else {
        return Err(anyhow!("D1 head unavailable"));
    };
    let material = HumanMaterialParentBundle {
        project_id: project.into(),
        consumer_kind: "proposal-revision".into(),
        consumer_key: id.into(),
        owning_run_id: run_id.clone(),
        expected_parent_envelope_digest: digest.clone(),
        material_basis: serde_json::from_value(envelope["effectiveMaterialBasis"].clone())?,
        source_basis: load_source_basis_rows(conn, id)?,
        active_dependency_declaration_set: active,
        persisted_v1_edges: find_edges_by_consumer(conn, project, "proposal-revision", id)?
            .into_iter()
            .map(|e| V1PersistedEdge {
                project_id: e.project_id,
                consumer_kind: e.consumer_kind,
                consumer_key: e.consumer_key,
                source_object_identity: e.source_object_identity,
                read_set_json: e.read_set_json,
                owning_run_id: e.owning_run_id,
                generated_by_transaction_id: e.generated_by_transaction_id,
            })
            .collect(),
    };
    let revision = Revision {
        id: id.into(),
        proposal_id,
        set_id,
        run_id,
        number,
        digest,
        envelope,
        payload,
        material,
    };
    validate_human_material_parent_bundle(
        &revision.material,
        &revision.context(&revision.payload)?,
    )?;
    Ok(Some(revision))
}

pub(super) fn read(conn: &Connection, project: &str, id: &str) -> Result<Option<Vec<Revision>>> {
    let Some(selected) = load(conn, project, id)? else {
        return Ok(None);
    };
    let mut seen = HashSet::from([id.to_owned()]);
    let mut chain = vec![selected];
    loop {
        let child = chain.last().context("lineage empty")?;
        match text(&child.envelope, "/revisionBasis/kind")? {
            "interpretation" => {
                ensure!(
                    child.parent_id().is_none(),
                    "interpretation parent forbidden"
                );
                break;
            }
            "human-derived" => {}
            _ => return Err(anyhow!("revision basis unsupported")),
        }
        let parent_id = child.parent_id().context("parent absent")?;
        ensure!(seen.insert(parent_id.to_owned()), "lineage cycle");
        let parent = load(conn, project, parent_id)?.context("parent unavailable")?;
        ensure!(
            parent.proposal_id == child.proposal_id
                && parent.set_id == child.set_id
                && parent.run_id == child.run_id
                && parent.number < child.number,
            "lineage identity/order mismatch"
        );
        validate_child(conn, &parent, child)?;
        chain.push(parent);
    }
    chain.reverse();
    for child in &chain[1..] {
        ensure!(
            text(
                &child.envelope,
                "/revisionBasis/rootInterpretationRevisionId"
            )? == chain[0].id,
            "root identity mismatch"
        );
    }
    Ok(Some(chain))
}

fn validate_child(conn: &Connection, parent: &Revision, child: &Revision) -> Result<()> {
    let classification = classify_chronicle_scene_event_changes(&parent.payload, &child.payload)
        .map_err(|e| anyhow!("changed payload: {e}"))?;
    ensure!(
        classification.disposition == ChronicleChangeDisposition::Accept,
        "semantic payload change rejected"
    );
    let kind = classification
        .derivation_kind
        .as_deref()
        .unwrap_or("projection-only");
    let context = parent.context(&child.payload)?;
    let parent_basis = &parent.envelope["revisionBasis"];
    let inherited = parent_basis
        .get("contextSet")
        .or_else(|| parent_basis.get("derivationContextSet"))
        .and_then(Value::as_array)
        .context("parent contexts absent")?;
    let mut contexts = inherited.clone();
    for entry in &mut contexts {
        entry
            .as_object_mut()
            .context("context shape")?
            .insert("inheritedFromRevisionId".into(), json!(parent.id));
    }
    let expected_material = match kind {
        "projection-only" => resolve_human_material_basis(
            HumanMaterialDerivationKind::ProjectionOnly,
            &parent.material,
            &context,
            None,
        )?,
        "scope-override" => {
            let controls: Vec<_> = child
                .material
                .material_basis
                .source_basis
                .iter()
                .filter(|s| child.material.material_basis.dependency_set.iter().any(|d|
                    d.role == grimodex_core::narrative_dependency::DependencyRole::ScopeResolution && d.input_ref == s.source_key))
                .collect();
            ensure!(controls.len() == 1, "scope control unavailable");
            let control = controls[0];
            let expected = if control.source_kind == "project-scope-authority" {
                ensure!(
                    control.source_key == format!("project:scope-authority:{}", context.project_id),
                    "legacy scope identity mismatch"
                );
                build_scope_override_material_sidecar(
                    &parent.material,
                    &context,
                    &control.source_key,
                    &control.revision_token,
                )?
            } else {
                ensure!(
                    control.source_kind == "scope-dependency-projection-v1",
                    "unknown scope control"
                );
                let identity = grimodex_core::narrative_scope_dependency_projection::ScopeDependencyIdentity::from_source_key(&control.source_key)?;
                ensure!(
                    identity.anchor_scene_ref == context.scene_ref
                        && identity.reveal_document_ref == context.edited_document_ref
                        && identity.secret == context.secret_scope,
                    "scope identity differs from child inputs"
                );
                super::super::scope_dependency_projection::validate_binding_in_tx(
                    conn,
                    &context.project_id,
                    &parent.run_id,
                    &identity,
                )?;
                build_scope_override_material_sidecar_for_kind(
                    &parent.material,
                    &context,
                    &control.source_kind,
                    &control.source_key,
                    &control.revision_token,
                )?
            };
            contexts.push(json!({"contextId":"context:chronicle-scope-resolver","inputRef":control.source_key,"stageId":"chronicle_scene_event_scope_resolver","exposure":"deterministic-stage","selector":{"kind":"whole-source"}}));
            resolve_human_material_basis(
                HumanMaterialDerivationKind::ScopeOverride,
                &parent.material,
                &context,
                Some(&expected),
            )?
        }
        _ => return Err(anyhow!("derivation unsupported")),
    };
    ensure!(
        expected_material.material_basis == child.material.material_basis,
        "material closure mismatch"
    );
    let root = if parent_basis["kind"] == "interpretation" {
        parent.id.as_str()
    } else {
        text(parent_basis, "/rootInterpretationRevisionId")?
    };
    let basis = json!({
        "kind":"human-derived","parentRevisionId":parent.id,"expectedParentEnvelopeDigest":parent.digest,
        "parentAssertionDigest":parent.envelope["assertionDigests"]["assertionDigest"],"rootInterpretationRevisionId":root,
        "derivation":{"adapterId":"chronicle.scene-event","adapterVersion":"1","kind":kind,"proposalPayloadChangedPaths":canonical_human_changed_paths(&classification.changed_paths)},
        "revisionActor":{"kind":"human","surfaceId":"chronicle-review"},
        "derivationContextSet":contexts,"derivationContextSetDigest":canonical_json_digest(&json!({"version":"chronicle.context-set/1","entries":contexts}))?,
    });
    let mut expected = parent.envelope.clone();
    expected["revisionBasis"] = basis;
    expected["projectionBinding"]["proposalPayloadDigest"] =
        json!(canonical_json_digest(&child.payload)?);
    expected["effectiveMaterialBasis"] = serde_json::to_value(expected_material.material_basis)?;
    if kind == "scope-override" {
        let scope = &child.envelope["assertion"]["scope"];
        if !context.secret_scope {
            let derived = derive_chronicle_scene_event_scope(
                &context.scene_ref,
                &child.payload,
                &json!({"status":"not-secret"}),
            )
            .map_err(|e| anyhow!("scope projection: {e}"))?;
            ensure!(
                *scope == derived.scope,
                "non-secret scope differs from deterministic projection"
            );
        } else {
            for axis in [
                "schemaVersion",
                "registryVersion",
                "timeline",
                "worldline",
                "scene",
                "viewpoint",
                "knowledgeHolder",
                "narrativeLayer",
            ] {
                ensure!(
                    scope[axis] == parent.envelope["assertion"]["scope"][axis],
                    "scope changed outside disclosure axes"
                );
            }
            ensure!(
                scope["audience"] == json!({"kind":"exact","ref":"reader"}),
                "secret audience invalid"
            );
        }
        expected["assertion"]["scope"] = scope.clone();
        expected["assertionDigests"]["scopeDigest"] =
            child.envelope["assertionDigests"]["scopeDigest"].clone();
        expected["assertionDigests"]["assertionDigest"] =
            child.envelope["assertionDigests"]["assertionDigest"].clone();
    }
    ensure!(
        expected == child.envelope,
        "child envelope differs from sealed derivation"
    );
    Ok(())
}
