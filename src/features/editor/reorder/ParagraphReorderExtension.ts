import { Extension, type Editor, type RawCommands } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import type { ReorderGranularity } from "./types";
import { resolveSelectionUnits } from "./selectionUnit";
import { getSelectionFlatRange } from "./reorderUnits";
import {
  buildAdjacentUnitSwapTransaction,
  buildParagraphReorderTransaction,
} from "./reorderTransaction";
import { flatRangeToPm, resolveParagraphAtSelection } from "./paragraphFlat";
import { flashUnitHighlight } from "./flashHighlight";
import {
  fetchBunsetsuUnits,
  getCachedBunsetsuUnits,
  isJapanese,
  prefetchBunsetsuUnits,
} from "./bunsetsuSegmenter";
import { captureSwapSnapshot, isSwapSnapshotValid } from "./paragraphSnapshot";
import { useReorderModifierStore } from "./reorderModifierStore";

/**
 * export される: ReorderInteractionExtension が同一 transaction 内で
 * 直接 tr.getMeta(reorderKey) を読むため（tiptap の ExtensionManager.plugins
 * は extensions 配列を reverse() してから plugin を積むので、拡張の登録順
 * とは無関係に reorderUiKey 側の apply() が reorderKey 側の apply() より
 * "先に" 呼ばれる。newState 経由でよそのプラグイン state を読むと、この
 * 順序次第で同一 transaction 内の変更を読み落とす — 詳細はコメント参照）。
 */
export const reorderKey = new PluginKey("paragraphReorder");

function isVerticalWriting(): boolean {
  return useSettingsStore.getState().getBoolean("editor.verticalMode", false);
}

function getGranularity(state: Editor["state"]): ReorderGranularity {
  return (
    (reorderKey.getState(state) as ReorderGranularity | undefined) ?? "sentence"
  );
}

/**
 * 有効粒度。文節指定でも非日本語なら文粒度へ落とす。
 * 装飾プラグイン(ReorderInteractionExtension)からも参照するため export。
 */
export function effectiveGranularity(
  state: EditorState,
  language: string | undefined,
): ReorderGranularity {
  const g = getGranularity(state);
  if (g === "bunsetsu" && !isJapanese(language)) return "sentence";
  if (g === "word" && isJapanese(language)) return "sentence";
  return g;
}

/** フッター表示用: エディタ plugin state の粒度を読む。 */
export function readReorderGranularity(state: EditorState): ReorderGranularity {
  return getGranularity(state);
}

function performUnitSwap(
  editor: Editor,
  dir: -1 | 1,
  granularity: ReorderGranularity,
  language: string | undefined,
): boolean {
  const bunsetsuUnits =
    granularity === "bunsetsu"
      ? getCachedBunsetsuUnits(editor.state, language)
      : null;

  const ctx = resolveSelectionUnits(
    editor.state,
    granularity,
    language,
    bunsetsuUnits,
  );
  if (!ctx) return false;

  const movedUnit = ctx.units[ctx.unitIndex]!;
  const oldPm = flatRangeToPm(ctx.resolved.flat, movedUnit.from, movedUnit.to);

  const ok =
    dir === -1
      ? editor.commands.swapUnitUpInner()
      : editor.commands.swapUnitDownInner();
  if (!ok) return false;

  const newCtx = resolveSelectionUnits(
    editor.state,
    granularity,
    language,
    granularity === "bunsetsu"
      ? getCachedBunsetsuUnits(editor.state, language)
      : null,
  );
  if (newCtx) {
    const newUnit = newCtx.units[newCtx.unitIndex]!;
    const newPm = flatRangeToPm(newCtx.resolved.flat, newUnit.from, newUnit.to);
    flashUnitHighlight(editor.view, newPm.from, newPm.to);
  } else {
    flashUnitHighlight(editor.view, oldPm.from, oldPm.to);
  }
  return true;
}

function swapWithFlash(editor: Editor, dir: -1 | 1): boolean {
  const language = getCurrentProjectLanguage();
  const granularity = effectiveGranularity(editor.state, language);

  if (granularity === "bunsetsu") {
    const bunsetsuUnits = getCachedBunsetsuUnits(editor.state, language);
    if (!bunsetsuUnits) {
      // 文節 cache miss 時は文粒度で即時 swap（カード UI と同じフォールバック）。
      // 並行して文節を prefetch し、次回以降は bunsetsu 粒度で swap できるようにする。
      if (performUnitSwap(editor, dir, "sentence", language)) {
        const resolved = resolveParagraphAtSelection(editor.state);
        if (resolved) void fetchBunsetsuUnits(resolved.flat.text);
        return true;
      }

      const resolved = resolveParagraphAtSelection(editor.state);
      if (!resolved) return false;
      const snapshot = captureSwapSnapshot(editor.state, resolved, dir);
      prefetchBunsetsuUnits(editor, snapshot, language, (validSnap) => {
        if (!isSwapSnapshotValid(editor.state, validSnap)) return;
        performUnitSwap(editor, validSnap.dir, "bunsetsu", language);
      });
      return false;
    }
  }

  return performUnitSwap(editor, dir, granularity, language);
}

export const ParagraphReorderExtension = Extension.create({
  name: "paragraphReorder",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: reorderKey,
        state: {
          init(): ReorderGranularity {
            return "sentence";
          },
          apply(tr, value) {
            const meta = tr.getMeta(reorderKey) as
              | { setGranularity?: ReorderGranularity }
              | undefined;
            if (meta?.setGranularity) return meta.setGranularity;
            return value;
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      swapUnitUpInner:
        () =>
        ({ state, tr, dispatch }) => {
          const language = getCurrentProjectLanguage();
          const granularity = effectiveGranularity(state, language);
          const bunsetsuUnits =
            granularity === "bunsetsu"
              ? getCachedBunsetsuUnits(state, language)
              : null;
          const ctx = resolveSelectionUnits(
            state,
            granularity,
            language,
            bunsetsuUnits,
          );
          if (!ctx) return false;
          const result = buildAdjacentUnitSwapTransaction(
            state,
            ctx.resolved,
            ctx.units,
            ctx.unitIndex,
            -1,
            tr,
            getSelectionFlatRange(state, ctx.resolved) ?? undefined,
            language,
            granularity,
          );
          if (!result) return false;
          if (dispatch) dispatch(result.tr);
          return true;
        },
      swapUnitDownInner:
        () =>
        ({ state, tr, dispatch }) => {
          const language = getCurrentProjectLanguage();
          const granularity = effectiveGranularity(state, language);
          const bunsetsuUnits =
            granularity === "bunsetsu"
              ? getCachedBunsetsuUnits(state, language)
              : null;
          const ctx = resolveSelectionUnits(
            state,
            granularity,
            language,
            bunsetsuUnits,
          );
          if (!ctx) return false;
          const result = buildAdjacentUnitSwapTransaction(
            state,
            ctx.resolved,
            ctx.units,
            ctx.unitIndex,
            1,
            tr,
            getSelectionFlatRange(state, ctx.resolved) ?? undefined,
            language,
            granularity,
          );
          if (!result) return false;
          if (dispatch) dispatch(result.tr);
          return true;
        },
      toggleReorderGranularity:
        () =>
        ({ state, tr, dispatch }) => {
          const language = getCurrentProjectLanguage();
          const current = getGranularity(state);
          let next: ReorderGranularity;
          if (isJapanese(language)) {
            next =
              current === "sentence"
                ? "bunsetsu"
                : current === "bunsetsu"
                  ? "character"
                  : "sentence";
          } else {
            next =
              current === "sentence"
                ? "word"
                : current === "word"
                  ? "character"
                  : "sentence";
          }
          if (!dispatch) return true;
          dispatch(tr.setMeta(reorderKey, { setGranularity: next }));
          useReorderModifierStore.getState().setGranularity(next);
          return true;
        },
      setReorderGranularity:
        (granularity: ReorderGranularity) =>
        ({ tr, dispatch }) => {
          if (!dispatch) return true;
          dispatch(tr.setMeta(reorderKey, { setGranularity: granularity }));
          useReorderModifierStore.getState().setGranularity(granularity);
          return true;
        },
      applyParagraphReorder:
        (order: number[]) =>
        ({ state, tr, dispatch }) => {
          const language = getCurrentProjectLanguage();
          const granularity = effectiveGranularity(state, language);
          const bunsetsuUnits =
            granularity === "bunsetsu"
              ? getCachedBunsetsuUnits(state, language)
              : null;
          const ctx = resolveSelectionUnits(
            state,
            granularity,
            language,
            bunsetsuUnits,
          );
          if (!ctx) return false;
          const result = buildParagraphReorderTransaction(
            state,
            ctx.resolved,
            ctx.units,
            order,
            ctx.caretFlatOffset,
            tr,
            undefined,
            language,
            granularity,
          );
          if (!result) return false;
          if (dispatch) dispatch(result.tr);
          return true;
        },
    } as Partial<RawCommands>;
  },

  addKeyboardShortcuts() {
    return {
      // 横書き: Alt+Shift+←/→、縦書き: Alt+Shift+↑/↓（段落移動 Alt+矢印とは軸を入れ替え）。
      "Alt-Shift-ArrowLeft": () =>
        !isVerticalWriting() && swapWithFlash(this.editor, -1),
      "Alt-Shift-ArrowRight": () =>
        !isVerticalWriting() && swapWithFlash(this.editor, 1),
      "Alt-Shift-ArrowUp": () =>
        isVerticalWriting() && swapWithFlash(this.editor, -1),
      "Alt-Shift-ArrowDown": () =>
        isVerticalWriting() && swapWithFlash(this.editor, 1),
      "Alt-Shift-g": () => this.editor.commands.toggleReorderGranularity(),
      "Alt-Shift-G": () => this.editor.commands.toggleReorderGranularity(),
    };
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    paragraphReorder: {
      swapUnitUpInner: () => ReturnType;
      swapUnitDownInner: () => ReturnType;
      toggleReorderGranularity: () => ReturnType;
      setReorderGranularity: (granularity: ReorderGranularity) => ReturnType;
      applyParagraphReorder: (order: number[]) => ReturnType;
    };
  }
}
