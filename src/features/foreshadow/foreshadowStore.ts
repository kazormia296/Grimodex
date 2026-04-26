import { create } from "zustand";
import { toast } from "sonner";
import i18next from "i18next";
import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { foreshadowSetups } from "@/db/schema";
import { debugLog, errorDetail, rootCause } from "@/lib/debugLog";
import {
  listForeshadows,
  createForeshadow,
  deleteForeshadow,
  listSetups,
  deleteSetup,
  reanchorOrphanSetup,
  reinsertOrphanSetup,
  updateSetup,
  evaluateSetupStrength,
} from "./api";
import { safeParseAiEvaluation } from "./types";
import { deriveLabel } from "./deriveLabel";
import { useEditorStore } from "@/features/editor/editorStore";
import { useSceneStore } from "@/features/tree/store";
import type {
  ForeshadowRow,
  ForeshadowSetupRow,
  ForeshadowWithLabel,
} from "./types";

interface ForeshadowState {
  items: ForeshadowWithLabel[];
  isLoading: boolean;

  /** Setup rows keyed by foreshadowId; populated on demand. */
  setupsByForeshadowId: Record<string, ForeshadowSetupRow[]>;

  load: (projectId: string) => Promise<void>;
  create: (
    data: Pick<ForeshadowRow, "projectId" | "title" | "intent">,
  ) => Promise<ForeshadowWithLabel>;
  remove: (id: string) => Promise<void>;
  loadSetups: (foreshadowId: string) => Promise<void>;
  removeSetup: (setupId: string, foreshadowId: string) => Promise<void>;
  reanchorSetup: (setupId: string, foreshadowId: string) => Promise<void>;
  reinsertSetup: (setupId: string, foreshadowId: string) => Promise<void>;
  evaluateSetup: (
    setupId: string,
    foreshadowId: string,
    setupExcerpt: string,
    foreshadowIntent: string,
  ) => Promise<void>;
  evaluatingSetupIds: Set<string>;
}

async function buildWithLabels(
  rows: ForeshadowRow[],
): Promise<ForeshadowWithLabel[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const setups = await db
    .select()
    .from(foreshadowSetups)
    .where(inArray(foreshadowSetups.foreshadowId, ids));

  const countMap = new Map<string, number>();
  const weakMap = new Map<string, boolean>();

  for (const s of setups) {
    if (s.isOrphan) continue;
    countMap.set(s.foreshadowId, (countMap.get(s.foreshadowId) ?? 0) + 1);
    const evaluation = safeParseAiEvaluation(s.aiReasoning);
    const effectiveStrength =
      s.strength ?? evaluation?.careful?.strength ?? s.aiStrength;
    if (effectiveStrength === "subtle") {
      weakMap.set(s.foreshadowId, true);
    }
  }

  return rows.map((r) => {
    const setupCount = countMap.get(r.id) ?? 0;
    const anyWeak = weakMap.get(r.id) ?? false;
    return { ...r, setupCount, label: deriveLabel(r, setupCount, anyWeak) };
  });
}

export const useForeshadowStore = create<ForeshadowState>()((set, get) => ({
  items: [],
  isLoading: false,
  setupsByForeshadowId: {},
  evaluatingSetupIds: new Set<string>(),

  load: async (projectId) => {
    set({ isLoading: true });
    try {
      const rows = await listForeshadows(projectId);
      const items = await buildWithLabels(rows);
      set({ items, isLoading: false });
    } catch (e) {
      set({ isLoading: false });
      toast.error(
        i18next.t(
          "foreshadow.store.loadFailed",
          "伏線の読み込みに失敗しました",
        ),
      );
      debugLog.error(
        "ForeshadowStore",
        `load: ${rootCause(e)}`,
        errorDetail(e),
      );
    }
  },

  create: async (data) => {
    try {
      const row = await createForeshadow({
        id: crypto.randomUUID(),
        projectId: data.projectId,
        title: data.title,
        intent: data.intent ?? null,
        notes: null,
        payoffSceneId: null,
        payoffFromPos: null,
        payoffToPos: null,
        payoffConfirmed: false,
        abandoned: false,
      });
      const item: ForeshadowWithLabel = {
        ...row,
        setupCount: 0,
        label: "planned",
      };
      set((s) => ({ items: [item, ...s.items] }));
      return item;
    } catch (e) {
      toast.error(
        i18next.t("foreshadow.store.createFailed", "伏線の作成に失敗しました"),
      );
      debugLog.error(
        "ForeshadowStore",
        `create: ${rootCause(e)}`,
        errorDetail(e),
      );
      throw e;
    }
  },

  remove: async (id) => {
    try {
      await deleteForeshadow(id);
      set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
    } catch (e) {
      toast.error(
        i18next.t("foreshadow.store.deleteFailed", "伏線の削除に失敗しました"),
      );
      debugLog.error(
        "ForeshadowStore",
        `remove: ${rootCause(e)}`,
        errorDetail(e),
      );
    }
  },

  loadSetups: async (foreshadowId) => {
    try {
      const rows = await listSetups(foreshadowId);
      set((s) => ({
        setupsByForeshadowId: {
          ...s.setupsByForeshadowId,
          [foreshadowId]: rows,
        },
      }));
    } catch (e) {
      debugLog.error(
        "ForeshadowStore",
        `loadSetups: ${rootCause(e)}`,
        errorDetail(e),
      );
    }
  },

  removeSetup: async (setupId, foreshadowId) => {
    try {
      await deleteSetup(setupId);
      set((s) => {
        const current = s.setupsByForeshadowId[foreshadowId] ?? [];
        return {
          setupsByForeshadowId: {
            ...s.setupsByForeshadowId,
            [foreshadowId]: current.filter((r) => r.id !== setupId),
          },
        };
      });
    } catch (e) {
      toast.error(
        i18next.t(
          "foreshadow.store.deleteSetupFailed",
          "Setupの削除に失敗しました",
        ),
      );
      debugLog.error(
        "ForeshadowStore",
        `removeSetup: ${rootCause(e)}`,
        errorDetail(e),
      );
    }
  },

  reanchorSetup: async (setupId, foreshadowId) => {
    const editor = useEditorStore.getState().editor;
    const activeSceneId = useSceneStore.getState().activeSceneId;
    if (!editor || !activeSceneId) {
      toast.error(
        i18next.t(
          "foreshadow.store.reanchorNoEditor",
          "再アンカーするには編集中のシーンを開いてください",
        ),
      );
      return;
    }
    const { from, to } = editor.state.selection;
    if (from === to) {
      toast.error(
        i18next.t(
          "foreshadow.store.reanchorNoSelection",
          "再アンカーする範囲を選択してください",
        ),
      );
      return;
    }

    try {
      await reanchorOrphanSetup(setupId, {
        sceneId: activeSceneId,
        fromPos: from,
        toPos: to,
      });

      const setups = get().setupsByForeshadowId[foreshadowId] ?? [];
      const nextSetups = setups.map((s) =>
        s.id === setupId
          ? {
              ...s,
              sceneId: activeSceneId,
              fromPos: from,
              toPos: to,
              isOrphan: false,
              updatedAt: new Date(),
            }
          : s,
      );

      const resolved = nextSetups.find((s) => s.id === setupId);
      if (resolved) {
        editor
          .chain()
          .setTextSelection({ from, to })
          .setMark("foreshadowSetup", {
            setupId: resolved.id,
            foreshadowId: resolved.foreshadowId,
          })
          .run();
      }

      set((s) => {
        const activeSetups = nextSetups.filter((x) => !x.isOrphan);
        const activeCount = activeSetups.length;
        const anyWeak = activeSetups.some((x) => {
          const ev = safeParseAiEvaluation(x.aiReasoning);
          const eff = x.strength ?? ev?.careful?.strength ?? x.aiStrength;
          return eff === "subtle";
        });
        return {
          setupsByForeshadowId: {
            ...s.setupsByForeshadowId,
            [foreshadowId]: nextSetups,
          },
          items: s.items.map((item) =>
            item.id === foreshadowId
              ? {
                  ...item,
                  setupCount: activeCount,
                  label: deriveLabel(item, activeCount, anyWeak),
                }
              : item,
          ),
        };
      });
    } catch (e) {
      toast.error(
        i18next.t(
          "foreshadow.store.reanchorFailed",
          "Setupの再アンカーに失敗しました",
        ),
      );
      debugLog.error(
        "ForeshadowStore",
        `reanchorSetup: ${rootCause(e)}`,
        errorDetail(e),
      );
    }
  },

  reinsertSetup: async (setupId, foreshadowId) => {
    const editor = useEditorStore.getState().editor;
    const activeSceneId = useSceneStore.getState().activeSceneId;
    if (!editor || !activeSceneId) {
      toast.error(
        i18next.t(
          "foreshadow.store.reinsertNoEditor",
          "再挿入するには編集中のシーンを開いてください",
        ),
      );
      return;
    }
    const { from, to } = editor.state.selection;
    if (from === to) {
      toast.error(
        i18next.t(
          "foreshadow.store.reinsertNoSelection",
          "再挿入する範囲を選択してください",
        ),
      );
      return;
    }

    try {
      const inserted = await reinsertOrphanSetup(setupId, {
        sceneId: activeSceneId,
        fromPos: from,
        toPos: to,
      });
      editor
        .chain()
        .setTextSelection({ from, to })
        .setMark("foreshadowSetup", {
          setupId: inserted.id,
          foreshadowId: inserted.foreshadowId,
        })
        .run();

      const setups = get().setupsByForeshadowId[foreshadowId] ?? [];
      const nextSetups = setups
        .filter((s) => s.id !== setupId)
        .concat([{ ...inserted, fromPos: from, toPos: to, isOrphan: false }]);

      set((s) => {
        const activeSetups = nextSetups.filter((x) => !x.isOrphan);
        const activeCount = activeSetups.length;
        const anyWeak = activeSetups.some((x) => {
          const ev = safeParseAiEvaluation(x.aiReasoning);
          const eff = x.strength ?? ev?.careful?.strength ?? x.aiStrength;
          return eff === "subtle";
        });
        return {
          setupsByForeshadowId: {
            ...s.setupsByForeshadowId,
            [foreshadowId]: nextSetups,
          },
          items: s.items.map((item) =>
            item.id === foreshadowId
              ? {
                  ...item,
                  setupCount: activeCount,
                  label: deriveLabel(item, activeCount, anyWeak),
                }
              : item,
          ),
        };
      });
    } catch (e) {
      toast.error(
        i18next.t(
          "foreshadow.store.reinsertFailed",
          "Setupの再挿入に失敗しました",
        ),
      );
      debugLog.error(
        "ForeshadowStore",
        `reinsertSetup: ${rootCause(e)}`,
        errorDetail(e),
      );
    }
  },

  evaluateSetup: async (
    setupId,
    foreshadowId,
    setupExcerpt,
    foreshadowIntent,
  ) => {
    set((s) => ({
      evaluatingSetupIds: new Set([...s.evaluatingSetupIds, setupId]),
    }));
    try {
      const evaluation = await evaluateSetupStrength({
        setupId,
        setupExcerpt,
        foreshadowIntent,
      });
      if (!evaluation) {
        toast.error(
          i18next.t(
            "foreshadow.store.evaluateFailed",
            "AI評価の取得に失敗しました",
          ),
        );
        return;
      }

      await updateSetup(setupId, {
        aiStrength: evaluation.careful.strength,
        aiReasoning: JSON.stringify(evaluation),
        lastEvaluatedAt: new Date(),
      });

      set((s) => {
        const current = s.setupsByForeshadowId[foreshadowId] ?? [];
        const nextSetups = current.map((row) =>
          row.id === setupId
            ? {
                ...row,
                aiStrength: evaluation.careful.strength,
                aiReasoning: JSON.stringify(evaluation),
                lastEvaluatedAt: new Date(),
                updatedAt: new Date(),
              }
            : row,
        );
        const activeSetups = nextSetups.filter((x) => !x.isOrphan);
        const activeCount = activeSetups.length;
        const anyWeak = activeSetups.some((x) => {
          const ev = safeParseAiEvaluation(x.aiReasoning);
          const eff = x.strength ?? ev?.careful?.strength ?? x.aiStrength;
          return eff === "subtle";
        });
        return {
          setupsByForeshadowId: {
            ...s.setupsByForeshadowId,
            [foreshadowId]: nextSetups,
          },
          items: s.items.map((item) =>
            item.id === foreshadowId
              ? {
                  ...item,
                  setupCount: activeCount,
                  label: deriveLabel(item, activeCount, anyWeak),
                }
              : item,
          ),
        };
      });
    } catch (e) {
      toast.error(
        i18next.t(
          "foreshadow.store.evaluateFailed",
          "AI評価の取得に失敗しました",
        ),
      );
      debugLog.error(
        "ForeshadowStore",
        `evaluateSetup: ${rootCause(e)}`,
        errorDetail(e),
      );
    } finally {
      set((s) => {
        const next = new Set(s.evaluatingSetupIds);
        next.delete(setupId);
        return { evaluatingSetupIds: next };
      });
    }
  },
}));
