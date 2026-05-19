//! 本文セマンティック検索の Tauri command 入口 (Step 6 & 7)。
//!
//! 設計: temp/semantic-prose-search-context.md §3.5。
//!
//! `semantic-embedding` feature 内でのみ build される。`--no-default-features`
//! ビルドでは `commands/mod.rs` の `mod semantic;` ごと cfg gate される。
//!
//! ## なぜ AppHandle を受け取るか
//! `tauri::async_runtime::spawn_blocking` の closure は `Send + 'static` を要求するが、
//! `tauri::State<'_, T>` は短い lifetime を持つため直接渡せない。`AppHandle` は
//! `Clone + Send + 'static` なので closure に move でき、内部で `app.state::<T>()`
//! で取り直せる。
//!
//! ## ロック戦略
//! - Embedder State: `std::sync::Mutex<Option<Embedder>>` (tokio mutex は spawn_blocking
//!   内で block_on アンチパターンになるため不採用)。
//! - 初回 invoke 時に lazy load → `Some(...)` を書き戻し、以後の invoke でも使い回す。
//! - 同じスレッドで embedder lock を取った状態で `with_db` を呼ぶため、embedder lock
//!   と workspace lock の取得順は常に「embedder → workspace」で固定。他コマンドは
//!   embedder に触らないため deadlock は発生しない。

#![cfg(feature = "semantic-embedding")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::semantic::embedding::{Embedder, EMBEDDING_DIM_RURI_V3_30M, MODEL_ID_RURI_V3_30M};
use crate::semantic::index::{
    collect_index_status, index_scene, list_scene_ids_in_project, IndexStatusReport, UpsertOutcome,
};
use crate::semantic::search::{run_search, SearchCache, SearchHit};

use super::{with_db, AppError, WorkspaceState};

/// `semantic:reindex_progress` event の payload。frontend で
/// `useReindexProgressListener` が listen し、Toast 表示に使う。
///
/// - `scene_index`: 完了した scene の累積数 (0..=total_scenes)。
/// - `scene_id`: 直近完了 (または開始) した scene の id (情報用)。
/// - `total_scenes`: 対象 scene 総数 (ループ開始時に確定)。
/// - `chunks_indexed`: 直近完了までに投入した chunk の累積数。
/// - `done`: 全 scene 完了で true。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SemanticReindexProgress {
    scene_index: usize,
    scene_id: String,
    total_scenes: usize,
    chunks_indexed: usize,
    done: bool,
}

const REINDEX_PROGRESS_EVENT: &str = "semantic:reindex_progress";

/// `lib.rs::setup` で `app.manage(...)` する Tauri 共有 state。
///
/// `inner` は `Mutex<Option<Embedder>>`。初回 invoke 時のみ ONNX 推論セッションを
/// 構築して `Some(...)` を入れる。以降は同じセッションを使い回す。
pub(crate) struct SemanticEmbedderState {
    pub(crate) inner: Mutex<Option<Embedder>>,
}

/// 同梱モデルディレクトリを解決する。
///
/// 探索順:
/// 1. `app.path().resource_dir()` 配下 (`tauri.conf.json#bundle.resources` で
///    同梱したファイルの置き場)。tauri build で installer に同梱され、
///    tauri dev 経由でも target/debug/ にコピーされる。
/// 2. それが見つからない場合は `CARGO_MANIFEST_DIR/resources/semantic/ruri-v3-30m`
///    にフォールバック (cargo test や非 Tauri 経路の救済)。
///
/// model_int8.onnx の存在で判定する: resource_dir に空のディレクトリだけある
/// 過渡的な状態でも、CARGO_MANIFEST_DIR にフォールバックする。
fn resolve_ruri_dir(app: &tauri::AppHandle) -> PathBuf {
    let rel = Path::new("resources/semantic/ruri-v3-30m");
    if let Ok(base) = app.path().resource_dir() {
        let candidate = base.join(rel);
        if candidate.join("model_int8.onnx").exists() {
            return candidate;
        }
    }
    // dev / test の安全網。
    Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
}

/// `scene_chunks.model_id` 列に書く識別子。
/// モデル変更時の stale 判定 (§3.4) に使うため曖昧な名前にしない。
fn current_model_id() -> String {
    format!("{}@local/model_int8.onnx/prefix-v1", MODEL_ID_RURI_V3_30M)
}

/// model_int8.onnx + tokenizer.json から Embedder を構築。
/// model 不在の dev 環境ではここで Err を返し、コマンドはエラー文字列を返却する。
fn load_embedder(app: &tauri::AppHandle) -> anyhow::Result<Embedder> {
    let dir = resolve_ruri_dir(app);
    let model_path = dir.join("model_int8.onnx");
    let tokenizer_path = dir.join("tokenizer.json");
    Embedder::load(&model_path, &tokenizer_path, EMBEDDING_DIM_RURI_V3_30M)
}

/// シーン 1 件をインデックス再構築する。
///
/// 戻り値: 挿入したチャンク数。古い content_hash で破棄された場合や
/// 非シーンノード/存在しないIDの場合は `0`。
///
/// upsert 成功時は `SearchCache` の該当 scene を invalidate して、
/// 次回 `semantic_search` で新しい chunks が読まれるようにする。
#[tauri::command]
pub(crate) async fn semantic_index_scene(
    app: tauri::AppHandle,
    scene_id: String,
) -> Result<usize, AppError> {
    let model_id = current_model_id();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<usize, AppError> {
        let ws_state = app.state::<WorkspaceState>();
        let emb_state = app.state::<SemanticEmbedderState>();
        let cache = app.state::<SearchCache>();

        // Embedder lazy load (初回のみコスト)。
        let mut guard = emb_state
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("embedder lock poisoned: {e}"))?;
        if guard.is_none() {
            *guard = Some(load_embedder(&app)?);
        }
        let embedder = guard.as_mut().expect("just ensured Some");

        let outcome = with_db(&ws_state, |db| {
            index_scene(db, embedder, &scene_id, &model_id)
        })?;

        // Indexed のときだけ cache を捨てる。Skipped* は DB を触っていないので
        // 既存キャッシュは有効。
        let n = match outcome {
            UpsertOutcome::Indexed(n) => {
                cache.invalidate(&scene_id)?;
                n
            }
            UpsertOutcome::SkippedHashMismatch | UpsertOutcome::SkippedNotScene => 0,
        };
        Ok(n)
    })
    .await
    .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?;
    result
}

/// 本文セマンティック検索。
///
/// クエリ文字列を Embedder で埋め込み、`scene_chunks` 全体 (または `scene_scope`
/// 指定時は単一 scene 内) に対して総当たりコサイン → Top-K を返す。
/// `description_mode=true` のとき、`dialogue_ratio > 0.6` のチャンクのスコアを
/// 0.85 倍に減点する。
#[tauri::command]
pub(crate) async fn semantic_search(
    app: tauri::AppHandle,
    project_id: String,
    query: String,
    limit: usize,
    scene_scope: Option<String>,
    description_mode: Option<bool>,
) -> Result<Vec<SearchHit>, AppError> {
    let model_id = current_model_id();
    let description_mode = description_mode.unwrap_or(false);
    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SearchHit>, AppError> {
            let ws_state = app.state::<WorkspaceState>();
            let emb_state = app.state::<SemanticEmbedderState>();
            let cache = app.state::<SearchCache>();

            // Embedder lazy load + クエリ埋め込み。検索クエリ prefix は embed_query
            // 側で付与される (semantic/embedding.rs::QUERY_PREFIX)。
            let mut guard = emb_state
                .inner
                .lock()
                .map_err(|e| anyhow::anyhow!("embedder lock poisoned: {e}"))?;
            if guard.is_none() {
                *guard = Some(load_embedder(&app)?);
            }
            let embedder = guard.as_mut().expect("just ensured Some");
            let query_embedding = embedder.embed_query(&query)?;
            let embedding_dim = embedder.embedding_dim();
            // Embedder を握り続ける必要は無いのでロック解放。スコアリング中に
            // 並行 invoke が embed できるようにする。
            drop(guard);

            let hits = with_db(&ws_state, |db| {
                run_search(
                    db,
                    &cache,
                    &query_embedding,
                    &project_id,
                    scene_scope.as_deref(),
                    limit,
                    description_mode,
                    &model_id,
                    embedding_dim,
                    crate::semantic::chunker::CHUNKER_VERSION,
                )
            })?;
            Ok(hits)
        })
        .await
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?;
    result
}

/// 指定 project の scene_chunks 状態を返す。
///
/// `current_*` は本コマンド側が握っている定数 (`current_model_id` /
/// `EMBEDDING_DIM_RURI_V3_30M` / `CHUNKER_VERSION`) と DB 上の値の差から
/// `stale_chunk_count` を算出する (§3.5)。Embedder のロードは不要。
#[tauri::command]
pub(crate) async fn semantic_index_status(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<IndexStatusReport, AppError> {
    let model_id = current_model_id();
    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<IndexStatusReport, AppError> {
            let ws_state = app.state::<WorkspaceState>();
            let report = with_db(&ws_state, |db| {
                collect_index_status(
                    db,
                    &project_id,
                    &model_id,
                    EMBEDDING_DIM_RURI_V3_30M,
                    crate::semantic::chunker::CHUNKER_VERSION,
                )
            })?;
            Ok(report)
        })
        .await
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?;
    result
}

/// project 配下の全 scene を再インデックスする。
///
/// 初回インデックス構築・モデル変更時・chunker_version 変更時の全再構築用 (§3.5)。
/// 各 scene について `index_scene` を順次呼び、戻り値はインデックスされた
/// 合計 chunk 数 (skipped 分は加算されない)。1 scene でも失敗すれば即座にエラーで
/// 中断する (MVP は強い整合性を優先)。
///
/// 成功した scene ごとに `SearchCache` の該当エントリを invalidate する。
#[tauri::command]
pub(crate) async fn semantic_reindex_all(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<usize, AppError> {
    let model_id = current_model_id();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<usize, AppError> {
        let ws_state = app.state::<WorkspaceState>();
        let emb_state = app.state::<SemanticEmbedderState>();
        let cache = app.state::<SearchCache>();

        // 対象 scene 一覧を先に確定 (途中の追加・削除に巻き込まれないため)
        let scene_ids: Vec<String> =
            with_db(&ws_state, |db| list_scene_ids_in_project(db, &project_id))?;
        let total_scenes = scene_ids.len();

        // Embedder lazy load。全 scene を 1 つの guard で回せばロックの取り直しが不要。
        let mut guard = emb_state
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("embedder lock poisoned: {e}"))?;
        if guard.is_none() {
            *guard = Some(load_embedder(&app)?);
        }
        let embedder = guard.as_mut().expect("just ensured Some");

        let mut total: usize = 0;
        for (i, scene_id) in scene_ids.iter().enumerate() {
            let outcome = with_db(&ws_state, |db| {
                index_scene(db, embedder, scene_id, &model_id)
            })?;
            if let UpsertOutcome::Indexed(n) = outcome {
                cache.invalidate(scene_id)?;
                total += n;
            }
            // 1 scene 完了ごとに progress を流す。emit 失敗 (event channel が無い等)
            // は再インデックス自体には影響しないので _ で握りつぶす。
            let _ = app.emit(
                REINDEX_PROGRESS_EVENT,
                SemanticReindexProgress {
                    scene_index: i + 1,
                    scene_id: scene_id.clone(),
                    total_scenes,
                    chunks_indexed: total,
                    done: i + 1 == total_scenes,
                },
            );
        }
        // total_scenes=0 のときは loop が回らず done event が出ないので別途送る。
        if total_scenes == 0 {
            let _ = app.emit(
                REINDEX_PROGRESS_EVENT,
                SemanticReindexProgress {
                    scene_index: 0,
                    scene_id: String::new(),
                    total_scenes: 0,
                    chunks_indexed: 0,
                    done: true,
                },
            );
        }
        Ok(total)
    })
    .await
    .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?;
    result
}
