//! 埋め込みモデル (int8 ONNX) のオンデマンドダウンロード。
//!
//! 設計: `docs/設計_埋め込みモデルのオンデマンドDL.md`。
//!
//! int8 モデルは非同梱で、言語に応じて (JA=ruri / EN=bge) 初回利用時にここから DL
//! する (tokenizer のみ同梱。設計書 §4.7 の「同梱は tokenizer のみ・DL は onnx のみ」)。
//! DL 先は `app_data_dir/models/<dir_name>/`(唯一確実な writable)。手順は
//! 「.part へ streaming DL → sha256 検証 → tokenizer を揃える → model_int8.onnx へ
//! atomic rename」。`resolve_model_dir`(commands/semantic.rs)は最終 model_int8.onnx の
//! 存在のみ見るため、rename 完了が「インストール完了」を意味し、中断した .part が
//! 誤って load されることはない。sha256 は spec に焼いた calibration 対象と一致必須。
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

/// `resolve_model_dir` と同じ判定 (model_int8.onnx の存在) で、バンドル同梱または
/// DL 済みディレクトリのどちらかにモデルが既に在るかを返す。DL の二重起動回避に使う。
pub fn is_model_installed(app: &tauri::AppHandle, spec: &EmbeddingModelSpec) -> bool {
    let rel = PathBuf::from("resources/semantic").join(spec.dir_name);
    if let Ok(base) = app.path().resource_dir() {
        if base.join(&rel).join("model_int8.onnx").exists() {
            return true;
        }
    }
    if let Ok(dir) = download_target_dir(app, spec) {
        if dir.join("model_int8.onnx").exists() {
            return true;
        }
    }
    false
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
    let final_path = dir.join("model_int8.onnx");
    if final_path.exists() {
        return Ok(()); // 別経路で既にインストール済み。
    }

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

    // atomic rename = インストール完了 (ここで初めて resolve_model_dir が拾う)。
    std::fs::rename(&part_path, &final_path)?;
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
