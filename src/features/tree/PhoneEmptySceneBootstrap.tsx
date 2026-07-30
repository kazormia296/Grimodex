import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@/features/chat/chatStore";
import { resolvePhoneEditorGroup } from "@/features/editor/phoneEditorGroup";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useCompactNavigationStore } from "@/features/layout/adaptive/compactNavigationStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useTreeStore, type TreeNodeData } from "./treeStore";

const initialSceneCreations = new Map<string, Promise<TreeNodeData | null>>();

function createInitialSceneOnce(
  scopeKey: string,
  createNode: ReturnType<typeof useTreeStore.getState>["createNode"],
): Promise<TreeNodeData | null> {
  const existing = initialSceneCreations.get(scopeKey);
  if (existing) return existing;

  const operation = createNode({
    nodeType: "scene",
    parentId: null,
    interaction: "implicit",
  });
  initialSceneCreations.set(scopeKey, operation);
  void operation
    .finally(() => {
      if (initialSceneCreations.get(scopeKey) === operation) {
        initialSceneCreations.delete(scopeKey);
      }
    })
    .catch(() => undefined);
  return operation;
}

/**
 * Phone-only empty editor state. Once tree hydration has completed, select an
 * existing document or create the first scene exactly once and hand focus to
 * the editor. The in-flight map prevents React StrictMode remounts from
 * creating duplicate scenes.
 */
export function PhoneEmptySceneBootstrap() {
  const { t } = useTranslation();
  const nodes = useTreeStore((state) => state.nodes);
  const isLoading = useTreeStore((state) => state.isLoading);
  const projectId = useTreeStore((state) => state.projectId);
  const hydratedProjectId = useTreeStore((state) => state.hydratedProjectId);
  const hydratedWorkspaceOpenRevision = useTreeStore(
    (state) => state.hydratedWorkspaceOpenRevision,
  );
  const createNode = useTreeStore((state) => state.createNode);
  const setActiveScene = useTreeStore((state) => state.setActiveScene);
  const workspacePath = useWorkspaceStore((state) => state.activeWorkspacePath);
  const workspaceOpenRevision = useWorkspaceStore(
    (state) => state.workspaceOpenRevision,
  );
  const [failed, setFailed] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const scopeKey = useMemo(
    () => JSON.stringify([workspacePath, workspaceOpenRevision, projectId]),
    [projectId, workspaceOpenRevision, workspacePath],
  );

  const activate = useCallback(
    (documentId: string) => {
      const tabs = useTabStore.getState();
      const editorOwnerGroup = resolvePhoneEditorGroup(
        {
          activeTabId: tabs.activeTabId,
          secondaryActiveTabId: tabs.secondaryActiveTabId,
          secondaryGroupOpen: tabs.secondaryGroupOpen,
          activeGroupIndex: tabs.activeGroupIndex,
        },
        documentId,
      );
      setActiveScene(documentId);
      useChatStore.getState().setActiveSceneId(documentId);
      useCompactNavigationStore.getState().openSurface("editor");
      useEditorSessionStore.getState().requestEditorFocus(editorOwnerGroup);
    },
    [setActiveScene],
  );

  const prepareScene = useCallback(async (): Promise<string> => {
    const existingDocument = nodes.find(
      (node) => node.nodeType === "scene" || node.nodeType === "note",
    );
    if (existingDocument) {
      return existingDocument.id;
    }

    const created = await createInitialSceneOnce(scopeKey, createNode);
    if (!created) {
      throw new Error("Initial Scene creation is blocked by active authority");
    }
    return created.id;
  }, [createNode, nodes, scopeKey]);

  useEffect(() => {
    if (
      hydratedProjectId !== projectId ||
      hydratedWorkspaceOpenRevision !== workspaceOpenRevision ||
      isLoading
    ) {
      return;
    }
    let cancelled = false;
    setFailed(false);
    void prepareScene()
      .then((documentId) => {
        const workspace = useWorkspaceStore.getState();
        const tree = useTreeStore.getState();
        const currentScopeKey = JSON.stringify([
          workspace.activeWorkspacePath,
          workspace.workspaceOpenRevision,
          tree.projectId,
        ]);
        if (
          cancelled ||
          currentScopeKey !== scopeKey ||
          tree.hydratedProjectId !== projectId ||
          tree.hydratedWorkspaceOpenRevision !== workspace.workspaceOpenRevision
        ) {
          return;
        }
        activate(documentId);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activate,
    hydratedProjectId,
    hydratedWorkspaceOpenRevision,
    isLoading,
    prepareScene,
    projectId,
    retryGeneration,
    scopeKey,
    workspaceOpenRevision,
  ]);

  return (
    <div
      role="status"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground"
    >
      <p>
        {failed
          ? t("mobileWorkspace.editor.createFailed")
          : t("mobileWorkspace.editor.preparing")}
      </p>
      {failed && (
        <button
          type="button"
          className="min-h-11 rounded-md border border-border px-4 font-medium text-foreground"
          onClick={() => {
            setRetryGeneration((generation) => generation + 1);
          }}
        >
          {t("mobileWorkspace.editor.retry")}
        </button>
      )}
    </div>
  );
}
