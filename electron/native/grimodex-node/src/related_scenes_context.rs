use anyhow::{ensure, Result};
use grimodex_db::narrative_extraction::{RetrievalSceneSource, RetrievalSceneSourceBinding};

use crate::related_scenes_query::saved_related_scene_query;

/// A request-local source binding read from the same coherent DB snapshot as
/// IR eligibility. Profile availability is deliberately not a Raw constraint.
pub(crate) struct RelatedScenesSourceContext {
    project_id: String,
    scene_id: String,
    binding: RetrievalSceneSourceBinding,
    query: String,
}

impl RelatedScenesSourceContext {
    pub fn capture(source: RetrievalSceneSource, caller_query: &str) -> Result<Self> {
        let query = saved_related_scene_query(&source.saved_content_json);
        ensure!(
            !query.is_empty() && query == caller_query,
            "RELATED_SCENES_QUERY_SOURCE_CHANGED"
        );
        Ok(Self {
            project_id: source.project_id,
            scene_id: source.scene_id,
            binding: source.query_source,
            query,
        })
    }

    pub fn query(&self) -> &str {
        &self.query
    }
    pub fn project_id(&self) -> &str {
        &self.project_id
    }
    pub fn scene_id(&self) -> &str {
        &self.scene_id
    }

    pub fn matches(&self, current: &RetrievalSceneSource) -> bool {
        current.project_id == self.project_id
            && current.scene_id == self.scene_id
            && current.query_source == self.binding
    }
}

#[cfg(test)]
#[path = "related_scenes_context_tests.rs"]
mod tests;
