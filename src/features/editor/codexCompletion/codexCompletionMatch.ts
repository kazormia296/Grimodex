import type {
  CodexCompletionCandidate,
  CodexCompletionIndex,
} from "./codexCompletionIndex";
import type { CodexCompletionMatch } from "./codexCompletionTypes";

const MAX_PREFIX_GRAPHEMES = 64;
const COMPLETE_PREFIX_WINDOW_GRAPHEMES = MAX_PREFIX_GRAPHEMES + 2;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function graphemeSegments(text: string): Intl.SegmentData[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text));
}

function isLatinOrDigitGrapheme(grapheme: string): boolean {
  return /^[\p{Script=Latin}\p{N}_]/u.test(grapheme);
}

function isCjkGrapheme(grapheme: string): boolean {
  return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
    grapheme,
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

function isAllowedBoundary(previous: string, first: string): boolean {
  if (previous === "@" || previous === "/") return false;
  if (!isLatinOrDigitGrapheme(first)) return true;
  return previous === "" || !isWordLike(previous) || isCjkGrapheme(previous);
}

/**
 * A textblock suffix is complete once it contains every candidate grapheme,
 * one boundary grapheme, and one spare segment in case the window starts in
 * the middle of a multi-code-point grapheme.
 */
export function hasCompleteCodexCompletionPrefixWindow(text: string): boolean {
  let count = 0;
  for (const _segment of GRAPHEME_SEGMENTER.segment(text)) {
    count += 1;
    if (count >= COMPLETE_PREFIX_WINDOW_GRAPHEMES) return true;
  }
  return false;
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
    const first = segments[i]?.segment ?? "";
    if (!isAllowedBoundary(segments[i - 1]?.segment ?? "", first)) continue;

    const minLength = isCjkGrapheme(first) ? 1 : 2;
    if (segments.length - i < minLength) continue;

    const candidate = index.findFirst(prefix);
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
