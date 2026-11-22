/**
 * What a read executor of the shared core returns (Mastra migration MP-4b,
 * DR-MP4-3). The renderer's `ToolResult` is this plus the tool call id; the
 * core cannot import that type (it lives in `src/`), so the shape is stated
 * here and the renderer assigns it structurally.
 *
 * `content` is what the model reads: its `JSON.stringify` is the byte string
 * whose size `tokensUsed` counts. The key order of an object a tool builds is
 * part of the result.
 */
export interface CoreToolResult {
  readonly name: string;
  readonly content: unknown;
  readonly summary: string;
  readonly tokensUsed: number;
}

/** A read executor: the model's parameters in, one result out. */
export type CoreReadExecutor = (
  params: Record<string, unknown>,
) => Promise<CoreToolResult>;
