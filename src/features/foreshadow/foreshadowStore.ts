import { create } from "zustand";
import { toast } from "sonner";
import i18next from "i18next";
import { debugLog, errorDetail, rootCause } from "@/lib/debugLog";
import {
  listForeshadowsWithLabels,
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
  detectRelatedCodex,
  type SceneForeshadowInfo,
} from "./api";
import { loadSceneContent, saveSceneContent } from "@/features/tree/api";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { rebaselineScenesAtTail } from "@/features/timelapse/toggle";
import { saveScene } from "@/features/editor/editorSaveRegistry";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { prosemirrorToText } from "@/lib/prosemirror";
import {
  saveForeshadowAnchors,
  unsetForeshadowPayoffMarksByForeshadowIds,
} from "./saveAnchors";
import { createRevision } from "@/features/revision/api";
import { aiAuthorshipAttrs } from "@/features/attribution/aiAuthorship";
import type { ProposedSetup } from "./api";
import { safeParseAiEvaluation } from "./types";
import type { AuditCandidate } from "./types";
import { deriveLabel } from "./deriveLabel";
import { useEditorStore } from "@/features/editor/editorStore";
import { useSceneStore } from "@/features/tree/store";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { captureForeshadowDeletion } from "@/features/trash-bin/captureHooks";
import { useTrashBinStore } from "@/features/trash-bin/trashBinStore";
import type {
  ForeshadowRow,
  ForeshadowSetupRow,
  ForeshadowWithLabel,
} from "./types";

/**
 * Foreshadow undo/redo re-bakes payoff marks by writing scene content directly
 * (`saveSceneContent`) and, when the editor is live, `setContent(..., {
 * emitUpdate: false })` — both bypass the editor's doc.step recording. This is
 * an out-of-band body write, so record it and re-anchor the scene's editor
 * baseline at the chain tail (same treatment as a snapshot restore) to keep
 * timelapse replay coherent. no-op when recording is off / no scene.
 */
async function recordForeshadowMarkBake(sceneId: string | null): Promise<void> {
  if (!sceneId) return;
  recordChangeEvent({
    domain: "foreshadow",
    opType: "mark.update",
    entityType: "scene",
    entityId: sceneId,
    sceneId,
    payload: { sceneId },
  });
  await rebaselineScenesAtTail(getCurrentProjectId(), [sceneId]);
}

interface ForeshadowState {
  items: ForeshadowWithLabel[];
  isLoading: boolean;
  sceneInfoBySceneId: Record<string, SceneForeshadowInfo>;

  /** 各伏線の非孤立 Setup シーン ID (load 時に構築・レーダーが使用)。 */
  setupScenesByForeshadowId: Record<string, string[]>;

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

export const useForeshadowStore = create<ForeshadowState>()((set, get) => ({
  items: [],
  isLoading: false,
  sceneInfoBySceneId: {},
  setupScenesByForeshadowId: {},
  setupsByForeshadowId: {},
  evaluatingSetupIds: new Set<string>(),
  proposeResults: {},
  proposingForForeshadowIds: new Set<string>(),
  auditingChapterIds: new Set<string>(),
  auditResults: {},

  load: async (projectId) => {
    set({ isLoading: true });
    try {
      const { items, sceneInfoBySceneId, setupScenesByForeshadowId } =
        await listForeshadowsWithLabels(projectId);
      set({
        items,
        sceneInfoBySceneId,
        setupScenesByForeshadowId: setupScenesByForeshadowId ?? {},
        isLoading: false,
      });
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
          label: i18next.t("foreshadow.store.historyCreate"),
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

    // payoffSceneId を null にした更新の場合、本文の payoff mark を物理削除
    // しているため、Undo 側で「対象シーンが現在開かれていれば mark を再付与
    // して saveSceneContent」を行う必要がある。対象シーンが開かれていない
    // 場合は DB だけ巻き戻せば、ロード時に loadForeshadowAnchors が DB から
    // mark を復元する。
    const releasedPayoff =
      patch.payoffSceneId === null &&
      typeof before.payoffSceneId === "string" &&
      before.payoffFromPos != null &&
      before.payoffToPos != null;
    const releasedPayoffSnapshot = releasedPayoff
      ? {
          sceneId: before.payoffSceneId as string,
          fromPos: before.payoffFromPos as number,
          toPos: before.payoffToPos as number,
        }
      : null;

    useGlobalHistoryStore.getState().push({
      kind: "foreshadow",
      label: i18next.t("foreshadow.store.historyUpdate"),
      async undo() {
        await updateForeshadow(id, undoPatch);
        if (releasedPayoffSnapshot) {
          const editor = useEditorStore.getState().editor;
          const activeSceneId = useSceneStore.getState().activeSceneId;
          if (
            editor &&
            activeSceneId &&
            activeSceneId === releasedPayoffSnapshot.sceneId
          ) {
            const payoffType = editor.state.schema.marks["foreshadowPayoff"];
            if (payoffType) {
              const tr = editor.state.tr;
              tr.addMark(
                releasedPayoffSnapshot.fromPos,
                releasedPayoffSnapshot.toPos,
                payoffType.create({ foreshadowId: id }),
              );
              editor.view.dispatch(tr);
              const contentJson = JSON.stringify(editor.getJSON());
              await saveSceneContent(activeSceneId, contentJson);
            }
          }
        }
        await get().load(projectId);
      },
      async redo() {
        await updateForeshadow(id, patch);
        if (releasedPayoffSnapshot) {
          const editor = useEditorStore.getState().editor;
          const activeSceneId = useSceneStore.getState().activeSceneId;
          if (
            editor &&
            activeSceneId &&
            activeSceneId === releasedPayoffSnapshot.sceneId
          ) {
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

    // Trash 連携: foreshadow の削除をゴミ箱にキャプチャ。
    // setup 行は CASCADE で消えるが復元時には再生できないため payload には含めない。
    const trashTempId = `trash-foreshadow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${before.id}`;
    captureForeshadowDeletion({
      projectId: before.projectId,
      foreshadow: before,
      tempId: trashTempId,
    });

    // Note: cascade FK は foreshadowSetups を消す。本 entry では foreshadow row
    // のみを restore し、setup 行とそれに対応する mark は復元できない。
    // 別 PR の adopt 系アトミック化で扱う想定。
    const cap = { ...before };
    useGlobalHistoryStore.getState().push({
      kind: "foreshadow",
      label: i18next.t("foreshadow.store.historyDelete"),
      async undo() {
        // 1500ms 以内 Ctrl+Z 吸収: trash 保留を cancel
        useTrashBinStore.getState().cancelPending({ tempId: trashTempId });
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
      // DB content を読む前に、編集中シーンの debounce 未 flush 保存を確定させる
      // (ChatPanel.handleSend と同じ仕組み)。
      const activeSceneId = useSceneStore.getState().activeSceneId;
      if (activeSceneId) await saveScene(activeSceneId);

      const nodes = useSceneStore.getState().nodes;
      const payoffNode = nodes.find((n) => n.id === foreshadow.payoffSceneId);
      const sceneNodes = nodes
        .filter(
          (n) =>
            n.nodeType === "scene" &&
            n.id !== foreshadow.payoffSceneId &&
            (payoffNode ? n.sortOrder < payoffNode.sortOrder : true),
        )
        .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

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

      const relatedCodex = await detectRelatedCodex(
        [payoffText, ...pastScenes.map((s) => s.excerpt)].join("\n"),
      );

      const results = await proposePastSetups({
        intent: foreshadow.intent ?? foreshadow.title,
        payoffSceneId: foreshadow.payoffSceneId,
        payoffExcerpt: payoffText.slice(0, 1000),
        pastScenes,
        relatedCodex,
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
      label: i18next.t("foreshadow.store.historyAdoptSetup"),
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

    let afterContent: string;

    try {
      // Pre-create DB record with AI metadata before inserting text.
      // The saveForeshadowAnchors UPSERT will only update fromPos/toPos — metadata is preserved.
      await createForeshadowSetup(setupPayload);

      // Insert text and apply foreshadowSetup + authorship marks in the editor.
      // The suggestedText is AI-generated (setupPayload.attribution === "ai"),
      // so tag it source='ai'; without this the AuthorshipMark default 'human'
      // would mis-count it in authorship_spans / loadBatchAiRatio. The
      // programmaticInsert meta keeps AiEditedPlugin from splitting the mark.
      editor
        .chain()
        .command(({ tr }) => {
          tr.setMeta("programmaticInsert", true);
          return true;
        })
        .insertContentAt(from, suggestedText)
        .setTextSelection({ from, to: from + suggestedText.length })
        .setMark("foreshadowSetup", { setupId, foreshadowId })
        .setMark("authorship", aiAuthorshipAttrs())
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

    const capCandidate = { ...candidate };
    const capIdx = candidateIdx;
    const capSceneId = activeSceneId;
    const capBefore = beforeContent;
    const capAfter = afterContent;

    useGlobalHistoryStore.getState().push({
      kind: "foreshadow",
      label: i18next.t("foreshadow.store.historyAdoptSetupInsert"),
      async undo() {
        await deleteSetup(setupPayload.id);
        await saveSceneContent(capSceneId, capBefore);
        await recordForeshadowMarkBake(capSceneId);
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
        await recordForeshadowMarkBake(capSceneId);
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
      // DB content を読む前に、編集中シーンの debounce 未 flush 保存を確定させる
      // (ChatPanel.handleSend と同じ仕組み)。
      const activeSceneId = useSceneStore.getState().activeSceneId;
      if (activeSceneId) await saveScene(activeSceneId);

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

      const relatedCodex = await detectRelatedCodex(
        scenes.map((s) => s.bodyText).join("\n"),
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
        relatedCodex,
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
