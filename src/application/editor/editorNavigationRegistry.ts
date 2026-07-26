import type { OpenEditorDocumentCommand } from "./openEditorDocument";

type EditorDocumentOpener = (command: OpenEditorDocumentCommand) => void;

let editorDocumentOpener: EditorDocumentOpener | null = null;

/** Register the renderer composition adapter without importing feature stores. */
export function registerEditorDocumentOpener(
  opener: EditorDocumentOpener | null,
): void {
  editorDocumentOpener = opener;
}

/** Dispatch navigation requested by application workflows such as history redo. */
export function requestOpenEditorDocument(
  command: OpenEditorDocumentCommand,
): boolean {
  // Headless Store tests and non-renderer callers can replay history without
  // an Editor surface. Navigation is a best-effort UI side effect and must not
  // turn a successfully persisted redo into a failed command.
  if (!editorDocumentOpener) return false;
  editorDocumentOpener(command);
  return true;
}
