use super::{chronicle, codex, foreshadow, project, scene, snippets};
use crate::db::tests::make_simple_db;
use crate::server::{
    GrimodexServer, INVALID_POLICY_WRITE_DENIAL, PROJECT_UNAVAILABLE_WRITE_DENIAL,
};
use rmcp::model::CallToolResult;
use rmcp::ErrorData;

fn make_server(raw: Option<&str>, project_exists: bool, project_id: &str) -> GrimodexServer {
    let conn = make_simple_db();
    if project_exists {
        conn.execute(
            "INSERT INTO projects (id, title, ai_policy) VALUES ('p1', 'Novel', ?1)",
            [raw],
        )
        .unwrap();
    }
    GrimodexServer::new(
        conn,
        project_id.to_string(),
        false,
        false,
        "policy-gate-test".to_string(),
        grimodex_core::policy::ParsedAiPolicy::invalid().toggles,
    )
}

fn assert_denied(name: &str, result: Result<CallToolResult, ErrorData>, expected: &str) {
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("{name} unexpectedly accepted a write"),
    };
    let detail = format!("{error:?}");
    assert!(detail.contains(expected), "{name}: {detail}");
}

async fn assert_all_write_tools_denied(server: &GrimodexServer, expected: &str) {
    assert_denied(
        "create_snippet",
        snippets::create_snippet(
            server,
            snippets::CreateSnippetParams {
                request_id: "r1".into(),
                title: "Note".into(),
                content: None,
                scene_id: None,
            },
        )
        .await,
        expected,
    );
    assert_denied(
        "create_foreshadow",
        foreshadow::create_foreshadow(
            server,
            foreshadow::CreateForeshadowParams {
                request_id: "r2".into(),
                title: "Clue".into(),
                intent: None,
                notes: None,
                load_bearing: None,
                secret: None,
            },
        )
        .await,
        expected,
    );
    assert_denied(
        "update_foreshadow",
        foreshadow::update_foreshadow(
            server,
            foreshadow::UpdateForeshadowParams {
                request_id: "r3".into(),
                id: "f1".into(),
                base_version: 0,
                title: None,
                intent: None,
                notes: None,
                load_bearing: None,
                payoff_confirmed: None,
                abandoned: None,
                secret: None,
            },
        )
        .await,
        expected,
    );
    assert_denied(
        "propose_scene_body",
        scene::propose_scene_body(
            server,
            scene::ProposeSceneBodyParams {
                scene_id: "s1".into(),
                text: "Prose".into(),
                mode: None,
                anchor_text: None,
                anchor_position: None,
            },
        )
        .await,
        expected,
    );
    assert_denied(
        "create_codex_entry",
        codex::create_codex_entry(
            server,
            codex::CreateCodexEntryParams {
                request_id: "r4".into(),
                type_slug: "character".into(),
                name: "Alice".into(),
                aliases: None,
                summary: None,
                content: None,
                tags: None,
            },
        )
        .await,
        expected,
    );
    assert_denied(
        "update_codex_entry",
        codex::update_codex_entry(
            server,
            codex::UpdateCodexEntryParams {
                request_id: "r5".into(),
                entry_id: "e1".into(),
                base_version: 0,
                name: None,
                aliases: None,
                summary: None,
                content: None,
                tags: None,
            },
        )
        .await,
        expected,
    );
    assert_denied(
        "create_event",
        chronicle::create_event(
            server,
            chronicle::CreateEventParams {
                request_id: "r6".into(),
                title: "Event".into(),
                note: None,
                kind: None,
                primary_codex_id: None,
                location_codex_id: None,
                start_time: Some(1),
                precision: Some("exact".into()),
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                secret: None,
                reveal_scene_id: None,
                participant_codex_ids: None,
                scene_ids: None,
            },
        )
        .await,
        expected,
    );
    assert_denied(
        "update_event",
        chronicle::update_event(
            server,
            chronicle::UpdateEventParams {
                request_id: "r7".into(),
                event_id: "event-1".into(),
                base_version: 0,
                title: None,
                note: None,
                kind: None,
                primary_codex_id: None,
                location_codex_id: None,
                start_time: None,
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                precision: None,
                secret: None,
                reveal_scene_id: None,
            },
        )
        .await,
        expected,
    );
    assert_denied(
        "delete_event",
        chronicle::delete_event(
            server,
            chronicle::EventIdParams {
                request_id: "r8".into(),
                event_id: "event-1".into(),
                base_version: 0,
            },
        )
        .await,
        expected,
    );
    assert_denied(
        "stamp_scene_event",
        chronicle::stamp_scene_event(
            server,
            chronicle::SceneEventParams {
                request_id: "r9".into(),
                scene_id: "s1".into(),
                event_id: "event-1".into(),
            },
        )
        .await,
        expected,
    );
    assert_denied(
        "unstamp_scene_event",
        chronicle::unstamp_scene_event(
            server,
            chronicle::SceneEventParams {
                request_id: "r10".into(),
                scene_id: "s1".into(),
                event_id: "event-1".into(),
            },
        )
        .await,
        expected,
    );
    assert_denied(
        "set_event_participants",
        chronicle::set_event_participants(
            server,
            chronicle::SetParticipantsParams {
                request_id: "r11".into(),
                event_id: "event-1".into(),
                base_version: 0,
                codex_entry_ids: vec![],
            },
        )
        .await,
        expected,
    );
    assert_denied(
        "add_event_relation",
        chronicle::add_event_relation(
            server,
            chronicle::EventRelationParams {
                request_id: "r12".into(),
                cause_event_id: "event-1".into(),
                effect_event_id: "event-2".into(),
            },
        )
        .await,
        expected,
    );
    assert_denied(
        "remove_event_relation",
        chronicle::remove_event_relation(
            server,
            chronicle::EventRelationParams {
                request_id: "r13".into(),
                cause_event_id: "event-1".into(),
                effect_event_id: "event-2".into(),
            },
        )
        .await,
        expected,
    );
}

#[tokio::test]
async fn every_write_tool_denies_invalid_empty_and_missing_project_policy() {
    for (raw, project_exists, expected) in [
        (
            Some(
                r#"{"preset":"unknown","toggles":{"chat":true,"bodyWrite":true,"analysis":true}}"#,
            ),
            true,
            INVALID_POLICY_WRITE_DENIAL,
        ),
        (Some(""), true, INVALID_POLICY_WRITE_DENIAL),
        (None, false, PROJECT_UNAVAILABLE_WRITE_DENIAL),
    ] {
        assert_all_write_tools_denied(&make_server(raw, project_exists, "p1"), expected).await;
    }
}

#[tokio::test]
async fn read_tools_remain_available_for_invalid_or_unavailable_projects() {
    for server in [
        make_server(Some(""), true, "p1"),
        make_server(None, false, "p1"),
    ] {
        project::list_projects(&server)
            .await
            .expect("project listing is not policy-gated");
    }
}
