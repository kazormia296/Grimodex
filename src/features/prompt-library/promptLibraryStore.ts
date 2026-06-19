import { create } from "zustand";
import { toast } from "sonner";
import i18next from "i18next";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { getCurrentProjectId } from "@/features/project/projectStore";
import * as api from "./api";
import type { PromptTemplate } from "./api";

interface PromptLibraryState {
  templates: PromptTemplate[];
  isLoading: boolean;
  loadedProjectId: string | null;

  /** 現在のプロジェクトのテンプレートを読み込む。 */
  load: () => Promise<void>;
  /** 未ロード or プロジェクト切替時のみ読み込む（mount 用）。 */
  ensureLoaded: () => Promise<void>;
  /** 新規テンプレートを作成して返す（失敗時 null）。 */
  create: (title: string, content: string) => Promise<PromptTemplate | null>;
  /** タイトル / 本文を更新。 */
  update: (
    id: string,
    data: { title?: string; content?: string },
  ) => Promise<void>;
  /** テンプレートを削除。 */
  remove: (id: string) => Promise<void>;
  /** 使用回数を 1 増やす（挿入時に呼ぶ・楽観更新）。 */
  incrementUsage: (id: string) => Promise<void>;
}

export const usePromptLibraryStore = create<PromptLibraryState>((set, get) => ({
  templates: [],
  isLoading: false,
  loadedProjectId: null,

  load: async () => {
    const projectId = getCurrentProjectId();
    set({ isLoading: true });
    try {
      const templates = await api.listPromptTemplates(projectId);
      // 非同期中にプロジェクトが切り替わっていたら stale 結果を破棄する
      // （クロスプロジェクト汚染防止 / 新プロジェクトの load が状態を所有する）。
      if (getCurrentProjectId() !== projectId) return;
      set({ templates, isLoading: false, loadedProjectId: projectId });
    } catch (e) {
      debugLog.error("promptLibrary", "load failed", errorDetail(e));
      // stale なエラーで現行ロードの状態を壊さない。
      if (getCurrentProjectId() !== projectId) return;
      // loadedProjectId をリセットし ensureLoaded での再試行を可能にする。
      set({ isLoading: false, loadedProjectId: null });
      toast.error(i18next.t("promptLibrary.toast.loadFailed"));
    }
  },

  ensureLoaded: async () => {
    const projectId = getCurrentProjectId();
    if (get().loadedProjectId === projectId && !get().isLoading) return;
    await get().load();
  },

  create: async (title, content) => {
    const projectId = getCurrentProjectId();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error(i18next.t("promptLibrary.toast.titleRequired"));
      return null;
    }
    if (!content.trim()) {
      toast.error(i18next.t("promptLibrary.toast.contentRequired"));
      return null;
    }
    try {
      const created = await api.createPromptTemplate({
        id: crypto.randomUUID(),
        projectId,
        title: trimmedTitle,
        content,
      });
      set((s) => ({ templates: [created, ...s.templates] }));
      toast.success(i18next.t("promptLibrary.toast.saved"));
      return created;
    } catch (e) {
      debugLog.error("promptLibrary", "create failed", errorDetail(e));
      toast.error(i18next.t("promptLibrary.toast.saveFailed"));
      return null;
    }
  },

  update: async (id, data) => {
    const projectId = getCurrentProjectId();
    const patch: { title?: string; content?: string } = {};
    if (data.title !== undefined) patch.title = data.title.trim();
    if (data.content !== undefined) patch.content = data.content;
    if (patch.title !== undefined && patch.title === "") {
      toast.error(i18next.t("promptLibrary.toast.titleRequired"));
      return;
    }
    try {
      const updated = await api.updatePromptTemplate(projectId, id, patch);
      if (!updated) return;
      set((s) => ({
        templates: s.templates.map((tpl) => (tpl.id === id ? updated : tpl)),
      }));
    } catch (e) {
      debugLog.error("promptLibrary", "update failed", errorDetail(e));
      toast.error(i18next.t("promptLibrary.toast.saveFailed"));
    }
  },

  remove: async (id) => {
    const projectId = getCurrentProjectId();
    try {
      await api.deletePromptTemplate(projectId, id);
      set((s) => ({ templates: s.templates.filter((tpl) => tpl.id !== id) }));
    } catch (e) {
      debugLog.error("promptLibrary", "remove failed", errorDetail(e));
      toast.error(i18next.t("promptLibrary.toast.deleteFailed"));
    }
  },

  incrementUsage: async (id) => {
    const projectId = getCurrentProjectId();
    // 楽観更新: 件数バッジを即座に反映する。失敗しても致命的でないので
    // ロールバックはしない（次回 load で整合する）。
    set((s) => ({
      templates: s.templates.map((tpl) =>
        tpl.id === id ? { ...tpl, usageCount: tpl.usageCount + 1 } : tpl,
      ),
    }));
    try {
      await api.incrementPromptTemplateUsage(projectId, id);
    } catch (e) {
      debugLog.error("promptLibrary", "incrementUsage failed", errorDetail(e));
    }
  },
}));
