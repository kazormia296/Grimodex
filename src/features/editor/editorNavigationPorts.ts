import { useLayoutStore } from "@/features/layout/layoutStore";
import { useTabStore } from "@/features/editor/tabStore";
import { isInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import { useTreeStore } from "@/features/tree/treeStore";
import type { EditorNavigationPorts } from "@/application/editor/openEditorDocument";

/** Composition adapter: feature stores are wired here, outside the pure command. */
export const defaultEditorNavigationPorts: EditorNavigationPorts = {
  tabs: {
    openPreview: (documentId) => useTabStore.getState().openPreview(documentId),
    openPinned: (documentId) => useTabStore.getState().openPinned(documentId),
    openCodexTab: (documentId, phaseId) =>
      useTabStore.getState().openCodexTab(documentId, phaseId),
    openSnippetTab: (documentId) =>
      useTabStore.getState().openSnippetTab(documentId),
    openChronicleEventTab: (documentId, label) =>
      useTabStore.getState().openChronicleEventTab(documentId, label),
    openInSecondaryGroup: (documentId) =>
      useTabStore.getState().openInSecondaryGroup(documentId),
    openInSecondaryGroupDirectional: (documentId, direction) =>
      useTabStore
        .getState()
        .openInSecondaryGroupDirectional(documentId, direction),
    requestEditorFocus: (group) =>
      useTabStore.getState().requestEditorFocus(group),
  },
  layout: {
    showEditor: () => useLayoutStore.getState().showPanel("editor"),
  },
  tree: {
    setActiveScene: (documentId) =>
      useTreeStore.getState().setActiveScene(documentId),
  },
  isNavigationBlocked: isInlineAiPending,
};
