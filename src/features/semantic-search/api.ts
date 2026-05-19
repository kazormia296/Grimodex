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
