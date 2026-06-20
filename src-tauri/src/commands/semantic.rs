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

use crate::semantic::chat_index::{
    collect_chat_index_status, embed_chat_text, list_message_ids_in_project,
    project_language_for_chat_message, read_chat_message_for_index, upsert_chat_chunk,
    ChatIndexStatus, ChatUpsertOutcome,
};
use crate::semantic::chat_search::{run_chat_search, ChatSearchCache, ChatSearchHit};
use crate::semantic::codex_index::{
    collect_codex_index_status, embed_codex_text, list_entry_ids_in_project,
    project_language_for_codex_entry, read_codex_for_index, upsert_codex_chunk, CodexIndexStatus,
    CodexUpsertOutcome,
};
use crate::semantic::codex_search::{run_codex_search, CodexSearchCache, CodexSearchHit};
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

/// Codex entry 1 件の埋め込みを再構築する (stage 3)。
///
/// scene の `index_scene_split_lock` と同型: 読み出し → embed → upsert を分割し、
/// workspace lock を ONNX 推論中に保持しない。推論中の entry 変更は upsert 側の
/// hash 再確認が race を吸収する。
fn codex_index_split_lock(
    ws_state: &tauri::State<'_, WorkspaceState>,
    embedder: &mut Embedder,
    entry_id: &str,
    model_id: &str,
    spec: &'static EmbeddingModelSpec,
) -> Result<CodexUpsertOutcome, AppError> {
    let Some((text, initial_hash)) = with_db(ws_state, |db| read_codex_for_index(db, entry_id))?
    else {
        return Ok(CodexUpsertOutcome::SkippedMissing);
    };
    // lock 外: 推論中も他コマンドの DB アクセスを止めない。
    let embedding = embed_codex_text(embedder, &text)?;
    let embedding_dim = embedder.embedding_dim();
    let outcome = with_db(ws_state, |db| {
        upsert_codex_chunk(
            db,
            entry_id,
            &initial_hash,
            &embedding,
            &text,
            model_id,
            embedding_dim,
            spec.chunker_version,
        )
    })?;
    Ok(outcome)
}

/// Codex entry 1 件をセマンティック index に投入/更新する。
///
/// 戻り値: 投入したベクトル数 (1)。entry 不在や古い hash で破棄された場合は 0。
/// 成功時は `CodexSearchCache` の該当 entry を invalidate する。
#[tauri::command]
pub(crate) async fn codex_index_entry(
    app: tauri::AppHandle,
    entry_id: String,
) -> Result<usize, AppError> {
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<usize, AppError> {
        let ws_state = app.state::<WorkspaceState>();
        let emb_state = app.state::<SemanticEmbedderState>();
        let cache = app.state::<CodexSearchCache>();

        let language = with_db(&ws_state, |db| {
            project_language_for_codex_entry(db, &entry_id)
        })?;
        let spec = spec_for_language(&language);
        let model_id = spec.full_model_id();

        let mut guard = emb_state
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("embedder lock poisoned: {e}"))?;
        let embedder = ensure_embedder(&app, spec, &mut guard)?;

        let outcome = codex_index_split_lock(&ws_state, embedder, &entry_id, &model_id, spec)?;

        let n = match outcome {
            CodexUpsertOutcome::Indexed(n) => {
                cache.invalidate(&entry_id)?;
                n
            }
            CodexUpsertOutcome::SkippedHashMismatch | CodexUpsertOutcome::SkippedMissing => 0,
        };
        Ok(n)
    })
    .await
    .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?;
    result
}

/// Codex セマンティック検索 (stage 3)。クエリを埋め込み、project 配下の
/// codex_chunks に総当たりコサイン → Top-K。JS 側 `search_codex` が sparse(FTS)
/// と RRF 融合する dense arm。
#[tauri::command]
pub(crate) async fn codex_semantic_search(
    app: tauri::AppHandle,
    project_id: String,
    query: String,
    limit: usize,
) -> Result<Vec<CodexSearchHit>, AppError> {
    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<CodexSearchHit>, AppError> {
            let ws_state = app.state::<WorkspaceState>();
            let emb_state = app.state::<SemanticEmbedderState>();
            let cache = app.state::<CodexSearchCache>();

            let language = with_db(&ws_state, |db| project_language(db, &project_id))?;
            let spec = spec_for_language(&language);
            let model_id = spec.full_model_id();

            let mut guard = emb_state
                .inner
                .lock()
                .map_err(|e| anyhow::anyhow!("embedder lock poisoned: {e}"))?;
            let embedder = ensure_embedder(&app, spec, &mut guard)?;
            let query_embedding = embedder.embed_query(&query)?;
            let embedding_dim = embedder.embedding_dim();
            drop(guard);

            let hits = with_db(&ws_state, |db| {
                run_codex_search(
                    db,
                    &cache,
                    &query_embedding,
                    &project_id,
                    limit,
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

/// Codex の index 充足状況 (段階3c)。Embedder 不要の cheap クエリ。JS 側が
/// `indexedEntryCount < totalEntryCount` を見て bulk back-index の要否を判定する。
#[tauri::command]
pub(crate) async fn codex_index_status(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<CodexIndexStatus, AppError> {
    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<CodexIndexStatus, AppError> {
            let ws_state = app.state::<WorkspaceState>();
            let report = with_db(&ws_state, |db| {
                let language = project_language(db, &project_id)?;
                let spec = spec_for_language(&language);
                collect_codex_index_status(
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

/// project 配下の全 codex entry を一括再 index する (段階3c bulk back-index)。
///
/// `semantic_reindex_all` の codex 版。既存エントリ (機能追加前 / 未編集) は逐次
/// index (`codex_index_entry`) が走らず未 index のままなので、初回構築用に全件回す。
/// Embedder を 1 度 load し各 entry を `codex_index_split_lock` で index、成功ごとに
/// `CodexSearchCache` を invalidate、投入ベクトル総数を返す。codex は件数が少なく
/// 短時間なので scene と違い progress event は出さない。
#[tauri::command]
pub(crate) async fn codex_reindex_all(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<usize, AppError> {
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<usize, AppError> {
        let ws_state = app.state::<WorkspaceState>();
        let emb_state = app.state::<SemanticEmbedderState>();
        let cache = app.state::<CodexSearchCache>();

        let language = with_db(&ws_state, |db| project_language(db, &project_id))?;
        let spec = spec_for_language(&language);
        let model_id = spec.full_model_id();
        let entry_ids: Vec<String> =
            with_db(&ws_state, |db| list_entry_ids_in_project(db, &project_id))?;

        // Embedder lazy load。全 entry を 1 guard で回し lock 取り直しを避ける。
        let mut guard = emb_state
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("embedder lock poisoned: {e}"))?;
        let embedder = ensure_embedder(&app, spec, &mut guard)?;

        let mut total: usize = 0;
        for entry_id in &entry_ids {
            // entry ごとに lock 分割版を使い、embed 中に workspace lock を持たない。
            let outcome = codex_index_split_lock(&ws_state, embedder, entry_id, &model_id, spec)?;
            if let CodexUpsertOutcome::Indexed(n) = outcome {
                cache.invalidate(entry_id)?;
                total += n;
            }
        }
        Ok(total)
    })
    .await
    .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?;
    result
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat episodic recall (エピソード記憶) — codex 経路と同型
// ─────────────────────────────────────────────────────────────────────────────

/// 1 メッセージの index 更新を「読み出し → embed → upsert」に分割し、ONNX 推論中に
/// workspace lock を持たない版 (codex_index_split_lock と同型)。
fn chat_index_split_lock(
    ws_state: &tauri::State<'_, WorkspaceState>,
    embedder: &mut Embedder,
    message_id: &str,
    model_id: &str,
    spec: &'static EmbeddingModelSpec,
) -> Result<ChatUpsertOutcome, AppError> {
    let Some(input) = with_db(ws_state, |db| read_chat_message_for_index(db, message_id))? else {
        return Ok(ChatUpsertOutcome::SkippedMissing);
    };
    // lock 外: 推論中も他コマンドの DB アクセスを止めない。
    let embedding = embed_chat_text(embedder, &input.text)?;
    let embedding_dim = embedder.embedding_dim();
    let outcome = with_db(ws_state, |db| {
        upsert_chat_chunk(
            db,
            message_id,
            &input.hash,
            &embedding,
            &input.text,
            model_id,
            embedding_dim,
            spec.chunker_version,
        )
    })?;
    Ok(outcome)
}

/// チャットメッセージ 1 件を episodic index に投入/更新する。
///
/// 戻り値: 投入したベクトル数 (1)。不在 / index 対象外 (system・空本文) / 古い hash で
/// 破棄された場合は 0。成功時は `ChatSearchCache` の該当メッセージを invalidate する。
/// addMessage (確定 1 回) と updateMessageMetadata (信号変化 → weight 列更新) から
/// デバウンス経由で呼ばれる。
#[tauri::command]
pub(crate) async fn chat_index_message(
    app: tauri::AppHandle,
    message_id: String,
) -> Result<usize, AppError> {
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<usize, AppError> {
        let ws_state = app.state::<WorkspaceState>();
        let emb_state = app.state::<SemanticEmbedderState>();
        let cache = app.state::<ChatSearchCache>();

        // 安価な事前 read: index 対象外 (system / 空本文 / 不在) なら ONNX を load せず即 0。
        // updateMessageMetadata は非対象メッセージにも呼ばれ得るので embedder load を省く。
        if with_db(&ws_state, |db| read_chat_message_for_index(db, &message_id))?.is_none() {
            return Ok(0);
        }

        let language = with_db(&ws_state, |db| {
            project_language_for_chat_message(db, &message_id)
        })?;
        let spec = spec_for_language(&language);
        let model_id = spec.full_model_id();

        let mut guard = emb_state
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("embedder lock poisoned: {e}"))?;
        let embedder = ensure_embedder(&app, spec, &mut guard)?;

        let outcome = chat_index_split_lock(&ws_state, embedder, &message_id, &model_id, spec)?;

        let n = match outcome {
            ChatUpsertOutcome::Indexed(n) => {
                cache.invalidate(&message_id)?;
                n
            }
            ChatUpsertOutcome::SkippedHashMismatch | ChatUpsertOutcome::SkippedMissing => 0,
        };
        Ok(n)
    })
    .await
    .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?;
    result
}

/// Chat episodic dense 検索。クエリを埋め込み、project 配下の chat_message_chunks に
/// 総当たりコサイン → Top-K。生 cosine + 信号を返す (重み付けは JS chatRecall)。
#[tauri::command]
pub(crate) async fn chat_message_search(
    app: tauri::AppHandle,
    project_id: String,
    query: String,
    limit: usize,
) -> Result<Vec<ChatSearchHit>, AppError> {
    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<ChatSearchHit>, AppError> {
            let ws_state = app.state::<WorkspaceState>();
            let emb_state = app.state::<SemanticEmbedderState>();
            let cache = app.state::<ChatSearchCache>();

            let language = with_db(&ws_state, |db| project_language(db, &project_id))?;
            let spec = spec_for_language(&language);
            let model_id = spec.full_model_id();

            let mut guard = emb_state
                .inner
                .lock()
                .map_err(|e| anyhow::anyhow!("embedder lock poisoned: {e}"))?;
            let embedder = ensure_embedder(&app, spec, &mut guard)?;
            let query_embedding = embedder.embed_query(&query)?;
            let embedding_dim = embedder.embedding_dim();
            drop(guard);

            let hits = with_db(&ws_state, |db| {
                run_chat_search(
                    db,
                    &cache,
                    &query_embedding,
                    &project_id,
                    limit,
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

/// chat episodic index の充足状況。Embedder 不要の cheap クエリ。JS 側が
/// `indexedMessageCount < totalMessageCount` を見て bulk back-index の要否を判定する。
#[tauri::command]
pub(crate) async fn chat_index_status(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<ChatIndexStatus, AppError> {
    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<ChatIndexStatus, AppError> {
            let ws_state = app.state::<WorkspaceState>();
            let report = with_db(&ws_state, |db| {
                let language = project_language(db, &project_id)?;
                let spec = spec_for_language(&language);
                collect_chat_index_status(
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

/// project 配下の全 index 対象メッセージを一括再 index する (初回構築 / bulk back-index)。
/// `codex_reindex_all` の chat 版。Embedder を 1 度 load し各メッセージを
/// `chat_index_split_lock` で index、成功ごとに `ChatSearchCache` を invalidate、
/// 投入ベクトル総数を返す。
#[tauri::command]
pub(crate) async fn chat_reindex_all(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<usize, AppError> {
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<usize, AppError> {
        let ws_state = app.state::<WorkspaceState>();
        let emb_state = app.state::<SemanticEmbedderState>();
        let cache = app.state::<ChatSearchCache>();

        let language = with_db(&ws_state, |db| project_language(db, &project_id))?;
        let spec = spec_for_language(&language);
        let model_id = spec.full_model_id();
        let message_ids: Vec<String> =
            with_db(&ws_state, |db| list_message_ids_in_project(db, &project_id))?;

        let mut guard = emb_state
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("embedder lock poisoned: {e}"))?;
        let embedder = ensure_embedder(&app, spec, &mut guard)?;

        let mut total: usize = 0;
        for message_id in &message_ids {
            let outcome = chat_index_split_lock(&ws_state, embedder, message_id, &model_id, spec)?;
            if let ChatUpsertOutcome::Indexed(n) = outcome {
                cache.invalidate(message_id)?;
                total += n;
            }
        }
        Ok(total)
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

/// `semantic_debug_dump` が返す 1 chunk 分の検査用メタデータ。
///
/// 埋め込みベクトルそのものは返さず、L2 ノルム (正規化済みなら ≈1.0) と
/// 寸法・モデル・chunker・content_hash・本文プレビューだけを返す。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DebugChunkRow {
    scene_id: String,
    scene_title: String,
    chunk_index: i64,
    char_start: i64,
    char_end: i64,
    dialogue_ratio: f64,
    text_preview: String,
    model_id: String,
    embedding_dim: i64,
    chunker_version: String,
    content_hash: String,
    /// 格納された f32 ベクトルの L2 ノルム。正規化済みなら ≈1.0。
    embedding_norm: f64,
    /// 現在の spec (project language 由来) と model/dim/chunker が食い違うなら true。
    is_stale: bool,
}

/// `semantic_debug_dump` のレスポンス全体。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DebugDumpReport {
    project_id: String,
    language: String,
    current_model_id: String,
    current_embedding_dim: usize,
    current_chunker_version: String,
    total_chunks: usize,
    returned_chunks: usize,
    chunks: Vec<DebugChunkRow>,
}

/// 開発者向け: 指定 project (任意で 1 scene) の `scene_chunks` を検査用にダンプする。
///
/// セマンティック検索のデバッグ用。「何が・どのモデルで index されたか」
/// (chunk 本文・文字範囲・dialogue_ratio・model_id・embedding_dim・
/// chunker_version・content_hash・埋め込み L2 ノルム・stale 判定) を一覧で返す。
/// Embedder のロードは不要で、DB 読み出しのみ。`scene_id=None` で project 全体、
/// `limit` 省略時は 200 件 (上限 2000) を返す。
#[tauri::command]
pub(crate) async fn semantic_debug_dump(
    app: tauri::AppHandle,
    project_id: String,
    scene_id: Option<String>,
    limit: Option<usize>,
) -> Result<DebugDumpReport, AppError> {
    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<DebugDumpReport, AppError> {
            let cap = limit.unwrap_or(200).min(2000);
            let ws_state = app.state::<WorkspaceState>();
            with_db(&ws_state, |db| {
                let language = project_language(db, &project_id)?;
                let spec = spec_for_language(&language);
                let current_model_id = spec.full_model_id();

                db.with_conn(|conn| {
                    let total_chunks: usize = conn
                        .query_row(
                            "SELECT COUNT(*) FROM scene_chunks sc \
                         JOIN tree_nodes tn ON tn.id = sc.scene_id \
                         WHERE tn.project_id = ?1 \
                           AND (?2 IS NULL OR sc.scene_id = ?2)",
                            rusqlite::params![project_id, scene_id],
                            |row| row.get::<_, i64>(0),
                        )
                        .unwrap_or(0) as usize;

                    let mut stmt = conn.prepare(
                        "SELECT sc.scene_id, COALESCE(tn.title, ''), sc.chunk_index, \
                            sc.char_start, sc.char_end, sc.dialogue_ratio, sc.text, \
                            sc.model_id, sc.embedding_dim, sc.chunker_version, \
                            sc.content_hash, sc.embedding \
                     FROM scene_chunks sc \
                     JOIN tree_nodes tn ON tn.id = sc.scene_id \
                     WHERE tn.project_id = ?1 \
                       AND (?2 IS NULL OR sc.scene_id = ?2) \
                     ORDER BY sc.scene_id, sc.chunk_index \
                     LIMIT ?3",
                    )?;

                    let rows = stmt.query_map(
                        rusqlite::params![project_id, scene_id, cap as i64],
                        |row| {
                            let text: String = row.get(6)?;
                            let model_id: String = row.get(7)?;
                            let embedding_dim: i64 = row.get(8)?;
                            let chunker_version: String = row.get(9)?;
                            let blob: Vec<u8> = row.get(11)?;
                            let norm = l2_norm_of_f32_le(&blob);
                            let is_stale = model_id != current_model_id
                                || embedding_dim != spec.embedding_dim as i64
                                || chunker_version != spec.chunker_version;
                            Ok(DebugChunkRow {
                                scene_id: row.get(0)?,
                                scene_title: row.get(1)?,
                                chunk_index: row.get(2)?,
                                char_start: row.get(3)?,
                                char_end: row.get(4)?,
                                dialogue_ratio: row.get(5)?,
                                text_preview: text.chars().take(140).collect(),
                                model_id,
                                embedding_dim,
                                chunker_version,
                                content_hash: row.get(10)?,
                                embedding_norm: norm,
                                is_stale,
                            })
                        },
                    )?;
                    let chunks: Vec<DebugChunkRow> = rows.collect::<rusqlite::Result<_>>()?;

                    Ok(DebugDumpReport {
                        project_id: project_id.clone(),
                        language: language.clone(),
                        current_model_id: current_model_id.clone(),
                        current_embedding_dim: spec.embedding_dim,
                        current_chunker_version: spec.chunker_version.to_string(),
                        total_chunks,
                        returned_chunks: chunks.len(),
                        chunks,
                    })
                })
            })
        })
        .await
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?;
    result
}

/// little-endian f32 でパックされた埋め込み BLOB の L2 ノルムを計算する。
/// 長さが 4 の倍数でなければ末尾の端数は無視する。
fn l2_norm_of_f32_le(blob: &[u8]) -> f64 {
    let mut sum = 0.0f64;
    for chunk in blob.chunks_exact(4) {
        let v = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as f64;
        sum += v * v;
    }
    sum.sqrt()
}
