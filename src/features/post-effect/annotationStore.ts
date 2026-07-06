import { create } from "zustand";
import { useSettingsStore } from "@/features/settings/settingsStore";
import type { PostEffectAnnotation, PostEffectStatus } from "./types";

interface AnnotationState {
  /** Annotations for the currently open scene, keyed by sceneId */
  annotationsByScene: Map<string, PostEffectAnnotation[]>;
  /** Whether the annotation overlays are visible */
  showAnnotations: boolean;
  /** ID of the annotation currently highlighted/selected in the panel */
  focusedAnnotationId: string | null;

  setAnnotations: (
    sceneId: string,
    annotations: PostEffectAnnotation[],
  ) => void;
  updateAnnotationStatus: (
    annotationId: string,
    status: PostEffectStatus,
  ) => void;
  toggleShowAnnotations: () => void;
  setFocusedAnnotationId: (id: string | null) => void;
  /** Sync runtime state from persisted settings (call after loadAll). */
  initFromSettings: () => void;
}

export const useAnnotationStore = create<AnnotationState>()((set) => ({
  annotationsByScene: new Map(),
  showAnnotations: true,
  focusedAnnotationId: null,

  setAnnotations: (sceneId, annotations) =>
    set((s) => {
      const next = new Map(s.annotationsByScene);
      next.set(sceneId, annotations);
      return { annotationsByScene: next };
    }),

  updateAnnotationStatus: (annotationId, status) =>
    set((s) => {
      const next = new Map(s.annotationsByScene);
      for (const [sceneId, anns] of next) {
        const idx = anns.findIndex((a) => a.id === annotationId);
        if (idx !== -1) {
          const updated = anns.map((a, i) =>
            i === idx ? { ...a, status } : a,
          );
          next.set(sceneId, updated);
          break;
        }
      }
      return { annotationsByScene: next };
    }),

  toggleShowAnnotations: () =>
    set((s) => {
      const next = !s.showAnnotations;
      useSettingsStore.getState().set("display.layerReview", String(next));
      return { showAnnotations: next };
    }),

  setFocusedAnnotationId: (id) => set({ focusedAnnotationId: id }),

  initFromSettings: () => {
    set({
      showAnnotations: useSettingsStore
        .getState()
        .getBoolean("display.layerReview", true),
    });
  },
}));
