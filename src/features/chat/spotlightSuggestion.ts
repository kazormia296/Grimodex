import type { CodexEntry } from "@/features/codex/api";

/** スコアリングが読む最小列 (M10: icon/notes なしの projection 行も受ける)。 */
type SpotlightCandidate = Pick<CodexEntry, "id" | "content" | "summary">;

const MIN_TEXT_LEN = 30;
const MIN_SCORE = 2;
const MAX_CANDIDATES = 3;

interface ProseMirrorNode {
  text?: string;
  content?: ProseMirrorNode[];
}

function extractTextLen(content: string | null | undefined): number {
  if (!content) return 0;
  try {
    const doc = JSON.parse(content) as ProseMirrorNode;
    return countText(doc);
  } catch {
    return 0;
  }
}

function countText(node: ProseMirrorNode | null | undefined): number {
  if (!node) return 0;
  if (typeof node.text === "string") return node.text.length;
  if (!Array.isArray(node.content)) return 0;
  let total = 0;
  for (const child of node.content) total += countText(child);
  return total;
}

function scoreCandidate(
  entry: SpotlightCandidate,
  isDetected: boolean,
): number {
  const textLen = extractTextLen(entry.content);
  if (textLen < MIN_TEXT_LEN) return 0;
  let score = 1;
  if (!entry.summary?.trim()) score += 2;
  if (isDetected) score += 1;
  return score;
}

export function computeSpotlightCandidates(
  detectedEntries: readonly SpotlightCandidate[],
  alwaysEntries: readonly SpotlightCandidate[],
  pinnedIds: ReadonlySet<string>,
  maxCandidates: number = MAX_CANDIDATES,
): Set<string> {
  const seen = new Set<string>();
  const scored: { id: string; score: number; rank: number }[] = [];
  let rank = 0;
  for (const entry of detectedEntries) {
    if (pinnedIds.has(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const score = scoreCandidate(entry, true);
    if (score >= MIN_SCORE) scored.push({ id: entry.id, score, rank: rank++ });
  }
  for (const entry of alwaysEntries) {
    if (pinnedIds.has(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const score = scoreCandidate(entry, false);
    if (score >= MIN_SCORE) scored.push({ id: entry.id, score, rank: rank++ });
  }
  scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
  return new Set(scored.slice(0, maxCandidates).map((s) => s.id));
}

export const _internals = { extractTextLen, scoreCandidate };
