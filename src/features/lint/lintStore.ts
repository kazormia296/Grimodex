import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import type {
  Diagnostic,
  LintConfig,
  LintLanguage,
  LintResponse,
  LintScope,
  RuleWarning,
  WireLintBlock,
} from "./types";
import { useLintIgnoreStore } from "./lintIgnoreStore";

interface LintState {
  /** Scene id whose diagnostics are currently displayed. */
  currentSceneId: string | null;
  /** Diagnostics produced by Rust, before applying the ignore filter. */
  rawDiagnostics: Diagnostic[];
  /** Diagnostics to display (raw minus persistent-ignore matches). */
  diagnostics: Diagnostic[];
  /** Scene text that was linted — used to re-apply ignore matching. */
  lastSceneText: string;
  warnings: RuleWarning[];
  /** Monotonic counter used to discard stale responses. */
  pendingRequestId: number;
  isLinting: boolean;
  /** Last error message shown in the panel (for fatal LintError cases). */
  lastErrorMessage: string | null;

  /**
   * Kick off a lint run for the given scene. Earlier in-flight requests
   * for the same scene are superseded — the request id mechanism means
   * any stale response is dropped on arrival.
   */
  runLint: (
    sceneId: string,
    blocks: WireLintBlock[],
    config: LintConfig,
    language: LintLanguage,
    sceneText: string,
  ) => Promise<void>;

  /**
   * Re-run the ignore filter against the current raw diagnostics without
   * going back to Rust. Call this after the ignore list for this scene
   * changes (e.g. user added / removed an entry).
   */
  reapplyIgnores: (sceneId: string) => void;

  /** Reset state when a scene is closed or the linter is disabled. */
  clear: () => void;
  setCurrentScene: (sceneId: string | null) => void;
}

/**
 * Rust `LintError` arrives as `{ type, data }`. `String({...})` would just
 * print "[object Object]", so we format it explicitly for the panel.
 */
function formatLintError(err: unknown): string {
  if (err && typeof err === "object" && "type" in err) {
    const e = err as { type: string; data?: unknown };
    switch (e.type) {
      case "TextTooLarge":
        return "このシーンは Lint できない大きさです";
      case "InvalidLanguage":
        return `未対応の言語です: ${String(e.data ?? "")}`;
      case "InvalidConfig":
        return "Linter 設定にエラーがあります";
      default:
        return `Linter が一時的に利用できません (${e.type})`;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function applyIgnoreFilter(
  sceneId: string,
  diagnostics: Diagnostic[],
  sceneText: string,
): Diagnostic[] {
  return useLintIgnoreStore
    .getState()
    .filterDiagnostics(sceneId, diagnostics, sceneText);
}

export const useLintStore = create<LintState>()((set, get) => ({
  currentSceneId: null,
  rawDiagnostics: [],
  diagnostics: [],
  lastSceneText: "",
  warnings: [],
  pendingRequestId: 0,
  isLinting: false,
  lastErrorMessage: null,

  setCurrentScene: (sceneId) => {
    set({
      currentSceneId: sceneId,
      rawDiagnostics: [],
      diagnostics: [],
      lastSceneText: "",
      warnings: [],
    });
  },

  clear: () =>
    set({
      rawDiagnostics: [],
      diagnostics: [],
      lastSceneText: "",
      warnings: [],
      isLinting: false,
      lastErrorMessage: null,
    }),

  reapplyIgnores: (sceneId) => {
    const { rawDiagnostics, lastSceneText, currentSceneId } = get();
    if (currentSceneId !== sceneId) return;
    const filtered = applyIgnoreFilter(sceneId, rawDiagnostics, lastSceneText);
    set({ diagnostics: filtered });
  },

  runLint: async (sceneId, blocks, config, language, sceneText) => {
    const requestId = get().pendingRequestId + 1;
    set({
      pendingRequestId: requestId,
      isLinting: true,
      currentSceneId: sceneId,
    });

    const scope: LintScope = { kind: "scene", scene_id: sceneId };

    try {
      const resp = await invoke<LintResponse>("lint_text", {
        blocks,
        language,
        scope,
        config,
      });
      // Drop if a newer request has been issued in the meantime.
      if (get().pendingRequestId !== requestId) return;
      const filtered = applyIgnoreFilter(sceneId, resp.diagnostics, sceneText);
      set({
        rawDiagnostics: resp.diagnostics,
        diagnostics: filtered,
        lastSceneText: sceneText,
        warnings: resp.warnings,
        isLinting: false,
        lastErrorMessage: null,
      });
    } catch (err) {
      if (get().pendingRequestId !== requestId) return;
      const message = formatLintError(err);
      set({
        rawDiagnostics: [],
        diagnostics: [],
        lastSceneText: "",
        warnings: [],
        isLinting: false,
        lastErrorMessage: message,
      });
    }
  },
}));
