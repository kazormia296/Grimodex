//! DA-2b CW, M and T while the D2a stop barrier is held (NIR-1 DA-2b ST4-A
//! review P2-2; DR-DA2-54). The Native profile state is moved with the same
//! calls the product path makes (stage 4's
//! `activate_first_restricted_publication`, the startup barrier, the bounded
//! settle), and the writers are called through the N-API entries:
//!
//! * from stage 4's persist until the stop is confirmed (stage 5; Main's
//!   stages 6 and 7 follow), and during a restricted restart's startup
//!   barrier, CW is refused with `D2A_EGRESS_DENIED` (`publication is closed
//!   during startup quiescence`) and writes nothing, while M and T write;
//! * an activation that failed after stage 4 (the settle ran out of time)
//!   keeps that mixed state for the rest of the process.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;
use std::time::Duration;

use super::*;
use crate::main_grant::ConsumedProfileActivation;
use crate::Backend;

const MARKER: &str = "D2A_EGRESS_DENIED";
const QUIESCENCE: &str = "publication is closed during startup quiescence";

struct Rig {
    backend: Backend,
    root: PathBuf,
    workspace: PathBuf,
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl Rig {
    async fn new(label: &str, state_file: Option<serde_json::Value>) -> Self {
        let root = std::env::temp_dir().join(format!(
            "grimodex-d2b-typed-writers-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        if let Some(content) = state_file {
            std::fs::write(root.join("profile-egress.json"), content.to_string()).unwrap();
        }
        let backend = Backend::new(root.to_string_lossy().into_owned(), None, None).unwrap();
        let workspace = root.join("workspace");
        backend
            .open_workspace(workspace.to_string_lossy().into_owned())
            .await
            .expect("open workspace");
        let workspace = workspace.canonicalize().unwrap();
        let rig = Self {
            backend,
            root,
            workspace,
        };
        rig.seed();
        rig
    }

    fn state(&self) -> &Arc<AppState> {
        &self.backend.state
    }

    fn seed(&self) {
        let snapshot = active_workspace_snapshot(&self.state().ws).unwrap();
        snapshot
            .authority
            .db()
            .with_conn(|conn| {
                conn.execute_batch(
                    "INSERT INTO projects (id, title) VALUES ('p1', 'One');
                     INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, version)
                       VALUES ('scene-1', 'p1', 'scene', 'Scene', 'a0', 0);
                     INSERT INTO chat_sessions (id, project_id, title) VALUES ('s1', 'p1', 'First'), ('s2', 'p1', 'Second');
                     INSERT INTO chat_messages (id, session_id, role, content) VALUES ('m1', 's1', 'user', 'q');
                     INSERT INTO project_snapshots (id, project_id, name) VALUES ('snap-1', 'p1', 'S');",
                )?;
                Ok(())
            })
            .unwrap();
    }

    fn rows(&self) -> (i64, i64, String) {
        let snapshot = active_workspace_snapshot(&self.state().ws).unwrap();
        snapshot
            .authority
            .db()
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT (SELECT count(*) FROM chat_sessions),
                            (SELECT count(*) FROM chat_messages),
                            (SELECT title FROM chat_sessions WHERE id = 's1')",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?)
            })
            .unwrap()
    }

    /// A well-formed identity of this profile and workspace; whether Native
    /// accepts it is what the tests check.
    fn identity(&self) -> String {
        let status = self.state().profile_egress.status();
        serde_json::json!({
            "profileId": status.profile_id,
            "callerId": "caller",
            "callerEpoch": status.caller_epoch,
            "senderId": 7,
            "workspaceId": self.workspace.to_string_lossy(),
            "sessionId": "session",
        })
        .to_string()
    }

    fn cw(&self, extra: serde_json::Value) -> serde_json::Value {
        let mut payload = serde_json::json!({
            "expectedWorkspacePath": self.workspace.to_string_lossy(),
            "projectId": "p1",
        });
        for (key, value) in extra.as_object().unwrap() {
            payload[key] = value.clone();
        }
        payload
    }

    /// Every CW entry is refused with the barrier's reason and writes nothing.
    async fn assert_cw_closed_by_the_barrier(&self) {
        let before = self.rows();
        let identity = Some(self.identity());
        let refusals = [
            self.backend
                .chat_session_rename(
                    self.cw(serde_json::json!({ "sessionId": "s1", "title": "renamed" })),
                    identity.clone(),
                )
                .await
                .unwrap_err(),
            self.backend
                .chat_messages_delete(
                    self.cw(serde_json::json!({ "sessionId": "s1", "messageIds": ["m1"] })),
                    identity.clone(),
                )
                .await
                .unwrap_err(),
            self.backend
                .chat_session_delete(self.cw(serde_json::json!({ "sessionId": "s2" })), identity.clone())
                .await
                .unwrap_err(),
            self.backend
                .chat_project_history_clear(self.cw(serde_json::json!({})), identity.clone())
                .await
                .unwrap_err(),
            self.backend
                .chat_message_metadata_record(
                    self.cw(serde_json::json!({ "messageId": "m1", "patch": { "insertedToEditor": true } })),
                    identity,
                )
                .await
                .unwrap_err(),
        ];
        for refusal in refusals {
            assert!(refusal.reason.contains(MARKER), "{}", refusal.reason);
            assert!(refusal.reason.contains(QUIESCENCE), "{}", refusal.reason);
        }
        assert_eq!(self.rows(), before, "a refused CW call writes nothing");
    }

    /// M and T keep writing (they do not take the caller admission).
    async fn assert_m_and_t_write(&self, content: &str) {
        let created: serde_json::Value = serde_json::from_str(
            &self
                .backend
                .revision_create(serde_json::json!({
                    "projectId": "p1",
                    "entityType": "scene",
                    "entityId": "scene-1",
                    "content": content,
                    "snapshotType": "auto",
                }))
                .await
                .expect("revision_create while the barrier is held"),
        )
        .unwrap();
        assert_eq!(created["created"], true);
        let pruned: serde_json::Value = serde_json::from_str(
            &self
                .backend
                .revision_prune(serde_json::json!({
                    "projectId": "p1",
                    "entityType": "scene",
                    "entityId": "scene-1",
                    "keepCount": 100,
                }))
                .await
                .expect("revision_prune while the barrier is held"),
        )
        .unwrap();
        assert_eq!(pruned["deleted"], 0);
    }
}

// Stage 4 persisted, stage 5 not yet confirmed (an activation in flight from
// Native's stage 4 to Main's stage 7), then the confirmed stop.
#[tokio::test]
async fn from_stage_4_until_the_confirmed_stop_cw_is_closed_and_m_t_write() {
    let rig = Rig::new("stage-4", None).await;
    let status = rig
        .state()
        .profile_egress
        .activate_first_restricted_publication(&ConsumedProfileActivation::for_test(), false)
        .unwrap();
    assert!(status.restricted && !status.in_flight_stopped);
    // No caller can be registered before the stop is confirmed.
    let identity: crate::profile_egress::CallerIdentity =
        serde_json::from_str(&rig.identity()).unwrap();
    assert!(rig
        .state()
        .profile_egress
        .register_caller(&identity)
        .is_err());
    rig.assert_cw_closed_by_the_barrier().await;
    rig.assert_m_and_t_write("{\"a\":1}").await;
    let deleted: serde_json::Value = serde_json::from_str(
        &rig.backend
            .project_snapshot_delete(
                serde_json::json!({ "projectId": "p1", "snapshotId": "snap-1" }),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(deleted["deleted"], 1);

    // Stage 5 confirms the stop; a registered identity then writes.
    crate::settle_profile_egress_bounded(rig.state(), Duration::from_secs(10))
        .await
        .expect("confirm the stop");
    let identity: crate::profile_egress::CallerIdentity =
        serde_json::from_str(&rig.identity()).unwrap();
    rig.state()
        .profile_egress
        .register_caller(&identity)
        .unwrap();
    let renamed: serde_json::Value = serde_json::from_str(
        &rig.backend
            .chat_session_rename(
                rig.cw(serde_json::json!({ "sessionId": "s1", "title": "renamed" })),
                Some(rig.identity()),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(renamed["updated"], 1);
}

// A restricted restart: the startup barrier closes the publication admission
// again until it confirms the stop.
#[tokio::test]
async fn a_restricted_restart_keeps_cw_closed_until_its_startup_barrier_confirms() {
    let rig = Rig::new(
        "restart",
        Some(serde_json::json!({
            "schemaVersion": 2, "profileId": "p-restart", "callerEpoch": 3,
            "restricted": true, "handlesInvalidated": true, "inFlightStopped": true,
        })),
    )
    .await;
    // The first step of `initialize_profile_egress` (the settle).
    let status = rig.state().profile_egress.begin_startup_barrier().unwrap();
    assert!(status.restricted && !status.in_flight_stopped);
    rig.assert_cw_closed_by_the_barrier().await;
    rig.assert_m_and_t_write("{\"a\":2}").await;
    rig.state()
        .profile_egress
        .confirm_in_flight_stopped()
        .unwrap();
    let identity: crate::profile_egress::CallerIdentity =
        serde_json::from_str(&rig.identity()).unwrap();
    rig.state()
        .profile_egress
        .register_caller(&identity)
        .unwrap();
    let deleted: serde_json::Value = serde_json::from_str(
        &rig.backend
            .chat_session_delete(
                rig.cw(serde_json::json!({ "sessionId": "s2" })),
                Some(rig.identity()),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(deleted["deleted"], 1);
}

// An activation that fails after stage 4's persist (here the stop barrier
// runs out of its bound): Native stays restricted with the stop unconfirmed
// and unavailable for the rest of the process. CW stays refused, M and T
// still write: no data is lost and nothing is sent anywhere.
#[tokio::test]
async fn an_activation_failed_after_stage_4_keeps_cw_refused_and_m_t_writing() {
    let rig = Rig::new("failed-after-stage-4", None).await;
    rig.state()
        .profile_egress
        .activate_first_restricted_publication(&ConsumedProfileActivation::for_test(), false)
        .unwrap();
    let stream = rig.state().chat_streams.register("never-quiesces").unwrap();
    let error = crate::settle_profile_egress_bounded(rig.state(), Duration::from_millis(50))
        .await
        .unwrap_err();
    assert_eq!(error.reason, "PROFILE_EGRESS_UNAVAILABLE:barrier-timeout");
    rig.state().chat_streams.complete("never-quiesces", &stream);
    let status = rig.state().profile_egress.status();
    assert!(status.restricted && !status.in_flight_stopped);
    assert_eq!(status.unavailable_reason, Some("barrier-timeout"));
    rig.assert_cw_closed_by_the_barrier().await;
    rig.assert_m_and_t_write("{\"a\":3}").await;
    // The mixed state does not end within the process.
    rig.assert_cw_closed_by_the_barrier().await;
}
