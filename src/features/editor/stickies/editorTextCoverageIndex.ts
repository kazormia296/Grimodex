export interface EditorTextCoverageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EditorTextCoverageIndex {
  rects: readonly EditorTextCoverageRect[];
  tileSize: number;
  tiles: ReadonlyMap<string, readonly EditorTextCoverageRect[]>;
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
export const EDITOR_STICKY_COVERAGE_TILE_SIZE = 768;

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

/**
 * Partition coverage once so every sticky mask only scans nearby text. The
 * full rect list remains available for diagnostics and correctness; tiles are
 * an acceleration index, not a visibility filter.
 */
export function indexEditorTextCoverage(
  rects: readonly EditorTextCoverageRect[],
  tileSize = EDITOR_STICKY_COVERAGE_TILE_SIZE,
): EditorTextCoverageIndex {
  const tiles = new Map<string, EditorTextCoverageRect[]>();
  for (const rect of rects) {
    const firstX = Math.floor(rect.x / tileSize);
    const lastX = Math.floor((rect.x + rect.width) / tileSize);
    const firstY = Math.floor(rect.y / tileSize);
    const lastY = Math.floor((rect.y + rect.height) / tileSize);
    for (let tileX = firstX; tileX <= lastX; tileX += 1) {
      for (let tileY = firstY; tileY <= lastY; tileY += 1) {
        const key = `${tileX}:${tileY}`;
        const bucket = tiles.get(key);
        if (bucket) bucket.push(rect);
        else tiles.set(key, [rect]);
      }
    }
  }
  return { rects, tileSize, tiles };
}

/** Intersect global surface coverage with one paper's local coordinate space. */
export function projectCoverageToCard(
  coverage: readonly EditorTextCoverageRect[] | EditorTextCoverageIndex,
  card: CoverageCardRect,
): EditorTextCoverageRect[] {
  const cardX = card.x ?? card.left ?? 0;
  const cardY = card.y ?? card.top ?? 0;
  const right = cardX + card.width;
  const bottom = cardY + card.height;
  const projected: EditorTextCoverageRect[] = [];
  const candidates =
    "tiles" in coverage
      ? (() => {
          const firstX = Math.floor(cardX / coverage.tileSize);
          const lastX = Math.floor(right / coverage.tileSize);
          const firstY = Math.floor(cardY / coverage.tileSize);
          const lastY = Math.floor(bottom / coverage.tileSize);
          const unique = new Set<EditorTextCoverageRect>();
          for (let tileX = firstX; tileX <= lastX; tileX += 1) {
            for (let tileY = firstY; tileY <= lastY; tileY += 1) {
              for (const rect of coverage.tiles.get(`${tileX}:${tileY}`) ??
                []) {
                unique.add(rect);
              }
            }
          }
          return unique;
        })()
      : coverage;

  for (const rect of candidates) {
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
