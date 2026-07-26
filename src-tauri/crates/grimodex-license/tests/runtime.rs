#![cfg(feature = "licensing")]

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use grimodex_core::license::{self as core_license, ActivatedLicense, LicenseFile, NewActivation};
use grimodex_license::{
    activate_license_with_client, deactivate_license_with_client, get_license_state,
    revalidate_license_with_client, run_validate_cycle_with_client, LicenseRuntime,
    PolarActivation, PolarLicenseClient, PolarValidateOutcome, POLAR_EXPECTED_BENEFIT_ID,
};
use tokio::sync::Semaphore;

#[derive(Clone)]
enum ValidateResult {
    Valid(Option<String>),
    Invalid,
    Error(String),
}

#[derive(Clone)]
struct FakeClient {
    activation: Arc<Mutex<PolarActivation>>,
    activate_error: Arc<Mutex<Option<String>>>,
    validate_result: Arc<Mutex<ValidateResult>>,
    deactivate_error: Arc<Mutex<Option<String>>>,
    deactivate_requests: Arc<Mutex<Vec<(String, String)>>>,
    activate_calls: Arc<AtomicUsize>,
    validate_calls: Arc<AtomicUsize>,
    deactivate_calls: Arc<AtomicUsize>,
    block_activate: bool,
    block_validate: bool,
    block_deactivate: bool,
    activate_started: Arc<Semaphore>,
    activate_resume: Arc<Semaphore>,
    validate_started: Arc<Semaphore>,
    validate_resume: Arc<Semaphore>,
    deactivate_started: Arc<Semaphore>,
    deactivate_resume: Arc<Semaphore>,
}

impl Default for FakeClient {
    fn default() -> Self {
        Self {
            activation: Arc::new(Mutex::new(PolarActivation {
                activation_id: "act-default".to_string(),
                benefit_id: Some(POLAR_EXPECTED_BENEFIT_ID.to_string()),
            })),
            activate_error: Arc::new(Mutex::new(None)),
            validate_result: Arc::new(Mutex::new(ValidateResult::Valid(Some(
                "benefit-v1".to_string(),
            )))),
            deactivate_error: Arc::new(Mutex::new(None)),
            deactivate_requests: Arc::new(Mutex::new(Vec::new())),
            activate_calls: Arc::new(AtomicUsize::new(0)),
            validate_calls: Arc::new(AtomicUsize::new(0)),
            deactivate_calls: Arc::new(AtomicUsize::new(0)),
            block_activate: false,
            block_validate: false,
            block_deactivate: false,
            activate_started: Arc::new(Semaphore::new(0)),
            activate_resume: Arc::new(Semaphore::new(0)),
            validate_started: Arc::new(Semaphore::new(0)),
            validate_resume: Arc::new(Semaphore::new(0)),
            deactivate_started: Arc::new(Semaphore::new(0)),
            deactivate_resume: Arc::new(Semaphore::new(0)),
        }
    }
}

impl FakeClient {
    fn with_activation(mut self, activation_id: &str) -> Self {
        self.activation = Arc::new(Mutex::new(PolarActivation {
            activation_id: activation_id.to_string(),
            benefit_id: Some(POLAR_EXPECTED_BENEFIT_ID.to_string()),
        }));
        self
    }

    fn with_activation_benefit(mut self, activation_id: &str, benefit_id: &str) -> Self {
        self.activation = Arc::new(Mutex::new(PolarActivation {
            activation_id: activation_id.to_string(),
            benefit_id: Some(benefit_id.to_string()),
        }));
        self
    }

    fn blocking_activate(mut self) -> Self {
        self.block_activate = true;
        self
    }

    fn blocking_validate(mut self) -> Self {
        self.block_validate = true;
        self
    }

    fn blocking_deactivate(mut self) -> Self {
        self.block_deactivate = true;
        self
    }

    fn set_validate(&self, result: ValidateResult) {
        *self.validate_result.lock().expect("validate result lock") = result;
    }

    fn set_activate_error(&self, message: Option<&str>) {
        *self.activate_error.lock().expect("activate result lock") = message.map(str::to_string);
    }

    fn set_deactivate_error(&self, message: Option<&str>) {
        *self
            .deactivate_error
            .lock()
            .expect("deactivate result lock") = message.map(str::to_string);
    }
}

#[async_trait]
impl PolarLicenseClient for FakeClient {
    async fn activate(&self, _key: &str) -> anyhow::Result<PolarActivation> {
        self.activate_calls.fetch_add(1, Ordering::SeqCst);
        if self.block_activate {
            self.activate_started.add_permits(1);
            self.activate_resume.acquire().await?.forget();
        }
        if let Some(message) = self
            .activate_error
            .lock()
            .expect("activate result lock")
            .clone()
        {
            anyhow::bail!(message);
        }
        Ok(self.activation.lock().expect("activation lock").clone())
    }

    async fn validate(
        &self,
        _key: &str,
        _activation_id: &str,
    ) -> anyhow::Result<PolarValidateOutcome> {
        self.validate_calls.fetch_add(1, Ordering::SeqCst);
        if self.block_validate {
            self.validate_started.add_permits(1);
            self.validate_resume.acquire().await?.forget();
        }
        match self
            .validate_result
            .lock()
            .expect("validate result lock")
            .clone()
        {
            ValidateResult::Valid(benefit_id) => Ok(PolarValidateOutcome::Valid { benefit_id }),
            ValidateResult::Invalid => Ok(PolarValidateOutcome::Invalid),
            ValidateResult::Error(message) => anyhow::bail!(message),
        }
    }

    async fn deactivate(&self, key: &str, activation_id: &str) -> anyhow::Result<()> {
        self.deactivate_calls.fetch_add(1, Ordering::SeqCst);
        self.deactivate_requests
            .lock()
            .expect("deactivate requests lock")
            .push((key.to_string(), activation_id.to_string()));
        if self.block_deactivate {
            self.deactivate_started.add_permits(1);
            self.deactivate_resume.acquire().await?.forget();
        }
        if let Some(message) = self
            .deactivate_error
            .lock()
            .expect("deactivate result lock")
            .clone()
        {
            anyhow::bail!(message);
        }
        Ok(())
    }
}

fn runtime(dir: &tempfile::TempDir) -> Arc<LicenseRuntime> {
    Arc::new(LicenseRuntime::new(dir.path().join("license.json")))
}

fn read(path: &Path) -> LicenseFile {
    core_license::read_license_file(path)
}

fn activated_file(activation_id: &str, last_validated_at: &str) -> LicenseFile {
    LicenseFile {
        license: Some(ActivatedLicense {
            key: "GRIM-KEY-1234".to_string(),
            activation_id: activation_id.to_string(),
            benefit_id: Some("benefit-v1".to_string()),
            activated_at: Some(last_validated_at.to_string()),
            last_validated_at: Some(last_validated_at.to_string()),
            revoked_at: None,
        }),
        ..LicenseFile::default()
    }
}

fn write(runtime: &LicenseRuntime, file: &LicenseFile) {
    core_license::write_license_file(runtime.path(), file).expect("write fixture");
}

fn stale_time() -> String {
    (Utc::now() - chrono::Duration::days(31)).to_rfc3339()
}

#[test]
fn get_is_idempotent_on_the_same_local_day() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);

    let first = get_license_state(&runtime).expect("first get");
    let second = get_license_state(&runtime).expect("second get");
    let file = read(runtime.path());

    assert_eq!(first.status, "trial");
    assert_eq!(second.status, "trial");
    assert_eq!(first.trial_days_remaining, Some(29));
    assert_eq!(second.trial_days_remaining, Some(29));
    assert_eq!(file.trial_used_dates.len(), 1);
}

#[tokio::test]
async fn get_during_activate_await_does_not_lose_either_update() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    let client = Arc::new(
        FakeClient::default()
            .with_activation("act-after-get")
            .blocking_activate(),
    );

    let task = {
        let runtime = Arc::clone(&runtime);
        let client = Arc::clone(&client);
        tokio::spawn(async move {
            activate_license_with_client(&runtime, "GRIM-KEY-1234".to_string(), client.as_ref())
                .await
        })
    };
    client
        .activate_started
        .acquire()
        .await
        .expect("activate started")
        .forget();
    get_license_state(&runtime).expect("get while activate awaits");
    client.activate_resume.add_permits(1);
    task.await.expect("activate task").expect("activate result");

    let file = read(runtime.path());
    assert_eq!(file.trial_used_dates.len(), 1);
    assert_eq!(
        file.license.as_ref().map(|lic| lic.activation_id.as_str()),
        Some("act-after-get")
    );
}

#[tokio::test]
async fn activate_is_single_flight_and_resets_after_success() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    let client = Arc::new(FakeClient::default().blocking_activate());

    let first = {
        let runtime = Arc::clone(&runtime);
        let client = Arc::clone(&client);
        tokio::spawn(async move {
            activate_license_with_client(&runtime, "GRIM-FIRST-1234".to_string(), client.as_ref())
                .await
        })
    };
    client
        .activate_started
        .acquire()
        .await
        .expect("activate started")
        .forget();

    let second = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        activate_license_with_client(&runtime, "GRIM-SECOND-5678".to_string(), client.as_ref()),
    )
    .await
    .expect("concurrent activate must reject without awaiting Polar")
    .expect_err("concurrent activate must be rejected");
    assert!(second.to_string().contains("すでにアクティベーション"));
    assert_eq!(client.activate_calls.load(Ordering::SeqCst), 1);

    client.activate_resume.add_permits(1);
    first.await.expect("activate task").expect("first activate");
    client.activate_resume.add_permits(1);
    activate_license_with_client(&runtime, "GRIM-AFTER-9012".to_string(), client.as_ref())
        .await
        .expect("flag must reset after success");
    assert_eq!(client.activate_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn activate_single_flight_flag_resets_after_client_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    let client = FakeClient::default();
    client.set_activate_error(Some("activate offline"));

    activate_license_with_client(&runtime, "GRIM-ERROR-1234".to_string(), &client)
        .await
        .expect_err("client failure");
    client.set_activate_error(None);
    activate_license_with_client(&runtime, "GRIM-RETRY-5678".to_string(), &client)
        .await
        .expect("flag must reset after client error");
    assert_eq!(client.activate_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn activate_single_flight_flag_resets_when_future_is_cancelled() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    let client = Arc::new(FakeClient::default().blocking_activate());

    let task = {
        let runtime = Arc::clone(&runtime);
        let client = Arc::clone(&client);
        tokio::spawn(async move {
            activate_license_with_client(&runtime, "GRIM-CANCEL-1234".to_string(), client.as_ref())
                .await
        })
    };
    client
        .activate_started
        .acquire()
        .await
        .expect("activate started")
        .forget();
    task.abort();
    assert!(task
        .await
        .expect_err("task must be cancelled")
        .is_cancelled());

    client.activate_resume.add_permits(1);
    activate_license_with_client(&runtime, "GRIM-AFTER-5678".to_string(), client.as_ref())
        .await
        .expect("RAII guard must reset when activate future is dropped");
    assert_eq!(client.activate_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn benefit_mismatch_compensates_the_exact_remote_activation_before_erroring() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    let client = FakeClient::default().with_activation_benefit("act-mismatch", "benefit-v2");

    let error = activate_license_with_client(&runtime, "GRIM-MISMATCH-1234".to_string(), &client)
        .await
        .expect_err("mismatched benefit must fail");

    assert!(error.to_string().contains("別のメジャーバージョン"));
    assert_eq!(client.deactivate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        *client
            .deactivate_requests
            .lock()
            .expect("deactivate requests lock"),
        vec![("GRIM-MISMATCH-1234".to_string(), "act-mismatch".to_string())]
    );
    assert!(!runtime.path().exists());
}

#[tokio::test]
async fn persist_failure_compensates_and_preserves_the_original_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    std::fs::create_dir(runtime.path()).expect("license path becomes a directory");
    let expected = core_license::write_license_file(runtime.path(), &LicenseFile::default())
        .expect_err("fixture path must reject writes")
        .to_string();
    let client = FakeClient::default().with_activation("act-persist-failure");

    let error = activate_license_with_client(&runtime, "GRIM-PERSIST-1234".to_string(), &client)
        .await
        .expect_err("local persist must fail");

    assert_eq!(error.to_string(), expected);
    assert_eq!(
        *client
            .deactivate_requests
            .lock()
            .expect("deactivate requests lock"),
        vec![(
            "GRIM-PERSIST-1234".to_string(),
            "act-persist-failure".to_string()
        )]
    );
}

#[tokio::test]
async fn persist_failure_drops_the_file_lock_before_compensation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    std::fs::create_dir(runtime.path()).expect("license path becomes a directory");
    let client = Arc::new(
        FakeClient::default()
            .with_activation("act-lock-probe")
            .blocking_deactivate(),
    );

    let activate_task = {
        let runtime = Arc::clone(&runtime);
        let client = Arc::clone(&client);
        tokio::spawn(async move {
            activate_license_with_client(&runtime, "GRIM-LOCK-1234".to_string(), client.as_ref())
                .await
        })
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        client.deactivate_started.acquire(),
    )
    .await
    .expect("persist failure must enter compensation")
    .expect("deactivate started")
    .forget();

    let mut lock_probe = {
        let runtime = Arc::clone(&runtime);
        tokio::task::spawn_blocking(move || get_license_state(&runtime))
    };
    let probe_result =
        tokio::time::timeout(std::time::Duration::from_millis(500), &mut lock_probe).await;
    client.deactivate_resume.add_permits(1);
    activate_task
        .await
        .expect("activate task")
        .expect_err("persist failure remains the result");

    match probe_result {
        Ok(joined) => {
            joined
                .expect("lock probe task")
                .expect_err("directory path still makes the probe write fail");
        }
        Err(_) => {
            let _ = lock_probe.await;
            panic!("license file lock was held across compensating deactivate");
        }
    }
}

#[tokio::test]
async fn compensation_failure_reports_both_the_original_and_cleanup_errors() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    let client = FakeClient::default().with_activation_benefit("act-mismatch", "benefit-v2");
    client.set_deactivate_error(Some("cleanup offline"));

    let error = activate_license_with_client(&runtime, "GRIM-MISMATCH-1234".to_string(), &client)
        .await
        .expect_err("mismatch and failed compensation must fail");
    let message = format!("{error:#}");

    assert!(message.contains("別のメジャーバージョン"), "{message}");
    assert!(message.contains("cleanup offline"), "{message}");
}

#[tokio::test]
async fn revalidate_is_single_flight_and_flag_resets_after_success() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    write(&runtime, &activated_file("act-old", &stale_time()));
    let client = Arc::new(FakeClient::default().blocking_validate());

    let first = {
        let runtime = Arc::clone(&runtime);
        let client = Arc::clone(&client);
        tokio::spawn(async move { revalidate_license_with_client(&runtime, client.as_ref()).await })
    };
    client
        .validate_started
        .acquire()
        .await
        .expect("validate started")
        .forget();
    let error = revalidate_license_with_client(&runtime, client.as_ref())
        .await
        .expect_err("second validation must be rejected");
    assert!(error.to_string().contains("すでに再検証"));
    assert_eq!(client.validate_calls.load(Ordering::SeqCst), 1);

    client.validate_resume.add_permits(1);
    first
        .await
        .expect("validate task")
        .expect("first validation");
    client.validate_resume.add_permits(1);
    revalidate_license_with_client(&runtime, client.as_ref())
        .await
        .expect("flag must reset after success");
}

#[tokio::test]
async fn revalidate_flag_resets_after_no_license_and_client_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    let client = FakeClient::default();

    revalidate_license_with_client(&runtime, &client)
        .await
        .expect_err("no activation");
    write(&runtime, &activated_file("act-old", &stale_time()));
    client.set_validate(ValidateResult::Error("offline".to_string()));
    revalidate_license_with_client(&runtime, &client)
        .await
        .expect_err("communication failure");
    client.set_validate(ValidateResult::Valid(None));
    revalidate_license_with_client(&runtime, &client)
        .await
        .expect("flag must reset on every error exit");
    assert_eq!(client.validate_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn revalidate_flag_resets_when_the_in_flight_future_is_cancelled() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    write(&runtime, &activated_file("act-old", &stale_time()));
    let client = Arc::new(FakeClient::default().blocking_validate());

    let task = {
        let runtime = Arc::clone(&runtime);
        let client = Arc::clone(&client);
        tokio::spawn(async move { revalidate_license_with_client(&runtime, client.as_ref()).await })
    };
    client
        .validate_started
        .acquire()
        .await
        .expect("validate started")
        .forget();
    task.abort();
    assert!(task
        .await
        .expect_err("task must be cancelled")
        .is_cancelled());

    client.validate_resume.add_permits(1);
    revalidate_license_with_client(&runtime, client.as_ref())
        .await
        .expect("RAII guard must reset the flag when its future is dropped");
    assert_eq!(client.validate_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn revalidate_applies_valid_invalid_and_preserves_state_on_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    let client = FakeClient::default();

    write(&runtime, &activated_file("act-valid", &stale_time()));
    let valid = revalidate_license_with_client(&runtime, &client)
        .await
        .expect("valid response");
    assert_eq!(valid.status, "licensed");

    write(&runtime, &activated_file("act-invalid", &stale_time()));
    client.set_validate(ValidateResult::Invalid);
    let invalid = revalidate_license_with_client(&runtime, &client)
        .await
        .expect("invalid is an explicit server outcome");
    assert_eq!(invalid.status, "revoked");

    write(&runtime, &activated_file("act-error", &stale_time()));
    let before = read(runtime.path());
    client.set_validate(ValidateResult::Error("offline".to_string()));
    revalidate_license_with_client(&runtime, &client)
        .await
        .expect_err("communication failure");
    assert_eq!(read(runtime.path()), before);
}

#[tokio::test]
async fn revalidate_does_not_overwrite_an_activation_created_while_awaiting() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    write(&runtime, &activated_file("act-old", &stale_time()));
    let validating = Arc::new(FakeClient::default().blocking_validate());
    let replacement = FakeClient::default().with_activation("act-new");

    let task = {
        let runtime = Arc::clone(&runtime);
        let validating = Arc::clone(&validating);
        tokio::spawn(
            async move { revalidate_license_with_client(&runtime, validating.as_ref()).await },
        )
    };
    validating
        .validate_started
        .acquire()
        .await
        .expect("validate started")
        .forget();
    activate_license_with_client(&runtime, "GRIM-NEW-5678".to_string(), &replacement)
        .await
        .expect("replacement activation");
    validating.validate_resume.add_permits(1);
    task.await
        .expect("validate task")
        .expect("stale validate response is ignored");

    assert_eq!(
        read(runtime.path())
            .license
            .as_ref()
            .map(|license| license.activation_id.as_str()),
        Some("act-new")
    );
}

#[tokio::test]
async fn deactivate_success_removes_local_license_and_error_preserves_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    let client = FakeClient::default();

    write(&runtime, &activated_file("act-remove", &stale_time()));
    let dto = deactivate_license_with_client(&runtime, &client)
        .await
        .expect("204/404 are represented by client success");
    assert_eq!(dto.status, "trial");
    assert!(read(runtime.path()).license.is_none());

    write(&runtime, &activated_file("act-keep", &stale_time()));
    client.set_deactivate_error(Some("HTTP 500"));
    deactivate_license_with_client(&runtime, &client)
        .await
        .expect_err("500 must fail");
    assert_eq!(
        read(runtime.path())
            .license
            .as_ref()
            .map(|license| license.activation_id.as_str()),
        Some("act-keep")
    );
}

#[tokio::test]
async fn deactivate_does_not_remove_an_activation_created_while_awaiting() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    write(&runtime, &activated_file("act-old", &stale_time()));
    let deactivating = Arc::new(FakeClient::default().blocking_deactivate());
    let replacement = FakeClient::default().with_activation("act-new");

    let task = {
        let runtime = Arc::clone(&runtime);
        let deactivating = Arc::clone(&deactivating);
        tokio::spawn(async move {
            deactivate_license_with_client(&runtime, deactivating.as_ref()).await
        })
    };
    deactivating
        .deactivate_started
        .acquire()
        .await
        .expect("deactivate started")
        .forget();
    activate_license_with_client(&runtime, "GRIM-NEW-5678".to_string(), &replacement)
        .await
        .expect("replacement activation");
    deactivating.deactivate_resume.add_permits(1);
    task.await
        .expect("deactivate task")
        .expect("stale deactivate response is ignored");

    assert_eq!(
        read(runtime.path())
            .license
            .as_ref()
            .map(|license| license.activation_id.as_str()),
        Some("act-new")
    );
}

#[tokio::test]
async fn background_returns_none_when_not_due_and_some_unchanged_on_failure() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    let client = FakeClient::default();

    write(
        &runtime,
        &activated_file("act-fresh", &Utc::now().to_rfc3339()),
    );
    assert_eq!(
        run_validate_cycle_with_client(&runtime, &client).await,
        None
    );
    assert_eq!(client.validate_calls.load(Ordering::SeqCst), 0);

    write(&runtime, &activated_file("act-stale", &stale_time()));
    let before = read(runtime.path());
    client.set_validate(ValidateResult::Error("offline".to_string()));
    let dto = run_validate_cycle_with_client(&runtime, &client)
        .await
        .expect("attempted background validation must emit unchanged DTO");
    assert_eq!(dto.status, "license_stale");
    assert_eq!(read(runtime.path()), before);
}

#[tokio::test]
async fn background_skip_after_activation_race_returns_current_dto_and_resets_flag() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = runtime(&dir);
    write(&runtime, &activated_file("act-old", &stale_time()));
    let validating = Arc::new(FakeClient::default().blocking_validate());
    let replacement = FakeClient::default().with_activation("act-new");

    let task = {
        let runtime = Arc::clone(&runtime);
        let validating = Arc::clone(&validating);
        tokio::spawn(
            async move { run_validate_cycle_with_client(&runtime, validating.as_ref()).await },
        )
    };
    validating
        .validate_started
        .acquire()
        .await
        .expect("validate started")
        .forget();
    assert_eq!(
        run_validate_cycle_with_client(&runtime, validating.as_ref()).await,
        None,
        "in-flight background cycle must skip"
    );
    activate_license_with_client(&runtime, "GRIM-NEW-5678".to_string(), &replacement)
        .await
        .expect("replacement activation");
    validating.validate_resume.add_permits(1);
    let dto = task
        .await
        .expect("background task")
        .expect("attempted cycle returns the current DTO even when mutation is skipped");
    assert_eq!(dto.key_tail.as_deref(), Some("5678"));

    write(&runtime, &activated_file("act-stale-again", &stale_time()));
    validating.validate_resume.add_permits(1);
    assert!(
        run_validate_cycle_with_client(&runtime, validating.as_ref())
            .await
            .is_some()
    );
}

#[test]
fn fixture_apply_activation_remains_compatible_with_shared_core() {
    let mut file = LicenseFile::default();
    core_license::apply_activation(
        &mut file,
        NewActivation {
            key: "K".to_string(),
            activation_id: "A".to_string(),
            benefit_id: None,
        },
        Utc::now(),
    );
    assert_eq!(file.license.expect("activation").activation_id, "A");
}
