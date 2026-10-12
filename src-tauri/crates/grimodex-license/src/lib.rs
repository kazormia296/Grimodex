//! Shared license orchestration for the Tauri and Electron shells.
//!
//! The license file is the sole source of truth. [`LicenseRuntime`] only owns
//! the process-local synchronization needed to make every read-modify-write
//! transaction atomic across shell commands. No mutex guard is held across an
//! HTTP await; responses are applied only after re-reading the current file.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use async_trait::async_trait;
use grimodex_core::license::{self as core_license, LicenseFile, LicenseSnapshot};
use serde::{Deserialize, Serialize};

/// Whether license enforcement is active in this build.
pub const LICENSING_ENABLED: bool = cfg!(feature = "licensing");

/// Stable IPC DTO shared by both desktop shells.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStateDto {
    pub licensing_enabled: bool,
    pub status: String,
    pub trial_days_remaining: Option<u32>,
    pub grace_days_remaining: Option<u32>,
    pub key_tail: Option<String>,
    pub activated_at: Option<String>,
    pub last_validated_at: Option<String>,
}

/// Exact disabled-build response. It does not inspect or create a file.
pub fn disabled_dto() -> LicenseStateDto {
    LicenseStateDto {
        licensing_enabled: false,
        status: "disabled".to_string(),
        trial_days_remaining: None,
        grace_days_remaining: None,
        key_tail: None,
        activated_at: None,
        last_validated_at: None,
    }
}

/// Build the renderer-facing DTO without exposing the full license key.
pub fn build_dto(file: &LicenseFile, snapshot: &LicenseSnapshot) -> LicenseStateDto {
    let license = file.license.as_ref();
    LicenseStateDto {
        licensing_enabled: true,
        status: snapshot.status.as_str().to_string(),
        trial_days_remaining: snapshot.trial_days_remaining,
        grace_days_remaining: snapshot.grace_days_remaining,
        key_tail: license.map(|license| key_tail(&license.key)),
        activated_at: license.and_then(|license| license.activated_at.clone()),
        last_validated_at: license.and_then(|license| license.last_validated_at.clone()),
    }
}

fn key_tail(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let start = chars.len().saturating_sub(4);
    chars[start..].iter().collect()
}

/// Process-local synchronization for one `license.json` file.
#[derive(Debug)]
pub struct LicenseRuntime {
    path: PathBuf,
    write_lock: Mutex<()>,
    activate_in_flight: AtomicBool,
    validate_in_flight: AtomicBool,
}

impl LicenseRuntime {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            write_lock: Mutex::new(()),
            activate_in_flight: AtomicBool::new(false),
            validate_in_flight: AtomicBool::new(false),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn lock_file(&self) -> anyhow::Result<MutexGuard<'_, ()>> {
        self.write_lock
            .lock()
            .map_err(|error| anyhow::anyhow!("license write lock poisoned: {error}"))
    }
}

fn now_pair() -> (chrono::DateTime<chrono::Utc>, String) {
    (
        chrono::Utc::now(),
        chrono::Local::now().format("%Y-%m-%d").to_string(),
    )
}

fn ensure_licensing_enabled() -> anyhow::Result<()> {
    if LICENSING_ENABLED {
        Ok(())
    } else {
        anyhow::bail!("このビルドではライセンス機構が無効です")
    }
}

fn is_same_activation(file: &LicenseFile, activation_id: &str) -> bool {
    file.license
        .as_ref()
        .is_some_and(|license| license.activation_id == activation_id)
}

struct InFlight<'a>(&'a AtomicBool);

impl<'a> InFlight<'a> {
    fn try_begin(flag: &'a AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(flag))
    }
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Polar activate response fields persisted locally.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolarActivation {
    pub activation_id: String,
    pub benefit_id: Option<String>,
}

/// A server-invalid response is deliberately distinct from transport failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolarValidateOutcome {
    Valid { benefit_id: Option<String> },
    Invalid,
}

/// Small async seam used by the orchestrator and deterministic race tests.
// `async_trait` adds `#[must_use]` to boxed futures that are already `must_use`.
#[allow(clippy::double_must_use)]
#[async_trait]
pub trait PolarLicenseClient: Send + Sync {
    async fn activate(&self, key: &str) -> anyhow::Result<PolarActivation>;
    async fn validate(
        &self,
        key: &str,
        activation_id: &str,
    ) -> anyhow::Result<PolarValidateOutcome>;
    async fn deactivate(&self, key: &str, activation_id: &str) -> anyhow::Result<()>;
}

/// Production Polar client.
#[derive(Debug, Clone, Copy, Default)]
pub struct PolarClient;

#[async_trait]
impl PolarLicenseClient for PolarClient {
    async fn activate(&self, key: &str) -> anyhow::Result<PolarActivation> {
        polar_activate(key).await
    }

    async fn validate(
        &self,
        key: &str,
        activation_id: &str,
    ) -> anyhow::Result<PolarValidateOutcome> {
        polar_validate(key, activation_id).await
    }

    async fn deactivate(&self, key: &str, activation_id: &str) -> anyhow::Result<()> {
        polar_deactivate(key, activation_id).await
    }
}

pub fn get_license_state(runtime: &LicenseRuntime) -> anyhow::Result<LicenseStateDto> {
    if !LICENSING_ENABLED {
        return Ok(disabled_dto());
    }

    let (now, today) = now_pair();
    let _guard = runtime.lock_file()?;
    let mut file = core_license::read_license_file(runtime.path());
    let mut changed = core_license::ensure_initialized(&mut file, now);
    changed |= core_license::register_usage_day(&mut file, &today);
    let seen = core_license::update_last_seen(&mut file, now);
    changed |= seen.changed;
    if seen.rollback_detected {
        tracing::warn!("license: clock rollback detected (now < last_seen_at)");
    }
    if changed {
        core_license::write_license_file(runtime.path(), &file)?;
    }
    let snapshot = core_license::compute_snapshot(&file, now, &today);
    Ok(build_dto(&file, &snapshot))
}

pub async fn activate_license(
    runtime: &LicenseRuntime,
    key: String,
) -> anyhow::Result<LicenseStateDto> {
    activate_license_with_client(runtime, key, &PolarClient).await
}

pub async fn activate_license_with_client<C: PolarLicenseClient + ?Sized>(
    runtime: &LicenseRuntime,
    key: String,
    client: &C,
) -> anyhow::Result<LicenseStateDto> {
    ensure_licensing_enabled()?;
    let Some(_in_flight) = InFlight::try_begin(&runtime.activate_in_flight) else {
        anyhow::bail!("すでにアクティベーションを実行中です");
    };
    let activation = client.activate(&key).await?;
    if benefit_mismatch(activation.benefit_id.as_deref()) {
        let original = anyhow::anyhow!(
            "このライセンスキーは別のメジャーバージョン用です（このバージョンでは利用できません）"
        );
        return Err(compensate_activation(client, &key, &activation.activation_id, original).await);
    }

    let activation_id = activation.activation_id;
    let benefit_id = activation.benefit_id;
    let persist_result = (|| {
        let (now, today) = now_pair();
        let _guard = runtime.lock_file()?;
        let mut file = core_license::read_license_file(runtime.path());
        core_license::apply_activation(
            &mut file,
            core_license::NewActivation {
                key: key.clone(),
                activation_id: activation_id.clone(),
                benefit_id: benefit_id.clone(),
            },
            now,
        );
        core_license::write_license_file(runtime.path(), &file)?;
        let snapshot = core_license::compute_snapshot(&file, now, &today);
        Ok(build_dto(&file, &snapshot))
    })();

    match persist_result {
        Ok(dto) => Ok(dto),
        Err(original) => Err(compensate_activation(client, &key, &activation_id, original).await),
    }
}

async fn compensate_activation<C: PolarLicenseClient + ?Sized>(
    client: &C,
    key: &str,
    activation_id: &str,
    original: anyhow::Error,
) -> anyhow::Error {
    match client.deactivate(key, activation_id).await {
        Ok(()) => original,
        Err(cleanup) => anyhow::anyhow!(
            "{original:#}; compensating license deactivation also failed: {cleanup:#}"
        ),
    }
}

pub async fn revalidate_license(runtime: &LicenseRuntime) -> anyhow::Result<LicenseStateDto> {
    revalidate_license_with_client(runtime, &PolarClient).await
}

pub async fn revalidate_license_with_client<C: PolarLicenseClient + ?Sized>(
    runtime: &LicenseRuntime,
    client: &C,
) -> anyhow::Result<LicenseStateDto> {
    ensure_licensing_enabled()?;
    let Some(_in_flight) = InFlight::try_begin(&runtime.validate_in_flight) else {
        anyhow::bail!("すでに再検証を実行中です");
    };

    let license = {
        let _guard = runtime.lock_file()?;
        let file = core_license::read_license_file(runtime.path());
        file.license
            .ok_or_else(|| anyhow::anyhow!("ライセンスがアクティベートされていません"))?
    };
    let outcome = client
        .validate(&license.key, &license.activation_id)
        .await?;

    let (now, today) = now_pair();
    let _guard = runtime.lock_file()?;
    let mut file = core_license::read_license_file(runtime.path());
    let changed = match outcome {
        PolarValidateOutcome::Valid { benefit_id } => {
            is_same_activation(&file, &license.activation_id)
                && core_license::apply_validate_success(&mut file, benefit_id.as_deref(), now)
        }
        PolarValidateOutcome::Invalid => {
            is_same_activation(&file, &license.activation_id)
                && core_license::apply_revoked(&mut file, now)
        }
    };
    if changed {
        core_license::write_license_file(runtime.path(), &file)?;
    }
    let snapshot = core_license::compute_snapshot(&file, now, &today);
    Ok(build_dto(&file, &snapshot))
}

pub async fn deactivate_license(runtime: &LicenseRuntime) -> anyhow::Result<LicenseStateDto> {
    deactivate_license_with_client(runtime, &PolarClient).await
}

pub async fn deactivate_license_with_client<C: PolarLicenseClient + ?Sized>(
    runtime: &LicenseRuntime,
    client: &C,
) -> anyhow::Result<LicenseStateDto> {
    ensure_licensing_enabled()?;
    let license = {
        let _guard = runtime.lock_file()?;
        let file = core_license::read_license_file(runtime.path());
        file.license
            .ok_or_else(|| anyhow::anyhow!("ライセンスがアクティベートされていません"))?
    };
    client
        .deactivate(&license.key, &license.activation_id)
        .await?;

    let (now, today) = now_pair();
    let _guard = runtime.lock_file()?;
    let mut file = core_license::read_license_file(runtime.path());
    if is_same_activation(&file, &license.activation_id)
        && core_license::apply_deactivation(&mut file)
    {
        core_license::write_license_file(runtime.path(), &file)?;
    }
    let snapshot = core_license::compute_snapshot(&file, now, &today);
    Ok(build_dto(&file, &snapshot))
}

/// Run one background validation cycle.
///
/// `None` means disabled, not due, no activation, or another validation is in
/// flight. Once network validation was attempted, the current DTO is always
/// returned, including transport errors and stale-response races, so shells can
/// confirm the fail-soft state to the renderer.
pub async fn run_validate_cycle(runtime: &LicenseRuntime) -> Option<LicenseStateDto> {
    run_validate_cycle_with_client(runtime, &PolarClient).await
}

pub async fn run_validate_cycle_with_client<C: PolarLicenseClient + ?Sized>(
    runtime: &LicenseRuntime,
    client: &C,
) -> Option<LicenseStateDto> {
    if !LICENSING_ENABLED {
        return None;
    }

    let (now, today) = now_pair();
    let (license, needs_validation) = {
        let _guard = match runtime.lock_file() {
            Ok(guard) => guard,
            Err(error) => {
                tracing::warn!("license: failed to lock for background validation: {error}");
                return None;
            }
        };
        let file = core_license::read_license_file(runtime.path());
        let snapshot = core_license::compute_snapshot(&file, now, &today);
        (file.license, snapshot.needs_validation)
    };
    if !needs_validation {
        return None;
    }
    let license = license?;
    let _in_flight = InFlight::try_begin(&runtime.validate_in_flight)?;

    let outcome = client.validate(&license.key, &license.activation_id).await;
    let (now, today) = now_pair();
    let _guard = match runtime.write_lock.lock() {
        Ok(guard) => guard,
        Err(poison) => {
            tracing::warn!("license: recovering poisoned write lock in background validation");
            poison.into_inner()
        }
    };
    let mut file = core_license::read_license_file(runtime.path());
    let changed = match outcome {
        Ok(PolarValidateOutcome::Valid { benefit_id }) => {
            is_same_activation(&file, &license.activation_id)
                && core_license::apply_validate_success(&mut file, benefit_id.as_deref(), now)
        }
        Ok(PolarValidateOutcome::Invalid) => {
            is_same_activation(&file, &license.activation_id)
                && core_license::apply_revoked(&mut file, now)
        }
        Err(error) => {
            tracing::info!("license: background validate failed (retry next cycle): {error}");
            false
        }
    };
    if changed {
        if let Err(error) = core_license::write_license_file(runtime.path(), &file) {
            tracing::warn!("license: failed to persist background validation: {error}");
        }
    }
    let snapshot = core_license::compute_snapshot(&file, now, &today);
    Some(build_dto(&file, &snapshot))
}

// ---------------------------------------------------------------------------
// Polar HTTP client
// ---------------------------------------------------------------------------

pub const POLAR_ORGANIZATION_ID: &str = "73eb02b0-1226-401e-9f77-141f5f1be4a4";
pub const POLAR_EXPECTED_BENEFIT_ID: &str = "25ee67c4-f7d1-4c4f-becb-d0201992779f";
const POLAR_BASE_URL: &str = "https://api.polar.sh";

pub fn activation_label() -> String {
    let os = match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    format!("Grimodex on {os}")
}

pub fn benefit_mismatch(benefit_id: Option<&str>) -> bool {
    benefit_mismatch_with(POLAR_EXPECTED_BENEFIT_ID, benefit_id)
}

#[doc(hidden)]
pub fn benefit_mismatch_with(expected: &str, benefit_id: Option<&str>) -> bool {
    if expected.is_empty() {
        return false;
    }
    match benefit_id {
        Some(benefit) => benefit != expected,
        None => false,
    }
}

fn polar_http_client() -> anyhow::Result<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(5))
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .ok()
        })
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("HTTP クライアントの初期化に失敗しました"))
}

pub async fn polar_activate(key: &str) -> anyhow::Result<PolarActivation> {
    polar_activate_at(POLAR_BASE_URL, POLAR_ORGANIZATION_ID, key).await
}

pub async fn polar_validate(
    key: &str,
    activation_id: &str,
) -> anyhow::Result<PolarValidateOutcome> {
    polar_validate_at(
        POLAR_BASE_URL,
        POLAR_ORGANIZATION_ID,
        POLAR_EXPECTED_BENEFIT_ID,
        key,
        activation_id,
    )
    .await
}

pub async fn polar_deactivate(key: &str, activation_id: &str) -> anyhow::Result<()> {
    polar_deactivate_at(POLAR_BASE_URL, POLAR_ORGANIZATION_ID, key, activation_id).await
}

#[derive(Deserialize)]
struct ActivateResponse {
    id: String,
    #[serde(default)]
    license_key: Option<ActivateLicenseKey>,
}

#[derive(Deserialize)]
struct ActivateLicenseKey {
    #[serde(default)]
    benefit_id: Option<String>,
}

#[derive(Deserialize)]
struct ValidateResponse {
    status: String,
    #[serde(default)]
    benefit_id: Option<String>,
}

#[doc(hidden)]
pub async fn polar_activate_at(
    base_url: &str,
    organization_id: &str,
    key: &str,
) -> anyhow::Result<PolarActivation> {
    let url = format!("{base_url}/v1/customer-portal/license-keys/activate");
    let response = polar_http_client()?
        .post(url)
        .json(&serde_json::json!({
            "key": key,
            "organization_id": organization_id,
            "label": activation_label(),
        }))
        .send()
        .await
        .map_err(|error| anyhow::anyhow!("ライセンスサーバーに接続できませんでした: {error}"))?;
    match response.status().as_u16() {
        200 => {
            let parsed: ActivateResponse = response.json().await.map_err(|error| {
                anyhow::anyhow!("ライセンスサーバーの応答を解釈できませんでした: {error}")
            })?;
            Ok(PolarActivation {
                activation_id: parsed.id,
                benefit_id: parsed.license_key.and_then(|license| license.benefit_id),
            })
        }
        403 => anyhow::bail!(
            "アクティベーション上限に達しています。設定画面から使っていない端末を解除してください"
        ),
        404 => anyhow::bail!("ライセンスキーが見つかりません。入力内容を確認してください"),
        422 => anyhow::bail!("リクエスト形式が不正です（アプリの不具合の可能性があります）"),
        status => anyhow::bail!("ライセンスサーバーがエラーを返しました (HTTP {status})"),
    }
}

#[doc(hidden)]
pub async fn polar_validate_at(
    base_url: &str,
    organization_id: &str,
    expected_benefit_id: &str,
    key: &str,
    activation_id: &str,
) -> anyhow::Result<PolarValidateOutcome> {
    let url = format!("{base_url}/v1/customer-portal/license-keys/validate");
    let response = polar_http_client()?
        .post(url)
        .json(&serde_json::json!({
            "key": key,
            "organization_id": organization_id,
            "activation_id": activation_id,
        }))
        .send()
        .await
        .map_err(|error| anyhow::anyhow!("ライセンスサーバーに接続できませんでした: {error}"))?;
    match response.status().as_u16() {
        200 => {
            let parsed: ValidateResponse = response.json().await.map_err(|error| {
                anyhow::anyhow!("ライセンスサーバーの応答を解釈できませんでした: {error}")
            })?;
            if parsed.status == "granted"
                && !benefit_mismatch_with(expected_benefit_id, parsed.benefit_id.as_deref())
            {
                Ok(PolarValidateOutcome::Valid {
                    benefit_id: parsed.benefit_id,
                })
            } else {
                Ok(PolarValidateOutcome::Invalid)
            }
        }
        404 => Ok(PolarValidateOutcome::Invalid),
        status => anyhow::bail!("ライセンスサーバーがエラーを返しました (HTTP {status})"),
    }
}

#[doc(hidden)]
pub async fn polar_deactivate_at(
    base_url: &str,
    organization_id: &str,
    key: &str,
    activation_id: &str,
) -> anyhow::Result<()> {
    let url = format!("{base_url}/v1/customer-portal/license-keys/deactivate");
    let response = polar_http_client()?
        .post(url)
        .json(&serde_json::json!({
            "key": key,
            "organization_id": organization_id,
            "activation_id": activation_id,
        }))
        .send()
        .await
        .map_err(|error| anyhow::anyhow!("ライセンスサーバーに接続できませんでした: {error}"))?;
    match response.status().as_u16() {
        204 => Ok(()),
        404 => {
            tracing::warn!("license: deactivate got 404 (already deactivated server-side)");
            Ok(())
        }
        status => anyhow::bail!("ライセンスサーバーがエラーを返しました (HTTP {status})"),
    }
}
