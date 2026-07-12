import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
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
}

type CodexCompletionMeta =
  | { type: "compositionStart" }
  | { type: "compositionEnd" }
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

function emptyState(composing = false): CodexCompletionState {
  return {
    candidate: null,
    prefixFrom: null,
    prefixTo: null,
    prefix: "",
    suffix: "",
    composing,
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

function computeState(
  state: EditorState,
  index: CodexCompletionIndex,
  composing: boolean,
  enabled: boolean,
): CodexCompletionState {
  if (composing || !enabled || !state.selection.empty) {
    return emptyState(composing);
  }

  const { $from } = state.selection;
  if (!canCompleteAt($from)) return emptyState(false);

  const match = findCodexCompletionMatch(
    $from.parent.textContent,
    $from.parentOffset,
    index,
  );
  if (!match) return emptyState(false);

  const blockStart = $from.start();
  return {
    candidate: match.candidate,
    prefixFrom: blockStart + match.from,
    prefixTo: blockStart + match.to,
    prefix: match.prefix,
    suffix: match.suffix,
    composing: false,
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

function applyMeta(
  oldState: CodexCompletionState,
  tr: Transaction,
  newState: EditorState,
  index: CodexCompletionIndex,
  enabled: boolean,
): CodexCompletionState {
  const meta = tr.getMeta(codexCompletionKey) as
    | CodexCompletionMeta
    | undefined;
  if (meta?.type === "compositionStart") return emptyState(true);
  if (meta?.type === "compositionEnd") return emptyState(false);
  if (meta?.type === "clear") return emptyState(oldState.composing);
  if (meta?.type === "refresh" || meta?.type === "recompute") {
    return computeState(newState, index, oldState.composing, enabled);
  }

  if (oldState.composing && tr.docChanged) return emptyState(true);
  if (tr.selectionSet && !tr.docChanged) return emptyState(oldState.composing);
  if (tr.docChanged) {
    return computeState(newState, index, oldState.composing, enabled);
  }
  return oldState;
}

export function createCodexCompletionPlugin(
  getIndex: () => CodexCompletionIndex,
  isEnabled: () => boolean = () => true,
): Plugin<CodexCompletionState> {
  return new Plugin<CodexCompletionState>({
    key: codexCompletionKey,
    state: {
      init: (_config, state) =>
        computeState(state, getIndex(), false, isEnabled()),
      apply: (tr, oldState, _oldEditorState, newEditorState) =>
        applyMeta(oldState, tr, newEditorState, getIndex(), isEnabled()),
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
        view.dispatch(
          view.state.tr
            .insertText(
              completion.candidate.surface,
              completion.prefixFrom,
              completion.prefixTo,
            )
            .scrollIntoView(),
        );
        return true;
      },
      handleDOMEvents: {
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
            view.state.tr.setMeta(codexCompletionKey, { type: "clear" }),
          );
          return false;
        },
      },
    },
  });
}
