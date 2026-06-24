import { create } from "zustand";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { generateKeyBetween, cmpKeys } from "@/features/tree/fractionalIndex";
import type { PlotPhaseType, PlotBranchKind } from "@/db/schema";
import {
  listPlotThreads,
  listPlotThreadLinks,
  listPlotThreadBranches,
  createPlotThread,
  updatePlotThread,
  deletePlotThread,
  createPlotThreadLink,
  updatePlotThreadLink,
  deletePlotThreadLink,
  createPlotThreadBranch,
  deletePlotThreadBranch,
  type PlotThreadRow,
  type PlotThreadLinkRow,
  type PlotThreadBranchRow,
} from "./api";

interface PlotThreadState {
  threads: PlotThreadRow[];
  links: PlotThreadLinkRow[];
  branches: PlotThreadBranchRow[];
  loading: boolean;
  load: (projectId: string) => Promise<void>;
  addThread: (
    projectId: string,
    name: string,
    color?: string | null,
  ) => Promise<void>;
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
    patch: Partial<
      Pick<PlotThreadLinkRow, "threadId" | "nodeId" | "phaseType" | "note">
    >,
  ) => Promise<void>;
  deleteMarker: (id: string) => Promise<void>;
  addBranch: (data: {
    projectId: string;
    fromThreadId: string;
    toThreadId: string;
    atNodeId: string;
    kind: PlotBranchKind;
  }) => Promise<void>;
  deleteBranch: (id: string) => Promise<void>;
}

export const usePlotThreadStore = create<PlotThreadState>((set, get) => ({
  threads: [],
  links: [],
  branches: [],
  loading: false,

  load: async (projectId) => {
    // 前プロジェクトのレーンを即座にクリア（切替時に一瞬残骸を見せない）。
    set({ threads: [], links: [], branches: [], loading: true });
    const [threads, links, branches] = await Promise.all([
      listPlotThreads(projectId),
      listPlotThreadLinks(projectId),
      listPlotThreadBranches(projectId),
    ]);
    // stale ガード: async 中にプロジェクトが切り替わっていたら破棄
    // （Grimodex 頻出のストア汚染対策）。より新しい load が状態を所有する。
    if (getCurrentProjectId() !== projectId) return;
    set({ threads, links, branches, loading: false });
  },

  addThread: async (projectId, name, color = null) => {
    // sortOrder は「末尾」ではなく実際の最大キーの後に置く
    // （listPlotThreads の返却順に依存しないため）。
    const maxKey = get().threads.reduce<string | null>(
      (m, t) => (m === null || cmpKeys(t.sortOrder, m) > 0 ? t.sortOrder : m),
      null,
    );
    const sortOrder = generateKeyBetween(maxKey, null);
    const created = await createPlotThread({
      projectId,
      name,
      color,
      sortOrder,
    });
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
      // from/to どちらかが消えた分岐エッジも CASCADE で消える。
      branches: get().branches.filter(
        (b) => b.fromThreadId !== id && b.toThreadId !== id,
      ),
    });
  },

  addMarker: async (threadId, nodeId, phaseType) => {
    // stale ガード: await 中にプロジェクトが切り替わったら反映しない
    // （他メソッドと同じ XPROJ 不変条件を守る）。
    const pid = getCurrentProjectId();
    const created = await createPlotThreadLink({ threadId, nodeId, phaseType });
    if (getCurrentProjectId() !== pid) return;
    set({ links: [...get().links, created] });
  },

  updateMarker: async (id, patch) => {
    const pid = getCurrentProjectId();
    await updatePlotThreadLink(id, patch);
    if (getCurrentProjectId() !== pid) return;
    set({
      links: get().links.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    });
  },

  deleteMarker: async (id) => {
    const pid = getCurrentProjectId();
    await deletePlotThreadLink(id);
    if (getCurrentProjectId() !== pid) return;
    set({ links: get().links.filter((l) => l.id !== id) });
  },

  addBranch: async (data) => {
    // 自己参照を弾く。
    if (data.fromThreadId === data.toThreadId) return;
    // XPROJ ガード: from/to は現在ロード中（＝同一 project）のスレッドのみ許可。
    // branch は Rust コマンドを経由せず Drizzle 直書きのため、ここで不変条件を守る。
    const threads = get().threads;
    const known = (id: string) => threads.some((t) => t.id === id);
    if (!known(data.fromThreadId) || !known(data.toThreadId)) return;
    // 同一(from,to,atNode,kind)の重複を弾く（DnD/手動の両経路で共通）。
    const dup = get().branches.some(
      (b) =>
        b.fromThreadId === data.fromThreadId &&
        b.toThreadId === data.toThreadId &&
        b.atNodeId === data.atNodeId &&
        b.kind === data.kind,
    );
    if (dup) return;
    const created = await createPlotThreadBranch(data);
    if (getCurrentProjectId() !== data.projectId) return;
    set({ branches: [...get().branches, created] });
  },

  deleteBranch: async (id) => {
    await deletePlotThreadBranch(id);
    set({ branches: get().branches.filter((b) => b.id !== id) });
  },
}));
