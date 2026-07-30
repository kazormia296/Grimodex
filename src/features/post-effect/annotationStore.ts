import { create } from "zustand";
import {
  readRuntimeSettingBoolean,
  writeRuntimeSetting,
} from "@/features/settings/runtimeSettings";
import type {
  LayerSetOptions,
  PostEffectAnnotation,
  PostEffectStatus,
} from "./types";

export type { LayerSetOptions } from "./types";

interface AnnotationState {
  /** Annotations for the currently open scene, keyed by sceneId */
  annotationsByScene: Map<string, PostEffectAnnotation[]>;
  /** Whether the annotation (校閲の指摘) overlays are visible */
  showAnnotations: boolean;
  /** Whether pseudo_comment (読者コメント) overlays are visible */
  showReaderComments: boolean;
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
  setShowAnnotations: (visible: boolean, opts?: LayerSetOptions) => void;
  toggleShowAnnotations: () => void;
  setShowReaderComments: (visible: boolean, opts?: LayerSetOptions) => void;
  toggleShowReaderComments: () => void;
  setFocusedAnnotationId: (id: string | null) => void;
  /** Sync runtime state from persisted settings (call after loadAll). */
  initFromSettings: () => void;
}

export const useAnnotationStore = create<AnnotationState>()((set, get) => ({
  annotationsByScene: new Map(),
  showAnnotations: true,
  showReaderComments: true,
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

  setShowAnnotations: (visible, opts) => {
    if (opts?.persist !== false) {
      writeRuntimeSetting("display.layerReview", String(visible));
    }
    set({ showAnnotations: visible });
  },

  toggleShowAnnotations: () => get().setShowAnnotations(!get().showAnnotations),

  setShowReaderComments: (visible, opts) => {
    if (opts?.persist !== false) {
      writeRuntimeSetting("display.layerReaderComments", String(visible));
    }
    set({ showReaderComments: visible });
  },

  toggleShowReaderComments: () =>
    get().setShowReaderComments(!get().showReaderComments),

  setFocusedAnnotationId: (id) => set({ focusedAnnotationId: id }),

  initFromSettings: () => {
    set({
      showAnnotations: readRuntimeSettingBoolean("display.layerReview", true),
      showReaderComments: readRuntimeSettingBoolean(
        "display.layerReaderComments",
        true,
      ),
    });
  },
}));
