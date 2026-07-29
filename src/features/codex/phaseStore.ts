import { create } from "zustand";
import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { debugLog, errorDetail } from "@/lib/debugLog";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntry } from "./api";
import * as phaseApi from "./phaseApi";
import type { CodexEntryPhase, CodexPhaseDetailOverride } from "./phaseApi";
import { PhaseVersionConflictError } from "./phaseOcc";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import {
  resolveCodexState,
  type PhaseResolutionMode,
  type ResolvedCodexState,
} from "./phaseResolver";
import {
  buildSceneTimeIndex,
  linearizeSceneTimeIndex,
  type SceneTimeIndex,
} from "./context/sceneTimeIndex";
import { notifySameRendererDocumentWrite } from "@/features/concurrency/documentWriteNotification";

export interface PhaseState {
  /** Project-bound async work is allowed to publish only within this epoch. */
  projectEpoch: number;
  phasesByEntry: Record<string, CodexEntryPhase[]>;
  detailOverrides: Record<string, CodexPhaseDetailOverride[]>; // phaseId → overrides
  globalSceneOrder: Map<string, number>;
  /** Mode-independent temporal index used by semantic Phase resolution. */
  sceneTimeIndex: SceneTimeIndex;
  resolvedStates: Record<string, ResolvedCodexState>; // entryId → resolved (キャッシュ)
  resolutionMode: PhaseResolutionMode;
  cachedNodes: TreeNodeData[];

  resetForProject(): void;
  loadPhasesForEntry(entryId: string): Promise<void>;
  createPhase(data: {
    entryId: string;
    label: string;
    anchorNodeId?: string | null;
    summaryOverride?: string | null;
    contentOverride?: string | null;
    contextModeOverride?: string | null;
  }): Promise<CodexEntryPhase>;
  updatePhase(
    id: string,
    data: Partial<
      Pick<
        CodexEntryPhase,
        | "label"
        | "anchorNodeId"
        | "summaryOverride"
        | "contentOverride"
        | "contextModeOverride"
      >
    >,
    opts?: { baseVersion?: number },
  ): Promise<CodexEntryPhase | null>;
  deletePhase(id: string): Promise<void>;
  upsertDetailOverride(
    phaseId: string,
    definitionId: string,
    value: string | null,
  ): Promise<void>;
  deleteDetailOverride(phaseId: string, definitionId: string): Promise<void>;
  recomputeSceneOrder(nodes: TreeNodeData[]): void;
  setResolutionMode(mode: PhaseResolutionMode): void;
  resolveForScene(
    entries: CodexEntry[],
    baseDetails: Map<string, Map<string, string | null>>,
    currentSceneId: string | null,
  ): void;
  getResolvedState(entryId: string): ResolvedCodexState | null;
}

const phaseEntryGenerations = new Map<string, number>();
const phaseHistoryVersionAliases = new Map<string, Map<number, number>>();

function phaseEntryGeneration(entryId: string): number {
  return phaseEntryGenerations.get(entryId) ?? 0;
}

function invalidatePhaseEntryLoads(entryId: string | undefined): void {
  if (!entryId) return;
  phaseEntryGenerations.set(entryId, phaseEntryGeneration(entryId) + 1);
}

function findEntryIdForPhase(
  state: PhaseState,
  phaseId: string,
): string | undefined {
  for (const [entryId, phases] of Object.entries(state.phasesByEntry)) {
    if (phases.some((phase) => phase.id === phaseId)) return entryId;
  }
  return undefined;
}

function resolvePhaseHistoryVersion(
  phaseId: string,
  originalVersion: number,
): number {
  const aliases = phaseHistoryVersionAliases.get(phaseId);
  if (!aliases) return originalVersion;
  let version = originalVersion;
  const visited = new Set<number>();
  while (!visited.has(version)) {
    visited.add(version);
    const next = aliases.get(version);
    if (next === undefined || next === version) break;
    version = next;
  }
  return version;
}

function advancePhaseHistoryVersion(
  phaseId: string,
  logicalVersion: number,
  persistedVersion: number,
): void {
  const aliases = phaseHistoryVersionAliases.get(phaseId) ?? new Map();
  aliases.set(logicalVersion, persistedVersion);
  phaseHistoryVersionAliases.set(phaseId, aliases);
}

function notifyPhaseDocumentWrite(
  phase: Pick<CodexEntryPhase, "id" | "entryId">,
  opType: string,
): void {
  notifySameRendererDocumentWrite(
    { kind: "codex", id: phase.entryId, phaseId: phase.id },
    { domain: "codex", opType, entityId: phase.id },
  );
}

export const usePhaseStore = create<PhaseState>()((set, get) => ({
  projectEpoch: 0,
  phasesByEntry: {},
  detailOverrides: {},
  globalSceneOrder: new Map(),
  sceneTimeIndex: buildSceneTimeIndex([]),
  resolvedStates: {},
  resolutionMode: "reading",
  cachedNodes: [],

  resetForProject() {
    phaseEntryGenerations.clear();
    phaseHistoryVersionAliases.clear();
    set((state) => ({
      projectEpoch: state.projectEpoch + 1,
      phasesByEntry: {},
      detailOverrides: {},
      globalSceneOrder: new Map(),
      sceneTimeIndex: buildSceneTimeIndex(
        [],
        state.sceneTimeIndex.revision + 1,
      ),
      resolvedStates: {},
      resolutionMode: state.resolutionMode,
      cachedNodes: [],
    }));
  },

  async loadPhasesForEntry(entryId) {
    const epoch = get().projectEpoch;
    const entryGeneration = phaseEntryGeneration(entryId);
    const restartIfSuperseded = (): boolean => {
      const state = get();
      if (state.projectEpoch !== epoch) return true;
      if (phaseEntryGeneration(entryId) === entryGeneration) return false;
      void state.loadPhasesForEntry(entryId);
      return true;
    };
    let phases: CodexEntryPhase[];
    let allOverrides: CodexPhaseDetailOverride[];
    try {
      phases = await phaseApi.listPhasesByEntry(entryId);
      if (restartIfSuperseded()) return;
      const phaseIds = phases.map((p) => p.id);
      allOverrides = await phaseApi.listDetailOverridesByPhaseIds(phaseIds);
      if (restartIfSuperseded()) return;
    } catch {
      return; // DB未接続時などは無視
    }

    const overridesByPhase: Record<string, CodexPhaseDetailOverride[]> = {};
    for (const ov of allOverrides) {
      if (!overridesByPhase[ov.phaseId]) overridesByPhase[ov.phaseId] = [];
      overridesByPhase[ov.phaseId].push(ov);
    }

    if (restartIfSuperseded()) return;
    set((state) => {
      if (state.projectEpoch !== epoch) return state;

      // The DB response is authoritative for this entry. Remove every cached
      // override belonging to the prior/current phase set before publishing it,
      // including the empty-result case.
      const nextOverrides = { ...state.detailOverrides };
      for (const phase of state.phasesByEntry[entryId] ?? []) {
        delete nextOverrides[phase.id];
      }
      for (const phase of phases) delete nextOverrides[phase.id];
      Object.assign(nextOverrides, overridesByPhase);

      return {
        phasesByEntry: { ...state.phasesByEntry, [entryId]: phases },
        detailOverrides: nextOverrides,
      };
    });
  },

  async createPhase(data) {
    const epoch = get().projectEpoch;
    invalidatePhaseEntryLoads(data.entryId);
    const id = crypto.randomUUID();
    const phase = await phaseApi.createPhase({
      id,
      ...data,
    });
    if (get().projectEpoch !== epoch) return phase;
    invalidatePhaseEntryLoads(phase.entryId);
    set((state) => {
      if (state.projectEpoch !== epoch) return state;
      const existing = state.phasesByEntry[phase.entryId] ?? [];
      return {
        phasesByEntry: {
          ...state.phasesByEntry,
          [phase.entryId]: [...existing, phase],
        },
      };
    });
    notifyPhaseDocumentWrite(phase, "phase.create");

    if (!useGlobalHistoryStore.getState().isReplaying) {
      const cap = {
        phase: { ...phase },
        projectEpoch: epoch,
        deleteVersion: phase.version,
        logicalVersion: phase.version,
      };
      useGlobalHistoryStore.getState().push({
        kind: "phase",
        label: i18next.t("phase.history.created"),
        entityId: cap.phase.id,
        documentKey: {
          kind: "codex",
          id: cap.phase.entryId,
          phaseId: cap.phase.id,
        },
        retainOnVersionConflict: true,
        async undo() {
          if (get().projectEpoch !== cap.projectEpoch) return;
          invalidatePhaseEntryLoads(cap.phase.entryId);
          cap.deleteVersion = resolvePhaseHistoryVersion(
            cap.phase.id,
            cap.logicalVersion,
          );
          await phaseApi.deletePhase(cap.phase.id, {
            expectedVersion: cap.deleteVersion,
          });
          if (get().projectEpoch !== cap.projectEpoch) return;
          invalidatePhaseEntryLoads(cap.phase.entryId);
          set((state) => {
            if (state.projectEpoch !== cap.projectEpoch) return state;
            return {
              phasesByEntry: {
                ...state.phasesByEntry,
                [cap.phase.entryId]: (
                  state.phasesByEntry[cap.phase.entryId] ?? []
                ).filter((p) => p.id !== cap.phase.id),
              },
            };
          });
          notifyPhaseDocumentWrite(cap.phase, "phase.create.undo");
        },
        async redo() {
          if (get().projectEpoch !== cap.projectEpoch) return;
          invalidatePhaseEntryLoads(cap.phase.entryId);
          const restored = await phaseApi.createPhase({
            id: cap.phase.id,
            entryId: cap.phase.entryId,
            anchorNodeId: cap.phase.anchorNodeId ?? null,
            label: cap.phase.label,
            summaryOverride: cap.phase.summaryOverride ?? null,
            contentOverride: cap.phase.contentOverride ?? null,
            contextModeOverride: cap.phase.contextModeOverride ?? null,
            // Re-creation must never reuse the pre-delete OCC token. A stale
            // editor that loaded the Phase before undo would otherwise pass
            // CAS after redo (ABA).
            version: cap.deleteVersion + 1,
            createdAt: cap.phase.createdAt,
            updatedAt: cap.phase.updatedAt,
          });
          cap.deleteVersion = restored.version;
          advancePhaseHistoryVersion(
            cap.phase.id,
            cap.logicalVersion,
            restored.version,
          );
          if (get().projectEpoch !== cap.projectEpoch) return;
          invalidatePhaseEntryLoads(cap.phase.entryId);
          set((state) => {
            if (state.projectEpoch !== cap.projectEpoch) return state;
            return {
              phasesByEntry: {
                ...state.phasesByEntry,
                [cap.phase.entryId]: [
                  ...(state.phasesByEntry[cap.phase.entryId] ?? []).filter(
                    (p) => p.id !== cap.phase.id,
                  ),
                  restored,
                ],
              },
            };
          });
          notifyPhaseDocumentWrite(restored, "phase.create.redo");
        },
      });
    }

    return phase;
  },

  async updatePhase(id, data, opts) {
    const epoch = get().projectEpoch;
    // Capture before-state of patched fields for undo
    let before: CodexEntryPhase | undefined;
    for (const phases of Object.values(get().phasesByEntry)) {
      const found = phases.find((p) => p.id === id);
      if (found) {
        before = found;
        break;
      }
    }
    if (!before && opts?.baseVersion === undefined) {
      try {
        before = await phaseApi.getPhase(id);
      } catch (error) {
        toast.error(i18next.t("phase.updateFailed"));
        debugLog.error("PhaseStore", "getPhaseForUpdate", errorDetail(error));
        return null;
      }
    }
    if (!before && opts?.baseVersion === undefined) {
      toast.error(i18next.t("phase.updateMissing"));
      return null;
    }
    invalidatePhaseEntryLoads(before?.entryId);

    let updated: CodexEntryPhase | undefined;
    try {
      updated = await phaseApi.updatePhase(id, data, {
        baseVersion: opts?.baseVersion ?? before?.version ?? 0,
      });
    } catch (error) {
      if (error instanceof PhaseVersionConflictError) {
        toast.error(i18next.t("phase.editConflict"));
      } else {
        toast.error(i18next.t("phase.updateFailed"));
        debugLog.error("PhaseStore", "updatePhase", errorDetail(error));
      }
      return null;
    }
    if (get().projectEpoch !== epoch) return null;
    if (!updated) {
      toast.error(i18next.t("phase.updateMissing"));
      return null;
    }
    invalidatePhaseEntryLoads(updated.entryId);
    set((state) => {
      if (state.projectEpoch !== epoch) return state;
      const entryId = updated.entryId;
      const phases = (state.phasesByEntry[entryId] ?? []).map((p) =>
        p.id === id ? updated : p,
      );
      return {
        phasesByEntry: { ...state.phasesByEntry, [entryId]: phases },
      };
    });
    // Calls that supply an explicit baseVersion originate from a mounted
    // editor and announce their returned binding themselves. Dialog/metadata
    // updates have no editor origin, so feed them back through the same
    // clean-reload / dirty-conflict coordinator.
    if (opts?.baseVersion === undefined) {
      notifyPhaseDocumentWrite(updated, "phase.update");
    }

    if (!before) return updated;
    if (useGlobalHistoryStore.getState().isReplaying) return updated;

    const undoPatch: Parameters<typeof phaseApi.updatePhase>[1] = {};
    for (const key of Object.keys(data) as (keyof typeof data)[]) {
      const v = (before as unknown as Record<string, unknown>)[key];
      // @ts-expect-error narrow union not assignable here
      undoPatch[key] = v ?? null;
    }
    const cap = {
      id,
      before: { ...before },
      undoPatch,
      redoPatch: { ...data },
      projectEpoch: epoch,
      logicalBaseVersion: before.version,
      logicalResultVersion: updated.version,
    };
    useGlobalHistoryStore.getState().push({
      kind: "phase",
      label: i18next.t("phase.history.updated"),
      entityId: cap.id,
      documentKey: {
        kind: "codex",
        id: cap.before.entryId,
        phaseId: cap.id,
      },
      retainOnVersionConflict: true,
      async undo() {
        if (get().projectEpoch !== cap.projectEpoch) return;
        invalidatePhaseEntryLoads(cap.before.entryId);
        const restored = await phaseApi.updatePhase(cap.id, cap.undoPatch, {
          baseVersion: resolvePhaseHistoryVersion(
            cap.id,
            cap.logicalResultVersion,
          ),
        });
        if (get().projectEpoch !== cap.projectEpoch) return;
        invalidatePhaseEntryLoads(cap.before.entryId);
        if (restored) {
          advancePhaseHistoryVersion(
            cap.id,
            cap.logicalBaseVersion,
            restored.version,
          );
          set((state) => {
            if (state.projectEpoch !== cap.projectEpoch) return state;
            const entryId = restored.entryId;
            const phases = (state.phasesByEntry[entryId] ?? []).map((p) =>
              p.id === cap.id ? restored : p,
            );
            return {
              phasesByEntry: { ...state.phasesByEntry, [entryId]: phases },
            };
          });
          notifyPhaseDocumentWrite(restored, "phase.undo");
        }
      },
      async redo() {
        if (get().projectEpoch !== cap.projectEpoch) return;
        invalidatePhaseEntryLoads(cap.before.entryId);
        const reapplied = await phaseApi.updatePhase(cap.id, cap.redoPatch, {
          baseVersion: resolvePhaseHistoryVersion(
            cap.id,
            cap.logicalBaseVersion,
          ),
        });
        if (get().projectEpoch !== cap.projectEpoch) return;
        invalidatePhaseEntryLoads(cap.before.entryId);
        if (reapplied) {
          advancePhaseHistoryVersion(
            cap.id,
            cap.logicalResultVersion,
            reapplied.version,
          );
          set((state) => {
            if (state.projectEpoch !== cap.projectEpoch) return state;
            const entryId = reapplied.entryId;
            const phases = (state.phasesByEntry[entryId] ?? []).map((p) =>
              p.id === cap.id ? reapplied : p,
            );
            return {
              phasesByEntry: { ...state.phasesByEntry, [entryId]: phases },
            };
          });
          notifyPhaseDocumentWrite(reapplied, "phase.redo");
        }
      },
    });
    return updated;
  },

  async deletePhase(id) {
    const epoch = get().projectEpoch;
    // Find entryId and full phase data before deleting
    let entryId: string | undefined;
    let beforePhase: CodexEntryPhase | undefined;
    for (const [eid, phases] of Object.entries(get().phasesByEntry)) {
      const found = phases.find((p) => p.id === id);
      if (found) {
        entryId = eid;
        beforePhase = found;
        break;
      }
    }
    const beforeOverrides = [...(get().detailOverrides[id] ?? [])];
    invalidatePhaseEntryLoads(entryId);

    let deleted: boolean;
    try {
      deleted = await phaseApi.deletePhase(
        id,
        beforePhase ? { expectedVersion: beforePhase.version } : undefined,
      );
    } catch (error) {
      if (error instanceof PhaseVersionConflictError) {
        toast.error(i18next.t("phase.editConflict"));
      } else {
        toast.error(i18next.t("phase.deleteFailed"));
        debugLog.error("PhaseStore", "deletePhase", errorDetail(error));
      }
      return;
    }
    if (!deleted) return;
    if (get().projectEpoch !== epoch) return;
    invalidatePhaseEntryLoads(entryId);

    set((state) => {
      if (state.projectEpoch !== epoch) return state;
      const next: Record<string, CodexEntryPhase[]> = {
        ...state.phasesByEntry,
      };
      if (entryId) {
        next[entryId] = (state.phasesByEntry[entryId] ?? []).filter(
          (p) => p.id !== id,
        );
      }
      // Remove associated overrides
      const nextOverrides = { ...state.detailOverrides };
      delete nextOverrides[id];
      return { phasesByEntry: next, detailOverrides: nextOverrides };
    });
    if (beforePhase) {
      notifyPhaseDocumentWrite(beforePhase, "phase.delete");
    }

    if (!beforePhase) return;
    if (useGlobalHistoryStore.getState().isReplaying) return;

    const cap = {
      phase: { ...beforePhase },
      overrides: beforeOverrides.map((ov) => ({ ...ov })),
      projectEpoch: epoch,
      redoDeleteVersion: null as number | null,
      logicalVersion: beforePhase.version,
    };
    useGlobalHistoryStore.getState().push({
      kind: "phase",
      label: i18next.t("phase.history.deleted"),
      entityId: cap.phase.id,
      documentKey: {
        kind: "codex",
        id: cap.phase.entryId,
        phaseId: cap.phase.id,
      },
      retainOnVersionConflict: true,
      async undo() {
        if (get().projectEpoch !== cap.projectEpoch) return;
        invalidatePhaseEntryLoads(cap.phase.entryId);
        const restored = await phaseApi.createPhase({
          id: cap.phase.id,
          entryId: cap.phase.entryId,
          anchorNodeId: cap.phase.anchorNodeId ?? null,
          label: cap.phase.label,
          summaryOverride: cap.phase.summaryOverride ?? null,
          contentOverride: cap.phase.contentOverride ?? null,
          contextModeOverride: cap.phase.contextModeOverride ?? null,
          // Use the most recently deleted token, not the original snapshot.
          // Every delete→restore cycle advances monotonically and rejects
          // editors whose session predates the deletion.
          version:
            (cap.redoDeleteVersion ??
              resolvePhaseHistoryVersion(cap.phase.id, cap.logicalVersion)) + 1,
          createdAt: cap.phase.createdAt,
          updatedAt: cap.phase.updatedAt,
        });
        cap.redoDeleteVersion = restored.version;
        advancePhaseHistoryVersion(
          cap.phase.id,
          cap.logicalVersion,
          restored.version,
        );
        if (get().projectEpoch !== cap.projectEpoch) return;
        // Restore detail overrides
        for (const ov of cap.overrides) {
          if (get().projectEpoch !== cap.projectEpoch) return;
          await phaseApi.upsertDetailOverride(
            cap.phase.id,
            ov.definitionId,
            ov.value ?? null,
          );
        }
        if (get().projectEpoch !== cap.projectEpoch) return;
        invalidatePhaseEntryLoads(cap.phase.entryId);
        set((state) => {
          if (state.projectEpoch !== cap.projectEpoch) return state;
          return {
            phasesByEntry: {
              ...state.phasesByEntry,
              [cap.phase.entryId]: [
                ...(state.phasesByEntry[cap.phase.entryId] ?? []),
                restored,
              ],
            },
            detailOverrides: {
              ...state.detailOverrides,
              [cap.phase.id]: cap.overrides,
            },
          };
        });
        notifyPhaseDocumentWrite(restored, "phase.delete.undo");
      },
      async redo() {
        if (get().projectEpoch !== cap.projectEpoch) return;
        invalidatePhaseEntryLoads(cap.phase.entryId);
        cap.redoDeleteVersion = resolvePhaseHistoryVersion(
          cap.phase.id,
          cap.logicalVersion,
        );
        await phaseApi.deletePhase(cap.phase.id, {
          expectedVersion: cap.redoDeleteVersion,
        });
        if (get().projectEpoch !== cap.projectEpoch) return;
        invalidatePhaseEntryLoads(cap.phase.entryId);
        set((state) => {
          if (state.projectEpoch !== cap.projectEpoch) return state;
          const next = {
            ...state.phasesByEntry,
            [cap.phase.entryId]: (
              state.phasesByEntry[cap.phase.entryId] ?? []
            ).filter((p) => p.id !== cap.phase.id),
          };
          const nextOverrides = { ...state.detailOverrides };
          delete nextOverrides[cap.phase.id];
          return { phasesByEntry: next, detailOverrides: nextOverrides };
        });
        notifyPhaseDocumentWrite(cap.phase, "phase.delete.redo");
      },
    });
  },

  async upsertDetailOverride(phaseId, definitionId, value) {
    const epoch = get().projectEpoch;
    const entryId = findEntryIdForPhase(get(), phaseId);
    invalidatePhaseEntryLoads(entryId);
    // Capture before-state: was there an existing override?
    const beforeOverride = (get().detailOverrides[phaseId] ?? []).find(
      (ov) => ov.definitionId === definitionId,
    );
    const beforeValue = beforeOverride ? beforeOverride.value : undefined;

    const override = await phaseApi.upsertDetailOverride(
      phaseId,
      definitionId,
      value,
    );
    if (get().projectEpoch !== epoch) return;
    invalidatePhaseEntryLoads(entryId);
    set((state) => {
      if (state.projectEpoch !== epoch) return state;
      const existing = (state.detailOverrides[phaseId] ?? []).filter(
        (ov) => ov.definitionId !== definitionId,
      );
      return {
        detailOverrides: {
          ...state.detailOverrides,
          [phaseId]: [...existing, override],
        },
      };
    });

    if (useGlobalHistoryStore.getState().isReplaying) return;

    const cap = {
      phaseId,
      definitionId,
      beforeValue,
      afterValue: value,
      entryId,
      projectEpoch: epoch,
    };
    useGlobalHistoryStore.getState().push({
      kind: "phase",
      label: i18next.t("phase.history.detailOverrideUpdated"),
      async undo() {
        if (get().projectEpoch !== cap.projectEpoch) return;
        invalidatePhaseEntryLoads(cap.entryId);
        if (cap.beforeValue === undefined) {
          // Was missing → delete
          await phaseApi.deleteDetailOverride(cap.phaseId, cap.definitionId);
          if (get().projectEpoch !== cap.projectEpoch) return;
          invalidatePhaseEntryLoads(cap.entryId);
          set((state) => {
            if (state.projectEpoch !== cap.projectEpoch) return state;
            return {
              detailOverrides: {
                ...state.detailOverrides,
                [cap.phaseId]: (
                  state.detailOverrides[cap.phaseId] ?? []
                ).filter((ov) => ov.definitionId !== cap.definitionId),
              },
            };
          });
        } else {
          const restored = await phaseApi.upsertDetailOverride(
            cap.phaseId,
            cap.definitionId,
            cap.beforeValue,
          );
          if (get().projectEpoch !== cap.projectEpoch) return;
          invalidatePhaseEntryLoads(cap.entryId);
          set((state) => {
            if (state.projectEpoch !== cap.projectEpoch) return state;
            return {
              detailOverrides: {
                ...state.detailOverrides,
                [cap.phaseId]: [
                  ...(state.detailOverrides[cap.phaseId] ?? []).filter(
                    (ov) => ov.definitionId !== cap.definitionId,
                  ),
                  restored,
                ],
              },
            };
          });
        }
      },
      async redo() {
        if (get().projectEpoch !== cap.projectEpoch) return;
        invalidatePhaseEntryLoads(cap.entryId);
        const reapplied = await phaseApi.upsertDetailOverride(
          cap.phaseId,
          cap.definitionId,
          cap.afterValue,
        );
        if (get().projectEpoch !== cap.projectEpoch) return;
        invalidatePhaseEntryLoads(cap.entryId);
        set((state) => {
          if (state.projectEpoch !== cap.projectEpoch) return state;
          return {
            detailOverrides: {
              ...state.detailOverrides,
              [cap.phaseId]: [
                ...(state.detailOverrides[cap.phaseId] ?? []).filter(
                  (ov) => ov.definitionId !== cap.definitionId,
                ),
                reapplied,
              ],
            },
          };
        });
      },
    });
  },

  async deleteDetailOverride(phaseId, definitionId) {
    const epoch = get().projectEpoch;
    const entryId = findEntryIdForPhase(get(), phaseId);
    invalidatePhaseEntryLoads(entryId);
    const beforeOverride = (get().detailOverrides[phaseId] ?? []).find(
      (ov) => ov.definitionId === definitionId,
    );

    await phaseApi.deleteDetailOverride(phaseId, definitionId);
    if (get().projectEpoch !== epoch) return;
    invalidatePhaseEntryLoads(entryId);
    set((state) => {
      if (state.projectEpoch !== epoch) return state;
      const filtered = (state.detailOverrides[phaseId] ?? []).filter(
        (ov) => ov.definitionId !== definitionId,
      );
      return {
        detailOverrides: {
          ...state.detailOverrides,
          [phaseId]: filtered,
        },
      };
    });

    if (!beforeOverride) return;
    if (useGlobalHistoryStore.getState().isReplaying) return;

    const cap = {
      override: { ...beforeOverride },
      entryId,
      projectEpoch: epoch,
    };
    useGlobalHistoryStore.getState().push({
      kind: "phase",
      label: i18next.t("phase.history.detailOverrideDeleted"),
      async undo() {
        if (get().projectEpoch !== cap.projectEpoch) return;
        invalidatePhaseEntryLoads(cap.entryId);
        const restored = await phaseApi.upsertDetailOverride(
          cap.override.phaseId,
          cap.override.definitionId,
          cap.override.value ?? null,
        );
        if (get().projectEpoch !== cap.projectEpoch) return;
        invalidatePhaseEntryLoads(cap.entryId);
        set((state) => {
          if (state.projectEpoch !== cap.projectEpoch) return state;
          return {
            detailOverrides: {
              ...state.detailOverrides,
              [cap.override.phaseId]: [
                ...(state.detailOverrides[cap.override.phaseId] ?? []).filter(
                  (ov) => ov.definitionId !== cap.override.definitionId,
                ),
                restored,
              ],
            },
          };
        });
      },
      async redo() {
        if (get().projectEpoch !== cap.projectEpoch) return;
        invalidatePhaseEntryLoads(cap.entryId);
        await phaseApi.deleteDetailOverride(
          cap.override.phaseId,
          cap.override.definitionId,
        );
        if (get().projectEpoch !== cap.projectEpoch) return;
        invalidatePhaseEntryLoads(cap.entryId);
        set((state) => {
          if (state.projectEpoch !== cap.projectEpoch) return state;
          return {
            detailOverrides: {
              ...state.detailOverrides,
              [cap.override.phaseId]: (
                state.detailOverrides[cap.override.phaseId] ?? []
              ).filter((ov) => ov.definitionId !== cap.override.definitionId),
            },
          };
        });
      },
    });
  },

  recomputeSceneOrder(nodes) {
    const sceneTimeIndex = buildSceneTimeIndex(
      nodes,
      get().sceneTimeIndex.revision + 1,
    );
    const order = linearizeSceneTimeIndex(sceneTimeIndex, get().resolutionMode);
    set({ globalSceneOrder: order, sceneTimeIndex, cachedNodes: nodes });
  },

  setResolutionMode(mode) {
    set({ resolutionMode: mode });
    const order = linearizeSceneTimeIndex(get().sceneTimeIndex, mode);
    set({ globalSceneOrder: order });
  },

  resolveForScene(entries, baseDetails, currentSceneId) {
    const { phasesByEntry, detailOverrides, sceneTimeIndex, resolutionMode } =
      get();
    const resolved: Record<string, ResolvedCodexState> = {};

    for (const entry of entries) {
      const phases = phasesByEntry[entry.id] ?? [];
      const phaseDetailsMap = new Map<string, CodexPhaseDetailOverride[]>();
      for (const phase of phases) {
        phaseDetailsMap.set(phase.id, detailOverrides[phase.id] ?? []);
      }
      const entryBaseDetails: Map<string, string | null> =
        baseDetails.get(entry.id) ?? new Map();

      resolved[entry.id] = resolveCodexState(
        {
          summary: entry.summary ?? null,
          content: entry.content,
          contextMode: entry.contextMode,
        },
        phases,
        phaseDetailsMap,
        entryBaseDetails,
        currentSceneId
          ? { kind: "scene", sceneId: currentSceneId }
          : { kind: "base" },
        sceneTimeIndex,
        resolutionMode,
      );
    }

    set({ resolvedStates: resolved });
  },

  getResolvedState(entryId) {
    return get().resolvedStates[entryId] ?? null;
  },
}));
