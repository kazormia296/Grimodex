import type { LexicalPreviewContent } from "../preview/lexicalPreview";
import type { SemanticPreviewContent } from "../preview/semanticPreview";

export type PreviewContent = LexicalPreviewContent | SemanticPreviewContent;

/**
 * itemId → PreviewContent の LRU キャッシュ (容量 100)。
 * クエリが変わったときは `clear()` してから再構築する想定 (caller が制御)。
 *
 * 実装: insertion order を保証する Map の特性を利用 (Map.delete + set で末尾に再挿入 = recently used)。
 */
const DEFAULT_CAPACITY = 100;

export class PreviewCache {
  private readonly cache: Map<string, PreviewContent>;
  private readonly capacity: number;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.cache = new Map();
    this.capacity = capacity;
  }

  get(itemId: string): PreviewContent | undefined {
    const v = this.cache.get(itemId);
    if (v === undefined) return undefined;
    // recently used として末尾に移動
    this.cache.delete(itemId);
    this.cache.set(itemId, v);
    return v;
  }

  set(itemId: string, content: PreviewContent): void {
    if (this.cache.has(itemId)) {
      this.cache.delete(itemId);
    } else if (this.cache.size >= this.capacity) {
      // 一番古い (= insertion order の先頭) を捨てる
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(itemId, content);
  }

  has(itemId: string): boolean {
    return this.cache.has(itemId);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/** モジュール singleton — UI から共有 */
export const previewCache = new PreviewCache();
