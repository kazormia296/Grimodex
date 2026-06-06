import { db } from "@/db/client";
import { changeEvents } from "@/db/schema";
import { and, eq, gt, ne, asc, desc } from "drizzle-orm";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useExternalWriteStore } from "./externalWriteStore";
import { useProseStagingStore } from "@/features/agent-writes/proseStagingStore";
import { loadLatestProposedProse } from "@/features/agent-writes/prose";

const POLL_MS = 750;

interface PollerState {
  projectId: string | null;
  cursor: number;
  timer: ReturnType<typeof setInterval> | null;
}

const state: PollerState = {
  projectId: null,
  cursor: 0,
  timer: null,
};

type ChangeEventRow = typeof changeEvents.$inferSelect;

async function readTailSequence(projectId: string): Promise<number> {
  const rows = await db
    .select({ sequence: changeEvents.sequence })
    .from(changeEvents)
    .where(eq(changeEvents.projectId, projectId))
    .orderBy(desc(changeEvents.sequence))
    .limit(1);
  return rows[0]?.sequence ?? 0;
}

function invalidateHistoryForEntity(
  entityType: string | null,
  entityId: string | null,
): void {
  if (!entityId) return;
  const history = useGlobalHistoryStore.getState();
  // Best-effort: external write on a tracked entity invalidates fragile closures.
  const kind =
    entityType === "codex_entry"
      ? "codex"
      : entityType === "snippet"
        ? "snippet"
        : entityType === "tree_batch"
          ? "scenes"
          : null;
  if (!kind) return;
  void history; // push stack lacks per-entry invalidation API; Phase 3 surfaces conflict instead.
}

async function fanOut(events: ChangeEventRow[]): Promise<void> {
  const domains = new Set(events.map((e) => e.domain));
  const projectId = state.projectId;
  if (!projectId) return;

  if (domains.has("grid")) {
    await useTreeStore.getState().reloadTreeOrThrow(projectId);
  }
  if (domains.has("codex")) {
    await useCodexStore.getState().loadEntries();
  }
  if (domains.has("snippet")) {
    await useSnippetStore.getState().loadEntries();
  }

  const editorEvents = events.filter(
    (e) => e.domain === "editor" && e.sceneId != null,
  );
  const dirtyTabIds = useTabStore.getState().dirtyTabIds;
  const extStore = useExternalWriteStore.getState();

  for (const ev of editorEvents) {
    const sceneId = ev.sceneId!;
    invalidateHistoryForEntity(ev.entityType, ev.entityId);
    if (dirtyTabIds.has(sceneId)) {
      extStore.pushConflict({
        sceneId,
        domain: ev.domain,
        opType: ev.opType,
        entityId: ev.entityId,
      });
    } else {
      extStore.bumpReloadNonce(sceneId);
    }
  }

  const proseProposals = events.filter(
    (e) => e.domain === "prose" && e.opType === "prose.propose" && e.sceneId,
  );
  const proseSceneIds = [...new Set(proseProposals.map((e) => e.sceneId!))];
  for (const sceneId of proseSceneIds) {
    try {
      const proposal = await loadLatestProposedProse(sceneId);
      if (proposal) {
        useProseStagingStore.getState().enqueue(proposal);
      }
    } catch {
      // ignore load failures; user can reopen scene to retry
    }
  }

  // Non-editor entity events may still target codex/snippet tabs open in editor.
  for (const ev of events) {
    if (ev.entityType === "codex_entry" && ev.entityId) {
      invalidateHistoryForEntity(ev.entityType, ev.entityId);
      if (dirtyTabIds.has(ev.entityId)) {
        extStore.pushConflict({
          sceneId: ev.entityId,
          domain: ev.domain,
          opType: ev.opType,
          entityId: ev.entityId,
        });
      } else {
        extStore.bumpReloadNonce(ev.entityId);
      }
    }
  }
}

async function pollTick(): Promise<void> {
  const projectId = state.projectId;
  if (!projectId) return;

  const sessionId = getRecorderSessionId();
  const rows = await db
    .select()
    .from(changeEvents)
    .where(
      and(
        eq(changeEvents.projectId, projectId),
        gt(changeEvents.sequence, state.cursor),
        ne(changeEvents.sessionId, sessionId),
      ),
    )
    .orderBy(asc(changeEvents.sequence));

  if (rows.length === 0) return;

  try {
    await fanOut(rows);
    state.cursor = rows[rows.length - 1].sequence;
  } catch (err) {
    console.warn("[externalWriteFeed] fan-out failed; cursor retained", err);
  }
}

/** Start polling external change_events for the given project. */
export async function startExternalWriteFeed(projectId: string): Promise<void> {
  stopExternalWriteFeed();
  state.projectId = projectId;
  state.cursor = await readTailSequence(projectId);
  useExternalWriteStore.getState().clear();
  state.timer = setInterval(() => {
    void pollTick();
  }, POLL_MS);
}

/** Stop polling (project switch / workspace close). */
export function stopExternalWriteFeed(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.projectId = null;
  state.cursor = 0;
  useExternalWriteStore.getState().clear();
}

/** Test hook: run fan-out for explicit events (no DB). */
export async function processExternalEventsForTest(
  events: ChangeEventRow[],
  projectId: string,
): Promise<void> {
  state.projectId = projectId;
  await fanOut(events);
}

/** Test hook: run one poll cycle synchronously. */
export async function pollExternalWritesForTest(): Promise<void> {
  await pollTick();
}

/** Test hook: read poller cursor. */
export function getExternalWriteCursorForTest(): number {
  return state.cursor;
}
