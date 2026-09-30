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
import {
  createQuiescenceProviderId,
  registerQuiescenceProvider,
} from "@/lib/quiescenceProviders";
import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";

export type ProjectMetadataField =
  | "title"
  | "genre"
  | "pov"
  | "tense"
  | "language"
  | "styleGuide"
  | "aiInstructions"
  | "outline"
  | "targetReaders"
  | "aiPolicy"
  | "phaseResolutionMode";

// Keep the patch shape coupled to the Native project writer's accepted
// fields. In particular, `title` is non-null at that boundary even though
// the generic settings control accepts nullable values for other fields.
type ProjectMetadataPatch = Parameters<typeof updateProject>[1];
type PersistCallbacks = Partial<Record<ProjectMetadataField, () => void>>;
type FailureCallbacks = Partial<
  Record<ProjectMetadataField, (error: unknown) => void>
>;
type GenerationByField = Partial<Record<ProjectMetadataField, number>>;

interface PendingProjectMetadataWrite {
  authority: MutationAuthority;
  projectId: string;
  patch: ProjectMetadataPatch;
  generationByField: GenerationByField;
  onPersistByField: PersistCallbacks;
  onFailureByField: FailureCallbacks;
}

interface ProjectMetadataWriteLane {
  key: string;
  projectId: string;
  pending: PendingProjectMetadataWrite | null;
  failed: PendingProjectMetadataWrite | null;
  latestGenerationByField: Map<ProjectMetadataField, number>;
  failure: unknown;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
}

const lanesByKey = new Map<string, ProjectMetadataWriteLane>();

function patchFields(patch: ProjectMetadataPatch): ProjectMetadataField[] {
  return Object.keys(patch) as ProjectMetadataField[];
}

function hasPatch(patch: ProjectMetadataPatch): boolean {
  return patchFields(patch).length > 0;
}

function getLane(key: string, projectId: string): ProjectMetadataWriteLane {
  let lane = lanesByKey.get(key);
  if (!lane) {
    lane = {
      key,
      projectId,
      pending: null,
      failed: null,
      latestGenerationByField: new Map(),
      failure: undefined,
      timer: null,
      running: null,
    };
    lanesByKey.set(key, lane);
  }
  return lane;
}

function mergeWrites(
  base: PendingProjectMetadataWrite | null,
  overlay: PendingProjectMetadataWrite,
): PendingProjectMetadataWrite {
  return {
    authority: overlay.authority,
    projectId: overlay.projectId,
    patch: {
      ...(base?.patch ?? {}),
      ...overlay.patch,
    },
    generationByField: {
      ...(base?.generationByField ?? {}),
      ...overlay.generationByField,
    },
    onPersistByField: {
      ...(base?.onPersistByField ?? {}),
      ...overlay.onPersistByField,
    },
    onFailureByField: {
      ...(base?.onFailureByField ?? {}),
      ...overlay.onFailureByField,
    },
  };
}

function withoutField(
  write: PendingProjectMetadataWrite,
  field: ProjectMetadataField,
): PendingProjectMetadataWrite | null {
  const patch = { ...write.patch };
  delete patch[field];
  const generationByField = { ...write.generationByField };
  delete generationByField[field];
  const onPersistByField = { ...write.onPersistByField };
  delete onPersistByField[field];
  const onFailureByField = { ...write.onFailureByField };
  delete onFailureByField[field];
  if (!hasPatch(patch)) return null;
  return {
    ...write,
    patch,
    generationByField,
    onPersistByField,
    onFailureByField,
  };
}

function retainLatestGenerations(
  lane: ProjectMetadataWriteLane,
  write: PendingProjectMetadataWrite,
): PendingProjectMetadataWrite | null {
  let retained: PendingProjectMetadataWrite | null = write;
  for (const field of patchFields(write.patch)) {
    const generation = write.generationByField[field];
    if (
      generation === undefined ||
      lane.latestGenerationByField.get(field) !== generation
    ) {
      retained = retained ? withoutField(retained, field) : null;
    }
  }
  return retained;
}

function clearSuccessfulFieldsFromFailure(
  lane: ProjectMetadataWriteLane,
  write: PendingProjectMetadataWrite,
): void {
  for (const field of patchFields(write.patch)) {
    const failedGeneration = lane.failed?.generationByField[field];
    const successfulGeneration = write.generationByField[field];
    if (
      lane.failed &&
      failedGeneration !== undefined &&
      successfulGeneration !== undefined &&
      successfulGeneration >= failedGeneration
    ) {
      lane.failed = withoutField(lane.failed, field);
    }
  }
  if (!lane.failed) lane.failure = undefined;
}

function cleanupLaneIfIdle(lane: ProjectMetadataWriteLane): void {
  if (lane.pending || lane.failed || lane.timer || lane.running) return;
  if (lanesByKey.get(lane.key) === lane) lanesByKey.delete(lane.key);
}

async function executeProjectMetadataWrite(
  write: PendingProjectMetadataWrite,
): Promise<void> {
  if (!isCurrentMutationAuthority(write.authority)) {
    throw new Error("Project metadata write authority changed");
  }
  const updated = await updateProject(write.projectId, write.patch);
  if (!updated) {
    throw new Error("Project metadata write target not found");
  }
  if (!isCurrentMutationAuthority(write.authority)) {
    throw new Error("Project metadata write authority changed");
  }
  await useProjectStore.getState().refreshProjects();
  if (!isCurrentMutationAuthority(write.authority)) {
    throw new Error("Project metadata write authority changed");
  }
  for (const callback of Object.values(write.onPersistByField)) {
    callback?.();
  }
}

function notifyWriteFailure(
  write: PendingProjectMetadataWrite,
  error: unknown,
): void {
  for (const callback of Object.values(write.onFailureByField)) {
    try {
      callback?.(error);
    } catch {
      // A rollback observer must not hide the persistence failure or prevent
      // the lifecycle recovery provider from retaining the failed patch.
    }
  }
}

function startLane(lane: ProjectMetadataWriteLane): Promise<void> {
  if (lane.running) return lane.running;
  const write = lane.pending;
  if (!write) return Promise.resolve();

  lane.pending = null;
  if (lane.timer) {
    clearTimeout(lane.timer);
    lane.timer = null;
  }

  const execution = executeProjectMetadataWrite(write);
  const tracked = execution
    .then(() => {
      // A successful newer generation makes any same-field failed generation
      // obsolete. Keep unrelated failed fields recoverable.
      clearSuccessfulFieldsFromFailure(lane, write);
    })
    .catch((error: unknown): never => {
      // An in-flight write may have become stale while Native OCC was
      // running. Only fields whose generation is still current belong in
      // lifecycle recovery; otherwise a later successful value could be
      // overwritten by this old failure on the next flush.
      const recoverable = retainLatestGenerations(lane, write);
      if (recoverable) {
        lane.failed = mergeWrites(lane.failed, recoverable);
        lane.failure = error;
        notifyWriteFailure(recoverable, error);
      } else if (!lane.failed) {
        lane.failure = undefined;
      }
      throw error;
    })
    .finally(() => {
      if (lane.running === tracked) lane.running = null;
      // A newer value may have reached its debounce deadline while this write
      // was running. It has already waited long enough, so drain it now.
      if (lane.pending && lane.timer === null) {
        void startLane(lane).catch(() => {});
      } else {
        cleanupLaneIfIdle(lane);
      }
    });
  lane.running = tracked;
  return tracked;
}

export function scheduleProjectMetadataWrite(options: {
  projectId: string;
  field: ProjectMetadataField;
  value: string | null;
  onPersist?: () => void;
  onFailure?: (error: unknown) => void;
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
  ].join("\u0000");
  const lane = getLane(key, options.projectId);
  const generation = (lane.latestGenerationByField.get(options.field) ?? 0) + 1;
  lane.latestGenerationByField.set(options.field, generation);

  // A newer value for the same field supersedes a failed value, but a failed
  // value for another field remains recoverable and will be retried with the
  // next Project-level patch.
  if (lane.failed) {
    lane.failed = withoutField(lane.failed, options.field);
    if (!lane.failed) lane.failure = undefined;
  }

  if (lane.timer) clearTimeout(lane.timer);
  const next: PendingProjectMetadataWrite = {
    authority,
    projectId: options.projectId,
    patch: { [options.field]: options.value } as ProjectMetadataPatch,
    generationByField: { [options.field]: generation },
    onPersistByField: { [options.field]: options.onPersist },
    onFailureByField: { [options.field]: options.onFailure },
  };
  lane.pending = mergeWrites(lane.pending, next);
  lane.timer = setTimeout(() => {
    lane.timer = null;
    void startLane(lane).catch(() => {});
  }, 300);
}

export async function flushProjectMetadataWrites(): Promise<void> {
  while (true) {
    const lanes = [...lanesByKey.values()];
    for (const lane of lanes) {
      const recoverable = lane.failed
        ? retainLatestGenerations(lane, lane.failed)
        : null;
      lane.failed = recoverable;
      if (recoverable) {
        // A lifecycle retry is a real persistence retry, not just a replay of
        // the previously reported error. Merge it with pending fields so one
        // Project transaction carries the newest values for every field.
        lane.pending = lane.pending
          ? mergeWrites(recoverable, lane.pending)
          : recoverable;
        lane.failed = null;
        lane.failure = undefined;
      }
      if (lane.timer) {
        clearTimeout(lane.timer);
        lane.timer = null;
      }
    }

    const running = lanes
      .map(startLane)
      .filter((run, index, all) => all.indexOf(run) === index);
    await Promise.allSettled(running);

    const currentLanes = [...lanesByKey.values()];
    if (
      currentLanes.every(
        (lane) => lane.pending === null && lane.running === null,
      )
    ) {
      const failures = currentLanes.flatMap((lane) =>
        lane.failed && lane.failure !== undefined ? [lane.failure] : [],
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
  for (const lane of lanesByKey.values()) {
    if (lane.timer) clearTimeout(lane.timer);
  }
  lanesByKey.clear();
}

registerQuiescenceProvider({
  id: createQuiescenceProviderId("project-metadata-writes"),
  stage: "scoped-mutations",
  flush: flushProjectMetadataWrites,
  discard: discardProjectMetadataWrites,
  recovery: () =>
    [...lanesByKey.values()].flatMap((lane) => {
      const failed = lane.failed
        ? retainLatestGenerations(lane, lane.failed)
        : null;
      const write = failed
        ? lane.pending
          ? mergeWrites(failed, lane.pending)
          : failed
        : lane.pending;
      if (!write) return [];
      return patchFields(write.patch).map((field) => ({
        kind: "project-metadata",
        projectId: write.projectId,
        field,
        value: write.patch[field] ?? null,
      }));
    }),
});

export function _resetProjectMetadataWritesForTests(): void {
  discardProjectMetadataWrites();
}
