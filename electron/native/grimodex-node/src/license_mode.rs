//! `license-control` client selection by profile mode (K3/2 N-1, NIR-1 DA-1 ST2).
//!
//! The four license entry points (`activate`, `revalidate`, `deactivate` and the
//! background validate cycle) read the profile mode at call time and pick the
//! restricted or the unrestricted client. From stage 1 of an activation (the
//! grant consumed into a reservation) the restricted client is used as well
//! (NIR-1 DA-2, DR-DA2-4), so stages 2 to 4 never pick the unrestricted one. The choice lives here, behind an
//! injected client pair, so that a test can prove which side was reached
//! without touching the network. Production passes [`PRODUCTION_CLIENTS`]; the
//! unrestricted side is the unchanged `PolarClient`.

use grimodex_license::{
    activate_license_restricted_with_client, activate_license_with_client,
    deactivate_license_with_client, revalidate_license_with_client, run_validate_cycle_with_client,
    LicenseRuntime, LicenseStateDto, PolarClient, PolarLicenseClient, RestrictedPolarClient,
};

use crate::profile_egress::ProfileEgressState;

#[derive(Clone, Copy)]
pub(crate) struct LicenseClients<'a> {
    pub(crate) restricted: &'a dyn PolarLicenseClient,
    pub(crate) unrestricted: &'a dyn PolarLicenseClient,
}

pub(crate) const PRODUCTION_CLIENTS: LicenseClients<'static> = LicenseClients {
    restricted: &RestrictedPolarClient,
    unrestricted: &PolarClient,
};

pub(crate) async fn activate(
    profile: &ProfileEgressState,
    runtime: &LicenseRuntime,
    key: String,
    clients: LicenseClients<'_>,
) -> anyhow::Result<LicenseStateDto> {
    if profile.license_uses_restricted_client() {
        activate_license_restricted_with_client(runtime, key, clients.restricted).await
    } else {
        activate_license_with_client(runtime, key, clients.unrestricted).await
    }
}

pub(crate) async fn revalidate(
    profile: &ProfileEgressState,
    runtime: &LicenseRuntime,
    clients: LicenseClients<'_>,
) -> anyhow::Result<LicenseStateDto> {
    if profile.license_uses_restricted_client() {
        revalidate_license_with_client(runtime, clients.restricted).await
    } else {
        revalidate_license_with_client(runtime, clients.unrestricted).await
    }
}

pub(crate) async fn deactivate(
    profile: &ProfileEgressState,
    runtime: &LicenseRuntime,
    clients: LicenseClients<'_>,
) -> anyhow::Result<LicenseStateDto> {
    if profile.license_uses_restricted_client() {
        deactivate_license_with_client(runtime, clients.restricted).await
    } else {
        deactivate_license_with_client(runtime, clients.unrestricted).await
    }
}

pub(crate) async fn validate_cycle(
    profile: &ProfileEgressState,
    runtime: &LicenseRuntime,
    clients: LicenseClients<'_>,
) -> Option<LicenseStateDto> {
    if profile.license_uses_restricted_client() {
        run_validate_cycle_with_client(runtime, clients.restricted).await
    } else {
        run_validate_cycle_with_client(runtime, clients.unrestricted).await
    }
}

#[cfg(all(test, feature = "licensing"))]
mod tests {
    use super::*;
    use std::future::Future;
    use std::path::PathBuf;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use grimodex_core::license::{write_license_file, ActivatedLicense, LicenseFile};
    use grimodex_license::{PolarActivation, PolarValidateOutcome};

    const WELL_FORMED_KEY: &str = "GRIMODEX-8CA5F5B0-4C44-4E5B-B7C5-F8C3D3E3E3E3";
    const MALFORMED_KEY: &str = "not a key\n";
    const FORMAT_ERROR: &str = "ライセンスキーの形式が正しくありません";

    type Reply<T> = Pin<Box<dyn Future<Output = anyhow::Result<T>> + Send>>;

    /// Counts the calls that reach it and fails every one, so a test sees
    /// which side of the pair an entry point chose without any network.
    #[derive(Default)]
    struct Counting {
        activate: AtomicUsize,
        validate: AtomicUsize,
        deactivate: AtomicUsize,
    }

    impl Counting {
        fn calls(&self) -> (usize, usize, usize) {
            (
                self.activate.load(Ordering::SeqCst),
                self.validate.load(Ordering::SeqCst),
                self.deactivate.load(Ordering::SeqCst),
            )
        }
    }

    // The trait is declared with `async_trait`; this crate does not depend on
    // it, so the methods are written in their expanded form.
    impl PolarLicenseClient for Counting {
        fn activate<'life0, 'life1, 'async_trait>(
            &'life0 self,
            _key: &'life1 str,
        ) -> Pin<Box<dyn Future<Output = anyhow::Result<PolarActivation>> + Send + 'async_trait>>
        where
            'life0: 'async_trait,
            'life1: 'async_trait,
            Self: 'async_trait,
        {
            self.activate.fetch_add(1, Ordering::SeqCst);
            let reply: Reply<PolarActivation> =
                Box::pin(async { Err(anyhow::anyhow!("counting client: activate")) });
            reply
        }

        fn validate<'life0, 'life1, 'life2, 'async_trait>(
            &'life0 self,
            _key: &'life1 str,
            _activation_id: &'life2 str,
        ) -> Pin<Box<dyn Future<Output = anyhow::Result<PolarValidateOutcome>> + Send + 'async_trait>>
        where
            'life0: 'async_trait,
            'life1: 'async_trait,
            'life2: 'async_trait,
            Self: 'async_trait,
        {
            self.validate.fetch_add(1, Ordering::SeqCst);
            let reply: Reply<PolarValidateOutcome> =
                Box::pin(async { Err(anyhow::anyhow!("counting client: validate")) });
            reply
        }

        fn deactivate<'life0, 'life1, 'life2, 'async_trait>(
            &'life0 self,
            _key: &'life1 str,
            _activation_id: &'life2 str,
        ) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'async_trait>>
        where
            'life0: 'async_trait,
            'life1: 'async_trait,
            'life2: 'async_trait,
            Self: 'async_trait,
        {
            self.deactivate.fetch_add(1, Ordering::SeqCst);
            let reply: Reply<()> =
                Box::pin(async { Err(anyhow::anyhow!("counting client: deactivate")) });
            reply
        }
    }

    struct Fixture {
        root: PathBuf,
        profile: ProfileEgressState,
        runtime: LicenseRuntime,
        restricted: Counting,
        unrestricted: Counting,
    }

    impl Fixture {
        /// A profile in the requested mode over a license file that holds an
        /// activation last validated long ago (so the background cycle is
        /// due and revalidate/deactivate have a stored key to send).
        fn new(restricted: bool) -> Self {
            let root = std::env::temp_dir().join(format!(
                "grimodex-node-license-mode-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&root).expect("fixture root");
            let profile = ProfileEgressState::new(root.join("profile-egress.json")).expect("state");
            if restricted {
                profile
                    .activate_first_restricted_publication(
                        &crate::main_grant::ConsumedProfileActivation::for_test(),
                        true,
                    )
                    .expect("restrict");
            }
            let stale = "2020-01-01T00:00:00Z".to_string();
            let license_path = root.join("license.json");
            write_license_file(
                &license_path,
                &LicenseFile {
                    license: Some(ActivatedLicense {
                        key: WELL_FORMED_KEY.to_string(),
                        activation_id: "act-1".to_string(),
                        benefit_id: None,
                        activated_at: Some(stale.clone()),
                        last_validated_at: Some(stale),
                        revoked_at: None,
                    }),
                    ..LicenseFile::default()
                },
            )
            .expect("license file");
            Self {
                root,
                profile,
                runtime: LicenseRuntime::new(license_path),
                restricted: Counting::default(),
                unrestricted: Counting::default(),
            }
        }

        fn clients(&self) -> LicenseClients<'_> {
            LicenseClients {
                restricted: &self.restricted,
                unrestricted: &self.unrestricted,
            }
        }

        /// (restricted side, unrestricted side) call counts.
        fn reached(&self) -> ((usize, usize, usize), (usize, usize, usize)) {
            (self.restricted.calls(), self.unrestricted.calls())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[tokio::test]
    async fn a_malformed_key_never_reaches_a_client_while_restricted() {
        let fixture = Fixture::new(true);
        let error = activate(
            &fixture.profile,
            &fixture.runtime,
            MALFORMED_KEY.to_string(),
            fixture.clients(),
        )
        .await
        .expect_err("a malformed key must be refused");
        assert!(format!("{error:#}").contains(FORMAT_ERROR), "{error:#}");
        assert_eq!(fixture.reached(), ((0, 0, 0), (0, 0, 0)));
    }

    #[tokio::test]
    async fn the_same_key_reaches_the_unrestricted_client_unchecked() {
        let fixture = Fixture::new(false);
        let error = activate(
            &fixture.profile,
            &fixture.runtime,
            MALFORMED_KEY.to_string(),
            fixture.clients(),
        )
        .await
        .expect_err("the counting client fails every call");
        assert!(
            !format!("{error:#}").contains(FORMAT_ERROR),
            "unrestricted keys are not grammar-checked: {error:#}"
        );
        assert_eq!(fixture.reached(), ((0, 0, 0), (1, 0, 0)));
    }

    #[tokio::test]
    async fn a_well_formed_key_uses_the_restricted_client_only_while_restricted() {
        let restricted = Fixture::new(true);
        let _ = activate(
            &restricted.profile,
            &restricted.runtime,
            WELL_FORMED_KEY.to_string(),
            restricted.clients(),
        )
        .await;
        assert_eq!(restricted.reached(), ((1, 0, 0), (0, 0, 0)));

        let unrestricted = Fixture::new(false);
        let _ = activate(
            &unrestricted.profile,
            &unrestricted.runtime,
            WELL_FORMED_KEY.to_string(),
            unrestricted.clients(),
        )
        .await;
        assert_eq!(unrestricted.reached(), ((0, 0, 0), (1, 0, 0)));
    }

    #[tokio::test]
    async fn revalidate_deactivate_and_the_cycle_pick_the_client_by_mode() {
        for (restricted, expected) in [
            (true, ((0, 3, 1), (0, 0, 0))),
            (false, ((0, 0, 0), (0, 3, 1))),
        ] {
            let fixture = Fixture::new(restricted);
            let revalidated = revalidate(&fixture.profile, &fixture.runtime, fixture.clients())
                .await
                .expect_err("the counting client fails validate");
            assert!(
                format!("{revalidated:#}").contains("validate"),
                "{revalidated:#}"
            );
            let cycled =
                validate_cycle(&fixture.profile, &fixture.runtime, fixture.clients()).await;
            assert!(cycled.is_some(), "a due cycle reports the fail-soft state");
            // A second cycle is still due (the failed validation changed nothing).
            let again = validate_cycle(&fixture.profile, &fixture.runtime, fixture.clients()).await;
            assert!(again.is_some());
            let deactivated = deactivate(&fixture.profile, &fixture.runtime, fixture.clients())
                .await
                .expect_err("the counting client fails deactivate");
            assert!(
                format!("{deactivated:#}").contains("deactivate"),
                "{deactivated:#}"
            );
            assert_eq!(fixture.reached(), expected, "restricted = {restricted}");
        }
    }

    #[tokio::test]
    async fn the_mode_is_read_at_call_time() {
        let fixture = Fixture::new(false);
        let _ = revalidate(&fixture.profile, &fixture.runtime, fixture.clients()).await;
        assert_eq!(fixture.reached(), ((0, 0, 0), (0, 1, 0)));
        fixture
            .profile
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("restrict");
        let _ = revalidate(&fixture.profile, &fixture.runtime, fixture.clients()).await;
        assert_eq!(fixture.reached(), ((0, 1, 0), (0, 1, 0)));
    }

    /// DA-2 (DR-DA2-4, DA-1 P3 (b)): from stage 1 (the reservation) the
    /// restricted client is chosen although the profile is not restricted yet,
    /// so stages 2 to 4 never reach the unrestricted client. The key grammar
    /// of the restricted path applies as well.
    #[tokio::test]
    async fn restricted_client_is_selected_once_activation_is_reserved() {
        let fixture = Fixture::new(false);
        let _ = revalidate(&fixture.profile, &fixture.runtime, fixture.clients()).await;
        assert_eq!(fixture.reached(), ((0, 0, 0), (0, 1, 0)));
        // The synchronization point: stage 1 marks the reservation.
        fixture.profile.mark_activation_reserved();
        assert!(!fixture.profile.is_restricted());
        let _ = revalidate(&fixture.profile, &fixture.runtime, fixture.clients()).await;
        let _ = deactivate(&fixture.profile, &fixture.runtime, fixture.clients()).await;
        let _ = validate_cycle(&fixture.profile, &fixture.runtime, fixture.clients()).await;
        let error = activate(
            &fixture.profile,
            &fixture.runtime,
            MALFORMED_KEY.to_string(),
            fixture.clients(),
        )
        .await
        .expect_err("the restricted grammar applies once reserved");
        assert!(format!("{error:#}").contains(FORMAT_ERROR), "{error:#}");
        // revalidate and the cycle validate, deactivate deactivates; all on
        // the restricted side. The unrestricted side keeps its first call.
        assert_eq!(fixture.reached(), ((0, 2, 1), (0, 1, 0)));
    }

    /// The napi entry point passes the profile's mode and the production
    /// pair: a restricted Backend refuses a malformed key before any request
    /// (no network is involved), and an unrestricted one does not apply the
    /// grammar (it goes on to the unchanged client; not exercised here because
    /// that client would reach the real origin).
    #[tokio::test]
    async fn the_backend_entry_point_applies_the_restricted_path() {
        let root = std::env::temp_dir().join(format!(
            "grimodex-node-license-backend-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("root");
        let backend =
            crate::Backend::new(root.to_string_lossy().into_owned(), None, None).expect("backend");
        backend
            .state
            .profile_egress
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("restrict");
        let error = backend
            .activate_license(MALFORMED_KEY.to_string())
            .await
            .expect_err("a restricted Backend refuses a malformed key");
        assert!(error.reason.contains(FORMAT_ERROR), "{}", error.reason);
        let _ = std::fs::remove_dir_all(&root);
    }
}
