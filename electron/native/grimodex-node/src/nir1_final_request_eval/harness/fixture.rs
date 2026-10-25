//! The parts of the frozen fixture the harness reads: how to build each
//! variant's workspace and which requests to make. The expectations
//! (`requests[].expected`) are never read here; the scorer reads them from the
//! fixture file and the harness has no reason to look at them.

use std::collections::{HashMap, HashSet};

use anyhow::{bail, ensure, Context, Result};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Route {
    pub(super) model: String,
    pub(super) context_window_tokens: u32,
    pub(super) output_tokens: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Isolation {
    pub(super) workspace_id: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct Project {
    #[serde(rename = "logicalId")]
    pub(super) logical_id: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct SceneSpec {
    #[serde(rename = "logicalId")]
    pub(super) logical_id: String,
    pub(super) role: String,
    pub(super) title: String,
    pub(super) body: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct EntitySpec {
    #[serde(rename = "logicalId")]
    pub(super) logical_id: String,
    #[serde(rename = "type")]
    pub(super) type_slug: String,
    pub(super) name: String,
    pub(super) summary: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct CaseSetup {
    pub(super) project: Project,
    pub(super) scenes: Vec<SceneSpec>,
    #[serde(rename = "codexEntities")]
    pub(super) codex_entities: Vec<EntitySpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Step {
    pub(super) stage: u32,
    pub(super) op: String,
    #[serde(default)]
    pub(super) revision: Option<String>,
    #[serde(default)]
    pub(super) entity: Option<String>,
    #[serde(default)]
    pub(super) anchor_scene: Option<String>,
    #[serde(default)]
    pub(super) proposal_key: Option<String>,
    #[serde(default)]
    pub(super) decision: Option<String>,
    #[serde(default)]
    pub(super) decision_json: Option<Value>,
    #[serde(default)]
    pub(super) created_by: Option<String>,
    #[serde(default)]
    pub(super) write: Option<String>,
    #[serde(default)]
    pub(super) add_timeline_ref: Option<String>,
    #[serde(default)]
    pub(super) summary: Option<String>,
    #[serde(default)]
    pub(super) binding: Option<String>,
    /// `scene-scope-unknown`: the negative-anchor Scene whose Scope turns unknown.
    #[serde(default)]
    pub(super) scene: Option<String>,
    /// `scene-scope-unknown`: the reason of the unresolved query identity.
    #[serde(default)]
    pub(super) unresolved_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatSessionSpec {
    pub(super) stage: u32,
    pub(super) node_scene: String,
    pub(super) title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeValueSpec {
    pub(super) kind: String,
    pub(super) logical_id: String,
    pub(super) stage: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VariantSetup {
    pub(super) steps: Vec<Step>,
    pub(super) chat_sessions: Vec<ChatSessionSpec>,
    #[serde(default)]
    pub(super) runtime_values: Vec<RuntimeValueSpec>,
    #[serde(default)]
    pub(super) codex_entities: Vec<EntitySpec>,
    /// A reject variant's own negative-anchor Scene (fixture version 2 and
    /// later; DR-DPH-99).
    #[serde(default)]
    pub(super) scenes: Vec<SceneSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RequestSpec {
    pub(super) stage: u32,
    pub(super) revision_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VariantSpec {
    pub(super) variant_id: String,
    pub(super) kind: String,
    #[serde(default)]
    pub(super) ineligible_logical_id: Option<String>,
    pub(super) setup: VariantSetup,
    pub(super) requests: Vec<RequestSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CaseSpec {
    pub(super) case_id: String,
    pub(super) user_message: String,
    pub(super) isolation: Isolation,
    pub(super) setup: CaseSetup,
    pub(super) variants: Vec<VariantSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SceneScopeSpec {
    pub(super) registry: Value,
    pub(super) per_scene: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SetupContract {
    pub(super) scene_scope: SceneScopeSpec,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Fixture {
    pub(super) fixture_version: u32,
    pub(super) estimator_version: String,
    pub(super) route: Route,
    pub(super) setup_contract: SetupContract,
    pub(super) cases: Vec<CaseSpec>,
    #[serde(default)]
    pub(super) diagnostic_cases: Vec<Value>,
}

impl Fixture {
    pub(super) fn parse(text: &str) -> Result<Self> {
        serde_json::from_str(text).context("the final-request fixture does not parse")
    }
}

impl CaseSpec {
    pub(super) fn anchor_scene(&self) -> Result<&SceneSpec> {
        self.setup
            .scenes
            .iter()
            .find(|scene| scene.role == "anchor")
            .with_context(|| format!("{} has no anchor scene", self.case_id))
    }
}

impl VariantSpec {
    /// The `revisionIds` of a request as logical ids.
    pub(super) fn request_for_stage(&self, stage: u32) -> Result<&RequestSpec> {
        self.requests
            .iter()
            .find(|request| request.stage == stage)
            .with_context(|| format!("{} has no request for stage {stage}", self.variant_id))
    }

    pub(super) fn stages(&self) -> Vec<u32> {
        let mut stages: Vec<u32> = self.requests.iter().map(|request| request.stage).collect();
        stages.sort_unstable();
        stages.dedup();
        stages
    }
}

/// The first fixture version that may declare a negative-anchor Scene and use
/// `scene-scope-unknown` (contract.mjs `FIXTURE_VERSIONS[2].negativeAnchors`).
pub(super) const NEGATIVE_ANCHOR_MIN_VERSION: u32 = 2;
pub(super) const NEGATIVE_ANCHOR_ROLE: &str = "negative-anchor";
pub(super) const SCENE_SCOPE_UNKNOWN_WRITE: &str = "scene-scope-unknown";
/// The writes an `invalidate-negative` or `binding-change` step may name
/// (contract.mjs `SETUP_WRITE_KINDS`).
pub(super) const SETUP_WRITE_KINDS: [&str; 4] = [
    "scene-scope-registry-update",
    "codex-update",
    "decision-cancel",
    SCENE_SCOPE_UNKNOWN_WRITE,
];

/// The setup shapes of one variant, checked before any workspace is built
/// (the same rules as contract.mjs `validateSetupShapes`, DR-DPH-100): a
/// negative-anchor Scene belongs to a reject variant only and is its
/// negative's anchor; `scene-scope-unknown` invalidates that negative and never
/// touches the case's anchor or query (the positive Revisions would fail A3).
pub(super) fn validate_variant_setup(
    fixture: &Fixture,
    case: &CaseSpec,
    variant: &VariantSpec,
) -> Result<()> {
    let label = format!("{}/{}", case.case_id, variant.variant_id);
    let steps = &variant.setup.steps;
    let uses_unknown = steps
        .iter()
        .any(|step| step.write.as_deref() == Some(SCENE_SCOPE_UNKNOWN_WRITE));
    if fixture.fixture_version < NEGATIVE_ANCHOR_MIN_VERSION {
        ensure!(
            variant.setup.scenes.is_empty() && !uses_unknown,
            "NIR1_EVAL_SETUP_SHAPE: {label}: fixture version {} may not declare a negative-anchor Scene or use {SCENE_SCOPE_UNKNOWN_WRITE}",
            fixture.fixture_version
        );
        return Ok(());
    }
    let case_scene = |role: &str| {
        case.setup
            .scenes
            .iter()
            .find(|scene| scene.role == role)
            .map(|scene| scene.logical_id.as_str())
    };
    let (case_anchor, case_query) = (case_scene("anchor"), case_scene("query"));
    ensure!(
        variant.setup.scenes.len() <= 1,
        "NIR1_EVAL_SETUP_SHAPE: {label}: at most one negative-anchor Scene"
    );
    let mut negative_anchors = HashSet::new();
    for scene in &variant.setup.scenes {
        ensure!(
            variant.kind == "reject",
            "NIR1_EVAL_SETUP_SHAPE: {label}: only a reject variant may declare a negative-anchor Scene"
        );
        ensure!(
            scene.role == NEGATIVE_ANCHOR_ROLE
                && !scene.logical_id.is_empty()
                && !scene.title.is_empty()
                && !scene.body.is_empty(),
            "NIR1_EVAL_SETUP_SHAPE: {label}: a variant Scene must be a {NEGATIVE_ANCHOR_ROLE} with logicalId, title and body"
        );
        ensure!(
            !case
                .setup
                .scenes
                .iter()
                .any(|other| other.logical_id == scene.logical_id),
            "NIR1_EVAL_SETUP_SHAPE: {label}: {} is a Scene of the case",
            scene.logical_id
        );
        negative_anchors.insert(scene.logical_id.as_str());
    }
    let negative_prepare: HashMap<&str, &str> = steps
        .iter()
        .filter(|step| step.op == "prepare-negative")
        .filter_map(|step| Some((step.revision.as_deref()?, step.anchor_scene.as_deref()?)))
        .collect();
    let mut used = HashSet::new();
    for step in steps {
        let anchor = step.anchor_scene.as_deref();
        match step.op.as_str() {
            "prepare" => ensure!(
                !anchor.is_some_and(|scene| negative_anchors.contains(scene)),
                "NIR1_EVAL_SETUP_SHAPE: {label}: a positive Revision may not anchor the negative-anchor Scene"
            ),
            "prepare-negative" => {
                if let Some(scene) = anchor {
                    if negative_anchors.contains(scene) {
                        used.insert(scene);
                    } else {
                        ensure!(
                            Some(scene) == case_anchor,
                            "NIR1_EVAL_SETUP_SHAPE: {label}: {scene} is neither the case's anchor nor a negative-anchor Scene of the variant"
                        );
                    }
                }
            }
            "invalidate-negative" | "binding-change" => {
                let write = step.write.as_deref().unwrap_or_default();
                ensure!(
                    SETUP_WRITE_KINDS.contains(&write),
                    "NIR1_EVAL_SETUP_SHAPE: {label}: unknown setup write {write}"
                );
                if write != SCENE_SCOPE_UNKNOWN_WRITE {
                    continue;
                }
                ensure!(
                    step.op == "invalidate-negative",
                    "NIR1_EVAL_SETUP_SHAPE: {label}: {SCENE_SCOPE_UNKNOWN_WRITE} is an invalidate-negative write only"
                );
                let scene = step.scene.as_deref().unwrap_or_default();
                if Some(scene) == case_anchor || Some(scene) == case_query {
                    bail!(
                        "NIR1_EVAL_SETUP_SHAPE: {label}: {SCENE_SCOPE_UNKNOWN_WRITE} may not target the case's anchor or query Scene"
                    );
                }
                ensure!(
                    negative_anchors.contains(scene),
                    "NIR1_EVAL_SETUP_SHAPE: {label}: {SCENE_SCOPE_UNKNOWN_WRITE} must name the variant's negative-anchor Scene"
                );
                ensure!(
                    step.revision
                        .as_deref()
                        .and_then(|revision| negative_prepare.get(revision))
                        == Some(&scene),
                    "NIR1_EVAL_SETUP_SHAPE: {label}: {scene} is not the anchor of the invalidated negative"
                );
                let reason = step.unresolved_reason.as_deref().unwrap_or_default();
                ensure!(
                    !reason.is_empty() && reason.trim() == reason,
                    "NIR1_EVAL_SETUP_SHAPE: {label}: unresolvedReason must be a trimmed non-empty string"
                );
            }
            _ => {}
        }
    }
    for scene in &negative_anchors {
        ensure!(
            used.contains(scene),
            "NIR1_EVAL_SETUP_SHAPE: {label}: {scene} is not the anchor of the variant's prepare-negative step"
        );
    }
    Ok(())
}
