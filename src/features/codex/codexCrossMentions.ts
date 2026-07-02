import type { CodexEntry } from "./api";
import {
  createCodexMatcher,
  parseAliases,
  type CodexMatchTarget,
} from "./codexMatcher";
import { extractPlainText } from "./prosemirrorTextExtractor";

/**
 * 逆 mention 走査の候補行に必要な最小列。M10: chat 経路は icon/notes を
 * 持たない projection 行を渡すため構造的部分型で受ける。
 */
type CrossMentionCandidate = Pick<
  CodexEntry,
  "id" | "summary" | "content" | "updatedAt"
>;

const plainTextCache = new Map<string, { stamp: string; text: string }>();
/**
 * findReverseMentioningEntries の結果メモ。memoKey は候補集合全体の
 * `${id}:${updatedAt}` を含むため、エントリを編集するたびに新キーになる —
 * 素の Map だと Codex スコープ利用中の編集ごとに古いキーが残り続け
 * unbounded に蓄積する (clear はプロジェクト切替時のみ)。挿入順 eviction で
 * 上限を張る (ヒット時は delete+set で再挿入し LRU 化)。
 */
const REVERSE_MEMO_MAX = 64;
const reverseMemoMap = new Map<string, CrossMentionCandidate[]>();

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
export function findReverseMentioningEntries<T extends CrossMentionCandidate>(
  selected: CodexMatchTarget,
  candidates: T[],
): T[] {
  const candidateKey = candidates
    .map((c) => `${c.id}:${c.updatedAt}`)
    .join(",");
  const selectedAliases = parseAliases(selected.aliases);
  const excludedAliases = parseAliases(selected.excludedAliases);
  const memoKey = `${selected.id}:${selected.name}:${selectedAliases.join(",")}:${excludedAliases.join(",")}:${candidateKey}`;
  const cached = reverseMemoMap.get(memoKey);
  if (cached !== undefined) {
    // LRU: ヒットしたキーを末尾へ移し、eviction 対象から遠ざける。
    // memoKey は候補集合の id:updatedAt を含むため、同一キーなら candidates と
    // 同じ行集合 (=同じ T) から選ばれた参照であることが保証される。
    reverseMemoMap.delete(memoKey);
    reverseMemoMap.set(memoKey, cached);
    return cached as T[];
  }

  const matcher = createCodexMatcher([selected]);
  const result: T[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.id === selected.id) continue;
    const text = getEntryScanText(candidate);
    if (text && matcher(text).length > 0 && !seen.has(candidate.id)) {
      seen.add(candidate.id);
      result.push(candidate);
    }
  }
  if (reverseMemoMap.size >= REVERSE_MEMO_MAX) {
    const oldest = reverseMemoMap.keys().next().value;
    if (oldest !== undefined) reverseMemoMap.delete(oldest);
  }
  reverseMemoMap.set(memoKey, result);
  return result;
}

/** Clear all caches. Called on project switch and in tests. */
export function _clearCodexCrossMentionCaches(): void {
  plainTextCache.clear();
  reverseMemoMap.clear();
}

/** Test-only: current reverse-memo size (bounded-growth contract). */
export function _reverseMemoSize(): number {
  return reverseMemoMap.size;
}
