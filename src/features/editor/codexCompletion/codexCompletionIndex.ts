import { parseAliases } from "@/features/codex/codexMatcher";
import type {
  CodexCompletionCandidate,
  CodexCompletionSourceEntry,
} from "./codexCompletionTypes";

export type {
  CodexCompletionCandidate,
  CodexCompletionSourceEntry,
} from "./codexCompletionTypes";

export interface CodexCompletionIndex {
  /** All candidates in deterministic display/ranking order. */
  all(): CodexCompletionCandidate[];
  /** Prefix matches in the order in which a single ghost candidate is chosen. */
  find(prefix: string): CodexCompletionCandidate[];
}

function normalizeSurface(surface: string): string {
  return surface.normalize("NFC").toLowerCase();
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function firstGrapheme(text: string): string {
  return (
    GRAPHEME_SEGMENTER.segment(text)[Symbol.iterator]().next().value?.segment ??
    ""
  );
}

function parseStringArray(raw: string[] | string | null | undefined): string[] {
  const parsed = parseAliases(raw);
  return parsed.filter((value): value is string => typeof value === "string");
}

const SURFACE_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" });

function compareSurface(
  a: CodexCompletionCandidate,
  b: CodexCompletionCandidate,
): number {
  return (
    SURFACE_COLLATOR.compare(a.surface, b.surface) ||
    a.entryId.localeCompare(b.entryId)
  );
}

function compareForPrefix(
  prefix: string,
  a: CodexCompletionCandidate,
  b: CodexCompletionCandidate,
): number {
  const aCaseExact = a.surface.startsWith(prefix) ? 0 : 1;
  const bCaseExact = b.surface.startsWith(prefix) ? 0 : 1;
  if (aCaseExact !== bCaseExact) return aCaseExact - bCaseExact;

  const aSource = a.source === "name" ? 0 : 1;
  const bSource = b.source === "name" ? 0 : 1;
  if (aSource !== bSource) return aSource - bSource;

  const prefixLength = prefix.normalize("NFC").length;
  const aRemaining = a.normalizedSurface.length - prefixLength;
  const bRemaining = b.normalizedSurface.length - prefixLength;
  if (aRemaining !== bRemaining) return aRemaining - bRemaining;

  return compareSurface(a, b);
}

/** Build an immutable, local-only index from the already-loaded Codex rows. */
export function buildCodexCompletionIndex(
  entries: readonly CodexCompletionSourceEntry[],
): CodexCompletionIndex {
  const bySurface = new Map<string, CodexCompletionCandidate>();

  for (const entry of entries) {
    const excludedAliases = new Set(parseStringArray(entry.excludedAliases));
    const values: Array<{ surface: string; source: "name" | "alias" }> = [
      { surface: entry.name, source: "name" },
      ...parseStringArray(entry.aliases).map((surface) => ({
        surface,
        source: "alias" as const,
      })),
    ];

    for (const { surface, source } of values) {
      if (surface.trim() === "") continue;
      if (source === "alias" && excludedAliases.has(surface)) continue;

      const candidate: CodexCompletionCandidate = {
        entryId: entry.id,
        surface,
        canonicalName: entry.name,
        source,
        type: entry.type,
        normalizedSurface: normalizeSurface(surface),
      };
      const existing = bySurface.get(candidate.normalizedSurface);
      if (
        !existing ||
        (existing.source === "alias" && candidate.source === "name") ||
        (existing.source === candidate.source &&
          candidate.entryId.localeCompare(existing.entryId) < 0)
      ) {
        bySurface.set(candidate.normalizedSurface, candidate);
      }
    }
  }

  const candidates = [...bySurface.values()].sort(compareSurface);
  const candidatesByInitial = new Map<string, CodexCompletionCandidate[]>();
  for (const candidate of candidates) {
    const initial = firstGrapheme(candidate.normalizedSurface);
    const bucket = candidatesByInitial.get(initial) ?? [];
    bucket.push(candidate);
    candidatesByInitial.set(initial, bucket);
  }

  return {
    all: () => [...candidates],
    find(prefix) {
      if (prefix.length === 0) return [];
      const normalizedPrefix = normalizeSurface(prefix);
      const pool =
        candidatesByInitial.get(firstGrapheme(normalizedPrefix)) ?? [];
      return pool
        .filter(
          (candidate) =>
            candidate.normalizedSurface.startsWith(normalizedPrefix) &&
            candidate.normalizedSurface !== normalizedPrefix,
        )
        .sort((a, b) => compareForPrefix(prefix, a, b));
    },
  };
}
