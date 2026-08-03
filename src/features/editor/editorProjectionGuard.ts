import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

export interface EditorProjectionRef {
  current: boolean;
}

/**
 * Reject document-changing transactions while a reused editor is between
 * projections. `onUpdate` is too late: ProseMirror has already applied the
 * transaction by then, so ignoring the callback can either lose the input on
 * the next load or save it under the previous document binding.
 *
 * Hydration/external synchronization is explicitly allowed through the
 * synchronous update scope. `preventUpdate` is TipTap's marker for
 * `setContent(..., { emitUpdate: false })`, which is also a non-user load
 * path. Selection-only transactions remain allowed while the projection is
 * unavailable.
 */
export function shouldAllowEditorProjectionTransaction(
  transaction: { docChanged: boolean; getMeta: (key: string) => unknown },
  projectionReady: EditorProjectionRef,
  programmaticUpdate: EditorProjectionRef,
  writeAuthority: EditorProjectionRef = projectionReady,
): boolean {
  if (!transaction.docChanged) return true;
  if (writeAuthority.current || programmaticUpdate.current) return true;
  return transaction.getMeta("preventUpdate") === true;
}

export function createEditorProjectionGuardExtension(
  projectionReady: EditorProjectionRef,
  programmaticUpdate: EditorProjectionRef,
  writeAuthority: EditorProjectionRef = projectionReady,
): Extension {
  return Extension.create({
    name: "editorProjectionGuard",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          filterTransaction: (transaction) =>
            shouldAllowEditorProjectionTransaction(
              transaction,
              projectionReady,
              programmaticUpdate,
              writeAuthority,
            ),
        }),
      ];
    },
  });
}
