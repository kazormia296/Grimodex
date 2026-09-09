use grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::narrative_extraction) struct SceneAxis {
    pub axis_used: Option<String>,
    pub fallback_reason: Option<String>,
}

/// Parity scope: scene anchor, no Codex phases, no graph overlay. This only
/// reproduces the axis choice; it does not resolve Scope constraints or grant
/// disclosure. In particular an ambiguous live story rank remains ambiguous.
pub(in crate::narrative_extraction) fn resolve(
    authority: &NarrativeProjectScopeAuthorityV1,
    mode: &str,
    s2: &str,
) -> anyhow::Result<SceneAxis> {
    anyhow::ensure!(
        ["reading", "story", "auto"].contains(&mode),
        "unknown phase resolution mode"
    );
    let target = authority
        .mappings
        .iter()
        .find(|m| m.scene_ref == format!("scene:{s2}"));
    let Some(target) = target else {
        return Ok(SceneAxis {
            axis_used: None,
            fallback_reason: Some("current-scene-missing".into()),
        });
    };
    // ADR-002 auto coverage counts explicit keys, including equal keys. The
    // authority separately records duplicate ranks as ambiguous; do not replace
    // its rank with a synthetic one merely because the query uses story axis.
    let explicit = authority
        .mappings
        .iter()
        .map(|m| {
            let story = serde_json::to_value(&m.story_time_order)?;
            let has_key = story["rawStoryKey"]
                .as_str()
                .is_some_and(|v| !v.trim().is_empty());
            Ok((m.reading_rank, has_key))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let (axis, reason) = match mode {
        "auto" if explicit.iter().all(|(_, present)| *present) => ("story", None),
        "auto" => ("reading", Some("auto-incomplete-story-coverage")),
        "story"
            if explicit
                .iter()
                .any(|(rank, present)| *rank <= target.reading_rank && *present) =>
        {
            ("story", None)
        }
        "story" => ("reading", Some("story-current-unresolved")),
        _ => ("reading", None),
    };
    Ok(SceneAxis {
        axis_used: Some(axis.into()),
        fallback_reason: reason.map(str::to_owned),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use grimodex_core::narrative_project_scope_authority::{
        build_narrative_project_scope_authority_v1, NarrativeProjectScopeAuthoritySceneInputV1,
    };
    #[test]
    fn matches_ts_adr002_scene_anchor_axis_cases() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("axis-cases.json")).expect("cases");
        for case in cases.as_array().expect("cases array") {
            let scenes = case["scenes"]
                .as_array()
                .expect("scenes")
                .iter()
                .map(|s| NarrativeProjectScopeAuthoritySceneInputV1 {
                    scene_id: s["sceneId"].as_str().expect("scene id").into(),
                    raw_story_key: s["rawStoryKey"].as_str().map(str::to_owned),
                })
                .collect::<Vec<_>>();
            let authority =
                build_narrative_project_scope_authority_v1("p1", &scenes).expect("authority");
            let actual = resolve(
                &authority,
                case["mode"].as_str().expect("mode"),
                case["s2"].as_str().expect("s2"),
            )
            .expect("resolve");
            assert_eq!(
                serde_json::to_value(actual).expect("json"),
                case["expected"],
                "{}",
                case["id"]
            );
        }
    }
}
