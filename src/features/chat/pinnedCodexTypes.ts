export interface PinnedCodexEntry {
  id: string;
  withChildren?: boolean;
}

/**
 * Normalize raw pinnedCodex JSON to PinnedCodexEntry[].
 * Supports both old format (string[]) and new format (PinnedCodexEntry[]).
 */
export function normalizePinnedCodex(raw: unknown): PinnedCodexEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): PinnedCodexEntry | null => {
      if (typeof item === "string") return { id: item, withChildren: false };
      if (
        item !== null &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).id === "string"
      ) {
        return {
          id: (item as Record<string, unknown>).id as string,
          withChildren: (item as Record<string, unknown>).withChildren === true,
        };
      }
      return null;
    })
    .filter((item): item is PinnedCodexEntry => item !== null);
}
