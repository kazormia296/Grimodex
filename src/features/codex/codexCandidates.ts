/**
 * codexCandidates.ts — 未確定固有名詞候補の純ロジック (描画・副作用なし)。
 *
 * - `candidateKey`: 却下キー / 既存エントリ照合のための安定キー。Rust 側の
 *   `normalize_name` (trim + lowercase) と揃える。
 * - `knownNameSet` / `activeCandidates`: 受理直後に該当候補を即時消し込みする
 *   ためのクライアント側フィルタ (Rust は本文スキャン時点の既知を引いているが、
 *   UI で受理した直後はまだ再スキャンしていないため entries と再照合する)。
 */
import { parseAliases } from "./codexMatcher";
import type { CodexCandidate } from "./candidateExtractor";

/**
 * 候補/エントリ名の正規化キー。**Rust 側 `normalize_name` (codex_candidates.rs) と
 * 必ず同じ規則**に保つこと: trim → NFC → 小文字化。NFC を挟むのは固有名詞の
 * NFC/NFD 揺れ (濁点付き仮名・macOS 由来の分解形等) で重複検出が外れないようにするため。
 */
export function candidateKey(surface: string): string {
  return surface.trim().normalize("NFC").toLowerCase();
}

/** entries の name + aliases を正規化した既知名集合。 */
export function knownNameSet(
  entries: ReadonlyArray<{ name: string | null; aliases: string | null }>,
): Set<string> {
  const set = new Set<string>();
  for (const e of entries) {
    const n = candidateKey(e.name ?? "");
    if (n) set.add(n);
    for (const alias of parseAliases(e.aliases)) {
      const k = candidateKey(alias);
      if (k) set.add(k);
    }
  }
  return set;
}

/**
 * 既に Codex に存在する (= 受理済み) 候補を除外する。却下フィルタは別 (UI 側で
 * dismissed 集合と突合)。
 */
export function activeCandidates(
  candidates: ReadonlyArray<CodexCandidate>,
  entries: ReadonlyArray<{ name: string | null; aliases: string | null }>,
): CodexCandidate[] {
  const known = knownNameSet(entries);
  return candidates.filter((c) => !known.has(candidateKey(c.surface)));
}
