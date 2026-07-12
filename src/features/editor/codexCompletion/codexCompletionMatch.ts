import type {
  CodexCompletionCandidate,
  CodexCompletionIndex,
} from "./codexCompletionIndex";
import type { CodexCompletionMatch } from "./codexCompletionTypes";

const MAX_PREFIX_GRAPHEMES = 64;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function graphemeSegments(text: string): Intl.SegmentData[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text));
}

function firstGrapheme(text: string): string {
  return graphemeSegments(text)[0]?.segment ?? "";
}

function isLatinOrDigitStart(text: string): boolean {
  return /^[\p{Script=Latin}\p{N}_]/u.test(firstGrapheme(text));
}

function isCjkStart(text: string): boolean {
  return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
    firstGrapheme(text),
  );
}

function isWordLike(text: string): boolean {
  return /^[\p{L}\p{N}_]/u.test(text);
}

function completionSuffix(
  candidate: CodexCompletionCandidate,
  prefix: string,
): string {
  const normalizedPrefix = prefix.normalize("NFC").toLowerCase();
  let normalized = "";
  let sourceOffset = 0;
  for (const segment of graphemeSegments(candidate.surface)) {
    normalized += segment.segment.normalize("NFC").toLowerCase();
    sourceOffset += segment.segment.length;
    if (normalized.length >= normalizedPrefix.length) {
      return candidate.surface.slice(sourceOffset);
    }
  }
  return "";
}

function isAllowedBoundary(previous: string, prefix: string): boolean {
  if (previous === "@" || previous === "/") return false;
  if (!isLatinOrDigitStart(prefix)) return true;
  return previous === "" || !isWordLike(previous) || isCjkStart(previous);
}

/**
 * Find the longest candidate-eligible suffix ending at `cursorOffset`.
 * Offsets are UTF-16 offsets, matching ProseMirror's text positions.
 */
export function findCodexCompletionMatch(
  text: string,
  cursorOffset: number,
  index: CodexCompletionIndex,
): CodexCompletionMatch | null {
  if (cursorOffset < 0 || cursorOffset > text.length) return null;

  const beforeCursor = text.slice(0, cursorOffset);
  const segments = graphemeSegments(beforeCursor);
  const boundaries = [
    0,
    ...segments.map((segment) => segment.index + segment.segment.length),
  ];
  const firstStart = Math.max(0, segments.length - MAX_PREFIX_GRAPHEMES);

  for (let i = firstStart; i < segments.length; i += 1) {
    const from = boundaries[i];
    const prefix = text.slice(from, cursorOffset);
    if (prefix.length === 0) continue;
    if (prefix.startsWith("/") || prefix.startsWith("@")) continue;
    if (!isAllowedBoundary(segments[i - 1]?.segment ?? "", prefix)) continue;

    const minLength = isCjkStart(prefix) ? 1 : 2;
    if (segments.length - i < minLength) continue;

    const candidate = index.find(prefix)[0];
    if (!candidate) continue;
    return {
      candidate,
      prefix,
      suffix: completionSuffix(candidate, prefix),
      from,
      to: cursorOffset,
    };
  }
  return null;
}
