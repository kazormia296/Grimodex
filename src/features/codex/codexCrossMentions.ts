import type { CodexEntry } from "./api";
import {
  createCodexMatcher,
  parseAliases,
  type CodexMatchTarget,
} from "./codexMatcher";
import { extractPlainText } from "./prosemirrorTextExtractor";

const plainTextCache = new Map<string, { stamp: string; text: string }>();
let reverseMemo: { key: string; result: CodexEntry[] } | null = null;

/** summary + content(PM JSON→plain) の走査用テキスト。updatedAt キーでメモ化 */
export function getEntryScanText(entry: {
  id: string;
  summary: string | null;
  content: string;
  updatedAt: string;
}): string {
  const cached = plainTextCache.get(entry.id);
  if (cached && cached.stamp === entry.updatedAt) return cached.text;
  const text =
    `${entry.summary ?? ""}\n${extractPlainText(entry.content)}`.trim();
  plainTextCache.set(entry.id, { stamp: entry.updatedAt, text });
  return text;
}

/** 逆方向: selected(name+aliases) が candidates の summary+content 中で言及されるエントリ */
export function findReverseMentioningEntries(
  selected: CodexMatchTarget,
  candidates: CodexEntry[],
): CodexEntry[] {
  const candidateKey = candidates
    .map((c) => `${c.id}:${c.updatedAt}`)
    .join(",");
  const selectedAliases = parseAliases(selected.aliases);
  const memoKey = `${selected.id}:${selected.name}:${selectedAliases.join(",")}:${candidateKey}`;
  if (reverseMemo?.key === memoKey) return reverseMemo.result;

  const matcher = createCodexMatcher([selected]);
  const result: CodexEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.id === selected.id) continue;
    const text = getEntryScanText(candidate);
    if (text && matcher(text).length > 0 && !seen.has(candidate.id)) {
      seen.add(candidate.id);
      result.push(candidate);
    }
  }
  reverseMemo = { key: memoKey, result };
  return result;
}

/** @internal test helper */
export function _clearCodexCrossMentionCaches(): void {
  plainTextCache.clear();
  reverseMemo = null;
}
