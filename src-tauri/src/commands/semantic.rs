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

use tauri::Manager;

use crate::semantic::embedding::{Embedder, EMBEDDING_DIM_RURI_V3_30M, MODEL_ID_RURI_V3_30M};
use crate::semantic::index::{index_scene, UpsertOutcome};
use crate::semantic::search::{run_search, SearchCache, SearchHit};

use super::{with_db, AppError, WorkspaceState};

/// `lib.rs::setup` で `app.manage(...)` する Tauri 共有 state。
///
/// `inner` は `Mutex<Option<Embedder>>`。初回 invoke 時のみ ONNX 推論セッションを
/// 構築して `Some(...)` を入れる。以降は同じセッションを使い回す。
pub(crate) struct SemanticEmbedderState {
    pub(crate) inner: Mutex<Option<Embedder>>,
}

/// 同梱モデルディレクトリ。MVP は dev 経路のみ対応するため
/// `CARGO_MANIFEST_DIR/resources/semantic/ruri-v3-30m` を直指す。
/// production bundling は Step 10 のフロント統合時に
/// `tauri.conf.json#bundle.resources` で行う。
fn resolve_ruri_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/semantic/ruri-v3-30m")
}

/// `scene_chunks.model_id` 列に書く識別子。
/// モデル変更時の stale 判定 (§3.4) に使うため曖昧な名前にしない。
fn current_model_id() -> String {
    format!("{}@local/model_int8.onnx/prefix-v1", MODEL_ID_RURI_V3_30M)
}

/// model_int8.onnx + tokenizer.json から Embedder を構築。
/// model 不在の dev 環境ではここで Err を返し、コマンドはエラー文字列を返却する。
fn load_embedder() -> anyhow::Result<Embedder> {
    let dir = resolve_ruri_dir();
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
            *guard = Some(load_embedder()?);
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
                *guard = Some(load_embedder()?);
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
