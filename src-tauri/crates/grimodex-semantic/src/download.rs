//! Shell-independent semantic model download and installation.
//!
//! The caller owns task spawning and event transport.  Paths are injected by
//! the desktop shell, so release code never falls back to a build-machine
//! `CARGO_MANIFEST_DIR`.

#![cfg(feature = "semantic-embedding")]

use std::fs::{File, OpenOptions};
use std::io::{self, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::StreamExt;
use sha2::{Digest, Sha256};

use crate::runtime::{ModelDownloadProgress, SemanticPaths};
use crate::spec::{EmbeddingModelSpec, ALL_SPECS};

const MODEL_FILE: &str = "model_int8.onnx";
const SIDECAR_FILE: &str = "model_int8.onnx.sha256";
const MODEL_DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MODEL_DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(60);

pub fn download_dir_is_current(dir: &Path, spec: &EmbeddingModelSpec) -> bool {
    if !dir.join(MODEL_FILE).exists() {
        return false;
    }
    std::fs::read_to_string(dir.join(SIDECAR_FILE))
        .map(|recorded| recorded.trim() == spec.artifact_sha256)
        .unwrap_or(false)
}

pub fn installed_download_dir(paths: &SemanticPaths, spec: &EmbeddingModelSpec) -> Option<PathBuf> {
    let dir = paths.models_root.join(spec.dir_name);
    (download_dir_is_current(&dir, spec) && tokenizer_is_usable(&dir.join("tokenizer.json")))
        .then_some(dir)
}

pub fn bundled_model_dir(paths: &SemanticPaths, spec: &EmbeddingModelSpec) -> Option<PathBuf> {
    let dir = paths.resource_semantic_root.join(spec.dir_name);
    (dir.join(MODEL_FILE).exists() && tokenizer_is_usable(&dir.join("tokenizer.json")))
        .then_some(dir)
}

pub fn resolve_model_dir(paths: &SemanticPaths, spec: &EmbeddingModelSpec) -> Option<PathBuf> {
    bundled_model_dir(paths, spec).or_else(|| installed_download_dir(paths, spec))
}

pub fn is_model_installed(paths: &SemanticPaths, spec: &EmbeddingModelSpec) -> bool {
    resolve_model_dir(paths, spec).is_some()
}

/// Remove model directories that no current specification can use.
pub fn gc_stale_model_dirs(paths: &SemanticPaths) {
    let Ok(entries) = std::fs::read_dir(&paths.models_root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let keep = ALL_SPECS.iter().any(|spec| spec.dir_name == name);
        if !keep && std::fs::remove_dir_all(&path).is_ok() {
            tracing::info!(target: "semantic", "GC removed stale model dir: {name}");
        }
    }
}

/// Download, verify and atomically publish one model.
///
/// `progress` is deliberately injected; the core has no knowledge of Tauri,
/// Electron, or their event APIs.  Terminal progress is emitted by the owning
/// [`crate::runtime::ModelDownloadJob`] so every failure path is covered.
pub async fn install(
    paths: &SemanticPaths,
    spec: &'static EmbeddingModelSpec,
    progress: &(dyn Fn(ModelDownloadProgress) + Send + Sync),
) -> anyhow::Result<()> {
    if spec.artifact_url.is_empty() {
        anyhow::bail!(
            "'{}' にはダウンロード元 (artifact_url) が設定されていません",
            spec.dir_name
        );
    }

    let dir = paths.models_root.join(spec.dir_name);
    std::fs::create_dir_all(&dir)?;
    if download_dir_is_current(&dir, spec) {
        // A previous install can have a valid model+sidecar but lose the
        // tokenizer (manual cleanup, interrupted older release). Repair it
        // from the injected resource root instead of permanently reporting an
        // installed-yet-unloadable model.
        ensure_tokenizer(paths, spec, &dir)?;
        return Ok(());
    }

    let final_path = dir.join(MODEL_FILE);
    let sidecar_path = dir.join(SIDECAR_FILE);
    let part_path = dir.join("model_int8.onnx.part");
    let _ = std::fs::remove_file(&sidecar_path);
    let _ = std::fs::remove_file(&part_path);

    if let Err(error) = stream_and_verify(spec, &part_path, progress).await {
        let _ = std::fs::remove_file(&part_path);
        return Err(error);
    }
    if let Err(error) = ensure_tokenizer(paths, spec, &dir) {
        let _ = std::fs::remove_file(&part_path);
        return Err(error);
    }

    // Windows cannot rename over an existing file.  The sidecar is already
    // absent, so a crash in this short replacement window is detected as an
    // incomplete install and retried on the next request.
    let _ = std::fs::remove_file(&final_path);
    std::fs::rename(&part_path, &final_path)?;
    std::fs::write(&sidecar_path, spec.artifact_sha256)?;
    Ok(())
}

async fn stream_and_verify(
    spec: &'static EmbeddingModelSpec,
    part_path: &Path,
    progress: &(dyn Fn(ModelDownloadProgress) + Send + Sync),
) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .connect_timeout(MODEL_DOWNLOAD_CONNECT_TIMEOUT)
        // Per-read idle timeout. A server that accepts the connection and then
        // stops producing bytes must not leave the in-flight model slot stuck
        // forever; large healthy downloads remain unrestricted in total time.
        .read_timeout(MODEL_DOWNLOAD_READ_TIMEOUT)
        .build()?;
    let response = client
        .get(spec.artifact_url)
        .send()
        .await
        .map_err(|error| anyhow::anyhow!("モデルのダウンロードに接続できませんでした: {error}"))?;
    if !response.status().is_success() {
        anyhow::bail!(
            "モデルのダウンロードが失敗しました (HTTP {})",
            response.status().as_u16()
        );
    }

    let hard_cap = spec.artifact_size.saturating_add(1024 * 1024);
    let mut file = std::fs::File::create(part_path)?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut last_emit = 0_u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes =
            chunk.map_err(|error| anyhow::anyhow!("ダウンロード中のストリームエラー: {error}"))?;
        downloaded = downloaded.saturating_add(bytes.len() as u64);
        if downloaded > hard_cap {
            anyhow::bail!("ダウンロードサイズが上限 ({hard_cap} bytes) を超えました");
        }
        hasher.update(&bytes);
        file.write_all(&bytes)?;
        if downloaded.saturating_sub(last_emit) >= 1024 * 1024 {
            last_emit = downloaded;
            progress(ModelDownloadProgress {
                dir_name: spec.dir_name.to_string(),
                downloaded,
                total: spec.artifact_size,
                done: false,
                error: None,
            });
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

fn ensure_tokenizer(
    paths: &SemanticPaths,
    spec: &EmbeddingModelSpec,
    destination_dir: &Path,
) -> anyhow::Result<()> {
    let destination = destination_dir.join("tokenizer.json");
    if tokenizer_is_usable(&destination) {
        return Ok(());
    }
    let source = paths
        .resource_semantic_root
        .join(spec.dir_name)
        .join("tokenizer.json");
    if !tokenizer_is_usable(&source) {
        anyhow::bail!(
            "usable tokenizer.json が見つかりません ('{}' の resource semantic root)",
            spec.dir_name
        );
    }

    std::fs::create_dir_all(destination_dir)?;
    let staged = destination_dir.join(format!(
        ".tokenizer-{}-{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> anyhow::Result<()> {
        let mut reader = BufReader::new(File::open(&source)?);
        let mut writer = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)?;
        io::copy(&mut reader, &mut writer)?;
        writer.flush()?;
        writer.sync_all()?;
        drop(writer);

        tokenizers::Tokenizer::from_file(&staged)
            .map_err(|error| anyhow::anyhow!("staged tokenizer validation failed: {error}"))?;
        atomic_replace(&staged, &destination)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    result
}

fn tokenizer_is_usable(path: &Path) -> bool {
    path.is_file() && tokenizers::Tokenizer::from_file(path).is_ok()
}

#[cfg(not(windows))]
fn atomic_replace(staged: &Path, destination: &Path) -> io::Result<()> {
    std::fs::rename(staged, destination)
}

#[cfg(windows)]
fn atomic_replace(staged: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

    if !destination.exists() {
        return std::fs::rename(staged, destination);
    }
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let staged_wide: Vec<u16> = staged
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: both buffers are NUL-terminated and live through the call; all
    // optional backup/exclude/reserved pointers are null as required.
    let replaced = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            staged_wide.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedding::Embedder;
    use crate::spec::{SPEC_EN, SPEC_JA};

    const VALID_TOKENIZER_JSON: &str = r#"{
      "version":"1.0",
      "truncation":null,
      "padding":null,
      "added_tokens":[],
      "normalizer":null,
      "pre_tokenizer":null,
      "post_processor":null,
      "decoder":null,
      "model":{"type":"WordLevel","vocab":{"[UNK]":0},"unk_token":"[UNK]"}
    }"#;

    fn temp_paths(label: &str) -> SemanticPaths {
        let root = std::env::temp_dir().join(format!(
            "grimodex-semantic-download-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        SemanticPaths {
            models_root: root.join("models"),
            resource_semantic_root: root.join("resources"),
        }
    }

    #[test]
    fn current_requires_model_and_matching_sidecar() {
        let paths = temp_paths("sidecar");
        let dir = paths.models_root.join(SPEC_EN.dir_name);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!download_dir_is_current(&dir, &SPEC_EN));
        std::fs::write(dir.join(MODEL_FILE), b"model").unwrap();
        assert!(!download_dir_is_current(&dir, &SPEC_EN));
        std::fs::write(dir.join(SIDECAR_FILE), "wrong").unwrap();
        assert!(!download_dir_is_current(&dir, &SPEC_EN));
        std::fs::write(
            dir.join(SIDECAR_FILE),
            format!("{}\n", SPEC_EN.artifact_sha256),
        )
        .unwrap();
        assert!(download_dir_is_current(&dir, &SPEC_EN));
        let _ = std::fs::remove_dir_all(paths.models_root.parent().unwrap());
    }

    #[test]
    fn bundled_and_download_roots_are_explicit() {
        let paths = temp_paths("roots");
        let bundled = paths.resource_semantic_root.join(SPEC_JA.dir_name);
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::write(bundled.join(MODEL_FILE), b"model").unwrap();
        std::fs::write(bundled.join("tokenizer.json"), VALID_TOKENIZER_JSON).unwrap();
        assert_eq!(bundled_model_dir(&paths, &SPEC_JA), Some(bundled));
        let _ = std::fs::remove_dir_all(paths.models_root.parent().unwrap());
    }

    #[test]
    fn bundled_model_with_wrong_artifact_bytes_fails_cold_load_verification() {
        let paths = temp_paths("bundled-artifact-mismatch");
        let bundled = paths.resource_semantic_root.join(SPEC_JA.dir_name);
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::write(bundled.join(MODEL_FILE), b"wrong bundled model bytes").unwrap();
        std::fs::write(bundled.join("tokenizer.json"), VALID_TOKENIZER_JSON).unwrap();

        let resolved = bundled_model_dir(&paths, &SPEC_JA).expect("bundled model candidate");
        let error = Embedder::load(
            &resolved.join(MODEL_FILE),
            &resolved.join("tokenizer.json"),
            &SPEC_JA,
        )
        .err()
        .expect("wrong bundled artifact must fail before ORT load");
        assert!(error.to_string().contains("ONNX artifact sha256 mismatch"));
        let _ = std::fs::remove_dir_all(paths.models_root.parent().unwrap());
    }

    #[test]
    fn downloaded_model_with_matching_sidecar_but_wrong_bytes_fails_cold_load_verification() {
        let paths = temp_paths("downloaded-artifact-mismatch");
        let downloaded = paths.models_root.join(SPEC_EN.dir_name);
        std::fs::create_dir_all(&downloaded).unwrap();
        std::fs::write(downloaded.join(MODEL_FILE), b"wrong downloaded model bytes").unwrap();
        std::fs::write(downloaded.join(SIDECAR_FILE), SPEC_EN.artifact_sha256).unwrap();
        std::fs::write(downloaded.join("tokenizer.json"), VALID_TOKENIZER_JSON).unwrap();

        let resolved =
            installed_download_dir(&paths, &SPEC_EN).expect("sidecar-matched model candidate");
        let error = Embedder::load(
            &resolved.join(MODEL_FILE),
            &resolved.join("tokenizer.json"),
            &SPEC_EN,
        )
        .err()
        .expect("wrong downloaded artifact must fail before ORT load");
        assert!(error.to_string().contains("ONNX artifact sha256 mismatch"));
        let _ = std::fs::remove_dir_all(paths.models_root.parent().unwrap());
    }

    #[test]
    fn each_spec_has_distinct_sidecar_identity() {
        let paths = temp_paths("identity");
        let dir = paths.models_root.join(SPEC_JA.dir_name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(MODEL_FILE), b"model").unwrap();
        std::fs::write(dir.join(SIDECAR_FILE), SPEC_EN.artifact_sha256).unwrap();
        assert!(!download_dir_is_current(&dir, &SPEC_JA));
        std::fs::write(dir.join(SIDECAR_FILE), SPEC_JA.artifact_sha256).unwrap();
        assert!(download_dir_is_current(&dir, &SPEC_JA));
        assert_ne!(SPEC_JA.artifact_sha256, SPEC_EN.artifact_sha256);
        let _ = std::fs::remove_dir_all(paths.models_root.parent().unwrap());
    }

    #[test]
    fn current_model_with_corrupt_tokenizer_is_unusable_and_repairable() {
        let paths = temp_paths("tokenizer-repair");
        let downloaded = paths.models_root.join(SPEC_EN.dir_name);
        let bundled = paths.resource_semantic_root.join(SPEC_EN.dir_name);
        std::fs::create_dir_all(&downloaded).unwrap();
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::write(downloaded.join(MODEL_FILE), b"model").unwrap();
        std::fs::write(downloaded.join(SIDECAR_FILE), SPEC_EN.artifact_sha256).unwrap();
        std::fs::write(downloaded.join("tokenizer.json"), b"corrupt").unwrap();
        std::fs::write(bundled.join("tokenizer.json"), VALID_TOKENIZER_JSON).unwrap();

        assert!(download_dir_is_current(&downloaded, &SPEC_EN));
        assert!(installed_download_dir(&paths, &SPEC_EN).is_none());
        ensure_tokenizer(&paths, &SPEC_EN, &downloaded).unwrap();
        assert!(tokenizer_is_usable(&downloaded.join("tokenizer.json")));
        assert_eq!(installed_download_dir(&paths, &SPEC_EN), Some(downloaded));
        let _ = std::fs::remove_dir_all(paths.models_root.parent().unwrap());
    }

    #[test]
    fn bundled_model_rejects_corrupt_tokenizer() {
        let paths = temp_paths("bundled-corrupt");
        let bundled = paths.resource_semantic_root.join(SPEC_JA.dir_name);
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::write(bundled.join(MODEL_FILE), b"model").unwrap();
        std::fs::write(bundled.join("tokenizer.json"), b"corrupt").unwrap();
        assert!(bundled_model_dir(&paths, &SPEC_JA).is_none());
        let _ = std::fs::remove_dir_all(paths.models_root.parent().unwrap());
    }

    #[test]
    fn corrupt_source_does_not_replace_existing_destination() {
        let paths = temp_paths("source-corrupt");
        let downloaded = paths.models_root.join(SPEC_EN.dir_name);
        let bundled = paths.resource_semantic_root.join(SPEC_EN.dir_name);
        std::fs::create_dir_all(&downloaded).unwrap();
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::write(downloaded.join("tokenizer.json"), b"old-corrupt").unwrap();
        std::fs::write(bundled.join("tokenizer.json"), b"new-corrupt").unwrap();
        assert!(ensure_tokenizer(&paths, &SPEC_EN, &downloaded).is_err());
        assert_eq!(
            std::fs::read(downloaded.join("tokenizer.json")).unwrap(),
            b"old-corrupt"
        );
        let _ = std::fs::remove_dir_all(paths.models_root.parent().unwrap());
    }

    #[test]
    fn download_client_has_finite_idle_read_timeout() {
        assert_eq!(MODEL_DOWNLOAD_CONNECT_TIMEOUT, Duration::from_secs(10));
        assert_eq!(MODEL_DOWNLOAD_READ_TIMEOUT, Duration::from_secs(60));
    }

    #[test]
    fn gc_removes_only_unknown_model_directories() {
        let paths = temp_paths("gc");
        let known = paths.models_root.join(SPEC_JA.dir_name);
        let stale = paths.models_root.join("retired-model");
        std::fs::create_dir_all(&known).unwrap();
        std::fs::create_dir_all(&stale).unwrap();
        gc_stale_model_dirs(&paths);
        assert!(known.exists());
        assert!(!stale.exists());
        let _ = std::fs::remove_dir_all(paths.models_root.parent().unwrap());
    }
}
