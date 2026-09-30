import {
  captureMutationAuthority,
  isCurrentMutationAuthority,
  type MutationAuthority,
} from "@/features/concurrency/mutationAuthority";
import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";
import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  createQuiescenceProviderId,
  registerQuiescenceProvider,
} from "@/lib/quiescenceProviders";
import { updateFrame, updateMapBoardSettings } from "../mapApi";
import type { ColorByAxis, MapBoardRecord } from "../types";

export const MAP_BOARD_SETTINGS_DEBOUNCE_MS = 600;
export const MAP_FRAME_RESIZE_DEBOUNCE_MS = 500;

export interface MapBoardSettingsSnapshot {
  mode: MapBoardRecord["mode"];
  viewportX: number;
  viewportY: number;
  viewportZoom: number;
  showConfig: string;
  colorBy: ColorByAxis;
}

interface BaseMapPersistenceWrite {
  authority: MutationAuthority;
  key: string;
  onPersist?: () => void;
  onBackgroundError?: (error: unknown) => void;
}

interface MapBoardSettingsWrite extends BaseMapPersistenceWrite {
  kind: "board-settings";
  boardId: string;
  settings: MapBoardSettingsSnapshot;
}

interface MapFrameResizeWrite extends BaseMapPersistenceWrite {
  kind: "frame-resize";
  boardId: string;
  frameId: string;
  width: number;
  height: number;
}

type PendingMapPersistenceWrite = MapBoardSettingsWrite | MapFrameResizeWrite;

interface MapPersistenceWriteSlot {
  key: string;
  pending: PendingMapPersistenceWrite | null;
  failed: PendingMapPersistenceWrite | null;
  failure: unknown;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
}

const slotsByKey = new Map<string, MapPersistenceWriteSlot>();

function authorityKey(authority: MutationAuthority): string {
  return [
    authority.workspacePath ?? "",
    authority.workspaceOpenRevision ?? "",
    authority.projectId,
  ].join("\u0000");
}

function getSlot(key: string): MapPersistenceWriteSlot {
  let slot = slotsByKey.get(key);
  if (!slot) {
    slot = {
      key,
      pending: null,
      failed: null,
      failure: undefined,
      timer: null,
      running: null,
    };
    slotsByKey.set(key, slot);
  }
  return slot;
}

function cleanupSlotIfIdle(slot: MapPersistenceWriteSlot): void {
  if (slot.pending || slot.failed || slot.timer || slot.running) return;
  if (slotsByKey.get(slot.key) === slot) slotsByKey.delete(slot.key);
}

async function executeWrite(write: PendingMapPersistenceWrite): Promise<void> {
  if (!isCurrentMutationAuthority(write.authority)) {
    throw new Error("Map persistence authority changed");
  }
  if (write.kind === "board-settings") {
    await updateMapBoardSettings(write.boardId, write.settings);
  } else {
    await updateFrame(write.frameId, {
      width: write.width,
      height: write.height,
    });
  }
  if (!isCurrentMutationAuthority(write.authority)) {
    throw new Error("Map persistence authority changed");
  }
}

function startSlot(slot: MapPersistenceWriteSlot): Promise<void> {
  if (slot.running) return slot.running;
  const write = slot.pending;
  if (!write) return Promise.resolve();

  slot.pending = null;
  if (slot.timer) {
    clearTimeout(slot.timer);
    slot.timer = null;
  }

  const execution = executeWrite(write);
  const tracked = execution
    .then(() => {
      slot.failed = null;
      slot.failure = undefined;
      // A newer full snapshot supersedes this completion. Publishing the old
      // frame dimensions would briefly snap the live React Flow node back.
      if (!slot.pending) write.onPersist?.();
    })
    .catch((error: unknown): never => {
      slot.failed = write;
      slot.failure = error;
      write.onBackgroundError?.(error);
      throw error;
    })
    .finally(() => {
      if (slot.running === tracked) slot.running = null;
      // A newer value whose debounce was forced by strict quiescence drains
      // immediately after the preceding write settles.
      if (slot.pending && slot.timer === null) {
        void startSlot(slot).catch(() => {});
      } else {
        cleanupSlotIfIdle(slot);
      }
    });
  slot.running = tracked;
  return tracked;
}

function scheduleWrite(
  write: PendingMapPersistenceWrite,
  delayMs: number,
): void {
  const slot = getSlot(write.key);
  if (slot.timer) clearTimeout(slot.timer);
  // Every payload is a complete snapshot for its key, so the latest pending
  // value safely supersedes an earlier failed or not-yet-started value.
  slot.failed = null;
  slot.failure = undefined;
  slot.pending = write;
  slot.timer = setTimeout(() => {
    slot.timer = null;
    void startSlot(slot).catch(() => {
      // Existing Map persistence treats background failures as non-fatal.
      // The failed snapshot remains registered for strict quiescence retry.
    });
  }, delayMs);
}

export function scheduleMapBoardSettingsWrite(options: {
  projectId: string;
  boardId: string;
  settings: MapBoardSettingsSnapshot;
}): void {
  if (!canScheduleQuiescenceMutation()) return;
  const authority = captureMutationAuthority(
    options.projectId,
    getCurrentProjectId,
  );
  scheduleWrite(
    {
      kind: "board-settings",
      authority,
      key: `${authorityKey(authority)}\u0000board-settings\u0000${options.boardId}`,
      boardId: options.boardId,
      settings: options.settings,
    },
    MAP_BOARD_SETTINGS_DEBOUNCE_MS,
  );
}

export function scheduleMapFrameResizeWrite(options: {
  projectId: string;
  boardId: string;
  frameId: string;
  width: number;
  height: number;
  onPersist?: () => void;
  onBackgroundError?: (error: unknown) => void;
}): void {
  if (!canScheduleQuiescenceMutation()) return;
  const authority = captureMutationAuthority(
    options.projectId,
    getCurrentProjectId,
  );
  scheduleWrite(
    {
      kind: "frame-resize",
      authority,
      key: `${authorityKey(authority)}\u0000frame-resize\u0000${options.boardId}\u0000${options.frameId}`,
      boardId: options.boardId,
      frameId: options.frameId,
      width: options.width,
      height: options.height,
      onPersist: options.onPersist,
      onBackgroundError: options.onBackgroundError,
    },
    MAP_FRAME_RESIZE_DEBOUNCE_MS,
  );
}

export async function flushMapPersistenceWritesStrict(): Promise<void> {
  while (true) {
    const slots = [...slotsByKey.values()];
    for (const slot of slots) {
      if (!slot.pending && slot.failed) {
        // A later strict attempt retries the retained full snapshot.
        slot.pending = slot.failed;
        slot.failed = null;
        slot.failure = undefined;
      }
      if (slot.timer) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
    }

    const running = slots.map(startSlot).filter((run, index, all) => {
      return all.indexOf(run) === index;
    });
    await Promise.allSettled(running);

    const currentSlots = [...slotsByKey.values()];
    if (
      currentSlots.every(
        (slot) => slot.pending === null && slot.running === null,
      )
    ) {
      const failures = currentSlots.flatMap((slot) =>
        slot.failed && slot.failure !== undefined ? [slot.failure] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          failures.length === 1 && failures[0] instanceof Error
            ? failures[0].message
            : "One or more Map persistence writes failed",
        );
      }
      return;
    }
  }
}

/**
 * React cleanup cannot await. Force timers into the registered queue now;
 * failures stay retained for the next strict lifecycle attempt.
 */
export function flushMapPersistenceWritesInBackground(): void {
  void flushMapPersistenceWritesStrict().catch(() => {});
}

function discardMapPersistenceWrites(): void {
  for (const slot of slotsByKey.values()) {
    if (slot.timer) clearTimeout(slot.timer);
  }
  slotsByKey.clear();
}

registerQuiescenceProvider({
  id: createQuiescenceProviderId("map-project-db-writes"),
  stage: "scoped-mutations",
  flush: flushMapPersistenceWritesStrict,
  discard: discardMapPersistenceWrites,
  recovery: () =>
    [...slotsByKey.values()].flatMap((slot) => {
      const write = slot.pending ?? slot.failed;
      if (!write) return [];
      return [
        write.kind === "board-settings"
          ? {
              kind: "map-board-settings",
              boardId: write.boardId,
              settings: write.settings,
            }
          : {
              kind: "map-frame-resize",
              boardId: write.boardId,
              frameId: write.frameId,
              width: write.width,
              height: write.height,
            },
      ];
    }),
});

export function _resetMapPersistenceWritesForTests(): void {
  discardMapPersistenceWrites();
}
