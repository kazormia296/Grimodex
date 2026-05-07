import { create } from "zustand";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntry } from "./api";
import * as phaseApi from "./phaseApi";
import type { CodexEntryPhase, CodexPhaseDetailOverride } from "./phaseApi";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import {
  computeSceneTimeIndex,
  resolveCodexState,
  type PhaseResolutionMode,
  type ResolvedCodexState,
} from "./phaseResolver";

interface PhaseState {
  phasesByEntry: Record<string, CodexEntryPhase[]>;
  detailOverrides: Record<string, CodexPhaseDetailOverride[]>; // phaseId → overrides
  globalSceneOrder: Map<string, number>;
  resolvedStates: Record<string, ResolvedCodexState>; // entryId → resolved (キャッシュ)
  resolutionMode: PhaseResolutionMode;
  cachedNodes: TreeNodeData[];

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
  ): Promise<void>;
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

export const usePhaseStore = create<PhaseState>()((set, get) => ({
  phasesByEntry: {},
  detailOverrides: {},
  globalSceneOrder: new Map(),
  resolvedStates: {},
  resolutionMode: "reading",
  cachedNodes: [],

  async loadPhasesForEntry(entryId) {
    let phases: CodexEntryPhase[];
    let allOverrides: CodexPhaseDetailOverride[];
    try {
      phases = await phaseApi.listPhasesByEntry(entryId);
      const phaseIds = phases.map((p) => p.id);
      allOverrides = await phaseApi.listDetailOverridesByPhaseIds(phaseIds);
    } catch {
      return; // DB未接続時などは無視
    }

    const overridesByPhase: Record<string, CodexPhaseDetailOverride[]> = {};
    for (const ov of allOverrides) {
      if (!overridesByPhase[ov.phaseId]) overridesByPhase[ov.phaseId] = [];
      overridesByPhase[ov.phaseId].push(ov);
    }

    set((state) => ({
      phasesByEntry: { ...state.phasesByEntry, [entryId]: phases },
      detailOverrides: { ...state.detailOverrides, ...overridesByPhase },
    }));
  },

  async createPhase(data) {
    const id = crypto.randomUUID();
    const phase = await phaseApi.createPhase({
      id,
      ...data,
    });
    set((state) => {
      const existing = state.phasesByEntry[phase.entryId] ?? [];
      return {
        phasesByEntry: {
          ...state.phasesByEntry,
          [phase.entryId]: [...existing, phase],
        },
      };
    });

    if (!useGlobalHistoryStore.getState().isReplaying) {
      const cap = { ...phase };
      useGlobalHistoryStore.getState().push({
        kind: "phase",
        label: "Phase作成",
        async undo() {
          await phaseApi.deletePhase(cap.id);
          set((state) => ({
            phasesByEntry: {
              ...state.phasesByEntry,
              [cap.entryId]: (state.phasesByEntry[cap.entryId] ?? []).filter(
                (p) => p.id !== cap.id,
              ),
            },
          }));
        },
        async redo() {
          await phaseApi.createPhase({
            id: cap.id,
            entryId: cap.entryId,
            anchorNodeId: cap.anchorNodeId ?? null,
            label: cap.label,
            summaryOverride: cap.summaryOverride ?? null,
            contentOverride: cap.contentOverride ?? null,
            contextModeOverride: cap.contextModeOverride ?? null,
          });
          set((state) => ({
            phasesByEntry: {
              ...state.phasesByEntry,
              [cap.entryId]: [
                ...(state.phasesByEntry[cap.entryId] ?? []).filter(
                  (p) => p.id !== cap.id,
                ),
                cap,
              ],
            },
          }));
        },
      });
    }

    return phase;
  },

  async updatePhase(id, data) {
    // Capture before-state of patched fields for undo
    let before: CodexEntryPhase | undefined;
    for (const phases of Object.values(get().phasesByEntry)) {
      const found = phases.find((p) => p.id === id);
      if (found) {
        before = found;
        break;
      }
    }

    const updated = await phaseApi.updatePhase(id, data);
    if (!updated) return;
    set((state) => {
      const entryId = updated.entryId;
      const phases = (state.phasesByEntry[entryId] ?? []).map((p) =>
        p.id === id ? updated : p,
      );
      return {
        phasesByEntry: { ...state.phasesByEntry, [entryId]: phases },
      };
    });

    if (!before) return;
    if (useGlobalHistoryStore.getState().isReplaying) return;

    const undoPatch: Parameters<typeof phaseApi.updatePhase>[1] = {};
    for (const key of Object.keys(data) as (keyof typeof data)[]) {
      const v = (before as unknown as Record<string, unknown>)[key];
      // @ts-expect-error narrow union not assignable here
      undoPatch[key] = v ?? null;
    }
    const cap = { id, before: { ...before }, undoPatch, redoPatch: data };
    useGlobalHistoryStore.getState().push({
      kind: "phase",
      label: "Phase更新",
      async undo() {
        const restored = await phaseApi.updatePhase(cap.id, cap.undoPatch);
        if (restored) {
          set((state) => {
            const entryId = restored.entryId;
            const phases = (state.phasesByEntry[entryId] ?? []).map((p) =>
              p.id === cap.id ? restored : p,
            );
            return {
              phasesByEntry: { ...state.phasesByEntry, [entryId]: phases },
            };
          });
        }
      },
      async redo() {
        const reapplied = await phaseApi.updatePhase(cap.id, cap.redoPatch);
        if (reapplied) {
          set((state) => {
            const entryId = reapplied.entryId;
            const phases = (state.phasesByEntry[entryId] ?? []).map((p) =>
              p.id === cap.id ? reapplied : p,
            );
            return {
              phasesByEntry: { ...state.phasesByEntry, [entryId]: phases },
            };
          });
        }
      },
    });
  },

  async deletePhase(id) {
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

    await phaseApi.deletePhase(id);

    set((state) => {
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

    if (!beforePhase) return;
    if (useGlobalHistoryStore.getState().isReplaying) return;

    const cap = {
      phase: { ...beforePhase },
      overrides: beforeOverrides.map((ov) => ({ ...ov })),
    };
    useGlobalHistoryStore.getState().push({
      kind: "phase",
      label: "Phase削除",
      async undo() {
        await phaseApi.createPhase({
          id: cap.phase.id,
          entryId: cap.phase.entryId,
          anchorNodeId: cap.phase.anchorNodeId ?? null,
          label: cap.phase.label,
          summaryOverride: cap.phase.summaryOverride ?? null,
          contentOverride: cap.phase.contentOverride ?? null,
          contextModeOverride: cap.phase.contextModeOverride ?? null,
        });
        // Restore detail overrides
        for (const ov of cap.overrides) {
          await phaseApi.upsertDetailOverride(
            cap.phase.id,
            ov.definitionId,
            ov.value ?? null,
          );
        }
        set((state) => ({
          phasesByEntry: {
            ...state.phasesByEntry,
            [cap.phase.entryId]: [
              ...(state.phasesByEntry[cap.phase.entryId] ?? []),
              cap.phase,
            ],
          },
          detailOverrides: {
            ...state.detailOverrides,
            [cap.phase.id]: cap.overrides,
          },
        }));
      },
      async redo() {
        await phaseApi.deletePhase(cap.phase.id);
        set((state) => {
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
      },
    });
  },

  async upsertDetailOverride(phaseId, definitionId, value) {
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
    set((state) => {
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

    const cap = { phaseId, definitionId, beforeValue, afterValue: value };
    useGlobalHistoryStore.getState().push({
      kind: "phase",
      label: "詳細上書き更新",
      async undo() {
        if (cap.beforeValue === undefined) {
          // Was missing → delete
          await phaseApi.deleteDetailOverride(cap.phaseId, cap.definitionId);
          set((state) => ({
            detailOverrides: {
              ...state.detailOverrides,
              [cap.phaseId]: (state.detailOverrides[cap.phaseId] ?? []).filter(
                (ov) => ov.definitionId !== cap.definitionId,
              ),
            },
          }));
        } else {
          const restored = await phaseApi.upsertDetailOverride(
            cap.phaseId,
            cap.definitionId,
            cap.beforeValue,
          );
          set((state) => ({
            detailOverrides: {
              ...state.detailOverrides,
              [cap.phaseId]: [
                ...(state.detailOverrides[cap.phaseId] ?? []).filter(
                  (ov) => ov.definitionId !== cap.definitionId,
                ),
                restored,
              ],
            },
          }));
        }
      },
      async redo() {
        const reapplied = await phaseApi.upsertDetailOverride(
          cap.phaseId,
          cap.definitionId,
          cap.afterValue,
        );
        set((state) => ({
          detailOverrides: {
            ...state.detailOverrides,
            [cap.phaseId]: [
              ...(state.detailOverrides[cap.phaseId] ?? []).filter(
                (ov) => ov.definitionId !== cap.definitionId,
              ),
              reapplied,
            ],
          },
        }));
      },
    });
  },

  async deleteDetailOverride(phaseId, definitionId) {
    const beforeOverride = (get().detailOverrides[phaseId] ?? []).find(
      (ov) => ov.definitionId === definitionId,
    );

    await phaseApi.deleteDetailOverride(phaseId, definitionId);
    set((state) => {
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

    const cap = { ...beforeOverride };
    useGlobalHistoryStore.getState().push({
      kind: "phase",
      label: "詳細上書き削除",
      async undo() {
        const restored = await phaseApi.upsertDetailOverride(
          cap.phaseId,
          cap.definitionId,
          cap.value ?? null,
        );
        set((state) => ({
          detailOverrides: {
            ...state.detailOverrides,
            [cap.phaseId]: [
              ...(state.detailOverrides[cap.phaseId] ?? []).filter(
                (ov) => ov.definitionId !== cap.definitionId,
              ),
              restored,
            ],
          },
        }));
      },
      async redo() {
        await phaseApi.deleteDetailOverride(cap.phaseId, cap.definitionId);
        set((state) => ({
          detailOverrides: {
            ...state.detailOverrides,
            [cap.phaseId]: (state.detailOverrides[cap.phaseId] ?? []).filter(
              (ov) => ov.definitionId !== cap.definitionId,
            ),
          },
        }));
      },
    });
  },

  recomputeSceneOrder(nodes) {
    const order = computeSceneTimeIndex(nodes, get().resolutionMode);
    set({ globalSceneOrder: order, cachedNodes: nodes });
  },

  setResolutionMode(mode) {
    set({ resolutionMode: mode });
    const order = computeSceneTimeIndex(get().cachedNodes, mode);
    set({ globalSceneOrder: order });
  },

  resolveForScene(entries, baseDetails, currentSceneId) {
    const { phasesByEntry, detailOverrides, globalSceneOrder } = get();
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
        currentSceneId,
        globalSceneOrder,
      );
    }

    set({ resolvedStates: resolved });
  },

  getResolvedState(entryId) {
    return get().resolvedStates[entryId] ?? null;
  },
}));
