import { create } from "zustand";
import {
  listLabels,
  createLabel,
  updateLabel,
  deleteLabel,
  setNodeLabels,
  reorderLabels,
  listAllNodeLabels,
} from "./labelApi";
import type { Label } from "./labelApi";

interface LabelState {
  labels: Label[];
  nodeLabels: Record<string, string[]>; // nodeId → labelId[]
  loading: boolean;
  projectId: string | null;

  load: (projectId: string) => Promise<void>;
  /** Clear project-owned labels before a reload. */
  resetForProject: () => void;
  addLabel: (data: { name: string; color: string }) => Promise<Label | null>;
  updateLabel: (
    id: string,
    data: { name?: string; color?: string },
  ) => Promise<void>;
  removeLabel: (id: string) => Promise<void>;
  setNodeLabels: (nodeId: string, labelIds: string[]) => Promise<void>;
  reorderLabels: (orderedIds: string[]) => Promise<void>;
}

export const useLabelStore = create<LabelState>()((set, get) => ({
  labels: [],
  nodeLabels: {},
  loading: false,
  projectId: null,

  resetForProject: () =>
    set({ labels: [], nodeLabels: {}, loading: false, projectId: null }),

  async load(projectId) {
    if (get().loading) return;
    set({ loading: true, projectId });
    try {
      const [labelList, nodeLabelMap] = await Promise.all([
        listLabels(projectId),
        listAllNodeLabels(projectId),
      ]);
      set({ labels: labelList, nodeLabels: nodeLabelMap });
    } finally {
      set({ loading: false });
    }
  },

  async addLabel({ name, color }) {
    const projectId = get().projectId;
    if (!projectId) return null;
    const maxOrder = Math.max(-1, ...get().labels.map((l) => l.sortOrder));
    const id = crypto.randomUUID();
    const newLabel = await createLabel({
      id,
      projectId,
      name,
      color,
      sortOrder: maxOrder + 1.0,
    });
    set((s) => ({ labels: [...s.labels, newLabel] }));
    return newLabel;
  },

  async updateLabel(id, data) {
    const updated = await updateLabel(id, data);
    if (!updated) return;
    set((s) => ({
      labels: s.labels.map((l) => (l.id === id ? updated : l)),
    }));
  },

  async removeLabel(id) {
    await deleteLabel(id);
    set((s) => ({
      labels: s.labels.filter((l) => l.id !== id),
      nodeLabels: Object.fromEntries(
        Object.entries(s.nodeLabels).map(([nodeId, ids]) => [
          nodeId,
          ids.filter((lid) => lid !== id),
        ]),
      ),
    }));
  },

  async setNodeLabels(nodeId, labelIds) {
    await setNodeLabels(nodeId, labelIds);
    set((s) => ({
      nodeLabels: { ...s.nodeLabels, [nodeId]: labelIds },
    }));
  },

  async reorderLabels(orderedIds) {
    await reorderLabels(orderedIds);
    set((s) => {
      const byId = Object.fromEntries(s.labels.map((l) => [l.id, l]));
      return {
        labels: orderedIds
          .filter((id) => byId[id])
          .map((id, i) => ({ ...byId[id], sortOrder: i * 1.0 })),
      };
    });
  },
}));
