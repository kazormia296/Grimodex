//! AI policy evaluation — mirrors TS `parseAiPolicy` decision vectors.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiPolicyState {
    Valid,
    Missing,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiPolicyToggles {
    pub chat: bool,
    pub body_write: bool,
    pub analysis: bool,
    pub structure_write: bool,
    pub knowledge_write: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAiPolicy {
    pub state: AiPolicyState,
    pub toggles: AiPolicyToggles,
}

impl ParsedAiPolicy {
    pub fn missing() -> Self {
        Self {
            state: AiPolicyState::Missing,
            toggles: AiPolicyToggles {
                chat: true,
                body_write: true,
                analysis: true,
                structure_write: false,
                knowledge_write: false,
            },
        }
    }

    /// 値が読めない形（空・不正な JSON・未知の preset・必須の欄の欠落）。
    /// 書き込みの 3 軸は不可、会話と分析は可（判断記録の DR-A4-1）。
    pub fn invalid() -> Self {
        Self {
            state: AiPolicyState::Invalid,
            toggles: AiPolicyToggles {
                chat: true,
                body_write: false,
                analysis: true,
                structure_write: false,
                knowledge_write: false,
            },
        }
    }
}

#[derive(Debug, Error)]
pub enum PolicyLoadError {
    #[error("project row not found")]
    ProjectNotFound,
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
}

/// JavaScript の `Boolean(value)` と同じ真偽。必須の 3 欄がそろう `invalid` の会話と
/// 分析は、画面側の今の読み方の値のままにする（DR-A4-1。読めた `false` を可にしない）。
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn preset_table(preset: &str) -> Option<AiPolicyToggles> {
    let toggles = match preset {
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
        "custom" => AiPolicyToggles {
            chat: true,
            body_write: true,
            analysis: true,
            structure_write: false,
            knowledge_write: false,
        },
        _ => return None,
    };
    Some(toggles)
}

fn optional_toggle(toggles: &Map<String, Value>, key: &str, fallback: bool) -> Option<bool> {
    match toggles.get(key) {
        Some(value) => value.as_bool(),
        None => Some(fallback),
    }
}

pub fn parse_policy_json(raw: &str) -> ParsedAiPolicy {
    let Ok(root) = serde_json::from_str::<Value>(raw) else {
        return ParsedAiPolicy::invalid();
    };
    let Some(root) = root.as_object() else {
        return ParsedAiPolicy::invalid();
    };
    let Some(preset) = root.get("preset").and_then(Value::as_str) else {
        return ParsedAiPolicy::invalid();
    };
    let Some(derived) = preset_table(preset) else {
        return ParsedAiPolicy::invalid();
    };
    let Some(toggles) = root.get("toggles").and_then(Value::as_object) else {
        return ParsedAiPolicy::invalid();
    };
    let (Some(chat), Some(body_write), Some(analysis)) = (
        toggles.get("chat"),
        toggles.get("bodyWrite"),
        toggles.get("analysis"),
    ) else {
        return ParsedAiPolicy::invalid();
    };
    // ここから先で `invalid` になる値は、必須の 3 欄がそろう形。
    let invalid_toggle_values = || {
        let mut policy = ParsedAiPolicy::invalid();
        policy.toggles.chat = js_truthy(chat);
        policy.toggles.analysis = js_truthy(analysis);
        policy
    };
    let (Some(chat), Some(body_write), Some(analysis)) =
        (chat.as_bool(), body_write.as_bool(), analysis.as_bool())
    else {
        return invalid_toggle_values();
    };
    let (Some(structure_write), Some(knowledge_write)) = (
        optional_toggle(toggles, "structureWrite", derived.structure_write),
        optional_toggle(toggles, "knowledgeWrite", derived.knowledge_write),
    ) else {
        return invalid_toggle_values();
    };

    ParsedAiPolicy {
        state: AiPolicyState::Valid,
        toggles: AiPolicyToggles {
            chat,
            body_write,
            analysis,
            structure_write,
            knowledge_write,
        },
    }
}

pub fn load_policy(conn: &Connection, project_id: &str) -> Result<ParsedAiPolicy, PolicyLoadError> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT ai_policy FROM projects WHERE id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(PolicyLoadError::ProjectNotFound)?;
    Ok(raw.map_or_else(ParsedAiPolicy::missing, |json| parse_policy_json(&json)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_toggles(actual: &AiPolicyToggles, expected: &Value, label: &str) {
        assert_eq!(
            actual.chat,
            expected["chat"].as_bool().unwrap(),
            "{label} chat"
        );
        assert_eq!(
            actual.body_write,
            expected["bodyWrite"].as_bool().unwrap(),
            "{label} bodyWrite"
        );
        assert_eq!(
            actual.analysis,
            expected["analysis"].as_bool().unwrap(),
            "{label} analysis"
        );
        assert_eq!(
            actual.structure_write,
            expected["structureWrite"].as_bool().unwrap(),
            "{label} structureWrite"
        );
        assert_eq!(
            actual.knowledge_write,
            expected["knowledgeWrite"].as_bool().unwrap(),
            "{label} knowledgeWrite"
        );
    }

    #[test]
    fn decision_vector_fixture_parity() {
        let fixture = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../src/features/ai-policy/policyDecisionVector.v2.fixture.json"
        ));
        let cases: Vec<Value> = serde_json::from_str(fixture).unwrap();
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let expected_state = match case["state"].as_str().unwrap() {
                "valid" => AiPolicyState::Valid,
                "missing" => AiPolicyState::Missing,
                "invalid" => AiPolicyState::Invalid,
                other => panic!("{label}: unknown fixture state {other}"),
            };
            let parsed = match &case["raw"] {
                Value::Null => ParsedAiPolicy::missing(),
                Value::String(raw) => parse_policy_json(raw),
                other => panic!("{label}: raw must be a string or null, got {other}"),
            };
            assert_eq!(parsed.state, expected_state, "{label} state");
            assert_toggles(&parsed.toggles, &case["expected"], label);
        }
    }

    #[test]
    fn load_policy_distinguishes_null_invalid_and_missing_project_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, ai_policy TEXT);
             INSERT INTO projects VALUES ('missing', NULL);
             INSERT INTO projects VALUES ('invalid', '');",
        )
        .unwrap();

        assert_eq!(
            load_policy(&conn, "missing").unwrap().state,
            AiPolicyState::Missing
        );
        assert_eq!(
            load_policy(&conn, "invalid").unwrap().state,
            AiPolicyState::Invalid
        );
        assert!(matches!(
            load_policy(&conn, "not-found"),
            Err(PolicyLoadError::ProjectNotFound)
        ));
    }

    #[test]
    fn load_policy_preserves_database_and_column_type_errors() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(matches!(
            load_policy(&conn, "p1"),
            Err(PolicyLoadError::Database(_))
        ));
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, ai_policy INTEGER);
             INSERT INTO projects VALUES ('p1', 42);",
        )
        .unwrap();
        assert!(matches!(
            load_policy(&conn, "p1"),
            Err(PolicyLoadError::Database(_))
        ));
    }
}
