import i18next from "i18next";

import { invoke } from "@/lib/tauri";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useChronicleStore } from "@/features/chronicle/chronicleStore";
import { scheduleEventIndex } from "@/features/semantic-search/scheduler";
import { notifySameRendererDocumentWrite } from "@/features/concurrency/documentWriteNotification";
import { isUnknownIpcOutcomeError } from "@/lib/ipcOutcome";
import { createPendingCreateRequestRegistry } from "@/lib/pendingCreateRequestRegistry";
import {
  captureMutationAuthority,
  isCurrentMutationAuthority,
  runAuthoritativeMutation,
} from "@/features/concurrency/mutationAuthority";
import { applyUndoJournal } from "./undoJournal";

type ChronicleGranularity =
  | "none"
  | "season"
  | "year"
  | "month"
  | "day"
  | "time";

export type ChronicleBulkOperation =
  | { kind: "eventDelete"; eventId: string; baseVersion: number }
  | { kind: "eventClearDate"; eventId: string; baseVersion: number }
  | {
      kind: "eventSetLane";
      eventId: string;
      baseVersion: number;
      primaryCodexId: string | null;
      laneGroup: string | null;
    }
  | {
      kind: "eventSetDate";
      eventId: string;
      baseVersion: number;
      startTime: number;
      startMinute: number | null;
      startGranularity: Exclude<ChronicleGranularity, "none">;
      endTime: number | null;
      endMinute: number | null;
      endGranularity: ChronicleGranularity;
    }
  | { kind: "sceneClearDate"; sceneId: string; baseUpdatedAt: string }
  | {
      kind: "sceneSetPov";
      sceneId: string;
      baseUpdatedAt: string;
      povCharacterId: string | null;
    }
  | {
      kind: "sceneSetDate";
      sceneId: string;
      baseUpdatedAt: string;
      startTime: number;
      startMinute: number | null;
      startGranularity: Exclude<ChronicleGranularity, "none">;
      endTime: number | null;
      endMinute: number | null;
      endGranularity: ChronicleGranularity;
    };

export interface ChronicleBulkMutationResult {
  eventResults: Array<{
    kind: "eventDelete" | "eventClearDate" | "eventSetLane" | "eventSetDate";
    eventId: string;
    version: number | null;
  }>;
  sceneResults: Array<{
    kind: "sceneClearDate" | "sceneSetPov" | "sceneSetDate";
    sceneId: string;
    updatedAt: string;
  }>;
  changeEventUid: string;
  undoJournalId: string;
}

type ReplayDirection = "initial" | "undo" | "redo";

interface ChronicleBulkInvokePayload {
  requestId: string;
  projectId: string;
  sessionId: string;
  surface: "manual";
  operations: ChronicleBulkOperation[];
}

const pendingBulkMutations =
  createPendingCreateRequestRegistry<ChronicleBulkInvokePayload>();
const inFlightBulkMutations = new Map<
  string,
  Promise<ChronicleBulkMutationResult>
>();

function publishEventEffects(
  operations: readonly ChronicleBulkOperation[],
  direction: ReplayDirection,
): void {
  for (const operation of operations) {
    if (operation.kind === "eventDelete") {
      const opType = direction === "undo" ? "event.create" : "event.delete";
      notifySameRendererDocumentWrite(
        { kind: "chronicle-event", id: operation.eventId },
        { domain: "event", opType, entityId: operation.eventId },
      );
      if (direction === "undo") {
        scheduleEventIndex(operation.eventId);
      }
      continue;
    }
    if (
      operation.kind === "eventClearDate" ||
      operation.kind === "eventSetLane" ||
      operation.kind === "eventSetDate"
    ) {
      notifySameRendererDocumentWrite(
        { kind: "chronicle-event", id: operation.eventId },
        {
          domain: "event",
          opType: "event.update",
          entityId: operation.eventId,
        },
      );
      scheduleEventIndex(operation.eventId);
    }
  }
}

async function refreshSceneProjections(
  operations: readonly ChronicleBulkOperation[],
  projectId: string,
  workspaceOpenRevision: number | null,
): Promise<void> {
  if (!operations.some((operation) => operation.kind.startsWith("scene"))) {
    return;
  }
  await useTreeStore
    .getState()
    .reloadTreeOrThrow(projectId, workspaceOpenRevision ?? undefined);
}

/**
 * Persist one Chronicle selection action atomically.
 *
 * The single Chronicle revision bump refreshes Event rows. The caller must
 * apply `sceneResults` to its exact-scope tree snapshot (or reload that tree
 * once) after success; undo/redo performs an authoritative tree reload and
 * propagates failure because those replays have no originating panel.
 */
export async function uiMutateChronicleBulk(
  operations: readonly ChronicleBulkOperation[],
): Promise<ChronicleBulkMutationResult> {
  if (operations.length === 0) {
    throw new Error("Chronicle bulk mutation requires at least one operation");
  }
  const stableOperations = operations.map((operation) => ({ ...operation }));
  const authority = captureMutationAuthority(
    getCurrentProjectId(),
    getCurrentProjectId,
  );
  const signature = JSON.stringify({
    projectId: authority.projectId,
    operations: stableOperations,
  });
  const requestKey = JSON.stringify({
    workspacePath: authority.workspacePath,
    workspaceOpenRevision: authority.workspaceOpenRevision,
    signature,
  });
  const inFlight = inFlightBulkMutations.get(requestKey);
  if (inFlight) return inFlight;
  const pending = pendingBulkMutations.acquire(
    requestKey,
    signature,
    (requestId) => ({
      requestId,
      projectId: authority.projectId,
      sessionId: getRecorderSessionId(),
      surface: "manual",
      operations: stableOperations,
    }),
  );

  const execution = (async (): Promise<ChronicleBulkMutationResult> => {
    let nativeMutationCommitted = false;
    try {
      const outcome = await runAuthoritativeMutation(authority, () =>
        invoke<ChronicleBulkMutationResult>("chronicle_bulk_mutate", {
          payload: pending.payload,
        }),
      );
      nativeMutationCommitted = "value" in outcome;
      if (
        outcome.status === "stale" ||
        !isCurrentMutationAuthority(authority)
      ) {
        throw new Error("chronicle bulk mutation authority changed");
      }

      const result = outcome.value;
      // Publish the replay closure before renderer invalidation. If publication
      // itself fails, an idempotent retry can resume without issuing a duplicate
      // Chronicle revision/reload generation.
      if (!useGlobalHistoryStore.getState().isReplaying) {
        const replayRequests = createPendingCreateRequestRegistry<{
          requestId: string;
        }>();
        const replay = async (direction: "undo" | "redo") => {
          const replaySignature = JSON.stringify({
            projectId: authority.projectId,
            journalId: result.undoJournalId,
            direction,
          });
          const replayRequest = replayRequests.acquire(
            direction,
            replaySignature,
            (requestId) => ({ requestId }),
          );
          let nativeReplayCommitted = false;
          try {
            await applyUndoJournal(
              result.undoJournalId,
              direction,
              replayRequest.payload.requestId,
            );
            nativeReplayCommitted = true;
            await refreshSceneProjections(
              stableOperations,
              authority.projectId,
              authority.workspaceOpenRevision,
            );
            publishEventEffects(stableOperations, direction);
            useChronicleStore.getState().bumpRevision();
            replayRequests.release(replayRequest);
          } catch (error) {
            if (!nativeReplayCommitted && !isUnknownIpcOutcomeError(error)) {
              replayRequests.release(replayRequest);
            }
            throw error;
          }
        };
        useGlobalHistoryStore.getState().push({
          kind: "chronicle",
          label: i18next.t("chronicle.agentHistoryUpdate"),
          operationId: result.undoJournalId,
          affectedEntities: stableOperations.map((operation) =>
            "eventId" in operation
              ? { kind: "chronicle" as const, entityId: operation.eventId }
              : { kind: "scenes" as const, entityId: operation.sceneId },
          ),
          retainOnVersionConflict: true,
          undo: () => replay("undo"),
          redo: () => replay("redo"),
        });
      }
      publishEventEffects(stableOperations, "initial");
      useChronicleStore.getState().bumpRevision();
      pendingBulkMutations.release(pending);
      return result;
    } catch (error) {
      if (!nativeMutationCommitted && !isUnknownIpcOutcomeError(error)) {
        pendingBulkMutations.release(pending);
      }
      throw error;
    }
  })();
  inFlightBulkMutations.set(requestKey, execution);
  void execution
    .finally(() => {
      if (inFlightBulkMutations.get(requestKey) === execution) {
        inFlightBulkMutations.delete(requestKey);
      }
    })
    .catch(() => {
      // The originating caller owns mutation/publication failure handling.
    });
  return execution;
}
