import { create } from "zustand";
import { toast } from "sonner";
import i18next from "i18next";
import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { foreshadowSetups } from "@/db/schema";
import { debugLog, errorDetail, rootCause } from "@/lib/debugLog";
import { listForeshadows, createForeshadow, deleteForeshadow } from "./api";
import { deriveLabel } from "./deriveLabel";
import type { ForeshadowRow, ForeshadowWithLabel } from "./types";

interface ForeshadowState {
  items: ForeshadowWithLabel[];
  isLoading: boolean;

  load: (projectId: string) => Promise<void>;
  create: (
    data: Pick<ForeshadowRow, "projectId" | "title" | "intent">,
  ) => Promise<ForeshadowWithLabel>;
  remove: (id: string) => Promise<void>;
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
    if (s.strength === "subtle" || s.aiStrength === "subtle") {
      weakMap.set(s.foreshadowId, true);
    }
  }

  return rows.map((r) => {
    const setupCount = countMap.get(r.id) ?? 0;
    const anyWeak = weakMap.get(r.id) ?? false;
    return { ...r, setupCount, label: deriveLabel(r, setupCount, anyWeak) };
  });
}

export const useForeshadowStore = create<ForeshadowState>()((set, _get) => ({
  items: [],
  isLoading: false,

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
}));
