import type { GroupIndex } from "@/features/editor/tabStore";

export type EditorDocumentTarget =
  | { kind: "scene"; documentId: string }
  | { kind: "codex"; documentId: string; phaseId?: string | null }
  | { kind: "snippet"; documentId: string }
  | { kind: "chronicle-event"; documentId: string; label?: string };

export interface OpenEditorDocumentCommand {
  target: EditorDocumentTarget;
  group?: GroupIndex;
  mode: "preview" | "pinned";
  revealEditor: boolean;
  focusEditor: boolean;
  syncSceneContext: boolean;
  splitDirection?: "right" | "below";
}

export interface EditorNavigationPorts {
  tabs: {
    openPreview(documentId: string): void;
    openPinned(documentId: string): void;
    openCodexTab(documentId: string, phaseId?: string | null): void;
    openSnippetTab(documentId: string): void;
    openChronicleEventTab(documentId: string, label?: string): void;
    openInSecondaryGroup(documentId: string): void;
    openInSecondaryGroupDirectional(
      documentId: string,
      direction: "right" | "below",
    ): void;
    requestEditorFocus(group: GroupIndex): void;
  };
  layout: {
    showEditor(): void;
  };
  tree: {
    setActiveScene(documentId: string): void;
  };
  isNavigationBlocked?(): boolean;
}

function openScene(
  command: OpenEditorDocumentCommand,
  target: Extract<EditorDocumentTarget, { kind: "scene" }>,
  ports: EditorNavigationPorts,
): void {
  const group = command.group ?? 0;
  if (group === 1) {
    if (command.splitDirection) {
      ports.tabs.openInSecondaryGroupDirectional(
        target.documentId,
        command.splitDirection,
      );
    } else {
      ports.tabs.openInSecondaryGroup(target.documentId);
    }
  } else if (command.mode === "preview") {
    ports.tabs.openPreview(target.documentId);
  } else {
    ports.tabs.openPinned(target.documentId);
  }

  if (command.syncSceneContext) {
    ports.tree.setActiveScene(target.documentId);
  }
}

/**
 * The only application command that coordinates editor tabs, layout reveal,
 * and the tree's scene context. Feature stores remain independently usable,
 * while cross-feature navigation has one ordering and one pending-editor gate.
 */
export function openEditorDocument(
  command: OpenEditorDocumentCommand,
  ports: EditorNavigationPorts,
): void {
  if (ports.isNavigationBlocked?.()) return;

  switch (command.target.kind) {
    case "scene":
      openScene(command, command.target, ports);
      break;
    case "codex":
      ports.tabs.openCodexTab(
        command.target.documentId,
        command.target.phaseId,
      );
      break;
    case "snippet":
      ports.tabs.openSnippetTab(command.target.documentId);
      break;
    case "chronicle-event":
      ports.tabs.openChronicleEventTab(
        command.target.documentId,
        command.target.label,
      );
      break;
  }

  if (command.revealEditor) ports.layout.showEditor();
  if (command.focusEditor) {
    ports.tabs.requestEditorFocus(command.group ?? 0);
  }
}
