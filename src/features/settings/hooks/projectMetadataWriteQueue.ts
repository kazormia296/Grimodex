import type { Project } from "@/features/project/api";
import { updateProject } from "@/features/project/api";
import {
  getCurrentProjectId,
  useProjectStore,
} from "@/features/project/projectStore";
import {
  captureMutationAuthority,
  isCurrentMutationAuthority,
  type MutationAuthority,
} from "@/features/concurrency/mutationAuthority";
import { registerQuiescenceProvider } from "@/lib/quiescenceProviders";
import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";

type ProjectMetadataField = keyof Omit<
  Project,
  "id" | "createdAt" | "updatedAt"
>;

interface PendingProjectMetadataWrite {
  authority: MutationAuthority;
  projectId: string;
  field: ProjectMetadataField;
  value: string | null;
  onPersist?: () => void;
}

interface ProjectMetadataWriteSlot {
  key: string;
  field: ProjectMetadataField;
  pending: PendingProjectMetadataWrite | null;
  failed: PendingProjectMetadataWrite | null;
  failure: unknown;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
}

const slotsByKey = new Map<string, ProjectMetadataWriteSlot>();

function getSlot(
  key: string,
  field: ProjectMetadataField,
): ProjectMetadataWriteSlot {
  let slot = slotsByKey.get(key);
  if (!slot) {
    slot = {
      key,
      field,
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

function hasFailure(slot: ProjectMetadataWriteSlot): boolean {
  return slot.failed !== null;
}

function cleanupSlotIfIdle(slot: ProjectMetadataWriteSlot): void {
  if (slot.pending || slot.failed || slot.timer || slot.running) {
    return;
  }
  if (slotsByKey.get(slot.key) === slot) slotsByKey.delete(slot.key);
}

function executeProjectMetadataWrite(
  write: PendingProjectMetadataWrite,
): Promise<void> {
  return (async () => {
    if (!isCurrentMutationAuthority(write.authority)) {
      throw new Error("Project metadata write authority changed");
    }
    await updateProject(write.projectId, {
      // `null` is the persisted meaning of an explicitly cleared nullable
      // metadata field. Converting it to `undefined` makes Drizzle omit the
      // column and falsely reports the old database value as saved.
      [write.field]: write.value,
    });
    if (!isCurrentMutationAuthority(write.authority)) {
      throw new Error("Project metadata write authority changed");
    }
    await useProjectStore.getState().refreshProjects();
    if (!isCurrentMutationAuthority(write.authority)) {
      throw new Error("Project metadata write authority changed");
    }
    write.onPersist?.();
  })();
}

function startSlot(slot: ProjectMetadataWriteSlot): Promise<void> {
  if (slot.running) return slot.running;
  const write = slot.pending;
  if (!write) return Promise.resolve();

  slot.pending = null;
  if (slot.timer) {
    clearTimeout(slot.timer);
    slot.timer = null;
  }

  const execution = executeProjectMetadataWrite(write);
  const tracked = execution
    .then(() => {
      slot.failed = null;
      slot.failure = undefined;
    })
    .catch((error: unknown): never => {
      slot.failed = write;
      slot.failure = error;
      throw error;
    })
    .finally(() => {
      if (slot.running === tracked) slot.running = null;
      // A newer value may have reached its debounce deadline while this write
      // was still running. It has already waited long enough, so drain it now.
      if (slot.pending && slot.timer === null) {
        void startSlot(slot).catch(() => {});
      } else {
        cleanupSlotIfIdle(slot);
      }
    });
  slot.running = tracked;
  return tracked;
}

export function scheduleProjectMetadataWrite(options: {
  projectId: string;
  field: ProjectMetadataField;
  value: string | null;
  onPersist?: () => void;
}): void {
  if (!canScheduleQuiescenceMutation()) return;
  const authority = captureMutationAuthority(
    options.projectId,
    getCurrentProjectId,
  );
  const key = [
    authority.workspacePath ?? "",
    authority.workspaceOpenRevision ?? "",
    options.projectId,
    options.field,
  ].join("\u0000");
  const slot = getSlot(key, options.field);
  if (slot.timer) clearTimeout(slot.timer);
  slot.failed = null;
  slot.failure = undefined;
  slot.pending = {
    authority,
    projectId: options.projectId,
    field: options.field,
    value: options.value,
    onPersist: options.onPersist,
  };
  slot.timer = setTimeout(() => {
    slot.timer = null;
    void startSlot(slot).catch(() => {});
  }, 300);
}

export async function flushProjectMetadataWrites(): Promise<void> {
  while (true) {
    const slots = [...slotsByKey.values()];
    for (const slot of slots) {
      if (!slot.pending && slot.failed) {
        // A lifecycle retry is a real persistence retry, not just a replay of
        // the previously reported error.
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
        hasFailure(slot) && slot.failure !== undefined ? [slot.failure] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          failures.length === 1 && failures[0] instanceof Error
            ? failures[0].message
            : "One or more Project metadata writes failed",
        );
      }
      return;
    }
  }
}

function discardProjectMetadataWrites(): void {
  for (const slot of slotsByKey.values()) {
    if (slot.timer) clearTimeout(slot.timer);
  }
  slotsByKey.clear();
}

registerQuiescenceProvider({
  id: "project-metadata-writes",
  stage: "scoped-mutations",
  flush: flushProjectMetadataWrites,
  discard: discardProjectMetadataWrites,
  recovery: () =>
    [...slotsByKey.values()].flatMap((slot) => {
      const write = slot.pending ?? slot.failed;
      if (!write) return [];
      return [
        {
          kind: "project-metadata",
          projectId: write.projectId,
          field: write.field,
          value: write.value,
        },
      ];
    }),
});

export function _resetProjectMetadataWritesForTests(): void {
  discardProjectMetadataWrites();
}
