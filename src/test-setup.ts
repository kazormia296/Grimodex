import "@testing-library/jest-dom/vitest";
import "@/lib/i18n";
import { vi } from "vitest";

// Mock @tanstack/react-virtual for jsdom (no ResizeObserver / element dimensions)
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number }) => {
    const size = opts.estimateSize();
    const items = Array.from({ length: opts.count }, (_, i) => ({
      index: i,
      start: i * size,
      size,
      key: i,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * size,
      measureElement: vi.fn(),
      scrollToIndex: vi.fn(),
    };
  },
}));

// ProseMirror requires DOM APIs that jsdom doesn't implement
if (typeof document !== "undefined") {
  document.elementFromPoint = () => null;
  const emptyDOMRectList = {
    length: 0,
    item: () => null,
    [Symbol.iterator]: Array.prototype[Symbol.iterator],
  } as unknown as DOMRectList;
  Range.prototype.getClientRects = () => emptyDOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  HTMLElement.prototype.getClientRects = () => emptyDOMRectList;
}
