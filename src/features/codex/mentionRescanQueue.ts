import { create } from "zustand";
import { db } from "@/db/client";
import { treeNodes, sceneCodexMentions } from "@/db/schema";
import { eq, and, count, inArray } from "drizzle-orm";
import { upsertSceneBodyMentions } from "@/features/editor/beat/bodyMentionApi";
import { listCodexEntries } from "./api";
import type { CodexMatchTarget } from "./codexMatcher";
import { getCurrentProjectId } from "@/features/project/projectStore";

// ---------------------------------------------------------------------------
// Queue state (Zustand — drives status bar "Scanning... N/Total")
// ---------------------------------------------------------------------------

interface RescanState {
  isRunning: boolean;
  progress: number;
  total: number;
}

export const useRescanStore = create<RescanState>()(() => ({
  isRunning: false,
  progress: 0,
  total: 0,
}));

// ---------------------------------------------------------------------------
// Internal serial queue — prevents concurrent runs
// ---------------------------------------------------------------------------

let runningPromise: Promise<void> | null = null;

async function runRescan(
  allEntries: CodexMatchTarget[],
  scenes: { id: string; content: string }[],
): Promise<void> {
  useRescanStore.setState({
    isRunning: true,
    progress: 0,
    total: scenes.length,
  });

  try {
    for (let i = 0; i < scenes.length; i++) {
      const { id, content } = scenes[i];
      try {
        await upsertSceneBodyMentions(id, content, allEntries);
      } catch {
        // Non-fatal: skip this scene, log nothing to avoid noise
      }
      useRescanStore.setState({ progress: i + 1 });
    }
  } finally {
    runningPromise = null;
    useRescanStore.setState({ isRunning: false, progress: 0, total: 0 });
  }
}

/**
 * Enqueue a full or partial rescan of scene body mentions.
 *
 * - If forEntryId is given, only scenes that currently reference that entry
 *   (or all scenes) are rescanned with the updated pattern set.
 * - If forEntryId is null, all scenes are rescanned (used by "Rebuild" button
 *   and startup backfill).
 *
 * Concurrent calls are coalesced: a new call while a run is in progress is a
 * no-op (the current run already covers the needed work).
 */
export function enqueueRescan(forEntryId: string | null = null): void {
  if (runningPromise !== null) return;

  runningPromise = (async () => {
    const allEntries = await listCodexEntries(getCurrentProjectId());
    const matchTargets: CodexMatchTarget[] = allEntries.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      aliases: e.aliases ?? undefined,
      excludedAliases: e.excludedAliases ?? undefined,
    }));

    // For a partial rescan we still pass all entries to the matcher (changing
    // one entry's pattern can affect other entries' matches via Aho-Corasick).
    // We limit the *scene* set for performance only when a single entry changed.
    let scenes: { id: string; content: string }[];
    if (forEntryId !== null) {
      const projectId = getCurrentProjectId();
      // Scenes that currently mention this entry (source='body').
      const mentioned = await db
        .select({ sceneId: sceneCodexMentions.sceneId })
        .from(sceneCodexMentions)
        .where(
          and(
            eq(sceneCodexMentions.codexEntryId, forEntryId),
            eq(sceneCodexMentions.source, "body"),
          ),
        );
      const mentionedIds = new Set(mentioned.map((r) => r.sceneId));

      if (mentionedIds.size === 0) {
        // Entry currently matches nothing: a name/alias change may newly match
        // anywhere, and this also covers rename re-establishment (the prior
        // rescan stripped every row before the new name existed in prose).
        // Scan every scene.
        scenes = await db
          .select({ id: treeNodes.id, content: treeNodes.content })
          .from(treeNodes)
          .where(
            and(
              eq(treeNodes.nodeType, "scene"),
              eq(treeNodes.projectId, projectId),
            ),
          );
      } else {
        // Rescan scenes that currently mention this entry (their rows may need
        // pruning) OR have no body row yet (never scanned → may hold new
        // matches). Resolve the target scene ids first, then load content for
        // only those scenes via inArray instead of pulling every scene's body.
        const indexed = await db
          .select({ sceneId: sceneCodexMentions.sceneId })
          .from(sceneCodexMentions)
          .where(eq(sceneCodexMentions.source, "body"));
        const indexedIds = new Set(indexed.map((r) => r.sceneId));
        const sceneRows = await db
          .select({ id: treeNodes.id })
          .from(treeNodes)
          .where(
            and(
              eq(treeNodes.nodeType, "scene"),
              eq(treeNodes.projectId, projectId),
            ),
          );
        const targetIds = sceneRows
          .map((r) => r.id)
          .filter((id) => mentionedIds.has(id) || !indexedIds.has(id));
        scenes =
          targetIds.length === 0
            ? []
            : await db
                .select({ id: treeNodes.id, content: treeNodes.content })
                .from(treeNodes)
                .where(inArray(treeNodes.id, targetIds));
      }
    } else {
      scenes = await db
        .select({ id: treeNodes.id, content: treeNodes.content })
        .from(treeNodes)
        .where(
          and(
            eq(treeNodes.nodeType, "scene"),
            eq(treeNodes.projectId, getCurrentProjectId()),
          ),
        );
    }

    await runRescan(matchTargets, scenes);
  })().catch(() => {
    runningPromise = null;
    useRescanStore.setState({ isRunning: false, progress: 0, total: 0 });
  });
}

/**
 * Check if a startup backfill is needed: returns true when fewer than 80% of
 * scenes have a body mention row.
 */
export async function needsBodyBackfill(): Promise<boolean> {
  const [sceneCountRow] = await db
    .select({ c: count() })
    .from(treeNodes)
    .where(
      and(
        eq(treeNodes.nodeType, "scene"),
        eq(treeNodes.projectId, getCurrentProjectId()),
      ),
    );
  const sceneCount = sceneCountRow?.c ?? 0;
  if (sceneCount === 0) return false;

  const [bodyCountRow] = await db
    .select({ c: count() })
    .from(sceneCodexMentions)
    .where(eq(sceneCodexMentions.source, "body"));
  const bodyCount = bodyCountRow?.c ?? 0;

  // bodyCount counts (scene, entry) pairs, not unique scenes.
  // Use sceneCount as the threshold proxy: if no body rows exist at all, backfill.
  return bodyCount === 0 || bodyCount / sceneCount < 0.8;
}
