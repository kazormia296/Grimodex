import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Mark, ResolvedPos, Slice } from "@tiptap/pm/model";
import { ReplaceStep } from "@tiptap/pm/transform";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { markStart, markEnd } from "@/lib/perfLog";

interface PendingComposition {
  from: number;
  to: number;
  compositionId: number | null;
  originalSlice: Slice;
}

interface AiEditedPluginState {
  composing: boolean;
  pendingComposition: PendingComposition | null;
}

type AiEditedPluginMeta =
  | {
      type: "compositionStart";
      pendingComposition: PendingComposition | null;
    }
  | { type: "compositionEnd" }
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
    return !isInsideMarkedRun(state.selection.$from, mark);
  }
  return isSplittableAuthorshipMark(mark);
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
  let compositionEndTimer: ReturnType<typeof setTimeout> | null = null;

  return new Plugin({
    key: aiEditedKey,
    state: {
      init(): AiEditedPluginState {
        return {
          composing: false,
          pendingComposition: null,
        };
      },
      apply(transaction, pluginState): AiEditedPluginState {
        const meta = transaction.getMeta(aiEditedKey) as
          | AiEditedPluginMeta
          | undefined;

        if (meta?.type === "compositionStart") {
          return {
            composing: true,
            pendingComposition: meta.pendingComposition,
          };
        }
        if (meta?.type === "compositionFlushed") {
          return {
            composing: false,
            pendingComposition: null,
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
          if (compositionEndTimer !== null) {
            clearTimeout(compositionEndTimer);
            compositionEndTimer = null;
          }
        },
      };
    },
    props: {
      handleDOMEvents: {
        compositionstart(view) {
          if (compositionEndTimer !== null) {
            clearTimeout(compositionEndTimer);
            compositionEndTimer = null;
          }
          const { from, to } = view.state.selection;
          const pendingComposition = shouldTrackComposition(view.state)
            ? {
                from,
                to,
                compositionId: null,
                originalSlice: view.state.doc.slice(from, to),
              }
            : null;
          view.dispatch(
            view.state.tr.setMeta(aiEditedKey, {
              type: "compositionStart",
              pendingComposition,
            } satisfies AiEditedPluginMeta),
          );
          return false;
        },
        compositionend(view) {
          if (compositionEndTimer !== null) {
            clearTimeout(compositionEndTimer);
          }
          // ProseMirror may flush the final DOM mutation in a microtask after
          // compositionend. Use a macrotask so the tracked range includes it.
          compositionEndTimer = setTimeout(() => {
            compositionEndTimer = null;
            if (view.isDestroyed) return;
            const pluginState = aiEditedKey.getState(view.state);
            const transaction = view.state.tr.setMeta(aiEditedKey, {
              type: "compositionEnd",
            } satisfies AiEditedPluginMeta);
            if (pluginState?.pendingComposition?.compositionId != null) {
              transaction.setMeta(
                "composition",
                pluginState.pendingComposition.compositionId,
              );
            }
            view.dispatch(transaction);
          }, 0);
          return false;
        },
      },
    },
    appendTransaction(transactions, oldState, newState) {
      const pluginState = aiEditedKey.getState(newState);
      const compositionEnded = transactions.some((transaction) => {
        const meta = transaction.getMeta(aiEditedKey) as
          | AiEditedPluginMeta
          | undefined;
        return meta?.type === "compositionEnd";
      });

      if (compositionEnded) {
        const pending = pluginState?.pendingComposition;
        if (!pending) return null;

        const authorshipType = newState.schema.marks["authorship"];
        if (!authorshipType) return null;

        const docEnd = newState.doc.content.size;
        const from = Math.max(0, Math.min(pending.from, docEnd));
        const to = Math.max(from, Math.min(pending.to, docEnd));
        const transaction = newState.tr.setMeta(aiEditedKey, {
          type: "compositionFlushed",
        } satisfies AiEditedPluginMeta);
        const finalSlice = newState.doc.slice(from, to);
        const hasCommittedChange =
          pending.compositionId != null &&
          !finalSlice.eq(pending.originalSlice);
        if (hasCommittedChange && from < to) {
          transaction.removeMark(from, to, authorshipType);
        }
        if (pending.compositionId != null) {
          transaction.setMeta("composition", pending.compositionId);
        }
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
                return !isInsideMarkedRun($pos, m);
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
