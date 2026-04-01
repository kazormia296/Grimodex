export interface CodexMatchTarget {
  id: string;
  name: string;
  type: string;
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

/** Check if a string is purely word characters (letters/digits/underscore) */
function isPureWord(s: string): boolean {
  return /^\w+$/u.test(s);
}

/**
 * Build a reusable matcher from codex entries.
 * Returns a function that scans text and returns all match positions.
 *
 * - Names sorted longest-first (longer match wins in alternation)
 * - Latin names use word boundaries; CJK names match as substrings
 * - Case-insensitive
 */
export function createCodexMatcher(
  entries: CodexMatchTarget[],
): (text: string) => CodexMatch[] {
  if (entries.length === 0) return () => [];

  // Build lookup: escaped pattern -> entry (longest first for priority)
  const sorted = [...entries].sort((a, b) => b.name.length - a.name.length);

  // Build alternation pattern, wrapping Latin-only names in \b
  const alternatives = sorted.map((e) => {
    const escaped = escapeRegex(e.name);
    // Only use \b for pure-word names (Latin letters/digits)
    // CJK or names with special chars (e.g. "C.C.") match as substrings
    return isPureWord(e.name) ? `\\b${escaped}\\b` : escaped;
  });

  const regex = new RegExp(alternatives.join("|"), "gi");

  // Build a name->entry map for fast lookup (case-insensitive for Latin)
  const entryByName = new Map<string, CodexMatchTarget>();
  for (const e of sorted) {
    entryByName.set(e.name.toLowerCase(), e);
  }

  return (text: string): CodexMatch[] => {
    if (!text) return [];

    const matches: CodexMatch[] = [];
    regex.lastIndex = 0;

    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const matched = m[0];
      const entry = entryByName.get(matched.toLowerCase());
      if (entry) {
        matches.push({
          entryId: entry.id,
          entryName: entry.name,
          entryType: entry.type,
          from: m.index,
          to: m.index + matched.length,
        });
      }
    }

    return matches;
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
