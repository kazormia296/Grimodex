import type {
  CodexContextEntry,
  CodexContextMetadataEntry,
} from "@/features/codex/api";

const EMPTY_CODEX_CONTENT = "{}";

export type CodexContextIndexEntry = CodexContextMetadataEntry &
  Pick<CodexContextEntry, "content">;

export type CodexNameLookupEntry = Pick<CodexContextEntry, "id" | "name">;

export function stripCodexContent(
  entry: CodexContextEntry,
): CodexContextMetadataEntry {
  const { content: _content, ...metadata } = entry;
  return metadata;
}

export function toCodexContextIndexEntry(
  entry: CodexContextMetadataEntry,
): CodexContextIndexEntry {
  return { ...entry, content: EMPTY_CODEX_CONTENT };
}

export function toCodexContextIndexEntries(
  entries: readonly CodexContextMetadataEntry[],
): CodexContextIndexEntry[] {
  return entries.map(toCodexContextIndexEntry);
}

export function uniqueIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)];
}

export function entriesById<T extends { id: string }>(
  entries: readonly T[],
): Map<string, T> {
  return new Map(entries.map((entry) => [entry.id, entry] as const));
}

export function orderEntriesByIds<T extends { id: string }>(
  ids: Iterable<string>,
  entries: readonly T[],
): T[] {
  const byId = entriesById(entries);
  return uniqueIds(ids).flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [entry] : [];
  });
}
