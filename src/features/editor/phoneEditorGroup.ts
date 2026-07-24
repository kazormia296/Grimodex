import type { GroupIndex } from "./tabStore";

export interface PhoneEditorGroupState {
  activeTabId: string | null;
  secondaryActiveTabId: string | null;
  secondaryGroupOpen: boolean;
  activeGroupIndex: GroupIndex;
}

/**
 * Reuse the group that already owns a document whenever possible. This keeps a
 * hidden dirty editor mounted as the live source of truth instead of loading a
 * second EditorPane for the same document from an older persisted snapshot.
 */
export function resolvePhoneEditorGroup(
  state: PhoneEditorGroupState,
  documentId?: string | null,
  preferredGroup?: GroupIndex | null,
): GroupIndex {
  const fallback: GroupIndex =
    state.secondaryGroupOpen && state.activeGroupIndex === 1 ? 1 : 0;
  if (preferredGroup === 0) return 0;
  if (preferredGroup === 1 && state.secondaryGroupOpen) return 1;
  if (!documentId) return fallback;

  const inPrimary = state.activeTabId === documentId;
  const inSecondary =
    state.secondaryGroupOpen && state.secondaryActiveTabId === documentId;
  if (inPrimary !== inSecondary) return inPrimary ? 0 : 1;
  return fallback;
}
