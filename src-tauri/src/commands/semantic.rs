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

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::semantic::embedding::Embedder;
use crate::semantic::index::{
    collect_index_status, embed_scene_payloads, list_scene_ids_in_project, project_language,
    project_language_for_scene, read_scene_for_index, upsert_scene_chunks, IndexStatusReport,
    UpsertOutcome,
};
use crate::semantic::search::{run_search, SearchCache, SearchHit};
use crate::semantic::spec::{spec_for_language, EmbeddingModelSpec};

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
    /// dir_name (= spec.dir_name) ごとに Embedder を保持。ja/en プロジェクトを
    /// 同一セッションで交互に使ってもそれぞれのモデルを使い回せる。
    pub(crate) inner: Mutex<HashMap<&'static str, Embedder>>,
}

/// spec に対応する同梱モデルディレクトリを解決する。
///
/// 探索順:
/// 1. `app.path().resource_dir()/resources/semantic/{spec.dir_name}` (bundle 同梱)。
/// 2. 見つからなければ `CARGO_MANIFEST_DIR/resources/semantic/{spec.dir_name}`
///    にフォールバック (cargo test や非 Tauri 経路の救済)。
///
/// model_int8.onnx の存在で判定する。
fn resolve_model_dir(app: &tauri::AppHandle, spec: &EmbeddingModelSpec) -> PathBuf {
    let rel = PathBuf::from("resources/semantic").join(spec.dir_name);
    if let Ok(base) = app.path().resource_dir() {
        let candidate = base.join(&rel);
        if candidate.join("model_int8.onnx").exists() {
            return candidate;
        }
    }
    // dev / test の安全網。
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

/// model_int8.onnx + tokenizer.json から spec のモデルを構築。
/// model 不在の dev 環境ではここで Err を返し、コマンドはエラー文字列を返却する。
fn load_embedder(
    app: &tauri::AppHandle,
    spec: &'static EmbeddingModelSpec,
) -> anyhow::Result<Embedder> {
    let dir = resolve_model_dir(app, spec);
    let model_path = dir.join("model_int8.onnx");
    let tokenizer_path = dir.join("tokenizer.json");
    Embedder::load(&model_path, &tokenizer_path, spec)
}

/// spec の Embedder を HashMap から取り出す (無ければ lazy load して挿入)。
fn ensure_embedder<'a>(
    app: &tauri::AppHandle,
    spec: &'static EmbeddingModelSpec,
    guard: &'a mut HashMap<&'static str, Embedder>,
) -> Result<&'a mut Embedder, AppError> {
    if !guard.contains_key(spec.dir_name) {
        let e = load_embedder(app, spec)?;
        guard.insert(spec.dir_name, e);
    }
    Ok(guard
        .get_mut(spec.dir_name)
        .expect("embedder just inserted"))
}

/// シーン 1 件をインデックス再構築する。
///
/// 戻り値: 挿入したチャンク数。古い content_hash で破棄された場合や
/// 非シーンノード/存在しないIDの場合は `0`。
///
/// upsert 成功時は `SearchCache` の該当 scene を invalidate して、
/// 次回 `semantic_search` で新しい chunks が読まれるようにする。
/// 1 scene のインデックス更新を「読み出し → embed → upsert」に分割し、
/// workspace lock (with_db) を読み出しと upsert の間だけ保持する版。
/// `semantic::index::index_scene` の合成と同じ結果になるが、ONNX 推論中に
/// lock を持たない点だけが違う (semantic-index-db-lock 対策)。
fn index_scene_split_lock(
    ws_state: &tauri::State<'_, WorkspaceState>,
    embedder: &mut Embedder,
    scene_id: &str,
    model_id: &str,
    spec: &'static EmbeddingModelSpec,
) -> Result<UpsertOutcome, AppError> {
    let Some((content, initial_hash)) = with_db(ws_state, |db| read_scene_for_index(db, scene_id))?
    else {
        return Ok(UpsertOutcome::SkippedNotScene);
    };
    // ここは lock 外: 推論中も他コマンドの DB アクセスを止めない
    let payloads = embed_scene_payloads(embedder, scene_id, &content, spec)?;
    let embedding_dim = embedder.embedding_dim();
    let outcome = with_db(ws_state, |db| {
        upsert_scene_chunks(
            db,
            scene_id,
            &initial_hash,
            &payloads,
            model_id,
            embedding_dim,
            spec.chunker_version,
        )
    })?;
    Ok(outcome)
}

#[tauri::command]
pub(crate) async fn semantic_index_scene(
    app: tauri::AppHandle,
    scene_id: String,
) -> Result<usize, AppError> {
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<usize, AppError> {
        let ws_state = app.state::<WorkspaceState>();
        let emb_state = app.state::<SemanticEmbedderState>();
        let cache = app.state::<SearchCache>();

        // 言語 → spec を embedder lock 取得前に確定 (with_db は scoped に
        // workspace lock を取り即解放するので embedder→workspace の順序は保たれる)。
        let language = with_db(&ws_state, |db| project_language_for_scene(db, &scene_id))?;
        let spec = spec_for_language(&language);
        let model_id = spec.full_model_id();

        // Embedder lazy load (spec ごと・初回のみコスト)。
        let mut guard = emb_state
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("embedder lock poisoned: {e}"))?;
        let embedder = ensure_embedder(&app, spec, &mut guard)?;

        // workspace lock (with_db) は読み出しと upsert の間だけ保持する。
        // ONNX 推論 (embed) は scene あたり秒単位かかりうるため、lock を
        // 跨いで持つと並行する db_execute が 10s timeout する
        // (semantic-index-db-lock)。推論中の本文変更は upsert 側の
        // hash 再確認が race を吸収する。
        let outcome = index_scene_split_lock(&ws_state, embedder, &scene_id, &model_id, spec)?;

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
    let description_mode = description_mode.unwrap_or(false);
    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SearchHit>, AppError> {
            let ws_state = app.state::<WorkspaceState>();
            let emb_state = app.state::<SemanticEmbedderState>();
            let cache = app.state::<SearchCache>();

            // 言語 → spec を embedder lock 前に確定。
            let language = with_db(&ws_state, |db| project_language(db, &project_id))?;
            let spec = spec_for_language(&language);
            let model_id = spec.full_model_id();

            // Embedder lazy load + クエリ埋め込み。検索クエリ prefix は embed_query
            // 側で spec.query_prefix が付与される。
            let mut guard = emb_state
                .inner
                .lock()
                .map_err(|e| anyhow::anyhow!("embedder lock poisoned: {e}"))?;
            let embedder = ensure_embedder(&app, spec, &mut guard)?;
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
                    spec.chunker_version,
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
    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<IndexStatusReport, AppError> {
            let ws_state = app.state::<WorkspaceState>();
            let report = with_db(&ws_state, |db| {
                let language = project_language(db, &project_id)?;
                let spec = spec_for_language(&language);
                collect_index_status(
                    db,
                    &project_id,
                    &spec.full_model_id(),
                    spec.embedding_dim,
                    spec.chunker_version,
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
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<usize, AppError> {
        let ws_state = app.state::<WorkspaceState>();
        let emb_state = app.state::<SemanticEmbedderState>();
        let cache = app.state::<SearchCache>();

        // 言語 → spec を確定 + 対象 scene 一覧を先に確定。
        let language = with_db(&ws_state, |db| project_language(db, &project_id))?;
        let spec = spec_for_language(&language);
        let model_id = spec.full_model_id();
        let scene_ids: Vec<String> =
            with_db(&ws_state, |db| list_scene_ids_in_project(db, &project_id))?;
        let total_scenes = scene_ids.len();

        // Embedder lazy load。全 scene を 1 つの guard で回せばロックの取り直しが不要。
        let mut guard = emb_state
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("embedder lock poisoned: {e}"))?;
        let embedder = ensure_embedder(&app, spec, &mut guard)?;

        let mut total: usize = 0;
        for (i, scene_id) in scene_ids.iter().enumerate() {
            // scene ごとに lock 分割版を使う: embed 中に workspace lock を
            // 持たないので、全件再構築の最中でも autosave 等の db_execute が
            // 各 scene の読み出し/upsert の隙間で通る。
            let outcome = index_scene_split_lock(&ws_state, embedder, scene_id, &model_id, spec)?;
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

/// Semantic hit のチャンク前後文脈を返す (専用ビューの hover プレビュー用)。
/// 切り出しの純ロジックは `crate::semantic::preview::slice_context` に分離。
#[tauri::command]
pub(crate) async fn semantic_chunk_context(
    app: tauri::AppHandle,
    scene_id: String,
    char_start: usize,
    char_end: usize,
    padding: usize,
) -> Result<crate::semantic::preview::PreviewContext, AppError> {
    use crate::semantic::preview::{slice_context_verified, PreviewContext};
    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<PreviewContext, AppError> {
            let ws_state = app.state::<WorkspaceState>();
            with_db(&ws_state, |db| {
                let row: Option<(String, String)> = db.with_conn(|conn| {
                    let v = conn
                        .query_row(
                            "SELECT content, title FROM tree_nodes \
                         WHERE id = ? AND node_type = 'scene'",
                            rusqlite::params![scene_id],
                            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                        )
                        .ok();
                    Ok(v)
                })?;

                // index 時のチャンク本文。本文が再 index 前に編集されていると
                // char offset がズレるため、照合・探し直しに使う。
                let indexed_chunk: Option<String> = db.with_conn(|conn| {
                    let v = conn
                        .query_row(
                            "SELECT text FROM scene_chunks \
                         WHERE scene_id = ? AND char_start = ? AND char_end = ?",
                            rusqlite::params![scene_id, char_start as i64, char_end as i64],
                            |row| row.get::<_, String>(0),
                        )
                        .ok();
                    Ok(v)
                })?;

                let (content_json, scene_title) = match row {
                    Some(t) => t,
                    None => {
                        return Ok(PreviewContext {
                            before: String::new(),
                            chunk: String::new(),
                            after: String::new(),
                            scene_title: String::new(),
                        })
                    }
                };

                let doc: serde_json::Value = serde_json::from_str(&content_json)
                    .map_err(|e| anyhow::anyhow!("scene content JSON parse error: {e}"))?;
                let paragraphs = crate::semantic::chunker::extract_paragraph_texts(&doc);
                let plain_text = paragraphs.join("\n");

                Ok(slice_context_verified(
                    &plain_text,
                    char_start,
                    char_end,
                    padding,
                    scene_title,
                    indexed_chunk.as_deref(),
                ))
            })
        })
        .await
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?;
    result
}
