//! DA-2 ST1 (K3/2 Positive (3), Negative (4)(5)(6)(10)(15)(16), Recovery
//! (1)〜(5), the bounds): the profile activation on a real `Backend` with no
//! workspace. The node:test `test/profile-activation.test.mjs` drives the
//! same calls through the addon.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::*;
use crate::main_grant::ConsumedProfileActivation;
use crate::Backend;

const SENDER: u32 = 7;
const WINDOW: u32 = 11;
const GATE: &str = "profile-activation";

struct Rig {
    backend: Backend,
    root: PathBuf,
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl Rig {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "grimodex-profile-activation-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let backend = Backend::new(root.to_string_lossy().into_owned(), None, None).unwrap();
        Self { backend, root }
    }

    fn with_state_file(label: &str, content: &serde_json::Value) -> Self {
        let root = std::env::temp_dir().join(format!(
            "grimodex-profile-activation-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("profile-egress.json"), content.to_string()).unwrap();
        let backend = Backend::new(root.to_string_lossy().into_owned(), None, None).unwrap();
        Self { backend, root }
    }

    fn state(&self) -> &Arc<AppState> {
        &self.backend.state
    }

    fn state_file(&self) -> PathBuf {
        self.root.join("profile-egress.json")
    }

    fn persisted(&self) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(self.state_file()).unwrap()).unwrap()
    }

    fn open_gate(&self) {
        self.backend
            .main_open_pre_publication_gate(GATE.to_string())
            .unwrap();
    }

    async fn preview(&self) -> std::result::Result<serde_json::Value, String> {
        self.backend
            .profile_activation_preview(SENDER, WINDOW)
            .await
            .map(|raw| serde_json::from_str(&raw).unwrap())
            .map_err(|error| error.reason)
    }

    fn shown_digest(preview: &serde_json::Value) -> String {
        // The digest Main computes over the strings it shows. Here the
        // strings are the preview's, unchanged.
        let shown: ProfileActivationDisplay = display();
        assert_eq!(serde_json::to_value(&shown).unwrap(), preview["display"]);
        display_digest(&shown).unwrap()
    }

    async fn issue(
        &self,
        preview: &serde_json::Value,
        digest: &str,
    ) -> std::result::Result<String, String> {
        self.backend
            .profile_activation_issue(
                preview["previewId"].as_str().unwrap().to_string(),
                SENDER,
                WINDOW,
                digest.to_string(),
            )
            .await
            .map(|raw| {
                let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
                assert_eq!(value.as_object().unwrap().len(), 1, "{value}");
                value["grantId"].as_str().unwrap().to_string()
            })
            .map_err(|error| error.reason)
    }

    async fn issued(&self) -> String {
        let preview = self.preview().await.unwrap();
        let digest = Self::shown_digest(&preview);
        self.issue(&preview, &digest).await.unwrap()
    }

    fn consume(&self, grant_id: &str) -> std::result::Result<(), String> {
        self.backend
            .profile_activation_consume(grant_id.to_string(), SENDER, WINDOW)
            .map_err(|error| error.reason)
    }

    async fn reserved(&self) {
        let grant = self.issued().await;
        self.consume(&grant).unwrap();
    }

    /// A non-stream legacy request whose transport never answers, returned
    /// once it is waiting inside `until_cancelled` (the synchronisation
    /// point: from here only the barrier's Notify wakeup can end it).
    async fn waiting_legacy_request(&self) -> tokio::task::JoinHandle<anyhow::Result<()>> {
        let before = self.state().profile_egress.legacy_waiting_for_test();
        let permit = self
            .state()
            .profile_egress
            .begin_legacy_provider_dispatch(None)
            .unwrap();
        let request = tokio::spawn(async move {
            let outcome = permit.until_cancelled(std::future::pending::<()>()).await;
            drop(permit);
            outcome
        });
        until(|| self.state().profile_egress.legacy_waiting_for_test() == before + 1).await;
        request
    }
}

/// Polls `condition` (a synchronisation point, not a fixed sleep) for up to
/// 10 s.
async fn until(condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "the condition never held");
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

/// Awaits a request ended by the barrier, with a bound so that a request
/// that is never cancelled fails the test instead of hanging it.
async fn stopped(request: tokio::task::JoinHandle<anyhow::Result<()>>) -> anyhow::Result<()> {
    tokio::time::timeout(Duration::from_secs(10), request)
        .await
        .expect("the request was never stopped")
        .unwrap()
}

fn assert_stopped_by_the_profile(outcome: anyhow::Result<()>) {
    let error = outcome.unwrap_err();
    assert!(
        format!("{error:#}").contains("D2A_EGRESS_DENIED: legacy-request-stopped"),
        "{error:#}"
    );
}

// Entrance closed (A-1, DR-DA2-1): a closed gate refuses before anything is
// read or written.
#[tokio::test]
async fn a_closed_gate_refuses_the_preview_before_anything_is_read() {
    let rig = Rig::new("closed");
    assert_eq!(
        rig.preview().await.unwrap_err(),
        "PROFILE_ACTIVATION_REFUSED:gate-closed"
    );
    // Not even a shutdown, a taken slot or a restricted profile changes the
    // reason: the gate is the first check.
    rig.state()
        .profile_egress
        .activate_first_restricted_publication(&ConsumedProfileActivation::for_test(), true)
        .unwrap();
    assert_eq!(
        rig.preview().await.unwrap_err(),
        "PROFILE_ACTIVATION_REFUSED:gate-closed"
    );
    let rig = Rig::new("closed-untouched");
    assert!(rig.preview().await.is_err());
    assert!(!rig.state_file().exists(), "no state file is written");
    assert!(rig.state().main_grant.registry.ensure_can_preview().is_ok());
    assert!(!rig.state().profile_egress.status().restricted);
}

// D-16: the disclosure is a versioned draft, and the gate that shows it is
// closed by default. Session C-1 approves the text and raises the version.
#[test]
fn the_disclosure_is_a_versioned_draft_behind_a_closed_gate() {
    // Session C-1 flips the mark and raises the version in the same change.
    assert_eq!(
        (
            PROFILE_ACTIVATION_DISCLOSURE_IS_DRAFT,
            PROFILE_ACTIVATION_DISCLOSURE_VERSION
        ),
        (true, 1)
    );
    let gate = crate::main_grant::PrePublicationGate::new();
    assert!(!gate.is_open(PrePublicationEntry::ProfileActivation));

    let shown = display();
    // The eight items of K3/2 "開示に必ず含めるもの", in order.
    let mut from = 0;
    for item in 1..=8 {
        let marker = format!("{item}. ");
        let at = shown.detail[from..]
            .find(&marker)
            .unwrap_or_else(|| panic!("item {item} is missing"));
        from += at + marker.len();
    }
    assert!(shown.detail.ends_with(&format!(
        "8. 開示の版: {PROFILE_ACTIVATION_DISCLOSURE_VERSION}"
    )));
    // Item 2: not "irreversible" but "not released by the app".
    assert!(shown.detail.contains("アプリの操作では解除できません"));
    assert!(shown.detail.contains("状態ファイルを消すと"));
    // Item 4 and 6: the refusal while an unfinished attempt remains.
    assert!(shown.detail.contains("attempt が残った会話や project"));
    // Item 5 in the K3/3 change 9 reading: the dictionary request is made but
    // nothing is fetched, and the connection to the in-app listener.
    assert!(shown
        .detail
        .contains("辞書の取得を試みますが、取得できません"));
    assert!(shown.detail.contains("127.0.0.1"));
    // The dialog: cancel is the default and the cancel button; approval needs
    // the box, whose text is part of the digest.
    assert_eq!(shown.buttons, ["取消", "有効にする"]);
    assert_eq!((shown.default_id, shown.cancel_id), (0, 0));
    assert!(!shown.checkbox_label.is_empty());
}

// P2-3: every string of the dialog is in the digest.
#[test]
fn every_string_of_the_dialog_is_in_its_digest() {
    let base = display_digest(&display()).unwrap();
    assert!(base.starts_with("sha256:"));
    let mut variants = Vec::new();
    let mut changed = display();
    changed.title = "x";
    variants.push(changed);
    let mut changed = display();
    changed.message = "x";
    variants.push(changed);
    let mut changed = display();
    changed.detail = "x";
    variants.push(changed);
    let mut changed = display();
    changed.checkbox_label = "x";
    variants.push(changed);
    let mut changed = display();
    changed.buttons = ["取消", "x"];
    variants.push(changed);
    let mut changed = display();
    changed.default_id = 1;
    variants.push(changed);
    let mut changed = display();
    changed.cancel_id = 1;
    variants.push(changed);
    for variant in &variants {
        assert_ne!(display_digest(variant).unwrap(), base, "{variant:?}");
    }
}

// Negative (5): the preview returns the previewId, the dialog text, its
// version and the time left, and nothing that names the profile, its epoch or
// a digest.
#[tokio::test]
async fn the_preview_returns_only_the_id_the_text_and_the_time_left() {
    let rig = Rig::new("preview-shape");
    rig.open_gate();
    let preview = rig.preview().await.unwrap();
    let mut keys: Vec<&str> = preview
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["disclosureVersion", "display", "expiresInMs", "previewId"]
    );
    assert_eq!(
        preview["disclosureVersion"],
        PROFILE_ACTIVATION_DISCLOSURE_VERSION
    );
    assert_eq!(preview["expiresInMs"], 60_000);
    let id = preview["previewId"].as_str().unwrap();
    assert_eq!(id.len(), 64);
    assert!(id.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let mut display_keys: Vec<&str> = preview["display"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    display_keys.sort_unstable();
    assert_eq!(
        display_keys,
        [
            "buttons",
            "cancelId",
            "checkboxLabel",
            "defaultId",
            "detail",
            "message",
            "title"
        ]
    );
    let raw = preview.to_string();
    let status = rig.state().profile_egress.status();
    assert!(!raw.contains(&status.profile_id));
    assert!(!raw.contains("sha256:"));
    assert!(!raw.contains("callerEpoch") && !raw.contains("profileId"));
    // One preview at a time, whatever the kind.
    assert_eq!(rig.preview().await.unwrap_err(), "MAIN_GRANT_BUSY");
}

// Positive (3), P2-3: the digest of the text Main showed is bound to the
// grant; a different text is refused and revokes the preview.
#[tokio::test]
async fn binds_the_dialog_text_digest_to_the_grant() {
    let rig = Rig::new("digest");
    rig.open_gate();
    let preview = rig.preview().await.unwrap();
    let mut altered = display();
    altered.detail = "外部の AI は引き続き使えます。";
    let wrong = display_digest(&altered).unwrap();
    assert_eq!(
        rig.issue(&preview, &wrong).await.unwrap_err(),
        "PROFILE_ACTIVATION_REFUSED:display-mismatch"
    );
    // The preview is revoked: the right digest no longer helps.
    let right = Rig::shown_digest(&preview);
    assert_eq!(
        rig.issue(&preview, &right).await.unwrap_err(),
        "MAIN_GRANT_REVOKED"
    );
    // A fresh preview with the shown text's digest is issued.
    let preview = rig.preview().await.unwrap();
    assert!(rig.issue(&preview, &right).await.is_ok());
    // Another sender or window cannot issue it.
    let other = rig
        .backend
        .profile_activation_issue(
            preview["previewId"].as_str().unwrap().to_string(),
            SENDER + 1,
            WINDOW,
            right.clone(),
        )
        .await
        .unwrap_err();
    assert_eq!(other.reason, "MAIN_GRANT_MISMATCH");
}

// Positive (3): preview -> issue -> consume -> commit happens once, in order,
// and leaves a restricted profile whose stop is confirmed.
#[tokio::test]
async fn the_whole_path_restricts_the_profile_once() {
    let rig = Rig::new("path");
    rig.open_gate();
    let before = rig.state().profile_egress.status();
    let grant = rig.issued().await;
    assert!(
        !rig.state_file().exists(),
        "nothing is persisted before stage 4"
    );
    rig.consume(&grant).unwrap();
    assert!(rig.state().profile_egress.license_uses_restricted_client());
    assert!(!rig.state().profile_egress.status().restricted);
    // The grant is spent: a second consume is busy (the reservation holds).
    assert_eq!(rig.consume(&grant).unwrap_err(), "MAIN_GRANT_BUSY");

    let status: serde_json::Value =
        serde_json::from_str(&rig.backend.profile_activation_commit().await.unwrap()).unwrap();
    assert_eq!(status["restricted"], true);
    assert_eq!(status["handlesInvalidated"], true);
    assert_eq!(status["inFlightStopped"], true);
    assert_eq!(status["profileId"], before.profile_id.as_str());
    assert_eq!(status["callerEpoch"], before.caller_epoch + 1);
    assert_eq!(status["legacyRequestsStopped"], 0);
    assert!(status.get("unavailableReason").is_none());
    let persisted = rig.persisted();
    assert_eq!(persisted["schemaVersion"], 2);
    assert_eq!(persisted["restricted"], true);
    assert_eq!(persisted["inFlightStopped"], true);

    // The reservation ended with the success; the slot is free again, and a
    // second activation is refused for what it is.
    assert!(!rig.state().main_grant.registry.is_reserved());
    assert_eq!(
        rig.preview().await.unwrap_err(),
        "PROFILE_ACTIVATION_REFUSED:already-restricted"
    );
    assert_eq!(
        rig.backend
            .profile_activation_commit()
            .await
            .unwrap_err()
            .reason,
        "PROFILE_ACTIVATION_REFUSED:not-reserved"
    );

    // Restart: the profile stays restricted with the same epoch.
    let restarted = Backend::new(rig.root.to_string_lossy().into_owned(), None, None).unwrap();
    let after: serde_json::Value =
        serde_json::from_str(&restarted.initialize_profile_egress().await.unwrap()).unwrap();
    assert_eq!(after["restricted"], true);
    assert_eq!(after["callerEpoch"], status["callerEpoch"]);
}

// Negative (4): no commit without a reservation, and refusals of stage 1
// close nothing.
#[tokio::test]
async fn commit_needs_the_reservation_and_stage_1_refusals_close_nothing() {
    let rig = Rig::new("refusals");
    rig.open_gate();
    assert_eq!(
        rig.backend
            .profile_activation_commit()
            .await
            .unwrap_err()
            .reason,
        "PROFILE_ACTIVATION_REFUSED:not-reserved"
    );
    assert_eq!(rig.consume("unknown").unwrap_err(), "MAIN_GRANT_NOT_FOUND");
    let grant = rig.issued().await;
    let other_window = rig
        .backend
        .profile_activation_consume(grant.clone(), SENDER, WINDOW + 1)
        .unwrap_err();
    assert_eq!(other_window.reason, "MAIN_GRANT_MISMATCH");
    assert!(!rig.state_file().exists());
    assert!(!rig.state().profile_egress.license_uses_restricted_client());
    assert_eq!(
        rig.backend
            .profile_activation_commit()
            .await
            .unwrap_err()
            .reason,
        "PROFILE_ACTIVATION_REFUSED:not-reserved"
    );
    assert!(!rig.state().profile_egress.status().restricted);
    // The right sender and window still consume it.
    rig.consume(&grant).unwrap();
}

// The binding is compared with the profile at stage 1: a profile that
// changed since the preview refuses the consume and nothing is reserved.
#[tokio::test]
async fn consume_binds_profile_epoch_and_disclosure_digest() {
    let rig = Rig::new("binding");
    rig.open_gate();
    let grant = rig.issued().await;
    // Another route restricted the profile meanwhile (only tests can).
    rig.state()
        .profile_egress
        .activate_first_restricted_publication(&ConsumedProfileActivation::for_test(), true)
        .unwrap();
    assert_eq!(rig.consume(&grant).unwrap_err(), "MAIN_GRANT_STATE_CHANGED");
    assert!(!rig.state().main_grant.registry.is_reserved());
    assert_eq!(
        rig.backend
            .profile_activation_commit()
            .await
            .unwrap_err()
            .reason,
        "PROFILE_ACTIVATION_REFUSED:not-reserved"
    );

    // Stage 4 re-checks the binding of a real token under the profile mutex.
    let rig = Rig::new("stage-4-binding");
    let status = rig.state().profile_egress.status();
    let stale = ConsumedProfileActivation::bound_for_test(
        crate::main_grant::ProfileActivationGrantPayload {
            profile_id: status.profile_id.clone(),
            caller_epoch: status.caller_epoch + 1,
            disclosure_version: PROFILE_ACTIVATION_DISCLOSURE_VERSION,
            disclosure_digest: display_digest(&display()).unwrap(),
        },
    );
    assert!(rig
        .state()
        .profile_egress
        .activate_first_restricted_publication(&stale, false)
        .is_err());
    assert!(!rig.state().profile_egress.status().restricted);
    assert!(!rig.state_file().exists());
    assert_eq!(
        rig.state().profile_egress.status().unavailable_reason,
        Some("activation-failed")
    );
    let old_version = ConsumedProfileActivation::bound_for_test(
        crate::main_grant::ProfileActivationGrantPayload {
            profile_id: status.profile_id,
            caller_epoch: status.caller_epoch,
            disclosure_version: PROFILE_ACTIVATION_DISCLOSURE_VERSION + 1,
            disclosure_digest: String::new(),
        },
    );
    assert!(rig
        .state()
        .profile_egress
        .activate_first_restricted_publication(&old_version, false)
        .is_err());
    assert!(!rig.state_file().exists());
}

// Recovery (1)〜(3): a failed persist at stage 4 keeps the admissions closed,
// reports `state-file-unwritable` without a path, and never gives the
// reservation back.
#[tokio::test]
async fn commit_after_persist_failure_keeps_admissions_closed() {
    let rig = Rig::new("persist-failure");
    rig.open_gate();
    rig.reserved().await;
    // A non-empty directory where the state file goes: the atomic replace
    // fails.
    std::fs::create_dir_all(rig.state_file().join("blocker")).unwrap();
    let error = rig.backend.profile_activation_commit().await.unwrap_err();
    assert_eq!(
        error.reason,
        "PROFILE_EGRESS_UNAVAILABLE:state-file-unwritable"
    );
    let status = rig.state().profile_egress.status();
    assert!(status.restricted, "the process fails closed");
    assert!(!status.in_flight_stopped);
    assert_eq!(status.unavailable_reason, Some("state-file-unwritable"));
    assert!(rig.state().profile_egress.begin_dispatch(None).is_err());
    assert!(rig
        .state()
        .profile_egress
        .begin_legacy_provider_dispatch(None)
        .is_err());
    // The reservation stays: no other grant, no second commit.
    assert!(rig.state().main_grant.registry.is_reserved());
    assert_eq!(rig.preview().await.unwrap_err(), "MAIN_GRANT_BUSY");
    assert_eq!(
        rig.backend
            .profile_activation_commit()
            .await
            .unwrap_err()
            .reason,
        "PROFILE_ACTIVATION_REFUSED:not-reserved"
    );
    // The file was never written: a restart is unrestricted (the activation
    // did not happen).
    std::fs::remove_dir_all(rig.state_file()).unwrap();
    let restarted = Backend::new(rig.root.to_string_lossy().into_owned(), None, None).unwrap();
    assert!(!restarted.state.profile_egress.status().restricted);
}

// The bound of stage 5 (P2-2): a dispatch that never drains fails closed with
// `barrier-timeout`, the state file stays restricted with the stop
// unconfirmed, and the next start runs the barrier again.
#[tokio::test]
async fn activation_barrier_drain_is_bounded() {
    let rig = Rig::new("stage-5-bound");
    rig.open_gate();
    // A legacy request accepted before the activation that is not
    // cancellable (it never enters `until_cancelled`).
    let stuck = rig
        .state()
        .profile_egress
        .begin_legacy_provider_dispatch(None)
        .unwrap();
    // And one of every kind that is: a chat stream that never quiesces (the
    // review's stream A), an inline stream (stream B) and a non-stream
    // request waiting on its transport.
    let chat = rig.state().chat_streams.register("chat-a").unwrap();
    let inline = rig.state().inline_ai_streams.register("inline-b").unwrap();
    let request = rig.waiting_legacy_request().await;
    rig.reserved().await;
    let started = Instant::now();
    let error = commit_bounded(rig.state(), Duration::from_millis(50))
        .await
        .unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(error.reason, "PROFILE_EGRESS_UNAVAILABLE:barrier-timeout");
    // Every kind was asked to stop although the chat stream held the wait
    // until the bound (F1), and nothing was withdrawn at the bound (F5).
    assert!(chat.abort_flag().load(std::sync::atomic::Ordering::Acquire));
    assert!(inline
        .abort_flag()
        .load(std::sync::atomic::Ordering::Acquire));
    assert!(rig.state().post_effect_abort.abort_all_pending());
    assert_stopped_by_the_profile(stopped(request).await);
    let persisted = rig.persisted();
    assert_eq!(persisted["restricted"], true);
    assert_eq!(persisted["inFlightStopped"], false);
    let status = rig.state().profile_egress.status();
    assert!(status.restricted && !status.in_flight_stopped);
    assert_eq!(status.unavailable_reason, Some("barrier-timeout"));
    assert!(rig.state().profile_egress.begin_dispatch(None).is_err());
    assert!(rig.state().main_grant.registry.is_reserved());
    drop(stuck);

    // Recovery (4): the next process repeats the barrier and confirms it.
    let restarted = Backend::new(rig.root.to_string_lossy().into_owned(), None, None).unwrap();
    let after: serde_json::Value =
        serde_json::from_str(&restarted.initialize_profile_egress().await.unwrap()).unwrap();
    assert_eq!(after["restricted"], true);
    assert_eq!(after["inFlightStopped"], true);
}

// P2-1 and D-4 (b) on the real Backend: what Main and the workspace do after
// stage 1 does not end the reservation. (The 60 s grant clock is covered by
// `reservation_survives_expiry_and_every_revoke` on a hand-driven clock.)
#[tokio::test]
async fn sender_loss_and_caller_invalidation_after_stage_1_do_not_end_the_reservation() {
    let rig = Rig::new("after-stage-1");
    rig.open_gate();
    rig.reserved().await;
    // Main's endConfirmation after stage 1, a workspace bind and a caller
    // invalidation (D-4 (b)) all leave the reservation.
    rig.backend.main_grant_revoke_sender(SENDER);
    rig.state()
        .profile_egress
        .bind_workspace(Some("/somewhere".into()));
    rig.backend.invalidate_profile_egress_callers();
    assert!(rig.state().main_grant.registry.is_reserved());
    let status: serde_json::Value =
        serde_json::from_str(&rig.backend.profile_activation_commit().await.unwrap()).unwrap();
    assert_eq!(status["restricted"], true);
}

// The startup barrier's bound (P2-2): a stream that never quiesces cannot
// hold the startup open past the bound.
#[tokio::test]
async fn startup_barrier_drain_is_bounded() {
    let rig = Rig::with_state_file(
        "startup-bound",
        &serde_json::json!({
            "schemaVersion": 2, "profileId": "p-startup", "callerEpoch": 3,
            "restricted": true, "handlesInvalidated": true, "inFlightStopped": true,
        }),
    );
    // Stream A never quiesces; stream B is in the other registry, which the
    // barrier used to reach only after A had quiesced (review F1).
    let chat = rig.state().chat_streams.register("never-quiesces").unwrap();
    let inline = rig.state().inline_ai_streams.register("inline-b").unwrap();
    let error = crate::settle_profile_egress_bounded(rig.state(), Duration::from_millis(50))
        .await
        .unwrap_err();
    assert_eq!(error.reason, "PROFILE_EGRESS_UNAVAILABLE:barrier-timeout");
    assert!(chat.abort_flag().load(std::sync::atomic::Ordering::Acquire));
    assert!(
        inline
            .abort_flag()
            .load(std::sync::atomic::Ordering::Acquire),
        "the inline stream is asked to stop although the bound ended the wait"
    );
    assert!(rig.state().post_effect_abort.abort_all_pending());
    assert!(rig.state().profile_egress.begin_dispatch(None).is_err());
    let persisted = rig.persisted();
    assert_eq!(persisted["restricted"], true);
    assert_eq!(persisted["inFlightStopped"], false);
    assert_eq!(persisted["callerEpoch"], 3);
}

// The precondition of the startup bound: at startup nothing is in flight, so
// the barrier finishes without waiting at all (a zero bound passes).
#[tokio::test]
async fn startup_barrier_without_targets_finishes_without_waiting() {
    let rig = Rig::with_state_file(
        "startup-zero",
        &serde_json::json!({
            "schemaVersion": 2, "profileId": "p-zero", "callerEpoch": 1,
            "restricted": true, "handlesInvalidated": true, "inFlightStopped": true,
        }),
    );
    // Until the barrier ends, no dispatch is admitted (no caller can be
    // registered before it).
    assert!(rig.state().profile_egress.begin_dispatch(None).is_err());
    let status: serde_json::Value = serde_json::from_str(
        &crate::settle_profile_egress_bounded(rig.state(), Duration::ZERO)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(status["inFlightStopped"], true);
    assert_eq!(status["chatStreamsStopped"], 0);
    assert_eq!(status["legacyRequestsStopped"], 0);
    assert_eq!(stop_barrier_bound(), Duration::from_secs(30));
}

// Negative (15), DR-DA2-6: an in-flight non-stream legacy request is
// cancelled by stage 5; the barrier completes within its bound and the
// request ends with the typed stop reason.
#[tokio::test]
async fn non_stream_legacy_request_is_cancelled_by_the_barrier() {
    let rig = Rig::new("legacy-cancel");
    rig.open_gate();
    // The request is already waiting on its transport (it passed the
    // generation check at the entry of `until_cancelled`), so only the
    // barrier's Notify wakeup can end it (review F5).
    let request = rig.waiting_legacy_request().await;
    rig.reserved().await;
    let status: serde_json::Value = serde_json::from_str(
        &commit_bounded(rig.state(), Duration::from_secs(10))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(status["restricted"], true);
    assert_eq!(status["inFlightStopped"], true);
    assert_eq!(status["legacyRequestsStopped"], 1);
    assert_eq!(rig.state().profile_egress.legacy_waiting_for_test(), 0);
    assert!(!rig.state().post_effect_abort.abort_all_pending());
    assert_stopped_by_the_profile(stopped(request).await);
}

// Review F2 (K3/2 "どの段の失敗も fail-closed"): a stage 4 failure still asks
// every in-flight AI work accepted before stage 2 to stop, without waiting,
// confirming or clearing.
#[tokio::test]
async fn a_stage_4_failure_still_asks_in_flight_ai_work_to_stop() {
    let rig = Rig::new("stage-4-stop");
    rig.open_gate();
    let request = rig.waiting_legacy_request().await;
    let chat = rig.state().chat_streams.register("chat-a").unwrap();
    let inline = rig.state().inline_ai_streams.register("inline-b").unwrap();
    rig.reserved().await;
    // The state file cannot be written: stage 4's persist fails.
    std::fs::create_dir_all(rig.state_file().join("blocker")).unwrap();
    let error = rig.backend.profile_activation_commit().await.unwrap_err();
    assert_eq!(
        error.reason,
        "PROFILE_EGRESS_UNAVAILABLE:state-file-unwritable"
    );
    assert_stopped_by_the_profile(stopped(request).await);
    assert!(chat.abort_flag().load(std::sync::atomic::Ordering::Acquire));
    assert!(inline
        .abort_flag()
        .load(std::sync::atomic::Ordering::Acquire));
    assert!(rig.state().post_effect_abort.abort_all_pending());
    let status = rig.state().profile_egress.status();
    assert!(status.restricted && !status.in_flight_stopped);
    // Nothing was confirmed: the streams are still registered (no wait).
    rig.state().chat_streams.complete("chat-a", &chat);
    rig.state().inline_ai_streams.complete("inline-b", &inline);
}

// Review F3: an unavailable process keeps its admissions closed. A barrier
// that ran past its bound cannot be run again into a confirmed stop, and no
// caller can be registered (recovery is a process restart, K3/2).
#[tokio::test]
async fn an_unavailable_process_refuses_a_second_barrier_and_registration() {
    let rig = Rig::with_state_file(
        "unavailable-closed",
        &serde_json::json!({
            "schemaVersion": 2, "profileId": "p-unavailable", "callerEpoch": 3,
            "restricted": true, "handlesInvalidated": true, "inFlightStopped": true,
        }),
    );
    let chat = rig.state().chat_streams.register("never-quiesces").unwrap();
    let error = crate::settle_profile_egress_bounded(rig.state(), Duration::from_millis(50))
        .await
        .unwrap_err();
    assert_eq!(error.reason, "PROFILE_EGRESS_UNAVAILABLE:barrier-timeout");
    // The stream quiesces late; a second barrier would now drain at once.
    rig.state().chat_streams.complete("never-quiesces", &chat);
    let again = crate::settle_profile_egress_bounded(rig.state(), Duration::from_secs(10))
        .await
        .unwrap_err();
    assert_eq!(again.reason, "PROFILE_EGRESS_UNAVAILABLE:barrier-timeout");
    let status = rig.state().profile_egress.status();
    assert!(status.restricted && !status.in_flight_stopped);
    assert_eq!(status.unavailable_reason, Some("barrier-timeout"));
    assert_eq!(rig.persisted()["inFlightStopped"], false);
    assert!(rig
        .state()
        .profile_egress
        .confirm_in_flight_stopped()
        .is_err());
    let identity = crate::profile_egress::CallerIdentity {
        profile_id: status.profile_id.clone(),
        caller_id: "caller".into(),
        caller_epoch: status.caller_epoch,
        sender_id: u64::from(SENDER),
        workspace_id: None,
        session_id: "session".into(),
    };
    let refused = rig
        .state()
        .profile_egress
        .register_caller(&identity)
        .unwrap_err();
    assert!(
        format!("{refused:#}").contains("unavailable"),
        "{refused:#}"
    );
    assert!(rig
        .state()
        .profile_egress
        .begin_dispatch(Some(&identity))
        .is_err());

    // Stage 4's binding failure leaves the profile unrestricted but
    // unavailable: no legacy provider permit is issued then either.
    let rig = Rig::new("unavailable-unrestricted");
    let status = rig.state().profile_egress.status();
    let stale = ConsumedProfileActivation::bound_for_test(
        crate::main_grant::ProfileActivationGrantPayload {
            profile_id: status.profile_id,
            caller_epoch: status.caller_epoch + 1,
            disclosure_version: PROFILE_ACTIVATION_DISCLOSURE_VERSION,
            disclosure_digest: display_digest(&display()).unwrap(),
        },
    );
    assert!(rig
        .state()
        .profile_egress
        .activate_first_restricted_publication(&stale, false)
        .is_err());
    assert!(!rig.state().profile_egress.status().restricted);
    assert!(rig
        .state()
        .profile_egress
        .begin_legacy_provider_dispatch(None)
        .is_err());
}

// Review F3: the barrier is single-flight. A second run while one is
// running is refused, and does not make the process unavailable.
#[tokio::test]
async fn the_stop_barrier_is_single_flight() {
    let rig = Rig::with_state_file(
        "single-flight",
        &serde_json::json!({
            "schemaVersion": 2, "profileId": "p-flight", "callerEpoch": 2,
            "restricted": true, "handlesInvalidated": true, "inFlightStopped": true,
        }),
    );
    let chat = rig.state().chat_streams.register("held").unwrap();
    let state = Arc::clone(rig.state());
    let first = tokio::spawn(async move {
        crate::settle_profile_egress_bounded(&state, Duration::from_secs(10)).await
    });
    // The first barrier has asked the stream to stop and waits for it.
    until(|| chat.abort_flag().load(std::sync::atomic::Ordering::Acquire)).await;
    let second = crate::settle_profile_egress_bounded(rig.state(), Duration::from_secs(10))
        .await
        .unwrap_err();
    assert!(
        second.reason.contains("already running"),
        "{}",
        second.reason
    );
    assert_eq!(rig.state().profile_egress.status().unavailable_reason, None);
    rig.state().chat_streams.complete("held", &chat);
    let status: serde_json::Value = serde_json::from_str(&first.await.unwrap().unwrap()).unwrap();
    assert_eq!(status["inFlightStopped"], true);
    assert_eq!(status["chatStreamsStopped"], 1);
}

// D-4 (b) with a real workspace open between stage 1 and the commit: the
// open's transition (TransitionAdmitted, the post-effect abort-all and its
// clear, the Native bind) does not end the reservation, and the commit
// passes (review F5).
#[tokio::test]
async fn a_real_workspace_open_after_stage_1_keeps_the_reservation() {
    let rig = Rig::new("open-after-stage-1");
    rig.open_gate();
    rig.reserved().await;
    rig.backend
        .open_workspace(rig.root.join("workspace").to_string_lossy().into_owned())
        .await
        .expect("open workspace");
    assert!(rig.state().main_grant.registry.is_reserved());
    assert!(!rig.state().post_effect_abort.abort_all_pending());
    let status: serde_json::Value =
        serde_json::from_str(&rig.backend.profile_activation_commit().await.unwrap()).unwrap();
    assert_eq!(status["restricted"], true);
    assert_eq!(status["inFlightStopped"], true);
    assert!(!rig.state().main_grant.registry.is_reserved());
}

// Review R2 (DR-DA2-20): a workspace open that completes while the stop is
// unconfirmed (here after the bound) does not withdraw the barrier's
// post-effect abort-all request.
#[tokio::test]
async fn a_workspace_open_does_not_withdraw_an_unconfirmed_stop() {
    let rig = Rig::new("open-after-timeout");
    rig.open_gate();
    let stuck = rig
        .state()
        .profile_egress
        .begin_legacy_provider_dispatch(None)
        .unwrap();
    rig.reserved().await;
    let error = commit_bounded(rig.state(), Duration::from_millis(50))
        .await
        .unwrap_err();
    assert_eq!(error.reason, "PROFILE_EGRESS_UNAVAILABLE:barrier-timeout");
    assert!(rig.state().post_effect_abort.abort_all_pending());
    rig.backend
        .open_workspace(rig.root.join("workspace").to_string_lossy().into_owned())
        .await
        .expect("open workspace");
    assert!(
        rig.state().post_effect_abort.abort_all_pending(),
        "the open's clear is held back while the stop is unconfirmed"
    );
    drop(stuck);
}

// D-3: no workspace is fine, a shutdown is not.
#[tokio::test]
async fn the_preview_refuses_while_the_app_shuts_down() {
    let rig = Rig::new("shutdown");
    rig.open_gate();
    rig.state().ws.lifecycle_core().request_shutdown().unwrap();
    assert_eq!(
        rig.preview().await.unwrap_err(),
        "PROFILE_ACTIVATION_REFUSED:lifecycle-busy"
    );
}

// The generic preview does not serve the profile-activation kind.
#[tokio::test]
async fn the_generic_preview_refuses_the_profile_activation_kind() {
    let rig = Rig::new("generic");
    rig.open_gate();
    let error = rig
        .backend
        .main_grant_preview(GATE.to_string(), "{}".to_string(), SENDER, WINDOW, None)
        .await
        .unwrap_err();
    assert_eq!(error.reason, "MAIN_GRANT_KIND");
}
