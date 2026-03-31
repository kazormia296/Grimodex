import { vi } from "vitest";

interface VirtualItem {
  index: number;
  start: number;
  size: number;
  key: number;
}

export function useVirtualizer(opts: {
  count: number;
  estimateSize: () => number;
  getScrollElement: () => HTMLElement | null;
  overscan?: number;
}) {
  const items: VirtualItem[] = [];
  const size = opts.estimateSize();
  for (let i = 0; i < opts.count; i++) {
    items.push({ index: i, start: i * size, size, key: i });
  }

  return {
    getVirtualItems: () => items,
    getTotalSize: () => opts.count * size,
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  };
}
