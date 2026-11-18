//! Reading-order parity, Rust half (chat IR S1-A2, G6 (c) layer 1).
//!
//! `src/features/codex/context/fixtures/reading-order-parity.json` is read by
//! both this test and the renderer's `readingOrderParity.test.ts`. The renderer
//! half runs `buildReadingOrder`; this half runs `derive_live_scene_projection`
//! (and the Core build that turns its order into `reading_rank`), which is the
//! function the IR admission's `query_reading_rank` comes from. The two are not
//! run together, only against one shared JSON.

use grimodex_core::narrative_project_scope_authority::build_narrative_project_scope_authority_v1;
use serde_json::Value;

use super::{derive_live_scene_projection, PersistedProjectTreeNode};

const FIXTURE: &str =
    include_str!("../../../../../../src/features/codex/context/fixtures/reading-order-parity.json");

/// The case ids the renderer half asserts (`readingOrderParity.test.ts`).
const EXPECTED_CASE_IDS: [&str; 11] = [
    "baseline-nested",
    "duplicate-sort-order-same-parent",
    "duplicate-sort-order-at-root",
    "orphan-scene",
    "scene-with-live-child",
    "note-with-live-child",
    "unknown-node-type",
    "archived-subtree",
    "mixed-case-sort-order",
    "archived-duplicate-sort-order",
    "parent-cycle",
];

fn cases() -> Vec<Value> {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture is JSON");
    fixture["cases"].as_array().expect("cases").clone()
}

fn case_id(case: &Value) -> &str {
    case["id"].as_str().expect("case id")
}

fn str_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("array")
        .iter()
        .map(|item| item.as_str().expect("string").to_owned())
        .collect()
}

fn to_nodes(case: &Value) -> Vec<PersistedProjectTreeNode> {
    case["nodes"]
        .as_array()
        .expect("nodes")
        .iter()
        .map(|node| PersistedProjectTreeNode {
            id: node["id"].as_str().expect("id").to_owned(),
            parent_id: node["parentId"].as_str().map(str::to_owned),
            node_type: node["nodeType"].as_str().expect("nodeType").to_owned(),
            sort_order: node["sortOrder"].as_str().expect("sortOrder").to_owned(),
            story_time_order: None,
            archived: node["archived"].as_bool().expect("archived"),
        })
        .collect()
}

fn scene_ids(nodes: &[PersistedProjectTreeNode]) -> Result<Vec<String>, String> {
    derive_live_scene_projection(nodes)
        .map(|scenes| scenes.into_iter().map(|scene| scene.scene_id).collect())
        .map_err(|error| error.to_string())
}

/// The row orders the callers can produce: the fixture's, reversed, and
/// `ORDER BY id` (the production read in `project_scope_authority.rs`).
fn row_orders(
    nodes: Vec<PersistedProjectTreeNode>,
) -> Vec<(&'static str, Vec<PersistedProjectTreeNode>)> {
    let mut reversed = nodes.iter().map(clone_node).collect::<Vec<_>>();
    reversed.reverse();
    let mut by_id = nodes.iter().map(clone_node).collect::<Vec<_>>();
    by_id.sort_by(|left, right| left.id.cmp(&right.id));
    vec![
        ("fixture order", nodes),
        ("reversed", reversed),
        ("by id", by_id),
    ]
}

fn clone_node(node: &PersistedProjectTreeNode) -> PersistedProjectTreeNode {
    PersistedProjectTreeNode {
        id: node.id.clone(),
        parent_id: node.parent_id.clone(),
        node_type: node.node_type.clone(),
        sort_order: node.sort_order.clone(),
        story_time_order: node.story_time_order.clone(),
        archived: node.archived,
    }
}

fn assert_expected_error(case: &Value, message: &str, context: &str) {
    let code = case["rust"]["code"].as_str().expect("rust.code");
    let reason = case["rust"]["reason"].as_str().expect("rust.reason");
    assert!(
        message.starts_with(code),
        "{context}: error does not start with {code}: {message}"
    );
    assert!(
        message.contains(reason),
        "{context}: error does not contain {reason:?}: {message}"
    );
}

#[test]
fn the_fixture_names_the_cases_the_renderer_half_asserts() {
    let cases = cases();
    let ids = cases.iter().map(case_id).collect::<Vec<_>>();
    assert_eq!(ids, EXPECTED_CASE_IDS);
    let mut rejected = 0;
    for case in &cases {
        let id = case_id(case);
        match case["rust"]["kind"].as_str().expect("rust.kind") {
            "order" => assert_eq!(
                str_list(&case["ts"]["readingOrder"]),
                str_list(&case["rust"]["sceneIds"]),
                "{id}: where Rust returns an order it must equal the renderer's"
            ),
            "error" => rejected += 1,
            other => panic!("{id}: unknown rust.kind {other}"),
        }
    }
    // The renderer half asserts the same count.
    assert_eq!(rejected, 7);
}

#[test]
fn derive_live_scene_projection_agrees_with_the_shared_fixture() {
    for case in cases() {
        let id = case_id(&case);
        let result = scene_ids(&to_nodes(&case));
        match case["rust"]["kind"].as_str().expect("rust.kind") {
            "order" => assert_eq!(
                result.unwrap_or_else(|message| panic!("{id}: {message}")),
                str_list(&case["rust"]["sceneIds"]),
                "{id}"
            ),
            _ => {
                let message = result.expect_err(id);
                assert_expected_error(&case, &message, id);
            }
        }
    }
}

#[test]
fn the_derived_result_does_not_depend_on_the_row_order() {
    for case in cases() {
        let id = case_id(&case);
        for (label, nodes) in row_orders(to_nodes(&case)) {
            let context = format!("{id} ({label})");
            let result = scene_ids(&nodes);
            match case["rust"]["kind"].as_str().expect("rust.kind") {
                "order" => assert_eq!(
                    result.unwrap_or_else(|message| panic!("{context}: {message}")),
                    str_list(&case["rust"]["sceneIds"]),
                    "{context}"
                ),
                _ => {
                    let message = result.expect_err(&context);
                    assert_expected_error(&case, &message, &context);
                }
            }
        }
    }
}

#[test]
fn reading_rank_is_the_index_of_the_derived_order() {
    let mut checked = 0;
    for case in cases() {
        if case["rust"]["kind"].as_str() != Some("order") {
            continue;
        }
        let id = case_id(&case);
        let scenes = derive_live_scene_projection(&to_nodes(&case)).expect(id);
        let authority = build_narrative_project_scope_authority_v1("p1", &scenes).expect(id);
        let expected = str_list(&case["rust"]["sceneIds"]);
        assert_eq!(authority.mappings.len(), expected.len(), "{id}");
        for (index, scene_id) in expected.iter().enumerate() {
            let mapping = authority
                .mappings
                .iter()
                .find(|mapping| mapping.scene_ref == format!("scene:{scene_id}"))
                .unwrap_or_else(|| panic!("{id}: no mapping for {scene_id}"));
            assert_eq!(mapping.reading_rank, index as u64, "{id}: {scene_id}");
            assert_eq!(
                mapping.source_key,
                format!("project:scene:{scene_id}"),
                "{id}"
            );
            checked += 1;
        }
    }
    assert!(checked > 0, "no order case was checked");
}
