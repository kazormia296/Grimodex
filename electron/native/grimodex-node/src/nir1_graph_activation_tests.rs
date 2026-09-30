use super::*;

#[tokio::test]
async fn direct_native_graph_requests_cannot_reach_the_unactivated_reader() {
    let root = std::env::temp_dir().join(format!("nir1-graph-gate-{}", uuid::Uuid::new_v4()));
    let backend = Backend::new(root.to_string_lossy().into_owned(), None, None)
        .expect("create backend without a workspace");
    for payload in [
        serde_json::json!({
            "expectedWorkspacePath": "/must-not-be-opened",
            "projectId": "project",
            "querySceneId": "scene",
            "seedEntityId": "entity",
        }),
        serde_json::json!({ "testTransport": true, "qualified": true }),
        serde_json::Value::Null,
    ] {
        let error = backend
            .nir1_graph_query(payload)
            .await
            .expect_err("internal implementation cannot authorize product Graph");
        assert_eq!(error.reason, "NIR1_GRAPH_NOT_ACTIVATED");
    }
    drop(backend);
    let _ = std::fs::remove_dir_all(root);
}
