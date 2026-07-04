//! ライセンス機構の Tauri 側グルー。
//!
//! 状態機械と license.json の IO は `grimodex_core::license` が正本 (MCP サーバー
//! と共有するため core に置く)。ここにはフロント向け DTO の構築と Polar
//! クライアント (Phase 3 で実装、現状はスタブ) を置く。
//!
//! ビルドフラグ: Cargo feature `licensing` が無効 (ベータ配布) のときは
//! `get_license_state` が `licensing_enabled: false` を返し、フロントは全ゲートを
//! 素通りさせ License UI を隠す (設計書 §9.1)。コマンド自体は常時登録する —
//! `semantic-embedding` のように generate_handler から消すと無効ビルドで
//! invoke 不能になりフロントが壊れるため。

use grimodex_core::license::{LicenseFile, LicenseSnapshot};
use serde::Serialize;

/// このビルドでライセンス機構が有効か (Cargo feature `licensing`)。
pub(crate) const LICENSING_ENABLED: bool = cfg!(feature = "licensing");

/// `get_license_state` がフロントへ返す DTO。IPC 境界は camelCase (Tauri 規約)。
/// ディスク上の license.json (snake_case) とは別物 — 命名を混ぜない。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LicenseStateDto {
    pub(crate) licensing_enabled: bool,
    /// 設計書 §3 の状態名 ("trial" | "trial_expired" | "licensed" | "grace" |
    /// "license_stale" | "revoked")。licensing 無効ビルドのみ "disabled"。
    pub(crate) status: String,
    pub(crate) trial_days_remaining: Option<u32>,
    pub(crate) grace_days_remaining: Option<u32>,
    /// キー末尾 4 文字 (Settings の「キー末尾 XXXX」表示用、§7)。
    pub(crate) key_tail: Option<String>,
    pub(crate) activated_at: Option<String>,
    pub(crate) last_validated_at: Option<String>,
}

/// licensing 無効ビルド用の DTO。license.json には触れない (試用日を消費しない)。
pub(crate) fn disabled_dto() -> LicenseStateDto {
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

/// 状態スナップショットから DTO を組み立てる。
pub(crate) fn build_dto(file: &LicenseFile, snapshot: &LicenseSnapshot) -> LicenseStateDto {
    let lic = file.license.as_ref();
    LicenseStateDto {
        licensing_enabled: true,
        status: snapshot.status.as_str().to_string(),
        trial_days_remaining: snapshot.trial_days_remaining,
        grace_days_remaining: snapshot.grace_days_remaining,
        key_tail: lic.map(|l| key_tail(&l.key)),
        activated_at: lic.and_then(|l| l.activated_at.clone()),
        last_validated_at: lic.and_then(|l| l.last_validated_at.clone()),
    }
}

/// キー末尾 4 文字 (4 文字未満ならキー全体)。char 境界で安全に切る。
fn key_tail(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let start = chars.len().saturating_sub(4);
    chars[start..].iter().collect()
}

// ---------------------------------------------------------------------------
// Polar クライアント (設計書 §4.2、2026-06-11 に docs.polar.sh + 実測で仕様確定)
//
// 契約 (設計書 §3/§4.2):
// - Err = 通信失敗 (ネットワーク不達・Polar 障害・5xx・タイムアウト・422)。
//   呼び出し側は状態を変えない (fail-soft)。revoked に倒してはならない。
//   422 はこちらのリクエスト不正 = アプリのバグであり、ユーザーのキーを
//   revoked に落とす理由にならない。
// - validate の「キー無効」は Ok(PolarValidateOutcome::Invalid)。
//   実仕様: 200 + status ∈ {revoked, disabled}、または 404 ResourceNotFound
//   (キー不存在 = Polar の明示応答)。granted のみ Valid。
// - エラーボディ実測: {"error":"ResourceNotFound","detail":"Not found"} 形。
// ---------------------------------------------------------------------------

/// Polar Organization ID (§4.1: アプリにハードコード埋め込み)。
/// Grimodex Organization (slug: grimodex) の実 ID。2026-07-04 設定。
/// licensing feature が無効な間 (ベータ) は到達しないコード。
pub(crate) const POLAR_ORGANIZATION_ID: &str = "73eb02b0-1226-401e-9f77-141f5f1be4a4";

/// メジャーバージョン期待 benefit_id (§4.3)。空文字の間は照合をスキップする。
/// v1.0 発売時は意図的に空のまま = 照合スキップで運用する。実キーの live E2E で
/// validate 応答が返す実 benefit_id を確認後、follow-up で実値を設定する
/// (§4.3 の罠: 実測前に埋めると不一致で正規キーを全 revoked に誤爆する)。
pub(crate) const POLAR_EXPECTED_BENEFIT_ID: &str = "";

const POLAR_BASE_URL: &str = "https://api.polar.sh";

/// Polar activate 応答のうちアプリが保存するフィールド。
#[derive(Debug)]
pub(crate) struct PolarActivation {
    pub(crate) activation_id: String,
    pub(crate) benefit_id: Option<String>,
}

/// validate の明示応答。Err (通信失敗) とは厳密に区別する。
#[derive(Debug)]
pub(crate) enum PolarValidateOutcome {
    /// Polar が有効と明示 (200 + status=granted)。
    Valid { benefit_id: Option<String> },
    /// Polar が「キー無効」を明示 (200 + status=revoked/disabled、または
    /// 404 キー不存在) → revoked へ。
    Invalid,
}

/// アクティベーションラベル。"Grimodex on <OS>" のみ — ホスト名・ユーザー名等の
/// 端末情報は送らない (設計書 §8.1 の送信全量に含まれる文字列)。
pub(crate) fn activation_label() -> String {
    let os = match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    format!("Grimodex on {os}")
}

/// §4.3 benefit_id 照合。**「存在して不一致」のときのみ** true (= 弾く)。
/// 欠損 (None) は照合せず通す — 応答仕様の揺れで正規キーを弾かない・
/// 曖昧ケースを revoked に倒さない (fail-soft、コミット前レビュー確定指摘)。
/// 期待値が未設定 (ベータ〜Product 作成前) も素通り。
pub(crate) fn benefit_mismatch(benefit_id: Option<&str>) -> bool {
    benefit_mismatch_with(POLAR_EXPECTED_BENEFIT_ID, benefit_id)
}

fn benefit_mismatch_with(expected: &str, benefit_id: Option<&str>) -> bool {
    if expected.is_empty() {
        return false;
    }
    match benefit_id {
        Some(b) => b != expected,
        None => false,
    }
}

/// Polar 用 HTTP クライアント。設計書 §5.4: connect 5s / total 15s を明示
/// (既存 ai.rs の `Client::new()` は timeout 無設定なので踏襲しない)。
///
/// 初期化失敗 (TLS 初期化不能等の壊れた環境) は Err = 通信失敗扱いに倒す。
/// reqwest の `Client::default()` は内部で `build().expect()` するため
/// フォールバックにならない (panic する) — Option キャッシュで本物の
/// fail-soft にする (コミット前レビュー確定指摘)。
fn polar_http_client() -> anyhow::Result<&'static reqwest::Client> {
    static CLIENT: std::sync::OnceLock<Option<reqwest::Client>> = std::sync::OnceLock::new();
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

pub(crate) async fn polar_activate(key: &str) -> anyhow::Result<PolarActivation> {
    polar_activate_at(POLAR_BASE_URL, POLAR_ORGANIZATION_ID, key).await
}

pub(crate) async fn polar_validate(
    key: &str,
    activation_id: &str,
) -> anyhow::Result<PolarValidateOutcome> {
    polar_validate_at(POLAR_BASE_URL, POLAR_ORGANIZATION_ID, key, activation_id).await
}

pub(crate) async fn polar_deactivate(key: &str, activation_id: &str) -> anyhow::Result<()> {
    polar_deactivate_at(POLAR_BASE_URL, POLAR_ORGANIZATION_ID, key, activation_id).await
}

/// activate 応答 (200) のうち読むフィールドだけ。未知フィールドは無視。
#[derive(serde::Deserialize)]
struct ActivateResponse {
    /// アクティベーション ID。
    id: String,
    #[serde(default)]
    license_key: Option<ActivateLicenseKey>,
}

#[derive(serde::Deserialize)]
struct ActivateLicenseKey {
    #[serde(default)]
    benefit_id: Option<String>,
}

/// validate 応答 (200, ValidatedLicenseKey) のうち読むフィールドだけ。
#[derive(serde::Deserialize)]
struct ValidateResponse {
    /// "granted" | "revoked" | "disabled"
    status: String,
    #[serde(default)]
    benefit_id: Option<String>,
}

async fn polar_activate_at(
    base_url: &str,
    organization_id: &str,
    key: &str,
) -> anyhow::Result<PolarActivation> {
    let url = format!("{base_url}/v1/customer-portal/license-keys/activate");
    let body = serde_json::json!({
        "key": key,
        "organization_id": organization_id,
        "label": activation_label(),
    });
    let res = polar_http_client()?
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("ライセンスサーバーに接続できませんでした: {e}"))?;
    match res.status().as_u16() {
        200 => {
            let parsed: ActivateResponse = res.json().await.map_err(|e| {
                anyhow::anyhow!("ライセンスサーバーの応答を解釈できませんでした: {e}")
            })?;
            Ok(PolarActivation {
                activation_id: parsed.id,
                benefit_id: parsed.license_key.and_then(|lk| lk.benefit_id),
            })
        }
        // 403 NotPermitted = アクティベーション上限到達 or 非サポート (公式仕様)
        403 => anyhow::bail!(
            "アクティベーション上限に達しています。設定画面から使っていない端末を解除してください"
        ),
        404 => anyhow::bail!("ライセンスキーが見つかりません。入力内容を確認してください"),
        422 => anyhow::bail!("リクエスト形式が不正です（アプリの不具合の可能性があります）"),
        s => anyhow::bail!("ライセンスサーバーがエラーを返しました (HTTP {s})"),
    }
}

async fn polar_validate_at(
    base_url: &str,
    organization_id: &str,
    key: &str,
    activation_id: &str,
) -> anyhow::Result<PolarValidateOutcome> {
    let url = format!("{base_url}/v1/customer-portal/license-keys/validate");
    let body = serde_json::json!({
        "key": key,
        "organization_id": organization_id,
        "activation_id": activation_id,
    });
    let res = polar_http_client()?
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("ライセンスサーバーに接続できませんでした: {e}"))?;
    match res.status().as_u16() {
        200 => {
            let parsed: ValidateResponse = res.json().await.map_err(|e| {
                anyhow::anyhow!("ライセンスサーバーの応答を解釈できませんでした: {e}")
            })?;
            // キー無効は HTTP エラーではなく status で表現される (公式仕様)。
            // benefit が「存在して不一致」(§4.3: 別メジャーバージョンのキー) も
            // 無効扱い。欠損は照合スキップ (granted を信頼、fail-soft)。
            if parsed.status == "granted" && !benefit_mismatch(parsed.benefit_id.as_deref()) {
                Ok(PolarValidateOutcome::Valid {
                    benefit_id: parsed.benefit_id,
                })
            } else {
                Ok(PolarValidateOutcome::Invalid)
            }
        }
        // キー不存在 = Polar の明示応答 (返金等でキーごと消えたケース)。
        404 => Ok(PolarValidateOutcome::Invalid),
        // 422 はこちらのリクエスト不正 (アプリのバグ)。5xx は Polar 障害。
        // どちらもユーザーのキーを revoked に倒す理由にならない (設計書 §3)。
        s => anyhow::bail!("ライセンスサーバーがエラーを返しました (HTTP {s})"),
    }
}

async fn polar_deactivate_at(
    base_url: &str,
    organization_id: &str,
    key: &str,
    activation_id: &str,
) -> anyhow::Result<()> {
    let url = format!("{base_url}/v1/customer-portal/license-keys/deactivate");
    let body = serde_json::json!({
        "key": key,
        "organization_id": organization_id,
        "activation_id": activation_id,
    });
    let res = polar_http_client()?
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("ライセンスサーバーに接続できませんでした: {e}"))?;
    match res.status().as_u16() {
        204 => Ok(()),
        // サーバー側に既に存在しない activation = 目的は達成済み (冪等)。
        // 返金等でキーごと消えていてもローカル破棄に進めるようにする。
        404 => {
            tracing::warn!("license: deactivate got 404 (already deactivated server-side)");
            Ok(())
        }
        s => anyhow::bail!("ライセンスサーバーがエラーを返しました (HTTP {s})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};
    use grimodex_core::license::{compute_snapshot, ActivatedLicense};

    const NOW: &str = "2026-09-08T12:00:00Z";
    const TODAY: &str = "2026-09-08";

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s)
            .expect("test timestamp must parse")
            .with_timezone(&Utc)
    }

    fn licensed_file() -> LicenseFile {
        LicenseFile {
            license: Some(ActivatedLicense {
                key: "GRIM-XXXX-YYYY-1234".to_string(),
                activation_id: "act-uuid".to_string(),
                benefit_id: Some("benefit-v1".to_string()),
                activated_at: Some("2026-08-01T00:00:00Z".to_string()),
                last_validated_at: Some(NOW.to_string()),
                revoked_at: None,
            }),
            ..LicenseFile::default()
        }
    }

    #[test]
    fn licensed_dto_has_status_and_key_tail() {
        let file = licensed_file();
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        let dto = build_dto(&file, &snap);
        assert_eq!(dto.status, "licensed");
        assert_eq!(dto.key_tail.as_deref(), Some("1234"));
        assert_eq!(dto.activated_at.as_deref(), Some("2026-08-01T00:00:00Z"));
        assert_eq!(dto.last_validated_at.as_deref(), Some(NOW));
        assert!(dto.licensing_enabled);
    }

    #[test]
    fn trial_dto_has_remaining_days_without_key() {
        let file = LicenseFile::default();
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        let dto = build_dto(&file, &snap);
        assert_eq!(dto.status, "trial");
        assert_eq!(dto.trial_days_remaining, Some(30));
        assert_eq!(dto.key_tail, None);
    }

    #[test]
    fn short_key_tail_does_not_panic() {
        let mut file = licensed_file();
        file.license.as_mut().unwrap().key = "abc".to_string();
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        let dto = build_dto(&file, &snap);
        assert_eq!(dto.key_tail.as_deref(), Some("abc"));
    }

    #[test]
    fn dto_serializes_camel_case() {
        // IPC 境界の命名規約 (Tauri 規約 = camelCase) の回帰テスト。
        let file = LicenseFile::default();
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        let value = serde_json::to_value(build_dto(&file, &snap)).expect("serialize");
        let obj = value.as_object().expect("object");
        assert!(obj.contains_key("licensingEnabled"));
        assert!(obj.contains_key("trialDaysRemaining"));
        assert!(obj.contains_key("graceDaysRemaining"));
        assert!(obj.contains_key("keyTail"));
        assert!(!obj.contains_key("licensing_enabled"));
    }

    #[test]
    fn app_identifier_matches_tauri_conf() {
        // MCP が dirs::data_dir()/{APP_IDENTIFIER} で license.json を解決する
        // 前提の保証 (ライセンス認証設計書 §5.1)。identifier を変えたら
        // grimodex_core::license::APP_IDENTIFIER も追従させること。
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json parses");
        assert_eq!(
            conf["identifier"].as_str(),
            Some(grimodex_core::license::APP_IDENTIFIER)
        );
    }

    #[test]
    fn disabled_dto_reports_disabled() {
        let dto = disabled_dto();
        assert!(!dto.licensing_enabled);
        assert_eq!(dto.status, "disabled");
        assert_eq!(dto.trial_days_remaining, None);
        assert_eq!(dto.key_tail, None);
    }
}

#[cfg(test)]
mod polar_tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const KEY: &str = "GRIMO-TEST-KEY-1234";
    const ORG: &str = "11111111-1111-4111-8111-111111111111";
    const ACT: &str = "22222222-2222-4222-8222-222222222222";

    // -- label / benefit 照合 (純粋関数) --------------------------------------

    #[test]
    fn label_is_os_only_without_hostname() {
        // 送信全量は "Grimodex on <OS>" のみ (設計書 §8.1)。
        let label = activation_label();
        assert!(label.starts_with("Grimodex on "));
        assert!(matches!(
            label.as_str(),
            "Grimodex on macOS" | "Grimodex on Windows" | "Grimodex on Linux"
        ));
    }

    #[test]
    fn benefit_check_skipped_when_expected_unset() {
        // Product 作成前 (期待値 = 空) は照合を素通り (設計書 §4.3)。
        assert!(!benefit_mismatch_with("", Some("any-benefit")));
        assert!(!benefit_mismatch_with("", None));
    }

    #[test]
    fn benefit_check_rejects_only_present_mismatch() {
        assert!(!benefit_mismatch_with("ben-v1", Some("ben-v1")));
        assert!(benefit_mismatch_with("ben-v1", Some("ben-v2")));
        // 欠損 (None) は照合スキップ — 曖昧ケースを revoked に倒さない
        // (fail-soft、コミット前レビュー確定指摘)。
        assert!(!benefit_mismatch_with("ben-v1", None));
    }

    // -- activate -------------------------------------------------------------

    #[tokio::test]
    async fn activate_success_returns_activation() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/customer-portal/license-keys/activate"))
            .and(body_partial_json(serde_json::json!({
                "key": KEY,
                "organization_id": ORG,
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "act-123",
                "license_key_id": "lk-1",
                "label": "Grimodex on Linux",
                "meta": {},
                "created_at": "2026-09-01T00:00:00Z",
                "license_key": {
                    "id": "lk-1",
                    "status": "granted",
                    "display_key": "****-1234",
                    "benefit_id": "ben-1",
                    "limit_activations": 5
                }
            })))
            .mount(&server)
            .await;
        let result = polar_activate_at(&server.uri(), ORG, KEY)
            .await
            .expect("activate should succeed");
        assert_eq!(result.activation_id, "act-123");
        assert_eq!(result.benefit_id.as_deref(), Some("ben-1"));
    }

    #[tokio::test]
    async fn activate_sends_label() {
        // label フィールドは必須 (公式仕様)。"Grimodex on <OS>" を送ること。
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/customer-portal/license-keys/activate"))
            .and(body_partial_json(serde_json::json!({
                "label": activation_label(),
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "act-1",
                "license_key": { "id": "lk-1", "status": "granted" }
            })))
            .mount(&server)
            .await;
        polar_activate_at(&server.uri(), ORG, KEY)
            .await
            .expect("label matcher should match");
    }

    #[tokio::test]
    async fn activate_403_means_activation_limit() {
        // 403 NotPermitted = 上限到達 or 非サポート (公式仕様)。
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/customer-portal/license-keys/activate"))
            .respond_with(ResponseTemplate::new(403).set_body_json(
                serde_json::json!({"error": "NotPermitted", "detail": "Activation limit reached"}),
            ))
            .mount(&server)
            .await;
        let err = polar_activate_at(&server.uri(), ORG, KEY)
            .await
            .expect_err("403 should be an error");
        assert!(err.to_string().contains("上限"), "got: {err}");
    }

    #[tokio::test]
    async fn activate_404_means_key_not_found() {
        // 実測ボディ: {"error":"ResourceNotFound","detail":"Not found"}
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/customer-portal/license-keys/activate"))
            .respond_with(ResponseTemplate::new(404).set_body_json(
                serde_json::json!({"error": "ResourceNotFound", "detail": "Not found"}),
            ))
            .mount(&server)
            .await;
        let err = polar_activate_at(&server.uri(), ORG, KEY)
            .await
            .expect_err("404 should be an error");
        assert!(err.to_string().contains("見つかりません"), "got: {err}");
    }

    #[tokio::test]
    async fn activate_500_is_server_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/customer-portal/license-keys/activate"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        assert!(polar_activate_at(&server.uri(), ORG, KEY).await.is_err());
    }

    // -- validate ---------------------------------------------------------------

    async fn mount_validate(server: &MockServer, status: u16, body: serde_json::Value) {
        Mock::given(method("POST"))
            .and(path("/v1/customer-portal/license-keys/validate"))
            .respond_with(ResponseTemplate::new(status).set_body_json(body))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn validate_granted_is_valid_with_benefit() {
        let server = MockServer::start().await;
        mount_validate(
            &server,
            200,
            serde_json::json!({
                "status": "granted",
                "expires_at": null,
                "benefit_id": "ben-2",
                "limit_activations": 5
            }),
        )
        .await;
        match polar_validate_at(&server.uri(), ORG, KEY, ACT).await {
            Ok(PolarValidateOutcome::Valid { benefit_id }) => {
                assert_eq!(benefit_id.as_deref(), Some("ben-2"));
            }
            other => panic!("expected Valid, got {:?}", outcome_kind(&other)),
        }
    }

    #[tokio::test]
    async fn validate_sends_activation_id() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/customer-portal/license-keys/validate"))
            .and(body_partial_json(serde_json::json!({
                "key": KEY,
                "organization_id": ORG,
                "activation_id": ACT,
            })))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"status": "granted", "benefit_id": "b"})),
            )
            .mount(&server)
            .await;
        let outcome = polar_validate_at(&server.uri(), ORG, KEY, ACT).await;
        assert!(matches!(outcome, Ok(PolarValidateOutcome::Valid { .. })));
    }

    #[tokio::test]
    async fn validate_revoked_status_is_invalid() {
        // キー無効は HTTP エラーではなく 200 + status=revoked (公式仕様で確定)。
        let server = MockServer::start().await;
        mount_validate(&server, 200, serde_json::json!({"status": "revoked"})).await;
        let outcome = polar_validate_at(&server.uri(), ORG, KEY, ACT).await;
        assert!(matches!(outcome, Ok(PolarValidateOutcome::Invalid)));
    }

    #[tokio::test]
    async fn validate_disabled_status_is_invalid() {
        let server = MockServer::start().await;
        mount_validate(&server, 200, serde_json::json!({"status": "disabled"})).await;
        let outcome = polar_validate_at(&server.uri(), ORG, KEY, ACT).await;
        assert!(matches!(outcome, Ok(PolarValidateOutcome::Invalid)));
    }

    #[tokio::test]
    async fn validate_404_is_invalid() {
        // キー不存在 = Polar の明示応答 → revoked へ落としてよい (設計書 §3)。
        let server = MockServer::start().await;
        mount_validate(
            &server,
            404,
            serde_json::json!({"error": "ResourceNotFound", "detail": "Not found"}),
        )
        .await;
        let outcome = polar_validate_at(&server.uri(), ORG, KEY, ACT).await;
        assert!(matches!(outcome, Ok(PolarValidateOutcome::Invalid)));
    }

    #[tokio::test]
    async fn validate_500_is_comm_failure_not_invalid() {
        // Polar 障害でユーザーを締め出さない (設計書 §3 の重要な区別)。
        let server = MockServer::start().await;
        mount_validate(
            &server,
            500,
            serde_json::json!({"error": "InternalServerError"}),
        )
        .await;
        assert!(polar_validate_at(&server.uri(), ORG, KEY, ACT)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn validate_422_is_comm_failure_not_invalid() {
        // 422 = こちらのリクエスト不正 (アプリのバグ)。ユーザーのキーを
        // revoked に倒す理由にならない (実測で 422 の存在を確認済み)。
        let server = MockServer::start().await;
        mount_validate(
            &server,
            422,
            serde_json::json!({"error": "RequestValidationError", "detail": []}),
        )
        .await;
        assert!(polar_validate_at(&server.uri(), ORG, KEY, ACT)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn validate_network_unreachable_is_comm_failure() {
        // 接続不能 (ポート閉鎖) → Err。grace 消化継続側に倒れる。
        let outcome = polar_validate_at("http://127.0.0.1:1", ORG, KEY, ACT).await;
        assert!(outcome.is_err());
    }

    fn outcome_kind(o: &anyhow::Result<PolarValidateOutcome>) -> &'static str {
        match o {
            Ok(PolarValidateOutcome::Valid { .. }) => "Valid",
            Ok(PolarValidateOutcome::Invalid) => "Invalid",
            Err(_) => "Err",
        }
    }

    // -- deactivate ---------------------------------------------------------------

    #[tokio::test]
    async fn deactivate_204_is_ok() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/customer-portal/license-keys/deactivate"))
            .and(body_partial_json(serde_json::json!({
                "key": KEY,
                "organization_id": ORG,
                "activation_id": ACT,
            })))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        polar_deactivate_at(&server.uri(), ORG, KEY, ACT)
            .await
            .expect("204 should be ok");
    }

    #[tokio::test]
    async fn deactivate_404_is_idempotent_ok() {
        // 既にサーバー側に存在しない activation の解除 = 目的は達成済み (冪等)。
        // 返金等でキーごと消えていてもローカル破棄に進めるようにする。
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/customer-portal/license-keys/deactivate"))
            .respond_with(ResponseTemplate::new(404).set_body_json(
                serde_json::json!({"error": "ResourceNotFound", "detail": "Not found"}),
            ))
            .mount(&server)
            .await;
        polar_deactivate_at(&server.uri(), ORG, KEY, ACT)
            .await
            .expect("404 should be treated as already-deactivated");
    }

    #[tokio::test]
    async fn deactivate_500_is_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/customer-portal/license-keys/deactivate"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        assert!(polar_deactivate_at(&server.uri(), ORG, KEY, ACT)
            .await
            .is_err());
    }
}
