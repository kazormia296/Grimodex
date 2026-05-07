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
  updateForeshadow,
  listSetups,
  deleteSetup,
  reanchorOrphanSetup,
  reinsertOrphanSetup,
  updateSetup,
  evaluateSetupStrength,
  proposePastSetups,
  createForeshadowSetup,
  auditChapter as auditChapterApi,
} from "./api";
import { loadSceneContent, saveSceneContent } from "@/features/tree/api";
import { prosemirrorToText } from "@/lib/prosemirror";
import {
  saveForeshadowAnchors,
  unsetForeshadowPayoffMarksByForeshadowIds,
} from "./saveAnchors";
import { createRevision } from "@/features/revision/api";
import type { ProposedSetup } from "./api";
import { safeParseAiEvaluation } from "./types";
import type { AuditCandidate } from "./types";
import { deriveLabel } from "./deriveLabel";
import { useEditorStore } from "@/features/editor/editorStore";
import { useSceneStore } from "@/features/tree/store";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
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
    data: Pick<ForeshadowRow, "projectId" | "title" | "intent" | "loadBearing">,
  ) => Promise<ForeshadowWithLabel>;
  update: (
    id: string,
    patch: Parameters<typeof updateForeshadow>[1],
    projectId: string,
  ) => Promise<void>;
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

  /** Phase 3: propose setups from AI */
  proposeResults: Record<string, ProposedSetup[]>;
  proposingForForeshadowIds: Set<string>;
  proposeSetups: (foreshadowId: string) => Promise<void>;
  adoptProposedSetup: (
    foreshadowId: string,
    candidateIdx: number,
  ) => Promise<void>;
  adoptInsertedNewSetup: (
    foreshadowId: string,
    candidateIdx: number,
  ) => Promise<void>;

  /** Phase 3: chapter audit */
  auditingChapterIds: Set<string>;
  auditResults: Record<string, AuditCandidate[]>;
  auditChapter: (chapterId: string) => Promise<void>;
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
  proposeResults: {},
  proposingForForeshadowIds: new Set<string>(),
  auditingChapterIds: new Set<string>(),
  auditResults: {},

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
      const id = crypto.randomUUID();
      const row = await createForeshadow({
        id,
        projectId: data.projectId,
        title: data.title,
        intent: data.intent ?? null,
        notes: null,
        payoffSceneId: null,
        payoffFromPos: null,
        payoffToPos: null,
        payoffConfirmed: false,
        abandoned: false,
        loadBearing: data.loadBearing ?? null,
      });
      const item: ForeshadowWithLabel = {
        ...row,
        setupCount: 0,
        label: "planned",
      };
      set((s) => ({ items: [item, ...s.items] }));

      if (!useGlobalHistoryStore.getState().isReplaying) {
        const cap = { ...row };
        useGlobalHistoryStore.getState().push({
          kind: "foreshadow",
          label: "伏線作成",
          async undo() {
            await deleteForeshadow(cap.id);
            set((s) => ({ items: s.items.filter((i) => i.id !== cap.id) }));
          },
          async redo() {
            await createForeshadow({
              id: cap.id,
              projectId: cap.projectId,
              title: cap.title,
              intent: cap.intent ?? null,
              notes: cap.notes ?? null,
              payoffSceneId: cap.payoffSceneId ?? null,
              payoffFromPos: cap.payoffFromPos ?? null,
              payoffToPos: cap.payoffToPos ?? null,
              payoffConfirmed: cap.payoffConfirmed,
              abandoned: cap.abandoned,
              loadBearing: cap.loadBearing ?? null,
            });
            set((s) => ({
              items: [
                { ...cap, setupCount: 0, label: "planned" as const },
                ...s.items.filter((i) => i.id !== cap.id),
              ],
            }));
          },
        });
      }

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

  update: async (id, patch, projectId) => {
    const before = get().items.find((i) => i.id === id);
    const undoPatch: typeof patch = {};
    if (before) {
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
        const v = (before as unknown as Record<string, unknown>)[key];
        // @ts-expect-error narrow union not assignable here
        undoPatch[key] = v ?? null;
      }
    }

    try {
      await updateForeshadow(id, patch);

      if (patch.payoffSceneId === null) {
        const editor = useEditorStore.getState().editor;
        const activeSceneId = useSceneStore.getState().activeSceneId;
        if (editor && activeSceneId) {
          unsetForeshadowPayoffMarksByForeshadowIds(
            (fn) => {
              const tr = editor.state.tr;
              fn(tr);
              editor.view.dispatch(tr);
            },
            [id],
          );
          const contentJson = JSON.stringify(editor.getJSON());
          await saveSceneContent(activeSceneId, contentJson);
        }
      }

      await get().load(projectId);
    } catch (e) {
      toast.error(
        i18next.t("foreshadow.store.updateFailed", "伏線の更新に失敗しました"),
      );
      debugLog.error(
        "ForeshadowStore",
        `update: ${rootCause(e)}`,
        errorDetail(e),
      );
      return;
    }

    if (!before) return;
    if (useGlobalHistoryStore.getState().isReplaying) return;

    // 注意: payoffSceneId === null 経由で mark を剥がした場合、Undo で
    // foreshadow row のデータは復元できるが、本文中の payoff mark までは
    // 戻せない。adopt 系アトミック化と合わせて別 PR で対応する。
    useGlobalHistoryStore.getState().push({
      kind: "foreshadow",
      label: "伏線更新",
      async undo() {
        await updateForeshadow(id, undoPatch);
        await get().load(projectId);
      },
      async redo() {
        await updateForeshadow(id, patch);
        await get().load(projectId);
      },
    });
  },

  remove: async (id) => {
    const before = get().items.find((i) => i.id === id);
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
      return;
    }

    if (!before) return;
    if (useGlobalHistoryStore.getState().isReplaying) return;

    // Note: cascade FK は foreshadowSetups を消す。本 entry では foreshadow row
    // のみを restore し、setup 行とそれに対応する mark は復元できない。
    // 別 PR の adopt 系アトミック化で扱う想定。
    const cap = { ...before };
    useGlobalHistoryStore.getState().push({
      kind: "foreshadow",
      label: "伏線削除",
      async undo() {
        await createForeshadow({
          id: cap.id,
          projectId: cap.projectId,
          title: cap.title,
          intent: cap.intent ?? null,
          notes: cap.notes ?? null,
          payoffSceneId: cap.payoffSceneId ?? null,
          payoffFromPos: cap.payoffFromPos ?? null,
          payoffToPos: cap.payoffToPos ?? null,
          payoffConfirmed: cap.payoffConfirmed,
          abandoned: cap.abandoned,
          loadBearing: cap.loadBearing ?? null,
        });
        set((s) => ({ items: [cap, ...s.items] }));
      },
      async redo() {
        await deleteForeshadow(cap.id);
        set((s) => ({ items: s.items.filter((i) => i.id !== cap.id) }));
      },
    });
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

  proposeSetups: async (foreshadowId) => {
    const foreshadow = get().items.find((i) => i.id === foreshadowId);
    if (!foreshadow?.payoffSceneId) {
      toast.error(
        i18next.t(
          "foreshadow.store.proposeNoPayoff",
          "Setup を提案するには回収シーンを先に設定してください",
        ),
      );
      return;
    }

    set((s) => ({
      proposingForForeshadowIds: new Set([
        ...s.proposingForForeshadowIds,
        foreshadowId,
      ]),
    }));

    try {
      const nodes = useSceneStore.getState().nodes;
      const payoffNode = nodes.find((n) => n.id === foreshadow.payoffSceneId);
      const sceneNodes = nodes.filter(
        (n) =>
          n.nodeType === "scene" &&
          n.id !== foreshadow.payoffSceneId &&
          (payoffNode ? n.sortOrder < payoffNode.sortOrder : true),
      );

      const pastScenes = await Promise.all(
        sceneNodes.slice(0, 30).map(async (n, idx) => {
          const content = await loadSceneContent(n.id);
          const bodyText = prosemirrorToText(content);
          return {
            sceneId: n.id,
            title: n.title,
            excerpt: bodyText.slice(0, 3000),
            orderIndex: idx + 1,
          };
        }),
      );

      const payoffContent = await loadSceneContent(foreshadow.payoffSceneId);
      const payoffText = prosemirrorToText(payoffContent);

      const results = await proposePastSetups({
        intent: foreshadow.intent ?? foreshadow.title,
        payoffSceneId: foreshadow.payoffSceneId,
        payoffExcerpt: payoffText.slice(0, 1000),
        pastScenes,
        relatedCodex: [],
      });

      set((s) => ({
        proposeResults: { ...s.proposeResults, [foreshadowId]: results },
      }));
    } catch (e) {
      toast.error(
        i18next.t(
          "foreshadow.store.proposeFailed",
          "Setup 提案の取得に失敗しました",
        ),
      );
      debugLog.error(
        "ForeshadowStore",
        `proposeSetups: ${rootCause(e)}`,
        errorDetail(e),
      );
    } finally {
      set((s) => {
        const next = new Set(s.proposingForForeshadowIds);
        next.delete(foreshadowId);
        return { proposingForForeshadowIds: next };
      });
    }
  },

  adoptProposedSetup: async (foreshadowId, candidateIdx) => {
    const candidates = get().proposeResults[foreshadowId] ?? [];
    const candidate = candidates[candidateIdx];
    if (!candidate) return;

    if (candidate.fromPosHint == null || candidate.toPosHint == null) {
      toast.error(
        i18next.t(
          "foreshadow.store.adoptNoPosition",
          "AI が位置情報を返しませんでした。シーンを開いて手動で設定してください",
        ),
      );
      return;
    }

    const setupId = crypto.randomUUID();
    const setupPayload = {
      id: setupId,
      foreshadowId,
      sceneId: candidate.sceneId,
      fromPos: candidate.fromPosHint,
      toPos: candidate.toPosHint,
      kind: "designated_existing" as const,
      strength: candidate.predictedStrength,
      aiStrength: candidate.predictedStrength,
      aiReasoning: null,
      attribution: "ai" as const,
      aiRationale: candidate.rationale,
      lastEvaluatedAt: null,
      isOrphan: false,
    };

    try {
      await createForeshadowSetup(setupPayload);

      await get().loadSetups(foreshadowId);

      set((s) => ({
        proposeResults: {
          ...s.proposeResults,
          [foreshadowId]: (s.proposeResults[foreshadowId] ?? []).filter(
            (_, i) => i !== candidateIdx,
          ),
        },
      }));
    } catch (e) {
      toast.error(
        i18next.t("foreshadow.store.adoptFailed", "採用に失敗しました"),
      );
      debugLog.error(
        "ForeshadowStore",
        `adoptProposedSetup: ${rootCause(e)}`,
        errorDetail(e),
      );
      return;
    }

    if (useGlobalHistoryStore.getState().isReplaying) return;

    const capCandidate = { ...candidate };
    const capIdx = candidateIdx;
    useGlobalHistoryStore.getState().push({
      kind: "foreshadow",
      label: "Setup採用",
      async undo() {
        await deleteSetup(setupPayload.id);
        await get().loadSetups(foreshadowId);
        // Restore candidate to proposeResults at original index
        set((s) => {
          const list = [...(s.proposeResults[foreshadowId] ?? [])];
          list.splice(capIdx, 0, capCandidate);
          return {
            proposeResults: { ...s.proposeResults, [foreshadowId]: list },
          };
        });
      },
      async redo() {
        await createForeshadowSetup(setupPayload);
        await get().loadSetups(foreshadowId);
        set((s) => ({
          proposeResults: {
            ...s.proposeResults,
            [foreshadowId]: (s.proposeResults[foreshadowId] ?? []).filter(
              (c) => c !== capCandidate,
            ),
          },
        }));
      },
    });
  },

  adoptInsertedNewSetup: async (foreshadowId, candidateIdx) => {
    const editor = useEditorStore.getState().editor;
    const activeSceneId = useSceneStore.getState().activeSceneId;

    const candidate = get().proposeResults[foreshadowId]?.[candidateIdx];
    if (!candidate || candidate.kind !== "inserted_new") return;

    if (!editor || !activeSceneId) {
      toast.error(
        i18next.t(
          "foreshadow.store.adoptNoEditor",
          "採用するには対象シーンを開いてください",
        ),
      );
      return;
    }

    if (activeSceneId !== candidate.sceneId) {
      toast.error(
        i18next.t(
          "foreshadow.store.adoptWrongScene",
          "候補のシーンを開いてから採用してください",
        ),
      );
      return;
    }

    const suggestedText = candidate.suggestedText ?? "";
    if (!suggestedText) return;

    const setupId = crypto.randomUUID();
    const { from } = editor.state.selection;
    // Snapshot the scene's JSON content BEFORE the insert so undo can restore.
    const beforeContent = JSON.stringify(editor.getJSON());

    const setupPayload = {
      id: setupId,
      foreshadowId,
      sceneId: activeSceneId,
      fromPos: from,
      toPos: from + suggestedText.length,
      kind: "inserted_new" as const,
      strength: candidate.predictedStrength,
      aiStrength: candidate.predictedStrength,
      aiReasoning: null,
      attribution: "ai" as const,
      aiRationale: candidate.rationale,
      lastEvaluatedAt: null,
      isOrphan: false,
    };

    let afterContent: string | null = null;

    try {
      // Pre-create DB record with AI metadata before inserting text.
      // The saveForeshadowAnchors UPSERT will only update fromPos/toPos — metadata is preserved.
      await createForeshadowSetup(setupPayload);

      // Insert text and apply foreshadowSetup mark in the editor
      editor
        .chain()
        .insertContentAt(from, suggestedText)
        .setTextSelection({ from, to: from + suggestedText.length })
        .setMark("foreshadowSetup", { setupId, foreshadowId })
        .run();

      // Sync mark positions to DB (UPSERT preserves AI metadata)
      await saveForeshadowAnchors(activeSceneId, editor.state.doc);

      // Persist scene content and record a revision
      afterContent = JSON.stringify(editor.getJSON());
      await saveSceneContent(activeSceneId, afterContent);
      await createRevision({
        entityType: "scene",
        entityId: activeSceneId,
        content: afterContent,
        snapshotType: "auto",
      });

      await get().loadSetups(foreshadowId);

      set((s) => ({
        proposeResults: {
          ...s.proposeResults,
          [foreshadowId]: (s.proposeResults[foreshadowId] ?? []).filter(
            (_, i) => i !== candidateIdx,
          ),
        },
      }));

      toast.success(i18next.t("foreshadow.store.adoptDone", "採用しました"));
    } catch (e) {
      toast.error(
        i18next.t("foreshadow.store.adoptFailed", "採用に失敗しました"),
      );
      debugLog.error(
        "ForeshadowStore",
        `adoptInsertedNewSetup: ${rootCause(e)}`,
        errorDetail(e),
      );
      return;
    }

    if (useGlobalHistoryStore.getState().isReplaying) return;
    if (!afterContent) return;

    const capCandidate = { ...candidate };
    const capIdx = candidateIdx;
    const capSceneId = activeSceneId;
    const capBefore = beforeContent;
    const capAfter = afterContent;

    useGlobalHistoryStore.getState().push({
      kind: "foreshadow",
      label: "Setup採用 (本文挿入)",
      async undo() {
        await deleteSetup(setupPayload.id);
        await saveSceneContent(capSceneId, capBefore);
        // If the editor is currently displaying this scene, also reset its content
        // without firing onUpdate (second arg false).
        const ed = useEditorStore.getState().editor;
        const curScene = useSceneStore.getState().activeSceneId;
        if (ed && curScene === capSceneId) {
          try {
            ed.commands.setContent(JSON.parse(capBefore), {
              emitUpdate: false,
            });
          } catch {
            // ignore parse errors — DB state is the truth
          }
        }
        await get().loadSetups(foreshadowId);
        set((s) => {
          const list = [...(s.proposeResults[foreshadowId] ?? [])];
          list.splice(capIdx, 0, capCandidate);
          return {
            proposeResults: { ...s.proposeResults, [foreshadowId]: list },
          };
        });
      },
      async redo() {
        await createForeshadowSetup(setupPayload);
        await saveSceneContent(capSceneId, capAfter);
        const ed = useEditorStore.getState().editor;
        const curScene = useSceneStore.getState().activeSceneId;
        if (ed && curScene === capSceneId) {
          try {
            ed.commands.setContent(JSON.parse(capAfter), { emitUpdate: false });
          } catch {
            // ignore
          }
        }
        await get().loadSetups(foreshadowId);
        set((s) => ({
          proposeResults: {
            ...s.proposeResults,
            [foreshadowId]: (s.proposeResults[foreshadowId] ?? []).filter(
              (c) => c !== capCandidate,
            ),
          },
        }));
      },
    });
  },

  auditChapter: async (chapterId) => {
    if (get().auditingChapterIds.has(chapterId)) return;

    set((s) => ({
      auditingChapterIds: new Set([...s.auditingChapterIds, chapterId]),
    }));

    try {
      const nodes = useSceneStore.getState().nodes;
      const sceneNodes = nodes
        .filter((n) => n.nodeType === "scene" && n.parentId === chapterId)
        .sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1));

      const scenes = await Promise.all(
        sceneNodes.map(async (n, i) => {
          const content = await loadSceneContent(n.id);
          const bodyText = prosemirrorToText(content);
          return { sceneId: n.id, title: n.title, bodyText, orderIndex: i };
        }),
      );

      const { items } = get();
      const candidates = await auditChapterApi({
        chapterId,
        scenes,
        existingForeshadows: items.map((f) => ({
          id: f.id,
          title: f.title,
          intent: f.intent,
        })),
        relatedCodex: [],
      });

      set((s) => ({
        auditResults: { ...s.auditResults, [chapterId]: candidates },
      }));
    } catch (e) {
      toast.error(
        i18next.t("foreshadow.store.auditFailed", "監査に失敗しました"),
      );
      debugLog.error(
        "ForeshadowStore",
        `auditChapter: ${rootCause(e)}`,
        errorDetail(e),
      );
    } finally {
      set((s) => {
        const next = new Set(s.auditingChapterIds);
        next.delete(chapterId);
        return { auditingChapterIds: next };
      });
    }
  },
}));
