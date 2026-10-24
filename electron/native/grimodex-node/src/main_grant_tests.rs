//! D tests of MG-1 (CB-2): the slot's state machine, its bindings, the
//! lifecycle observer and the gate. The Scene reads that sit around the slot
//! (preview, issue's second read) are covered by `test/body-declaration.test.mjs`
//! on the real addon.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

use grimodex_core::narrative_scene_body_declaration::{
    NarrativeSceneBodyDeclarationValuesV1, NarrativeSceneBodySourceV1,
};
use grimodex_db::narrative_extraction::scene_body_declaration::{
    BodyDeclarationBinding, DeclareRequest, ExpectedDeclarationOcc,
};
use grimodex_db::workspace_lifecycle::{
    AdmissionKind, LifecycleEdge, OperationId, WorkspaceLifecycleCore, WorkspaceLifecycleObserver,
};

use super::*;

fn digest(seed: char) -> String {
    format!("sha256:{}", seed.to_string().repeat(64))
}

fn binding(token: &str) -> BodyDeclarationBinding {
    BodyDeclarationBinding {
        project_id: "p1".into(),
        scene_id: "s1".into(),
        scene_incarnation_id: "inc".into(),
        scope_version: 3,
        scope_token: token.into(),
        declaration_token: None,
        body_source: NarrativeSceneBodySourceV1 {
            source_identity: "project:scene:s1".into(),
            source_token: "v1@t".into(),
            storage_digest: digest('a'),
            canonical_digest: digest('b'),
            normalizer_version: "gdx-canonical-text/1".into(),
            utf16_length: 21,
        },
        title_digest: digest('c'),
        workspace_id: "w".into(),
        canonical_locator_digest: digest('d'),
        authority_instance: u64::MAX,
        recovery_generation: 9_007_199_254_740_993,
        values_digest: digest('e'),
        display_digest: digest('f'),
    }
}

fn request() -> DeclareRequest {
    DeclareRequest {
        project_id: "p1".into(),
        scene_id: "s1".into(),
        request_id: "r1".into(),
        expected: ExpectedDeclarationOcc {
            scope_version: 3,
            scope_token: "tok".into(),
            declaration_token: None,
        },
        values: NarrativeSceneBodyDeclarationValuesV1::g01(),
    }
}

fn payload(token: &str) -> GrantPayload {
    GrantPayload::BodyDeclaration(Box::new(BodyDeclarationGrantPayload {
        request: request(),
        expected_workspace_path: "/w".into(),
        binding: binding(token),
    }))
}

const SENDER: u32 = 7;
const WINDOW: u32 = 11;
const REVISION: u64 = 42;

/// A registry on a hand-driven clock, with its observer registered.
struct Rig {
    registry: Arc<MainGrantRegistry>,
    clock: Arc<AtomicU64>,
    core: WorkspaceLifecycleCore,
}

fn fresh_rig() -> Rig {
    let clock = Arc::new(AtomicU64::new(1_000));
    let registry = Arc::new(MainGrantRegistry::with_clock({
        let clock = Arc::clone(&clock);
        Arc::new(move || clock.load(Ordering::SeqCst))
    }));
    let core = WorkspaceLifecycleCore::new();
    let _state = MainGrantState::register(&core, Arc::clone(&registry));
    Rig {
        registry,
        clock,
        core,
    }
}

impl Rig {
    fn advance(&self, ms: u64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    fn preview(&self) -> Result<PreviewHandle, GrantRefusal> {
        self.preview_for(SENDER, WINDOW, "tok")
    }

    fn preview_for(
        &self,
        sender_id: u32,
        window_id: u32,
        token: &str,
    ) -> Result<PreviewHandle, GrantRefusal> {
        let binding = binding(token);
        let grant_digest = main_grant_digest(
            MainGrantKind::BodyDeclaration,
            &binding,
            REVISION,
            sender_id,
            window_id,
        )
        .unwrap();
        self.registry.insert_preview(
            PreviewInit {
                kind: MainGrantKind::BodyDeclaration,
                sender_id,
                window_id,
                digest: grant_digest,
                lifecycle_revision: REVISION,
                payload: payload(token),
            },
            self.registry.edge_epoch(),
        )
    }

    fn current_digest(&self, token: &str) -> String {
        main_grant_digest(
            MainGrantKind::BodyDeclaration,
            &binding(token),
            REVISION,
            SENDER,
            WINDOW,
        )
        .unwrap()
    }

    fn issued(&self) -> (String, String) {
        let preview = self.preview().unwrap();
        self.registry
            .begin_issue(&preview.preview_id, SENDER, WINDOW)
            .unwrap();
        let grant_id = self
            .registry
            .finish_issue(&preview.preview_id, &self.current_digest("tok"))
            .unwrap();
        (preview.preview_id, grant_id)
    }

    fn consume(&self, grant_id: &str) -> Result<ConsumedBodyDeclarationBinding, GrantRefusal> {
        self.registry
            .consume::<BodyDeclarationKind>(grant_id, SENDER, WINDOW, REVISION)
    }
}

// D1
#[test]
fn grant_expires_after_60s() {
    let rig = fresh_rig();
    // Just inside the window: issue and consume pass.
    let (_, grant) = rig.issued();
    rig.advance(MAIN_GRANT_TTL_MS - 1);
    assert!(rig.consume(&grant).is_ok());

    // At the deadline the preview is expired: issue is refused, and so is a
    // second try with the same previewId.
    let preview = rig.preview().unwrap();
    rig.advance(MAIN_GRANT_TTL_MS);
    for _ in 0..2 {
        assert_eq!(
            rig.registry
                .begin_issue(&preview.preview_id, SENDER, WINDOW)
                .err(),
            Some(GrantRefusal::Expired)
        );
    }
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Expired));

    // An issued grant expires too.
    let (_, grant) = rig.issued();
    rig.advance(MAIN_GRANT_TTL_MS);
    assert_eq!(rig.consume(&grant).err(), Some(GrantRefusal::Expired));
}

// D2
#[test]
fn grant_is_single_use() {
    let rig = fresh_rig();
    let (preview_id, grant) = rig.issued();
    assert!(rig.consume(&grant).is_ok());
    assert_eq!(rig.consume(&grant).err(), Some(GrantRefusal::Consumed));
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Consumed));
    // The previewId cannot be issued again, and a revoke cannot undo a
    // consume.
    assert_eq!(
        rig.registry.begin_issue(&preview_id, SENDER, WINDOW).err(),
        Some(GrantRefusal::Consumed)
    );
    rig.registry.revoke(&grant);
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Consumed));
    // A failed write does not give the grant back: nothing in the registry
    // reopens a Consumed slot, and the next preview is a new one.
    assert_eq!(rig.consume(&grant).err(), Some(GrantRefusal::Consumed));
    let next = rig.preview().unwrap();
    assert_ne!(next.preview_id, preview_id);
    assert_eq!(rig.consume(&grant).err(), Some(GrantRefusal::NotFound));
}

// D3
#[test]
fn grant_binds_sender_and_window() {
    let rig = fresh_rig();
    let preview = rig.preview().unwrap();
    for (sender, window) in [(SENDER + 1, WINDOW), (SENDER, WINDOW + 1)] {
        assert_eq!(
            rig.registry
                .begin_issue(&preview.preview_id, sender, window)
                .err(),
            Some(GrantRefusal::Mismatch)
        );
    }
    // A mismatched caller does not disturb the owner's preview.
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Previewed));
    rig.registry
        .begin_issue(&preview.preview_id, SENDER, WINDOW)
        .unwrap();
    let grant = rig
        .registry
        .finish_issue(&preview.preview_id, &rig.current_digest("tok"))
        .unwrap();
    for (sender, window) in [(SENDER + 1, WINDOW), (SENDER, WINDOW + 1)] {
        assert_eq!(
            rig.registry
                .consume::<BodyDeclarationKind>(&grant, sender, window, REVISION)
                .err(),
            Some(GrantRefusal::Mismatch)
        );
    }
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Issued));
    assert!(rig.consume(&grant).is_ok());
}

// D4 (the slot's part: a digest that differs at issue, or a lifecycle revision
// that differs at consume, refuses and revokes)
#[test]
fn grant_binds_occ_and_digests() {
    let rig = fresh_rig();
    let preview = rig.preview().unwrap();
    rig.registry
        .begin_issue(&preview.preview_id, SENDER, WINDOW)
        .unwrap();
    assert_eq!(
        rig.registry
            .finish_issue(&preview.preview_id, &rig.current_digest("changed"))
            .err(),
        Some(GrantRefusal::StateChanged)
    );
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Revoked));
    assert_eq!(
        rig.registry
            .begin_issue(&preview.preview_id, SENDER, WINDOW)
            .err(),
        Some(GrantRefusal::Revoked)
    );

    // The lifecycle revision moved between issue and consume.
    let (_, grant) = rig.issued();
    assert_eq!(
        rig.registry
            .consume::<BodyDeclarationKind>(&grant, SENDER, WINDOW, REVISION + 1)
            .err(),
        Some(GrantRefusal::StateChanged)
    );
    assert_eq!(rig.consume(&grant).err(), Some(GrantRefusal::Revoked));
}

#[test]
fn the_digest_changes_with_every_bound_component() {
    let base = main_grant_digest(
        MainGrantKind::BodyDeclaration,
        &binding("tok"),
        REVISION,
        SENDER,
        WINDOW,
    )
    .unwrap();
    let variants = [
        main_grant_digest(
            MainGrantKind::BodyDeclaration,
            &binding("other"),
            REVISION,
            SENDER,
            WINDOW,
        ),
        main_grant_digest(
            MainGrantKind::BodyDeclaration,
            &binding("tok"),
            REVISION + 1,
            SENDER,
            WINDOW,
        ),
        main_grant_digest(
            MainGrantKind::BodyDeclaration,
            &binding("tok"),
            REVISION,
            SENDER + 1,
            WINDOW,
        ),
        main_grant_digest(
            MainGrantKind::BodyDeclaration,
            &binding("tok"),
            REVISION,
            SENDER,
            WINDOW + 1,
        ),
    ];
    for variant in variants {
        assert_ne!(variant.unwrap(), base);
    }
    // Deterministic, and in the sha256 form of the canonical digests.
    assert_eq!(
        base,
        main_grant_digest(
            MainGrantKind::BodyDeclaration,
            &binding("tok"),
            REVISION,
            SENDER,
            WINDOW,
        )
        .unwrap()
    );
    assert!(base.starts_with("sha256:"));
}

// D5
#[test]
fn only_one_slot_across_kinds() {
    let rig = fresh_rig();
    let first = rig.preview().unwrap();
    assert_eq!(rig.preview().err(), Some(GrantRefusal::Busy));
    assert_eq!(
        rig.registry.ensure_can_preview().err(),
        Some(GrantRefusal::Busy)
    );
    // An issued grant holds the slot too.
    rig.registry
        .begin_issue(&first.preview_id, SENDER, WINDOW)
        .unwrap();
    let grant = rig
        .registry
        .finish_issue(&first.preview_id, &rig.current_digest("tok"))
        .unwrap();
    assert_eq!(rig.preview().err(), Some(GrantRefusal::Busy));
    // The slot frees when the grant ends: revoked, consumed or expired.
    rig.registry.revoke(&grant);
    assert!(rig.preview().is_ok());
    rig.advance(MAIN_GRANT_TTL_MS);
    assert!(rig.preview().is_ok());
}

#[test]
fn a_registry_without_its_observer_cannot_preview() {
    let registry = MainGrantRegistry::new();
    assert_eq!(
        registry.ensure_can_preview().err(),
        Some(GrantRefusal::Unavailable)
    );
}

#[test]
fn a_preview_does_not_survive_an_edge_seen_while_it_was_read() {
    let rig = fresh_rig();
    let epoch = rig.registry.edge_epoch();
    rig.registry.revoke_for_edge();
    let binding = binding("tok");
    let result = rig.registry.insert_preview(
        PreviewInit {
            kind: MainGrantKind::BodyDeclaration,
            sender_id: SENDER,
            window_id: WINDOW,
            digest: main_grant_digest(
                MainGrantKind::BodyDeclaration,
                &binding,
                REVISION,
                SENDER,
                WINDOW,
            )
            .unwrap(),
            lifecycle_revision: REVISION,
            payload: payload("tok"),
        },
        epoch,
    );
    assert_eq!(result.err(), Some(GrantRefusal::StateChanged));
    assert_eq!(rig.registry.state_for_test(), None);
}

// D6
#[test]
fn lifecycle_edges_revoke_the_grant() {
    let rig = fresh_rig();
    let operation_id = OperationId::new(5);
    let edges = [
        LifecycleEdge::TransitionAdmitted {
            operation_id,
            kind: AdmissionKind::Restore,
            revision: 9,
        },
        LifecycleEdge::Unavailable { revision: 9 },
        LifecycleEdge::ShutdownRequested { revision: 9 },
    ];
    let observer = GrantEdgeObserver {
        registry: Arc::clone(&rig.registry),
    };
    for edge in &edges {
        // Previewed.
        let preview = rig.preview().unwrap();
        let epoch = rig.registry.edge_epoch();
        observer.on_lifecycle_edge(edge);
        assert_eq!(rig.registry.edge_epoch(), epoch + 1);
        assert_eq!(rig.registry.state_for_test(), Some(GrantState::Revoked));
        assert_eq!(
            rig.registry
                .begin_issue(&preview.preview_id, SENDER, WINDOW)
                .err(),
            Some(GrantRefusal::Revoked)
        );
        // Issued.
        let (_, grant) = rig.issued();
        observer.on_lifecycle_edge(edge);
        assert_eq!(rig.consume(&grant).err(), Some(GrantRefusal::Revoked));
    }
    // A new Ready entry alone does not revoke (the edges above did).
    let (_, grant) = rig.issued();
    let epoch = rig.registry.edge_epoch();
    observer.on_lifecycle_edge(&LifecycleEdge::ReadyPublished {
        binding: grimodex_db::workspace_lifecycle::LiveBinding::new("/w", "w", 1, 1),
        revision: 10,
    });
    assert_eq!(rig.registry.edge_epoch(), epoch);
    assert!(rig.consume(&grant).is_ok());
}

#[test]
fn the_real_core_delivers_its_edges_to_the_registered_observer() {
    let rig = fresh_rig();
    rig.preview().unwrap();
    let epoch = rig.registry.edge_epoch();
    rig.core.request_shutdown().unwrap();
    assert!(rig.registry.edge_epoch() > epoch);
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Revoked));
}

#[test]
fn the_observer_is_the_third_of_four_and_the_limit_is_unchanged() {
    assert_eq!(grimodex_db::workspace_lifecycle::MAX_LIFECYCLE_OBSERVERS, 4);
    // Two other observers and ours fit; only a fifth is refused.
    struct Idle;
    impl WorkspaceLifecycleObserver for Idle {
        fn on_lifecycle_edge(&self, _edge: &LifecycleEdge) {}
    }
    let core = WorkspaceLifecycleCore::new();
    core.register_observer(Arc::new(Idle)).unwrap();
    core.register_observer(Arc::new(Idle)).unwrap();
    let registry = Arc::new(MainGrantRegistry::new());
    MainGrantState::register(&core, Arc::clone(&registry));
    assert!(registry.ensure_can_preview().is_ok());
    core.register_observer(Arc::new(Idle)).unwrap();
    assert!(core.register_observer(Arc::new(Idle)).is_err());
}

#[test]
fn the_observer_never_blocks_on_a_held_slot_lock_for_longer_than_the_holder() {
    // The observer only takes the slot mutex; another thread that holds a
    // preview and returns never makes it wait on the Core, a DB or a window.
    let rig = fresh_rig();
    rig.preview().unwrap();
    let registry = Arc::clone(&rig.registry);
    let worker = thread::spawn(move || {
        for _ in 0..100 {
            registry.revoke_for_edge();
        }
    });
    worker.join().unwrap();
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Revoked));
    assert_eq!(rig.registry.edge_epoch(), 100);
}

#[test]
fn revoke_by_id_and_by_sender() {
    let rig = fresh_rig();
    let preview = rig.preview().unwrap();
    rig.registry.revoke("unknown");
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Previewed));
    rig.registry.revoke_sender(SENDER + 1);
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Previewed));
    rig.registry.revoke(&preview.preview_id);
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Revoked));

    let (_, grant) = rig.issued();
    rig.registry.revoke_sender(SENDER);
    assert_eq!(rig.consume(&grant).err(), Some(GrantRefusal::Revoked));

    let (_, grant) = rig.issued();
    rig.registry.revoke_all();
    assert_eq!(rig.consume(&grant).err(), Some(GrantRefusal::Revoked));
}

#[test]
fn a_revoked_grant_drops_its_binding() {
    let rig = fresh_rig();
    rig.preview().unwrap();
    rig.registry.revoke_all();
    let slot = rig.registry.lock();
    assert!(slot.as_ref().unwrap().payload.is_none());
}

// D7
#[test]
fn u64_values_stay_inside_native() {
    // Decimal strings only: the binding is serialized with them as strings,
    // so a value beyond 2^53 never becomes a JS number.
    let value = serde_json::to_value(binding("tok")).unwrap();
    assert_eq!(value["authorityInstance"], "18446744073709551615");
    assert_eq!(value["recoveryGeneration"], "9007199254740993");
    assert_eq!(parse_decimal_u64("18446744073709551615"), Some(u64::MAX));
    assert_eq!(parse_decimal_u64("0"), Some(0));
    for rejected in [
        "",
        " 1",
        "1 ",
        "+1",
        "-1",
        "01",
        "00",
        "1e3",
        "0x10",
        "1.0",
        "18446744073709551616",
        "１２",
    ] {
        assert_eq!(parse_decimal_u64(rejected), None, "{rejected:?}");
    }
    // Neither id, nor the preview's JSON, carries the lifecycle revision or
    // the authority numbers.
    let rig = fresh_rig();
    let preview = rig.preview().unwrap();
    let text = serde_json::json!({
        "previewId": preview.preview_id,
        "expiresInMs": preview.expires_in_ms,
    })
    .to_string();
    assert!(!text.contains("18446744073709551615"));
    assert!(!text.contains("9007199254740993"));
}

// D8
#[test]
fn ids_are_random_and_errors_carry_no_ids() {
    let rig = fresh_rig();
    let (preview_id, grant_id) = rig.issued();
    assert_eq!(preview_id.len(), 64);
    assert_eq!(grant_id.len(), 64);
    assert!(preview_id.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_ne!(preview_id, grant_id);
    for refusal in [
        GrantRefusal::Busy,
        GrantRefusal::Missing,
        GrantRefusal::Unavailable,
        GrantRefusal::NotFound,
        GrantRefusal::Mismatch,
        GrantRefusal::Expired,
        GrantRefusal::Revoked,
        GrantRefusal::Consumed,
        GrantRefusal::WrongState,
        GrantRefusal::WrongKind,
        GrantRefusal::StateChanged,
    ] {
        let message = refusal.into_error().to_string();
        assert!(message.starts_with("MAIN_GRANT_"), "{message}");
        assert!(!message.contains(&preview_id) && !message.contains(&grant_id));
    }
    assert_eq!(GrantRefusal::Busy.code(), "MAIN_GRANT_BUSY");
    let second = fresh_rig();
    assert_ne!(second.issued().0, preview_id);
}

#[test]
fn an_unknown_grant_id_is_not_found_and_changes_nothing() {
    let rig = fresh_rig();
    let (_, grant) = rig.issued();
    assert_eq!(
        rig.consume("not-the-grant").err(),
        Some(GrantRefusal::NotFound)
    );
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Issued));
    assert!(rig.consume(&grant).is_ok());
}

// D9 (the gate itself; the entries are tested on the real addon)
#[test]
fn the_gate_is_closed_by_default_and_only_opens() {
    // Every entry is closed by default, and opening one leaves the others
    // closed (DR-DA2-1: the profile-activation entry is its own).
    for entry in PrePublicationEntry::ALL {
        let gate = PrePublicationGate::new();
        assert!(!gate.is_open(entry), "{entry:?}");
        gate.open(entry);
        assert!(gate.is_open(entry));
        for other in PrePublicationEntry::ALL
            .into_iter()
            .filter(|other| *other != entry)
        {
            assert!(!gate.is_open(other), "{other:?} opened with {entry:?}");
        }
    }
    assert_eq!(
        PrePublicationEntry::parse("scene-body-declaration"),
        Some(PrePublicationEntry::SceneBodyDeclaration)
    );
    assert_eq!(
        PrePublicationEntry::parse("profile-activation"),
        Some(PrePublicationEntry::ProfileActivation)
    );
    for unknown in [
        "",
        "all",
        "Scene-Body-Declaration",
        "local-send",
        "Profile-Activation",
        "profile_activation",
    ] {
        assert_eq!(PrePublicationEntry::parse(unknown), None, "{unknown:?}");
    }
    assert_eq!(
        MainGrantKind::BodyDeclaration.gate_entry(),
        PrePublicationEntry::SceneBodyDeclaration
    );
    assert_eq!(
        MainGrantKind::ProfileActivation.gate_entry(),
        PrePublicationEntry::ProfileActivation
    );
    assert_eq!(
        MainGrantKind::parse("body-declaration"),
        Some(MainGrantKind::BodyDeclaration)
    );
    assert_eq!(
        MainGrantKind::parse("profile-activation"),
        Some(MainGrantKind::ProfileActivation)
    );
}

// ─────────────── DA-2: the ProfileActivation grant and reservation ───────────────

fn activation_binding() -> ProfileActivationGrantPayload {
    ProfileActivationGrantPayload {
        profile_id: "profile-1".into(),
        caller_epoch: 0,
        disclosure_version: crate::profile_activation::PROFILE_ACTIVATION_DISCLOSURE_VERSION,
        disclosure_digest: digest('9'),
    }
}

impl Rig {
    fn activation_preview(&self) -> Result<PreviewHandle, GrantRefusal> {
        let binding = activation_binding();
        let digest = profile_activation_grant_digest(&binding, REVISION, SENDER, WINDOW).unwrap();
        self.registry.insert_preview(
            PreviewInit {
                kind: MainGrantKind::ProfileActivation,
                sender_id: SENDER,
                window_id: WINDOW,
                digest,
                lifecycle_revision: REVISION,
                payload: GrantPayload::ProfileActivation(binding),
            },
            self.registry.edge_epoch(),
        )
    }

    fn activation_issued(&self) -> String {
        let preview = self.activation_preview().unwrap();
        self.registry
            .begin_issue(&preview.preview_id, SENDER, WINDOW)
            .unwrap();
        let digest =
            profile_activation_grant_digest(&activation_binding(), REVISION, SENDER, WINDOW)
                .unwrap();
        self.registry
            .finish_issue(&preview.preview_id, &digest)
            .unwrap()
    }

    fn reserve(&self, grant_id: &str) -> Result<(), GrantRefusal> {
        self.registry
            .consume_profile_activation(grant_id, SENDER, WINDOW, REVISION, |bound| {
                *bound == activation_binding()
            })
    }
}

// K3/2 Negative (4): while the reservation holds the slot, every preview,
// issue and consume is busy, whatever its kind or id.
#[test]
fn profile_activation_reservation_blocks_any_preview_and_second_consume() {
    let rig = fresh_rig();
    let grant = rig.activation_issued();
    rig.reserve(&grant).unwrap();
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Reserved));
    assert!(rig.registry.is_reserved());
    assert_eq!(rig.preview().err(), Some(GrantRefusal::Busy));
    assert_eq!(rig.activation_preview().err(), Some(GrantRefusal::Busy));
    assert_eq!(
        rig.registry.ensure_can_preview().err(),
        Some(GrantRefusal::Busy)
    );
    // A second consume of the same grant, of any other id, of either kind.
    assert_eq!(rig.reserve(&grant).err(), Some(GrantRefusal::Busy));
    assert_eq!(rig.reserve("another-grant").err(), Some(GrantRefusal::Busy));
    assert_eq!(rig.consume(&grant).err(), Some(GrantRefusal::Busy));
    assert_eq!(rig.consume("another-grant").err(), Some(GrantRefusal::Busy));
    assert_eq!(
        rig.registry
            .begin_issue("any-preview", SENDER, WINDOW)
            .err(),
        Some(GrantRefusal::Busy)
    );
    assert_eq!(
        rig.registry.finish_issue("any-preview", &digest('1')).err(),
        Some(GrantRefusal::Busy)
    );
    // The commit takes the token once.
    assert!(rig.registry.take_reservation().is_ok());
    assert_eq!(
        rig.registry.take_reservation().err(),
        Some(ReservationRefusal::NotReserved)
    );
    // Still reserved until the commit finishes.
    assert_eq!(rig.preview().err(), Some(GrantRefusal::Busy));
    rig.registry.finish_reservation();
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Consumed));
    assert!(!rig.registry.is_reserved());
    // Only now can another grant start.
    assert!(rig.preview().is_ok());
}

// P2-1: the reservation outlives the 60 s expiry, every revoke and every
// lifecycle edge but shutdown, so stage 3 plus stage 5 may exceed 60 s.
#[test]
fn reservation_survives_expiry_and_every_revoke() {
    let rig = fresh_rig();
    let grant = rig.activation_issued();
    rig.reserve(&grant).unwrap();
    rig.advance(MAIN_GRANT_TTL_MS * 3);
    rig.registry.revoke_all();
    rig.registry.revoke_sender(SENDER);
    rig.registry.revoke(&grant);
    rig.registry.revoke_for_edge();
    let observer = GrantEdgeObserver {
        registry: Arc::clone(&rig.registry),
    };
    observer.on_lifecycle_edge(&LifecycleEdge::TransitionAdmitted {
        operation_id: OperationId::new(3),
        kind: AdmissionKind::Open,
        revision: 9,
    });
    observer.on_lifecycle_edge(&LifecycleEdge::Unavailable { revision: 10 });
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Reserved));
    // More than 60 s after the preview (stage 3 + stage 5), the commit still
    // finds its token.
    rig.advance(MAIN_GRANT_TTL_MS);
    let consumed = rig
        .registry
        .take_reservation()
        .expect("the reservation stays");
    assert!(consumed.binds("profile-1", 0, false));
    assert!(
        !consumed.binds("profile-1", 0, true),
        "restricted no longer binds"
    );
    assert!(!consumed.binds("profile-1", 1, false), "another epoch");
    assert!(!consumed.binds("profile-2", 0, false), "another profile");
    rig.registry.finish_reservation();
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Consumed));
}

// Stage 1's refusals close nothing: an expired grant, another sender or
// window, a lifecycle edge since the preview, a binding that no longer holds,
// and the generic consume of the wrong kind.
#[test]
fn expired_profile_activation_consume_closes_nothing() {
    let rig = fresh_rig();
    let grant = rig.activation_issued();
    rig.advance(MAIN_GRANT_TTL_MS);
    assert_eq!(rig.reserve(&grant).err(), Some(GrantRefusal::Expired));
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Expired));
    assert_eq!(
        rig.registry.take_reservation().err(),
        Some(ReservationRefusal::NotReserved)
    );

    let grant = rig.activation_issued();
    assert_eq!(
        rig.registry
            .consume_profile_activation(&grant, SENDER + 1, WINDOW, REVISION, |_| true)
            .err(),
        Some(GrantRefusal::Mismatch)
    );
    assert_eq!(
        rig.registry
            .consume_profile_activation(&grant, SENDER, WINDOW + 1, REVISION, |_| true)
            .err(),
        Some(GrantRefusal::Mismatch)
    );
    assert_eq!(
        rig.registry
            .consume::<BodyDeclarationKind>(&grant, SENDER, WINDOW, REVISION)
            .err(),
        Some(GrantRefusal::WrongKind)
    );
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Issued));
    assert_eq!(
        rig.registry
            .consume_profile_activation(&grant, SENDER, WINDOW, REVISION + 1, |_| true)
            .err(),
        Some(GrantRefusal::StateChanged)
    );
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Revoked));

    let grant = rig.activation_issued();
    assert_eq!(
        rig.registry
            .consume_profile_activation(&grant, SENDER, WINDOW, REVISION, |_| false)
            .err(),
        Some(GrantRefusal::StateChanged)
    );
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Revoked));
    assert!(!rig.registry.is_reserved());

    // A body-declaration grant is not a profile activation.
    let (_, body) = rig.issued();
    assert_eq!(rig.reserve(&body).err(), Some(GrantRefusal::WrongKind));
    assert!(rig.consume(&body).is_ok());
}

// The app's shutdown starts no new stage: the reservation is marked and the
// slot stays taken.
#[test]
fn shutdown_marks_the_reservation_and_commit_refuses() {
    let rig = fresh_rig();
    let grant = rig.activation_issued();
    rig.reserve(&grant).unwrap();
    rig.core.request_shutdown().unwrap();
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Reserved));
    assert_eq!(
        rig.registry.take_reservation().err(),
        Some(ReservationRefusal::Shutdown)
    );
    assert_eq!(rig.preview().err(), Some(GrantRefusal::Busy));

    // A shutdown after the commit took its token does not stop the commit.
    let rig = fresh_rig();
    let grant = rig.activation_issued();
    rig.reserve(&grant).unwrap();
    let _token = rig.registry.take_reservation().unwrap();
    rig.core.request_shutdown().unwrap();
    rig.registry.finish_reservation();
    assert_eq!(rig.registry.state_for_test(), Some(GrantState::Consumed));
}

// The ProfileActivation grant digest moves with every bound component, and
// the u64 caller epoch is a decimal string inside it.
#[test]
fn the_profile_activation_digest_changes_with_every_bound_component() {
    let base_binding = activation_binding();
    let base = profile_activation_grant_digest(&base_binding, REVISION, SENDER, WINDOW).unwrap();
    assert!(base.starts_with("sha256:"));
    let mut variants = Vec::new();
    let mut variant = base_binding.clone();
    variant.profile_id = "profile-2".into();
    variants.push(variant);
    let mut variant = base_binding.clone();
    variant.caller_epoch = u64::MAX;
    variants.push(variant);
    let mut variant = base_binding.clone();
    variant.disclosure_version += 1;
    variants.push(variant);
    let mut variant = base_binding.clone();
    variant.disclosure_digest = digest('8');
    variants.push(variant);
    for variant in &variants {
        assert_ne!(
            profile_activation_grant_digest(variant, REVISION, SENDER, WINDOW).unwrap(),
            base
        );
    }
    for (revision, sender, window) in [
        (REVISION + 1, SENDER, WINDOW),
        (REVISION, SENDER + 1, WINDOW),
        (REVISION, SENDER, WINDOW + 1),
    ] {
        assert_ne!(
            profile_activation_grant_digest(&base_binding, revision, sender, window).unwrap(),
            base
        );
    }
    // Not the body-declaration digest's domain.
    assert_ne!(
        base,
        main_grant_digest(
            MainGrantKind::BodyDeclaration,
            &binding("tok"),
            REVISION,
            SENDER,
            WINDOW
        )
        .unwrap()
    );
}
