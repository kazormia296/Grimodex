import { create } from "zustand";
import i18next from "@/lib/i18n";
import { invoke } from "@/lib/tauri";
import { announce } from "@/lib/a11y/announcer";
import type {
  Diagnostic,
  DisableDirective,
  LintConfig,
  LintIncrementalScope,
  LintInputRevisions,
  LintLanguage,
  LintResponse,
  LintScope,
  RuleWarning,
  WireLintBlock,
} from "./types";
import { useLintIgnoreStore } from "./lintIgnoreStore";

/**
 * One-off informational message pushed into the panel from UI actions
 * (currently: Fix-applied-and-removed-a-disable). Distinct from
 * `RuleWarning` because the schema for those is owned by Rust and bumping
 * it would require an engine round-trip for a pure-UI signal.
 *
 * Lifetime is "until next runLint clears it" — design says "本文への
 * 反映を執筆体験を阻害しない原則"、so we don't leave it lingering forever.
 */
export interface LintNotification {
  id: string;
  message: string;
  timestamp: number;
}

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
  /** Transient UI notifications (e.g. Fix removed N disable Marks). */
  notifications: LintNotification[];
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
   * since the last run are recomputed. Rust reports the maximum context scope
   * required by enabled rules, so a cross-block target receives its required
   * neighbour(s) without treating context-only diagnostics as fresh results.
   * Cached relative-offset diagnostics are shifted by the block's current
   * `str_offset_start` and merged with the fresh results.
   */
  runLint: (
    sceneId: string,
    blocks: WireLintBlock[],
    config: LintConfig,
    language: LintLanguage,
    sceneText: string,
    disables: DisableDirective[],
    inputRevisions?: LintInputRevisions,
  ) => Promise<void>;

  /**
   * Re-run the ignore filter against the current raw diagnostics without
   * going back to Rust. Call this after the ignore list for this scene
   * changes (e.g. user added / removed an entry).
   */
  reapplyIgnores: (sceneId: string) => void;

  /** Push a transient UI notification (auto-cleared on next runLint). */
  pushNotification: (message: string) => void;
  /** Dismiss a single notification by id. */
  dismissNotification: (id: string) => void;

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
        return i18next.t(
          "lint.error.sceneTooLarge",
          "このシーンは Lint できない大きさです",
        );
      case "InvalidLanguage":
        return i18next.t("lint.error.unsupportedLanguage", {
          lang: String(e.data ?? ""),
          defaultValue: "未対応の言語です: {{lang}}",
        });
      case "InvalidConfig":
        return i18next.t(
          "lint.error.configError",
          "Linter 設定にエラーがあります",
        );
      default:
        return i18next.t("lint.error.temporarilyUnavailable", {
          type: e.type,
          defaultValue: "Linter が一時的に利用できません ({{type}})",
        });
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

function diagnosticListsEqual(
  left: readonly Diagnostic[],
  right: readonly Diagnostic[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.rule_id !== b.rule_id ||
      a.severity !== b.severity ||
      a.message !== b.message ||
      a.range.start !== b.range.start ||
      a.range.end !== b.range.end ||
      a.fix?.label !== b.fix?.label ||
      a.fix?.replacement !== b.fix?.replacement ||
      a.fix?.range.start !== b.fix?.range.start ||
      a.fix?.range.end !== b.fix?.range.end
    ) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Incremental lint helpers
// ---------------------------------------------------------------------------

/**
 * Cache key for one block. Captures content identity: same kind + same text
 * means the same diagnostics for block-local rules.
 */
export function blockCacheKey(block: WireLintBlock): string {
  return `${block.kind}\0${block.text}`;
}

function sceneContentKey(blocks: WireLintBlock[]): string {
  return JSON.stringify(
    blocks.map((block) => [
      block.id,
      block.kind,
      block.text,
      block.str_offset_start,
    ]),
  );
}

function responseIncrementalScope(
  scope: LintResponse["incremental_scope"],
): LintIncrementalScope {
  switch (scope) {
    case "block":
    case "nextBlock":
    case "scene":
      return scope;
    default:
      // Backward compatibility with pre-contract backends. The initial pass
      // already contains every block; retaining that correct result under a
      // scene-wide key is safer than assuming unknown rules are block-local.
      return "scene";
  }
}

/**
 * Key one target by the context Rust says its enabled rules consume.
 * `nextBlock` includes the successor's content identity, so changing only the
 * successor invalidates the preceding target. Scene-scoped entries are keyed
 * by index after the whole cache has been invalidated on a scene-key change.
 */
function scopedBlockCacheKey(
  blocks: WireLintBlock[],
  index: number,
  scope: LintIncrementalScope,
): string {
  const block = blocks[index];
  if (!block) return `missing:${index}`;
  const own = blockCacheKey(block);
  switch (scope) {
    case "nextBlock":
      return JSON.stringify([
        own,
        blocks[index + 1] ? blockCacheKey(blocks[index + 1]) : null,
      ]);
    case "scene":
      return JSON.stringify([index, own]);
    case "block":
      return own;
  }
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
   * Keys include the neighbouring context declared by Rust when required.
   */
  let blockDiagCache = new Map<string, Diagnostic[]>();
  /**
   * Engine-owned context contract from the last successful response. `null`
   * means the cache is empty and the next request necessarily contains every
   * block, allowing Rust to establish the contract safely.
   */
  let lastIncrementalScope: LintIncrementalScope | null = null;
  /** Last successful scene content sequence, used by `scene` scope. */
  let lastSceneContentKey = "";
  /**
   * JSON snapshot of rules, language, disables, and project-input revisions
   * from the last runLint call. When it changes the block cache is invalidated.
   */
  let lastConfigKey = "";
  /**
   * SR 読み上げ (announce) の重複抑止。lint は入力のたびに debounce 実行
   * されるため、毎回読み上げるとノイズになる — 診断数が変化したときだけ
   * 完了を announce する (視覚的にはパネルの件数変化に相当する情報)。
   * Lint はトーストを出さない経路なので二重読み上げにはならない。
   */
  let lastAnnouncedCount: number | null = null;
  let lastAnnouncedError: string | null = null;

  return {
    currentSceneId: null,
    rawDiagnostics: [],
    diagnostics: [],
    lastSceneText: "",
    warnings: [],
    notifications: [],
    pendingRequestId: 0,
    isLinting: false,
    lastErrorMessage: null,
    cursorOffset: null,

    setCursorOffset: (offset) => set({ cursorOffset: offset }),

    pushNotification: (message) => {
      const notification: LintNotification = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        message,
        timestamp: Date.now(),
      };
      set((s) => ({ notifications: [...s.notifications, notification] }));
    },

    dismissNotification: (id) => {
      set((s) => ({
        notifications: s.notifications.filter((n) => n.id !== id),
      }));
    },

    setCurrentScene: (sceneId) => {
      blockDiagCache = new Map();
      lastConfigKey = "";
      lastIncrementalScope = null;
      lastSceneContentKey = "";
      lastAnnouncedCount = null;
      lastAnnouncedError = null;
      set({
        currentSceneId: sceneId,
        rawDiagnostics: [],
        diagnostics: [],
        lastSceneText: "",
        warnings: [],
        notifications: [],
      });
    },

    clear: () => {
      blockDiagCache = new Map();
      lastConfigKey = "";
      lastIncrementalScope = null;
      lastSceneContentKey = "";
      lastAnnouncedCount = null;
      lastAnnouncedError = null;
      set({
        rawDiagnostics: [],
        diagnostics: [],
        lastSceneText: "",
        warnings: [],
        notifications: [],
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

    runLint: async (
      sceneId,
      blocks,
      config,
      language,
      sceneText,
      disables,
      inputRevisions,
    ) => {
      const requestId = get().pendingRequestId + 1;

      // Invalidate block cache when config, language, or disables change.
      // `disables` is sorted before serialisation so insertion order
      // doesn't cause spurious busts: two runs with the same directives
      // in a different order must map to the same key.
      const sortedDisables = [...disables].sort((a, b) => {
        if (a.range.start !== b.range.start)
          return a.range.start - b.range.start;
        if (a.range.end !== b.range.end) return a.range.end - b.range.end;
        return a.rules.join(",").localeCompare(b.rules.join(","));
      });
      const { codex_entries: codexEntries, ...configWithoutCodexEntries } =
        config;
      const configKey = JSON.stringify({
        config: configWithoutCodexEntries,
        codexInput:
          inputRevisions?.codex === undefined
            ? codexEntries
            : { revision: inputRevisions.codex },
        language,
        disables: sortedDisables,
      });
      if (configKey !== lastConfigKey) {
        blockDiagCache = new Map();
        lastConfigKey = configKey;
        lastIncrementalScope = null;
        lastSceneContentKey = "";
      }

      set({
        pendingRequestId: requestId,
        isLinting: true,
        currentSceneId: sceneId,
      });

      const scope: LintScope = { kind: "scene", scene_id: sceneId };

      const currentSceneContentKey =
        lastIncrementalScope === "scene" ? sceneContentKey(blocks) : null;
      if (
        lastIncrementalScope === "scene" &&
        currentSceneContentKey !== lastSceneContentKey
      ) {
        blockDiagCache = new Map();
      }

      // Split target blocks: hits come from cache, misses are recomputed.
      // Before the first response the cache is empty, so using block scope
      // here still sends the complete scene and lets Rust establish the
      // engine-owned scope contract.
      const requestScope = lastIncrementalScope ?? "block";
      const hitTargets: Array<{
        block: WireLintBlock;
        cacheKey: string;
      }> = [];
      const missTargets: Array<{
        block: WireLintBlock;
        index: number;
      }> = [];
      for (const [index, block] of blocks.entries()) {
        const cacheKey = scopedBlockCacheKey(blocks, index, requestScope);
        if (blockDiagCache.has(cacheKey)) {
          hitTargets.push({ block, cacheKey });
        } else {
          missTargets.push({ block, index });
        }
      }

      try {
        const freshDiagnostics: Diagnostic[] = [];
        let freshWarnings: RuleWarning[] = [];
        let responseScope = lastIncrementalScope;

        if (missTargets.length > 0) {
          const requestIndices = new Set(
            missTargets.map((target) => target.index),
          );
          if (requestScope === "nextBlock") {
            // Context blocks let Rust evaluate a target against its immediate
            // successor. They are deliberately not cache targets: their own
            // diagnostics may require a successor not present in this request.
            for (const target of missTargets) {
              if (target.index + 1 < blocks.length) {
                requestIndices.add(target.index + 1);
              }
            }
          } else if (requestScope === "scene") {
            for (const index of blocks.keys()) requestIndices.add(index);
          }
          const requestBlocks = blocks.filter((_, index) =>
            requestIndices.has(index),
          );
          const resp = await invoke<LintResponse>("lint_text", {
            blocks: requestBlocks,
            language,
            scope,
            config,
            disables,
          });
          // Drop if a newer request superseded this one.
          if (get().pendingRequestId !== requestId) return;

          freshWarnings = resp.warnings;
          const resolvedResponseScope = responseIncrementalScope(
            resp.incremental_scope,
          );
          responseScope = resolvedResponseScope;

          // Attribute each returned diagnostic to its source block by
          // range interval, then cache as relative offsets. Only miss targets
          // are cached; diagnostics belonging to context-only blocks are
          // intentionally ignored.
          const attributedIndices = new Set<number>();
          for (const target of missTargets) {
            const { block, index } = target;
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
              scopedBlockCacheKey(blocks, index, resolvedResponseScope),
              blockDiags.map((d) => toRelative(d, block.str_offset_start)),
            );
            freshDiagnostics.push(...blockDiags);
          }
          if (import.meta.env.DEV) {
            const orphans = resp.diagnostics.filter(
              (diagnostic, i) =>
                !attributedIndices.has(i) &&
                !requestBlocks.some((block) => {
                  const blockEnd = block.str_offset_start + block.text.length;
                  return (
                    diagnostic.range.start >= block.str_offset_start &&
                    diagnostic.range.start < blockEnd
                  );
                }),
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
        for (const { block, cacheKey } of hitTargets) {
          const cached = blockDiagCache.get(cacheKey) ?? [];
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
        lastIncrementalScope = responseScope;
        lastSceneContentKey =
          responseScope === "scene"
            ? (currentSceneContentKey ?? sceneContentKey(blocks))
            : "";
        set((s) => ({
          rawDiagnostics: diagnosticListsEqual(
            s.rawDiagnostics,
            freshDiagnostics,
          )
            ? s.rawDiagnostics
            : freshDiagnostics,
          // Preserve identity when an edit leaves diagnostics unchanged.
          // useLinter subscribes to this exact slice; retaining the reference
          // avoids a redundant full-document decoration transaction.
          diagnostics: diagnosticListsEqual(s.diagnostics, filtered)
            ? s.diagnostics
            : filtered,
          lastSceneText: sceneText,
          warnings: mergeWarnings(s.warnings, freshWarnings),
          isLinting: false,
          lastErrorMessage: null,
        }));
        // Lint 完了を SR へ通知 (WCAG 4.1.3)。件数が変わったときだけ。
        if (filtered.length !== lastAnnouncedCount) {
          lastAnnouncedCount = filtered.length;
          announce(
            i18next.t("lint.a11y.completed", {
              count: filtered.length,
              defaultValue: "Lint が完了しました。指摘は {{count}} 件です",
            }),
          );
        }
        lastAnnouncedError = null;
      } catch (err) {
        if (get().pendingRequestId !== requestId) return;
        // Clear the block cache on error — stale entries could mask the root
        // cause on the next successful run.
        blockDiagCache = new Map();
        lastConfigKey = "";
        lastIncrementalScope = null;
        lastSceneContentKey = "";
        const message = formatLintError(err);
        set({
          rawDiagnostics: [],
          diagnostics: [],
          lastSceneText: "",
          isLinting: false,
          lastErrorMessage: message,
        });
        // エラーはパネル表示のみでトーストが出ないため SR へも通知する。
        if (message !== lastAnnouncedError) {
          lastAnnouncedError = message;
          announce(message, "assertive");
        }
        lastAnnouncedCount = null;
      }
    },
  };
});
