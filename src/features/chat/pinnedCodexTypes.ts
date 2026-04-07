export interface PinnedCodexEntry {
  id: string;
  withChildren?: boolean;
  source?: "manual" | "chat_mention";
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
        const obj = item as Record<string, unknown>;
        const rawSource = obj.source;
        const source: "manual" | "chat_mention" | undefined =
          rawSource === "manual" || rawSource === "chat_mention"
            ? rawSource
            : undefined;
        return {
          id: obj.id as string,
          withChildren: obj.withChildren === true,
          source,
        };
      }
      return null;
    })
    .filter((item): item is PinnedCodexEntry => item !== null);
}
