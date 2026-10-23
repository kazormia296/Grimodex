/**
 * Whether the author still has unsaved edits on a Scene (CB-3, P2-3).
 *
 * A declaration covers the saved body and title. While the editor still holds
 * an edit that is not saved (the body autosave is debouncing, the title draft
 * is open, a synopsis save is pending), declaring would describe text that
 * differs from what the author sees, so the declare action waits. Nothing here
 * saves or flushes anything: it only reads the state that already exists.
 */
import { useSyncExternalStore } from "react";
import { hasPendingQuiescenceParticipantsForScopes } from "@/application/lifecycle/quiescenceParticipants";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import {
  hasPendingSynopsisSaveForNode,
  subscribePendingSynopsisSaves,
} from "@/features/editor/pendingSynopsisSaves";

/** A point-in-time read, used again at the moment the author presses declare. */
export function hasUnsavedSceneEdits(sceneId: string): boolean {
  if (useEditorSessionStore.getState().dirtyDocumentIds.has(sceneId)) {
    return true;
  }
  if (hasPendingSynopsisSaveForNode(sceneId)) return true;
  return hasPendingQuiescenceParticipantsForScopes([
    { kind: "tree-node", entityId: sceneId },
  ]);
}

export function useUnsavedSceneEdits(sceneId: string): boolean {
  const bodyDirty = useEditorSessionStore((state) =>
    state.dirtyDocumentIds.has(sceneId),
  );
  const synopsisPending = useSyncExternalStore(
    subscribePendingSynopsisSaves,
    () => hasPendingSynopsisSaveForNode(sceneId),
    () => false,
  );
  // Evaluated on every render of the panel; the press-time check covers the
  // drafts (such as the title) that do not announce their changes.
  const draftPending = hasPendingQuiescenceParticipantsForScopes([
    { kind: "tree-node", entityId: sceneId },
  ]);
  return bodyDirty || synopsisPending || draftPending;
}
