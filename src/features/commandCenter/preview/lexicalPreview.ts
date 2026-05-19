/**
 * Lexical ヒットのプレビュー内容。`SearchResult.excerpt` をそのまま使う。
 * Rust 側の追加 invoke は不要。
 */
export interface LexicalPreviewContent {
  kind: "lexical";
  /** scene/codex/snippet のタイトル */
  title: string;
  /** FTS5 が返した excerpt (前後文脈付きの短文) */
  excerpt: string;
}

export function buildLexicalPreview(
  title: string,
  excerpt: string,
): LexicalPreviewContent {
  return { kind: "lexical", title, excerpt };
}
