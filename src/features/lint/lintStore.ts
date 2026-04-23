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
   * Scene-wide UTF-16 offset of the editor cursor (null if unknown or
   * the cursor is outside any lintable block). Drives reverse highlight.
   */
  cursorOffset: number | null;
  setCursorOffset: (offset: number | null) => void;

  /**
   * Kick off a lint run for the given scene. Earlier in-flight requests
   * for the same scene are superseded — the request id mechanism means
   * any stale response is dropped on arrival.
   *
   * Implements incremental lint: only blocks whose `kind + text` changed
   * since the last run are sent to Rust. Cached relative-offset diagnostics
   * are shifted by the block's current `str_offset_start` and merged with
   * the fresh results.
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
 * Merge incoming warnings into the existing log, deduplicating by
 * `rule_id + kind`. Incoming entries overwrite existing ones with the same
 * key so the message stays fresh, but entries absent from `incoming` are
 * kept — persistent conditions (e.g. UniDic InitFailed) must not blink away
 * on a lint cycle that happens to produce no warning.
 */
export function mergeWarnings(
  existing: RuleWarning[],
  incoming: RuleWarning[],
): RuleWarning[] {
  const map = new Map(existing.map((w) => [`${w.rule_id}:${w.kind}`, w]));
  for (const w of incoming) {
    map.set(`${w.rule_id}:${w.kind}`, w);
  }
  return Array.from(map.values());
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

// ---------------------------------------------------------------------------
// Incremental lint helpers
// ---------------------------------------------------------------------------

/**
 * Cache key for one block. Captures content identity: same kind + same text
 * means the same diagnostics (all current rules are block-internal).
 */
export function blockCacheKey(block: WireLintBlock): string {
  return `${block.kind}\0${block.text}`;
}

/**
 * Convert a Diagnostic with scene-wide absolute ranges to one whose ranges
 * are relative to `offset` (the block's `str_offset_start`). The returned
 * value is stored in the cache.
 */
export function toRelative(d: Diagnostic, offset: number): Diagnostic {
  return {
    ...d,
    range: { start: d.range.start - offset, end: d.range.end - offset },
    fix: d.fix
      ? {
          ...d.fix,
          range: {
            start: d.fix.range.start - offset,
            end: d.fix.range.end - offset,
          },
        }
      : undefined,
  };
}

/**
 * Inverse of `toRelative`: add `offset` back to produce scene-wide absolute
 * ranges from the cached relative ones.
 */
export function toAbsolute(d: Diagnostic, offset: number): Diagnostic {
  return {
    ...d,
    range: { start: d.range.start + offset, end: d.range.end + offset },
    fix: d.fix
      ? {
          ...d.fix,
          range: {
            start: d.fix.range.start + offset,
            end: d.fix.range.end + offset,
          },
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useLintStore = create<LintState>()((set, get) => {
  /**
   * Block-level diagnostic cache — NOT tracked by Zustand (implementation
   * detail, not UI state). Values are relative-offset Diagnostics so they
   * survive block repositioning without a full cache bust.
   *
   * Key: blockCacheKey(block) = `kind\0text`
   */
  let blockDiagCache = new Map<string, Diagnostic[]>();
  /**
   * JSON snapshot of { config, language } from the last runLint call.
   * When this changes the entire block cache is invalidated.
   */
  let lastConfigKey = "";

  return {
    currentSceneId: null,
    rawDiagnostics: [],
    diagnostics: [],
    lastSceneText: "",
    warnings: [],
    pendingRequestId: 0,
    isLinting: false,
    lastErrorMessage: null,
    cursorOffset: null,

    setCursorOffset: (offset) => set({ cursorOffset: offset }),

    setCurrentScene: (sceneId) => {
      blockDiagCache = new Map();
      lastConfigKey = "";
      set({
        currentSceneId: sceneId,
        rawDiagnostics: [],
        diagnostics: [],
        lastSceneText: "",
        warnings: [],
      });
    },

    clear: () => {
      blockDiagCache = new Map();
      lastConfigKey = "";
      set({
        rawDiagnostics: [],
        diagnostics: [],
        lastSceneText: "",
        warnings: [],
        isLinting: false,
        lastErrorMessage: null,
      });
    },

    reapplyIgnores: (sceneId) => {
      const { rawDiagnostics, lastSceneText, currentSceneId } = get();
      if (currentSceneId !== sceneId) return;
      const filtered = applyIgnoreFilter(
        sceneId,
        rawDiagnostics,
        lastSceneText,
      );
      set({ diagnostics: filtered });
    },

    runLint: async (sceneId, blocks, config, language, sceneText) => {
      const requestId = get().pendingRequestId + 1;

      // Invalidate block cache when config or language changes.
      const configKey = JSON.stringify({ config, language });
      if (configKey !== lastConfigKey) {
        blockDiagCache = new Map();
        lastConfigKey = configKey;
      }

      set({
        pendingRequestId: requestId,
        isLinting: true,
        currentSceneId: sceneId,
      });

      const scope: LintScope = { kind: "scene", scene_id: sceneId };

      // Split blocks: hits come from cache, misses go to Rust.
      const hitBlocks: WireLintBlock[] = [];
      const missBlocks: WireLintBlock[] = [];
      for (const block of blocks) {
        if (blockDiagCache.has(blockCacheKey(block))) {
          hitBlocks.push(block);
        } else {
          missBlocks.push(block);
        }
      }

      try {
        let freshDiagnostics: Diagnostic[] = [];
        let freshWarnings: RuleWarning[] = [];

        if (missBlocks.length > 0) {
          const resp = await invoke<LintResponse>("lint_text", {
            blocks: missBlocks,
            language,
            scope,
            config,
          });
          // Drop if a newer request superseded this one.
          if (get().pendingRequestId !== requestId) return;

          freshWarnings = resp.warnings;

          // Attribute each returned diagnostic to its source block by
          // range interval, then cache as relative offsets.
          const attributedIndices = new Set<number>();
          for (const block of missBlocks) {
            const blockEnd = block.str_offset_start + block.text.length;
            const blockDiags = resp.diagnostics.filter((d, i) => {
              if (
                d.range.start >= block.str_offset_start &&
                d.range.start < blockEnd
              ) {
                attributedIndices.add(i);
                return true;
              }
              return false;
            });
            blockDiagCache.set(
              blockCacheKey(block),
              blockDiags.map((d) => toRelative(d, block.str_offset_start)),
            );
            freshDiagnostics.push(...blockDiags);
          }
          if (import.meta.env.DEV) {
            const orphans = resp.diagnostics.filter(
              (_, i) => !attributedIndices.has(i),
            );
            if (orphans.length > 0) {
              console.warn(
                "[lint] orphan diagnostics (cross-block rule?)",
                orphans,
              );
            }
          }
        } else {
          // All blocks were cache hits — no Rust call needed.
          if (get().pendingRequestId !== requestId) return;
        }

        // Reconstruct absolute diagnostics from cache hits.
        for (const block of hitBlocks) {
          const cached = blockDiagCache.get(blockCacheKey(block)) ?? [];
          freshDiagnostics.push(
            ...cached.map((d) => toAbsolute(d, block.str_offset_start)),
          );
        }

        // Restore deterministic ordering (Rust sorts within each run; we
        // need to re-sort after merging hit and miss results).
        freshDiagnostics.sort(
          (a, b) =>
            a.range.start - b.range.start ||
            a.range.end - b.range.end ||
            a.rule_id.localeCompare(b.rule_id),
        );

        const filtered = applyIgnoreFilter(
          sceneId,
          freshDiagnostics,
          sceneText,
        );
        set((s) => ({
          rawDiagnostics: freshDiagnostics,
          diagnostics: filtered,
          lastSceneText: sceneText,
          warnings: mergeWarnings(s.warnings, freshWarnings),
          isLinting: false,
          lastErrorMessage: null,
        }));
      } catch (err) {
        if (get().pendingRequestId !== requestId) return;
        // Clear the block cache on error — stale entries could mask the root
        // cause on the next successful run.
        blockDiagCache = new Map();
        lastConfigKey = "";
        const message = formatLintError(err);
        set({
          rawDiagnostics: [],
          diagnostics: [],
          lastSceneText: "",
          isLinting: false,
          lastErrorMessage: message,
        });
      }
    },
  };
});
