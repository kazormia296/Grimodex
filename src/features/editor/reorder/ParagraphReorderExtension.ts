import { Extension, type Editor, type RawCommands } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import type { ReorderGranularity } from "./types";
import { resolveSelectionUnits } from "./selectionUnit";
import {
  buildAdjacentUnitSwapTransaction,
  buildParagraphReorderTransaction,
} from "./reorderTransaction";
import { flatRangeToPm } from "./paragraphFlat";
import { flashUnitHighlight } from "./flashHighlight";
import {
  getCachedBunsetsuUnits,
  prefetchBunsetsuUnits,
} from "./bunsetsuSegmenter";

const reorderKey = new PluginKey("paragraphReorder");

function isVerticalWriting(): boolean {
  return useSettingsStore.getState().getBoolean("editor.verticalMode", false);
}

function getGranularity(state: Editor["state"]): ReorderGranularity {
  return (
    (reorderKey.getState(state) as ReorderGranularity | undefined) ?? "sentence"
  );
}

function swapWithFlash(editor: Editor, dir: -1 | 1): boolean {
  const language = getCurrentProjectLanguage();
  const granularity = getGranularity(editor.state);
  const bunsetsuUnits =
    granularity === "bunsetsu"
      ? getCachedBunsetsuUnits(editor.state, language)
      : null;

  if (granularity === "bunsetsu" && !bunsetsuUnits) {
    const ctx = resolveSelectionUnits(editor.state, "sentence", language);
    if (ctx) {
      prefetchBunsetsuUnits(editor, ctx.resolved.flat.text, language, () => {
        swapWithFlash(editor, dir);
      });
    }
    return true;
  }

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
          const granularity = getGranularity(state);
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
          );
          if (!result) return false;
          if (dispatch) dispatch(result.tr);
          return true;
        },
      swapUnitDownInner:
        () =>
        ({ state, tr, dispatch }) => {
          const language = getCurrentProjectLanguage();
          const granularity = getGranularity(state);
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
          );
          if (!result) return false;
          if (dispatch) dispatch(result.tr);
          return true;
        },
      toggleReorderGranularity:
        () =>
        ({ state, tr, dispatch }) => {
          const next =
            getGranularity(state) === "sentence" ? "bunsetsu" : "sentence";
          if (!dispatch) return true;
          dispatch(tr.setMeta(reorderKey, { setGranularity: next }));
          return true;
        },
      setReorderGranularity:
        (granularity: ReorderGranularity) =>
        ({ tr, dispatch }) => {
          if (!dispatch) return true;
          dispatch(tr.setMeta(reorderKey, { setGranularity: granularity }));
          return true;
        },
      applyParagraphReorder:
        (order: number[]) =>
        ({ state, tr, dispatch }) => {
          const language = getCurrentProjectLanguage();
          const granularity = getGranularity(state);
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
          );
          if (!result) return false;
          if (dispatch) dispatch(result.tr);
          return true;
        },
    } as Partial<RawCommands>;
  },

  addKeyboardShortcuts() {
    return {
      "Alt-Shift-ArrowUp": () =>
        !isVerticalWriting() && swapWithFlash(this.editor, -1),
      "Alt-Shift-ArrowDown": () =>
        !isVerticalWriting() && swapWithFlash(this.editor, 1),
      "Alt-Shift-ArrowRight": () =>
        isVerticalWriting() && swapWithFlash(this.editor, -1),
      "Alt-Shift-ArrowLeft": () =>
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
