import {
  getSemanticChunkContext,
  type SemanticChunkContext,
} from "@/features/semantic-search/api";

/**
 * Semantic ヒットのプレビュー内容。chunk 前後 ±padding 文字を Rust 経由で取得。
 */
export interface SemanticPreviewContent {
  kind: "semantic";
  sceneTitle: string;
  before: string;
  chunk: string;
  after: string;
  /** badge 表示用のスコア (caller 側で渡す。invoke は不要なので分離) */
  score: number;
}

export interface SemanticPreviewArgs {
  sceneId: string;
  charStart: number;
  charEnd: number;
  /** chunk 本体スコア (display 用) */
  score: number;
  /** デフォルト 100 文字 */
  padding?: number;
}

const DEFAULT_PADDING = 100;

export async function fetchSemanticPreview(
  args: SemanticPreviewArgs,
): Promise<SemanticPreviewContent> {
  const padding = args.padding ?? DEFAULT_PADDING;
  const ctx: SemanticChunkContext = await getSemanticChunkContext({
    sceneId: args.sceneId,
    charStart: args.charStart,
    charEnd: args.charEnd,
    padding,
  });
  return {
    kind: "semantic",
    sceneTitle: ctx.sceneTitle,
    before: ctx.before,
    chunk: ctx.chunk,
    after: ctx.after,
    score: args.score,
  };
}
