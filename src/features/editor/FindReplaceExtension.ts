import { Extension, type RawCommands } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

export interface FindReplaceStorage {
  query: string;
  caseSensitive: boolean;
  useRegex: boolean;
  currentIndex: number;
  matches: Array<{ from: number; to: number }>;
  /** true when useRegex=true and the pattern is syntactically invalid */
  regexError: boolean;
}

const pluginKey = new PluginKey<DecorationSet>("findReplace");

type FindMatch = FindReplaceStorage["matches"][number];

interface FindReplacePluginMeta {
  matches: FindMatch[];
  currentIndex: number;
}

/**
 * Scroll the DOM element at the given ProseMirror position into view.
 *
 * Why: TipTap の `.scrollIntoView()` (= `tr.scrollIntoView()`) はエディタが
 * blur 状態（フォーカスは検索バー側）だと Editor の overflow:auto 親まで
 * 確実にスクロールが伝播しないため、DOM API で直接スクロールする。
 */
function scrollMatchIntoView(
  editor: import("@tiptap/core").Editor,
  pos: number,
): void {
  try {
    const { node } = editor.view.domAtPos(pos);
    const target: Element | null =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  } catch {
    // domAtPos can throw if pos is out of range after a doc edit; ignore.
  }
}

function buildMatches(
  doc: import("prosemirror-model").Node,
  query: string,
  caseSensitive: boolean,
  useRegex: boolean,
): { matches: Array<{ from: number; to: number }>; regexError: boolean } {
  if (!query) return { matches: [], regexError: false };

  const matches: Array<{ from: number; to: number }> = [];

  try {
    const flags = caseSensitive ? "g" : "gi";
    const pattern = useRegex
      ? query
      : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(pattern, flags);

    doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return;
      let match: RegExpExecArray | null;
      regex.lastIndex = 0;
      while ((match = regex.exec(node.text)) !== null) {
        if (match[0].length === 0) {
          regex.lastIndex++;
          continue;
        }
        matches.push({
          from: pos + match.index,
          to: pos + match.index + match[0].length,
        });
      }
    });
  } catch {
    // Invalid regex pattern
    return { matches: [], regexError: useRegex };
  }

  return { matches, regexError: false };
}

function buildDecorations(
  doc: import("prosemirror-model").Node,
  matches: ReadonlyArray<FindMatch>,
  currentIndex: number,
): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((match, index) =>
      Decoration.inline(match.from, match.to, {
        class: index === currentIndex ? "find-current" : "find-match",
      }),
    ),
  );
}

function resolveMappedCurrentIndex(
  transaction: Transaction,
  previousMatches: ReadonlyArray<FindMatch>,
  previousIndex: number,
  nextMatches: ReadonlyArray<FindMatch>,
): number {
  if (nextMatches.length === 0) return 0;
  const previousCurrent = previousMatches[previousIndex];
  if (!previousCurrent) {
    return Math.min(Math.max(previousIndex, 0), nextMatches.length - 1);
  }

  const mappedFrom = transaction.mapping.map(previousCurrent.from, 1);
  const exactIndex = nextMatches.findIndex(
    (match) => match.from === mappedFrom,
  );
  if (exactIndex >= 0) return exactIndex;

  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  nextMatches.forEach((match, index) => {
    const distance = Math.abs(match.from - mappedFrom);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  });
  return nearestIndex;
}

function replacesEntireDocument(transaction: Transaction): boolean {
  const firstStep = transaction.steps[0];
  if (!firstStep) return false;

  let replacesEntireContent = false;
  firstStep.getMap().forEach((oldStart, oldEnd) => {
    if (oldStart === 0 && oldEnd === transaction.before.content.size) {
      replacesEntireContent = true;
    }
  });
  return replacesEntireContent;
}

/**
 * FindReplaceExtension — C-7: Find & Replace for TipTap editor
 * Manages search state and ProseMirror decorations for match highlighting.
 */
export const FindReplaceExtension = Extension.create<
  object,
  FindReplaceStorage
>({
  name: "findReplace",

  addStorage() {
    return {
      query: "",
      caseSensitive: false,
      useRegex: false,
      currentIndex: 0,
      matches: [],
      regexError: false,
    };
  },

  addCommands() {
    return {
      setFindQuery:
        (query: string) =>
        ({ editor, dispatch, tr }) => {
          editor.storage.findReplace.query = query;
          editor.storage.findReplace.currentIndex = 0;
          const { matches, regexError } = buildMatches(
            tr.doc,
            query,
            editor.storage.findReplace.caseSensitive,
            editor.storage.findReplace.useRegex,
          );
          editor.storage.findReplace.matches = matches;
          editor.storage.findReplace.regexError = regexError;
          if (dispatch) {
            tr.setMeta(pluginKey, { matches, currentIndex: 0 });
            dispatch(tr);
          }
          if (matches.length > 0) {
            const first = matches[0];
            editor
              .chain()
              .setTextSelection({ from: first.from, to: first.to })
              .run();
            scrollMatchIntoView(editor, first.from);
          }
          return true;
        },

      setFindOptions:
        (
          opts: Partial<Pick<FindReplaceStorage, "caseSensitive" | "useRegex">>,
        ) =>
        ({ editor, dispatch, tr }) => {
          if (opts.caseSensitive !== undefined)
            editor.storage.findReplace.caseSensitive = opts.caseSensitive;
          if (opts.useRegex !== undefined)
            editor.storage.findReplace.useRegex = opts.useRegex;
          const { matches, regexError } = buildMatches(
            tr.doc,
            editor.storage.findReplace.query,
            editor.storage.findReplace.caseSensitive,
            editor.storage.findReplace.useRegex,
          );
          editor.storage.findReplace.matches = matches;
          editor.storage.findReplace.regexError = regexError;
          editor.storage.findReplace.currentIndex = 0;
          if (dispatch) {
            tr.setMeta(pluginKey, { matches, currentIndex: 0 });
            dispatch(tr);
          }
          return true;
        },

      findNext:
        () =>
        ({ editor, dispatch, tr }) => {
          const storage = editor.storage.findReplace as FindReplaceStorage;
          if (storage.matches.length === 0) return false;
          const nextIndex = (storage.currentIndex + 1) % storage.matches.length;
          storage.currentIndex = nextIndex;
          const match = storage.matches[nextIndex];
          if (dispatch) {
            tr.setMeta(pluginKey, {
              matches: storage.matches,
              currentIndex: nextIndex,
            });
            dispatch(tr);
          }
          editor
            .chain()
            .setTextSelection({ from: match.from, to: match.to })
            .run();
          scrollMatchIntoView(editor, match.from);
          return true;
        },

      findPrev:
        () =>
        ({ editor, dispatch, tr }) => {
          const storage = editor.storage.findReplace as FindReplaceStorage;
          if (storage.matches.length === 0) return false;
          const prevIndex =
            (storage.currentIndex - 1 + storage.matches.length) %
            storage.matches.length;
          storage.currentIndex = prevIndex;
          const match = storage.matches[prevIndex];
          if (dispatch) {
            tr.setMeta(pluginKey, {
              matches: storage.matches,
              currentIndex: prevIndex,
            });
            dispatch(tr);
          }
          editor
            .chain()
            .setTextSelection({ from: match.from, to: match.to })
            .run();
          scrollMatchIntoView(editor, match.from);
          return true;
        },

      replaceOne:
        (replacement: string) =>
        ({ editor, dispatch, tr }) => {
          const storage = editor.storage.findReplace as FindReplaceStorage;
          if (storage.matches.length === 0) return false;
          const match = storage.matches[storage.currentIndex];
          if (dispatch) {
            if (replacement) {
              tr.replaceWith(
                match.from,
                match.to,
                editor.schema.text(replacement),
              );
            } else {
              tr.delete(match.from, match.to);
            }
            // Rebuild matches after replacement
            const { matches: newMatches, regexError } = buildMatches(
              tr.doc,
              storage.query,
              storage.caseSensitive,
              storage.useRegex,
            );
            const newIndex = Math.min(
              storage.currentIndex,
              Math.max(newMatches.length - 1, 0),
            );
            storage.matches = newMatches;
            storage.regexError = regexError;
            storage.currentIndex = newIndex;
            tr.setMeta(pluginKey, {
              matches: newMatches,
              currentIndex: newIndex,
            });
            dispatch(tr);
          }
          return true;
        },

      replaceAll:
        (replacement: string) =>
        ({ editor, dispatch, tr }) => {
          const storage = editor.storage.findReplace as FindReplaceStorage;
          if (storage.matches.length === 0) return false;
          // Replace from end to start so positions don't shift
          const sorted = [...storage.matches].sort((a, b) => b.from - a.from);
          for (const match of sorted) {
            if (replacement) {
              tr.replaceWith(
                match.from,
                match.to,
                editor.schema.text(replacement),
              );
            } else {
              tr.delete(match.from, match.to);
            }
          }
          storage.matches = [];
          storage.currentIndex = 0;
          if (dispatch) {
            tr.setMeta(pluginKey, { matches: [], currentIndex: 0 });
            dispatch(tr);
          }
          return true;
        },

      clearFind:
        () =>
        ({ editor, dispatch, tr }) => {
          editor.storage.findReplace.query = "";
          editor.storage.findReplace.matches = [];
          editor.storage.findReplace.currentIndex = 0;
          editor.storage.findReplace.regexError = false;
          if (dispatch) {
            tr.setMeta(pluginKey, { matches: [], currentIndex: 0 });
            dispatch(tr);
          }
          return true;
        },
    } as Partial<RawCommands>;
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: pluginKey,
        state: {
          init(_config, state) {
            const storage = editor.storage.findReplace as FindReplaceStorage;
            const { matches, regexError } = buildMatches(
              state.doc,
              storage.query,
              storage.caseSensitive,
              storage.useRegex,
            );
            const currentIndex =
              matches.length === 0
                ? 0
                : Math.min(
                    Math.max(storage.currentIndex, 0),
                    matches.length - 1,
                  );
            storage.matches = matches;
            storage.currentIndex = currentIndex;
            storage.regexError = regexError;
            return buildDecorations(state.doc, matches, currentIndex);
          },
          apply(tr, old) {
            const meta = tr.getMeta(pluginKey) as
              | FindReplacePluginMeta
              | undefined;
            if (!meta && tr.docChanged) {
              const storage = editor.storage.findReplace as FindReplaceStorage;
              if (!storage.query) {
                storage.matches = [];
                storage.currentIndex = 0;
                storage.regexError = false;
                return DecorationSet.empty;
              }

              const previousMatches = storage.matches;
              const previousIndex = storage.currentIndex;
              const { matches, regexError } = buildMatches(
                tr.doc,
                storage.query,
                storage.caseSensitive,
                storage.useRegex,
              );
              // A fresh document has no semantic position corresponding to the
              // previous scene's current result, so start from its first hit.
              // Do not use preventUpdate as the signal: Inline AI rollback uses
              // the same meta for partial edits that must preserve navigation.
              const currentIndex = replacesEntireDocument(tr)
                ? 0
                : resolveMappedCurrentIndex(
                    tr,
                    previousMatches,
                    previousIndex,
                    matches,
                  );
              storage.matches = matches;
              storage.currentIndex = currentIndex;
              storage.regexError = regexError;
              return buildDecorations(tr.doc, matches, currentIndex);
            }
            if (!meta) return old.map(tr.mapping, tr.doc);
            const { matches, currentIndex } = meta;
            return buildDecorations(tr.doc, matches, currentIndex);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    findReplace: {
      setFindQuery: (query: string) => ReturnType;
      setFindOptions: (
        opts: Partial<Pick<FindReplaceStorage, "caseSensitive" | "useRegex">>,
      ) => ReturnType;
      findNext: () => ReturnType;
      findPrev: () => ReturnType;
      replaceOne: (replacement: string) => ReturnType;
      replaceAll: (replacement: string) => ReturnType;
      clearFind: () => ReturnType;
    };
  }
  interface Storage {
    findReplace: FindReplaceStorage;
  }
}
