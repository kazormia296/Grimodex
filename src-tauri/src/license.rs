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
/// TODO(発売前): Polar で Grimodex Organization を作成したら実 ID に差し替える。
/// licensing feature が無効な間 (ベータ) は到達しないコード。
pub(crate) const POLAR_ORGANIZATION_ID: &str = "00000000-0000-4000-8000-000000000000";

/// メジャーバージョン期待 benefit_id (§4.3)。空文字の間は照合をスキップする。
/// TODO(発売前): Polar の v1 Product / Benefit 作成後に埋める。
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

/// §4.3 benefit_id 照合。期待値が未設定 (ベータ〜Product 作成前) は素通り。
pub(crate) fn benefit_matches(benefit_id: Option<&str>) -> bool {
    benefit_matches_with(POLAR_EXPECTED_BENEFIT_ID, benefit_id)
}

fn benefit_matches_with(expected: &str, benefit_id: Option<&str>) -> bool {
    let _ = (expected, benefit_id);
    todo!("Phase 3: benefit 照合の実装")
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

async fn polar_activate_at(
    base_url: &str,
    organization_id: &str,
    key: &str,
) -> anyhow::Result<PolarActivation> {
    let _ = (base_url, organization_id, key);
    anyhow::bail!("Phase 3: activate の実装")
}

async fn polar_validate_at(
    base_url: &str,
    organization_id: &str,
    key: &str,
    activation_id: &str,
) -> anyhow::Result<PolarValidateOutcome> {
    let _ = (base_url, organization_id, key, activation_id);
    anyhow::bail!("Phase 3: validate の実装")
}

async fn polar_deactivate_at(
    base_url: &str,
    organization_id: &str,
    key: &str,
    activation_id: &str,
) -> anyhow::Result<()> {
    let _ = (base_url, organization_id, key, activation_id);
    anyhow::bail!("Phase 3: deactivate の実装")
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
        assert!(benefit_matches_with("", Some("any-benefit")));
        assert!(benefit_matches_with("", None));
    }

    #[test]
    fn benefit_check_enforced_when_expected_set() {
        assert!(benefit_matches_with("ben-v1", Some("ben-v1")));
        assert!(!benefit_matches_with("ben-v1", Some("ben-v2")));
        assert!(!benefit_matches_with("ben-v1", None));
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
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"status": "granted", "benefit_id": "b"}),
            ))
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
        mount_validate(&server, 500, serde_json::json!({"error": "InternalServerError"})).await;
        assert!(polar_validate_at(&server.uri(), ORG, KEY, ACT).await.is_err());
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
        assert!(polar_validate_at(&server.uri(), ORG, KEY, ACT).await.is_err());
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
        assert!(polar_deactivate_at(&server.uri(), ORG, KEY, ACT).await.is_err());
    }
}
