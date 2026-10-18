//! The parts of the frozen fixture the harness reads: how to build each
//! variant's workspace and which requests to make. The expectations
//! (`requests[].expected`) are never read here; the scorer reads them from the
//! fixture file and the harness has no reason to look at them.

use anyhow::{Context, Result};
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
