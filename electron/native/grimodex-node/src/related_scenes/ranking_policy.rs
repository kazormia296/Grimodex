//! Compiled application policy. Requests cannot supply or override IR gates.
use anyhow::{anyhow, ensure, Result};
use serde::Deserialize;
use std::sync::OnceLock;

const SOURCE: &str =
    include_str!("../../../../../policies/narrative/nir1-related-scenes-ranking.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Policy {
    schema_version: String,
    statement_representation: String,
    ir_cosine_floors: Floors,
    ir_max_scenes: usize,
    fusion: Fusion,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Floors {
    ja: f64,
    en: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fusion {
    id: String,
    max_scenes: usize,
    max_additional_scenes: usize,
}

/// The compiled policy, checked against the values this build was written for.
fn policy() -> Result<&'static Policy> {
    static POLICY: OnceLock<Option<Policy>> = OnceLock::new();
    let policy = POLICY
        .get_or_init(|| serde_json::from_str(SOURCE).ok())
        .as_ref()
        .ok_or_else(|| anyhow!("RELATED_SCENES_RANKING_POLICY_INVALID"))?;
    ensure!(
        policy.schema_version == "nir1-related-scenes-ranking/2"
            && policy.statement_representation == "ordered-json/1"
            && policy.ir_max_scenes == 8
            && policy.fusion.id == "raw-stable-one-supplement/1"
            && policy.fusion.max_scenes == 8
            && policy.fusion.max_additional_scenes == 1,
        "RELATED_SCENES_RANKING_POLICY_INVALID"
    );
    Ok(policy)
}

pub(super) fn for_language(language: &str) -> Result<(f64, usize)> {
    let policy = policy()?;
    let floor = match language {
        "ja" => policy.ir_cosine_floors.ja,
        "en" => policy.ir_cosine_floors.en,
        _ => return Err(anyhow!("RELATED_SCENES_UNSUPPORTED_LANGUAGE")),
    };
    ensure!(
        floor.is_finite() && (-1.0..=1.0).contains(&floor),
        "RELATED_SCENES_RANKING_POLICY_INVALID"
    );
    Ok((floor, policy.ir_max_scenes))
}

/// The fusion's limits, `(maxScenes, maxAdditionalScenes)`: the most Scenes a
/// Related Scenes result shows, and how many of them the IR (or a Graph-only
/// Scene) may add beyond Raw. The common extra slot of CP-3a is open while Raw
/// has fewer than `maxScenes` items and the IR added none of the
/// `maxAdditionalScenes`.
// The Graph's response assembly (CP-3a S2b) is the first caller.
#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn fusion_limits() -> Result<(usize, usize)> {
    let policy = policy()?;
    Ok((policy.fusion.max_scenes, policy.fusion.max_additional_scenes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiled_ir_policy_keeps_separate_language_gates_and_scene_cap() -> Result<()> {
        assert_eq!(for_language("ja")?, (0.813, 8));
        assert_eq!(for_language("en")?, (0.660, 8));
        for language in ["", "JA", "fr", "en-US"] {
            assert!(for_language(language).is_err());
        }
        Ok(())
    }

    #[test]
    fn compiled_fusion_limits_are_the_policy_file_values() -> Result<()> {
        assert_eq!(fusion_limits()?, (8, 1));
        // The accessor reads the same validated policy as the IR gates.
        assert_eq!(for_language("ja")?.1, fusion_limits()?.0);
        // The db crate's reader opens the common extra slot at the same count.
        assert_eq!(
            fusion_limits()?.0,
            grimodex_db::narrative_extraction::COMMON_SLOT_RAW_LIMIT
        );
        Ok(())
    }
}
