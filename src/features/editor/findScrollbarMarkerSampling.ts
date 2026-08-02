import {
  getFindDecorationRect,
  type FindMatchRect,
} from "./findScrollbarMarkerGeometry";

interface CollectFindMatchRectsOptions {
  decorations: NodeListOf<HTMLElement>;
  maximumGeometryReads: number;
  getTrackPixel: (rect: FindMatchRect["rect"]) => number | null;
}

interface SampledDecoration {
  index: number;
  rect: FindMatchRect["rect"] | null;
  current: boolean;
  trackPixel: number | null;
}

interface SampleInterval {
  left: number;
  right: number;
  priority: number;
}

class MaxIntervalHeap {
  private readonly values: SampleInterval[] = [];

  get size(): number {
    return this.values.length;
  }

  push(interval: SampleInterval): void {
    this.values.push(interval);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent]!.priority >= interval.priority) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = interval;
  }

  pop(): SampleInterval | null {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last) return first ?? null;
    if (this.values.length === 0) return first;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const largerChild =
        right < this.values.length &&
        this.values[right]!.priority > this.values[left]!.priority
          ? right
          : left;
      if (this.values[largerChild]!.priority <= last.priority) break;
      this.values[index] = this.values[largerChild]!;
      index = largerChild;
    }
    this.values[index] = last;
    return first;
  }
}

/**
 * Adaptively sample document-ordered hits by visual track position. A max heap
 * keeps interval selection O(B log B) for geometry budget B; hidden samples
 * remain null-pixel boundaries so visible hits on both sides are still found.
 */
export function collectFindMatchRects({
  decorations,
  maximumGeometryReads,
  getTrackPixel,
}: CollectFindMatchRectsOptions): FindMatchRect[] {
  if (decorations.length === 0) return [];

  const maximum = Math.max(Math.floor(maximumGeometryReads), 1);
  const samples = new Map<number, SampledDecoration>();
  let geometryReads = 0;

  const measure = (index: number): SampledDecoration | null => {
    const cached = samples.get(index);
    if (cached) return cached;
    if (geometryReads >= maximum) return null;
    const decoration = decorations[index];
    if (!decoration) return null;

    geometryReads++;
    let rect: FindMatchRect["rect"] | null = null;
    try {
      rect = getFindDecorationRect(decoration);
    } catch {
      // The decoration can disappear between the query and this geometry read.
    }
    const result: SampledDecoration = {
      index,
      rect,
      current: decoration.classList.contains("find-current"),
      trackPixel: rect ? getTrackPixel(rect) : null,
    };
    samples.set(index, result);
    return result;
  };

  let currentIndex = -1;
  for (let index = 0; index < decorations.length; index++) {
    if (decorations[index]?.classList.contains("find-current")) {
      currentIndex = index;
      break;
    }
  }
  if (currentIndex >= 0) measure(currentIndex);

  if (decorations.length <= maximum) {
    for (let index = 0; index < decorations.length; index++) measure(index);
  } else {
    measure(0);
    measure(decorations.length - 1);
    const pending = new MaxIntervalHeap();
    const enqueue = (leftIndex: number, rightIndex: number) => {
      if (rightIndex - leftIndex <= 1) return;
      const left = samples.get(leftIndex);
      const right = samples.get(rightIndex);
      if (
        left?.trackPixel != null &&
        right?.trackPixel != null &&
        left.trackPixel === right.trackPixel
      ) {
        return;
      }
      const visualGap =
        left?.trackPixel != null && right?.trackPixel != null
          ? Math.abs(right.trackPixel - left.trackPixel)
          : 0;
      pending.push({
        left: leftIndex,
        right: rightIndex,
        priority: visualGap * decorations.length + rightIndex - leftIndex,
      });
    };
    enqueue(0, decorations.length - 1);

    while (pending.size > 0 && geometryReads < maximum) {
      const interval = pending.pop();
      if (!interval) break;
      const midpoint = Math.floor((interval.left + interval.right) / 2);
      const middle = measure(midpoint);
      if (!middle) break;
      enqueue(interval.left, midpoint);
      enqueue(midpoint, interval.right);
    }
  }

  return [...samples.values()]
    .filter(
      (sample): sample is SampledDecoration & { rect: FindMatchRect["rect"] } =>
        sample.rect !== null,
    )
    .sort((left, right) => left.index - right.index)
    .map(({ rect, current }) => ({ rect, current }));
}
