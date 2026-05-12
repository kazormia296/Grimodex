import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export interface ResolvedRange {
  from: number;
  to: number;
}

interface TextSegment {
  startInFlat: number;
  pmPos: number;
  length: number;
}

interface FlatDoc {
  flat: string;
  segments: TextSegment[];
}

function buildFlatDoc(doc: ProseMirrorNode): FlatDoc {
  const segments: TextSegment[] = [];
  let flat = "";
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      segments.push({
        startInFlat: flat.length,
        pmPos: pos,
        length: node.text.length,
      });
      flat += node.text;
    }
  });
  return { flat, segments };
}

function flatIndexToPm(
  segments: TextSegment[],
  flatIdx: number,
  prefer: "start" | "end",
): number | null {
  // For "start": prefer the next segment when on a boundary (flatIdx is the
  // first char of a span, so we want the leading edge inside that segment).
  // For "end": prefer the current segment so the trailing edge sits at the
  // very end of the matched text, not the leading edge of the next segment
  // (which would be one paragraph break away in PM-space).
  for (const seg of segments) {
    const start = seg.startInFlat;
    const end = seg.startInFlat + seg.length;
    if (prefer === "start") {
      if (flatIdx >= start && flatIdx < end) {
        return seg.pmPos + (flatIdx - start);
      }
    } else {
      if (flatIdx > start && flatIdx <= end) {
        return seg.pmPos + (flatIdx - start);
      }
    }
  }
  // Edge cases: empty doc, or flatIdx at the very start/end of all segments.
  if (segments.length === 0) return null;
  if (prefer === "start") {
    const last = segments[segments.length - 1]!;
    if (flatIdx === last.startInFlat + last.length)
      return last.pmPos + last.length;
  } else {
    const first = segments[0]!;
    if (flatIdx === first.startInFlat) return first.pmPos;
  }
  return null;
}

/**
 * Find every occurrence of `needle` in `haystack`. Returns flat-string indices.
 */
function findAllOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    out.push(i);
    from = i + 1;
  }
  return out;
}

/**
 * Resolve an annotation's true PM range in the editor doc.
 *
 * Priority:
 * 1. If `rangeStart`/`rangeEnd` already point at a PM range whose text equals
 *    `textSnapshot`, use as-is. This is the happy path after a save-roundtrip
 *    through `extractAnnotationMarks` (which writes PM positions).
 * 2. Otherwise search the doc for `textSnapshot` and pick the occurrence
 *    closest to `rangeStart` (treated as a rough char-position hint — the
 *    Rust backend writes a byte offset into the whitespace-normalized
 *    plain text, so the hint is approximate but useful for disambiguating
 *    multiple matches).
 * 3. If `textSnapshot` is empty or unmatched, return null (orphan).
 */
export function resolveAnnotationRange(
  doc: ProseMirrorNode,
  args: {
    rangeStart: number | null;
    rangeEnd: number | null;
    textSnapshot: string | null;
  },
): ResolvedRange | null {
  const { rangeStart, rangeEnd, textSnapshot } = args;
  const docSize = doc.content.size;

  // (1) Trust existing PM positions when they round-trip the snapshot exactly.
  if (
    rangeStart != null &&
    rangeEnd != null &&
    rangeStart >= 0 &&
    rangeEnd > rangeStart &&
    rangeEnd <= docSize &&
    textSnapshot
  ) {
    try {
      const here = doc.textBetween(rangeStart, rangeEnd, "", "");
      if (here === textSnapshot) {
        return { from: rangeStart, to: rangeEnd };
      }
    } catch {
      // textBetween can throw on invalid positions; fall through to search.
    }
  }

  // (2) Search the flat doc text for textSnapshot.
  if (!textSnapshot) return null;
  const { flat, segments } = buildFlatDoc(doc);
  const occurrences = findAllOccurrences(flat, textSnapshot);
  if (occurrences.length === 0) return null;

  // Pick the occurrence closest to the (approximate) hint. When hint is
  // missing or all distances tie, return the first occurrence.
  const hint = rangeStart ?? 0;
  let bestFlatIdx = occurrences[0]!;
  let bestDist = Math.abs(bestFlatIdx - hint);
  for (let i = 1; i < occurrences.length; i++) {
    const idx = occurrences[i]!;
    const d = Math.abs(idx - hint);
    if (d < bestDist) {
      bestDist = d;
      bestFlatIdx = idx;
    }
  }

  const from = flatIndexToPm(segments, bestFlatIdx, "start");
  const to = flatIndexToPm(segments, bestFlatIdx + textSnapshot.length, "end");
  if (from == null || to == null || from >= to) return null;
  return { from, to };
}
