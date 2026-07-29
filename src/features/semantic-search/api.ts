import { invoke } from "@/lib/tauri";

/**
 * 本文セマンティック検索の Rust ↔ JS ブリッジ。
 * Rust 側コマンドは `src-tauri/src/commands/semantic.rs` に実装 (Step 6-8)。
 * 型は Rust 側の `SearchHit` / `IndexStatusReport` (serde camelCase) と一致させること。
 */

export interface SemanticSearchHit {
  sceneId: string;
  sceneTitle: string;
  chunkText: string;
  charStart: number;
  charEnd: number;
  score: number;
  dialogueRatio: number;
}

export interface SemanticIndexStatus {
  indexedChunkCount: number;
  staleChunkCount: number;
  indexedSceneCount: number;
  /**
   * 本文が現行チャンカで 1 つ以上 chunk を生む (= index に載りうる) scene 数。
   * 空 scene は chunk を生まず indexedSceneCount に載らないため、充足判定の分母は
   * total scene 数ではなくこの値を使う (空 scene での恒真化 → open ごとの無駄な
   * 再インデックスを防ぐ)。Rust `IndexStatusReport.nonemptySceneCount` と一致。
   */
  nonemptySceneCount: number;
  currentModelId: string;
  currentEmbeddingDim: number;
  currentChunkerVersion: string;
}

/**
 * 実行中の再構築可能な semantic index 処理を協調停止する。
 * 戻り値は切り替え後の runtime epoch。文書の正本データは変更しない。
 */
export function semanticCancelBackground(): Promise<number> {
  return invoke<number>("semantic_cancel_background", {});
}

/** シーン 1 件をインデックス再構築。戻り値は投入チャンク数 (0 = race/非 scene)。 */
export function semanticIndexScene(sceneId: string): Promise<number> {
  return invoke<number>("semantic_index_scene", { sceneId });
}

/**
 * 本文セマンティック検索。
 * - `query` は「検索クエリ: 」prefix を Rust 側で自動付与するので生文字列を渡す。
 * - `sceneScope` 未指定時は project 全体を対象。
 * - `descriptionMode` true で会話文比率 >0.6 のチャンクのスコアを 0.85 倍に減点。
 */
export function semanticSearch(args: {
  projectId: string;
  query: string;
  limit: number;
  sceneScope?: string | null;
  descriptionMode?: boolean;
}): Promise<SemanticSearchHit[]> {
  return invoke<SemanticSearchHit[]>("semantic_search", {
    projectId: args.projectId,
    query: args.query,
    limit: args.limit,
    sceneScope: args.sceneScope ?? null,
    descriptionMode: args.descriptionMode ?? false,
  });
}

/**
 * project 内全 scene の再インデックス。戻り値は投入チャンク総数。
 * `runId` は progress event と呼び出し側を結びつける optional token。
 * 省略時は従来と同じ payload を送り、旧 Tauri backend との互換性を保つ。
 */
export function semanticReindexAll(
  projectId: string,
  runId?: string,
): Promise<number> {
  return invoke<number>("semantic_reindex_all", {
    projectId,
    ...(runId ? { runId } : {}),
  });
}

/**
 * 指定言語の埋め込みモデルが未インストールなら、バックグラウンド DL を開始する。
 * 即時に状態を返す: `"installed"`(DL 不要) / `"downloading"`(開始 or 進行中) /
 * `"unavailable"`(DL 元未設定)。DL 本体は Rust 側 spawn で走り、進捗は
 * `semantic:model_download_progress` イベント (useModelDownloadListener) で流れる
 * ため、この invoke 自体は即座に返る (IPC タイムアウト非該当)。
 */
export function downloadSemanticModel(language: string): Promise<string> {
  return invoke<string>("semantic_download_model", { language });
}

/**
 * Codex の dense セマンティック検索 (段階3 hybrid の dense arm)。
 * Rust 側 `codex_semantic_search` (semantic-embedding feature gate) を叩く。
 * 1 エントリ 1 ベクトル (name+aliases+summary+content を埋め込み)。score は cosine。
 * 型は Rust 側 `CodexSearchHit` (serde camelCase) と一致させること。
 */
export interface CodexSearchHit {
  entryId: string;
  entryName: string;
  entryType: string;
  summary: string;
  score: number;
}

export function codexSemanticSearch(args: {
  projectId: string;
  query: string;
  limit: number;
}): Promise<CodexSearchHit[]> {
  return invoke<CodexSearchHit[]>("codex_semantic_search", {
    projectId: args.projectId,
    query: args.query,
    limit: args.limit,
  });
}

/** Codex エントリ 1 件を index 再構築。戻り値は投入ベクトル数 (0 = race/欠落)。 */
export function codexIndexEntry(entryId: string): Promise<number> {
  return invoke<number>("codex_index_entry", { entryId });
}

/**
 * 段階3c: project 内の codex index 充足状況。Embedder ロード不要の軽量クエリ。
 * indexedEntryCount < totalEntryCount なら未 index の既存エントリがある
 * (= bulk back-index が必要)。型は Rust 側 `CodexIndexStatus` (camelCase) と一致。
 */
export interface CodexIndexStatus {
  indexedEntryCount: number;
  totalEntryCount: number;
}

export function codexIndexStatus(projectId: string): Promise<CodexIndexStatus> {
  return invoke<CodexIndexStatus>("codex_index_status", { projectId });
}

/** project 内の全 codex エントリを一括再 index。戻り値は投入ベクトル総数。 */
export function codexReindexAll(projectId: string): Promise<number> {
  return invoke<number>("codex_reindex_all", { projectId });
}

/**
 * Chronicle event の dense セマンティック検索 (作中年表 RAG, Phase 3)。
 * Rust 側 `events_semantic_search` (semantic-embedding feature gate) を叩く。
 * 1 出来事 1 ベクトル (title+note+主役名+場所名+参加者名 を埋め込み)。score は cosine。
 * dense のみ (FTS 融合なし)。型は Rust 側 `EventSearchHit` (serde camelCase) と一致。
 */
export interface EventSearchHit {
  eventId: string;
  title: string;
  kind: string;
  score: number;
}

export function eventsSemanticSearch(args: {
  projectId: string;
  query: string;
  limit: number;
}): Promise<EventSearchHit[]> {
  return invoke<EventSearchHit[]>("events_semantic_search", {
    projectId: args.projectId,
    query: args.query,
    limit: args.limit,
  });
}

/** Chronicle event 1 件を index 再構築。戻り値は投入ベクトル数 (0 = race/欠落)。 */
export function eventsIndexEntry(eventId: string): Promise<number> {
  return invoke<number>("events_index_entry", { eventId });
}

/**
 * Phase 3: project 内の event index 充足状況。Embedder ロード不要の軽量クエリ。
 * indexedEventCount < totalEventCount なら未 index の既存出来事がある
 * (= bulk back-index が必要)。型は Rust 側 `EventsIndexStatus` (camelCase) と一致。
 */
export interface EventsIndexStatus {
  indexedEventCount: number;
  totalEventCount: number;
}

export function eventsIndexStatus(
  projectId: string,
): Promise<EventsIndexStatus> {
  return invoke<EventsIndexStatus>("events_index_status", { projectId });
}

/** project 内の全 Chronicle event を一括再 index。戻り値は投入ベクトル総数。 */
export function eventsReindexAll(projectId: string): Promise<number> {
  return invoke<number>("events_reindex_all", { projectId });
}

/**
 * Chat episodic recall の dense 検索 (過去対話の意味検索)。Rust 側
 * `chat_message_search` を叩く。1 メッセージ 1 ベクトル。**生 cosine** を `score` に、
 * 重み付けの材料 (role / insertedToEditor / extractedCount) を併せて返す
 * (重み付け・gate は JS chatRecall に集約)。型は Rust 側 `ChatSearchHit`
 * (serde camelCase) と一致させること。
 */
export interface ChatMessageSearchHit {
  messageId: string;
  sessionId: string;
  role: string;
  text: string;
  insertedToEditor: boolean;
  extractedCount: number;
  score: number;
}

export function chatMessageSearch(args: {
  projectId: string;
  query: string;
  limit: number;
}): Promise<ChatMessageSearchHit[]> {
  return invoke<ChatMessageSearchHit[]>("chat_message_search", {
    projectId: args.projectId,
    query: args.query,
    limit: args.limit,
  });
}

/** チャットメッセージ 1 件を index 再構築。戻り値は投入ベクトル数 (0 = race/対象外)。 */
export function chatIndexMessage(messageId: string): Promise<number> {
  return invoke<number>("chat_index_message", { messageId });
}

/**
 * project 内の chat episodic index 充足状況。Embedder ロード不要の軽量クエリ。
 * indexedMessageCount < totalMessageCount なら未 index の既存メッセージがある
 * (= bulk back-index が必要)。型は Rust 側 `ChatIndexStatus` (camelCase) と一致。
 */
export interface ChatIndexStatus {
  indexedMessageCount: number;
  totalMessageCount: number;
}

export function chatIndexStatus(projectId: string): Promise<ChatIndexStatus> {
  return invoke<ChatIndexStatus>("chat_index_status", { projectId });
}

/** project 内の全 index 対象メッセージを一括再 index。戻り値は投入ベクトル総数。 */
export function chatReindexAll(projectId: string): Promise<number> {
  return invoke<number>("chat_reindex_all", { projectId });
}

/** 指定 project の scene_chunks 状態を取得。Embedder ロード不要、軽量。 */
export function semanticIndexStatus(
  projectId: string,
): Promise<SemanticIndexStatus> {
  return invoke<SemanticIndexStatus>("semantic_index_status", { projectId });
}

/**
 * Semantic ヒットの chunk 前後文脈を取得 (CommandCenter 専用ビューの hover プレビュー用)。
 * Rust 側で plain_text を `char_indices()` 1 パスで切り出す (`semantic/preview.rs`)。
 */
export interface SemanticChunkContext {
  before: string;
  chunk: string;
  after: string;
  sceneTitle: string;
}

export function getSemanticChunkContext(args: {
  sceneId: string;
  charStart: number;
  charEnd: number;
  padding: number;
}): Promise<SemanticChunkContext> {
  return invoke<SemanticChunkContext>("semantic_chunk_context", {
    sceneId: args.sceneId,
    charStart: args.charStart,
    charEnd: args.charEnd,
    padding: args.padding,
  });
}

/**
 * 開発者向けデバッグダンプ。指定 project (任意で 1 scene) の `scene_chunks` を
 * 検査用に列挙する。セマンティック検索で「何が・どのモデルで index されたか」を
 * 確認するための窓口。Rust 側の `DebugChunkRow` / `DebugDumpReport` (serde camelCase)
 * と一致させること。`embeddingNorm` は格納ベクトルの L2 ノルム (正規化済みなら ≈1.0)、
 * `isStale` は現在の spec と model/dim/chunker が食い違うと true。
 */
export interface SemanticDebugChunk {
  sceneId: string;
  sceneTitle: string;
  chunkIndex: number;
  charStart: number;
  charEnd: number;
  dialogueRatio: number;
  textPreview: string;
  modelId: string;
  embeddingDim: number;
  chunkerVersion: string;
  contentHash: string;
  embeddingNorm: number;
  isStale: boolean;
}

export interface SemanticDebugDump {
  projectId: string;
  language: string;
  currentModelId: string;
  currentEmbeddingDim: number;
  currentChunkerVersion: string;
  totalChunks: number;
  returnedChunks: number;
  chunks: SemanticDebugChunk[];
}

export function semanticDebugDump(args: {
  projectId: string;
  sceneId?: string | null;
  limit?: number;
}): Promise<SemanticDebugDump> {
  return invoke<SemanticDebugDump>("semantic_debug_dump", {
    projectId: args.projectId,
    sceneId: args.sceneId ?? null,
    limit: args.limit ?? null,
  });
}
