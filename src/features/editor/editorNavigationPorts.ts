import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { registerEditorDocumentOpener } from "@/application/editor/editorNavigationRegistry";
import { isInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import { useTabStore } from "@/features/editor/tabStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useTreeStore } from "@/features/tree/treeStore";
import type { EditorNavigationPorts } from "@/application/editor/openEditorDocument";
import { isChatSceneTransitionBlocked } from "@/lib/chatNavigationGuard";

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
  isNavigationBlocked: (command) =>
    isInlineAiPending() ||
    (isChatSceneTransitionBlocked() &&
      !(
        command.target.kind === "scene" &&
        command.target.documentId === useTreeStore.getState().activeSceneId
      )),
};

/** Install the application-level navigation sink once from the renderer root. */
export function installDefaultEditorNavigation(): void {
  registerEditorDocumentOpener((command) =>
    openEditorDocument(command, defaultEditorNavigationPorts),
  );
}
