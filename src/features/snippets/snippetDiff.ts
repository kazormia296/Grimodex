import DiffMatchPatch from "diff-match-patch";

export interface AttributedSegment {
  text: string;
  source: "ai" | "human";
}

const dmp = new DiffMatchPatch();

/**
 * Compute attributed segments by diffing the original AI content against
 * the (possibly edited) current content.
 *
 * - Unchanged (EQUAL) regions → "ai"
 * - Inserted (INSERT) regions → "human"
 * - Deleted (DELETE) regions are skipped (not in current content)
 */
export function computeAttributedSegments(
  originalContent: string,
  currentContent: string,
): AttributedSegment[] {
  if (originalContent === currentContent) {
    return [{ text: currentContent, source: "ai" }];
  }

  const diffs = dmp.diff_main(originalContent, currentContent);
  dmp.diff_cleanupSemantic(diffs);

  const segments: AttributedSegment[] = [];

  for (const [op, text] of diffs) {
    if (op === DiffMatchPatch.DIFF_DELETE) continue;

    const source = op === DiffMatchPatch.DIFF_EQUAL ? "ai" : "human";

    // Merge with previous segment if same source
    const last = segments[segments.length - 1];
    if (last && last.source === source) {
      last.text += text;
    } else {
      segments.push({ text, source });
    }
  }

  return segments;
}
