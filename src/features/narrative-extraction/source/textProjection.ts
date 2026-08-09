import type {
  CanonicalRange,
  MappedProjectionSegment,
  TextProjectionFragment,
  TextProjectionMap,
  TextProjectionResult,
} from "./types";

function isValidRange(map: TextProjectionMap, range: CanonicalRange): boolean {
  return (
    isValidProjectionMap(map) &&
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end > range.start &&
    range.end <= map.canonicalLength
  );
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidProjectionMap(map: TextProjectionMap): boolean {
  try {
    if (
      map.schemaVersion !== 1 ||
      map.unit !== "utf16" ||
      !isNonNegativeSafeInteger(map.canonicalLength) ||
      !Array.isArray(map.segments)
    ) {
      return false;
    }

    let previousCanonicalEnd = 0;
    let previousPmEnd = 0;
    for (const segment of map.segments) {
      if (
        segment.kind !== "linear" &&
        segment.kind !== "transformed" &&
        segment.kind !== "atomic" &&
        segment.kind !== "synthetic-boundary"
      ) {
        return false;
      }
      if (
        !isNonNegativeSafeInteger(segment.canonicalStart) ||
        !isNonNegativeSafeInteger(segment.canonicalEnd) ||
        segment.canonicalEnd <= segment.canonicalStart ||
        segment.canonicalEnd > map.canonicalLength ||
        segment.canonicalStart < previousCanonicalEnd ||
        segment.canonical.from !== segment.canonicalStart ||
        segment.canonical.to !== segment.canonicalEnd
      ) {
        return false;
      }
      previousCanonicalEnd = segment.canonicalEnd;

      if (segment.kind === "synthetic-boundary") {
        if (
          !isNonNegativeSafeInteger(segment.boundary.leftPmPos) ||
          !isNonNegativeSafeInteger(segment.boundary.rightPmPos) ||
          segment.boundary.leftPmPos < previousPmEnd ||
          segment.boundary.rightPmPos < segment.boundary.leftPmPos ||
          segment.reason !== "block-boundary"
        ) {
          return false;
        }
        previousPmEnd = segment.boundary.rightPmPos;
        continue;
      }

      if (
        !isNonNegativeSafeInteger(segment.from) ||
        !isNonNegativeSafeInteger(segment.to) ||
        segment.to <= segment.from ||
        segment.from < previousPmEnd ||
        segment.source.kind !== "prosemirror" ||
        segment.source.fromPos !== segment.from ||
        segment.source.toPos !== segment.to
      ) {
        return false;
      }
      previousPmEnd = segment.to;
      const canonicalLength = segment.canonicalEnd - segment.canonicalStart;
      const sourceLength = segment.to - segment.from;
      if (segment.kind === "linear" && canonicalLength !== sourceLength) {
        return false;
      }
      if (
        segment.kind === "transformed" &&
        (canonicalLength !== 1 ||
          (segment.transform === "cr-to-lf" && sourceLength !== 1) ||
          (segment.transform === "crlf-to-lf" && sourceLength !== 2) ||
          (segment.transform !== "cr-to-lf" &&
            segment.transform !== "crlf-to-lf"))
      ) {
        return false;
      }
      if (segment.kind === "atomic" && !segment.nodeType) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function projectIntersection(
  segment: MappedProjectionSegment,
  canonicalStart: number,
  canonicalEnd: number,
): TextProjectionFragment {
  if (segment.kind === "linear") {
    return {
      canonicalStart,
      canonicalEnd,
      from: segment.from + canonicalStart - segment.canonicalStart,
      to: segment.from + canonicalEnd - segment.canonicalStart,
      kind: "linear",
    };
  }

  return {
    canonicalStart,
    canonicalEnd,
    from: segment.from,
    to: segment.to,
    kind: segment.kind,
  };
}

function appendProjectedFragment(
  fragments: TextProjectionFragment[],
  fragment: TextProjectionFragment,
): void {
  const previous = fragments.at(-1);
  if (
    previous?.kind === "linear" &&
    fragment.kind === "linear" &&
    previous.canonicalEnd === fragment.canonicalStart &&
    previous.to === fragment.from
  ) {
    fragments[fragments.length - 1] = {
      ...previous,
      canonicalEnd: fragment.canonicalEnd,
      to: fragment.to,
    };
    return;
  }
  fragments.push(fragment);
}

/** Project a half-open canonical UTF-16 range back to ProseMirror positions. */
export function projectCanonicalRange(
  map: TextProjectionMap,
  range: CanonicalRange,
): TextProjectionResult {
  if (!isValidRange(map, range)) {
    return { status: "unmapped", fragments: [] };
  }

  const fragments: TextProjectionFragment[] = [];
  let mappedLength = 0;

  for (const segment of map.segments) {
    if (segment.canonicalEnd <= range.start) continue;
    if (segment.canonicalStart >= range.end) break;

    if (segment.kind === "synthetic-boundary") continue;

    const canonicalStart = Math.max(range.start, segment.canonicalStart);
    const canonicalEnd = Math.min(range.end, segment.canonicalEnd);
    if (canonicalEnd <= canonicalStart) continue;
    mappedLength += canonicalEnd - canonicalStart;
    appendProjectedFragment(
      fragments,
      projectIntersection(segment, canonicalStart, canonicalEnd),
    );
  }

  if (fragments.length === 0) {
    return { status: "unmapped", fragments: [] };
  }

  if (mappedLength === range.end - range.start) {
    return { status: "exact", fragments };
  }

  return {
    status: "fragmented",
    fragments,
    enclosingRange: {
      from: Math.min(...fragments.map((fragment) => fragment.from)),
      to: Math.max(...fragments.map((fragment) => fragment.to)),
    },
  };
}
