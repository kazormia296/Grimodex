//! ライセンス関連の Tauri コマンド。
//!
//! 状態機械・IO・Polar通信・並行制御は `grimodex-license` が正本。この層は
//! Tauri State / AppError / event の形へ変換するだけに留める。

use super::AppError;
use grimodex_license::{LicenseRuntime, LicenseStateDto};

#[tauri::command]
pub(crate) fn get_license_state(
    runtime: tauri::State<'_, LicenseRuntime>,
) -> Result<LicenseStateDto, AppError> {
    grimodex_license::get_license_state(runtime.inner()).map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn activate_license(
    runtime: tauri::State<'_, LicenseRuntime>,
    key: String,
) -> Result<LicenseStateDto, AppError> {
    grimodex_license::activate_license(runtime.inner(), key)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn revalidate_license(
    runtime: tauri::State<'_, LicenseRuntime>,
) -> Result<LicenseStateDto, AppError> {
    grimodex_license::revalidate_license(runtime.inner())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn deactivate_license(
    runtime: tauri::State<'_, LicenseRuntime>,
) -> Result<LicenseStateDto, AppError> {
    grimodex_license::deactivate_license(runtime.inner())
        .await
        .map_err(Into::into)
}

pub(crate) async fn run_validate_cycle(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};

    let runtime = app.state::<LicenseRuntime>();
    if let Some(dto) = grimodex_license::run_validate_cycle(runtime.inner()).await {
        // ウィンドウ未生成等の失敗は fail-soft。
        let _ = app.emit("license:state_changed", dto);
    }
}
