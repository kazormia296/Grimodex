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
// Polar クライアント (Phase 3 で reqwest 実装に置換するスタブ)
//
// 契約 (設計書 §3/§4.2):
// - Err = 通信失敗 (ネットワーク不達・Polar 障害・5xx・タイムアウト)。
//   呼び出し側は状態を変えない (fail-soft)。revoked に倒してはならない。
// - validate の「キー無効」は Ok(PolarValidateOutcome::Invalid) で表現する。
//   Polar が HTTP レベルで明示応答した場合のみここに入る。
// - Phase 3 実装時の注意: reqwest は connect 5s / total 15s を明示設定
//   (既存 ai.rs の Client::new() は timeout 無設定なので写経しない)。
//   base URL はテスト差し替え可能にする (wiremock 前提、ai.rs の轍を踏まない)。
// ---------------------------------------------------------------------------

/// Polar activate 応答のうちアプリが保存するフィールド。
pub(crate) struct PolarActivation {
    pub(crate) activation_id: String,
    pub(crate) benefit_id: Option<String>,
}

/// validate の明示応答。Err (通信失敗) とは厳密に区別する。
// Phase 1 ではスタブが Err しか返さず variant が未構築のため allow。
// Phase 3 の Polar 実装で構築されるようになったら外すこと。
#[allow(dead_code)]
pub(crate) enum PolarValidateOutcome {
    /// Polar が有効と明示。
    Valid { benefit_id: Option<String> },
    /// Polar が「キー無効」を明示 (返金・失効・上限超過) → revoked へ。
    Invalid,
}

pub(crate) async fn polar_activate(key: &str) -> anyhow::Result<PolarActivation> {
    let _ = key;
    anyhow::bail!("ライセンス認証サーバーとの連携は未実装です（Phase 3 で実装予定）")
}

pub(crate) async fn polar_validate(
    key: &str,
    activation_id: &str,
) -> anyhow::Result<PolarValidateOutcome> {
    let _ = (key, activation_id);
    anyhow::bail!("ライセンス認証サーバーとの連携は未実装です（Phase 3 で実装予定）")
}

pub(crate) async fn polar_deactivate(key: &str, activation_id: &str) -> anyhow::Result<()> {
    let _ = (key, activation_id);
    anyhow::bail!("ライセンス認証サーバーとの連携は未実装です（Phase 3 で実装予定）")
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
    fn disabled_dto_reports_disabled() {
        let dto = disabled_dto();
        assert!(!dto.licensing_enabled);
        assert_eq!(dto.status, "disabled");
        assert_eq!(dto.trial_days_remaining, None);
        assert_eq!(dto.key_tail, None);
    }
}
