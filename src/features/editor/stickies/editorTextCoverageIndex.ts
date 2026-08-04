export interface EditorTextCoverageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SurfaceRectOrigin {
  left: number;
  top: number;
}

export interface CoverageCardRect {
  x?: number;
  y?: number;
  left?: number;
  top?: number;
  width: number;
  height: number;
}

const COVERAGE_EXPANSION_PX = 1;
const NON_WHITESPACE_RUN = /\S+/gu;

function isCoverageExcluded(textNode: Text): boolean {
  const parent = textNode.parentElement;
  if (!parent) return true;
  return Boolean(
    parent.closest(
      '[data-editor-sticky-card], [data-editor-sticky-ignore], img, [data-placeholder="true"]',
    ),
  );
}

function rectValue(
  rect: DOMRect | DOMRectReadOnly | ClientRect,
): EditorTextCoverageRect | null {
  const left = Number.isFinite(rect.left) ? rect.left : rect.x;
  const top = Number.isFinite(rect.top) ? rect.top : rect.y;
  const width = rect.width;
  const height = rect.height;
  if (![left, top, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  return {
    x: left - COVERAGE_EXPANSION_PX,
    y: top - COVERAGE_EXPANSION_PX,
    width: width + COVERAGE_EXPANSION_PX * 2,
    height: height + COVERAGE_EXPANSION_PX * 2,
  };
}

/**
 * Read only real non-whitespace text runs from an editor DOM. The caller owns
 * scheduling; this function deliberately performs no mutation and never
 * inspects layout outside the supplied root.
 */
export function collectEditorTextCoverage(
  root: HTMLElement,
  origin: SurfaceRectOrigin,
): EditorTextCoverageRect[] {
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const coverage: EditorTextCoverageRect[] = [];
  let current: Node | null = walker.nextNode();

  while (current) {
    const textNode = current as Text;
    if (!isCoverageExcluded(textNode)) {
      NON_WHITESPACE_RUN.lastIndex = 0;
      let match = NON_WHITESPACE_RUN.exec(textNode.data);
      while (match) {
        const range = document.createRange();
        range.setStart(textNode, match.index);
        range.setEnd(textNode, match.index + match[0].length);
        for (const rect of Array.from(range.getClientRects())) {
          const value = rectValue(rect);
          if (value) {
            coverage.push({
              ...value,
              x: value.x - origin.left,
              y: value.y - origin.top,
            });
          }
        }
        match = NON_WHITESPACE_RUN.exec(textNode.data);
      }
    }
    current = walker.nextNode();
  }

  return coverage;
}

/** Intersect global surface coverage with one paper's local coordinate space. */
export function projectCoverageToCard(
  coverage: readonly EditorTextCoverageRect[],
  card: CoverageCardRect,
): EditorTextCoverageRect[] {
  const cardX = card.x ?? card.left ?? 0;
  const cardY = card.y ?? card.top ?? 0;
  const right = cardX + card.width;
  const bottom = cardY + card.height;
  const projected: EditorTextCoverageRect[] = [];

  for (const rect of coverage) {
    const left = Math.max(cardX, rect.x);
    const top = Math.max(cardY, rect.y);
    const clippedRight = Math.min(right, rect.x + rect.width);
    const clippedBottom = Math.min(bottom, rect.y + rect.height);
    if (clippedRight <= left || clippedBottom <= top) continue;
    projected.push({
      x: left - cardX,
      y: top - cardY,
      width: clippedRight - left,
      height: clippedBottom - top,
    });
  }
  return projected;
}
