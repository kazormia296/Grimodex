import { isValidBoundary } from "./charClassBoundary";

export interface CodexMatchTarget {
  id: string;
  name: string;
  type: string;
  /** Parsed string array or raw JSON string from DB */
  aliases?: string[] | string | null;
  /** Parsed string array or raw JSON string from DB */
  excludedAliases?: string[] | string | null;
}

export function parseAliases(
  raw: string[] | string | null | undefined,
): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export interface CodexMatch {
  entryId: string;
  entryName: string;
  entryType: string;
  from: number;
  to: number;
}

/** Escape regex special characters */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Check if a string is purely Latin letters/digits/underscore */
function isPureLatinWord(s: string): boolean {
  return /^[A-Za-z0-9_]+$/u.test(s);
}

interface PatternEntry {
  pattern: string;
  length: number;
  entryId: string;
  entryName: string;
  entryType: string;
}

/**
 * Build a reusable matcher from codex entries.
 * Returns a function that scans text and returns all match positions.
 *
 * - Names + aliases all participate in matching
 * - Excluded aliases are applied as post-filter (covers-based exclusion)
 * - CJK boundary validation applied after exclusion
 * - Longest match wins when two matches overlap
 * - Case-insensitive for Latin names
 */
export function createCodexMatcher(
  entries: CodexMatchTarget[],
): (text: string) => CodexMatch[] {
  if (entries.length === 0) return () => [];

  // Collect all (pattern, entry) pairs
  const patterns: PatternEntry[] = [];
  for (const entry of entries) {
    const names = [entry.name, ...parseAliases(entry.aliases)].filter(Boolean);
    for (const name of names) {
      patterns.push({
        pattern: name,
        length: name.length,
        entryId: entry.id,
        entryName: entry.name,
        entryType: entry.type,
      });
    }
  }

  // Sort by pattern length desc (longest first for priority in alternation)
  patterns.sort((a, b) => b.length - a.length);

  // Build regex alternatives
  const alternatives = patterns.map((p) => {
    const escaped = escapeRegex(p.pattern);
    return isPureLatinWord(p.pattern) ? `\\b${escaped}\\b` : escaped;
  });

  const regex = new RegExp(alternatives.join("|"), "gi");

  // Build lookup map: lower-case pattern → PatternEntry
  const patternMap = new Map<string, PatternEntry>();
  for (const p of patterns) {
    const key = p.pattern.toLowerCase();
    if (!patternMap.has(key)) {
      patternMap.set(key, p);
    }
  }

  // Build exclusion map: entryId → excluded strings
  const exclusionMap = new Map<string, string[]>();
  for (const entry of entries) {
    const excls = parseAliases(entry.excludedAliases).filter(Boolean);
    if (excls.length > 0) {
      exclusionMap.set(entry.id, excls);
    }
  }

  return (text: string): CodexMatch[] => {
    if (!text) return [];

    // Step 1: collect raw regex matches
    const raw: Array<{
      from: number;
      to: number;
      matched: string;
      pe: PatternEntry;
    }> = [];

    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const matched = m[0];
      const pe = patternMap.get(matched.toLowerCase());
      if (pe) {
        raw.push({ from: m.index, to: m.index + matched.length, matched, pe });
      }
    }

    // Step 2: apply exclusion patterns (excluded aliases)
    const afterExclusion = raw.filter(({ from, to, pe }) => {
      const excluded = exclusionMap.get(pe.entryId);
      if (!excluded || excluded.length === 0) return true;
      // Check if any exclusion pattern covers this match position
      for (const excl of excluded) {
        const exclRegex = new RegExp(escapeRegex(excl), "gi");
        let em: RegExpExecArray | null;
        while ((em = exclRegex.exec(text)) !== null) {
          // If exclusion covers [from, to), discard this match
          if (em.index <= from && em.index + excl.length >= to) {
            return false;
          }
        }
      }
      return true;
    });

    // Step 3: apply CJK boundary check
    const afterBoundary = afterExclusion.filter(({ from, to }) =>
      isValidBoundary(text, from, to),
    );

    // Step 4: resolve overlapping matches — longer wins (already sorted by pattern length, so first match at a position wins)
    const result: CodexMatch[] = [];
    const covered = new Set<number>();
    // Sort by position, then by length desc (longer pattern wins at same position)
    afterBoundary.sort((a, b) => {
      if (a.from !== b.from) return a.from - b.from;
      return b.pe.length - a.pe.length;
    });
    for (const { from, to, pe } of afterBoundary) {
      // Skip if any position in [from, to) is already covered
      let overlap = false;
      for (let i = from; i < to; i++) {
        if (covered.has(i)) {
          overlap = true;
          break;
        }
      }
      if (overlap) continue;
      for (let i = from; i < to; i++) covered.add(i);
      result.push({
        entryId: pe.entryId,
        entryName: pe.entryName,
        entryType: pe.entryType,
        from,
        to,
      });
    }

    // Sort by position
    result.sort((a, b) => a.from - b.from);
    return result;
  };
}

/**
 * Find which codex entries are mentioned in text (de-duplicated).
 */
export function findMentionedEntries(
  text: string,
  entries: CodexMatchTarget[],
): CodexMatchTarget[] {
  if (!text || entries.length === 0) return [];

  const matcher = createCodexMatcher(entries);
  const matches = matcher(text);

  const seen = new Set<string>();
  const result: CodexMatchTarget[] = [];
  for (const m of matches) {
    if (!seen.has(m.entryId)) {
      seen.add(m.entryId);
      const entry = entries.find((e) => e.id === m.entryId);
      if (entry) result.push(entry);
    }
  }

  return result;
}
