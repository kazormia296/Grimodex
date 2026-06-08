import "@testing-library/jest-dom/vitest";
import "@/lib/i18n";
import { vi, expect } from "vitest";
import * as axeMatchers from "vitest-axe/matchers";
// vitest-axe 0.1.0 の extend-expect.js は 0 バイトの no-op のため、
// matcher を手動登録する。型拡張 (toHaveNoViolations) は次行の side-effect
// import (extend-expect.d.ts の Vi.Assertion augmentation) で得る。
import "vitest-axe/extend-expect";

expect.extend(axeMatchers);

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
