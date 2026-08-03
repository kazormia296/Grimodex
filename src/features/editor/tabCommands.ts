import { useTabStore } from "./tabStore";

/** Close every editor projection owned by one document. */
export function closeEditorDocumentTabs(documentId: string): void {
  const tabs = useTabStore.getState();
  tabs.closeTab(documentId);
  tabs.closeSecondaryTab(documentId);
}

/** Snapshot only the tab state needed by cross-feature conflict guards. */
export function activeEditorDocumentIds(): {
  isLinearMode: boolean;
  activeTabId: string | null;
  secondaryActiveTabId: string | null;
} {
  const tabs = useTabStore.getState();
  return {
    isLinearMode: tabs.isLinearMode,
    activeTabId: tabs.activeTabId,
    secondaryActiveTabId: tabs.secondaryActiveTabId,
  };
}
