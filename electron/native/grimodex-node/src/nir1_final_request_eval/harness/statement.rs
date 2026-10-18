//! The renderer's `createSession` statement (draft: chat session を
//! `createSession` と同じ文で `db_execute` の裏の関数に restricted の前に渡す).
//!
//! The statement text and the meaning of each parameter come from
//! `evals/nir1-packing/final-request-create-session-statement.v1.json`, which
//! `src/features/chat/chatApi.createSessionStatement.test.ts` pins to what the
//! renderer's `createSession` sends. The harness builds its statement from the
//! vector and so the pinned renderer statement is the statement it runs. The
//! slot list below is the harness's own reading of the vector: when the vector
//! (and so the renderer) changes in a way the harness does not understand,
//! `statement_matches_renderer` is false and the setup receipt says so.

use anyhow::{Context, Result};
use serde_json::{json, Value};

const VECTOR: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../evals/nir1-packing/final-request-create-session-statement.v1.json"
));

/// The slots this harness knows how to fill, in statement order.
const KNOWN_SLOTS: [&str; 10] = [
    "generated-uuid",
    "project-id",
    "node-id",
    "null",
    "null",
    "title",
    "constant:0",
    "schema-default-model",
    "generated-instant",
    "generated-instant",
];

pub(super) struct CreateSessionStatement {
    pub(super) sql: String,
    pub(super) method: String,
    pub(super) params: Vec<Value>,
    pub(super) session_id: String,
    pub(super) matches_renderer: bool,
}

/// True when the vector's statement is the one this harness fills: the same
/// slots in the same order and a non-empty statement.
fn vector_is_understood(vector: &Value) -> bool {
    let slots: Vec<&str> = vector["paramSlots"]
        .as_array()
        .map(|slots| slots.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    slots == KNOWN_SLOTS
        && vector["sql"].as_str().is_some_and(|sql| !sql.is_empty())
        && vector["method"] == "all"
        && vector["schemaDefaultModel"].as_str().is_some()
}

pub(super) fn build(
    project_id: &str,
    node_id: &str,
    title: &str,
) -> Result<CreateSessionStatement> {
    let vector: Value = serde_json::from_str(VECTOR).context("statement vector does not parse")?;
    let matches_renderer = vector_is_understood(&vector);
    let session_id = uuid::Uuid::new_v4().to_string();
    let now = grimodex_core::now_rfc3339_millis();
    let model = vector["schemaDefaultModel"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let params = vec![
        json!(session_id),
        json!(project_id),
        json!(node_id),
        Value::Null,
        Value::Null,
        json!(title),
        json!(0),
        json!(model),
        json!(now),
        json!(now),
    ];
    Ok(CreateSessionStatement {
        sql: vector["sql"].as_str().unwrap_or_default().to_owned(),
        method: vector["method"].as_str().unwrap_or_default().to_owned(),
        params,
        session_id,
        matches_renderer,
    })
}
