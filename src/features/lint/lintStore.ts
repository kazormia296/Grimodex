import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import type {
  Diagnostic,
  LintConfig,
  LintResponse,
  LintScope,
  RuleWarning,
  WireLintBlock,
} from "./types";

interface LintState {
  /** Scene id whose diagnostics are currently displayed. */
  currentSceneId: string | null;
  diagnostics: Diagnostic[];
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
  ) => Promise<void>;

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

export const useLintStore = create<LintState>()((set, get) => ({
  currentSceneId: null,
  diagnostics: [],
  warnings: [],
  pendingRequestId: 0,
  isLinting: false,
  lastErrorMessage: null,

  setCurrentScene: (sceneId) => {
    set({ currentSceneId: sceneId, diagnostics: [], warnings: [] });
  },

  clear: () =>
    set({
      diagnostics: [],
      warnings: [],
      isLinting: false,
      lastErrorMessage: null,
    }),

  runLint: async (sceneId, blocks, config) => {
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
        language: "ja",
        scope,
        config,
      });
      // Drop if a newer request has been issued in the meantime.
      if (get().pendingRequestId !== requestId) return;
      set({
        diagnostics: resp.diagnostics,
        warnings: resp.warnings,
        isLinting: false,
        lastErrorMessage: null,
      });
    } catch (err) {
      if (get().pendingRequestId !== requestId) return;
      const message = formatLintError(err);
      set({
        diagnostics: [],
        warnings: [],
        isLinting: false,
        lastErrorMessage: message,
      });
    }
  },
}));
