/**
 * Project-scan state (Phase 2 Project mode).
 *
 * Kept separate from `lintStore` so the live-editor pipeline and the
 * all-scenes pipeline can coexist: flipping between Current and Project
 * modes in the panel should not throw away either side's results.
 */

import { create } from "zustand";
import i18next from "@/lib/i18n";
import { useLintConfigStore } from "./lintConfigStore";
import { resolveLintLanguage } from "./types";
import type { Diagnostic, Utf16Range } from "./types";
import {
  scanProject,
  type ProjectScanProgress,
  type ScannedScene,
} from "./projectScan";

/**
 * A deferred "open scene, then jump to this range" action. Written by
 * the panel when the user clicks a project-mode diagnostic for a
 * non-current scene; consumed by the editor after it finishes
 * loading that scene's content.
 */
export interface PendingJump {
  sceneId: string;
  range: Utf16Range;
}

export type ScanPhase = "idle" | "running" | "done" | "cancelled" | "error";

interface LintProjectState {
  phase: ScanPhase;
  completed: number;
  total: number;
  currentSceneId: string | null;
  currentSceneTitle: string | null;
  scenes: ScannedScene[];
  /** Flattened diagnostic list tagged with sceneId for panel display. */
  fatalError: string | null;
  /** Timestamp when this result set was produced (for UI freshness hint). */
  completedAt: number | null;

  start: (projectId: string) => Promise<void>;
  cancel: () => void;
  clear: () => void;
  replaceSceneDiagnostics: (sceneId: string, diagnostics: Diagnostic[]) => void;
  /** Request a scene open + jump. Consumed once by useLinter. */
  pendingJump: PendingJump | null;
  requestJump: (jump: PendingJump) => void;
  consumeJump: (sceneId: string) => PendingJump | null;
}

let activeController: AbortController | null = null;

export const useLintProjectStore = create<LintProjectState>()((set, get) => ({
  phase: "idle",
  completed: 0,
  total: 0,
  currentSceneId: null,
  currentSceneTitle: null,
  scenes: [],
  fatalError: null,
  completedAt: null,
  pendingJump: null,

  requestJump: (jump) => set({ pendingJump: jump }),

  consumeJump: (sceneId) => {
    const { pendingJump } = get();
    if (!pendingJump || pendingJump.sceneId !== sceneId) return null;
    set({ pendingJump: null });
    return pendingJump;
  },

  start: async (projectId) => {
    // If a scan is already running, ignore — user should cancel first.
    if (get().phase === "running") return;
    const cfgStore = useLintConfigStore.getState();
    if (!cfgStore.isLoaded) {
      set({
        phase: "error",
        fatalError: i18next.t(
          "lint.error.configLoadingWait",
          "設定の読み込み待ちです",
        ),
      });
      return;
    }
    const effective = cfgStore.getEffective();
    const language = resolveLintLanguage();
    if (!effective.enabled || !effective.languages[language]?.enabled) {
      set({
        phase: "error",
        fatalError: i18next.t(
          "lint.error.linterDisabled",
          "Linter が無効化されています",
        ),
      });
      return;
    }
    const codexRule = effective.rules["codex/name-inconsistency"];
    const includeCodex = Boolean(codexRule && codexRule.enabled !== false);

    const controller = new AbortController();
    activeController = controller;
    set({
      phase: "running",
      completed: 0,
      total: 0,
      currentSceneId: null,
      currentSceneTitle: null,
      scenes: [],
      fatalError: null,
      completedAt: null,
    });

    const onProgress = (p: ProjectScanProgress) => {
      // Don't clobber 'cancelled' → 'running' if cancel fired between
      // tick and reaching here.
      if (get().phase !== "running") return;
      set({
        completed: p.completed,
        total: p.total,
        currentSceneId: p.currentSceneId,
        currentSceneTitle: p.currentSceneTitle,
      });
    };
    const onSceneComplete = (scene: ScannedScene) => {
      // Stream-append so the panel can show results as they arrive.
      if (get().phase !== "running") return;
      set((s) => ({ scenes: [...s.scenes, scene] }));
    };

    const result = await scanProject({
      projectId,
      language,
      baseConfig: cfgStore.getWireConfig(),
      includeCodex,
      signal: controller.signal,
      onProgress,
      onSceneComplete,
    });

    // If another scan took over while this one was running, don't touch state.
    if (activeController !== controller) return;
    activeController = null;

    if (result.fatalError) {
      set({
        phase: "error",
        fatalError: result.fatalError,
        completedAt: Date.now(),
      });
      return;
    }
    set({
      phase: result.finished ? "done" : "cancelled",
      scenes: result.scenes,
      completedAt: Date.now(),
      currentSceneId: null,
      currentSceneTitle: null,
    });
  },

  cancel: () => {
    if (activeController) {
      activeController.abort();
    }
    // Flip phase immediately so the UI reflects user intent without
    // waiting for the active tick to notice.
    if (get().phase === "running") {
      set({ phase: "cancelled", completedAt: Date.now() });
    }
  },

  clear: () => {
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
    set({
      phase: "idle",
      completed: 0,
      total: 0,
      currentSceneId: null,
      currentSceneTitle: null,
      scenes: [],
      fatalError: null,
      completedAt: null,
    });
  },

  replaceSceneDiagnostics: (sceneId, diagnostics) => {
    set((s) => ({
      scenes: s.scenes.map((scn) =>
        scn.sceneId === sceneId ? { ...scn, diagnostics } : scn,
      ),
    }));
  },
}));
