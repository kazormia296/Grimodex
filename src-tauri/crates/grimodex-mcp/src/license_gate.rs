//! ライセンスゲートのパス解決 (ライセンス認証設計書 §6 / §14)。
//!
//! MCP サーバーは Tauri AppHandle なしで動くため、standalone sidecar では
//! Electron main が `--license-file` で絶対パスを注入する。従来の Tauri
//! `mcp` subcommand は引数を省略でき、その場合は `dirs` クレートで解決する。
//! Tauri v2 の `app_data_dir()` は
//! `dirs::data_dir()/{bundle identifier}` に解決されるので、同じ識別子
//! (`grimodex_core::license::APP_IDENTIFIER`) を使えば Tauri 側が読み書き
//! するのと同一ファイルを指す。識別子と tauri.conf.json の一致は
//! src-tauri 側の unit test が保証する。

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};

/// Tauri 側が読み書きする license.json と同一のパス。
/// データディレクトリが解決できない環境では None (呼び出し側は fail-soft で
/// 許可に倒す)。
fn default_license_file_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| {
        d.join(grimodex_core::license::APP_IDENTIFIER)
            .join("license.json")
    })
}

/// Resolve the license file selected by the trusted process that starts MCP.
///
/// A supplied path must be absolute: accepting a renderer-controlled relative
/// path would make the gate depend on an MCP client's working directory. The
/// file itself may be absent because the established fail-soft policy treats a
/// missing license file as a fresh trial.
pub(crate) fn resolve_license_file_path(
    explicit: Option<PathBuf>,
) -> anyhow::Result<Option<PathBuf>> {
    match explicit {
        Some(path) if !path.is_absolute() => {
            anyhow::bail!("--license-file must be an absolute path")
        }
        Some(path) => Ok(Some(path)),
        None => Ok(default_license_file_path()),
    }
}

/// Evaluate the shared license state for one MCP write call. The caller
/// supplies time so status-boundary tests remain deterministic. `None`, a
/// missing file, or a malformed file preserves the existing fail-soft policy.
pub(crate) fn license_allows_write(
    path: Option<&Path>,
    now: DateTime<Utc>,
    today_local: &str,
) -> bool {
    let Some(path) = path else {
        return true;
    };
    let file = grimodex_core::license::read_license_file(path);
    let snapshot = grimodex_core::license::compute_snapshot(&file, now, today_local);
    !snapshot.status.is_write_restricted()
}

#[cfg(test)]
mod tests {
    use super::*;
    use grimodex_core::license::{ActivatedLicense, LicenseFile};

    fn utc(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .expect("test timestamp must parse")
            .with_timezone(&Utc)
    }

    fn test_license_path(label: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!(
                "grimodex-mcp-license-{label}-{}",
                uuid::Uuid::new_v4()
            ))
            .join("license.json")
    }

    #[test]
    fn path_ends_with_identifier_and_filename() {
        // CI 環境によっては data_dir が無いこともあるため Some の場合のみ検証。
        if let Some(p) = default_license_file_path() {
            let s = p.to_string_lossy();
            assert!(s.contains(grimodex_core::license::APP_IDENTIFIER));
            assert!(s.ends_with("license.json"));
        }
    }

    #[test]
    fn explicit_path_must_be_absolute() {
        let relative = PathBuf::from("relative/license.json");
        let error = resolve_license_file_path(Some(relative))
            .expect_err("relative license path must be rejected");
        assert!(error.to_string().contains("absolute"));

        let absolute = test_license_path("absolute");
        assert_eq!(
            resolve_license_file_path(Some(absolute.clone())).expect("absolute path"),
            Some(absolute)
        );
    }

    #[test]
    fn missing_injected_file_keeps_fail_soft_trial_access() {
        let path = test_license_path("missing");
        assert!(license_allows_write(
            Some(&path),
            utc("2026-07-11T12:00:00Z"),
            "2026-07-11"
        ));
    }

    #[test]
    fn injected_expired_trial_file_denies_writes() {
        let path = test_license_path("expired");
        let file = LicenseFile {
            trial_used_dates: (1..=30).map(|day| format!("2026-05-{day:02}")).collect(),
            ..LicenseFile::default()
        };
        grimodex_core::license::write_license_file(&path, &file).expect("write license fixture");

        assert!(!license_allows_write(
            Some(&path),
            utc("2026-07-11T12:00:00Z"),
            "2026-07-11"
        ));
        let _ = std::fs::remove_dir_all(path.parent().expect("fixture parent"));
    }

    #[test]
    fn injected_revoked_and_stale_files_deny_writes() {
        let path = test_license_path("restricted");
        let mut file = LicenseFile {
            license: Some(ActivatedLicense {
                key: "GRIM-TEST".to_string(),
                activation_id: "activation-test".to_string(),
                benefit_id: None,
                activated_at: Some("2026-01-01T00:00:00Z".to_string()),
                last_validated_at: Some("2026-07-11T12:00:00Z".to_string()),
                revoked_at: Some("2026-07-11T12:00:00Z".to_string()),
            }),
            ..LicenseFile::default()
        };
        grimodex_core::license::write_license_file(&path, &file).expect("write revoked fixture");
        assert!(!license_allows_write(
            Some(&path),
            utc("2026-07-11T12:00:00Z"),
            "2026-07-11"
        ));

        let license = file.license.as_mut().expect("activated fixture");
        license.revoked_at = None;
        license.last_validated_at = Some("2026-05-01T00:00:00Z".to_string());
        grimodex_core::license::write_license_file(&path, &file).expect("write stale fixture");
        assert!(!license_allows_write(
            Some(&path),
            utc("2026-07-11T12:00:00Z"),
            "2026-07-11"
        ));
        let _ = std::fs::remove_dir_all(path.parent().expect("fixture parent"));
    }
}
