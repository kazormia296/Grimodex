//! ライセンス状態機械と license.json のスキーマ / IO。
//!
//! Tauri アプリ (src-tauri/src/license.rs + commands/license.rs) と MCP サーバー
//! (grimodex-mcp、Phase 2 で write ツールをゲート) の双方からリンクされるため
//! grimodex-core に置く。grimodex-mcp は src-tauri 本体をリンクできない。
//!
//! 規約: 時刻は全て引数で注入する。このモジュール内で `Utc::now()` /
//! `Local::now()` を呼ばないこと (workspace.rs の時刻注入パターンに従う)。
//! `today_local` はローカルタイムゾーンの暦日 `"YYYY-MM-DD"` — 試用カウントは
//! 「起動した日」だけを消費する使用日ベース (ライセンス認証設計書 §3)。
//!
//! fail-soft 原則: ファイル欠損・破損・タイムスタンプ不正をユーザーの締め出しに
//! 倒さない。license.json は平文・改竄対策なし (設計書 原則 4)。

use std::path::Path;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// 試用期間 (使用日ベース)。
pub const TRIAL_DAYS: usize = 30;
/// この日数以上 validate していなければバックグラウンド再検証を行う。
pub const VALIDATE_INTERVAL_DAYS: i64 = 7;
/// 最終検証成功からのオフライン猶予。超過で `LicenseStale`。
pub const GRACE_DAYS: i64 = 30;

/// Tauri の bundle identifier (tauri.conf.json の `identifier`)。
/// MCP サーバーが Tauri AppHandle なしで license.json のパスを解決するための
/// 正本 — `dirs::data_dir()/{APP_IDENTIFIER}/license.json` が Tauri の
/// `app_data_dir()` と同一パスになる。tauri.conf.json との一致は
/// src-tauri/src/license.rs の unit test が保証する。
pub const APP_IDENTIFIER: &str = "com.miyakey.grimodex";

/// `{app_data_dir}/license.json` のディスク上スキーマ。キーは snake_case
/// (Polar API のペイロード命名と揃える)。フロントへ返す DTO は別構造体で
/// camelCase (src-tauri 側) — ディスクと IPC の命名を混ぜない。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LicenseFile {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    /// 初回起動時刻 (RFC3339)。
    #[serde(default)]
    pub first_run_at: Option<String>,
    /// 最後に起動を観測した時刻 (RFC3339)。時計巻き戻し検出用に単調更新。
    #[serde(default)]
    pub last_seen_at: Option<String>,
    /// 試用で消費した使用日 (`"YYYY-MM-DD"`、ローカル暦日)。最大 30 要素。
    #[serde(default)]
    pub trial_used_dates: Vec<String>,
    /// アクティベーション情報。未アクティベート時は None。
    #[serde(default)]
    pub license: Option<ActivatedLicense>,
}

impl Default for LicenseFile {
    fn default() -> Self {
        Self {
            schema_version: default_schema_version(),
            first_run_at: None,
            last_seen_at: None,
            trial_used_dates: Vec::new(),
            license: None,
        }
    }
}

fn default_schema_version() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActivatedLicense {
    pub key: String,
    /// Polar が activate 時に発行する端末ごとの識別子。端末識別はこれのみ
    /// (ハードウェアフィンガープリント・自前生成 ID は使わない)。
    pub activation_id: String,
    /// validate 応答から保存。メジャーバージョン期待値の照合に使用 (§4.3)。
    #[serde(default)]
    pub benefit_id: Option<String>,
    #[serde(default)]
    pub activated_at: Option<String>,
    /// 最後に validate が成功した時刻 (RFC3339)。
    #[serde(default)]
    pub last_validated_at: Option<String>,
    /// Polar が明示的に「キー無効」を応答した時刻。Some なら `Revoked`。
    /// 通信失敗では絶対にセットしない (fail-soft、設計書 §3)。
    #[serde(default)]
    pub revoked_at: Option<String>,
}

/// 設計書 §3 の状態機械。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LicenseStatus {
    Trial,
    TrialExpired,
    Licensed,
    Grace,
    LicenseStale,
    Revoked,
}

impl LicenseStatus {
    /// IPC / UI 向けの安定識別子 (設計書 §3 の状態名)。
    pub fn as_str(&self) -> &'static str {
        match self {
            LicenseStatus::Trial => "trial",
            LicenseStatus::TrialExpired => "trial_expired",
            LicenseStatus::Licensed => "licensed",
            LicenseStatus::Grace => "grace",
            LicenseStatus::LicenseStale => "license_stale",
            LicenseStatus::Revoked => "revoked",
        }
    }

    /// 閲覧・エクスポート専用モードか (設計書 §6 のゲート対象状態)。
    /// フロントの gate.ts / MCP の write ツールゲートと同じ判定表。
    pub fn is_write_restricted(&self) -> bool {
        matches!(
            self,
            LicenseStatus::TrialExpired | LicenseStatus::LicenseStale | LicenseStatus::Revoked
        )
    }
}

/// `compute_snapshot` の出力。状態 + UI 表示用の残日数 + 再検証要否。
#[derive(Debug, Clone, PartialEq)]
pub struct LicenseSnapshot {
    pub status: LicenseStatus,
    /// 未アクティベート時のみ Some。30 − 使用日数 (最終日は 0)。
    pub trial_days_remaining: Option<u32>,
    /// `Grace` のみ Some。猶予期限までの残日数 (床値、最終日は 0)。
    pub grace_days_remaining: Option<u32>,
    /// バックグラウンド validate を投げるべきか (最終検証から 7 日以上経過、
    /// または検証時刻が読めない)。`Revoked` / 未アクティベートでは false。
    pub needs_validation: bool,
}

/// `update_last_seen` の結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LastSeenUpdate {
    pub changed: bool,
    /// 現在時刻が記録済み `last_seen_at` より過去 = 時計巻き戻しを観測。
    /// 呼び出し側はログに残すのみで機能は止めない (fail-soft)。
    pub rollback_detected: bool,
}

/// activate 成功時に Polar 応答から組み立てる入力。
#[derive(Debug, Clone, PartialEq)]
pub struct NewActivation {
    pub key: String,
    pub activation_id: String,
    pub benefit_id: Option<String>,
}

// ---------------------------------------------------------------------------
// 状態機械 (純粋関数)
// ---------------------------------------------------------------------------

/// license.json と現在時刻から状態を導出する。設計書 §3 の遷移表が正本。
///
/// - `licensed`: 最終検証成功から 7 日以内 (7 日ちょうどを含む)
/// - `grace`: 7 日超〜30 日以内 (30 日ちょうどを含む)
/// - `license_stale`: 30 日超
/// - 検証時刻が欠損・不正・未来 (時計巻き戻し) でも締め出さない (fail-soft)
/// - 試用: 使用日数 30 以下なら `trial` (30 日目はその日の終わりまで)、
///   配列満杯かつ当日未登録で `trial_expired`
pub fn compute_snapshot(
    file: &LicenseFile,
    now_utc: DateTime<Utc>,
    today_local: &str,
) -> LicenseSnapshot {
    if let Some(lic) = &file.license {
        if lic.revoked_at.is_some() {
            return LicenseSnapshot {
                status: LicenseStatus::Revoked,
                trial_days_remaining: None,
                grace_days_remaining: None,
                needs_validation: false,
            };
        }
        let validated = lic
            .last_validated_at
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.with_timezone(&Utc));
        let Some(validated) = validated else {
            // 検証時刻が欠損・不正でも締め出さない: grace 扱いで全機能を維持し、
            // 次の validate 成功で正常へ戻す。
            return LicenseSnapshot {
                status: LicenseStatus::Grace,
                trial_days_remaining: None,
                grace_days_remaining: None,
                needs_validation: true,
            };
        };
        // 時計巻き戻しによるオフライン無期限延命を防ぐ: 単調更新される
        // last_seen_at を下限に取り、有効「現在時刻」を max(now_utc, last_seen_at)
        // とする。前方ジャンプは now_utc のまま (fail-soft を維持) で、過去への
        // 巻き戻しだけが grace/stale 遷移を先送りできなくなる。
        let effective_now = file
            .last_seen_at
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.with_timezone(&Utc))
            .map_or(now_utc, |seen| now_utc.max(seen));
        // 負の経過 (検証後に時計が巻き戻った) は licensed 扱い。
        let elapsed = effective_now - validated;
        if elapsed <= Duration::days(VALIDATE_INTERVAL_DAYS) {
            return LicenseSnapshot {
                status: LicenseStatus::Licensed,
                trial_days_remaining: None,
                grace_days_remaining: None,
                needs_validation: elapsed >= Duration::days(VALIDATE_INTERVAL_DAYS),
            };
        }
        if elapsed <= Duration::days(GRACE_DAYS) {
            let remaining = (validated + Duration::days(GRACE_DAYS) - effective_now).num_days();
            return LicenseSnapshot {
                status: LicenseStatus::Grace,
                trial_days_remaining: None,
                grace_days_remaining: Some(remaining.max(0) as u32),
                needs_validation: true,
            };
        }
        return LicenseSnapshot {
            status: LicenseStatus::LicenseStale,
            trial_days_remaining: None,
            grace_days_remaining: None,
            needs_validation: true,
        };
    }

    let used = file.trial_used_dates.len();
    let used_today = file.trial_used_dates.iter().any(|d| d == today_local);
    if used < TRIAL_DAYS || used_today {
        LicenseSnapshot {
            status: LicenseStatus::Trial,
            trial_days_remaining: Some(TRIAL_DAYS.saturating_sub(used) as u32),
            grace_days_remaining: None,
            needs_validation: false,
        }
    } else {
        LicenseSnapshot {
            status: LicenseStatus::TrialExpired,
            trial_days_remaining: Some(0),
            grace_days_remaining: None,
            needs_validation: false,
        }
    }
}

/// RFC3339 (秒精度、Z 表記) で統一的に文字列化する。
fn to_rfc3339(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 初回起動の初期化 (`first_run_at` の設定)。変更があれば true。
pub fn ensure_initialized(file: &mut LicenseFile, now_utc: DateTime<Utc>) -> bool {
    if file.first_run_at.is_some() {
        return false;
    }
    file.first_run_at = Some(to_rfc3339(now_utc));
    true
}

/// 試用の使用日登録。アクティベート済み・登録済み・配列満杯 (= 試用切れ後)
/// では何もしない。変更があれば true (書き戻しが必要)。
pub fn register_usage_day(file: &mut LicenseFile, today_local: &str) -> bool {
    if file.license.is_some() {
        return false;
    }
    if file.trial_used_dates.iter().any(|d| d == today_local) {
        return false;
    }
    if file.trial_used_dates.len() >= TRIAL_DAYS {
        return false;
    }
    file.trial_used_dates.push(today_local.to_string());
    true
}

/// `last_seen_at` の単調更新。過去方向には動かさず、巻き戻し観測を報告する。
pub fn update_last_seen(file: &mut LicenseFile, now_utc: DateTime<Utc>) -> LastSeenUpdate {
    let prev = file
        .last_seen_at
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Utc));
    match prev {
        Some(prev) if now_utc < prev => LastSeenUpdate {
            changed: false,
            rollback_detected: true,
        },
        Some(prev) if now_utc == prev => LastSeenUpdate {
            changed: false,
            rollback_detected: false,
        },
        _ => {
            file.last_seen_at = Some(to_rfc3339(now_utc));
            LastSeenUpdate {
                changed: true,
                rollback_detected: false,
            }
        }
    }
}

/// activate 成功 → `licensed`。既存の revoked 状態は新しい有効キーで上書き
/// される (設計書 §3: revoked ─ 別の有効キーで activate ─▶ licensed)。
pub fn apply_activation(file: &mut LicenseFile, activation: NewActivation, now_utc: DateTime<Utc>) {
    let now = to_rfc3339(now_utc);
    file.license = Some(ActivatedLicense {
        key: activation.key,
        activation_id: activation.activation_id,
        benefit_id: activation.benefit_id,
        activated_at: Some(now.clone()),
        last_validated_at: Some(now),
        revoked_at: None,
    });
}

/// validate 成功 → `licensed`。`last_validated_at` / `benefit_id` を更新し、
/// revoked 痕跡もクリアする (Polar が有効と明示した = 最新の正)。
/// 未アクティベートなら何もしない。変更があれば true。
pub fn apply_validate_success(
    file: &mut LicenseFile,
    benefit_id: Option<&str>,
    now_utc: DateTime<Utc>,
) -> bool {
    let Some(lic) = file.license.as_mut() else {
        return false;
    };
    lic.last_validated_at = Some(to_rfc3339(now_utc));
    if let Some(benefit_id) = benefit_id {
        lic.benefit_id = Some(benefit_id.to_string());
    }
    lic.revoked_at = None;
    true
}

/// validate が明示的に「キー無効」を応答 → `revoked`。
/// 通信失敗でこれを呼んではならない (呼び出し側の責務、設計書 §3)。
pub fn apply_revoked(file: &mut LicenseFile, now_utc: DateTime<Utc>) -> bool {
    let Some(lic) = file.license.as_mut() else {
        return false;
    };
    lic.revoked_at = Some(to_rfc3339(now_utc));
    true
}

/// deactivate 成功 → ローカルのアクティベーション情報を破棄。
/// `trial_used_dates` は保持する (試用日数が残っていれば trial に戻る、§4.2)。
pub fn apply_deactivation(file: &mut LicenseFile) -> bool {
    if file.license.is_none() {
        return false;
    }
    file.license = None;
    true
}

// ---------------------------------------------------------------------------
// license.json IO (workspace.rs の global-settings パターンを踏襲)
// ---------------------------------------------------------------------------

/// 欠損・破損は default (= 試用初期状態) に倒す。Err は返さない (fail-soft)。
pub fn read_license_file(path: &Path) -> LicenseFile {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => LicenseFile::default(),
    }
}

/// 平文 pretty JSON で書き込む (設計書 §5.2、改竄対策なし)。
pub fn write_license_file(path: &Path, file: &LicenseFile) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(file)?;
    std::fs::write(path, json)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// テスト (設計書 §10: 全遷移 + 境界 + 時計異常)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s)
            .expect("test timestamp must parse")
            .with_timezone(&Utc)
    }

    fn trial_file(dates: &[&str]) -> LicenseFile {
        LicenseFile {
            trial_used_dates: dates.iter().map(|s| s.to_string()).collect(),
            ..LicenseFile::default()
        }
    }

    /// n 日分の使用日を 2026-08-01 から連番で埋める。
    fn trial_file_with_n_days(n: usize) -> LicenseFile {
        let dates: Vec<String> = (0..n).map(|i| format!("2026-08-{:02}", i + 1)).collect();
        LicenseFile {
            trial_used_dates: dates,
            ..LicenseFile::default()
        }
    }

    fn licensed_file(last_validated_at: &str) -> LicenseFile {
        LicenseFile {
            license: Some(ActivatedLicense {
                key: "GRIM-XXXX-YYYY-1234".to_string(),
                activation_id: "act-uuid".to_string(),
                benefit_id: Some("benefit-v1".to_string()),
                activated_at: Some("2026-08-01T00:00:00Z".to_string()),
                last_validated_at: Some(last_validated_at.to_string()),
                revoked_at: None,
            }),
            ..LicenseFile::default()
        }
    }

    const TODAY: &str = "2026-09-08";
    const NOW: &str = "2026-09-08T12:00:00Z";

    // -- 試用状態 ----------------------------------------------------------

    #[test]
    fn fresh_file_is_trial_with_30_days() {
        let snap = compute_snapshot(&LicenseFile::default(), utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Trial);
        assert_eq!(snap.trial_days_remaining, Some(30));
        assert!(!snap.needs_validation);
    }

    #[test]
    fn mid_trial_counts_remaining_days() {
        let file = trial_file_with_n_days(15);
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Trial);
        assert_eq!(snap.trial_days_remaining, Some(15));
    }

    #[test]
    fn day_30_registered_today_is_still_trial_last_day() {
        // 境界 (設計書 §3): 30 日目はその日の終わりまでフル機能。
        let mut file = trial_file_with_n_days(29);
        file.trial_used_dates.push(TODAY.to_string()); // 30 個目 = 今日
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Trial);
        assert_eq!(snap.trial_days_remaining, Some(0));
    }

    #[test]
    fn day_31_new_day_with_full_array_is_expired() {
        // 境界 (設計書 §3): 配列満杯 + 当日未登録 = 31 日目で expired。
        let file = trial_file_with_n_days(30);
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::TrialExpired);
        assert_eq!(snap.trial_days_remaining, Some(0));
    }

    #[test]
    fn day_29_to_30_boundary_still_trial_before_registration() {
        let file = trial_file_with_n_days(29);
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Trial);
        assert_eq!(snap.trial_days_remaining, Some(1));
    }

    #[test]
    fn hand_edited_overlong_dates_do_not_panic() {
        // 手編集で 31 要素になっていても panic せず expired 扱い (fail-soft)。
        let file = trial_file_with_n_days(31);
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::TrialExpired);
        assert_eq!(snap.trial_days_remaining, Some(0));
    }

    // -- 使用日登録 --------------------------------------------------------

    #[test]
    fn register_appends_new_day() {
        let mut file = trial_file(&["2026-09-01"]);
        assert!(register_usage_day(&mut file, TODAY));
        assert_eq!(file.trial_used_dates.len(), 2);
        assert!(file.trial_used_dates.iter().any(|d| d == TODAY));
    }

    #[test]
    fn register_same_day_twice_is_noop() {
        // 同日複数起動の非重複カウント (設計書 §10)。
        let mut file = trial_file(&[TODAY]);
        assert!(!register_usage_day(&mut file, TODAY));
        assert_eq!(file.trial_used_dates.len(), 1);
    }

    #[test]
    fn register_on_full_array_is_noop() {
        // 31 日目: 配列には追記しない (設計書 §3)。
        let mut file = trial_file_with_n_days(30);
        assert!(!register_usage_day(&mut file, TODAY));
        assert_eq!(file.trial_used_dates.len(), 30);
    }

    #[test]
    fn register_while_licensed_is_noop() {
        // アクティベート済みは試用日を消費しない (deactivate で復帰する資産)。
        let mut file = licensed_file(NOW);
        assert!(!register_usage_day(&mut file, TODAY));
        assert!(file.trial_used_dates.is_empty());
    }

    #[test]
    fn register_29th_to_30th_day_appends() {
        let mut file = trial_file_with_n_days(29);
        assert!(register_usage_day(&mut file, TODAY));
        assert_eq!(file.trial_used_dates.len(), 30);
        // 登録後は 30 日目 = 最終日として trial 維持。
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Trial);
        assert_eq!(snap.trial_days_remaining, Some(0));
    }

    // -- licensed / grace / stale 境界 --------------------------------------

    #[test]
    fn validated_just_now_is_licensed() {
        let file = licensed_file(NOW);
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Licensed);
        assert_eq!(snap.trial_days_remaining, None);
        assert_eq!(snap.grace_days_remaining, None);
        assert!(!snap.needs_validation);
    }

    #[test]
    fn exactly_7_days_is_licensed_but_needs_validation() {
        // 境界: 7 日ちょうどは「7 日以内」= licensed、かつ「7 日以上経過」= 要再検証。
        let file = licensed_file("2026-09-01T12:00:00Z");
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Licensed);
        assert!(snap.needs_validation);
    }

    #[test]
    fn just_over_7_days_is_grace() {
        let file = licensed_file("2026-09-01T11:59:59Z");
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Grace);
        assert!(snap.needs_validation);
    }

    #[test]
    fn grace_remaining_days_is_floor_of_deadline() {
        // 検証 2026-09-01T00:00、now 09-09T12:00 (経過 8.5 日)。
        // 期限 10-01T00:00 まで 21 日 12 時間 → 床値 21。
        let file = licensed_file("2026-09-01T00:00:00Z");
        let snap = compute_snapshot(&file, utc("2026-09-09T12:00:00Z"), "2026-09-09");
        assert_eq!(snap.status, LicenseStatus::Grace);
        assert_eq!(snap.grace_days_remaining, Some(21));
    }

    #[test]
    fn exactly_30_days_is_grace_last_day() {
        let file = licensed_file("2026-08-09T12:00:00Z");
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Grace);
        assert_eq!(snap.grace_days_remaining, Some(0));
    }

    #[test]
    fn just_over_30_days_is_stale() {
        let file = licensed_file("2026-08-09T11:59:59Z");
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::LicenseStale);
        assert_eq!(snap.grace_days_remaining, None);
        assert!(snap.needs_validation);
    }

    // -- 時計異常 (設計書 §3) ------------------------------------------------

    #[test]
    fn future_validated_at_stays_licensed() {
        // 検証後に時計が巻き戻った (経過が負) → licensed 維持 (fail-soft)。
        let file = licensed_file("2026-09-20T00:00:00Z");
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Licensed);
    }

    #[test]
    fn clock_rollback_cannot_extend_window_via_last_seen() {
        // 検証から 45 日が実時間で経過 (last_seen_at が単調記録) した後、
        // 攻撃者が時計を検証直後 (経過 1 分) まで巻き戻しても、effective_now が
        // last_seen_at で下限化され grace(>30日) → stale に正しく遷移する。
        let mut file = licensed_file("2026-08-01T00:00:00Z");
        file.last_seen_at = Some("2026-09-15T00:00:00Z".to_string()); // 実時間の高水位 (45日後)
        let snap = compute_snapshot(&file, utc("2026-08-01T00:01:00Z"), "2026-08-01");
        assert_eq!(snap.status, LicenseStatus::LicenseStale);
        assert!(snap.needs_validation);
    }

    #[test]
    fn last_seen_in_past_does_not_change_legit_licensed() {
        // last_seen_at が now 以下なら clamp は no-op: 通常運用 (実時間進行) に影響なし。
        let mut file = licensed_file(NOW);
        file.last_seen_at = Some("2026-09-08T11:00:00Z".to_string()); // now の 1 時間前
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Licensed);
        assert!(!snap.needs_validation);
    }

    #[test]
    fn forward_jump_keeps_failsoft_for_negative_elapsed() {
        // last_seen_at があっても、検証時刻が未来 (巻き戻し検証) なら licensed 維持。
        // effective_now=max(now,last_seen) でも validated 超なら elapsed<=0 で licensed。
        let mut file = licensed_file("2026-09-20T00:00:00Z");
        file.last_seen_at = Some("2026-09-08T00:00:00Z".to_string());
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Licensed);
    }

    #[test]
    fn unparsable_validated_at_falls_to_grace() {
        // タイムスタンプ破損で締め出さない: grace + 要再検証。
        let mut file = licensed_file(NOW);
        file.license.as_mut().unwrap().last_validated_at = Some("not-a-date".to_string());
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Grace);
        assert!(snap.needs_validation);
    }

    #[test]
    fn missing_validated_at_falls_to_grace() {
        let mut file = licensed_file(NOW);
        file.license.as_mut().unwrap().last_validated_at = None;
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Grace);
        assert!(snap.needs_validation);
    }

    // -- revoked -------------------------------------------------------------

    #[test]
    fn revoked_at_wins_over_fresh_validation() {
        let mut file = licensed_file(NOW);
        file.license.as_mut().unwrap().revoked_at = Some(NOW.to_string());
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Revoked);
        assert!(!snap.needs_validation);
    }

    #[test]
    fn apply_revoked_transitions_licensed_to_revoked() {
        let mut file = licensed_file(NOW);
        assert!(apply_revoked(&mut file, utc(NOW)));
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Revoked);
    }

    #[test]
    fn apply_revoked_without_license_is_noop() {
        let mut file = LicenseFile::default();
        assert!(!apply_revoked(&mut file, utc(NOW)));
        assert_eq!(file, LicenseFile::default());
    }

    // -- activate ------------------------------------------------------------

    fn activation() -> NewActivation {
        NewActivation {
            key: "GRIM-AAAA-BBBB-5678".to_string(),
            activation_id: "act-2".to_string(),
            benefit_id: Some("benefit-v1".to_string()),
        }
    }

    #[test]
    fn activation_from_trial_becomes_licensed() {
        let mut file = trial_file_with_n_days(10);
        apply_activation(&mut file, activation(), utc(NOW));
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Licensed);
        let lic = file.license.as_ref().unwrap();
        assert_eq!(lic.key, "GRIM-AAAA-BBBB-5678");
        assert_eq!(lic.activation_id, "act-2");
        assert_eq!(lic.benefit_id.as_deref(), Some("benefit-v1"));
        assert_eq!(lic.activated_at.as_deref(), Some(NOW));
        assert_eq!(lic.last_validated_at.as_deref(), Some(NOW));
        assert_eq!(lic.revoked_at, None);
        // 試用日は保持される (deactivate で戻ってくる資産)。
        assert_eq!(file.trial_used_dates.len(), 10);
    }

    #[test]
    fn activation_from_trial_expired_becomes_licensed() {
        let mut file = trial_file_with_n_days(30);
        apply_activation(&mut file, activation(), utc(NOW));
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Licensed);
    }

    #[test]
    fn activation_with_new_key_recovers_from_revoked() {
        // 設計書 §3: revoked ─ 別の有効キーで activate ─▶ licensed。
        let mut file = licensed_file("2026-09-01T00:00:00Z");
        apply_revoked(&mut file, utc(NOW));
        apply_activation(&mut file, activation(), utc(NOW));
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Licensed);
        assert_eq!(file.license.as_ref().unwrap().revoked_at, None);
    }

    // -- validate 成功 --------------------------------------------------------

    #[test]
    fn validate_success_recovers_grace_to_licensed() {
        let mut file = licensed_file("2026-08-25T00:00:00Z"); // grace 圏内
        assert!(apply_validate_success(
            &mut file,
            Some("benefit-v1"),
            utc(NOW)
        ));
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Licensed);
        assert_eq!(
            file.license.as_ref().unwrap().last_validated_at.as_deref(),
            Some(NOW)
        );
    }

    #[test]
    fn validate_success_recovers_stale_to_licensed() {
        let mut file = licensed_file("2026-07-01T00:00:00Z"); // 30 日超 = stale
        assert!(apply_validate_success(&mut file, None, utc(NOW)));
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Licensed);
    }

    #[test]
    fn validate_success_updates_benefit_id() {
        let mut file = licensed_file(NOW);
        assert!(apply_validate_success(
            &mut file,
            Some("benefit-v2"),
            utc(NOW)
        ));
        assert_eq!(
            file.license.as_ref().unwrap().benefit_id.as_deref(),
            Some("benefit-v2")
        );
    }

    #[test]
    fn validate_success_clears_revoked_trace() {
        // Polar が「有効」と明示した最新応答を正とする。
        let mut file = licensed_file(NOW);
        apply_revoked(&mut file, utc(NOW));
        assert!(apply_validate_success(&mut file, None, utc(NOW)));
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Licensed);
    }

    #[test]
    fn validate_success_without_license_is_noop() {
        let mut file = LicenseFile::default();
        assert!(!apply_validate_success(&mut file, None, utc(NOW)));
        assert_eq!(file, LicenseFile::default());
    }

    // -- deactivate ------------------------------------------------------------

    #[test]
    fn deactivation_with_trial_days_left_returns_to_trial() {
        // 設計書 §4.2: 試用日数が残っていれば trial へ (日数は消えない)。
        let mut file = licensed_file(NOW);
        file.trial_used_dates = (0..10).map(|i| format!("2026-08-{:02}", i + 1)).collect();
        assert!(apply_deactivation(&mut file));
        assert_eq!(file.license, None);
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::Trial);
        assert_eq!(snap.trial_days_remaining, Some(20));
    }

    #[test]
    fn deactivation_with_trial_used_up_is_expired() {
        let mut file = licensed_file(NOW);
        file.trial_used_dates = (0..30).map(|i| format!("2026-08-{:02}", i + 1)).collect();
        assert!(apply_deactivation(&mut file));
        let snap = compute_snapshot(&file, utc(NOW), TODAY);
        assert_eq!(snap.status, LicenseStatus::TrialExpired);
    }

    #[test]
    fn deactivation_without_license_is_noop() {
        let mut file = LicenseFile::default();
        assert!(!apply_deactivation(&mut file));
    }

    // -- last_seen / 時計巻き戻し ----------------------------------------------

    #[test]
    fn last_seen_set_on_first_observation() {
        let mut file = LicenseFile::default();
        let result = update_last_seen(&mut file, utc(NOW));
        assert!(result.changed);
        assert!(!result.rollback_detected);
        assert_eq!(file.last_seen_at.as_deref(), Some(NOW));
    }

    #[test]
    fn last_seen_moves_forward() {
        let mut file = LicenseFile {
            last_seen_at: Some("2026-09-01T00:00:00Z".to_string()),
            ..LicenseFile::default()
        };
        let result = update_last_seen(&mut file, utc(NOW));
        assert!(result.changed);
        assert!(!result.rollback_detected);
        assert_eq!(file.last_seen_at.as_deref(), Some(NOW));
    }

    #[test]
    fn last_seen_does_not_move_backward_and_reports_rollback() {
        // 巻き戻し: 値は保持し、観測だけ報告する (機能は止めない)。
        let mut file = LicenseFile {
            last_seen_at: Some("2026-09-20T00:00:00Z".to_string()),
            ..LicenseFile::default()
        };
        let result = update_last_seen(&mut file, utc(NOW));
        assert!(!result.changed);
        assert!(result.rollback_detected);
        assert_eq!(file.last_seen_at.as_deref(), Some("2026-09-20T00:00:00Z"));
    }

    #[test]
    fn last_seen_unparsable_is_overwritten() {
        let mut file = LicenseFile {
            last_seen_at: Some("garbage".to_string()),
            ..LicenseFile::default()
        };
        let result = update_last_seen(&mut file, utc(NOW));
        assert!(result.changed);
        assert!(!result.rollback_detected);
        assert_eq!(file.last_seen_at.as_deref(), Some(NOW));
    }

    // -- 初期化 -----------------------------------------------------------------

    #[test]
    fn ensure_initialized_sets_first_run_once() {
        let mut file = LicenseFile::default();
        assert!(ensure_initialized(&mut file, utc(NOW)));
        assert_eq!(file.first_run_at.as_deref(), Some(NOW));
        // 2 回目は no-op。
        assert!(!ensure_initialized(&mut file, utc("2026-09-09T00:00:00Z")));
        assert_eq!(file.first_run_at.as_deref(), Some(NOW));
    }

    // -- write 制限の判定表 -------------------------------------------------------

    #[test]
    fn write_restriction_table() {
        assert!(!LicenseStatus::Trial.is_write_restricted());
        assert!(!LicenseStatus::Licensed.is_write_restricted());
        assert!(!LicenseStatus::Grace.is_write_restricted());
        assert!(LicenseStatus::TrialExpired.is_write_restricted());
        assert!(LicenseStatus::LicenseStale.is_write_restricted());
        assert!(LicenseStatus::Revoked.is_write_restricted());
    }

    // -- IO (workspace.rs の global-settings テストパターン) ---------------------

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("grimodex_license_test_{name}"))
    }

    #[test]
    fn io_roundtrip_preserves_file() {
        let dir = temp_path("roundtrip");
        fs::remove_dir_all(&dir).ok();
        let path = dir.join("license.json");

        let mut original = licensed_file(NOW);
        original.first_run_at = Some("2026-08-01T00:00:00Z".to_string());
        original.trial_used_dates = vec!["2026-08-01".to_string()];
        write_license_file(&path, &original).expect("write should succeed");
        let read_back = read_license_file(&path);
        assert_eq!(read_back, original);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn io_missing_file_yields_default() {
        let path = temp_path("missing").join("license.json");
        assert_eq!(read_license_file(&path), LicenseFile::default());
    }

    #[test]
    fn io_corrupt_json_yields_default() {
        // fail-soft: 破損は試用初期状態へ (原稿は人質に取らない)。
        let dir = temp_path("corrupt");
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("license.json");
        fs::write(&path, "{ not valid json !!").expect("write");
        assert_eq!(read_license_file(&path), LicenseFile::default());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn io_disk_keys_are_snake_case() {
        // ディスク上スキーマは snake_case (Polar API と整合、設計書 §5.2)。
        let dir = temp_path("snake");
        fs::remove_dir_all(&dir).ok();
        let path = dir.join("license.json");
        write_license_file(&path, &licensed_file(NOW)).expect("write");
        let raw = fs::read_to_string(&path).expect("read raw");
        assert!(raw.contains("\"schema_version\""));
        assert!(raw.contains("\"trial_used_dates\""));
        assert!(raw.contains("\"activation_id\""));
        assert!(raw.contains("\"last_validated_at\""));
        assert!(!raw.contains("\"schemaVersion\""));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn io_forward_compat_ignores_unknown_fields() {
        // 将来フィールドが増えた license.json を旧ビルドが読んでも壊れない。
        let dir = temp_path("forward");
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("license.json");
        fs::write(
            &path,
            r#"{ "schema_version": 2, "trial_used_dates": ["2026-09-01"], "future_field": true }"#,
        )
        .expect("write");
        let file = read_license_file(&path);
        assert_eq!(file.schema_version, 2);
        assert_eq!(file.trial_used_dates, vec!["2026-09-01".to_string()]);
        fs::remove_dir_all(&dir).ok();
    }
}
