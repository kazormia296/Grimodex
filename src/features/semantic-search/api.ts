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
  currentModelId: string;
  currentEmbeddingDim: number;
  currentChunkerVersion: string;
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

/** project 内全 scene の再インデックス。戻り値は投入チャンク総数。 */
export function semanticReindexAll(projectId: string): Promise<number> {
  return invoke<number>("semantic_reindex_all", { projectId });
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
