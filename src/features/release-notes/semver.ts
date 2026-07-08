/** "0.10.4" 形式の semver セグメント比較。pre-release 非対応。 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

/** lastSeen が null/undefined なら false（初回判定は gate 側で別処理）。 */
export function isNewer(
  current: string,
  lastSeen: string | null | undefined,
): boolean {
  if (lastSeen == null || lastSeen === "") return false;
  return compareSemver(current, lastSeen) > 0;
}
