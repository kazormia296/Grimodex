//! JS ワイヤ ↔ Rust 型の変換とエラー写像 (設計書 §5.2 のエラー文字列契約)。

use grimodex_db::AppError;

/// `AppError` → `napi::Error`。reason には Tauri invoke の reject 値
/// (= `AppError` の Display = `Serialize` が載せる文字列) と**同一の文字列**を
/// そのまま載せる。フロントは `WORKSPACE_SWITCHING` / `No workspace is open`
/// マーカーを 126 箇所で部分一致判定するため、ここで整形やラップを足しては
/// ならない (main の envelope は `{ ok:false, error: reason }` にそのまま入れる)。
pub fn app_err_to_napi(e: AppError) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

/// `spawn_blocking` の JoinError (swap 後 panic 等の異常系のみ)。
/// Tauri 側 (commands/db.rs, commands/workspace.rs) と同じ文言で包む。
pub fn join_err_to_napi(e: napi::tokio::task::JoinError) -> napi::Error {
    napi::Error::from_reason(format!("spawn_blocking join error: {e}"))
}

/// `LintError` → `napi::Error`。Tauri の `lint_text` は AppError と違い
/// **object** (`{"type":…,"data":…}` — serde tag/content) で reject する
/// 唯一のコマンド。reason にその JSON を載せ、ipcContract 側の lint_text
/// アダプタが parse して object reject に復元する (WireErrorValue —
/// FE `formatLintError` の `{type,data}` 分岐を保存するため)。
pub fn lint_err_to_napi(e: &grimodex_lint::LintError) -> napi::Error {
    let reason = serde_json::to_string(e).unwrap_or_else(|_| e.to_string());
    napi::Error::from_reason(reason)
}

/// f64 が正確に整数を表せる上限 (2^53)。これを超える整数は JS 側で既に精度を
/// 失っているため正規化しない。
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_992.0;

/// napi の serde-json 変換は JS number を i32 範囲外で **f64** にする
/// (`Date.now()` ≈ 1.7e12 が `1783664540830.0` になる)。一方 Tauri の invoke は
/// JSON テキスト経由なので `JSON.stringify(Date.now())` = 整数表記 → serde が
/// i64 に読む。この乖離は (a) `i64` フィールド (AppendChangeEvent.timestamp 等)
/// の deserialize 失敗、(b) SQLite への REAL 混入 (INTEGER 列想定) を生むため、
/// **整数値の f64 を i64 に正規化して Tauri ワイヤと同形にする** (再帰)。
pub fn normalize_integer_numbers(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Number(n) if n.is_f64() => {
            if let Some(f) = n.as_f64() {
                if f.is_finite() && f.fract() == 0.0 && f.abs() <= MAX_SAFE_INTEGER {
                    *n = serde_json::Number::from(f as i64);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                normalize_integer_numbers(item);
            }
        }
        serde_json::Value::Object(map) => {
            for (_, v) in map.iter_mut() {
                normalize_integer_numbers(v);
            }
        }
        _ => {}
    }
}

/// `params` (JSON 配列) → `Vec<Value>`。Tauri コマンドは `Vec<Value>` を serde で
/// 直接受けるが、napi 側は `serde_json::Value` で受けてここで形を検証する。
/// null / undefined は空配列として許容する (引数省略の安全側)。
pub fn params_array(mut params: serde_json::Value) -> Result<Vec<serde_json::Value>, AppError> {
    normalize_integer_numbers(&mut params);
    match params {
        serde_json::Value::Array(items) => Ok(items),
        serde_json::Value::Null => Ok(Vec::new()),
        other => Err(AppError::Anyhow(anyhow::anyhow!(
            "params must be a JSON array: got {other}"
        ))),
    }
}

/// 任意の JSON 値を serde 型へ (Tauri の引数 deserialize と同じ失敗モード)。
/// `label` はエラー文言用の引数名。
pub fn from_wire<T: serde::de::DeserializeOwned>(
    label: &str,
    mut value: serde_json::Value,
) -> Result<T, AppError> {
    normalize_integer_numbers(&mut value);
    serde_json::from_value(value)
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("invalid {label}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_error_markers_pass_through_to_napi_reason() {
        // クロス言語契約 (設計書 §5.2): FE は reject 文字列の部分一致で判定する。
        // napi reason は Tauri ワイヤ (AppError::serialize = Display) と
        // byte-equal であること — 透過テストの Rust 側半分 (JS 側は
        // test/smoke.test.mjs が "No workspace is open" で end-to-end を検証)。
        let switching = app_err_to_napi(AppError::WorkspaceSwitching);
        assert!(switching.reason.contains("WORKSPACE_SWITCHING"));
        assert_eq!(switching.reason, AppError::WorkspaceSwitching.to_string());

        let no_ws = app_err_to_napi(AppError::NoWorkspace);
        assert!(no_ws.reason.contains("No workspace is open"));
        assert_eq!(no_ws.reason, AppError::NoWorkspace.to_string());
    }

    #[test]
    fn lint_error_serializes_to_tagged_json_reason() {
        // Tauri ワイヤ: LintError は {"type":…,"data":…} の object で reject
        // される (FE formatLintError の分岐対象)。reason にその JSON が
        // そのまま載ること — JS 側アダプタの parse 復元前提。
        let err = lint_err_to_napi(&grimodex_lint::LintError::InvalidLanguage("fr".to_string()));
        let parsed: serde_json::Value = serde_json::from_str(&err.reason).expect("reason は JSON");
        assert_eq!(parsed["type"], "InvalidLanguage");
        assert_eq!(parsed["data"], "fr");
    }

    #[test]
    fn anyhow_app_error_keeps_top_level_message_only() {
        // Tauri ワイヤの Anyhow variant は `#[error("{0}")]` = anyhow の Display
        // (原因チェーン無し)。napi 側でも同じ形になること。
        let err = app_err_to_napi(AppError::Anyhow(anyhow::anyhow!("boom: {}", 42)));
        assert_eq!(err.reason, "boom: 42");
    }

    #[test]
    fn params_array_accepts_array_and_null_rejects_others() {
        let ok = params_array(serde_json::json!([1, "a", null])).expect("array ok");
        assert_eq!(ok.len(), 3);
        let empty = params_array(serde_json::Value::Null).expect("null → 空配列");
        assert!(empty.is_empty());
        let err = params_array(serde_json::json!({ "not": "array" })).expect_err("object は拒否");
        assert!(err.to_string().contains("params must be a JSON array"));
    }

    #[test]
    fn normalize_integer_numbers_matches_tauri_json_wire() {
        // napi serde-json は i32 範囲外の JS number を f64 にする。Tauri の
        // JSON テキストワイヤ (整数表記 → i64) と同形へ正規化されること。
        let mut v = serde_json::json!({
            "timestamp": 1_783_664_540_830.0_f64,   // Date.now() 相当
            "small": 1.0_f64,
            "real": 1.5_f64,                        // 真の小数はそのまま
            "nested": [{ "n": 42.0_f64 }],
            "text": "そのまま",
        });
        normalize_integer_numbers(&mut v);
        assert!(v["timestamp"].is_i64());
        assert_eq!(v["timestamp"].as_i64(), Some(1_783_664_540_830));
        assert!(v["small"].is_i64());
        assert!(v["real"].is_f64(), "小数部を持つ値は f64 のまま");
        assert!(v["nested"][0]["n"].is_i64(), "再帰的に正規化される");

        // i64 フィールドへの deserialize が通る (AppendChangeEvent.timestamp の
        // 失敗モードの回帰 gate)。
        #[derive(serde::Deserialize)]
        struct HasTimestamp {
            timestamp: i64,
        }
        let ok: HasTimestamp = from_wire(
            "event",
            serde_json::json!({ "timestamp": 1_783_664_540_830.0_f64 }),
        )
        .expect("整数正規化後は i64 に落ちる");
        assert_eq!(ok.timestamp, 1_783_664_540_830);
    }

    #[test]
    fn from_wire_deserializes_batch_statements() {
        // dbExecuteBatch のワイヤ形 (src/db/client.ts が送る {sql, params, method})
        // がそのまま BatchStatement に落ちること。
        let statements: Vec<grimodex_db::BatchStatement> = from_wire(
            "statements",
            serde_json::json!([
                { "sql": "INSERT INTO t (v) VALUES (?)", "params": [1], "method": "run" }
            ]),
        )
        .expect("deserialize");
        assert_eq!(statements.len(), 1);
        assert_eq!(statements[0].method, "run");

        let err = from_wire::<Vec<grimodex_db::BatchStatement>>(
            "statements",
            serde_json::json!("not an array"),
        )
        .expect_err("不正な形はエラー");
        assert!(err.to_string().contains("invalid statements"));
    }
}
