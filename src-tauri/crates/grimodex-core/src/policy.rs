//! AI policy evaluation — mirrors TS `parseAiPolicy` decision vectors.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiPolicyToggles {
    pub chat: bool,
    pub body_write: bool,
    pub analysis: bool,
    pub structure_write: bool,
    pub knowledge_write: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPolicy {
    preset: String,
    toggles: RawToggles,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawToggles {
    chat: Option<bool>,
    body_write: Option<bool>,
    analysis: Option<bool>,
    structure_write: Option<bool>,
    knowledge_write: Option<bool>,
}

fn preset_table(preset: &str) -> AiPolicyToggles {
    match preset {
        "full" => AiPolicyToggles {
            chat: true,
            body_write: true,
            analysis: true,
            structure_write: true,
            knowledge_write: true,
        },
        "assist-off" => AiPolicyToggles {
            chat: true,
            body_write: false,
            analysis: true,
            structure_write: true,
            knowledge_write: true,
        },
        "review-only" => AiPolicyToggles {
            chat: false,
            body_write: false,
            analysis: true,
            structure_write: false,
            knowledge_write: false,
        },
        "off" => AiPolicyToggles {
            chat: false,
            body_write: false,
            analysis: false,
            structure_write: false,
            knowledge_write: false,
        },
        _ => AiPolicyToggles {
            chat: true,
            body_write: true,
            analysis: true,
            structure_write: true,
            knowledge_write: true,
        },
    }
}

pub fn parse_policy_json(raw: &str) -> anyhow::Result<AiPolicyToggles> {
    let p: RawPolicy = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return Ok(preset_table("full")),
    };
    let preset = p.preset.as_str();
    if !matches!(
        preset,
        "full" | "assist-off" | "review-only" | "off" | "custom"
    ) {
        return Ok(preset_table("full"));
    }
    let derived = preset_table(preset);
    let structure_write = p.toggles.structure_write.unwrap_or_else(|| {
        if preset == "custom" {
            false
        } else {
            derived.structure_write
        }
    });
    let knowledge_write = p.toggles.knowledge_write.unwrap_or_else(|| {
        if preset == "custom" {
            false
        } else {
            derived.knowledge_write
        }
    });
    Ok(AiPolicyToggles {
        chat: p.toggles.chat.unwrap_or(derived.chat),
        body_write: p.toggles.body_write.unwrap_or(derived.body_write),
        analysis: p.toggles.analysis.unwrap_or(derived.analysis),
        structure_write,
        knowledge_write,
    })
}

pub fn load_policy(conn: &Connection, project_id: &str) -> anyhow::Result<AiPolicyToggles> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT ai_policy FROM projects WHERE id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    match raw {
        Some(json) if !json.is_empty() => parse_policy_json(&json),
        _ => Ok(preset_table("full")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_missing_knowledge_write_is_fail_closed() {
        let toggles = parse_policy_json(
            r#"{"preset":"custom","toggles":{"chat":true,"bodyWrite":true,"analysis":false,"structureWrite":true}}"#,
        )
        .unwrap();
        assert!(!toggles.knowledge_write);
    }

    #[test]
    fn decision_vector_fixture_parity() {
        let fixture = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../src/features/ai-policy/policyDecisionVector.fixture.json"
        ));
        let cases: Vec<serde_json::Value> = serde_json::from_str(fixture).unwrap();
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let raw = case["raw"].as_str().unwrap();
            let expected = &case["expected"];
            let toggles = parse_policy_json(raw).unwrap();
            assert_eq!(
                toggles.chat,
                expected["chat"].as_bool().unwrap(),
                "{label} chat"
            );
            assert_eq!(
                toggles.body_write,
                expected["bodyWrite"].as_bool().unwrap(),
                "{label} bodyWrite"
            );
            assert_eq!(
                toggles.analysis,
                expected["analysis"].as_bool().unwrap(),
                "{label} analysis"
            );
            assert_eq!(
                toggles.structure_write,
                expected["structureWrite"].as_bool().unwrap(),
                "{label} structureWrite"
            );
            assert_eq!(
                toggles.knowledge_write,
                expected["knowledgeWrite"].as_bool().unwrap(),
                "{label} knowledgeWrite"
            );
        }
    }

    #[test]
    fn full_preset_enables_knowledge_write() {
        let toggles = parse_policy_json(
            r#"{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true,"structureWrite":true,"knowledgeWrite":true}}"#,
        )
        .unwrap();
        assert!(toggles.knowledge_write);
    }
}
