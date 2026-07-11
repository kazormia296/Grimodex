//! Regression coverage migrated verbatim from the Tauri glue module.

use grimodex_core::license::LicenseFile;
use grimodex_license::{
    activation_label, benefit_mismatch_with, build_dto, disabled_dto, polar_activate_at,
    polar_deactivate_at, polar_validate_at, PolarValidateOutcome,
};

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
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../../tauri.conf.json"))
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
        match polar_validate_at(&server.uri(), ORG, "", KEY, ACT).await {
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
        let outcome = polar_validate_at(&server.uri(), ORG, "", KEY, ACT).await;
        assert!(matches!(outcome, Ok(PolarValidateOutcome::Valid { .. })));
    }

    #[tokio::test]
    async fn validate_revoked_status_is_invalid() {
        // キー無効は HTTP エラーではなく 200 + status=revoked (公式仕様で確定)。
        let server = MockServer::start().await;
        mount_validate(&server, 200, serde_json::json!({"status": "revoked"})).await;
        let outcome = polar_validate_at(&server.uri(), ORG, "", KEY, ACT).await;
        assert!(matches!(outcome, Ok(PolarValidateOutcome::Invalid)));
    }

    #[tokio::test]
    async fn validate_disabled_status_is_invalid() {
        let server = MockServer::start().await;
        mount_validate(&server, 200, serde_json::json!({"status": "disabled"})).await;
        let outcome = polar_validate_at(&server.uri(), ORG, "", KEY, ACT).await;
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
        let outcome = polar_validate_at(&server.uri(), ORG, "", KEY, ACT).await;
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
        assert!(polar_validate_at(&server.uri(), ORG, "", KEY, ACT)
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
        assert!(polar_validate_at(&server.uri(), ORG, "", KEY, ACT)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn validate_network_unreachable_is_comm_failure() {
        // 接続不能 (ポート閉鎖) → Err。grace 消化継続側に倒れる。
        let outcome = polar_validate_at("http://127.0.0.1:1", ORG, "", KEY, ACT).await;
        assert!(outcome.is_err());
    }

    #[tokio::test]
    async fn validate_granted_matching_benefit_is_valid() {
        // 期待 benefit と一致すれば Valid (§4.3 の正常系)。
        let server = MockServer::start().await;
        mount_validate(
            &server,
            200,
            serde_json::json!({"status": "granted", "benefit_id": "expected-benefit"}),
        )
        .await;
        let outcome = polar_validate_at(&server.uri(), ORG, "expected-benefit", KEY, ACT).await;
        assert!(matches!(outcome, Ok(PolarValidateOutcome::Valid { .. })));
    }

    #[tokio::test]
    async fn validate_granted_but_benefit_mismatch_is_invalid() {
        // §4.3: granted でも benefit_id が期待値と不一致 = 別メジャーバージョンのキー扱いで無効。
        let server = MockServer::start().await;
        mount_validate(
            &server,
            200,
            serde_json::json!({"status": "granted", "benefit_id": "other-major-version"}),
        )
        .await;
        let outcome = polar_validate_at(&server.uri(), ORG, "expected-benefit", KEY, ACT).await;
        assert!(matches!(outcome, Ok(PolarValidateOutcome::Invalid)));
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
