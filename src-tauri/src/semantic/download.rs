//! 埋め込みモデル (int8 ONNX) のオンデマンドダウンロード。
//!
//! 設計: `docs/設計_埋め込みモデルのオンデマンドDL.md`。
//!
//! int8 モデルは非同梱で、言語に応じて (JA=ruri / EN=bge) 初回利用時にここから DL
//! する (tokenizer のみ同梱。設計書 §4.7 の「同梱は tokenizer のみ・DL は onnx のみ」)。
//! DL 先は `app_data_dir/models/<dir_name>/`(唯一確実な writable)。手順は
//! 「.part へ streaming DL → sha256 検証 → tokenizer を揃える → model_int8.onnx へ
//! atomic rename → sha256 sidecar を書く」。インストール判定 (`download_dir_is_current`)
//! は model の存在に加えて **sidecar の sha256 が現行 spec と一致するか** まで見るため、
//! (a) 中断した .part が誤って load されず、(b) 別モデルへ差し替え (artifact_sha256 変更)
//! を検知して再 DL でき、(c) 旧バージョンの DL 済みを stale として置換できる。
//! sha256 は spec に焼いた calibration 対象と一致必須。
#![cfg(feature = "semantic-embedding")]

use std::io::Write;
use std::path::{Path, PathBuf};

use futures::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

use super::spec::EmbeddingModelSpec;

/// フロントの `useModelDownloadListener` が購読する進捗イベント名。
pub const MODEL_DOWNLOAD_PROGRESS_EVENT: &str = "semantic:model_download_progress";

/// 進捗ペイロード。`ReindexProgress` と同型 (camelCase)。
/// `done=true` かつ `error=None` で成功、`error=Some(..)` で失敗 (FTS degrade)。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadProgress {
    pub dir_name: String,
    pub downloaded: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
}

/// DL 済みモデルの書き込み先 `app_data_dir/models/<dir_name>`。
fn download_target_dir(
    app: &tauri::AppHandle,
    spec: &EmbeddingModelSpec,
) -> anyhow::Result<PathBuf> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("app_data_dir の取得に失敗しました: {e}"))?;
    Ok(data.join("models").join(spec.dir_name))
}

const MODEL_FILE: &str = "model_int8.onnx";
/// インストール済みモデルの identity 印。DL 完了時に `spec.artifact_sha256` を書き、
/// 以降 `download_dir_is_current` がこれと現行 spec を突き合わせる。ファイルの「存在」
/// だけでなく「中身が現行 spec と一致するか」を安価に判定でき、別モデルへの差し替え
/// (artifact_sha256 変更) を検知して再 DL を促せる。
const SIDECAR_FILE: &str = "model_int8.onnx.sha256";

/// DL 済みディレクトリが「現行 spec と一致する完成品」か。model_int8.onnx が在り、
/// かつ sidecar の sha256 が `spec.artifact_sha256` と一致する時だけ true。sidecar が
/// 無い/食い違う (=旧バージョン DL・中断・別モデル) は false → 呼び出し側が再 DL する。
pub fn download_dir_is_current(dir: &Path, spec: &EmbeddingModelSpec) -> bool {
    if !dir.join(MODEL_FILE).exists() {
        return false;
    }
    match std::fs::read_to_string(dir.join(SIDECAR_FILE)) {
        Ok(recorded) => recorded.trim() == spec.artifact_sha256,
        Err(_) => false,
    }
}

/// 現行 spec と一致する DL 済みモデルディレクトリ (app_data)。無ければ None。
/// ローダ (`resolve_model_dir`) と DL 判定 (`is_model_installed`) の両方から使う。
pub fn installed_download_dir(
    app: &tauri::AppHandle,
    spec: &EmbeddingModelSpec,
) -> Option<PathBuf> {
    let dir = download_target_dir(app, spec).ok()?;
    if download_dir_is_current(&dir, spec) {
        Some(dir)
    } else {
        None
    }
}

/// モデルが「使える状態で在る」か。バンドル同梱 (信頼・sidecar 不要) か、現行 spec と
/// 一致する DL 済み。DL の二重起動回避と先行トリガの skip 判定に使う。存在だけでなく
/// sha256 一致まで見るので、別モデルへ差し替え後は false になり再 DL される。
pub fn is_model_installed(app: &tauri::AppHandle, spec: &EmbeddingModelSpec) -> bool {
    let rel = PathBuf::from("resources/semantic").join(spec.dir_name);
    if let Ok(base) = app.path().resource_dir() {
        if base.join(&rel).join(MODEL_FILE).exists() {
            return true; // 同梱物は信頼 (Strategy A では int8 非同梱だが一般性のため残す)。
        }
    }
    installed_download_dir(app, spec).is_some()
}

/// 現行 spec 群 (`ALL_SPECS`) 以外の `app_data/models/<dir>` を削除する。モデル切替
/// (dir_name 変更) で残る旧モデルの掃除。起動時に 1 度だけ呼ぶ想定 (`lib.rs::setup`)。
/// 進行中 DL の dir は現行 spec に含まれるため消さない。
pub fn gc_stale_model_dirs(app: &tauri::AppHandle) {
    let Ok(base) = app.path().app_data_dir() else {
        return;
    };
    let models = base.join("models");
    let Ok(entries) = std::fs::read_dir(&models) else {
        return; // models/ 未作成 (初回) なら何もしない。
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let keep = super::spec::ALL_SPECS.iter().any(|s| s.dir_name == name);
        if !keep && std::fs::remove_dir_all(&path).is_ok() {
            tracing::info!(target: "semantic", "GC removed stale model dir: {name}");
        }
    }
}

fn emit_progress(app: &tauri::AppHandle, progress: ModelDownloadProgress) {
    let _ = app.emit(MODEL_DOWNLOAD_PROGRESS_EVENT, progress);
}

/// spec のモデルを DL してインストールする。成功/失敗を終端イベントで通知する。
/// 既にインストール済みなら即 Ok。`artifact_url` 未設定 (同梱専用 spec) は Err。
pub async fn download_model(
    app: tauri::AppHandle,
    spec: &'static EmbeddingModelSpec,
) -> anyhow::Result<()> {
    let result = install(&app, spec).await;
    match &result {
        Ok(()) => emit_progress(
            &app,
            ModelDownloadProgress {
                dir_name: spec.dir_name.to_string(),
                downloaded: spec.artifact_size,
                total: spec.artifact_size,
                done: true,
                error: None,
            },
        ),
        Err(e) => emit_progress(
            &app,
            ModelDownloadProgress {
                dir_name: spec.dir_name.to_string(),
                downloaded: 0,
                total: spec.artifact_size,
                done: true,
                error: Some(e.to_string()),
            },
        ),
    }
    result
}

async fn install(app: &tauri::AppHandle, spec: &EmbeddingModelSpec) -> anyhow::Result<()> {
    if spec.artifact_url.is_empty() {
        anyhow::bail!(
            "'{}' にはダウンロード元 (artifact_url) が設定されていません",
            spec.dir_name
        );
    }
    let dir = download_target_dir(app, spec)?;
    std::fs::create_dir_all(&dir)?;
    // 既に現行 spec と一致する DL 済みなら skip (sha256 sidecar で判定)。単なる
    // ファイル存在ではなく中身一致で見るので、別モデルへ差し替えた (artifact_sha256
    // 変更) 場合は skip されず再 DL される。
    if download_dir_is_current(&dir, spec) {
        return Ok(());
    }

    let final_path = dir.join(MODEL_FILE);
    let sidecar_path = dir.join(SIDECAR_FILE);
    // 更新の開始と同時に "not current" にする (古い sidecar を先に消す)。以降どの経路で
    // 中断しても download_dir_is_current=false のまま = 次回きちんと再 DL される。
    let _ = std::fs::remove_file(&sidecar_path);

    // .part は最終ディレクトリと同一 FS に置く (rename を atomic に保つ)。
    let part_path = dir.join("model_int8.onnx.part");
    let _ = std::fs::remove_file(&part_path); // 前回中断の残骸を掃除。

    // 破損した .part を残さないため、どの失敗経路でも掃除する。
    if let Err(e) = stream_and_verify(app, spec, &part_path).await {
        let _ = std::fs::remove_file(&part_path);
        return Err(e);
    }

    // ローダは model と同じディレクトリから tokenizer.json を読む。DL モデルの
    // ディレクトリ (app_data) に、バンドル同梱の tokenizer をコピーして揃える。
    if let Err(e) = ensure_tokenizer(app, spec, &dir) {
        let _ = std::fs::remove_file(&part_path);
        return Err(e);
    }

    // 旧モデルを置換して rename (Windows の rename は既存先で失敗しうるので先に消す)。
    let _ = std::fs::remove_file(&final_path);
    std::fs::rename(&part_path, &final_path)?;
    // sidecar は最後に書く = ここで初めて download_dir_is_current が true になる。
    // (rename 後〜write 前に落ちても "not current" 扱いで安全に再 DL される。)
    std::fs::write(&sidecar_path, spec.artifact_sha256)?;
    Ok(())
}

async fn stream_and_verify(
    app: &tauri::AppHandle,
    spec: &EmbeddingModelSpec,
    part_path: &Path,
) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        // 大容量 (34-37MB) なので total timeout は設けない。connect のみで
        // オフライン/到達不能を早期に諦める。
        .build()?;
    let resp = client
        .get(spec.artifact_url)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("モデルのダウンロードに接続できませんでした: {e}"))?;
    if !resp.status().is_success() {
        anyhow::bail!(
            "モデルのダウンロードが失敗しました (HTTP {})",
            resp.status().as_u16()
        );
    }

    // DoS ガード: 想定サイズ + 1MiB を上限に hard cap。
    let hard_cap = spec.artifact_size.saturating_add(1024 * 1024);
    let mut file = std::fs::File::create(part_path)?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| anyhow::anyhow!("ダウンロード中のストリームエラー: {e}"))?;
        downloaded = downloaded.saturating_add(bytes.len() as u64);
        if downloaded > hard_cap {
            anyhow::bail!("ダウンロードサイズが上限 ({} bytes) を超えました", hard_cap);
        }
        hasher.update(&bytes);
        file.write_all(&bytes)?;
        // 進捗 emit は ~1MiB ごとに間引く。
        if downloaded - last_emit >= 1024 * 1024 {
            last_emit = downloaded;
            emit_progress(
                app,
                ModelDownloadProgress {
                    dir_name: spec.dir_name.to_string(),
                    downloaded,
                    total: spec.artifact_size,
                    done: false,
                    error: None,
                },
            );
        }
    }
    file.flush()?;

    let got = hex::encode(hasher.finalize());
    if got != spec.artifact_sha256 {
        anyhow::bail!(
            "sha256 不一致: 期待 {} 実際 {} (別量子化の可能性 — calibration 無効化を防ぐため拒否)",
            spec.artifact_sha256,
            got
        );
    }
    Ok(())
}

/// DL モデルのディレクトリに tokenizer.json を用意する。EN の tokenizer は
/// バンドル同梱 (git-tracked) なので、それを app_data 側へコピーする。
fn ensure_tokenizer(
    app: &tauri::AppHandle,
    spec: &EmbeddingModelSpec,
    dir: &Path,
) -> anyhow::Result<()> {
    let dest = dir.join("tokenizer.json");
    if dest.exists() {
        return Ok(());
    }
    let rel = PathBuf::from("resources/semantic")
        .join(spec.dir_name)
        .join("tokenizer.json");
    if let Ok(base) = app.path().resource_dir() {
        let src = base.join(&rel);
        if src.exists() {
            std::fs::copy(&src, &dest)?;
            return Ok(());
        }
    }
    // dev/test 救済。
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(&rel);
    if dev.exists() {
        std::fs::copy(&dev, &dest)?;
        return Ok(());
    }
    anyhow::bail!(
        "tokenizer.json が見つかりません ('{}' のバンドル/dev いずれにも)",
        spec.dir_name
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn fresh_dir() -> PathBuf {
        // tempfile 依存なしでユニークな一時ディレクトリを作る。
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("grimodex-dl-test-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn current_requires_model_and_matching_sidecar() {
        let dir = fresh_dir();
        let spec = &crate::semantic::spec::SPEC_EN;

        // model 無し → false。
        assert!(!download_dir_is_current(&dir, spec));

        // model はあるが sidecar 無し (旧バージョン DL 相当) → false。
        std::fs::write(dir.join(MODEL_FILE), b"onnx-bytes").unwrap();
        assert!(!download_dir_is_current(&dir, spec));

        // sidecar が別 sha (別モデル差し替え相当) → false。
        std::fs::write(dir.join(SIDECAR_FILE), "0000000000000000").unwrap();
        assert!(!download_dir_is_current(&dir, spec));

        // sidecar が spec.artifact_sha256 と一致 → true。
        std::fs::write(dir.join(SIDECAR_FILE), spec.artifact_sha256).unwrap();
        assert!(download_dir_is_current(&dir, spec));

        // 末尾改行/空白があっても trim 一致で true。
        std::fs::write(
            dir.join(SIDECAR_FILE),
            format!("{}\n", spec.artifact_sha256),
        )
        .unwrap();
        assert!(download_dir_is_current(&dir, spec));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn each_spec_has_distinct_sidecar_identity() {
        // 2 モデルの sha256 が異なる = sidecar で取り違えない。
        let dir = fresh_dir();
        let ja = &crate::semantic::spec::SPEC_JA;
        let en = &crate::semantic::spec::SPEC_EN;
        std::fs::write(dir.join(MODEL_FILE), b"x").unwrap();
        std::fs::write(dir.join(SIDECAR_FILE), ja.artifact_sha256).unwrap();
        assert!(download_dir_is_current(&dir, ja));
        assert!(!download_dir_is_current(&dir, en));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
