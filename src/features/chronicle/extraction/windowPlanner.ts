import type {
  CanonicalBlockSpan,
  CanonicalRange,
  NarrativeCorpusDocument,
  NarrativeCorpusSnapshot,
} from "@/features/narrative-extraction/source/types";

/** Default owned-window budget in UTF-16 code units (approx. structured-model token headroom). */
export const DEFAULT_MAX_WINDOW_OWNED_CHARS = 6000;

/** Extra context pulled from each side of an owned range when splitting. */
export const DEFAULT_CONTEXT_RADIUS_CHARS = 240;

export interface ExtractionWindow {
  readonly windowId: string;
  readonly documentRef: string;
  readonly sourceRef: string;
  readonly ownedRanges: readonly CanonicalRange[];
  readonly contextRanges: readonly CanonicalRange[];
}

export interface WindowPlan {
  readonly windows: readonly ExtractionWindow[];
}

/**
 * Structural view of the sealed evidence span catalog that the planner needs.
 * `EvidenceSpanCatalog` satisfies it; the planner does not import the catalog
 * module so the dependency direction stays features/narrative-extraction ->
 * features/chronicle.
 */
export interface EvidenceCoverageCatalog {
  readonly entries: readonly {
    readonly documentRef: string;
    readonly canonicalRange: CanonicalRange;
  }[];
}

export interface PlanWindowsOptions {
  readonly maxOwnedChars?: number;
  readonly contextRadiusChars?: number;
  /**
   * citation-id-v2 only. When given, a window's context is widened (and only
   * its context: owned ranges, windowId and sourceRef never change) just far
   * enough that every catalog entry fits entirely in at least one window's
   * source view. Without it, or when every entry already fits, the plan is
   * byte-identical to the plan made without it.
   */
  readonly evidenceCatalog?: EvidenceCoverageCatalog;
}

function sourceViewRef(index: number): string {
  return `S${String(index + 1).padStart(4, "0")}`;
}

function windowId(index: number): string {
  return `window-${String(index + 1).padStart(3, "0")}`;
}

function clampRange(
  start: number,
  end: number,
  length: number,
): CanonicalRange | null {
  const clampedStart = Math.max(0, Math.min(start, length));
  const clampedEnd = Math.max(clampedStart, Math.min(end, length));
  if (clampedEnd <= clampedStart) return null;
  return { start: clampedStart, end: clampedEnd };
}

function mergeAdjacent(ranges: readonly CanonicalRange[]): CanonicalRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: CanonicalRange[] = [{ ...sorted[0] }];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.start <= last.end) {
      merged[merged.length - 1] = {
        start: last.start,
        end: Math.max(last.end, range.end),
      };
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function subtractRanges(
  owned: CanonicalRange,
  contextCandidates: readonly CanonicalRange[],
): CanonicalRange[] {
  return contextCandidates.flatMap((candidate) => {
    const parts: CanonicalRange[] = [];
    if (candidate.start < owned.start) {
      parts.push({
        start: candidate.start,
        end: Math.min(candidate.end, owned.start),
      });
    }
    if (candidate.end > owned.end) {
      parts.push({
        start: Math.max(candidate.start, owned.end),
        end: candidate.end,
      });
    }
    return parts.filter((part) => part.end > part.start);
  });
}

interface ContextRadii {
  left: number;
  right: number;
}

function contextForOwned(
  owned: CanonicalRange,
  textLength: number,
  radii: ContextRadii,
): CanonicalRange[] {
  const left = clampRange(owned.start - radii.left, owned.start, textLength);
  const right = clampRange(owned.end, owned.end + radii.right, textLength);
  return [left, right].filter(
    (range): range is CanonicalRange => range !== null,
  );
}

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

function snapToUtf16Boundary(text: string, offset: number): number {
  if (isUtf16Boundary(text, offset)) return offset;
  return Math.max(0, offset - 1);
}

function blockCutPoints(
  blocks: readonly CanonicalBlockSpan[],
  start: number,
  end: number,
): number[] {
  const points: number[] = [];
  for (const block of blocks) {
    const from = block.range.from;
    if (from > start && from < end) points.push(from);
  }
  return points;
}

function sentenceCutPoints(text: string, start: number, end: number): number[] {
  const points: number[] = [];
  for (let index = start; index < end; index += 1) {
    const ch = text[index];
    if (ch === "。" || ch === "！" || ch === "？" || ch === "\n") {
      const after = index + 1;
      if (after > start && after < end) points.push(after);
    }
  }
  return points;
}

function graphemeCutPoints(text: string, start: number, end: number): number[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const points: number[] = [];
  for (const segment of segmenter.segment(text.slice(start, end))) {
    const absolute = start + segment.index + segment.segment.length;
    if (absolute > start && absolute < end && isUtf16Boundary(text, absolute)) {
      points.push(absolute);
    }
  }
  return points;
}

function pickCut(
  preferred: readonly number[],
  start: number,
  end: number,
  maxOwned: number,
): number | null {
  const target = start + maxOwned;
  if (target >= end) return null;
  const candidates = preferred.filter(
    (point) => point > start && point < end && point <= target,
  );
  if (candidates.length === 0) return null;
  return candidates[candidates.length - 1];
}

function splitOwnedRanges(
  document: NarrativeCorpusDocument,
  maxOwned: number,
): CanonicalRange[] {
  const text = document.canonical.text;
  const length = text.length;
  if (length === 0) return [];
  if (length <= maxOwned) return [{ start: 0, end: length }];

  const ranges: CanonicalRange[] = [];
  let cursor = 0;
  while (cursor < length) {
    const remaining = length - cursor;
    if (remaining <= maxOwned) {
      ranges.push({ start: cursor, end: length });
      break;
    }
    const blockCut = pickCut(
      blockCutPoints(document.canonical.blocks, cursor, length),
      cursor,
      length,
      maxOwned,
    );
    const sentenceCut =
      blockCut ??
      pickCut(
        sentenceCutPoints(text, cursor, length),
        cursor,
        length,
        maxOwned,
      );
    const graphemeCut =
      sentenceCut ??
      pickCut(
        graphemeCutPoints(text, cursor, length),
        cursor,
        length,
        maxOwned,
      );
    let cut =
      graphemeCut ??
      snapToUtf16Boundary(text, Math.min(cursor + maxOwned, length));
    if (cut <= cursor) {
      cut = Math.min(length, cursor + Math.max(1, maxOwned));
      cut = snapToUtf16Boundary(text, cut);
      if (cut <= cursor) cut = Math.min(length, cursor + 1);
    }
    ranges.push({ start: cursor, end: cut });
    cursor = cut;
  }
  return ranges;
}

function coverOf(
  owned: CanonicalRange,
  radii: ContextRadii,
  textLength: number,
): CanonicalRange {
  return {
    start: Math.max(0, owned.start - radii.left),
    end: Math.min(textLength, owned.end + radii.right),
  };
}

/**
 * Widen only the context radii so that each evidence entry is fully inside at
 * least one window's source view (owned plus context). Entries already inside
 * some window change nothing. For an entry that is not, the window that owns
 * part of it and needs the smallest extension (ties: the earliest window) is
 * widened to the entry's far end. The owned partition is never touched, and no
 * entry is dropped: a window is only ever widened here, at planning time,
 * before any source view or coverage assertion exists.
 */
function widenRadiiForEvidence(
  ownedRanges: readonly CanonicalRange[],
  radii: ContextRadii[],
  entries: readonly CanonicalRange[],
  textLength: number,
): void {
  const sorted = [...entries]
    .map((entry) => ({
      start: Math.max(0, entry.start),
      end: Math.min(textLength, entry.end),
    }))
    .filter((entry) => entry.end > entry.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (const entry of sorted) {
    let best = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    let covered = false;
    for (let index = 0; index < ownedRanges.length; index += 1) {
      const owned = ownedRanges[index];
      const cover = coverOf(owned, radii[index], textLength);
      if (cover.start <= entry.start && entry.end <= cover.end) {
        covered = true;
        break;
      }
      if (owned.start < entry.end && entry.start < owned.end) {
        const cost =
          Math.max(0, cover.start - entry.start) +
          Math.max(0, entry.end - cover.end);
        if (cost < bestCost) {
          best = index;
          bestCost = cost;
        }
      }
    }
    if (covered || best < 0) continue;
    const owned = ownedRanges[best];
    radii[best] = {
      left: Math.max(radii[best].left, owned.start - entry.start),
      right: Math.max(radii[best].right, entry.end - owned.end),
    };
  }
}

/**
 * Plan extraction windows: one scene → one window unless the owned text
 * exceeds the budget; then split on block → sentence → grapheme boundaries.
 * Owned ranges partition each document without overlap or gaps.
 */
export function planExtractionWindows(
  snapshot: NarrativeCorpusSnapshot,
  options: PlanWindowsOptions = {},
): WindowPlan {
  const maxOwned = options.maxOwnedChars ?? DEFAULT_MAX_WINDOW_OWNED_CHARS;
  const contextRadius =
    options.contextRadiusChars ?? DEFAULT_CONTEXT_RADIUS_CHARS;

  const entriesByDocument = new Map<string, CanonicalRange[]>();
  for (const entry of options.evidenceCatalog?.entries ?? []) {
    const bucket = entriesByDocument.get(entry.documentRef);
    if (bucket) bucket.push(entry.canonicalRange);
    else entriesByDocument.set(entry.documentRef, [entry.canonicalRange]);
  }

  const windows: ExtractionWindow[] = [];
  let sourceIndex = 0;

  for (const document of snapshot.documents) {
    const ownedRanges = splitOwnedRanges(document, maxOwned);
    const radii: ContextRadii[] = ownedRanges.map(() => ({
      left: contextRadius,
      right: contextRadius,
    }));
    const evidenceEntries = entriesByDocument.get(document.ref);
    if (evidenceEntries) {
      widenRadiiForEvidence(
        ownedRanges,
        radii,
        evidenceEntries,
        document.canonical.text.length,
      );
    }
    for (const [ownedIndex, owned] of ownedRanges.entries()) {
      const contextCandidates = contextForOwned(
        owned,
        document.canonical.text.length,
        radii[ownedIndex],
      );
      const contextRanges = mergeAdjacent(
        subtractRanges(owned, contextCandidates),
      );
      windows.push({
        windowId: windowId(windows.length),
        documentRef: document.ref,
        sourceRef: sourceViewRef(sourceIndex),
        ownedRanges: [owned],
        contextRanges,
      });
      sourceIndex += 1;
    }
  }

  return { windows };
}

/** Validate that owned ranges cover each document exactly once. */
export function assertOwnedRangesPartition(
  snapshot: NarrativeCorpusSnapshot,
  plan: WindowPlan,
): boolean {
  for (const document of snapshot.documents) {
    const owned = plan.windows
      .filter((window) => window.documentRef === document.ref)
      .flatMap((window) => window.ownedRanges)
      .sort((left, right) => left.start - right.start);
    let cursor = 0;
    for (const range of owned) {
      if (range.start !== cursor || range.end < range.start) return false;
      cursor = range.end;
    }
    if (cursor !== document.canonical.text.length) return false;
  }
  return true;
}
