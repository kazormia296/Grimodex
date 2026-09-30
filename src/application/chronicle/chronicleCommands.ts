import type { EventRow } from "@/features/chronicle/api";
import type { ChronicleDatePatch } from "@/features/tree/treeStore";

export interface ChronicleCreateInput {
  title: string;
  primaryCodexId?: string;
  laneGroup?: string;
  startTime?: number;
  startMinute?: number;
  startGranularity?: EventRow["startGranularity"];
}

export interface ChronicleCreatedEvent {
  id: string;
  title: string;
}

export interface ChronicleVersionedWriteResult {
  version: number;
}

/** Context carried only by a draft that was queued before lifecycle quiescence. */
export interface ChronicleWriteOptions {
  preexistingDraft?: boolean;
}

export interface ChroniclePatchOptions extends ChronicleWriteOptions {
  baseVersion?: number;
}

export interface ChronicleCommandPorts {
  event: {
    create(input: ChronicleCreateInput): Promise<ChronicleCreatedEvent>;
    update(
      input: { eventId: string; baseVersion?: number } & Partial<EventRow>,
      options?: ChronicleWriteOptions,
    ): Promise<ChronicleVersionedWriteResult>;
    delete(
      eventId: string,
      options?: { baseVersion?: number },
    ): Promise<ChronicleVersionedWriteResult>;
    addRelation(causeId: string, effectId: string): Promise<void>;
    removeRelation(causeId: string, effectId: string): Promise<void>;
    setParticipants(
      eventId: string,
      codexEntryIds: string[],
      options?: { baseVersion?: number },
    ): Promise<ChronicleVersionedWriteResult>;
    linkScene(sceneId: string, eventId: string): Promise<void>;
    unlinkScene(sceneId: string, eventId: string): Promise<void>;
  };
  scene: {
    updateTitle(
      sceneId: string,
      title: string,
      options?: ChronicleWriteOptions,
    ): Promise<void>;
    updateSynopsis(
      sceneId: string,
      synopsis: string,
      options?: ChronicleWriteOptions,
    ): Promise<void>;
    updatePov(
      sceneId: string,
      codexId: string | null,
      options?: ChronicleWriteOptions,
    ): Promise<void>;
    updateLocation(
      sceneId: string,
      codexId: string | null,
      options?: ChronicleWriteOptions,
    ): Promise<void>;
    updateDate(
      sceneId: string,
      patch: ChronicleDatePatch,
      options?: ChronicleWriteOptions,
    ): Promise<void>;
  };
}

const EMPTY_SCENE_DATE: ChronicleDatePatch = {
  chronicleStartTime: null,
  chronicleStartMinute: null,
  chronicleStartGranularity: "none",
  chronicleEndTime: null,
  chronicleEndMinute: null,
  chronicleEndGranularity: "none",
};

function sceneDatePatch(patch: Partial<EventRow>): ChronicleDatePatch {
  const result: ChronicleDatePatch = {};
  if ("startTime" in patch) result.chronicleStartTime = patch.startTime;
  if ("endTime" in patch) result.chronicleEndTime = patch.endTime;
  if ("startMinute" in patch) result.chronicleStartMinute = patch.startMinute;
  if ("endMinute" in patch) result.chronicleEndMinute = patch.endMinute;
  if ("startGranularity" in patch)
    result.chronicleStartGranularity = patch.startGranularity;
  if ("endGranularity" in patch)
    result.chronicleEndGranularity = patch.endGranularity;
  if ("precision" in patch) result.chroniclePrecision = patch.precision;
  return result;
}

/** Applies the shared Chronicle edit contract to either a real event or a scene-event projection. */
export async function patchChronicleItem(
  target: { kind: "event" | "scene"; id: string },
  patch: Partial<EventRow>,
  ports: ChronicleCommandPorts,
  options?: ChroniclePatchOptions,
): Promise<ChronicleVersionedWriteResult | void> {
  if (target.kind === "event") {
    const input = {
      eventId: target.id,
      ...patch,
      ...(options?.baseVersion === undefined
        ? {}
        : { baseVersion: options.baseVersion }),
    };
    return options?.preexistingDraft === true
      ? ports.event.update(input, { preexistingDraft: true })
      : ports.event.update(input);
  }

  if (patch.title != null) {
    if (options?.preexistingDraft === true)
      await ports.scene.updateTitle(target.id, patch.title, {
        preexistingDraft: true,
      });
    else await ports.scene.updateTitle(target.id, patch.title);
  }
  if ("note" in patch) {
    if (options?.preexistingDraft === true)
      await ports.scene.updateSynopsis(target.id, patch.note ?? "", {
        preexistingDraft: true,
      });
    else await ports.scene.updateSynopsis(target.id, patch.note ?? "");
  }
  if ("primaryCodexId" in patch) {
    if (options?.preexistingDraft === true)
      await ports.scene.updatePov(target.id, patch.primaryCodexId ?? null, {
        preexistingDraft: true,
      });
    else await ports.scene.updatePov(target.id, patch.primaryCodexId ?? null);
  }
  if ("locationCodexId" in patch) {
    if (options?.preexistingDraft === true)
      await ports.scene.updateLocation(
        target.id,
        patch.locationCodexId ?? null,
        { preexistingDraft: true },
      );
    else
      await ports.scene.updateLocation(
        target.id,
        patch.locationCodexId ?? null,
      );
  }
  const datePatch = sceneDatePatch(patch);
  if (Object.keys(datePatch).length > 0) {
    if (options?.preexistingDraft === true)
      await ports.scene.updateDate(target.id, datePatch, {
        preexistingDraft: true,
      });
    else await ports.scene.updateDate(target.id, datePatch);
  }
}

export async function clearChronicleDate(
  sceneId: string,
  ports: ChronicleCommandPorts,
): Promise<void> {
  await ports.scene.updateDate(sceneId, EMPTY_SCENE_DATE);
}

export async function deleteChronicleItem(
  target: { kind: "event" | "scene"; id: string },
  ports: ChronicleCommandPorts,
  options?: { baseVersion?: number },
): Promise<ChronicleVersionedWriteResult | void> {
  if (target.kind === "scene") {
    await clearChronicleDate(target.id, ports);
    return;
  }
  return options?.baseVersion === undefined
    ? ports.event.delete(target.id)
    : ports.event.delete(target.id, options);
}

export async function createChronicleEvent(
  input: ChronicleCreateInput,
  ports: ChronicleCommandPorts,
): Promise<ChronicleCreatedEvent> {
  return ports.event.create(input);
}
