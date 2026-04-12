import { create } from "zustand";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntry } from "./api";
import * as phaseApi from "./phaseApi";
import type { CodexEntryPhase, CodexPhaseDetailOverride } from "./phaseApi";
import {
  computeGlobalSceneOrder,
  resolveCodexState,
  type ResolvedCodexState,
} from "./phaseResolver";

interface PhaseState {
  phasesByEntry: Record<string, CodexEntryPhase[]>;
  detailOverrides: Record<string, CodexPhaseDetailOverride[]>; // phaseId → overrides
  globalSceneOrder: Map<string, number>;
  resolvedStates: Record<string, ResolvedCodexState>; // entryId → resolved (キャッシュ)

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

  async loadPhasesForEntry(entryId) {
    const phases = await phaseApi.listPhasesByEntry(entryId);
    const phaseIds = phases.map((p) => p.id);
    const allOverrides = await phaseApi.listDetailOverridesByPhaseIds(phaseIds);

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
    const phase = await phaseApi.createPhase({
      id: crypto.randomUUID(),
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
    return phase;
  },

  async updatePhase(id, data) {
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
  },

  async deletePhase(id) {
    // Find entryId before deleting
    let entryId: string | undefined;
    for (const [eid, phases] of Object.entries(get().phasesByEntry)) {
      if (phases.some((p) => p.id === id)) {
        entryId = eid;
        break;
      }
    }

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
  },

  async upsertDetailOverride(phaseId, definitionId, value) {
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
  },

  async deleteDetailOverride(phaseId, definitionId) {
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
  },

  recomputeSceneOrder(nodes) {
    const order = computeGlobalSceneOrder(nodes);
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
