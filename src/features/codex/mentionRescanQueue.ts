import { create } from "zustand";
import { db } from "@/db/client";
import { treeNodes, sceneCodexMentions } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { upsertSceneBodyMentions } from "@/features/editor/beat/bodyMentionApi";
import { listCodexMatchTargets } from "./api";
import type { CodexMatchTarget } from "./codexMatcher";
import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  isBodyMentionIndexReady,
  recordBodyMentionScans,
  type BodyMentionSceneRevision,
} from "./bodyMentionIndexState";

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
  projectId: string,
  allEntries: CodexMatchTarget[],
  scenes: Array<{
    id: string;
    content: string;
    version: number;
    updatedAt: string;
  }>,
): Promise<void> {
  useRescanStore.setState({
    isRunning: true,
    progress: 0,
    total: scenes.length,
  });

  const successfulScans: BodyMentionSceneRevision[] = [];
  try {
    for (let i = 0; i < scenes.length; i++) {
      const { id, content } = scenes[i];
      try {
        await upsertSceneBodyMentions(id, content, allEntries);
        successfulScans.push({
          sceneId: id,
          version: scenes[i].version,
          updatedAt: scenes[i].updatedAt,
        });
      } catch {
        // Non-fatal: skip this scene, log nothing to avoid noise
      }
      useRescanStore.setState({ progress: i + 1 });
    }
    await recordBodyMentionScans(projectId, allEntries, successfulScans);
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
export function enqueueRescan(
  forEntryId: string | null = null,
  projectId: string = getCurrentProjectId(),
): Promise<void> {
  if (runningPromise !== null) return runningPromise;

  const scheduled = (async () => {
    const allEntries = await listCodexMatchTargets(projectId);
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
    let scenes: Array<{
      id: string;
      content: string;
      version: number;
      updatedAt: string;
    }>;
    if (forEntryId !== null) {
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
          .select({
            id: treeNodes.id,
            content: treeNodes.content,
            version: treeNodes.version,
            updatedAt: treeNodes.updatedAt,
          })
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
                .select({
                  id: treeNodes.id,
                  content: treeNodes.content,
                  version: treeNodes.version,
                  updatedAt: treeNodes.updatedAt,
                })
                .from(treeNodes)
                .where(inArray(treeNodes.id, targetIds));
      }
    } else {
      scenes = await db
        .select({
          id: treeNodes.id,
          content: treeNodes.content,
          version: treeNodes.version,
          updatedAt: treeNodes.updatedAt,
        })
        .from(treeNodes)
        .where(
          and(
            eq(treeNodes.nodeType, "scene"),
            eq(treeNodes.projectId, projectId),
          ),
        );
    }

    await runRescan(projectId, matchTargets, scenes);
  })().catch(() => {
    runningPromise = null;
    useRescanStore.setState({ isRunning: false, progress: 0, total: 0 });
  });
  runningPromise = scheduled;
  return scheduled;
}

/**
 * Check whether every current scene revision has been scanned with the current
 * Codex matcher inputs. Zero-mention scenes are represented by the state marker.
 */
export async function needsBodyBackfill(
  projectId: string = getCurrentProjectId(),
): Promise<boolean> {
  const entries = await listCodexMatchTargets(projectId);
  return !(await isBodyMentionIndexReady(projectId, entries));
}
