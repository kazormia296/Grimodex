/** 診断（diagnostic only）専用。種を固定した決定的な case の選び方。 */

function hashSeed(seed: string): number {
  // FNV-1a（32 bit）
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ids を昇順に並べてから seed で Fisher-Yates し、先頭 count 件を昇順で返す。 */
export function seededPick(
  ids: readonly string[],
  count: number,
  seed: string,
): string[] {
  const sorted = [...ids].sort();
  if (count > sorted.length) {
    throw new RangeError(`cannot pick ${count} of ${sorted.length}`);
  }
  const random = mulberry32(hashSeed(seed));
  for (let i = sorted.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [sorted[i], sorted[j]] = [sorted[j]!, sorted[i]!];
  }
  return sorted.slice(0, count).sort();
}

export const DIAG_SELECTION_SEED = "chronicle-prompt-cache-diag/v1";
export const DIAG_SELECTION_PLAN = [
  { suiteId: "chronicle-micro-v1", count: 3 },
  { suiteId: "chronicle-motif-boundary-v1", count: 2 },
] as const;
