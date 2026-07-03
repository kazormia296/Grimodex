import { db } from "@/db/client";
import { changeEvents } from "@/db/schema";
import { and, eq, gt, ne, asc, desc } from "drizzle-orm";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useTabStore } from "@/features/editor/tabStore";
import {
  useGlobalHistoryStore,
  setUndoConflictHandler,
  setHistoryReplayGuard,
  type HistoryCommand,
  type HistoryKind,
} from "@/store/globalHistoryStore";
import {
  guardInlineAiPending,
  isInlineAiPending,
} from "@/features/editor/inlineAi/pendingGuard";
import { useExternalWriteStore } from "./externalWriteStore";
import {
  useProseStagingStore,
  type PendingProseProposal,
} from "@/features/agent-writes/proseStagingStore";
import { loadLatestProposedProse } from "@/features/agent-writes/prose";

const POLL_MS = 750;

/**
 * Optional handler for incoming MCP/agent prose proposals (headless auto-apply).
 * Injected via {@link setProseProposalHandler} so this low-level concurrency
 * module need not import the heavy auto-apply graph (persistSceneBody → editor
 * side-effects), mirroring the setUndoConflictHandler decoupling above. Returns
 * true if it consumed the proposal (auto-applied) — then it is NOT enqueued into
 * the human review UI; false falls back to the existing diff-UI enqueue.
 */
type ProseProposalHandler = (
  proposal: PendingProseProposal,
  projectId: string,
) => boolean | Promise<boolean>;

let proseProposalHandler: ProseProposalHandler | null = null;

export function setProseProposalHandler(fn: ProseProposalHandler | null): void {
  proseProposalHandler = fn;
}

/**
 * Surface a failed (version-conflict) undo/redo to the user. Defined here — not
 * in globalHistoryStore — so the low-level history store need not import
 * tabStore / externalWriteStore (which would form a module-init cycle with
 * projectStore→treeStore; see setUndoConflictHandler in globalHistoryStore).
 * Registered at module load: externalWriteFeed is imported by projectStore, so
 * the handler is wired before any undo can run in the app.
 */
function domainForHistoryKind(kind: HistoryKind): string | null {
  switch (kind) {
    case "codex":
      return "codex";
    case "snippets":
      return "snippet";
    case "scenes":
      return "grid";
    default:
      return null;
  }
}

function handleUndoConflict(cmd: HistoryCommand): void {
  const entityId = cmd.entityId;
  const domain = domainForHistoryKind(cmd.kind);
  if (!entityId || !domain) return;
  const extStore = useExternalWriteStore.getState();
  const dirtyTabIds = useTabStore.getState().dirtyTabIds;
  if (dirtyTabIds.has(entityId) || isInlineAiPending()) {
    extStore.pushConflict({
      sceneId: entityId,
      domain,
      opType: "undo.version_conflict",
      entityId,
    });
  } else {
    extStore.bumpReloadNonce(entityId);
  }
}

setUndoConflictHandler(handleUndoConflict);

// Veto global undo/redo while an inline-AI diff is pending. Replaying history
// would rebuild the active editor doc out from under the un-accepted generated
// text (data loss). Registered at module load alongside the conflict handler so
// it is wired before any undo can run. Same leaf-DI rationale: globalHistoryStore
// must not import the inline-AI layer directly.
setHistoryReplayGuard(() => guardInlineAiPending());

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
        ? "snippets"
        : entityType === "tree_batch"
          ? "scenes"
          : null;
  if (!kind) return;
  history.invalidateForEntity(kind, entityId);
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
  if (domains.has("foreshadow")) {
    // Dynamic import: foreshadowStore pulls in the editor/scene graph, and
    // this low-level module is imported early — an eager import here would
    // regrow the module-init chain that broke browser-mode vi.mock linking.
    const { useForeshadowStore } =
      await import("@/features/foreshadow/foreshadowStore");
    await useForeshadowStore.getState().load(projectId);
  }
  // 以下 3 ドメインは metadata 系（Rust agent_writes / MCP が記録する）。
  // 従来 fanOut は grid/codex/snippet/foreshadow の 4 ドメインしか反映せず、
  // 別プロセス（MCP 等）が年表(event)・プロット・ラベルを書いても UI が stale
  // なままだった。各ドメインの再ロード権威に合わせて反映する。dynamic import
  // は上の foreshadow と同じ module-init cycle 回避のため。
  if (domains.has("event")) {
    // Chronicle は revisionCounter を購読して listEvents を再クエリするため
    // bumpRevision が再ロードのトリガ（ChroniclePanel useEffect deps）。
    const { useChronicleStore } =
      await import("@/features/chronicle/chronicleStore");
    useChronicleStore.getState().bumpRevision();
  }
  if (domains.has("plot")) {
    const { usePlotThreadStore } =
      await import("@/features/plot-threads/plotThreadStore");
    await usePlotThreadStore.getState().load(projectId);
  }
  if (domains.has("labels")) {
    const { useLabelStore } = await import("@/features/labels/labelStore");
    await useLabelStore.getState().load(projectId);
  }

  const editorEvents = events.filter(
    (e) => e.domain === "editor" && e.sceneId != null,
  );
  const dirtyTabIds = useTabStore.getState().dirtyTabIds;
  const extStore = useExternalWriteStore.getState();
  const inlineAiPending = isInlineAiPending();

  for (const ev of editorEvents) {
    const sceneId = ev.sceneId!;
    invalidateHistoryForEntity(ev.entityType, ev.entityId);
    if (dirtyTabIds.has(sceneId) || inlineAiPending) {
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
      if (!proposal) continue;
      if (proseProposalHandler) {
        let consumed = false;
        try {
          consumed = await proseProposalHandler(proposal, projectId);
        } catch (err) {
          console.warn("[externalWriteFeed] prose auto-apply failed", err);
        }
        if (consumed) continue;
      }
      useProseStagingStore.getState().enqueue(proposal);
    } catch {
      // ignore load failures; user can reopen scene to retry
    }
  }

  // Non-editor entity events may still target codex/snippet tabs open in editor.
  for (const ev of events) {
    if (ev.entityType === "codex_entry" && ev.entityId) {
      invalidateHistoryForEntity(ev.entityType, ev.entityId);
      if (dirtyTabIds.has(ev.entityId) || inlineAiPending) {
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
    if (ev.entityType === "snippet" && ev.entityId) {
      invalidateHistoryForEntity(ev.entityType, ev.entityId);
      if (dirtyTabIds.has(ev.entityId) || inlineAiPending) {
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

async function fetchExternalRows(
  projectId: string,
  cursor: number,
  sessionId: string,
): Promise<ChangeEventRow[]> {
  return db
    .select()
    .from(changeEvents)
    .where(
      and(
        eq(changeEvents.projectId, projectId),
        gt(changeEvents.sequence, cursor),
        ne(changeEvents.sessionId, sessionId),
      ),
    )
    .orderBy(asc(changeEvents.sequence));
}

async function pollTick(): Promise<void> {
  const projectId = state.projectId;
  if (!projectId) return;

  // Everything below runs inside one try/catch. pollTick is fired via
  // `void pollTick()` in setInterval, so ANY throw here (including the DB reads,
  // not just fan-out) escapes as a [Global] unhandled rejection. In particular
  // db_execute can hit ipcQueue's 10s timeout when a native modal dialog blocks
  // IPC dispatch — e.g. the save dialog at the end of a timelapse export. Swallow
  // + log and retain state.cursor (only advanced on success) so the next tick
  // retries the same range instead of crashing the poll or dropping events.
  try {
    const sessionId = getRecorderSessionId();
    let rows = await fetchExternalRows(projectId, state.cursor, sessionId);

    if (rows.length === 0) {
      const tail = await readTailSequence(projectId);
      if (tail > state.cursor) {
        // Re-fetch once: events may have landed between the first query and tail read.
        rows = await fetchExternalRows(projectId, state.cursor, sessionId);
        if (rows.length === 0) {
          state.cursor = tail;
        }
      }
      if (rows.length === 0) return;
    }

    await fanOut(rows);
    state.cursor = rows[rows.length - 1].sequence;
  } catch (err) {
    console.warn("[externalWriteFeed] poll failed; cursor retained", err);
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
