//! ライセンス関連の Tauri コマンド (薄い委譲)。
//!
//! 状態機械と license.json IO は `grimodex_core::license`、DTO 構築と Polar
//! クライアント (Phase 3 スタブ) は `crate::license`。時刻の取得はこの層に
//! 閉じ込め、純粋関数には引数で渡す (workspace.rs の時刻注入規約)。
//!
//! 並行制御: license.json の read-modify-write は `LicensePath.write_lock` で
//! 直列化する。sync コマンドと async コマンドは別スレッドで並行しうるため、
//! ロックなしでは lost update が起きる (例: 起動直後の get_license_state と
//! activate_license の競合で使用日追記かアクティベートの一方が消える)。
//! Polar への await 中はガードを持たず、**await 後にファイルを読み直してから**
//! 適用する (std::sync::MutexGuard は !Send で await を跨げない)。
//!
//! licensing 無効ビルドでも 4 コマンドすべて登録される。`get_license_state` は
//! `licensing_enabled: false` を返し (license.json には触れない = ベータ期間中に
//! 試用日を消費しない)、書き込み系 3 コマンドはエラーを返す。

use super::{AppError, LicensePath};
use crate::license::{self as glue, LicenseStateDto};
use grimodex_core::license as core_license;

/// 現在時刻 (UTC) とローカル暦日 ("YYYY-MM-DD") の組。
/// 試用カウントはローカルタイムゾーンの暦日ベース (設計書 §3)。
fn now_pair() -> (chrono::DateTime<chrono::Utc>, String) {
    (
        chrono::Utc::now(),
        chrono::Local::now().format("%Y-%m-%d").to_string(),
    )
}

fn ensure_licensing_enabled() -> Result<(), AppError> {
    if glue::LICENSING_ENABLED {
        Ok(())
    } else {
        Err(anyhow::anyhow!("このビルドではライセンス機構が無効です").into())
    }
}

/// license.json の read-modify-write 区間を直列化するガードを取る。
fn lock_license_file<'a>(
    license_path: &'a tauri::State<'_, LicensePath>,
) -> Result<std::sync::MutexGuard<'a, ()>, AppError> {
    Ok(license_path
        .write_lock
        .lock()
        .map_err(|e| anyhow::anyhow!("license write lock poisoned: {e}"))?)
}

/// 起動時 + 状態確認。試用使用日の登録と last_seen の単調更新も行う
/// (起動時に store が最初に呼ぶことが前提、設計書 §5.3)。
#[tauri::command]
pub(crate) fn get_license_state(
    license_path: tauri::State<'_, LicensePath>,
) -> Result<LicenseStateDto, AppError> {
    if !glue::LICENSING_ENABLED {
        return Ok(glue::disabled_dto());
    }
    let (now, today) = now_pair();
    let _guard = lock_license_file(&license_path)?;
    let mut file = core_license::read_license_file(&license_path.path);
    let mut changed = core_license::ensure_initialized(&mut file, now);
    changed |= core_license::register_usage_day(&mut file, &today);
    let seen = core_license::update_last_seen(&mut file, now);
    changed |= seen.changed;
    if seen.rollback_detected {
        // 時計巻き戻しは観測のみ。機能は止めない (fail-soft、設計書 §3)。
        tracing::warn!("license: clock rollback detected (now < last_seen_at)");
    }
    if changed {
        core_license::write_license_file(&license_path.path, &file)?;
    }
    let snapshot = core_license::compute_snapshot(&file, now, &today);
    Ok(glue::build_dto(&file, &snapshot))
}

/// キー入力 → Polar activate → license.json 更新 → 新状態を返す。
#[tauri::command]
pub(crate) async fn activate_license(
    license_path: tauri::State<'_, LicensePath>,
    key: String,
) -> Result<LicenseStateDto, AppError> {
    ensure_licensing_enabled()?;
    let activation = glue::polar_activate(&key).await?;
    // §4.3: メジャーバージョン期待値との照合。期待値未設定 (Product 作成前) と
    // benefit_id 欠損は素通り。v2 アプリに v1 キーを入れた場合のみここで弾く。
    if glue::benefit_mismatch(activation.benefit_id.as_deref()) {
        return Err(anyhow::anyhow!(
            "このライセンスキーは別のメジャーバージョン用です（このバージョンでは利用できません）"
        )
        .into());
    }
    let (now, today) = now_pair();
    let _guard = lock_license_file(&license_path)?;
    let mut file = core_license::read_license_file(&license_path.path);
    core_license::apply_activation(
        &mut file,
        core_license::NewActivation {
            key,
            activation_id: activation.activation_id,
            benefit_id: activation.benefit_id,
        },
        now,
    );
    core_license::write_license_file(&license_path.path, &file)?;
    let snapshot = core_license::compute_snapshot(&file, now, &today);
    Ok(glue::build_dto(&file, &snapshot))
}

/// await 前に読んだアクティベーションがまだ現役か (await 中に deactivate /
/// 別キーで activate されていないか) を確認する。
fn is_same_activation(file: &core_license::LicenseFile, activation_id: &str) -> bool {
    file.license
        .as_ref()
        .is_some_and(|l| l.activation_id == activation_id)
}

/// validate の二重送信ガード。Drop でフラグを戻す RAII。
/// AtomicBool なので await を跨いで保持してよい (MutexGuard と違い Send)。
struct ValidateInFlight<'a>(&'a std::sync::atomic::AtomicBool);

impl<'a> ValidateInFlight<'a> {
    fn try_begin(flag: &'a std::sync::atomic::AtomicBool) -> Option<Self> {
        use std::sync::atomic::Ordering;
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(flag))
    }
}

impl Drop for ValidateInFlight<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

/// 手動再検証 (`license_stale` からの復帰ボタン用)。
/// 通信失敗は状態を変えずエラーを返す。「キー無効」の明示応答のみ revoked。
#[tauri::command]
pub(crate) async fn revalidate_license(
    license_path: tauri::State<'_, LicensePath>,
) -> Result<LicenseStateDto, AppError> {
    ensure_licensing_enabled()?;
    let Some(_in_flight) = ValidateInFlight::try_begin(&license_path.validate_in_flight) else {
        return Err(anyhow::anyhow!("すでに再検証を実行中です").into());
    };
    // await 前はキーの取得だけ。適用は await 後に読み直したファイルへ行う。
    let lic = {
        let file = core_license::read_license_file(&license_path.path);
        let Some(lic) = file.license else {
            return Err(anyhow::anyhow!("ライセンスがアクティベートされていません").into());
        };
        lic
    };
    let outcome = glue::polar_validate(&lic.key, &lic.activation_id).await;
    let (now, today) = now_pair();
    let _guard = lock_license_file(&license_path)?;
    let mut file = core_license::read_license_file(&license_path.path);
    match outcome {
        Ok(glue::PolarValidateOutcome::Valid { benefit_id }) => {
            if is_same_activation(&file, &lic.activation_id)
                && core_license::apply_validate_success(&mut file, benefit_id.as_deref(), now)
            {
                core_license::write_license_file(&license_path.path, &file)?;
            }
        }
        Ok(glue::PolarValidateOutcome::Invalid) => {
            // Polar の明示「キー無効」応答のみここに入る (設計書 §3 の重要な区別)。
            if is_same_activation(&file, &lic.activation_id)
                && core_license::apply_revoked(&mut file, now)
            {
                core_license::write_license_file(&license_path.path, &file)?;
            }
        }
        // 通信失敗 (5xx 含む) は fail-soft: 状態を一切変えない。
        Err(e) => return Err(e.into()),
    }
    let snapshot = core_license::compute_snapshot(&file, now, &today);
    Ok(glue::build_dto(&file, &snapshot))
}

/// Settings の「この端末を解除」。Polar deactivate 成功時のみローカル破棄。
/// 試用日数が残っていれば trial に戻る (設計書 §4.2)。
#[tauri::command]
pub(crate) async fn deactivate_license(
    license_path: tauri::State<'_, LicensePath>,
) -> Result<LicenseStateDto, AppError> {
    ensure_licensing_enabled()?;
    let lic = {
        let file = core_license::read_license_file(&license_path.path);
        let Some(lic) = file.license else {
            return Err(anyhow::anyhow!("ライセンスがアクティベートされていません").into());
        };
        lic
    };
    glue::polar_deactivate(&lic.key, &lic.activation_id).await?;
    let (now, today) = now_pair();
    let _guard = lock_license_file(&license_path)?;
    let mut file = core_license::read_license_file(&license_path.path);
    // await 中に別キーで activate し直されていたら、その新しい license は壊さない。
    if is_same_activation(&file, &lic.activation_id) && core_license::apply_deactivation(&mut file)
    {
        core_license::write_license_file(&license_path.path, &file)?;
    }
    let snapshot = core_license::compute_snapshot(&file, now, &today);
    Ok(glue::build_dto(&file, &snapshot))
}

/// バックグラウンド再検証の 1 サイクル (設計書 §5.4)。
///
/// 最終検証成功から 7 日以上経過 (= snapshot.needs_validation) の場合のみ
/// Polar validate を投げ、結果を license.json と `license:state_changed`
/// イベントへ反映する。通信失敗は状態を変えずログのみ (fail-soft —
/// リトライ・バックオフは実装せず、次の定期チェックが事実上のリトライ)。
///
/// §3 前方ジャンプ対策との関係: フロントは license_stale の**制限発動**を
/// 「validate 試行を経た確認」(store の staleConfirmed) まで保留しており、
/// このサイクルの emit が確認経路になる (もう一つは手動再検証の失敗)。
/// licensing 無効ビルドでは何もしない。
pub(crate) async fn run_validate_cycle(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};

    if !glue::LICENSING_ENABLED {
        return;
    }
    let license_path = app.state::<LicensePath>();
    let (now, today) = now_pair();
    let file = core_license::read_license_file(&license_path.path);
    let snapshot = core_license::compute_snapshot(&file, now, &today);
    if !snapshot.needs_validation {
        return;
    }
    let Some(lic) = file.license else {
        return;
    };
    // 手動再検証と同時に走った場合は今回のサイクルを見送る (次サイクルで再試行)。
    let Some(_in_flight) = ValidateInFlight::try_begin(&license_path.validate_in_flight) else {
        return;
    };

    let outcome = glue::polar_validate(&lic.key, &lic.activation_id).await;

    let (now, today) = now_pair();
    let dto = {
        // 書き戻しは write_lock で直列化し、await 後に読み直したファイルへ適用
        // (コマンド側と同じ規律。MutexGuard はこのブロック内で await を跨がない)。
        let _guard = match license_path.write_lock.lock() {
            Ok(g) => g,
            Err(poison) => poison.into_inner(),
        };
        let mut file = core_license::read_license_file(&license_path.path);
        match outcome {
            Ok(glue::PolarValidateOutcome::Valid { benefit_id }) => {
                if is_same_activation(&file, &lic.activation_id)
                    && core_license::apply_validate_success(&mut file, benefit_id.as_deref(), now)
                {
                    if let Err(e) = core_license::write_license_file(&license_path.path, &file) {
                        tracing::warn!("license: failed to persist validate success: {e}");
                    }
                }
            }
            Ok(glue::PolarValidateOutcome::Invalid) => {
                if is_same_activation(&file, &lic.activation_id)
                    && core_license::apply_revoked(&mut file, now)
                {
                    if let Err(e) = core_license::write_license_file(&license_path.path, &file) {
                        tracing::warn!("license: failed to persist revocation: {e}");
                    }
                }
            }
            Err(e) => {
                tracing::info!("license: background validate failed (retry next cycle): {e}");
            }
        }
        let snapshot = core_license::compute_snapshot(&file, now, &today);
        glue::build_dto(&file, &snapshot)
    };
    // 失敗 (ウィンドウ未生成等) は握り潰す — emit は best-effort (fail-soft)。
    let _ = app.emit("license:state_changed", dto);
}
