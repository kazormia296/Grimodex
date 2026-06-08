import type { MentionNameResolver } from "@/features/export/exportEngine";
import { useCodexStore } from "./codexStore";

/**
 * Build a {@link MentionNameResolver} that maps a mention node's entry id to the
 * entry's **current** name (snapshot of the codex store at call time), falling
 * back to the label baked into the node for entries the store doesn't know
 * (deleted, or a different project than the one currently loaded).
 *
 * Used by one-way export paths (publish / zip archive) so that renaming a codex
 * entry propagates to exported output — mirroring the live editor display
 * (Item A). NOT used by file-backed write-back: there the baked label is kept to
 * avoid drifting `hashForDiskContent` (mention atoms only exist in DB-backed
 * scenes anyway — a file-backed round-trip lowers them to plain text).
 *
 * Snapshotting into a Map keeps the per-node lookup O(1) across a whole export.
 */
export function currentCodexMentionResolver(): MentionNameResolver {
  const entries = useCodexStore.getState().entries;
  const byId = new Map(entries.map((e) => [e.id, e.name]));
  return (id, fallbackLabel) => byId.get(id) ?? fallbackLabel;
}
