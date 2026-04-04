import { Extension, type RawCommands } from "@tiptap/core";
import { Plugin, PluginKey } from "prosemirror-state";
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
          // Scroll match into view
          editor.commands.setTextSelection({ from: match.from, to: match.to });
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
          editor.commands.setTextSelection({ from: match.from, to: match.to });
          return true;
        },

      replaceOne:
        (replacement: string) =>
        ({ editor, dispatch, tr }) => {
          const storage = editor.storage.findReplace as FindReplaceStorage;
          if (storage.matches.length === 0) return false;
          const match = storage.matches[storage.currentIndex];
          if (dispatch) {
            tr.replaceWith(
              match.from,
              match.to,
              editor.schema.text(replacement),
            );
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
            tr.replaceWith(
              match.from,
              match.to,
              editor.schema.text(replacement),
            );
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
    return [
      new Plugin({
        key: pluginKey,
        state: {
          init() {
            return DecorationSet.empty;
          },
          apply(tr, old) {
            const meta = tr.getMeta(pluginKey) as
              | {
                  matches: Array<{ from: number; to: number }>;
                  currentIndex: number;
                }
              | undefined;
            if (!meta) return old.map(tr.mapping, tr.doc);
            const { matches, currentIndex } = meta;
            if (matches.length === 0) return DecorationSet.empty;
            const decorations = matches.map((m, i) =>
              Decoration.inline(m.from, m.to, {
                class: i === currentIndex ? "find-current" : "find-match",
              }),
            );
            return DecorationSet.create(tr.doc, decorations);
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
