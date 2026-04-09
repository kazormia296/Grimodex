import { invoke } from "@/lib/tauri";
import {
  createCodexMatcher,
  findMentionedEntries,
  type CodexMatch,
  type CodexMatchTarget,
} from "./codexMatcher";

// ---------------------------------------------------------------------------
// Tauri availability
// ---------------------------------------------------------------------------

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ---------------------------------------------------------------------------
// Entry hash for change detection (skip rebuild when entries unchanged)
// ---------------------------------------------------------------------------

let lastEntriesHash = "";

function hashEntries(entries: CodexMatchTarget[]): string {
  return entries
    .map(
      (e) =>
        `${e.id}:${e.name}:${e.type}:${JSON.stringify(e.aliases ?? [])}:${JSON.stringify(e.excludedAliases ?? [])}`,
    )
    .join("|");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rebuild the Rust-side Aho-Corasick matcher with the given entries.
 * Skips the IPC call when entries are unchanged.
 * Falls back to a no-op when Tauri is not available (browser / test env).
 */
export async function rebuildMatcher(
  entries: CodexMatchTarget[],
): Promise<void> {
  if (!isTauri()) return;

  const hash = hashEntries(entries);
  if (hash === lastEntriesHash) return;
  lastEntriesHash = hash;

  const rustEntries = entries.map((e) => ({
    id: e.id,
    name: e.name,
    entryType: e.type,
    aliases: Array.isArray(e.aliases)
      ? (e.aliases as string[])
      : e.aliases
        ? (JSON.parse(e.aliases as string) as string[])
        : [],
    excludedAliases: Array.isArray(e.excludedAliases)
      ? (e.excludedAliases as string[])
      : e.excludedAliases
        ? (JSON.parse(e.excludedAliases as string) as string[])
        : [],
  }));

  await invoke<void>("codex_rebuild_matcher", { entries: rustEntries });
}

/**
 * Match `text` against the current Rust matcher.
 * Falls back to the JS `createCodexMatcher` when Tauri is not available.
 */
export async function matchText(
  text: string,
  entries: CodexMatchTarget[],
  excludeEntryIds: string[] = [],
): Promise<CodexMatch[]> {
  if (!isTauri()) {
    const matcher = createCodexMatcher(entries);
    return matcher(text).filter((m) => !excludeEntryIds.includes(m.entryId));
  }
  return invoke<CodexMatch[]>("codex_match_text", {
    text,
    excludeEntryIds,
  });
}

/**
 * Rebuild matcher (if needed) then match, returning deduplicated CodexMatchTarget list.
 * One-shot wrapper for callers that just need "which entries are mentioned".
 */
export async function findMentionedEntriesAsync(
  text: string,
  entries: CodexMatchTarget[],
): Promise<CodexMatchTarget[]> {
  if (!text || entries.length === 0) return [];

  if (!isTauri()) {
    return findMentionedEntries(text, entries);
  }

  await rebuildMatcher(entries);
  const matches = await matchText(text, entries);

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
