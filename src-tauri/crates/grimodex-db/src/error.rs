//! コマンド層共通のエラー / 結果型 (旧 `src-tauri/src/commands/mod.rs` から
//! Electron 移行 Phase 2 S1 で移動)。`AppError` の**文字列ワイヤ契約**
//! (`WORKSPACE_SWITCHING` / `No workspace is open` マーカー、object 化禁止) は
//! Tauri invoke と Electron envelope の両ワイヤで共有されるため、既存テストごと
//! このクレートで gate を維持する。

use serde::Serialize;
use serde_json::Value;

/// コマンドの標準 Result 型 (`Result<T, AppError>` の別名)。新規コマンドは
/// これを使う。
pub type AppResult<T> = Result<T, AppError>;

/// コマンドがフロントへ返すエラー。ドメイン化された失敗は名前付き variant に
/// し、それ以外は `Anyhow` に集約する (`?` で anyhow から自動変換)。
///
/// **ワイヤ形式は文字列**: `Serialize` は Display をそのまま `serialize_str` で
/// 載せる。フロントは invoke reject 値を 126 箇所で `String(err)` /
/// `err.message` として読むため、object 形 (`{code, message}`) へ変えると全箇所が
/// "[object Object]" に化ける。よって `code` フィールド追加と FE の code ベース
/// 判定への移行は Slice2 (FE と同時) で行い、本 Slice では文字列ワイヤを維持する。
/// 名前付き variant の Display には、フロントが部分一致で判定している安定
/// マーカーを必ず含めること (下記各 variant のコメント参照)。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// workspace 切替中の DB アクセス拒否 (M3)。Display は安定マーカー
    /// "WORKSPACE_SWITCHING" を含む — フロント
    /// `src/features/concurrency/workspaceSwitching.ts` の
    /// `WORKSPACE_SWITCHING_MARKER` と対。変更時は両方同時に。
    #[error("WORKSPACE_SWITCHING: workspace is switching; DB access is temporarily rejected")]
    WorkspaceSwitching,

    /// アクティブな workspace が無い状態での DB / メタアクセス。
    #[error("No workspace is open")]
    NoWorkspace,

    /// Restore-only Safe Mode 中に通常の DB authority API が呼ばれた。
    /// Display は安定マーカー `WORKSPACE_SAFE_MODE` を含む — FE / IPC 分類と対。
    #[error(
        "WORKSPACE_SAFE_MODE: restore-only session is active; Database authority is not published"
    )]
    SafeModeActive,

    /// Safe Mode セッションが無い状態で recovery API が呼ばれた。
    #[error("No safe mode session is active")]
    NoSafeMode,

    /// ドメイン化されていないアプリ層エラー。`?` で anyhow から自動変換される。
    #[error("{0}")]
    Anyhow(#[from] anyhow::Error),
}

impl From<crate::workspace_lease::LeaseError> for AppError {
    fn from(value: crate::workspace_lease::LeaseError) -> Self {
        AppError::Anyhow(anyhow::anyhow!("{value}"))
    }
}

impl From<crate::workspace_lifecycle::LifecycleError> for AppError {
    fn from(value: crate::workspace_lifecycle::LifecycleError) -> Self {
        AppError::Anyhow(value.into())
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // 文字列ワイヤ (上記コメント参照)。object 化は FE 移行と同時 (Slice2)
        // まで禁止 — 破ると 126 箇所の String(err) が "[object Object]" になる。
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Serialize)]
pub struct QueryResult {
    pub rows: Vec<serde_json::Map<String, Value>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_error_variant_display_carries_frontend_markers() {
        // クロス言語契約: フロントは Display 文字列の部分一致でこれらを判定する
        // (workspaceSwitching.ts / debugLog rootCause 経由の版数判定など)。
        // variant の Display からマーカーが消えると FE の分岐が静かに壊れる。
        assert!(AppError::WorkspaceSwitching
            .to_string()
            .contains("WORKSPACE_SWITCHING"));
        assert!(AppError::NoWorkspace
            .to_string()
            .contains("No workspace is open"));
        assert!(AppError::SafeModeActive
            .to_string()
            .contains("WORKSPACE_SAFE_MODE"));
        assert!(AppError::NoSafeMode
            .to_string()
            .contains("No safe mode session is active"));
    }

    #[test]
    fn app_error_serializes_as_bare_string_not_object() {
        // ワイヤは文字列を維持する (フロントは 126 箇所で String(err) / err.message
        // として読むため object 化すると全滅する)。object 化は FE 移行と同時
        // (Slice2) まで禁止 — その回帰をここで gate する。
        let json = serde_json::to_string(&AppError::WorkspaceSwitching).expect("serialize");
        assert!(
            json.starts_with('"') && json.ends_with('"'),
            "AppError はワイヤに文字列で載ること (object 化禁止): {json}"
        );
        assert!(json.contains("WORKSPACE_SWITCHING"));
    }
}
