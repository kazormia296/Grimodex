import { create } from "zustand";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { generateKeyBetween } from "@/features/tree/fractionalIndex";
import type { PlotPhaseType } from "@/db/schema";
import {
  listPlotThreads,
  listPlotThreadLinks,
  createPlotThread,
  updatePlotThread,
  deletePlotThread,
  createPlotThreadLink,
  updatePlotThreadLink,
  deletePlotThreadLink,
  type PlotThreadRow,
  type PlotThreadLinkRow,
} from "./api";

interface PlotThreadState {
  threads: PlotThreadRow[];
  links: PlotThreadLinkRow[];
  loading: boolean;
  load: (projectId: string) => Promise<void>;
  addThread: (projectId: string, name: string) => Promise<void>;
  renameThread: (id: string, name: string) => Promise<void>;
  setThreadColor: (id: string, color: string | null) => Promise<void>;
  deleteThread: (id: string) => Promise<void>;
  addMarker: (
    threadId: string,
    nodeId: string,
    phaseType: PlotPhaseType,
  ) => Promise<void>;
  updateMarker: (
    id: string,
    patch: Partial<Pick<PlotThreadLinkRow, "nodeId" | "phaseType" | "note">>,
  ) => Promise<void>;
  deleteMarker: (id: string) => Promise<void>;
}

export const usePlotThreadStore = create<PlotThreadState>((set, get) => ({
  threads: [],
  links: [],
  loading: false,

  load: async (projectId) => {
    set({ loading: true });
    const [threads, links] = await Promise.all([
      listPlotThreads(projectId),
      listPlotThreadLinks(projectId),
    ]);
    // stale ガード: async 中にプロジェクトが切り替わっていたら破棄
    // （Grimodex 頻出のストア汚染対策）。
    if (getCurrentProjectId() !== projectId) return;
    set({ threads, links, loading: false });
  },

  addThread: async (projectId, name) => {
    const { threads } = get();
    const last = threads[threads.length - 1];
    const sortOrder = generateKeyBetween(last ? last.sortOrder : null, null);
    const created = await createPlotThread({ projectId, name, sortOrder });
    if (getCurrentProjectId() !== projectId) return;
    set({ threads: [...get().threads, created] });
  },

  renameThread: async (id, name) => {
    await updatePlotThread(id, { name });
    set({
      threads: get().threads.map((t) => (t.id === id ? { ...t, name } : t)),
    });
  },

  setThreadColor: async (id, color) => {
    await updatePlotThread(id, { color });
    set({
      threads: get().threads.map((t) => (t.id === id ? { ...t, color } : t)),
    });
  },

  deleteThread: async (id) => {
    await deletePlotThread(id);
    set({
      threads: get().threads.filter((t) => t.id !== id),
      links: get().links.filter((l) => l.threadId !== id), // CASCADE をローカルにも反映
    });
  },

  addMarker: async (threadId, nodeId, phaseType) => {
    const created = await createPlotThreadLink({ threadId, nodeId, phaseType });
    set({ links: [...get().links, created] });
  },

  updateMarker: async (id, patch) => {
    await updatePlotThreadLink(id, patch);
    set({
      links: get().links.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    });
  },

  deleteMarker: async (id) => {
    await deletePlotThreadLink(id);
    set({ links: get().links.filter((l) => l.id !== id) });
  },
}));
