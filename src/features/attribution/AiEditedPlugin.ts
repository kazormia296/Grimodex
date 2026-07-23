import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type {
  Mark,
  Node as ProseMirrorNode,
  ResolvedPos,
  Slice,
} from "@tiptap/pm/model";
import { ReplaceStep } from "@tiptap/pm/transform";
import { isHistoryTransaction } from "@tiptap/pm/history";
import type { EditorView } from "@tiptap/pm/view";
import { markStart, markEnd } from "@/lib/perfLog";

type CompositionTerminalIntent = "commit" | "unknown";

interface PendingComposition {
  from: number;
  to: number;
  compositionId: number;
  originalSlice: Slice;
}

interface AiEditedPluginState {
  composing: boolean;
  pendingComposition: PendingComposition | null;
}

type AiEditedPluginMeta =
  | {
      type: "compositionEnd";
      terminalIntent: CompositionTerminalIntent;
    }
  | { type: "compositionFlushed" };

export const aiEditedKey = new PluginKey<AiEditedPluginState>("aiEdited");

/**
 * Sources that trigger node splitting when the user inserts text mid-span.
 */
const SPLITTABLE_SOURCES = new Set(["ai", "unknown"]);

function isSplittableAuthorshipMark(mark: Mark): boolean {
  return (
    mark.type.name === "authorship" &&
    SPLITTABLE_SOURCES.has(mark.attrs.source as string) &&
    !mark.attrs.manualOverride
  );
}

function isInsideMarkedRun($pos: ResolvedPos, mark: Mark): boolean {
  const hasMarkBefore =
    $pos.nodeBefore?.marks.some((candidate) => candidate.eq(mark)) ?? false;
  const hasMarkAfter =
    $pos.nodeAfter?.marks.some((candidate) => candidate.eq(mark)) ?? false;
  return hasMarkBefore && hasMarkAfter;
}

function isRangeFullyCoveredByExactMark(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  mark: Mark,
): boolean {
  if (from >= to) return false;

  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if (!$from.sameParent($to) || !$from.parent.inlineContent) return false;

  let coveredInlineContent = false;
  let hasOnlyExactMark = true;
  $from.parent.nodesBetween($from.parentOffset, $to.parentOffset, (node) => {
    if (!node.isInline) return;
    coveredInlineContent = true;
    if (!node.marks.some((candidate) => candidate.eq(mark))) {
      hasOnlyExactMark = false;
    }
  });
  return coveredInlineContent && hasOnlyExactMark;
}

function inheritedAuthorshipMark(state: EditorState): Mark | undefined {
  const { selection, storedMarks } = state;
  const marks =
    storedMarks ??
    (selection.empty
      ? selection.$from.marks()
      : (selection.$from.marksAcross(selection.$to) ?? []));
  return marks.find((mark) => mark.type.name === "authorship");
}

function shouldTrackComposition(state: EditorState): boolean {
  const mark = inheritedAuthorshipMark(state);
  if (!mark) return false;
  if (mark.attrs.manualOverride) {
    const { selection } = state;
    return selection.empty
      ? !isInsideMarkedRun(selection.$from, mark)
      : !isRangeFullyCoveredByExactMark(
          state.doc,
          selection.from,
          selection.to,
          mark,
        );
  }
  return isSplittableAuthorshipMark(mark);
}

function createPendingComposition(
  state: EditorState,
  compositionId: number,
): PendingComposition | null {
  if (!shouldTrackComposition(state)) return null;
  const { from, to } = state.selection;
  return {
    from,
    to,
    compositionId,
    originalSlice: state.doc.slice(from, to),
  };
}

function mapPendingComposition(
  pending: PendingComposition | null,
  transaction: Transaction,
): PendingComposition | null {
  if (!pending || !transaction.docChanged) return pending;

  const mappedFrom = transaction.mapping.map(pending.from, -1);
  const mappedTo = transaction.mapping.map(pending.to, 1);
  const compositionMeta = transaction.getMeta("composition");
  return {
    from: Math.min(mappedFrom, mappedTo),
    to: Math.max(mappedFrom, mappedTo),
    compositionId:
      typeof compositionMeta === "number"
        ? compositionMeta
        : pending.compositionId,
    originalSlice: pending.originalSlice,
  };
}

/**
 * ProseMirror plugin that splits authorship marks when the user inserts
 * text within an AI or unknown-attributed range.
 *
 * When a user types inside a marked span, the inserted characters become
 * separate unmarked (human) text nodes while the original flanking text
 * retains its mark unchanged.
 *
 * Detection: inspects each transaction's ReplaceStep to find pure
 * insertions (from === to) or replacements (from !== to with content)
 * that land inside a splittable span, then strips the authorship mark
 * from the inserted range via tr.removeMark().
 *
 * Native IME composition is special: changing marks around the preedit DOM
 * node can corrupt Chromium's replacement range. While composing, inherited
 * attribution is kept intact. The final committed range is stripped only
 * after ProseMirror has flushed compositionend.
 */
export function createAiEditedPlugin(): Plugin {
  let compositionSessionArmed = false;
  let lastCompositionData: string | null = null;
  let scheduledCompositionEnd: {
    token: number;
    terminalIntent: CompositionTerminalIntent;
  } | null = null;
  let compositionEndToken = 0;

  function eventData(event: Event): string | null {
    const data = (event as CompositionEvent | InputEvent).data;
    return typeof data === "string" ? data : null;
  }

  function terminalIntentFor(event: Event): CompositionTerminalIntent {
    const finalData = eventData(event);
    if (finalData !== null && finalData.length > 0) return "commit";
    // Empty data is ambiguous: it can represent cancellation, a committed
    // deletion, or an IME that does not disclose its committed text. Fall back
    // to the last non-empty payload only when the terminal event exposes no
    // data property at all, then let the final Slice resolve the other cases.
    if (
      finalData === null &&
      lastCompositionData !== null &&
      lastCompositionData.length > 0
    ) {
      return "commit";
    }
    return "unknown";
  }

  function flushCompositionEnd(
    view: EditorView,
    terminalIntent: CompositionTerminalIntent,
  ) {
    scheduledCompositionEnd = null;
    compositionSessionArmed = false;
    lastCompositionData = null;
    if (view.isDestroyed) return;

    const pluginState = aiEditedKey.getState(view.state);
    if (!pluginState?.composing && !pluginState?.pendingComposition) return;

    const transaction = view.state.tr.setMeta(aiEditedKey, {
      type: "compositionEnd",
      terminalIntent,
    } satisfies AiEditedPluginMeta);
    if (pluginState.pendingComposition) {
      transaction.setMeta(
        "composition",
        pluginState.pendingComposition.compositionId,
      );
    }
    view.dispatch(transaction);
  }

  return new Plugin({
    key: aiEditedKey,
    state: {
      init(): AiEditedPluginState {
        return {
          composing: false,
          pendingComposition: null,
        };
      },
      apply(transaction, pluginState, oldState): AiEditedPluginState {
        const meta = transaction.getMeta(aiEditedKey) as
          | AiEditedPluginMeta
          | undefined;

        if (meta?.type === "compositionFlushed") {
          return {
            composing: false,
            pendingComposition: null,
          };
        }

        const compositionMeta = transaction.getMeta("composition");
        if (
          compositionSessionArmed &&
          typeof compositionMeta === "number" &&
          !pluginState.composing
        ) {
          const captured = createPendingComposition(oldState, compositionMeta);
          return {
            composing: true,
            pendingComposition: mapPendingComposition(captured, transaction),
          };
        }

        const pendingComposition = mapPendingComposition(
          pluginState.pendingComposition,
          transaction,
        );
        if (meta?.type === "compositionEnd") {
          return {
            composing: false,
            pendingComposition,
          };
        }
        return {
          composing: pluginState.composing,
          pendingComposition,
        };
      },
    },
    view() {
      return {
        destroy() {
          compositionEndToken++;
          scheduledCompositionEnd = null;
          compositionSessionArmed = false;
          lastCompositionData = null;
        },
      };
    },
    props: {
      handleDOMEvents: {
        compositionstart(view) {
          if (scheduledCompositionEnd) {
            const { terminalIntent } = scheduledCompositionEnd;
            compositionEndToken++;
            flushCompositionEnd(view, terminalIntent);
          }
          // ProseMirror's built-in compositionstart handler flushes the DOM
          // observer after custom handlers run. Arm the session here, then
          // capture oldState from the first transaction carrying its
          // composition ID so the snapshot is post-flush.
          compositionSessionArmed = true;
          lastCompositionData = null;
          return false;
        },
        compositionupdate(_view, event) {
          if (compositionSessionArmed) {
            lastCompositionData = eventData(event);
          }
          return false;
        },
        beforeinput(_view, event) {
          const inputEvent = event as InputEvent;
          if (
            compositionSessionArmed &&
            inputEvent.inputType === "insertCompositionText"
          ) {
            lastCompositionData = eventData(event);
          }
          return false;
        },
        compositionend(view, event) {
          const terminalIntent = terminalIntentFor(event);
          const token = ++compositionEndToken;
          scheduledCompositionEnd = { token, terminalIntent };

          // Custom handlers run before ProseMirror's built-in handler. The
          // first microtask lets that handler enqueue its pending DOM flush;
          // the second runs after the flush transaction has been dispatched.
          queueMicrotask(() => {
            queueMicrotask(() => {
              if (scheduledCompositionEnd?.token !== token) return;
              flushCompositionEnd(view, terminalIntent);
            });
          });
          return false;
        },
      },
    },
    appendTransaction(transactions, oldState, newState) {
      const pluginState = aiEditedKey.getState(newState);
      const compositionEndMeta = transactions
        .map((transaction) => {
          return transaction.getMeta(aiEditedKey) as
            | AiEditedPluginMeta
            | undefined;
        })
        .find((meta) => meta?.type === "compositionEnd");

      if (compositionEndMeta?.type === "compositionEnd") {
        const pending = pluginState?.pendingComposition;
        if (!pending) return null;

        const docEnd = newState.doc.content.size;
        const from = Math.max(0, Math.min(pending.from, docEnd));
        const to = Math.max(from, Math.min(pending.to, docEnd));
        const transaction = newState.tr.setMeta(aiEditedKey, {
          type: "compositionFlushed",
        } satisfies AiEditedPluginMeta);
        const finalSlice = newState.doc.slice(from, to);
        // Empty composition data is only a cancellation hint. Some IMEs expose
        // empty data even though they committed a replacement, so an actual
        // range change must still be treated as human-authored content.
        const shouldCleanup =
          compositionEndMeta.terminalIntent === "commit" ||
          !finalSlice.eq(pending.originalSlice);

        const authorshipType = newState.schema.marks["authorship"];
        if (shouldCleanup && authorshipType && from < to) {
          transaction.removeMark(from, to, authorshipType);
        }
        transaction.setMeta("composition", pending.compositionId);
        return transaction;
      }

      const docChanged = transactions.some((tr) => tr.docChanged);
      if (!docChanged) return null;
      if (pluginState?.composing) return null;
      // Undo/redo replays content verbatim from the history stack — the
      // split/no-split decision was already made at original-edit time.
      // Re-running the splitter here would strip ai/unknown marks from
      // re-inserted text (e.g. delete a mid-span char then Ctrl+Z restores it
      // as "human"). Skip history transactions. isHistoryTransaction matches by
      // prosemirror-history's own PluginKey (robust vs the "history$" string).
      if (transactions.some((tr) => isHistoryTransaction(tr))) return null;
      markStart("plugin.aiEdited.appendTransaction");
      try {
        // Skip programmatic inserts (chat/snippet insertion)
        const hasProgrammatic = transactions.some(
          (tr) => tr.getMeta("programmaticInsert") === true,
        );
        if (hasProgrammatic) return null;

        const { schema, tr } = newState;
        const authorshipType = schema.marks["authorship"];
        if (!authorshipType) return null;

        let changed = false;

        for (const transaction of transactions) {
          if (transaction.getMeta("programmaticInsert") === true) continue;

          const steps = transaction.steps;
          for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (!(step instanceof ReplaceStep)) continue;

            const { from, to } = step;
            const insertedSize = step.slice.size;
            if (insertedSize === 0) continue;

            // Resolve the marks that ProseMirror actually inherits for this
            // insertion/replacement in the document immediately before the step.
            let mark = null;
            const stepDoc = transaction.docs[i] ?? oldState.doc;
            if (from < stepDoc.content.size) {
              const $pos = stepDoc.resolve(from);
              const inheritedMarks =
                from === to
                  ? $pos.marks()
                  : ($pos.marksAcross(stepDoc.resolve(to)) ?? []);
              mark = inheritedMarks.find((m) => {
                if (m.type !== authorshipType) return false;
                if (!m.attrs.manualOverride) {
                  return SPLITTABLE_SOURCES.has(m.attrs.source as string);
                }
                return from === to
                  ? !isInsideMarkedRun($pos, m)
                  : !isRangeFullyCoveredByExactMark(stepDoc, from, to, m);
              });
            }

            if (mark) {
              // Map the insertion range to newState coordinates
              // For multi-step transactions, map through subsequent steps
              let newFrom = from;
              let newTo = from + insertedSize;
              for (let j = i + 1; j < steps.length; j++) {
                const map = steps[j].getMap();
                newFrom = map.map(newFrom, -1);
                newTo = map.map(newTo, 1);
              }

              tr.removeMark(newFrom, newTo, authorshipType);
              changed = true;
            }
          }
        }

        return changed ? tr : null;
      } finally {
        markEnd("plugin.aiEdited.appendTransaction");
      }
    },
  });
}
