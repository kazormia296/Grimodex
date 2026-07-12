import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import type { ResolvedPos } from "@tiptap/pm/model";
import type {
  CodexCompletionCandidate,
  CodexCompletionIndex,
} from "./codexCompletionIndex";
import { findCodexCompletionMatch } from "./codexCompletionMatch";

export interface CodexCompletionState {
  candidate: CodexCompletionCandidate | null;
  prefixFrom: number | null;
  prefixTo: number | null;
  prefix: string;
  suffix: string;
  composing: boolean;
  focused: boolean;
  activeInput: boolean;
}

type CodexCompletionMeta =
  | { type: "compositionStart" }
  | { type: "compositionEnd" }
  | { type: "focus" }
  | { type: "blur" }
  | { type: "clear" }
  | { type: "refresh" }
  | { type: "recompute" };

export const codexCompletionKey = new PluginKey<CodexCompletionState>(
  "codexCompletion",
);

const BLOCKED_ANCESTORS = new Set([
  "codeBlock",
  "code",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "listItem",
]);

function emptyState(
  composing = false,
  focused = false,
  activeInput = false,
): CodexCompletionState {
  return {
    candidate: null,
    prefixFrom: null,
    prefixTo: null,
    prefix: "",
    suffix: "",
    composing,
    focused,
    activeInput,
  };
}

function hasBlockedAncestor($from: ResolvedPos): boolean {
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    if (BLOCKED_ANCESTORS.has($from.node(depth).type.name)) return true;
  }
  return false;
}

function canCompleteAt($from: ResolvedPos): boolean {
  if (!$from.parent.isTextblock || hasBlockedAncestor($from)) return false;
  // Ruby, mention, image, and other atom boundaries are intentionally not
  // guessed around. The user can move one character away and type normally.
  if (
    ($from.nodeBefore && !$from.nodeBefore.isText && $from.nodeBefore.isAtom) ||
    ($from.nodeAfter && !$from.nodeAfter.isText && $from.nodeAfter.isAtom)
  ) {
    return false;
  }
  return true;
}

interface TextblockPrefix {
  text: string;
  /** UTF-16 text offset → absolute ProseMirror position. */
  positions: number[];
}

/**
 * `Node.textContent` omits inline atoms while ProseMirror positions count each
 * atom as one offset. Preserve those boundaries with a sentinel and retain an
 * explicit text-offset → document-position mapping.
 */
function textblockPrefix($from: ResolvedPos): TextblockPrefix {
  const blockStart = $from.start();
  let text = "";
  const positions: number[] = [];

  $from.parent.forEach((node, offset) => {
    if (offset >= $from.parentOffset) return;
    if (node.isText && node.text) {
      const length = Math.min(node.text.length, $from.parentOffset - offset);
      text += node.text.slice(0, length);
      for (let index = 0; index < length; index += 1) {
        positions.push(blockStart + offset + index);
      }
      return;
    }
    if (node.isInline) {
      text += "\uFFFC";
      positions.push(blockStart + offset);
    }
  });

  return { text, positions };
}

function computeState(
  state: EditorState,
  index: CodexCompletionIndex,
  composing: boolean,
  focused: boolean,
  activeInput: boolean,
  enabled: boolean,
): CodexCompletionState {
  if (
    composing ||
    !focused ||
    !activeInput ||
    !enabled ||
    !state.selection.empty
  ) {
    return emptyState(composing, focused, activeInput);
  }

  const { $from } = state.selection;
  if (!canCompleteAt($from)) return emptyState(false, focused, activeInput);

  const prefix = textblockPrefix($from);

  const match = findCodexCompletionMatch(
    prefix.text,
    prefix.text.length,
    index,
  );
  if (!match) return emptyState(false, focused, activeInput);

  const prefixFrom = prefix.positions[match.from];
  if (prefixFrom == null) return emptyState(false, focused, activeInput);
  return {
    candidate: match.candidate,
    prefixFrom,
    prefixTo: $from.pos,
    prefix: match.prefix,
    suffix: match.suffix,
    composing: false,
    focused,
    activeInput,
  };
}

function buildGhostWidget(suffix: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "codex-completion-ghost";
  span.setAttribute("aria-hidden", "true");
  span.setAttribute("contenteditable", "false");
  span.textContent = suffix;
  return span;
}

function scheduleRecompute(view: EditorView): void {
  const recompute = () => {
    if (view.isDestroyed) return;
    view.dispatch(
      view.state.tr.setMeta(codexCompletionKey, { type: "recompute" }),
    );
  };
  if (typeof window !== "undefined" && window.requestAnimationFrame) {
    window.requestAnimationFrame(recompute);
  } else {
    Promise.resolve().then(recompute);
  }
}

function isModifierPressed(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;
}

function isProgrammaticOrBulkTransaction(tr: Transaction): boolean {
  const uiEvent = tr.getMeta("uiEvent");
  return (
    isHistoryTransaction(tr) ||
    tr.getMeta("history$") !== undefined ||
    tr.getMeta("paste") !== undefined ||
    uiEvent === "paste" ||
    uiEvent === "drop" ||
    uiEvent === "cut" ||
    tr.getMeta("programmaticInsert") === true ||
    tr.getMeta("preventUpdate") !== undefined ||
    tr.getMeta("addToHistory") === false
  );
}

function isDirectTextInput(
  tr: Transaction,
  oldEditorState: EditorState,
  newEditorState: EditorState,
): boolean {
  return (
    !isProgrammaticOrBulkTransaction(tr) &&
    oldEditorState.doc.textContent !== newEditorState.doc.textContent
  );
}

function applyMeta(
  oldState: CodexCompletionState,
  tr: Transaction,
  oldEditorState: EditorState,
  newState: EditorState,
  index: CodexCompletionIndex,
  enabled: boolean,
): CodexCompletionState {
  const meta = tr.getMeta(codexCompletionKey) as
    | CodexCompletionMeta
    | undefined;
  if (meta?.type === "compositionStart") {
    return emptyState(true, oldState.focused, false);
  }
  if (meta?.type === "compositionEnd") {
    return emptyState(false, oldState.focused, oldState.focused);
  }
  if (meta?.type === "focus") return emptyState(false, true, false);
  if (meta?.type === "blur") return emptyState(false, false, false);
  if (meta?.type === "clear") {
    return emptyState(oldState.composing, oldState.focused, false);
  }
  if (meta?.type === "refresh" || meta?.type === "recompute") {
    return computeState(
      newState,
      index,
      oldState.composing,
      oldState.focused,
      oldState.activeInput,
      enabled,
    );
  }

  if (oldState.composing && tr.docChanged) {
    return emptyState(true, oldState.focused, false);
  }
  if (isProgrammaticOrBulkTransaction(tr)) {
    return emptyState(oldState.composing, oldState.focused, false);
  }
  if (tr.selectionSet && !tr.docChanged) {
    return emptyState(oldState.composing, oldState.focused, false);
  }
  if (tr.docChanged) {
    // Authorship and similar append-transactions may only change marks after a
    // direct keystroke. They keep both text and positions stable, so preserve
    // the candidate produced by the originating text transaction.
    if (
      oldEditorState.doc.textContent === newState.doc.textContent &&
      oldEditorState.doc.content.size === newState.doc.content.size
    ) {
      return oldState;
    }
    if (!oldState.focused || !isDirectTextInput(tr, oldEditorState, newState)) {
      return emptyState(oldState.composing, oldState.focused, false);
    }
    return computeState(
      newState,
      index,
      oldState.composing,
      oldState.focused,
      true,
      enabled,
    );
  }
  return oldState;
}

export function createCodexCompletionPlugin(
  getIndex: () => CodexCompletionIndex,
  isEnabled: () => boolean = () => true,
  isFocused: () => boolean = () => false,
): Plugin<CodexCompletionState> {
  return new Plugin<CodexCompletionState>({
    key: codexCompletionKey,
    state: {
      init: () => emptyState(false, isFocused(), false),
      apply: (tr, oldState, oldEditorState, newEditorState) =>
        applyMeta(
          oldState,
          tr,
          oldEditorState,
          newEditorState,
          getIndex(),
          isEnabled(),
        ),
    },
    props: {
      decorations(state) {
        const completion = codexCompletionKey.getState(state);
        if (
          !completion?.candidate ||
          completion.prefixTo == null ||
          completion.suffix.length === 0
        ) {
          return null;
        }
        return DecorationSet.create(state.doc, [
          Decoration.widget(
            completion.prefixTo,
            () => buildGhostWidget(completion.suffix),
            {
              side: 1,
              key: `${completion.candidate.entryId}:${completion.candidate.surface}`,
            },
          ),
        ]);
      },
      handleKeyDown(view, event) {
        const completion = codexCompletionKey.getState(view.state);
        if (!completion || event.isComposing || completion.composing) {
          return false;
        }
        if (event.key === "Escape" && !isModifierPressed(event)) {
          if (!completion.candidate) return false;
          event.preventDefault();
          view.dispatch(
            view.state.tr.setMeta(codexCompletionKey, { type: "clear" }),
          );
          return true;
        }
        if (
          event.key !== "Tab" ||
          isModifierPressed(event) ||
          !completion.candidate ||
          !view.editable ||
          completion.prefixFrom == null ||
          completion.prefixTo == null ||
          !view.state.selection.empty ||
          view.state.selection.from !== completion.prefixTo
        ) {
          return false;
        }

        event.preventDefault();
        const tr = closeHistory(view.state.tr).insertText(
          completion.candidate.surface,
          completion.prefixFrom,
          completion.prefixTo,
        );
        view.dispatch(tr.scrollIntoView());
        return true;
      },
      handleDOMEvents: {
        focus(view) {
          view.dispatch(
            view.state.tr.setMeta(codexCompletionKey, { type: "focus" }),
          );
          return false;
        },
        compositionstart(view) {
          view.dispatch(
            view.state.tr.setMeta(codexCompletionKey, {
              type: "compositionStart",
            }),
          );
          return false;
        },
        compositionend(view) {
          view.dispatch(
            view.state.tr.setMeta(codexCompletionKey, {
              type: "compositionEnd",
            }),
          );
          scheduleRecompute(view);
          return false;
        },
        blur(view) {
          view.dispatch(
            view.state.tr.setMeta(codexCompletionKey, { type: "blur" }),
          );
          return false;
        },
      },
    },
  });
}
