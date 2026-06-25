import { create } from "zustand";
import i18next from "i18next";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { generateKeyBetween, cmpKeys } from "@/features/tree/fractionalIndex";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import type { PlotPhaseType, PlotBranchKind } from "@/db/schema";
import {
  listPlotThreads,
  listPlotThreadLinks,
  listPlotThreadBranches,
  createPlotThread,
  updatePlotThread,
  deletePlotThread,
  restorePlotThread,
  createPlotThreadLink,
  updatePlotThreadLink,
  deletePlotThreadLink,
  restorePlotThreadLink,
  createPlotThreadBranch,
  updatePlotThreadBranch,
  deletePlotThreadBranch,
  restorePlotThreadBranch,
  type PlotThreadRow,
  type PlotThreadLinkRow,
  type PlotThreadBranchRow,
} from "./api";

/**
 * Undo/Redo: プロットスレッド操作を globalHistoryStore に1エントリ積む。
 * replay 中は no-op（push 自体も safety net で弾くが、ここで早期 return して
 * クロージャ生成も省く）。closures は逆操作 API + set を直接叩き、ストアの公開
 * mutation を呼ばない（再 push の再帰を避ける。codexStore と同方針）。複数 mutation
 * を1ユーザー操作にまとめたい経路（マーカードラッグ）は呼び出し側で
 * useGlobalHistoryStore.runAsTransaction で包む。
 */
function recordPlotHistory(cmd: {
  label: string;
  entityId?: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}): void {
  const history = useGlobalHistoryStore.getState();
  if (history.isReplaying) return;
  history.push({ kind: "plot", ...cmd });
}

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
  updateBranch: (
    id: string,
    patch: Partial<
      Pick<PlotThreadBranchRow, "fromThreadId" | "toThreadId" | "atNodeId">
    >,
  ) => Promise<void>;
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
    const captured = { ...created };
    recordPlotHistory({
      label: i18next.t("plotThread.history.addThread", "スレッド追加"),
      entityId: captured.id,
      undo: async () => {
        await deletePlotThread(captured.id);
        set({ threads: get().threads.filter((t) => t.id !== captured.id) });
      },
      redo: async () => {
        await restorePlotThread(captured);
        set({ threads: [...get().threads, captured] });
      },
    });
  },

  renameThread: async (id, name) => {
    const before = get().threads.find((t) => t.id === id)?.name;
    await updatePlotThread(id, { name });
    set({
      threads: get().threads.map((t) => (t.id === id ? { ...t, name } : t)),
    });
    if (before === undefined) return;
    recordPlotHistory({
      label: i18next.t("plotThread.history.renameThread", "スレッド名変更"),
      entityId: id,
      undo: async () => {
        await updatePlotThread(id, { name: before });
        set({
          threads: get().threads.map((t) =>
            t.id === id ? { ...t, name: before } : t,
          ),
        });
      },
      redo: async () => {
        await updatePlotThread(id, { name });
        set({
          threads: get().threads.map((t) => (t.id === id ? { ...t, name } : t)),
        });
      },
    });
  },

  setThreadColor: async (id, color) => {
    const before = get().threads.find((t) => t.id === id);
    await updatePlotThread(id, { color });
    set({
      threads: get().threads.map((t) => (t.id === id ? { ...t, color } : t)),
    });
    if (!before) return;
    const prevColor = before.color;
    recordPlotHistory({
      label: i18next.t("plotThread.history.colorThread", "スレッド色変更"),
      entityId: id,
      undo: async () => {
        await updatePlotThread(id, { color: prevColor });
        set({
          threads: get().threads.map((t) =>
            t.id === id ? { ...t, color: prevColor } : t,
          ),
        });
      },
      redo: async () => {
        await updatePlotThread(id, { color });
        set({
          threads: get().threads.map((t) =>
            t.id === id ? { ...t, color } : t,
          ),
        });
      },
    });
  },

  deleteThread: async (id) => {
    const thread = get().threads.find((t) => t.id === id);
    const removedLinks = get().links.filter((l) => l.threadId === id);
    // from/to どちらかが消えた分岐エッジも CASCADE で消える。
    const removedBranches = get().branches.filter(
      (b) => b.fromThreadId === id || b.toThreadId === id,
    );
    const applyDelete = () =>
      set({
        threads: get().threads.filter((t) => t.id !== id),
        links: get().links.filter((l) => l.threadId !== id), // CASCADE をローカルにも反映
        branches: get().branches.filter(
          (b) => b.fromThreadId !== id && b.toThreadId !== id,
        ),
      });
    await deletePlotThread(id);
    applyDelete();
    if (!thread) return;
    recordPlotHistory({
      label: i18next.t("plotThread.history.deleteThread", "スレッド削除"),
      entityId: id,
      undo: async () => {
        // 親(thread)を先に復元してから子(links/branches)を FK 順に戻す。
        await restorePlotThread(thread);
        for (const l of removedLinks) await restorePlotThreadLink(l);
        for (const b of removedBranches) await restorePlotThreadBranch(b);
        set({
          threads: [...get().threads, thread],
          links: [...get().links, ...removedLinks],
          branches: [...get().branches, ...removedBranches],
        });
      },
      redo: async () => {
        await deletePlotThread(id); // DB 側で links/branches も CASCADE 削除
        applyDelete();
      },
    });
  },

  addMarker: async (threadId, nodeId, phaseType) => {
    // stale ガード: await 中にプロジェクトが切り替わったら反映しない
    // （他メソッドと同じ XPROJ 不変条件を守る）。
    const pid = getCurrentProjectId();
    const created = await createPlotThreadLink({ threadId, nodeId, phaseType });
    if (getCurrentProjectId() !== pid) return;
    set({ links: [...get().links, created] });
    const captured = { ...created };
    recordPlotHistory({
      label: i18next.t("plotThread.history.addMarker", "マーカー追加"),
      entityId: captured.id,
      undo: async () => {
        await deletePlotThreadLink(captured.id);
        set({ links: get().links.filter((l) => l.id !== captured.id) });
      },
      redo: async () => {
        await restorePlotThreadLink(captured);
        set({ links: [...get().links, captured] });
      },
    });
  },

  updateMarker: async (id, patch) => {
    const pid = getCurrentProjectId();
    const before = get().links.find((l) => l.id === id);
    await updatePlotThreadLink(id, patch);
    if (getCurrentProjectId() !== pid) return;
    set({
      links: get().links.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    });
    if (!before) return;
    // patch で触れたキーだけ元値を控える before patch を作る。
    const beforePatch: typeof patch = {};
    if ("threadId" in patch) beforePatch.threadId = before.threadId;
    if ("nodeId" in patch) beforePatch.nodeId = before.nodeId;
    if ("phaseType" in patch) beforePatch.phaseType = before.phaseType;
    if ("note" in patch) beforePatch.note = before.note;
    recordPlotHistory({
      label: markerPatchLabel(patch),
      entityId: id,
      undo: async () => {
        await updatePlotThreadLink(id, beforePatch);
        set({
          links: get().links.map((l) =>
            l.id === id ? { ...l, ...beforePatch } : l,
          ),
        });
      },
      redo: async () => {
        await updatePlotThreadLink(id, patch);
        set({
          links: get().links.map((l) => (l.id === id ? { ...l, ...patch } : l)),
        });
      },
    });
  },

  deleteMarker: async (id) => {
    const pid = getCurrentProjectId();
    const link = get().links.find((l) => l.id === id);
    await deletePlotThreadLink(id);
    if (getCurrentProjectId() !== pid) return;
    // アンカー側のエッジをカスケード削除。統一モデル: branch も merge も
    // マーカーは移動先 = to 側に乗る（PlotBranchEditor / D&D 共通）。よってアンカー =
    // to===threadId && atNodeId===nodeId のエッジ。
    // ただし同一(thread,scene)に別 phase のマーカーが残るなら、そのエッジは
    // まだアンカーされているので消さない（複数 phase の取り残し防止）。
    const orphanIds = new Set<string>();
    if (link) {
      const stillAnchored = get().links.some(
        (l) =>
          l.id !== id &&
          l.threadId === link.threadId &&
          l.nodeId === link.nodeId,
      );
      if (!stillAnchored) {
        for (const b of get().branches) {
          if (b.atNodeId === link.nodeId && b.toThreadId === link.threadId) {
            orphanIds.add(b.id);
          }
        }
        for (const bid of orphanIds) {
          await deletePlotThreadBranch(bid);
        }
        if (getCurrentProjectId() !== pid) return;
      }
    }
    // set より前（まだ存在するうち）に消えるエッジの完全な行を控える。
    const removedBranches = get().branches.filter((b) => orphanIds.has(b.id));
    set({
      links: get().links.filter((l) => l.id !== id),
      branches: get().branches.filter((b) => !orphanIds.has(b.id)),
    });
    if (!link) return;
    const removedLink = link;
    recordPlotHistory({
      label: i18next.t("plotThread.history.deleteMarker", "マーカー削除"),
      entityId: id,
      undo: async () => {
        await restorePlotThreadLink(removedLink);
        for (const b of removedBranches) await restorePlotThreadBranch(b);
        set({
          links: [...get().links, removedLink],
          branches: [...get().branches, ...removedBranches],
        });
      },
      redo: async () => {
        await deletePlotThreadLink(id);
        for (const b of removedBranches) await deletePlotThreadBranch(b.id);
        set({
          links: get().links.filter((l) => l.id !== id),
          branches: get().branches.filter(
            (b) => !removedBranches.some((r) => r.id === b.id),
          ),
        });
      },
    });
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
    const captured = { ...created };
    recordPlotHistory({
      label: i18next.t("plotThread.history.addBranch", "分岐 / 合流を追加"),
      entityId: captured.id,
      undo: async () => {
        await deletePlotThreadBranch(captured.id);
        set({ branches: get().branches.filter((b) => b.id !== captured.id) });
      },
      redo: async () => {
        await restorePlotThreadBranch(captured);
        set({ branches: [...get().branches, captured] });
      },
    });
  },

  updateBranch: async (id, patch) => {
    const pid = getCurrentProjectId();
    const before = get().branches.find((b) => b.id === id);
    await updatePlotThreadBranch(id, patch);
    if (getCurrentProjectId() !== pid) return;
    set({
      branches: get().branches.map((b) =>
        b.id === id ? { ...b, ...patch } : b,
      ),
    });
    if (!before) return;
    const beforePatch: typeof patch = {};
    if ("fromThreadId" in patch) beforePatch.fromThreadId = before.fromThreadId;
    if ("toThreadId" in patch) beforePatch.toThreadId = before.toThreadId;
    if ("atNodeId" in patch) beforePatch.atNodeId = before.atNodeId;
    recordPlotHistory({
      label: i18next.t("plotThread.history.updateBranch", "分岐 / 合流を変更"),
      entityId: id,
      undo: async () => {
        await updatePlotThreadBranch(id, beforePatch);
        set({
          branches: get().branches.map((b) =>
            b.id === id ? { ...b, ...beforePatch } : b,
          ),
        });
      },
      redo: async () => {
        await updatePlotThreadBranch(id, patch);
        set({
          branches: get().branches.map((b) =>
            b.id === id ? { ...b, ...patch } : b,
          ),
        });
      },
    });
  },

  deleteBranch: async (id) => {
    const removed = get().branches.find((b) => b.id === id);
    await deletePlotThreadBranch(id);
    set({ branches: get().branches.filter((b) => b.id !== id) });
    if (!removed) return;
    recordPlotHistory({
      label: i18next.t("plotThread.history.deleteBranch", "分岐 / 合流を削除"),
      entityId: id,
      undo: async () => {
        await restorePlotThreadBranch(removed);
        set({ branches: [...get().branches, removed] });
      },
      redo: async () => {
        await deletePlotThreadBranch(id);
        set({ branches: get().branches.filter((b) => b.id !== id) });
      },
    });
  },
}));

/** updateMarker の patch から、何を変えたか分かる履歴ラベルを選ぶ。 */
function markerPatchLabel(
  patch: Partial<
    Pick<PlotThreadLinkRow, "threadId" | "nodeId" | "phaseType" | "note">
  >,
): string {
  if ("phaseType" in patch) {
    return i18next.t("plotThread.history.phaseMarker", "段階変更");
  }
  if ("threadId" in patch || "nodeId" in patch) {
    return i18next.t("plotThread.history.moveMarker", "マーカー移動");
  }
  if ("note" in patch) {
    return i18next.t("plotThread.history.editNote", "メモ変更");
  }
  return i18next.t("plotThread.history.editMarker", "マーカー編集");
}
