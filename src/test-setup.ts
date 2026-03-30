import "@testing-library/jest-dom/vitest";

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
