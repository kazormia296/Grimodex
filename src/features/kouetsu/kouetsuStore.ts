import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TreeNodeData } from "@/features/tree/treeStore";

export type KouetsuTab = "issues" | "comments" | "blocker";
export type KouetsuScope =
  | { type: "scene" }
  | { type: "folder"; anchorId: string }
  | { type: "project" };
export type KouetsuStatusFilter = "open" | "dismissed";
export type ProjectGroupBy = "scene" | "codex";

/**
 * persist された folder anchor が現ツリーに存在しない場合 project へ倒す
 * （kouetsu-store はプロジェクト横断 persist のため、プロジェクト切替や
 * フォルダ削除で anchor が宙に浮く）。宙に浮いた folder のまま放置すると
 * getSceneIdsForScope が空集合を返し、Project 系ビューが全空表示 + 実行が
 * 無音 no-op になる。scene / project はそのまま素通しする。
 * 消費側（Project 系ビュー / KouetsuScopeBar）は必ずこの正規化を経由する。
 */
export function resolveKouetsuScope(
  scope: KouetsuScope,
  nodes: TreeNodeData[],
): KouetsuScope {
  if (scope.type !== "folder") return scope;
  const exists = nodes.some(
    (n) => n.id === scope.anchorId && n.nodeType === "folder",
  );
  return exists ? scope : { type: "project" };
}

interface KouetsuState {
  activeTab: KouetsuTab;
  /** 指摘タブのスコープ（Chat と同セマンティクス）。scene = アクティブシーン追従。 */
  scope: KouetsuScope;
  /** 場所軸から分離したステータスフィルタ（旧 "ignored" スコープの後継）。 */
  statusFilter: KouetsuStatusFilter;
  projectGroupBy: ProjectGroupBy;
  /**
   * AnimatedSlotPanel keepalive 中の KouetsuPanel の active 状態。
   * 実行時 UI 状態なので永続化しない (partialize で除外)。
   * KouetsuPanel が書き込む。旧 CurrentScenePseudoCommentView 削除後は現状の
   * 読み手が居ないが、hidden 中の reload bail 用途で将来また使うため残す。
   */
  panelActive: boolean;
  setActiveTab: (tab: KouetsuTab) => void;
  setScope: (scope: KouetsuScope) => void;
  setStatusFilter: (filter: KouetsuStatusFilter) => void;
  setProjectGroupBy: (mode: ProjectGroupBy) => void;
  setPanelActive: (active: boolean) => void;
}

interface PersistedV0 {
  activeTab?: string;
  activeIssuesScope?: "current" | "project" | "ignored";
  activeEditorialScope?: "current" | "project" | "ignored";
  projectGroupBy?: ProjectGroupBy;
}

/**
 * v0（指摘/批評独立スコープ + ignored スコープ）→ v1（単一 scope + statusFilter）。
 * 旧 activeIssuesScope を正とし、editorial 側は捨てる（タブ自体が消えるため）。
 */
export function migrateKouetsuStore(persisted: unknown, version: number) {
  if (version >= 1) return persisted as Record<string, unknown>;
  const old = (persisted ?? {}) as PersistedV0;
  const oldScope = old.activeIssuesScope ?? "current";
  const scope: KouetsuScope =
    oldScope === "project" ? { type: "project" } : { type: "scene" };
  const statusFilter: KouetsuStatusFilter =
    oldScope === "ignored" ? "dismissed" : "open";
  const activeTab: KouetsuTab =
    old.activeTab === "comments" || old.activeTab === "blocker"
      ? old.activeTab
      : "issues";
  return {
    activeTab,
    scope,
    statusFilter,
    projectGroupBy: old.projectGroupBy ?? "scene",
  };
}

export const useKouetsuStore = create<KouetsuState>()(
  persist(
    (set) => ({
      activeTab: "issues",
      scope: { type: "scene" },
      statusFilter: "open",
      projectGroupBy: "scene",
      panelActive: true,
      setActiveTab: (tab) => set({ activeTab: tab }),
      setScope: (scope) => set({ scope }),
      setStatusFilter: (filter) => set({ statusFilter: filter }),
      setProjectGroupBy: (mode) => set({ projectGroupBy: mode }),
      setPanelActive: (active) => set({ panelActive: active }),
    }),
    {
      name: "kouetsu-store",
      version: 1,
      migrate: migrateKouetsuStore,
      partialize: (s) => ({
        activeTab: s.activeTab,
        scope: s.scope,
        statusFilter: s.statusFilter,
        projectGroupBy: s.projectGroupBy,
      }),
    },
  ),
);
